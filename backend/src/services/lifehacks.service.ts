import { BadRequestException, Injectable } from '@nestjs/common';
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
  ) {}

  static audienceOf(segment: Experience | null): Audience {
    return segment === Experience.lt_6m ? 'newcomer' : 'experienced';
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

    // Enrich with author display name + confirmation proof (tried/ok/rate).
    const feed = await Promise.all(
      rows.map(async (r) => {
        const author = await this.authorName(r.author_id as string);
        const { tried, ok } = await this.proofOf(r.id as string);
        const content = (r.content_json ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          title: r.title,
          product_type: r.product_type,
          author,
          tried,
          ok,
          rate: tried > 0 ? Math.round((ok / tried) * 100) : 0,
          sit: content.sit ?? '',
          do: content.do ?? '',
          why: content.why ?? '',
        };
      }),
    );

    await this.redis.setFeed(categoryId, audience, JSON.stringify(feed));
    return feed;
  }

  private async authorName(authorId: string): Promise<string> {
    const { data } = await this.supabase.db
      .from('users')
      .select('name, status')
      .eq('id', authorId)
      .maybeSingle();
    if (!data) return 'Архівний автор';
    const u = data as { name: string | null; status: string };
    if (u.status === 'archived') return 'Колишній співробітник';
    return u.name || 'Продавець';
  }

  private async proofOf(lifehackId: string): Promise<{ tried: number; ok: number }> {
    const { data } = await this.supabase.db
      .from('work_items')
      .select('status')
      .eq('lifehack_id', lifehackId);
    const statuses = (data ?? []).map((r) => r.status as WorkItemStatus);
    const c = ScoringService.tallyOutcomes(statuses);
    const tried = c.success + c.partial + c.fail;
    return { tried, ok: c.success };
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
