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
import { LifehacksService } from '../services/lifehacks.service';
import { CategoriesService } from '../services/categories.service';
import { Experience, UserRole } from '../common/enums';

interface VoiceFlow {
  fileId: string;
  slug?: string;
  product?: string;
  title?: string;
  step: 'title' | 'confirm';
}

type OnboardStep = 'phone' | 'experience' | 'store' | 'done';
interface OnboardState {
  userId: string;
  role: UserRole;
  step: OnboardStep;
  storeAssigned?: boolean; // true when store_id is already set (e.g. dir_<storeId> pilot link)
}

const ADMIN_NEW_STORE_BTN = '🏪 Створити магазин';
const BTN_INV_REGIONAL = '➕ Рег. ІТ-лід';
const BTN_INV_DIRECTOR = '➕ Директор';
const BTN_INV_SELLER = '➕ Продавець';
const BTN_INV_DEP = '➕ Заступник';

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
    private readonly lifehacks: LifehacksService,
    private readonly categories: CategoriesService,
  ) {}

  /** Send a voice message to a user by telegram id (used to forward voice cases). */
  async sendVoice(telegramId: number, fileId: string, caption?: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendVoice(telegramId, fileId, caption ? { caption } : undefined);
    } catch (e) {
      this.logger.error(`sendVoice to ${telegramId} failed: ${(e as Error).message}`);
    }
  }

  onApplicationBootstrap(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled (API/workers still run)');
      return;
    }
    this.bot = new Bot(token);
    this.registerHandlers(this.bot);
    this.bot
      .start({
        onStart: (info) => this.logger.log(`Bot @${info.username} started (long-polling)`),
      })
      .catch((err) => {
        this.logger.error(`Bot failed to start — check TELEGRAM_BOT_TOKEN: ${err.message}`);
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
    // Commands first — the generic message:text handler below stops the chain
    // when it has nothing to do, so it must be registered last.
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('app', (ctx) => this.sendAppButton(ctx));
    bot.command('newstore', (ctx) => this.onNewStore(ctx));
    bot.command('reset', (ctx) => this.onReset(ctx));
    bot.command('stores', (ctx) => this.onStores(ctx));
    bot.callbackQuery(/^delstore:(.+)$/, (ctx) => this.onDeleteStore(ctx));
    bot.hears(ADMIN_NEW_STORE_BTN, (ctx) => {
      const tgId = ctx.from?.id;
      return tgId ? this.promptStoreName(ctx, tgId) : Promise.resolve();
    });
    bot.hears(BTN_INV_REGIONAL, (ctx) => this.startInvite(ctx, UserRole.REGIONAL_IT_LEAD));
    bot.hears(BTN_INV_DIRECTOR, (ctx) => this.startInvite(ctx, UserRole.DIRECTOR));
    bot.hears(BTN_INV_SELLER, (ctx) => this.startInvite(ctx, UserRole.SELLER));
    bot.hears(BTN_INV_DEP, (ctx) => this.startInvite(ctx, UserRole.DEP_DIRECTOR));
    bot.on(':contact', (ctx) => this.onContact(ctx));
    bot.on('message:voice', (ctx) => this.onVoice(ctx));
    bot.callbackQuery(/^exp:(.+)$/, (ctx) => this.onExperience(ctx));
    bot.callbackQuery(/^ns:(confirm|edit)$/, (ctx) => this.onNewStoreConfirm(ctx));
    bot.callbackQuery(/^vpub:(confirm|edit|cancel)$/, (ctx) => this.onVoicePublish(ctx));
    bot.callbackQuery(/^cancelflow$/, (ctx) => this.onCancelFlow(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
    bot.catch((err) => this.logger.error(`Bot error: ${err.message}`));
  }

  /**
   * Admin-only: `/newstore <name>` creates a pilot store (region+store) and
   * replies with the two non-expiring deep links. Only MEGA_ADMIN /
   * REGIONAL_IT_LEAD may run it — this is how store #1 is provisioned without
   * the invite hierarchy (see PRODUCT_LOGIC.md pilot note).
   */
  private async onNewStore(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || (caller.role !== UserRole.MEGA_ADMIN && caller.role !== UserRole.REGIONAL_IT_LEAD)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const storeName = (ctx.match as string | undefined)?.trim();
    if (!storeName) {
      // No name given → start the interactive flow (same as the keyboard button).
      await this.promptStoreName(ctx, tgId);
      return;
    }
    await this.createStoreAndReply(ctx, storeName);
  }

  /** Admin-only: `/stores` lists every store with a delete button each. */
  private async onStores(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const stores = await this.users.listStores();
    if (!stores.length) {
      await ctx.reply('Магазинів ще немає. Натисни 🏪 Створити магазин.');
      return;
    }

    const kb = new InlineKeyboard();
    for (const s of stores) {
      kb.text(`🗑 ${s.name} (${s.id.slice(0, 8)})`, `delstore:${s.id}`).row();
    }
    await ctx.reply(`Магазини (${stores.length}). Тисни, щоб видалити порожній:`, { reply_markup: kb });
  }

  /** Handles the 🗑 delete buttons from /stores. */
  private async onDeleteStore(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const storeId = (ctx.match as RegExpMatchArray)[1];
    try {
      const res = await this.users.deleteStore(storeId);
      if (res === 'not_found') await ctx.reply('Магазин уже видалено.');
      else if (res === 'has_users') await ctx.reply('❌ У магазині є користувачі — спочатку прибери їх через /reset.');
      else await ctx.reply('🗑 Магазин видалено.');
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  /** Role-appropriate reply keyboard (store creation / invites). */
  private keyboardFor(role: UserRole): Keyboard | undefined {
    switch (role) {
      case UserRole.MEGA_ADMIN:
        return new Keyboard().text(ADMIN_NEW_STORE_BTN).row().text(BTN_INV_REGIONAL).resized();
      case UserRole.REGIONAL_IT_LEAD:
        return new Keyboard().text(ADMIN_NEW_STORE_BTN).row().text(BTN_INV_DIRECTOR).resized();
      case UserRole.DIRECTOR:
      case UserRole.DEP_DIRECTOR:
        return new Keyboard().text(BTN_INV_SELLER).text(BTN_INV_DEP).resized();
      default:
        return undefined; // SELLER — no admin actions
    }
  }

  private isAdmin(role: UserRole): boolean {
    return role === UserRole.MEGA_ADMIN || role === UserRole.REGIONAL_IT_LEAD;
  }

  /** Clear any half-finished bot flow so the user is never stuck. */
  private async clearTransientFlow(tgId: number): Promise<void> {
    await this.redis.client.del(
      `awaitStoreName:${tgId}`,
      `pendingStoreName:${tgId}`,
      `awaitRegionName:${tgId}`,
      this.voiceKey(tgId),
    );
  }

  /** Button/`/newstore` with no name → ask for the store name (state in Redis). */
  private async promptStoreName(ctx: Context, tgId: number): Promise<void> {
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }
    await this.redis.client.set(`awaitStoreName:${tgId}`, '1', 'EX', 300);
    await ctx.reply('Введи назву магазину (напр. «Обухів»):', {
      reply_markup: new InlineKeyboard().text('❌ Скасувати', 'cancelflow'),
    });
  }

  /** Cancel any pending flow (store/region name entry, voice case). */
  private async onCancelFlow(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    await this.clearTransientFlow(tgId);
    await this.redis.client.del(`voiceIntent:${tgId}`);
    await ctx.reply('❌ Скасовано.');
  }

  /** Invite a user of a given role and reply with the deep link + share buttons. */
  private async startInvite(ctx: Context, targetRole: UserRole): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const creator = await this.users.findByTelegramId(tgId);
    if (!creator) return;

    // MEGA_ADMIN invites a REGIONAL — needs a region first (ask its name).
    if (targetRole === UserRole.REGIONAL_IT_LEAD) {
      await this.redis.client.set(`awaitRegionName:${tgId}`, '1', 'EX', 300);
      await ctx.reply('Введи назву регіону (напр. «Житомирська область»):', {
        reply_markup: new InlineKeyboard().text('❌ Скасувати', 'cancelflow'),
      });
      return;
    }

    try {
      const invite = await this.invites.create(creator, targetRole);
      await this.sendInviteLink(ctx, targetRole, invite.deepLink);
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  private async sendInviteLink(
    ctx: Context,
    role: UserRole,
    deepLink: string | null,
  ): Promise<void> {
    if (!deepLink) {
      await ctx.reply('❌ BOT_USERNAME не налаштовано — не можу зібрати посилання.');
      return;
    }
    const label: Record<string, string> = {
      [UserRole.REGIONAL_IT_LEAD]: 'регіонального ІТ-ліда',
      [UserRole.DIRECTOR]: 'директора',
      [UserRole.DEP_DIRECTOR]: 'заступника',
      [UserRole.SELLER]: 'продавця',
    };
    const share = `https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent(
      'Долучайся до BOOST:',
    )}`;
    const kb = new InlineKeyboard().url('📤 Переслати', share);
    await ctx.reply(
      `✅ Посилання-запрошення для ${label[role] ?? 'співробітника'} (одноразове, дійсне 7 днів):\n${deepLink}`,
      { reply_markup: kb },
    );
  }

  /** Handles the ✅ Підтвердити / ✏️ Змінити buttons on the confirmation prompt. */
  private async onNewStoreConfirm(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();

    const action = (ctx.match as RegExpMatchArray)[1];
    const pendingKey = `pendingStoreName:${tgId}`;
    const name = await this.redis.client.get(pendingKey);

    if (action === 'edit') {
      await this.redis.client.del(pendingKey);
      await this.redis.client.set(`awaitStoreName:${tgId}`, '1', 'EX', 300);
      await ctx.reply('Введи назву магазину (напр. «Обухів»):');
      return;
    }

    // confirm
    if (!name) {
      await ctx.reply('⌛️ Назва не збереглася. Натисни 🏪 Створити магазин ще раз.');
      return;
    }
    await this.redis.client.del(pendingKey);
    await this.createStoreAndReply(ctx, name);
  }

  private async createStoreAndReply(ctx: Context, storeName: string): Promise<void> {
    try {
      const { storeId } = await this.users.createPilotStore(storeName);
      const username = this.config.get<string>('BOT_USERNAME');
      const dirLink = `https://t.me/${username}?start=dir_${storeId}`;
      const sellerLink = `https://t.me/${username}?start=store_${storeId}`;

      // Telegram's built-in share sheet: one tap opens the chat picker with the
      // link pre-filled, so the admin/director forwards without copy-paste.
      const shareUrl = (link: string, text: string): string =>
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
      const kb = new InlineKeyboard()
        .url('📤 Переслати директору', shareUrl(dirLink, 'Долучайся до BOOST як директор магазину:'))
        .row()
        .url('📤 Переслати продавцям', shareUrl(sellerLink, 'Долучайся до BOOST — база кейсів магазину:'));

      await ctx.reply(
        `✅ Магазин «${storeName}» створено.\n\n` +
          `👔 Директору — надішли посилання особисто.\n` +
          `🧑‍💼 Продавцям — директор пересилає команді.\n\n` +
          `Обери, кому переслати:`,
        { reply_markup: kb },
      );
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  private async onStart(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || undefined;
    const payload = (ctx.match as string | undefined)?.trim();

    // /start always unsticks any half-finished flow.
    await this.clearTransientFlow(tgId);

    // Already onboarded — re-entry regardless of which link they used.
    const existing = await this.users.findByTelegramId(tgId);
    if (existing && existing.phone && existing.experience_segment) {
      await this.setMenuButton(tgId);
      const kb = this.keyboardFor(existing.role);
      await ctx.reply(
        `Вітаю знову! Роль: ${existing.role}`,
        kb ? { reply_markup: kb } : undefined,
      );
      await this.sendAppButton(ctx);
      return;
    }

    if (!payload) {
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

    // Pilot mode: "store_<storeId>" (SELLER) / "dir_<storeId>" (DIRECTOR) —
    // no invite row, no single-use token. Used for store #1 while it runs
    // without the referral hierarchy (see PRODUCT_LOGIC.md pilot note).
    const storeLinkMatch = payload.match(/^(store|dir)_(.+)$/);
    if (storeLinkMatch) {
      try {
        const [, kind, storeId] = storeLinkMatch;
        const role = kind === 'dir' ? UserRole.DIRECTOR : UserRole.SELLER;
        const user = await this.users.joinStoreDirect(tgId, storeId, role, name);
        await this.setState(tgId, { userId: user.id, role: user.role, step: 'phone', storeAssigned: true });
        await ctx.reply(`Вітаємо! Роль: ${user.role}. Завершимо вхід.`);
        await this.askPhone(ctx);
      } catch (e) {
        await ctx.reply(`❌ ${(e as Error).message}`);
      }
      return;
    }

    try {
      const { user, needsStoreCreation } = await this.invites.consume(payload, { id: tgId, name });
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

  /**
   * TEST-ONLY: `/reset <telegramId>` hard-deletes a user (default: yourself)
   * so the bot flow can be retried from scratch. MEGA_ADMIN only. Deleting
   * yourself lets the next /start re-bootstrap you as the first admin.
   */
  private async onReset(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || caller.role !== UserRole.MEGA_ADMIN) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const arg = (ctx.match as string | undefined)?.trim();
    const targetId = arg ? Number(arg) : tgId;
    if (!Number.isFinite(targetId)) {
      await ctx.reply('Вкажи числовий Telegram ID: /reset 123456789 (або /reset без ID — видалити себе)');
      return;
    }

    try {
      const deleted = await this.users.deleteByTelegramId(targetId);
      await this.clearState(targetId);
      if (!deleted) {
        await ctx.reply(`Користувача з ID ${targetId} не знайдено.`);
        return;
      }
      await ctx.reply(
        targetId === tgId
          ? '🗑 Тебе видалено. Надішли /start, щоб зайти заново.'
          : `🗑 Користувача ${targetId} видалено.`,
      );
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  // ── Voice case flow: category is chosen in the WebApp first (voiceIntent),
  //    then the user records a voice note here; bot only asks for a title. ──
  private voiceKey(tgId: number): string {
    return `voiceFlow:${tgId}`;
  }

  private async onVoice(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await this.users.findByTelegramId(tgId);
    if (!user || !user.phone) {
      await ctx.reply('🔒 Спочатку заверши вхід через посилання від директора.');
      return;
    }

    const fileId = ctx.message?.voice?.file_id;
    if (!fileId) return;

    // Category is mandatory and must have been chosen in the WebApp first.
    const intentRaw = await this.redis.client.get(`voiceIntent:${tgId}`);
    if (!intentRaw) {
      await ctx.reply(
        '🎙️ Спочатку обери категорію і товар у застосунку (кнопка «📲 BOOST» знизу) → ' +
          'натисни «Записати голосом», і аж тоді надішли голосове.',
      );
      return;
    }
    const intent = JSON.parse(intentRaw) as { categorySlug: string; productType: string };

    const flow: VoiceFlow = {
      fileId,
      slug: intent.categorySlug,
      product: intent.productType,
      step: 'title',
    };
    await this.redis.client.set(this.voiceKey(tgId), JSON.stringify(flow), 'EX', 1800);
    await this.redis.client.del(`voiceIntent:${tgId}`);
    await ctx.reply('🎙️ Голосове отримано! Введи короткий заголовок кейсу:');
  }

  /** Called from onText when a voice flow is awaiting its title. Asks to confirm. */
  private async handleVoiceTitle(ctx: Context, tgId: number): Promise<boolean> {
    const raw = await this.redis.client.get(this.voiceKey(tgId));
    if (!raw) return false;
    const flow = JSON.parse(raw) as VoiceFlow;
    if (flow.step !== 'title' || !flow.slug) return false;

    const title = ctx.message?.text?.trim();
    if (!title) return true; // consume, keep waiting

    flow.title = title;
    flow.step = 'confirm';
    await this.redis.client.set(this.voiceKey(tgId), JSON.stringify(flow), 'EX', 1800);
    const kb = new InlineKeyboard()
      .text('✅ Опублікувати', 'vpub:confirm')
      .row()
      .text('✏️ Змінити заголовок', 'vpub:edit')
      .row()
      .text('❌ Скасувати', 'vpub:cancel');
    await ctx.reply(`Опублікувати голосовий кейс «${title}»?`, { reply_markup: kb });
    return true;
  }

  /** Handles the confirm/edit/cancel buttons for a voice case. */
  private async onVoicePublish(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();

    const raw = await this.redis.client.get(this.voiceKey(tgId));
    if (!raw) return;
    const flow = JSON.parse(raw) as VoiceFlow;
    const action = (ctx.match as RegExpMatchArray)[1];

    if (action === 'cancel') {
      await this.redis.client.del(this.voiceKey(tgId));
      await ctx.reply('❌ Скасовано. Голосовий кейс не опубліковано.');
      return;
    }
    if (action === 'edit') {
      flow.step = 'title';
      await this.redis.client.set(this.voiceKey(tgId), JSON.stringify(flow), 'EX', 1800);
      await ctx.reply('Введи новий заголовок:');
      return;
    }

    // confirm
    if (flow.step !== 'confirm' || !flow.slug || !flow.title) return;
    const user = await this.users.findByTelegramId(tgId);
    if (!user) {
      await this.redis.client.del(this.voiceKey(tgId));
      return;
    }
    try {
      await this.lifehacks.create(user, {
        categorySlug: flow.slug,
        productType: flow.product ?? '',
        title: flow.title,
        content: { voice_file_id: flow.fileId },
      });
      await this.redis.client.del(this.voiceKey(tgId));
      await ctx.reply('✅ Голосовий кейс опубліковано! Він зʼявився у стрічці.');
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
    // Number confirmed — the request-contact keyboard is no longer needed.
    await ctx.reply('✅ Номер підтверджено.', { reply_markup: { remove_keyboard: true } });
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

    if (state.role === UserRole.DIRECTOR && !state.storeAssigned) {
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

    // Voice case flow: waiting for the title of a just-recorded voice case.
    if (await this.handleVoiceTitle(ctx, tgId)) return;

    // Invite flow: MEGA_ADMIN entered a region name → create region + invite.
    const regionKey = `awaitRegionName:${tgId}`;
    if (await this.redis.client.get(regionKey)) {
      const regionName = ctx.message?.text?.trim();
      if (!regionName) return;
      await this.redis.client.del(regionKey);
      try {
        const creator = await this.users.findByTelegramId(tgId);
        if (!creator) return;
        const region = await this.users.createRegion(regionName);
        const invite = await this.invites.create(creator, UserRole.REGIONAL_IT_LEAD, {
          regionId: region.id,
        });
        await ctx.reply(`✅ Регіон «${regionName}» створено.`);
        await this.sendInviteLink(ctx, UserRole.REGIONAL_IT_LEAD, invite.deepLink);
      } catch (e) {
        await ctx.reply(`❌ ${(e as Error).message}`);
      }
      return;
    }

    // Admin "create store" flow: waiting for the store name (set by button/`/newstore`).
    const awaitKey = `awaitStoreName:${tgId}`;
    if (await this.redis.client.get(awaitKey)) {
      const name = ctx.message?.text?.trim();
      if (!name) return;
      await this.redis.client.del(awaitKey);
      // Stash the name and ask for confirmation before writing to the DB.
      await this.redis.client.set(`pendingStoreName:${tgId}`, name, 'EX', 300);
      const kb = new InlineKeyboard()
        .text('✅ Підтвердити', 'ns:confirm')
        .text('✏️ Змінити', 'ns:edit');
      await ctx.reply(`Створити магазин «${name}»?`, { reply_markup: kb });
      return;
    }

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
    await this.setMenuButton(tgId);
    const user = await this.users.findByTelegramId(tgId);
    const kb = user ? this.keyboardFor(user.role) : undefined;
    await ctx.reply('✅ Вхід успішний.', kb ? { reply_markup: kb } : undefined);
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

  /** Pin the WebApp to the native bottom-left menu button for this user. */
  private async setMenuButton(chatId: number): Promise<void> {
    const url = this.config.get<string>('WEBAPP_URL');
    if (!this.bot || !url) return;
    try {
      await this.bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: { type: 'web_app', text: '📲 BOOST', web_app: { url } },
      });
    } catch (e) {
      this.logger.error(`setChatMenuButton for ${chatId} failed: ${(e as Error).message}`);
    }
  }
}
