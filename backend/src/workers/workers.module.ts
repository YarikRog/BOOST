import { Module } from '@nestjs/common';
import { ReminderWorker } from './reminder.worker';
import { ExpiryWorker } from './expiry.worker';
import { BotModule } from '../bot/bot.module';

/**
 * Sweep workers. For MVP they run inside the single backend deploy; they can be
 * split into a separate process later with no model change (state is in Postgres).
 */
@Module({
  imports: [BotModule], // ReminderWorker sends the 7-day check via the bot
  providers: [ReminderWorker, ExpiryWorker],
})
export class WorkersModule {}
