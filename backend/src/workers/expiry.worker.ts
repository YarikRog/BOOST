import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../integrations/supabase.client';
import { WorkItemStatus } from '../common/enums';

/**
 * Expiry sweep — sets EXPIRED at the 14-day mark for unanswered work items.
 * EXPIRED = operational silence: frees the slot, excluded from all scoring
 * (PRODUCT_LOGIC §11c). Postgres is the clock; this is crash-safe and idempotent.
 */
@Injectable()
export class ExpiryWorker {
  private readonly logger = new Logger(ExpiryWorker.name);

  constructor(private readonly supabase: SupabaseService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const nowIso = new Date().toISOString();

    const { data, error } = await this.supabase.db
      .from('work_items')
      .update({ status: WorkItemStatus.expired, resolved_at: nowIso })
      .eq('status', WorkItemStatus.in_work)
      .lte('expires_at', nowIso)
      .select('id');

    if (error) {
      this.logger.error(`Expiry sweep failed: ${error.message}`);
      return;
    }
    if (data?.length) {
      this.logger.log(`Expiry sweep marked ${data.length} work item(s) EXPIRED`);
    }
  }
}
