import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../integrations/supabase.client';
import { BotService } from '../bot/bot.service';
import { WorkItemStatus } from '../common/enums';

/**
 * Reminder sweep — fires the 7-day WORK_CHECK.
 * Postgres is the clock (STACK.md §3), NOT Redis TTL. Idempotent: a restarted
 * or late worker just picks up due rows on the next tick; nothing is lost.
 */
@Injectable()
export class ReminderWorker {
  private readonly logger = new Logger(ReminderWorker.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly bot: BotService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const nowIso = new Date().toISOString();

    const { data, error } = await this.supabase.db
      .from('work_items')
      .select('id, user_id, lifehack_id')
      .eq('status', WorkItemStatus.in_work)
      .eq('check_sent', false)
      .lte('check_due_at', nowIso)
      .limit(500);

    if (error) {
      this.logger.error(`Reminder sweep query failed: ${error.message}`);
      return;
    }
    if (!data?.length) return;

    for (const wi of data) {
      try {
        // Claim the row first so a concurrent sweep can't double-send.
        const { data: claimed } = await this.supabase.db
          .from('work_items')
          .update({ check_sent: true })
          .eq('id', wi.id)
          .eq('check_sent', false)
          .select('id')
          .maybeSingle();
        if (!claimed) continue; // another sweep took it

        // Look up the taker's telegram id + the lifehack title, then prompt.
        const [{ data: user }, { data: lh }] = await Promise.all([
          this.supabase.db
            .from('users')
            .select('telegram_id')
            .eq('id', wi.user_id as string)
            .maybeSingle(),
          this.supabase.db
            .from('lifehacks')
            .select('title')
            .eq('id', wi.lifehack_id as string)
            .maybeSingle(),
        ]);
        const telegramId = (user as { telegram_id: number } | null)?.telegram_id;
        const title = (lh as { title: string } | null)?.title ?? 'кейс';

        const sent = telegramId
          ? await this.bot.sendResultPrompt(telegramId, wi.id as string, title)
          : false;

        if (sent) {
          this.logger.debug(`Check prompt sent for work_item ${wi.id}`);
        } else {
          // Telegram was down / rate-limited / the user has no chat: release the
          // claim so the next sweep retries. Claiming before sending is what
          // prevents double-sends; releasing on failure is what prevents loss.
          await this.releaseClaim(wi.id as string);
        }
      } catch (e) {
        this.logger.error(`Reminder for ${wi.id} failed: ${(e as Error).message}`);
        await this.releaseClaim(wi.id as string);
      }
    }
    this.logger.log(`Reminder sweep processed ${data.length} work item(s)`);
  }

  /** Undo a claim so a failed prompt is retried on the next sweep. */
  private async releaseClaim(workItemId: string): Promise<void> {
    const { error } = await this.supabase.db
      .from('work_items')
      .update({ check_sent: false })
      .eq('id', workItemId)
      .eq('status', WorkItemStatus.in_work);
    if (error) {
      // Worst case the prompt is not retried — loud, because it means a user
      // silently never gets asked for their result.
      this.logger.error(`Failed to release claim on ${workItemId}: ${error.message}`);
    }
  }
}
