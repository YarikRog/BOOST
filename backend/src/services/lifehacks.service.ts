import { BadRequestException, ForbiddenException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../integrations/supabase.client';
import { RedisService } from '../integrations/redis.client';
import { ScoringService } from './scoring.service';
import { RankingService } from './ranking.service';
import { Experience, LifehackStatus, SCORED_OUTCOMES, WorkItemStatus } from '../common/enums';
import { UserRow } from './users.service';
import { BotService } from '../bot/bot.service';

type Audience = 'newcomer' | 'experienced';

/** Whole days between an ISO timestamp and now; null passes through. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, ms / 86_400_000);
}

export interface CreateLifehackInput {
  categorySlug: string;
  productType: string;
  title: string;
  content: Record<string, unknown>;
}

/**
 * Lifehack reads/feed. Skeleton: the staged ranking (PRODUCT_LOGIC §6/§7) is
 * stubbed to "newest published" — enough to wire the feed cache + scoring shape.
 */
@Injectable()
export class LifehacksService {
  private static readonly VOICE_BUCKET = 'voice-cases';
  private static readonly VOICE_URL_TTL_SECONDS = 3600;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
    private readonly scoring: ScoringService,
    private readonly ranking: RankingService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => BotService))
    private readonly bot: BotService,
  ) {}

  static audienceOf(segment: Experience | null): Audience {
    return segment === Experience.lt_6m ? 'newcomer' : 'experienced';
  }

  /** Direct Telegram sendMessage (avoids a circular dep on BotService). */
  private async tgSend(chatId: number, text: string): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Fetch a voice case's audio bytes from Telegram (file_id → getFile →
   * download). Used by GET /lifehacks/:id/voice so the WebApp can play it.
   */
  async voiceBuffer(lifehackId: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    const { data } = await this.supabase.db
      .from('lifehacks')
      .select('content_json')
      .eq('id', lifehackId)
      .maybeSingle();
    const fileId = (data?.content_json as { voice_file_id?: string } | undefined)?.voice_file_id;
    if (!fileId) return null;
    const buffer = await this.downloadTelegramFile(fileId);
    return buffer ? { buffer, contentType: 'audio/ogg' } : null;
  }

  /** Download a Telegram file by file_id (getFile → download). */
  private async downloadTelegramFile(fileId: string): Promise<Buffer | null> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return null;
    try {
      const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
      const gfJson = (await gf.json()) as { ok: boolean; result?: { file_path?: string } };
      const filePath = gfJson.result?.file_path;
      if (!filePath) return null;
      const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
      return Buffer.from(await dl.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Copy a Telegram voice note into Supabase Storage and return a public URL.
   * Best-effort: returns null on failure, and we fall back to file_id streaming.
   */
  private async uploadVoice(fileId: string): Promise<string | null> {
    const buffer = await this.downloadTelegramFile(fileId);
    if (!buffer) return null;
    try {
      // Ensure the bucket exists (ignored if it already does). PRIVATE: these
      // are internal recordings, so access always goes through a signed URL
      // minted for an authenticated feed request — never a guessable public URL.
      await this.supabase.db.storage.createBucket(LifehacksService.VOICE_BUCKET, { public: false });
    } catch {
      /* already exists */
    }
    const path = `${randomUUID()}.ogg`;
    const { error } = await this.supabase.db.storage
      .from(LifehacksService.VOICE_BUCKET)
      .upload(path, buffer, { contentType: 'audio/ogg', upsert: false });
    if (error) return null;
    // Store the object path, not a URL — signed URLs expire, so they are minted
    // per request in the feed rather than persisted.
    return path;
  }

  /** Mint a short-lived signed URL for a stored voice object. */
  private async signVoiceUrl(path: string): Promise<string | null> {
    const { data, error } = await this.supabase.db.storage
      .from(LifehacksService.VOICE_BUCKET)
      .createSignedUrl(path, LifehacksService.VOICE_URL_TTL_SECONDS);
    if (error) return null;
    return data?.signedUrl ?? null;
  }

  /**
   * WebApp stores the chosen category/product before the user records a voice
   * note in the bot. The bot reads this to publish the voice case — enforcing
   * "pick category first". 15-min TTL, keyed by telegram id.
   */
  async setVoiceIntent(
    telegramId: number,
    intent: { categorySlug: string; productType: string },
  ): Promise<{ ok: true }> {
    await this.redis.client.set(`voiceIntent:${telegramId}`, JSON.stringify(intent), 'EX', 900);
    // Tell the user what to do now that the app closed and they're back in chat.
    await this.tgSend(
      telegramId,
      '🎙️ Натисни значок мікрофона внизу і надиктуй кейс (до 60 сек). ' +
        'Запиши й надішли голосове — я попрошу лише короткий заголовок.',
    );
    return { ok: true };
  }

  /**
   * Toggle a like/dislike on a lifehack. Cross-store weight is frozen at like
   * time (cross=1.0, same-store=0.25 — derived at scoring). You cannot react to
   * your own case. Returns the resulting reaction state (or null if toggled off).
   */
  async react(
    user: UserRow,
    lifehackId: string,
    type: 'like' | 'dislike',
  ): Promise<{ type: 'like' | 'dislike' | null }> {
    // Anti-spam: cap reactions per user per minute.
    if (await this.redis.hitReactionLimit(user.id, 20)) {
      throw new BadRequestException('Занадто багато реакцій. Спробуй за хвилину.');
    }
    const { data: lh } = await this.supabase.db
      .from('lifehacks')
      .select('author_id, author_store_id, category_id')
      .eq('id', lifehackId)
      .maybeSingle();
    if (!lh) throw new BadRequestException('Кейс не знайдено.');
    const row = lh as { author_id: string; author_store_id: string | null; category_id: string };
    if (row.author_id === user.id) {
      throw new BadRequestException('Не можна реагувати на власний кейс.');
    }

    const { data: existing } = await this.supabase.db
      .from('reactions')
      .select('id, type')
      .eq('user_id', user.id)
      .eq('lifehack_id', lifehackId)
      .maybeSingle();

    let result: 'like' | 'dislike' | null;
    if (existing) {
      const ex = existing as { id: string; type: 'like' | 'dislike' };
      if (ex.type === type) {
        await this.supabase.db.from('reactions').delete().eq('id', ex.id);
        result = null; // tapped the same reaction again → remove it
      } else {
        await this.supabase.db.from('reactions').update({ type }).eq('id', ex.id);
        result = type;
      }
    } else {
      const isCross = row.author_store_id !== user.store_id; // null store (admin) counts as cross
      await this.supabase.db.from('reactions').insert({
        user_id: user.id,
        lifehack_id: lifehackId,
        type,
        author_store_id_snap: row.author_store_id,
        user_store_id_snap: user.store_id,
        is_cross_store: isCross,
      });
      result = type;
    }

    await this.redis.invalidateFeed(row.category_id);
    return { type: result };
  }

  /** The current user's reactions (for the WebApp to highlight buttons). */
  async myReactions(userId: string): Promise<{ lifehack_id: string; type: string }[]> {
    const { data } = await this.supabase.db
      .from('reactions')
      .select('lifehack_id, type')
      .eq('user_id', userId);
    return (data as { lifehack_id: string; type: string }[]) ?? [];
  }

  /**
   * Archive a lifehack (author or admin) — it leaves the feed but the row and
   * everything referencing it survive. Hard delete would destroy other people's
   * work items and reactions, i.e. the outcome history the whole scoring model
   * is built on (PRODUCT_LOGIC §3: archived is never hard-deleted).
   */
  async remove(userId: string, isAdmin: boolean, lifehackId: string): Promise<{ ok: true }> {
    const { data: lh } = await this.supabase.db
      .from('lifehacks')
      .select('author_id, category_id, status')
      .eq('id', lifehackId)
      .maybeSingle();
    if (!lh) throw new BadRequestException('Кейс не знайдено.');
    const row = lh as { author_id: string; category_id: string; status: LifehackStatus };
    if (row.author_id !== userId && !isAdmin) {
      throw new ForbiddenException('Можна видаляти лише власний кейс.');
    }
    if (row.status === LifehackStatus.archived) return { ok: true };

    const { error } = await this.supabase.db
      .from('lifehacks')
      .update({ status: LifehackStatus.archived })
      .eq('id', lifehackId);
    if (error) throw error;

    // Free the slot for anyone still holding it — the case is gone from the
    // feed, so asking them for a result in 7 days would be noise.
    await this.supabase.db
      .from('work_items')
      .update({ status: WorkItemStatus.expired, resolved_at: new Date().toISOString() })
      .eq('lifehack_id', lifehackId)
      .eq('status', WorkItemStatus.in_work);

    await this.redis.invalidateFeed(row.category_id);
    return { ok: true };
  }

  /** Create + publish a lifehack (WebApp create flow). Returns the new id. */
  async create(author: UserRow, input: CreateLifehackInput): Promise<{ id: string }> {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Заголовок обовʼязковий.');

    const { data: cat, error: catErr } = await this.supabase.db
      .from('categories')
      .select('id, name')
      .eq('slug', input.categorySlug)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!cat) throw new BadRequestException('Невідома категорія.');
    const { id: categoryId, name: categoryName } = cat as { id: string; name: string };

    // Voice case: copy the audio into our own storage so it survives regardless
    // of the Telegram file_id lifecycle. Keep file_id as a fallback.
    const content = { ...(input.content ?? {}) } as Record<string, unknown>;
    if (content.voice_file_id) {
      const path = await this.uploadVoice(content.voice_file_id as string);
      if (path) content.voice_path = path;
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase.db
      .from('lifehacks')
      .insert({
        author_id: author.id,
        author_store_id: author.store_id, // snapshot at publish time
        category_id: categoryId,
        product_type: input.productType ?? '',
        title,
        content_json: content,
        status: LifehackStatus.published,
        published_at: nowIso,
      })
      .select('id')
      .single();
    if (error) throw error;
    const newId = (data as { id: string }).id;

    await this.redis.invalidateFeed(categoryId);
    // Fire-and-forget: notify everyone else there's a fresh case to try.
    void this.bot.broadcastNewLifehack(newId, title, categoryName, author.id);
    return { id: newId };
  }

  /** Feed by category slug — one endpoint call for the WebApp (no pre-fetch). */
  async feedBySlug(slug: string, audience: Audience): Promise<unknown[]> {
    const { data: cat } = await this.supabase.db
      .from('categories')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (!cat) return [];
    return this.feed((cat as { id: string }).id, audience);
  }

  /**
   * GET /lifehacks/feed?categoryId= — cached by category+audience (STACK.md §4).
   * Scoring and tier are computed here and shipped ready-to-render: the WebApp
   * must never recompute business values (TECH_ARCHITECTURE §4).
   */
  async feed(categoryId: string, audience: Audience): Promise<unknown[]> {
    if (!categoryId) return [];
    const cached = await this.redis.getFeed(categoryId, audience);
    if (cached) return JSON.parse(cached);

    const { data, error } = await this.supabase.db
      .from('lifehacks')
      .select('id, title, category_id, product_type, content_json, author_id, created_at')
      .eq('category_id', categoryId)
      .eq('status', LifehackStatus.published)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) {
      await this.redis.setFeed(categoryId, audience, '[]');
      return [];
    }

    // Batch-enrich (no N+1): one query each for authors, work-items, reactions.
    const authorIds = [...new Set(rows.map((r) => r.author_id as string))];
    const lifehackIds = rows.map((r) => r.id as string);

    const [{ data: users }, { data: wis }, { data: reacts }] = await Promise.all([
      this.supabase.db.from('users').select('id, name, status').in('id', authorIds),
      // resolved_at drives the recency factor — without it recency is always 0.
      this.supabase.db
        .from('work_items')
        .select('lifehack_id, status, resolved_at')
        .in('lifehack_id', lifehackIds),
      // is_cross_store is the frozen snapshot that weights each reaction.
      this.supabase.db
        .from('reactions')
        .select('lifehack_id, type, is_cross_store')
        .in('lifehack_id', lifehackIds),
    ]);

    const reByLh = new Map<
      string,
      { likes: number; dislikes: number; weightedLikes: number; weightedDislikes: number }
    >();
    (reacts ?? []).forEach((r) => {
      const key = r.lifehack_id as string;
      const e = reByLh.get(key) ?? { likes: 0, dislikes: 0, weightedLikes: 0, weightedDislikes: 0 };
      const w = ScoringService.reactionWeight(r.is_cross_store as boolean);
      if (r.type === 'like') {
        e.likes++;
        e.weightedLikes += w;
      } else {
        e.dislikes++;
        e.weightedDislikes += w;
      }
      reByLh.set(key, e);
    });

    const userById = new Map(
      (users ?? []).map((u) => [u.id as string, u as { name: string | null; status: string }]),
    );
    const statusesByLh = new Map<string, WorkItemStatus[]>();
    const lastConfirmedByLh = new Map<string, string>();
    (wis ?? []).forEach((w) => {
      const key = w.lifehack_id as string;
      const status = w.status as WorkItemStatus;
      const arr = statusesByLh.get(key) ?? [];
      arr.push(status);
      statusesByLh.set(key, arr);
      // Only scored outcomes count as a "confirmation" for recency purposes.
      const resolvedAt = w.resolved_at as string | null;
      if (resolvedAt && SCORED_OUTCOMES.includes(status as (typeof SCORED_OUTCOMES)[number])) {
        const prev = lastConfirmedByLh.get(key);
        if (!prev || resolvedAt > prev) lastConfirmedByLh.set(key, resolvedAt);
      }
    });

    const scored = await Promise.all(
      rows.map(async (r) => {
        const id = r.id as string;
        const u = userById.get(r.author_id as string);
        const author = !u
          ? 'Архівний автор'
          : u.status === 'archived'
            ? 'Колишній співробітник'
            : u.name || 'Продавець';
        const counts = ScoringService.tallyOutcomes(statusesByLh.get(id) ?? []);
        const tried = counts.success + counts.partial + counts.fail;
        const content = (r.content_json ?? {}) as Record<string, unknown>;
        const re = reByLh.get(id) ?? {
          likes: 0,
          dislikes: 0,
          weightedLikes: 0,
          weightedDislikes: 0,
        };

        const quality = this.scoring.compute({
          ...counts,
          weightedLikes: re.weightedLikes,
          weightedDislikes: re.weightedDislikes,
          daysSinceLastConfirmation: daysSince(lastConfirmedByLh.get(id) ?? null),
        });

        // Private bucket: mint a short-lived signed URL. `voice_url` on older
        // rows is a legacy public URL from before the bucket was locked down.
        const voicePath = content.voice_path as string | undefined;
        const voiceUrl = voicePath
          ? await this.signVoiceUrl(voicePath)
          : ((content.voice_url as string | undefined) ?? null);

        return {
          id,
          createdAt: r.created_at as string,
          title: r.title,
          product_type: r.product_type,
          author,
          author_id: r.author_id,
          tried,
          ok: counts.success,
          // Plain success share — a display metric, deliberately NOT the
          // weighted quality score (which also counts partial/fail/recency).
          rate: tried > 0 ? Math.round((counts.success / tried) * 100) : 0,
          likes: re.likes,
          dislikes: re.dislikes,
          // Backend is the single source of truth for both of these.
          tier: quality.tier,
          qualityScore: quality.qualityScore,
          confirmations: quality.confirmations,
          has_voice: !!(content.voice_file_id || voicePath || content.voice_url),
          voice_url: voiceUrl,
          sit: content.sit ?? '',
          do: content.do ?? '',
          why: content.why ?? '',
        };
      }),
    );

    // Seed exploration per cache window so ordering is stable while cached.
    const seed = Math.floor(Date.now() / (RedisService.FEED_TTL_SECONDS * 1000));
    const feed = this.ranking.rank(scored, seed);

    await this.redis.setFeed(categoryId, audience, JSON.stringify(feed));
    return feed;
  }

  /** Real profile stats for a user (WebApp profile screen). */
  async authorStats(userId: string): Promise<{
    written: number;
    confirmed: number;
    effectiveness: number;
    byCategory: Record<string, number>;
  }> {
    const { data: mine } = await this.supabase.db
      .from('lifehacks')
      .select('id, category_id')
      .eq('author_id', userId)
      .eq('status', LifehackStatus.published);
    const rows = mine ?? [];
    const written = rows.length;

    // Per-category counts keyed by slug.
    const { data: cats } = await this.supabase.db.from('categories').select('id, slug');
    const slugById = new Map((cats ?? []).map((c) => [c.id as string, c.slug as string]));
    const byCategory: Record<string, number> = {};
    rows.forEach((r) => {
      const s = slugById.get(r.category_id as string);
      if (s) byCategory[s] = (byCategory[s] ?? 0) + 1;
    });

    // Confirmations on my cases → confirmed (successes) + effectiveness.
    let tried = 0;
    let ok = 0;
    if (rows.length) {
      const ids = rows.map((r) => r.id as string);
      const { data: wis } = await this.supabase.db
        .from('work_items')
        .select('status')
        .in('lifehack_id', ids);
      const c = ScoringService.tallyOutcomes((wis ?? []).map((w) => w.status as WorkItemStatus));
      tried = c.success + c.partial + c.fail;
      ok = c.success;
    }
    const effectiveness = tried > 0 ? Math.round((ok / tried) * 100) : 0;
    return { written, confirmed: ok, effectiveness, byCategory };
  }

  /** Recompute a lifehack's quality via the ONE scoring function. */
  async qualityOf(lifehackId: string) {
    const { data, error } = await this.supabase.db
      .from('work_items')
      .select('status, resolved_at')
      .eq('lifehack_id', lifehackId);
    if (error) throw error;

    const statuses = (data ?? []).map((r) => r.status as WorkItemStatus);
    const counts = ScoringService.tallyOutcomes(statuses);

    // Most recent scored confirmation drives the recency factor.
    let lastConfirmedAt: string | null = null;
    (data ?? []).forEach((r) => {
      const status = r.status as WorkItemStatus;
      const resolvedAt = r.resolved_at as string | null;
      if (resolvedAt && SCORED_OUTCOMES.includes(status as (typeof SCORED_OUTCOMES)[number])) {
        if (!lastConfirmedAt || resolvedAt > lastConfirmedAt) lastConfirmedAt = resolvedAt;
      }
    });

    // Fold reaction weights from the frozen cross-store snapshot.
    const { data: reacts } = await this.supabase.db
      .from('reactions')
      .select('type, is_cross_store')
      .eq('lifehack_id', lifehackId);
    let weightedLikes = 0;
    let weightedDislikes = 0;
    (reacts ?? []).forEach((r) => {
      const w = ScoringService.reactionWeight(r.is_cross_store as boolean);
      if (r.type === 'like') weightedLikes += w;
      else weightedDislikes += w;
    });

    return this.scoring.compute({
      ...counts,
      weightedLikes,
      weightedDislikes,
      daysSinceLastConfirmation: daysSince(lastConfirmedAt),
    });
  }
}
