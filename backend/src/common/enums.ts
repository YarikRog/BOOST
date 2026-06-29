// Domain enums — the locked core. Mirror migration 0001 and TECH_ARCHITECTURE §2.

export enum UserRole {
  MEGA_ADMIN = 'MEGA_ADMIN',
  REGIONAL_IT_LEAD = 'REGIONAL_IT_LEAD',
  DIRECTOR = 'DIRECTOR',
  DEP_DIRECTOR = 'DEP_DIRECTOR',
  SELLER = 'SELLER',
}

export enum UserStatus {
  active = 'active',
  inactive = 'inactive',
  archived = 'archived',
}

export enum Experience {
  lt_6m = 'lt_6m',
  '6m_2y' = '6m_2y',
  gt_2y = 'gt_2y',
}

// Categories are DATA (see `categories` table), not an enum — the product is
// category-agnostic so the same deploy works for any retail vertical.

export enum LifehackStatus {
  draft = 'draft',
  published = 'published',
  archived = 'archived',
}

// Derived, never stored. Computed from confirmation count + quality_score.
export enum LifehackTier {
  NEW = 'NEW',
  GROWING = 'GROWING',
  TOP = 'TOP',
}

export enum WorkItemStatus {
  in_work = 'in_work',
  success = 'success',
  partial = 'partial',
  fail = 'fail',
  not_tried = 'not_tried',
  expired = 'expired',
}

// Outcomes that count toward the score (denominator). not_tried + expired are "no signal".
export const SCORED_OUTCOMES = [
  WorkItemStatus.success,
  WorkItemStatus.partial,
  WorkItemStatus.fail,
] as const;

export enum ReactionType {
  like = 'like',
  dislike = 'dislike',
}

export enum InviteStatus {
  active = 'active',
  used = 'used',
  revoked = 'revoked',
}
