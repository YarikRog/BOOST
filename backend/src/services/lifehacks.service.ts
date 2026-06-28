import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../integrations/supabase.client';
import { RedisService } from '../integrations/redis.client';
import { ScoringService } from './scoring.service';
import { Category, Experience, LifehackStatus, WorkItemStatus } from '../common/enums';

type Audience = 'newcomer' | 'experienced';

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

  /** GET /lifehacks/feed?category= — cached by category+audience (STACK.md §4). */
  async feed(category: Category, audience: Audience): Promise<unknown[]> {
    const cached = await this.redis.getFeed(category, audience);
    if (cached) return JSON.parse(cached);

    // TODO: staged ranking (Stage 1/2/3, per category). Skeleton: newest first.
    const { data, error } = await this.supabase.db
      .from('lifehacks')
      .select('id, title, category, product_type, author_id, created_at')
      .eq('category', category)
      .eq('status', LifehackStatus.published)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const feed = data ?? [];
    await this.redis.setFeed(category, audience, JSON.stringify(feed));
    return feed;
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
