import { RankingService } from './ranking.service';
import { ScoringService } from './scoring.service';
import { LifehackTier } from '../common/enums';

/**
 * Scoring + ranking together on realistic feeds. The unit specs check each
 * service in isolation; this checks the property that actually matters to a
 * user — that the right cases reach the top of the feed at each stage.
 */
const ranking = new RankingService();
const scoring = new ScoringService();

function mk(id: string, daysAgo: number, s: number, p: number, f: number) {
  const q = scoring.compute({
    success: s, partial: p, fail: f,
    weightedLikes: 0, weightedDislikes: 0,
    daysSinceLastConfirmation: s + p + f > 0 ? 1 : null,
  });
  return {
    id,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    qualityScore: q.qualityScore, confirmations: q.confirmations, tier: q.tier,
  };
}

const newCases = (n: number) => Array.from({ length: n }, (_, i) => mk(`NEW${i}`, i, 0, 0, 0));
const SEED = 12345;

describe('feed pipeline', () => {
  it('leads with the newest case in stage 1, even when an old case scores well', () => {
    const set = [...newCases(20), mk('OLDGOOD', 90, 12, 0, 0)];
    expect(ranking.stageFor(set)).toBe(1);
    expect(ranking.rank(set, SEED)[0].id).toBe('NEW0');
  });

  it('gives quality real estate at the top in stage 2 without ceding it', () => {
    const set = [...newCases(20), ...Array.from({ length: 6 }, (_, i) => mk(`HIGH${i}`, 40 + i, 12, 1, 0))];
    expect(ranking.stageFor(set)).toBe(2);
    const top8 = ranking.rank(set, SEED).slice(0, 8).map((x) => x.id);
    // Both lanes must be represented near the top — that is what stage 2 means.
    expect(top8.some((id) => id.startsWith('HIGH'))).toBe(true);
    expect(top8.some((id) => id.startsWith('NEW'))).toBe(true);
  });

  it('leads with the best-scoring case in stage 3', () => {
    const set = [
      ...newCases(20),
      ...Array.from({ length: 5 }, (_, i) => mk(`HIGH${i}`, 40 + i, 12, 1, 0)),
      ...Array.from({ length: 5 }, (_, i) => mk(`LOW${i}`, 50 + i, 1, 1, 10)),
      ...Array.from({ length: 10 }, (_, i) => mk(`MID${i}`, 25 + i, 5, 2, 2)),
    ];
    expect(ranking.stageFor(set)).toBe(3);
    const ranked = ranking.rank(set, SEED);
    // Regression guard: taking quotas as sequential blocks used to park the
    // best case around position 11 behind a wall of unconfirmed new ones.
    expect(ranked[0].id).toBe('HIGH0');
    const worstPos = Math.min(...ranked.map((x, i) => (x.id.startsWith('LOW') ? i : Infinity)));
    expect(worstPos).toBeGreaterThan(5);
  });

  it('never loses or duplicates a case at any stage', () => {
    for (const n of [1, 5, 26, 40]) {
      const set = [...newCases(n), ...Array.from({ length: n }, (_, i) => mk(`C${i}`, i, 3, 1, 1))];
      const ranked = ranking.rank(set, SEED);
      expect(ranked).toHaveLength(set.length);
      expect(new Set(ranked.map((x) => x.id)).size).toBe(set.length);
    }
  });

  it('KNOWN LIMITATION: a 1/1 case outscores a proven 20/25 one', () => {
    // No sample-size confidence weighting yet (documented P1). The tier gate is
    // what currently contains the damage: the lucky case cannot reach TOP.
    const lucky = mk('LUCKY', 10, 1, 0, 0);
    const proven = mk('PROVEN', 10, 20, 0, 5);
    expect(lucky.qualityScore!).toBeGreaterThan(proven.qualityScore!);
    expect(lucky.tier).toBe(LifehackTier.GROWING);
    expect(proven.tier).toBe(LifehackTier.TOP);
  });
});
