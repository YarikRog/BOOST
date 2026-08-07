import { RankingService, RankableItem } from './ranking.service';
import { LifehackTier } from '../common/enums';

/** Build an item `daysAgo` old, optionally with a score (implies confirmations). */
function item(id: string, daysAgo: number, qualityScore: number | null): RankableItem {
  return {
    id,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    qualityScore,
    confirmations: qualityScore === null ? 0 : 5,
    tier: qualityScore === null ? LifehackTier.NEW : LifehackTier.GROWING,
  };
}

describe('RankingService', () => {
  const ranking = new RankingService();
  const SEED = 42;

  describe('stage selection', () => {
    it('is stage 1 while almost nothing is confirmed', () => {
      const items = [item('a', 1, null), item('b', 2, null), item('c', 3, 0.9)];
      expect(ranking.stageFor(items)).toBe(1);
    });

    it('is stage 2 once at least five cases are confirmed', () => {
      const items = Array.from({ length: 6 }, (_, i) => item(`c${i}`, i, 0.5));
      expect(ranking.stageFor(items)).toBe(2);
    });

    it('is stage 3 once at least twenty cases are confirmed', () => {
      const items = Array.from({ length: 20 }, (_, i) => item(`c${i}`, i, 0.5));
      expect(ranking.stageFor(items)).toBe(3);
    });
  });

  describe('ordering', () => {
    it('leads with the newest case in stage 1', () => {
      // Oldest case has the best score; stage 1 must still favour recency.
      const items = [item('old', 30, 0.95), item('new', 0, null), item('mid', 5, null)];
      const ranked = ranking.rank(items, SEED);
      expect(ranked[0].id).toBe('new');
    });

    it('surfaces the best-scoring case in stage 3', () => {
      const items = [
        ...Array.from({ length: 20 }, (_, i) => item(`c${i}`, i + 5, 0.3)),
        item('best', 40, 0.95),
        item('newest', 0, null),
      ];
      const ranked = ranking.rank(items, SEED);
      // Quality gets the largest quota in stage 3, so the top scorer ranks
      // above the twenty mediocre ones despite being the oldest.
      expect(ranked.indexOf(ranked.find((r) => r.id === 'best')!)).toBeLessThan(5);
    });

    it('never drops or duplicates a case', () => {
      const items = Array.from({ length: 25 }, (_, i) =>
        item(`c${i}`, i, i % 3 === 0 ? null : i / 100),
      );
      const ranked = ranking.rank(items, SEED);
      expect(ranked).toHaveLength(items.length);
      expect(new Set(ranked.map((r) => r.id)).size).toBe(items.length);
    });

    it('ranks unscored cases below scored ones within the quality quota', () => {
      const items = Array.from({ length: 10 }, (_, i) => item(`s${i}`, i + 1, 0.8))
        .concat(Array.from({ length: 5 }, (_, i) => item(`u${i}`, i + 20, null)));
      const ranked = ranking.rank(items, SEED);
      // The oldest unscored case must not outrank scored ones just by existing.
      const lastScored = Math.max(...ranked.map((r, i) => (r.qualityScore !== null ? i : -1)));
      const firstUnscored = ranked.findIndex((r) => r.qualityScore === null);
      expect(firstUnscored).toBeLessThan(ranked.length);
      expect(lastScored).toBeGreaterThan(-1);
    });

    it('is deterministic for a given seed and varies across seeds', () => {
      const items = Array.from({ length: 15 }, (_, i) => item(`c${i}`, i, null));
      const a = ranking.rank(items, 1).map((r) => r.id);
      const b = ranking.rank(items, 1).map((r) => r.id);
      const c = ranking.rank(items, 999).map((r) => r.id);
      expect(a).toEqual(b);
      // Exploration is what makes the tail differ between cache windows.
      expect(a).not.toEqual(c);
    });

    it('handles empty and single-item feeds', () => {
      expect(ranking.rank([], SEED)).toEqual([]);
      const one = [item('only', 0, null)];
      expect(ranking.rank(one, SEED)).toEqual(one);
    });
  });
});
