import { Module } from '@nestjs/common';
import { ReminderWorker } from './reminder.worker';
import { ExpiryWorker } from './expiry.worker';

/**
 * Sweep workers. For MVP they run inside the single backend deploy; they can be
 * split into a separate process later with no model change (state is in Postgres).
 */
@Module({
  providers: [ReminderWorker, ExpiryWorker],
})
export class WorkersModule {}
