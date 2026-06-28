import { Module } from '@nestjs/common';

/**
 * Telegram bot layer — thin UI (TECH_ARCHITECTURE §8): callback → backend service
 * → render buttons. No business logic. Handlers (grammY/Telegraf) land here.
 * Stub for the skeleton; wired into the single backend deploy.
 */
@Module({})
export class BotModule {}
