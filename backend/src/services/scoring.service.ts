import { Injectable } from '@nestjs/common';
import { LifehackTier, WorkItemStatus } from '../common/enums';

/** Raw counts needed to score a lifehack. */
export interface ScoringInput {
  success: number;
  partial: number;
  fail: number;
  // not_tried and expired are intentionally absent — they are "no signal"
  // and must never enter the math (PRODUCT_LOGIC §11c).
  weightedLikes: number; // Σ weight over 'like' reactions   (cross=1.0, same=0.25)
  weightedDislikes: number; // Σ weight over 'dislike' reactions
  daysSinceLastConfirmation: number | null; // null if never confirmed
}

export interface QualityResult {
  confirmationSuccessRate: number | null; // null while N = 0
  weightedLikeRate: number; // [-1, 1]
  recencyFactor: number; // [0, 1]
  qualityScore: number | null; // null while N = 0 — likes alone never promote
  confirmations: number; // N (success + partial + fail)
  tier: LifehackTier;
}

/**
 * THE single quality definition in the system. Feed ranking and tier both read
 * this — nothing else computes its own score (TECH_ARCHITECTURE §4).
 *
 *   quality_score = 0.6*confirmation + 0.2*likes + 0.2*recency
 *
 * Hard rules:
 *   - not_tried + expired are excluded from numerator AND denominator.
 *   - quality_score is UNDEFINED (null) while N = 0 → tier NEW, never promoted by likes.
 */
@Injectable()
export class ScoringService {
  // Outcome weights (PRODUCT_LOGIC §11c).
  private static readonly W_SUCCESS = 1.0;
  private static readonly W_PARTIAL = 0.3;
  private static readonly W_FAIL = -0.5;

  // quality_score component weights (PRODUCT_LOGIC §5).
  private static readonly C_CONFIRMATION = 0.6;
  private static readonly C_LIKES = 0.2;
  private static readonly C_RECENCY = 0.2;

  // Recency half-life in days.
  private static readonly RECENCY_HALF_LIFE_DAYS = 30;

  // TOP tier requires this many confirmations AND score at/above threshold.
  private static readonly TOP_MIN_CONFIRMATIONS = 10;
  private static readonly TOP_SCORE_THRESHOLD = 0.5;

  compute(input: ScoringInput): QualityResult {
    const N = input.success + input.partial + input.fail;

    const confirmationSuccessRate =
      N === 0
        ? null
        : (ScoringService.W_SUCCESS * input.success +
            ScoringService.W_PARTIAL * input.partial +
            ScoringService.W_FAIL * input.fail) /
          N;

    const weightedLikeRate = this.likeRate(input.weightedLikes, input.weightedDislikes);
    const recencyFactor = this.recency(input.daysSinceLastConfirmation);

    // Likes alone never promote: no score until there's at least one real confirmation.
    const qualityScore =
      confirmationSuccessRate === null
        ? null
        : ScoringService.C_CONFIRMATION * confirmationSuccessRate +
          ScoringService.C_LIKES * weightedLikeRate +
          ScoringService.C_RECENCY * recencyFactor;

    return {
      confirmationSuccessRate,
      weightedLikeRate,
      recencyFactor,
      qualityScore,
      confirmations: N,
      tier: this.tier(N, qualityScore),
    };
  }

  /** Net weighted like rate in [-1, 1]; 0 when there are no reactions. */
  private likeRate(likes: number, dislikes: number): number {
    const total = likes + dislikes;
    if (total === 0) return 0;
    return (likes - dislikes) / total;
  }

  /** Exponential decay on days since last confirmation; 0 if never confirmed. */
  private recency(days: number | null): number {
    if (days === null) return 0;
    return Math.pow(0.5, days / ScoringService.RECENCY_HALF_LIFE_DAYS);
  }

  /** Derived tier (PRODUCT_LOGIC §6). NEW/GROWING/TOP are never stored. */
  private tier(confirmations: number, qualityScore: number | null): LifehackTier {
    if (confirmations === 0) return LifehackTier.NEW;
    if (confirmations < ScoringService.TOP_MIN_CONFIRMATIONS) return LifehackTier.GROWING;
    if (qualityScore !== null && qualityScore >= ScoringService.TOP_SCORE_THRESHOLD) {
      return LifehackTier.TOP;
    }
    // ≥10 confirmations but below threshold — strong enough to have data, not TOP.
    return LifehackTier.GROWING;
  }

  /** Per-reaction weight from the frozen cross-store snapshot (PRODUCT_LOGIC §4). */
  static reactionWeight(isCrossStore: boolean): number {
    return isCrossStore ? 1.0 : 0.25;
  }

  /** Helper to fold a list of work-item statuses into scored counts. */
  static tallyOutcomes(statuses: WorkItemStatus[]): { success: number; partial: number; fail: number } {
    let success = 0;
    let partial = 0;
    let fail = 0;
    for (const s of statuses) {
      if (s === WorkItemStatus.success) success++;
      else if (s === WorkItemStatus.partial) partial++;
      else if (s === WorkItemStatus.fail) fail++;
      // not_tried, expired, in_work → ignored
    }
    return { success, partial, fail };
  }
}
