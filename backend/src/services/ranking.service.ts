import { Injectable } from '@nestjs/common';
import { LifehackTier } from '../common/enums';

/** One ranked feed entry: the scoring output plus what ordering needs. */
export interface RankableItem {
  id: string;
  createdAt: string;
  qualityScore: number | null;
  confirmations: number;
  tier: LifehackTier;
}

/**
 * Staged feed ranking (PRODUCT_LOGIC §6/§7). Deterministic, not ML — the stage
 * is chosen from how much confirmed evidence the category actually has, so a
 * fresh deploy shows new cases while a mature one surfaces what works.
 *
 *   Stage 1 (cold start):  90% newest        + 10% exploration
 *   Stage 2 (warming):     40% newest / 40% best / 20% exploration
 *   Stage 3 (mature):      quality-first, exploration kept as a tail
 *
 * Exploration exists so a good case published on a quiet day still gets seen —
 * without it the feed self-reinforces whatever ranked well first.
 */
@Injectable()
export class RankingService {
  // A category needs this many confirmed cases before quality means anything.
  private static readonly STAGE2_MIN_CONFIRMED_CASES = 5;
  private static readonly STAGE3_MIN_CONFIRMED_CASES = 20;

  /** Which stage a category is in, from its confirmed-case count. */
  stageFor(items: RankableItem[]): 1 | 2 | 3 {
    const confirmed = items.filter((i) => i.confirmations > 0).length;
    if (confirmed >= RankingService.STAGE3_MIN_CONFIRMED_CASES) return 3;
    if (confirmed >= RankingService.STAGE2_MIN_CONFIRMED_CASES) return 2;
    return 1;
  }

  /**
   * Order items for the feed. `seed` makes exploration stable within a cache
   * window (same seed → same order), so a user scrolling doesn't see items
   * jump around between requests that hit and miss the cache.
   */
  rank<T extends RankableItem>(items: T[], seed: number): T[] {
    if (items.length <= 1) return items;
    const stage = this.stageFor(items);

    const byNewest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Unscored cases (no confirmations yet) can't be "best" — they sort last.
    const byQuality = [...items].sort((a, b) => {
      const qa = a.qualityScore ?? -Infinity;
      const qb = b.qualityScore ?? -Infinity;
      if (qa !== qb) return qb - qa;
      return b.createdAt.localeCompare(a.createdAt);
    });

    const quotas =
      stage === 1
        ? { newest: 0.9, quality: 0.0 }
        : stage === 2
          ? { newest: 0.4, quality: 0.4 }
          : { newest: 0.2, quality: 0.6 };

    const total = items.length;
    const nNewest = Math.round(total * quotas.newest);
    const nQuality = Math.round(total * quotas.quality);

    const picked = new Set<string>();
    const out: T[] = [];
    const take = (source: T[], n: number): void => {
      for (const item of source) {
        if (out.length >= total || n <= 0) break;
        if (picked.has(item.id)) continue;
        picked.add(item.id);
        out.push(item);
        n--;
      }
    };

    take(byNewest, nNewest);
    take(byQuality, nQuality);

    const rng = this.rng(seed);

    // Everything neither quota claimed is the exploration pool. These are
    // spliced into random positions rather than appended, because an item
    // parked at the bottom of the feed is never seen — which would make
    // exploration decorative.
    const exploration = this.shuffle(
      items.filter((i) => !picked.has(i.id)),
      rng,
    );
    for (const item of exploration) {
      out.splice(rng() % (out.length + 1), 0, item);
    }
    return out;
  }

  /** xorshift32 — small, fast, deterministic across Node versions. */
  private rng(seed: number): () => number {
    let state = seed || 1;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return Math.abs(state);
    };
  }

  /** Seeded Fisher-Yates so exploration order is reproducible for a given seed. */
  private shuffle<T>(items: T[], rng: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng() % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
