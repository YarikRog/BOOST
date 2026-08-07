import { ScoringService } from './scoring.service';
import { LifehackTier, WorkItemStatus } from '../common/enums';

/** Baseline input: no evidence at all. Specs override only what they exercise. */
const base = {
  success: 0,
  partial: 0,
  fail: 0,
  weightedLikes: 0,
  weightedDislikes: 0,
  daysSinceLastConfirmation: null as number | null,
};

describe('ScoringService', () => {
  const scoring = new ScoringService();

  describe('quality score', () => {
    it('is null with no confirmations, so likes alone cannot promote a case', () => {
      const r = scoring.compute({ ...base, weightedLikes: 50 });
      expect(r.qualityScore).toBeNull();
      expect(r.confirmations).toBe(0);
      expect(r.tier).toBe(LifehackTier.NEW);
    });

    it('scores a lone fresh success at the top of the range', () => {
      const r = scoring.compute({ ...base, success: 1, daysSinceLastConfirmation: 0 });
      // 0.6*1.0 (confirmation) + 0.2*0 (no reactions) + 0.2*1.0 (fresh)
      expect(r.qualityScore).toBeCloseTo(0.8, 5);
      expect(r.confirmationSuccessRate).toBeCloseTo(1.0, 5);
    });

    it('weights partial below success and fail negatively', () => {
      const r = scoring.compute({
        ...base,
        success: 1,
        partial: 1,
        fail: 1,
        daysSinceLastConfirmation: 0,
      });
      // (1.0 + 0.3 - 0.5) / 3 = 0.2666…
      expect(r.confirmationSuccessRate).toBeCloseTo(0.8 / 3, 5);
      expect(r.confirmations).toBe(3);
    });

    it('halves the recency factor every 30 days', () => {
      const fresh = scoring.compute({ ...base, success: 1, daysSinceLastConfirmation: 0 });
      const month = scoring.compute({ ...base, success: 1, daysSinceLastConfirmation: 30 });
      const twoMonths = scoring.compute({ ...base, success: 1, daysSinceLastConfirmation: 60 });
      expect(fresh.recencyFactor).toBeCloseTo(1.0, 5);
      expect(month.recencyFactor).toBeCloseTo(0.5, 5);
      expect(twoMonths.recencyFactor).toBeCloseTo(0.25, 5);
      // A stale case must score strictly below the identical fresh one.
      expect(twoMonths.qualityScore!).toBeLessThan(fresh.qualityScore!);
    });

    it('nets likes against dislikes into [-1, 1]', () => {
      const allLikes = scoring.compute({ ...base, success: 1, weightedLikes: 4 });
      const split = scoring.compute({ ...base, success: 1, weightedLikes: 2, weightedDislikes: 2 });
      const allDislikes = scoring.compute({ ...base, success: 1, weightedDislikes: 4 });
      expect(allLikes.weightedLikeRate).toBeCloseTo(1, 5);
      expect(split.weightedLikeRate).toBeCloseTo(0, 5);
      expect(allDislikes.weightedLikeRate).toBeCloseTo(-1, 5);
    });
  });

  describe('tier', () => {
    it('is NEW with zero confirmations', () => {
      expect(scoring.compute({ ...base }).tier).toBe(LifehackTier.NEW);
    });

    it('is GROWING with some confirmations but fewer than ten', () => {
      const r = scoring.compute({ ...base, success: 9, daysSinceLastConfirmation: 0 });
      expect(r.confirmations).toBe(9);
      expect(r.tier).toBe(LifehackTier.GROWING);
    });

    it('is TOP at ten confirmations once the score clears the threshold', () => {
      const r = scoring.compute({ ...base, success: 10, daysSinceLastConfirmation: 0 });
      expect(r.qualityScore!).toBeGreaterThanOrEqual(0.5);
      expect(r.tier).toBe(LifehackTier.TOP);
    });

    it('stays GROWING at ten confirmations when the case mostly fails', () => {
      // Enough data to qualify on volume, but the outcomes do not earn TOP.
      const r = scoring.compute({ ...base, success: 2, fail: 8, daysSinceLastConfirmation: 0 });
      expect(r.confirmations).toBe(10);
      expect(r.qualityScore!).toBeLessThan(0.5);
      expect(r.tier).toBe(LifehackTier.GROWING);
    });
  });

  describe('reaction weight', () => {
    it('counts a cross-store reaction four times a same-store one', () => {
      expect(ScoringService.reactionWeight(true)).toBe(1.0);
      expect(ScoringService.reactionWeight(false)).toBe(0.25);
    });
  });

  describe('tallyOutcomes', () => {
    it('ignores not_tried, expired and in_work as "no signal"', () => {
      const counts = ScoringService.tallyOutcomes([
        WorkItemStatus.success,
        WorkItemStatus.partial,
        WorkItemStatus.fail,
        WorkItemStatus.not_tried,
        WorkItemStatus.expired,
        WorkItemStatus.in_work,
      ]);
      expect(counts).toEqual({ success: 1, partial: 1, fail: 1 });
    });

    it('keeps a case with only not_tried results unscored', () => {
      const counts = ScoringService.tallyOutcomes([
        WorkItemStatus.not_tried,
        WorkItemStatus.not_tried,
      ]);
      const r = scoring.compute({ ...base, ...counts });
      expect(r.confirmations).toBe(0);
      expect(r.qualityScore).toBeNull();
      expect(r.tier).toBe(LifehackTier.NEW);
    });
  });
});
