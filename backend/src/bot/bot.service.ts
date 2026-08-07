import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, Keyboard, Context } from 'grammy';
import { RedisService } from '../integrations/redis.client';
import { SupabaseService } from '../integrations/supabase.client';
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

const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.MEGA_ADMIN]: 'Адміністратор',
  [UserRole.REGIONAL_IT_LEAD]: 'Регіональний ІТ-лід',
  [UserRole.DIRECTOR]: 'Директор (Store IT-лід)',
  [UserRole.DEP_DIRECTOR]: 'Заступник директора',
  [UserRole.SELLER]: 'Продавець (IT-експерт)',
};
const roleLabel = (r: UserRole): string => ROLE_LABELS[r] ?? r;
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
    private readonly supabase: SupabaseService,
    private readonly invites: InvitesService,
    private readonly users: UsersService,
    @Inject(forwardRef(() => LifehacksService))
    private readonly lifehacks: LifehacksService,
    private readonly categories: CategoriesService,
  ) {}

  /**
   * Queue a bot message for deletion in 5 minutes (keeps command chatter from
   * piling up). Backed by Redis (see AutoDeleteWorker), not setTimeout — a
   * redeploy restarts this process often, which would silently drop in-memory
   * timers and leave messages stuck forever.
   */
  private scheduleAutoDelete(chatId: number, messageId: number): void {
    void this.redis.scheduleMessageDelete(chatId, messageId, 5 * 60 * 1000);
  }

  /** Called by AutoDeleteWorker's sweep — actually deletes a due message. */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.bot?.api.deleteMessage(chatId, messageId).catch(() => {
      /* already deleted, or too old for the bot to remove — ignore */
    });
  }

  /**
   * Send a critical-error alert straight to the admin's Telegram, bypassing
   * everything else (DB, cache, business logic) — this is the "the app is on
   * fire" channel, so it must work even if the DB is down. Targets
   * BOOTSTRAP_ADMIN_TELEGRAM_ID directly rather than querying MEGA_ADMIN from
   * the database, for exactly that reason. Never throws.
   */
  async alertAdmin(source: string, message: string): Promise<void> {
    if (!this.bot) return;
    const adminId = this.config.get<string>('BOOTSTRAP_ADMIN_TELEGRAM_ID');
    if (!adminId) return;
    try {
      await this.bot.api.sendMessage(
        Number(adminId),
        `🚨 Помилка на бекенді (${source})\n\n${message.slice(0, 3500)}`,
      );
    } catch (e) {
      this.logger.error(`alertAdmin failed to notify: ${(e as Error).message}`);
    }
  }

  /**
   * Ping everyone (except the author) that a fresh case just dropped, with a
   * button straight into the WebApp. Best-effort per user — one blocked/left
   * user must never stop the rest of the broadcast, and a small delay between
   * sends keeps us well under Telegram's flood limits.
   */
  async broadcastNewLifehack(
    lifehackId: string,
    title: string,
    categoryName: string,
    authorId: string,
  ): Promise<void> {
    if (!this.bot) return;
    const webAppUrl = this.config.get<string>('WEBAPP_URL');
    try {
      const { data: recipients, error } = await this.supabase.db
        .from('users')
        .select('telegram_id')
        .eq('status', 'active')
        .neq('id', authorId);
      if (error) throw error;

      const kb = webAppUrl
        ? new InlineKeyboard().webApp('📲 Відкрити BOOST', webAppUrl)
        : undefined;
      const text =
        `✨ Новий лайфхак у стрічці «${categoryName}»\n\n` +
        `«${title}»\n\n` +
        `Глянь, може саме він допоможе тобі закрити наступний продаж 👇`;

      for (const r of (recipients ?? []) as Array<{ telegram_id: number }>) {
        try {
          await this.bot.api.sendMessage(r.telegram_id, text, kb ? { reply_markup: kb } : undefined);
        } catch (e) {
          this.logger.warn(`broadcastNewLifehack to ${r.telegram_id} failed: ${(e as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 40)); // stay under flood limits
      }
    } catch (e) {
      this.logger.error(`broadcastNewLifehack(${lifehackId}) failed: ${(e as Error).message}`);
    }
  }

  /** 7-day check: ask the taker if the case worked, with resolve buttons. */

  async sendResultPrompt(telegramId: number, workItemId: string, title: string): Promise<boolean> {
    if (!this.bot) return false;
    const kb = new InlineKeyboard()
      .text('🔥 Так, продав', `wres:${workItemId}:success`)
      .row()
      .text('😐 Частково', `wres:${workItemId}:partial`)
      .text('❌ Ні', `wres:${workItemId}:fail`)
      .row()
      .text('⏭ Не пробував', `wres:${workItemId}:not_tried`);
    try {
      await this.bot.api.sendMessage(
        telegramId,
        `⏰ Ти брав кейс «${title}» у роботу 7 днів тому. Спрацювало?`,
        { reply_markup: kb },
      );
      return true;
    } catch (e) {
      // Reported, not swallowed: the caller releases its claim so the next
      // sweep retries instead of the prompt being silently lost.
      this.logger.error(`sendResultPrompt to ${telegramId} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Notify a case's author that it just worked for a colleague (engagement loop). */
  async notifyAuthorSuccess(lifehackId: string): Promise<void> {
    if (!this.bot) return;
    try {
      const { data: lh } = await this.supabase.db
        .from('lifehacks')
        .select('author_id, title')
        .eq('id', lifehackId)
        .maybeSingle();
      if (!lh) return;
      const author = lh as { author_id: string; title: string };
      const { data: u } = await this.supabase.db
        .from('users')
        .select('telegram_id')
        .eq('id', author.author_id)
        .maybeSingle();
      const tg = (u as { telegram_id: number } | null)?.telegram_id;
      if (!tg) return;
      const { count } = await this.supabase.db
        .from('work_items')
        .select('id', { count: 'exact', head: true })
        .eq('lifehack_id', lifehackId)
        .eq('status', 'success');
      await this.bot.api.sendMessage(
        tg,
        `🔥 Твій кейс «${author.title}» щойно спрацював у колеги! ` +
          `Уже ${count ?? 1} підтверджень. Так тримати 💪`,
      );
    } catch (e) {
      this.logger.error(`notifyAuthorSuccess failed: ${(e as Error).message}`);
    }
  }

  /** Notify a case's author that a colleague just took it into work (engagement loop). */
  async notifyAuthorTaken(lifehackId: string): Promise<void> {
    if (!this.bot) return;
    try {
      const { data: lh } = await this.supabase.db
        .from('lifehacks')
        .select('author_id, title')
        .eq('id', lifehackId)
        .maybeSingle();
      if (!lh) return;
      const author = lh as { author_id: string; title: string };
      const { data: u } = await this.supabase.db
        .from('users')
        .select('telegram_id')
        .eq('id', author.author_id)
        .maybeSingle();
      const tg = (u as { telegram_id: number } | null)?.telegram_id;
      if (!tg) return;
      await this.bot.api.sendMessage(
        tg,
        `✨ Твій кейс «${author.title}» щойно взяли в роботу!\n\n` +
          `Хтось із колег зараз спробує твій прийом із клієнтом — можливо, ` +
          `саме він допоможе комусь закрити продаж. Дякуємо, що ділишся 🙌`,
      );
    } catch (e) {
      this.logger.error(`notifyAuthorTaken failed: ${(e as Error).message}`);
    }
  }

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
    // Auto-delete every ctx.reply() after 5 minutes so command chatter
    // (/stats, /users, /stores, /regions, confirmations, etc.) doesn't
    // clutter the chat. Background/proactive messages (7-day reminders,
    // author-success pings) go through bot.api.sendMessage directly and
    // are untouched by this.
    bot.use(async (ctx, next) => {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = (async (...args: Parameters<typeof originalReply>) => {
        const msg = await originalReply(...args);
        this.scheduleAutoDelete(msg.chat.id, msg.message_id);
        return msg;
      }) as typeof ctx.reply;
      await next();
    });

    // The command message itself (e.g. "/stats") gets deleted immediately
    // once we're done handling it — no reason for it to linger either.
    bot.use(async (ctx, next) => {
      const isCommand = ctx.message?.text?.startsWith('/');
      await next();
      if (isCommand && ctx.chat) {
        await ctx.deleteMessage().catch(() => {
          /* can't delete (e.g. >48h old) — ignore */
        });
      }
    });

    // Commands first — the generic message:text handler below stops the chain
    // when it has nothing to do, so it must be registered last.
    bot.command('start', (ctx) => this.onStart(ctx));
    bot.command('app', (ctx) => this.sendAppButton(ctx));
    bot.command('newstore', (ctx) => this.onNewStore(ctx));
    bot.command('reset', (ctx) => this.onReset(ctx));
    bot.command('stores', (ctx) => this.onStores(ctx));
    bot.command('regions', (ctx) => this.onRegions(ctx));
    bot.command('help', (ctx) => this.onHelp(ctx));
    bot.command('stats', (ctx) => this.onStats(ctx));
    bot.command('users', (ctx) => this.onUsers(ctx));
    bot.callbackQuery(/^delstore:(.+)$/, (ctx) => this.onDeleteStoreConfirm(ctx));
    bot.callbackQuery(/^delregion:(.+)$/, (ctx) => this.onDeleteRegionConfirm(ctx));
    bot.callbackQuery(/^doDelStore:(.+)$/, (ctx) => this.onDeleteStore(ctx));
    bot.callbackQuery(/^doDelRegion:(.+)$/, (ctx) => this.onDeleteRegion(ctx));
    bot.callbackQuery(/^cancelDel$/, (ctx) => this.onCancelDelete(ctx));
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
    bot.callbackQuery(/^wres:([0-9a-f-]+):(success|partial|fail|not_tried)$/, (ctx) =>
      this.onResolveWork(ctx),
    );
    bot.on('message:text', (ctx) => this.onText(ctx));
    bot.catch((err) => {
      this.logger.error(`Bot error: ${err.message}`);
      void this.alertAdmin('bot', `${err.message}\n${err.stack ?? ''}`);
    });
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

  /** Resolve buttons on the 7-day check prompt → write the outcome. */
  private async onResolveWork(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const m = ctx.match as RegExpMatchArray;
    const workItemId = m[1];
    const outcome = m[2];

    const user = await this.users.findByTelegramId(tgId);
    if (!user) return;

    const { data } = await this.supabase.db
      .from('work_items')
      .update({ status: outcome, resolved_at: new Date().toISOString() })
      .eq('id', workItemId)
      .eq('user_id', user.id)
      .eq('status', 'in_work')
      .select('id, lifehack_id')
      .maybeSingle();

    if (!data) {
      await ctx.reply('Цей кейс уже підтверджено або не активний.');
      return;
    }
    // A real outcome changes the score → drop the category feed cache.
    const { data: lh } = await this.supabase.db
      .from('lifehacks')
      .select('category_id')
      .eq('id', (data as { lifehack_id: string }).lifehack_id)
      .maybeSingle();
    if (lh) await this.redis.invalidateFeed((lh as { category_id: string }).category_id);
    if (outcome === 'success') {
      await this.notifyAuthorSuccess((data as { lifehack_id: string }).lifehack_id);
    }

    const labels: Record<string, string> = {
      success: '🔥 Зараховано як успіх! Дякую.',
      partial: 'Дякуємо за відповідь.',
      fail: 'Дякуємо за відповідь.',
      not_tried: 'Не враховується в рейтинг. Дякую.',
    };
    await ctx.reply(labels[outcome] ?? 'Дякуємо.');
  }

  /** `/help` — list available commands (admin sees management ones). */
  private async onHelp(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    const caller = tgId ? await this.users.findByTelegramId(tgId) : null;
    const admin = caller ? this.isAdmin(caller.role) : false;

    let text =
      '📖 ДОВІДКА BOOST\n\n' +
      '━━ Для всіх ━━\n' +
      '/start — увійти / показати головне меню з кнопками\n' +
      '/app — відкрити застосунок з кейсами\n' +
      '/help — цей список команд\n\n' +
      '🎙️ Щоб додати голосовий кейс: у застосунку тисни «+», обери ' +
      'категорію і товар, натисни мікрофон — далі надішли сюди голосове.';

    if (admin) {
      text +=
        '\n\n━━ 👑 Адмін ━━\n\n' +
        '📊 СТАТИСТИКА\n' +
        '/stats — зведення по платформі: скільки юзерів, магазинів, кейсів, ' +
        'скільки разів відкривали застосунок (всього / сьогодні / за тиждень), ' +
        'скільки підтверджень і % успішності\n' +
        '/users — по кожному юзеру: скільки написав кейсів (✍️), скільки взяв ' +
        'у роботу (📌), скільки успішних (🔥), скільки разів відкривав ' +
        'застосунок (📱) і коли заходив востаннє\n\n' +
        '🏪 МАГАЗИНИ І РЕГІОНИ\n' +
        '/stores — список усіх магазинів; тап по магазину видаляє порожній\n' +
        '/regions — список регіонів зі скількістю людей; видаляє порожні\n' +
        '/newstore <назва> — створити магазин одразу з назвою ' +
        '(без назви — запитає)\n\n' +
        '🧹 ОБСЛУГОВУВАННЯ\n' +
        '/reset — видалити СЕБЕ (потім /start створить заново)\n' +
        '/reset <telegram_id> — видалити конкретного юзера (для тестів)\n\n' +
        '⌨️ КНОПКИ ЗНИЗУ\n' +
        '🏪 Створити магазин — новий магазин\n' +
        '➕ Рег. ІТ-лід — запросити регіонального ліда (спершу спитає регіон)\n' +
        '➕ Директор — запросити директора магазину (спершу спитає регіон)';
    }
    await ctx.reply(text);
  }

  /** Admin-only: `/stats` — platform-wide numbers. */
  private async onStats(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    const caller = tgId ? await this.users.findByTelegramId(tgId) : null;
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }
    const s = await this.users.platformStats();
    await ctx.reply(
      '📊 Статистика платформи\n\n' +
        `👥 Юзери: ${s.users} (активних ${s.activeUsers})\n` +
        `🏪 Магазини: ${s.stores} · Регіони: ${s.regions}\n` +
        `💡 Кейси опубліковано: ${s.lifehacks}\n\n` +
        `📱 Відкриттів застосунку: ${s.opens.total} всього\n` +
        `   сьогодні ${s.opens.today} · за тиждень ${s.opens.week} ` +
        `(${s.opens.uniqueWeek} унік. юзерів)\n\n` +
        `📌 В роботі зараз: ${s.wc.in_work}\n` +
        `✅ Підтверджень: ${s.confirmations} ` +
        `(🔥 ${s.wc.success} / 😐 ${s.wc.partial} / ❌ ${s.wc.fail})\n` +
        `⏭ Не пробували: ${s.wc.not_tried} · Протерміновано: ${s.wc.expired}\n` +
        `🎯 Success rate: ${s.successRate}%\n\n` +
        `🙋 Залучення: авторів ${s.engaged.authors}, тих хто брав ${s.engaged.takers}`,
    );
  }

  /** Admin-only: `/users` — per-user activity. */
  private async onUsers(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    const caller = tgId ? await this.users.findByTelegramId(tgId) : null;
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }
    const rows = await this.users.usersActivity();
    if (!rows.length) {
      await ctx.reply('Ще немає юзерів.');
      return;
    }
    const ago = (iso: string | null): string => {
      if (!iso) return 'не заходив';
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
      if (days === 0) return 'сьогодні';
      if (days === 1) return 'вчора';
      return `${days} дн. тому`;
    };
    const lines = rows.map(
      (r) =>
        `• ${r.name} (${roleLabel(r.role as UserRole)})\n` +
        `   ✍️${r.written} 📌${r.taken} 🔥${r.success} 📱${r.opens} · ${ago(r.lastSeen)}`,
    );
    await ctx.reply(
      '👥 Активність\n✍️ написав · 📌 брав у роботу · 🔥 успіх · 📱 відкриттів застосунку\n\n' +
        lines.join('\n'),
    );
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
      const label = s.userCount === 0 ? `🗑 ${s.name} (0 людей)` : `${s.name} (${s.userCount} 👥)`;
      kb.text(label, `delstore:${s.id}`).row();
    }
    await ctx.reply(`Магазини (${stores.length}). Тисни, щоб видалити порожній:`, { reply_markup: kb });
  }

  /** First tap on a 🗑 store button from /stores → ask for confirmation. */
  private async onDeleteStoreConfirm(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }
    const storeId = (ctx.match as RegExpMatchArray)[1];
    const name = await this.users.storeName(storeId);
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `doDelStore:${storeId}`)
      .text('❌ Скасувати', 'cancelDel');
    await ctx.reply(`Точно видалити магазин «${name ?? storeId}»?`, { reply_markup: kb });
  }

  /** Second tap (after confirmation) → actually delete the store. */
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

  /** Cancel button on any delete-confirmation prompt. */
  private async onCancelDelete(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery();
    await ctx.reply('Скасовано.');
  }

  /** Admin-only: `/regions` lists every region with user counts and delete button. */
  private async onRegions(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const regions = await this.users.listRegionsWithCounts();
    if (!regions.length) {
      await ctx.reply('Регіонів ще немає.');
      return;
    }

    const kb = new InlineKeyboard();
    for (const r of regions) {
      const label = r.userCount === 0 ? `🗑 ${r.name} (0 людей)` : `${r.name} (${r.userCount} 👥)`;
      kb.text(label, `delregion:${r.id}`).row();
    }
    await ctx.reply(`Регіони (${regions.length}). Тисни, щоб видалити порожній:`, { reply_markup: kb });
  }

  /** First tap on a region button from /regions → ask for confirmation. */
  private async onDeleteRegionConfirm(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }
    const regionId = (ctx.match as RegExpMatchArray)[1];
    const regions = await this.users.listRegionsWithCounts();
    const region = regions.find((r) => r.id === regionId);
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `doDelRegion:${regionId}`)
      .text('❌ Скасувати', 'cancelDel');
    await ctx.reply(`Точно видалити регіон «${region?.name ?? regionId}»?`, { reply_markup: kb });
  }

  /** Second tap (after confirmation) → actually delete the region. */
  private async onDeleteRegion(ctx: Context): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await ctx.answerCallbackQuery();
    const caller = await this.users.findByTelegramId(tgId);
    if (!caller || !this.isAdmin(caller.role)) {
      await ctx.reply('🔒 Команда лише для адміністратора.');
      return;
    }

    const regionId = (ctx.match as RegExpMatchArray)[1];
    try {
      const res = await this.users.deleteRegion(regionId);
      if (res === 'not_found') await ctx.reply('Регіон уже видалено.');
      else if (res === 'has_users') await ctx.reply('❌ У регіоні є користувачі — спочатку прибери їх через /reset.');
      else await ctx.reply('🗑 Регіон видалено.');
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  /** Role-appropriate reply keyboard (store creation / invites). */
  private keyboardFor(role: UserRole): Keyboard | undefined {
    switch (role) {
      case UserRole.MEGA_ADMIN:
        return new Keyboard()
          .text(ADMIN_NEW_STORE_BTN)
          .row()
          .text(BTN_INV_REGIONAL)
          .text(BTN_INV_DIRECTOR)
          .resized();
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

    // Needs a region first (ask its name): inviting a REGIONAL, or MEGA_ADMIN
    // inviting a DIRECTOR directly (pilot bypass). The role is stored so onText
    // knows what to create after the region.
    const needsRegion =
      targetRole === UserRole.REGIONAL_IT_LEAD ||
      (targetRole === UserRole.DIRECTOR && creator.role === UserRole.MEGA_ADMIN);
    if (needsRegion) {
      await this.redis.client.set(`awaitRegionName:${tgId}`, targetRole, 'EX', 300);
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

    // Already onboarded — re-entry regardless of which link they used, UNLESS
    // they have no store yet and this link points to one (e.g. MEGA_ADMIN
    // joining a store via the director's invite link, purely for visibility —
    // role is untouched).
    const existing = await this.users.findByTelegramId(tgId);
    if (existing && existing.phone && existing.experience_segment) {
      if (payload && !existing.store_id) {
        const storeId = await this.resolveStoreIdFromPayload(payload);
        if (storeId) {
          try {
            await this.users.attachToStore(existing.id, storeId);
            await ctx.reply('✅ Тебе додано до магазину.');
          } catch (e) {
            await ctx.reply(`❌ ${(e as Error).message}`);
          }
        }
      }
      await this.setMenuButton(tgId);
      const kb = this.keyboardFor(existing.role);
      await ctx.reply(
        `Вітаю знову! Роль: ${roleLabel(existing.role)}`,
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
        await ctx.reply(`Вітаємо! Роль: ${roleLabel(user.role)}. Завершимо вхід.`);
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
        await ctx.reply(`Вітаю знову! Роль: ${roleLabel(user.role)}`);
        await this.sendAppButton(ctx);
        return;
      }
      await this.setState(tgId, { userId: user.id, role: user.role, step: 'phone' });
      await ctx.reply(`Вас запрошено як: ${roleLabel(user.role)}. Завершимо вхід.`);
      await this.askPhone(ctx);
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`);
    }
  }

  /** Extract a store id from any kind of /start payload — pilot link or single-use invite token. */
  private async resolveStoreIdFromPayload(payload: string): Promise<string | null> {
    const storeLinkMatch = payload.match(/^(store|dir)_(.+)$/);
    if (storeLinkMatch) return storeLinkMatch[2];
    const scope = await this.invites.peekScope(payload);
    return scope?.storeId ?? null;
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

    // Invite flow: admin entered a region name → find/create region + invite the
    // stored target role (REGIONAL, or DIRECTOR when admin bypasses the chain).
    const regionKey = `awaitRegionName:${tgId}`;
    const pendingRole = await this.redis.client.get(regionKey);
    if (pendingRole) {
      const regionName = ctx.message?.text?.trim();
      if (!regionName) return;
      await this.redis.client.del(regionKey);
      try {
        const creator = await this.users.findByTelegramId(tgId);
        if (!creator) return;
        const targetRole = pendingRole as UserRole;
        const region = await this.users.createRegion(regionName);
        const invite = await this.invites.create(creator, targetRole, { regionId: region.id });
        await ctx.reply(`✅ Регіон «${region.name}».`);
        await this.sendInviteLink(ctx, targetRole, invite.deepLink);
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
