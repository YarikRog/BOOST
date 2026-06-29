import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard } from 'grammy';

/**
 * Telegram bot — thin UI layer (TECH_ARCHITECTURE §8). Long-polling for MVP
 * (simplest; works without a public URL). Switch to webhooks later if needed.
 *
 * NOTE: long-polling has a single getUpdates consumer — run ONE replica of the
 * bot. When scaling, split the bot into its own single-instance deploy or move
 * to webhooks.
 *
 * Boots gracefully without a token so the API/workers still run in dev.
 */
@Injectable()
export class BotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot?: Bot;

  constructor(private readonly config: ConfigService) {}

  onApplicationBootstrap(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled (API/workers still run)');
      return;
    }

    this.bot = new Bot(token);
    this.registerHandlers(this.bot);

    // Do not await — start() runs the long-polling loop until stop().
    void this.bot.start({
      onStart: (info) => this.logger.log(`Bot @${info.username} started (long-polling)`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  private registerHandlers(bot: Bot): void {
    // Entry — Flow 1. Deep-link invite token arrives as the /start payload:
    //   https://t.me/<bot>?start=<INVITE_TOKEN>
    bot.command('start', async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        await ctx.reply(
          '🔒 Доступ лише для співробітників.\n\n' +
            'Отримай запрошення у директора магазину або регіонального IT-ліда.',
        );
        return;
      }

      // TODO (next step): invites.consume(token, ctx.from) → create user + scope,
      // then run the onboarding steps (phone, experience). For now, acknowledge.
      this.logger.debug(`/start with invite token: ${token}`);
      await ctx.reply('Перевіряю запрошення…');
    });

    // Opens the WebApp (Mini App) — shown after onboarding.
    bot.command('app', async (ctx) => {
      const webAppUrl = this.config.get<string>('WEBAPP_URL');
      if (!webAppUrl) {
        await ctx.reply('WebApp ще не налаштовано.');
        return;
      }
      const kb = new InlineKeyboard().webApp('📲 Відкрити застосунок', webAppUrl);
      await ctx.reply('Відкрий базу кейсів:', { reply_markup: kb });
    });

    bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
  }
}
