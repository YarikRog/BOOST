import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis is cache / queues / ephemeral flow-state / rate-limit — NOT the clock.
 * Timers live in Postgres and are driven by the sweep workers (STACK.md §3).
 *
 * Key conventions (STACK.md §4):
 *   flow:user:{id}             wizard step          TTL 10–30m
 *   ratelimit:react:{user}     reaction counter     TTL 60s
 *   feed:{category}:{audience} cached ranked json   TTL 2–5m
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  /** Feed cache lifetime; also the window that keeps feed ordering stable. */
  static readonly FEED_TTL_SECONDS = 180;

  private readonly logger = new Logger(RedisService.name);
  private redis!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.redis.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
    this.logger.log('Redis client initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  get client(): Redis {
    return this.redis;
  }

  // ── Flow state ──────────────────────────────────────────────
  async setFlowState(userId: string, step: string, ttlSeconds = 1800): Promise<void> {
    await this.redis.set(`flow:user:${userId}`, step, 'EX', ttlSeconds);
  }

  async getFlowState(userId: string): Promise<string | null> {
    return this.redis.get(`flow:user:${userId}`);
  }

  // ── Rate limit (sliding-ish counter) ────────────────────────
  async hitReactionLimit(userId: string, max: number, windowSeconds = 60): Promise<boolean> {
    const key = `ratelimit:react:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count > max; // true => over the limit
  }

  // ── Feed cache ──────────────────────────────────────────────
  async getFeed(category: string, audience: string): Promise<string | null> {
    return this.redis.get(`feed:${category}:${audience}`);
  }

  async setFeed(
    category: string,
    audience: string,
    json: string,
    ttlSeconds = RedisService.FEED_TTL_SECONDS,
  ): Promise<void> {
    await this.redis.set(`feed:${category}:${audience}`, json, 'EX', ttlSeconds);
  }

  async invalidateFeed(category: string): Promise<void> {
    const keys = await this.redis.keys(`feed:${category}:*`);
    if (keys.length) await this.redis.del(...keys);
  }

  // ── Scheduled bot-message deletion ──────────────────────────
  // Sorted set instead of setTimeout: survives a redeploy (Railway restarts
  // the process often), since the due time lives in Redis, not process memory.
  async scheduleMessageDelete(chatId: number, messageId: number, delayMs: number): Promise<void> {
    await this.redis.zadd('autodelete:msgs', Date.now() + delayMs, `${chatId}:${messageId}`);
  }

  /** Pop all entries due for deletion (score <= now) and remove them from the set. */
  async popDueMessageDeletes(): Promise<Array<{ chatId: number; messageId: number }>> {
    const due = await this.redis.zrangebyscore('autodelete:msgs', 0, Date.now());
    if (!due.length) return [];
    await this.redis.zrem('autodelete:msgs', ...due);
    return due.map((entry) => {
      const [chatId, messageId] = entry.split(':').map(Number);
      return { chatId, messageId };
    });
  }
}
