import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../integrations/redis.client';
import { BotService } from '../bot/bot.service';

/**
 * Sweeps Redis for bot messages queued for deletion (BotService.scheduleAutoDelete)
 * and actually deletes them. A Redis-backed queue + periodic sweep, not
 * setTimeout, because setTimeout dies with the process — and this backend
 * redeploys often (every push), which would leave messages stuck forever.
 */
@Injectable()
export class AutoDeleteWorker {
  private readonly logger = new Logger(AutoDeleteWorker.name);

  constructor(
    private readonly redis: RedisService,
    private readonly bot: BotService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    const due = await this.redis.popDueMessageDeletes();
    for (const { chatId, messageId } of due) {
      await this.bot.deleteMessage(chatId, messageId);
    }
    if (due.length) {
      this.logger.log(`Auto-delete swept ${due.length} bot message(s)`);
    }
  }
}
