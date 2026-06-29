import { Module } from '@nestjs/common';
import { BotService } from './bot.service';

/**
 * Telegram bot layer — thin UI (TECH_ARCHITECTURE §8): callback → backend service
 * → render buttons. No business logic. Runs inside the single backend deploy.
 */
@Module({
  providers: [BotService],
})
export class BotModule {}
