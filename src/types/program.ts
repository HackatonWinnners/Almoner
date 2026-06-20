// ProgramConfig — the single source of truth for one grant program.
// "One program = one config." Everything downstream (scoring weights,
// approval bands, milestones, wallet caps) is driven from here.

export type MeritCriterion =
  | "need"
  | "feasibility"
  | "impact_per_dollar"
  | "plan_clarity"
  | "local_legitimacy"
  | "sdg_alignment";

export interface PeriodCap {
  window: string; // e.g. "24h"
  amount: number;
}

export interface BudgetPolicy {
  total_pool: number;
  per_grant_cap: number;
  per_recipient_cumulative_cap: number;
  period_cap: PeriodCap;
}

export interface EligibilityPolicy {
  categories: string[];
  geo_allow: string[];
  exclude_if: string[];
}

export interface ScoringPolicy {
  fund_threshold: number;
  weights: Record<MeritCriterion, number>;
}

export interface ApprovalPolicy {
  auto_approve_ceiling: number;
  human_review_band: [number, number];
  hard_reject_below_score: number;
}

export interface RiskPolicy {
  screening_required: boolean;
  min_wallet_age_days_for_auto: number;
  new_wallet_first_tranche_cap: number;
  require_endorser_above: number;
}

export interface MilestoneSpec {
  id: string;
  label: string;
  tranche_pct: number;
  evidence: EvidenceType[];
}

export type EvidenceType =
  | "receipt"
  | "geo_photo"
  | "report"
  | "attestation";

export interface ProgramConfig {
  program_id: string;
  title: string;
  country: string;
  sdg_tags: number[];
  currency: string;
  chain: string;
  budget: BudgetPolicy;
  eligibility: EligibilityPolicy;
  scoring: ScoringPolicy;
  approval_policy: ApprovalPolicy;
  risk_policy: RiskPolicy;
  milestones: MilestoneSpec[];
}
