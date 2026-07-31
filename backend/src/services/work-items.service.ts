import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../integrations/supabase.client';
import { RedisService } from '../integrations/redis.client';
import { BotService } from '../bot/bot.service';
import { WorkItemStatus } from '../common/enums';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ResolveOutcome =
  | WorkItemStatus.success
  | WorkItemStatus.partial
  | WorkItemStatus.fail
  | WorkItemStatus.not_tried;

/**
 * Drives the work-item state machine (PRODUCT_LOGIC §11b):
 *   NONE → IN_WORK → success | partial | fail | not_tried | expired
 * The lifehack entity state is untouched here.
 */
@Injectable()
export class WorkItemsService {
  private readonly logger = new Logger(WorkItemsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly bot: BotService,
  ) {}

  private get limit(): number {
    return Number(this.config.get('ACTIVE_WORK_LIMIT', 5));
  }

  /**
   * Take a lifehack into work. Enforces the active-work limit + single-active
   * guard. If the lifehack is a voice case, forwards the audio to the taker.
   */
  async take(userId: string, lifehackId: string, takerTelegramId?: number) {
    // You cannot take your own lifehack into work (you can't confirm yourself).
    const { data: lh, error: lhErr } = await this.supabase.db
      .from('lifehacks')
      .select('author_id, content_json')
      .eq('id', lifehackId)
      .maybeSingle();
    if (lhErr) throw lhErr;
    if (!lh) throw new BadRequestException('Кейс не знайдено.');
    if ((lh as { author_id: string }).author_id === userId) {
      throw new BadRequestException('Не можна брати власний кейс у роботу.');
    }

    const active = await this.countActive(userId);
    if (active >= this.limit) {
      throw new BadRequestException(
        `Ліміт активних кейсів (${this.limit}). Заверши один, перш ніж брати новий.`,
      );
    }

    const now = Date.now();
    const checkDays = Number(this.config.get('WORK_CHECK_DAYS', 7));
    const expiryDays = Number(this.config.get('WORK_EXPIRY_DAYS', 14));

    const { data, error } = await this.supabase.db
      .from('work_items')
      .insert({
        user_id: userId,
        lifehack_id: lifehackId,
        status: WorkItemStatus.in_work,
        started_at: new Date(now).toISOString(),
        check_due_at: new Date(now + checkDays * DAY_MS).toISOString(),
        expires_at: new Date(now + expiryDays * DAY_MS).toISOString(),
        check_sent: false,
      })
      .select()
      .single();

    // The partial-unique index (status='in_work') rejects a second active item.
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('Ти вже маєш цей кейс у роботі.');
      }
      throw error;
    }

    // Voice case: forward the original audio to the taker's bot chat.
    const content = ((lh as { content_json?: Record<string, unknown> }).content_json ?? {}) as {
      voice_file_id?: string;
    };
    if (content.voice_file_id && takerTelegramId) {
      await this.bot.sendVoice(
        takerTelegramId,
        content.voice_file_id,
        '🎧 Голосовий кейс, який ти взяв у роботу. Спробуй і за 7 днів скажи результат.',
      );
    }

    // Engagement loop: tell the author someone is trying their case.
    await this.bot.notifyAuthorTaken(lifehackId);

    return data;
  }

  /** Submit a result. Frees the slot; only success/partial/fail feed the score. */
  async resolve(userId: string, workItemId: string, outcome: ResolveOutcome) {
    const { data, error } = await this.supabase.db
      .from('work_items')
      .update({ status: outcome, resolved_at: new Date().toISOString() })
      .eq('id', workItemId)
      .eq('user_id', userId) // only your own work item
      .eq('status', WorkItemStatus.in_work) // only an active item can be resolved
      .select('id, lifehack_id')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new BadRequestException('Кейс не в роботі або не існує.');

    // A real outcome changes the lifehack's score → drop its category feed cache.
    const { data: lh } = await this.supabase.db
      .from('lifehacks')
      .select('category_id')
      .eq('id', (data as { lifehack_id: string }).lifehack_id)
      .maybeSingle();
    if (lh) await this.redis.invalidateFeed((lh as { category_id: string }).category_id);

    // Positive feedback loop: tell the author their case worked for a colleague.
    if (outcome === WorkItemStatus.success) {
      await this.bot.notifyAuthorSuccess((data as { lifehack_id: string }).lifehack_id);
    }

    return data;
  }

  /** Active (in_work) items for a user — powers HOME "В роботі (X)". */
  async listActive(userId: string) {
    const { data, error } = await this.supabase.db
      .from('work_items')
      .select('id, lifehack_id, started_at, check_due_at, expires_at')
      .eq('user_id', userId)
      .eq('status', WorkItemStatus.in_work)
      .order('started_at', { ascending: true });
    if (error) throw error;
    const items = data ?? [];
    if (!items.length) return [];

    // Enrich with lifehack title for the WebApp confirm sheet.
    const ids = items.map((w) => w.lifehack_id as string);
    const { data: lhs } = await this.supabase.db
      .from('lifehacks')
      .select('id, title')
      .in('id', ids);
    const titleById = new Map((lhs ?? []).map((l) => [l.id as string, l.title as string]));
    return items.map((w) => ({ ...w, title: titleById.get(w.lifehack_id as string) ?? 'Кейс' }));
  }

  private async countActive(userId: string): Promise<number> {
    const { count, error } = await this.supabase.db
      .from('work_items')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', WorkItemStatus.in_work);
    if (error) throw error;
    return count ?? 0;
  }
}
