import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import { RedisService } from '../integrations/redis.client';
import { InvitesService } from '../services/invites.service';
import { UsersService } from '../services/users.service';
import { Experience, UserRole } from '../common/enums';

type OnboardStep = 'phone' | 'experience' | 'store' | 'done';
interface OnboardState {
  userId: string;
  role: UserRole;
  step: OnboardStep;
}

const EXPERIENCE_LABELS: Record<Experience, string> = {
  [Experience.lt_6m]: 'До 6 місяців',
  [Experience['6m_2y']]: 'Від 6 місяців до 2 років',
  [Experience.gt_2y]: 'Понад 2 роки',
};

/**
 * Telegram bot — thin UI (TECH_ARCHITECTURE §8). Implements Flow 1 onboarding:
 *   /start <token> → consume invite → phone → experience → [store for DIRECTOR] → done.
 * Step state is ephemeral in Redis; all real work is delegated to services.
 */
@Injectable()
export class BotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot?: Bot;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly invites: InvitesService,
    private readonly users: UsersService,
  ) {}

  onApplicationBootstrap(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled (API/workers still run)');
      return;
    }
    this.bot = new Bot(token);
    this.registerHandlers(this.bot);
    void this.bot.start({
      onStart: (info) => this.logger.log(`Bot @${info.username} started (long-polling)`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop();
  }

  // ── Redis onboarding state ──────────────────────────────────
  private stateKey(tgId: number): string {
    return `onboard:${tgId}`;
  }
  private async setState(tgId: number, state: OnboardState): Promise<void> {
    await this.redis.client.set(this.stateKey(tgId), JSON.stringify(state), 'EX', 3600);
  }
  private async getState(tgId: number): Promise<OnboardState | null> {
    const raw = await this.redis.client.get(this.stateKey(tgId));
    return raw ? (JSON.parse(raw) as OnboardState) : null;
  }
  private async clearState(tgId: number): Promise<void> {
    await this.redis.client.del(this.stateKey(tgId));
  }

  // ── Handlers ────────────────────────────────────────────────
  private registerHandlers(bot: Bot): void {
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.on(':contact', (ctx) => this.onContact(ctx));
    bot.callbackQuery(/^exp:(.+)$/, (ctx) => this.onExperience(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
    bot.command('app', (ctx) => this.sendAppButton(ctx));
    bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
  }

  private async onStart(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined;
    const token = (ctx.match as string | undefined)?.trim();

    if (!token) {
      // No token — try bootstrapping the first MEGA_ADMIN, else deny.
      const admin = await this.users.bootstrapAdminIfEligible(tgId, name);
      if (admin) {
        await this.setState(tgId, { userId: admin.id, role: admin.role, step: 'phone' });
        await this.askPhone(ctx);
        return;
      }
      await ctx.reply(
        '🔒 Доступ лише для співробітників.\n\n' +
          'Отримай запрошення у директора магазину або регіонального IT-ліда.',
      );
      return;
    }

    try {
      const { user, needsStoreCreation } = await this.invites.consume(token, { id: tgId, name });
      // If already fully onboarded, just greet + app button.
      if (user.phone && user.experience_segment && !needsStoreCreation) {
        await ctx.reply(`Вітаю знову! Роль: ${user.role}`);
        await this.sendAppButton(ctx);
        return;
      }
      await this.setState(tgId, { userId: user.id, role: user.role, step: 'phone' });
      await ctx.reply(`Вас запрошено як: ${user.role}. Завершимо вхід.`);
      await this.askPhone(ctx);
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  private async askPhone(ctx: Context): Promise<void> {
    const kb = new Keyboard().requestContact('📞 Поділитися номером').resized().oneTime();
    await ctx.reply('Підтвердіть номер телефону:', { reply_markup: kb });
  }

  private async onContact(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const state = await this.getState(tgId);
    if (!state || state.step !== 'phone') return;

    const phone = ctx.message?.contact?.phone_number;
    if (!phone) return;

    await this.users.setPhone(state.userId, phone);
    state.step = 'experience';
    await this.setState(tgId, state);
    await this.askExperience(ctx);
  }

  private async askExperience(ctx: Context): Promise<void> {
    const kb = new InlineKeyboard()
      .text(EXPERIENCE_LABELS[Experience.lt_6m], `exp:${Experience.lt_6m}`)
      .row()
      .text(EXPERIENCE_LABELS[Experience['6m_2y']], `exp:${Experience['6m_2y']}`)
      .row()
      .text(EXPERIENCE_LABELS[Experience.gt_2y], `exp:${Experience.gt_2y}`);
    await ctx.reply('Скільки часу ви працюєте в компанії Comfy?', { reply_markup: kb });
  }

  private async onExperience(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const state = await this.getState(tgId);
    if (!state || state.step !== 'experience') return;

    const segment = (ctx.match as RegExpMatchArray)[1] as Experience;
    if (!Object.values(Experience).includes(segment)) return;

    await this.users.setExperience(state.userId, segment);

    if (state.role === UserRole.DIRECTOR) {
      state.step = 'store';
      await this.setState(tgId, state);
      await ctx.reply('Введіть назву вашого магазину:');
      return;
    }
    await this.finish(ctx, tgId);
  }

  private async onText(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const state = await this.getState(tgId);
    if (!state || state.step !== 'store') return; // ignore free text outside the store step

    const storeName = ctx.message?.text?.trim();
    if (!storeName) return;

    try {
      await this.users.createStoreForDirector(state.userId, storeName);
      await this.finish(ctx, tgId);
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  private async finish(ctx: Context, tgId: number): Promise<void> {
    await this.clearState(tgId);
    await ctx.reply('✅ Вхід успішний.');
    await this.sendAppButton(ctx);
  }

  private async sendAppButton(ctx: Context): Promise<void> {
    const webAppUrl = this.config.get<string>('WEBAPP_URL');
    if (!webAppUrl) {
      await ctx.reply('WebApp ще не налаштовано.');
      return;
    }
    const kb = new InlineKeyboard().webApp('📲 Відкрити застосунок', webAppUrl);
    await ctx.reply('Відкрий базу кейсів:', { reply_markup: kb });
  }
}
