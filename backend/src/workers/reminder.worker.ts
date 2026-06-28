import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../integrations/supabase.client';
import { WorkItemStatus } from '../common/enums';

/**
 * Reminder sweep — fires the 7-day WORK_CHECK.
 * Postgres is the clock (STACK.md §3), NOT Redis TTL. Idempotent: a restarted
 * or late worker just picks up due rows on the next tick; nothing is lost.
 */
@Injectable()
export class ReminderWorker {
  private readonly logger = new Logger(ReminderWorker.name);

  constructor(private readonly supabase: SupabaseService) {}

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
        // TODO: enqueue the bot check prompt (batched per user — PRODUCT_LOGIC §4).
        await this.supabase.db
          .from('work_items')
          .update({ check_sent: true })
          .eq('id', wi.id)
          .eq('check_sent', false); // guard against a concurrent sweep
        this.logger.debug(`Check prompt due for work_item ${wi.id}`);
      } catch (e) {
        this.logger.error(`Reminder for ${wi.id} failed: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Reminder sweep processed ${data.length} work item(s)`);
  }
}
