import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../integrations/supabase.client';
import { RedisService } from '../integrations/redis.client';
import { ScoringService } from './scoring.service';
import { Experience, LifehackStatus, WorkItemStatus } from '../common/enums';
import { UserRow } from './users.service';

type Audience = 'newcomer' | 'experienced';

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
  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
    private readonly scoring: ScoringService,
    private readonly config: ConfigService,
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
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return null;
    const { data } = await this.supabase.db
      .from('lifehacks')
      .select('content_json')
      .eq('id', lifehackId)
      .maybeSingle();
    const fileId = (data?.content_json as { voice_file_id?: string } | undefined)?.voice_file_id;
    if (!fileId) return null;

    const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const gfJson = (await gf.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = gfJson.result?.file_path;
    if (!filePath) return null;

    const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    const buffer = Buffer.from(await dl.arrayBuffer());
    return { buffer, contentType: 'audio/ogg' };
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

  /** Create + publish a lifehack (WebApp create flow). Returns the new id. */
  async create(author: UserRow, input: CreateLifehackInput): Promise<{ id: string }> {
    const title = input.title?.trim();
    if (!title) throw new BadRequestException('Заголовок обовʼязковий.');

    const { data: cat, error: catErr } = await this.supabase.db
      .from('categories')
      .select('id')
      .eq('slug', input.categorySlug)
      .maybeSingle();
    if (catErr) throw catErr;
    if (!cat) throw new BadRequestException('Невідома категорія.');
    const categoryId = (cat as { id: string }).id;

    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase.db
      .from('lifehacks')
      .insert({
        author_id: author.id,
        author_store_id: author.store_id, // snapshot at publish time
        category_id: categoryId,
        product_type: input.productType ?? '',
        title,
        content_json: input.content ?? {},
        status: LifehackStatus.published,
        published_at: nowIso,
      })
      .select('id')
      .single();
    if (error) throw error;

    await this.redis.invalidateFeed(categoryId);
    return { id: (data as { id: string }).id };
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

  /** GET /lifehacks/feed?categoryId= — cached by category+audience (STACK.md §4). */
  async feed(categoryId: string, audience: Audience): Promise<unknown[]> {
    const cached = await this.redis.getFeed(categoryId, audience);
    if (cached) return JSON.parse(cached);

    // TODO: staged ranking (Stage 1/2/3, per category). Skeleton: newest first.
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

    // Batch-enrich (no N+1): one query for authors, one for all work-items.
    const authorIds = [...new Set(rows.map((r) => r.author_id as string))];
    const lifehackIds = rows.map((r) => r.id as string);

    const [{ data: users }, { data: wis }] = await Promise.all([
      this.supabase.db.from('users').select('id, name, status').in('id', authorIds),
      this.supabase.db.from('work_items').select('lifehack_id, status').in('lifehack_id', lifehackIds),
    ]);

    const userById = new Map(
      (users ?? []).map((u) => [u.id as string, u as { name: string | null; status: string }]),
    );
    const statusesByLh = new Map<string, WorkItemStatus[]>();
    (wis ?? []).forEach((w) => {
      const arr = statusesByLh.get(w.lifehack_id as string) ?? [];
      arr.push(w.status as WorkItemStatus);
      statusesByLh.set(w.lifehack_id as string, arr);
    });

    const feed = rows.map((r) => {
      const u = userById.get(r.author_id as string);
      const author = !u
        ? 'Архівний автор'
        : u.status === 'archived'
          ? 'Колишній співробітник'
          : u.name || 'Продавець';
      const c = ScoringService.tallyOutcomes(statusesByLh.get(r.id as string) ?? []);
      const tried = c.success + c.partial + c.fail;
      const ok = c.success;
      const content = (r.content_json ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        product_type: r.product_type,
        author,
        author_id: r.author_id,
        tried,
        ok,
        rate: tried > 0 ? Math.round((ok / tried) * 100) : 0,
        has_voice: !!content.voice_file_id,
        sit: content.sit ?? '',
        do: content.do ?? '',
        why: content.why ?? '',
      };
    });

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
      .select('status')
      .eq('lifehack_id', lifehackId);
    if (error) throw error;

    const statuses = (data ?? []).map((r) => r.status as WorkItemStatus);
    const counts = ScoringService.tallyOutcomes(statuses);

    // Reaction weights would be folded in here from the reactions table.
    return this.scoring.compute({
      ...counts,
      weightedLikes: 0,
      weightedDislikes: 0,
      daysSinceLastConfirmation: null,
    });
  }
}
