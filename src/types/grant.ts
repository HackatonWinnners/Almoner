import type { EvidenceType, MeritCriterion } from "./program.js";

// ---- Application intake ----

export interface Applicant {
  id: string;
  // PII — never written on-chain. On-chain stores keccak(id).
  displayName: string;
  contact?: string;
  wallet: WalletInfo;
  endorser?: Endorser;
}

export interface WalletInfo {
  address: string;
  ageDays: number; // from on-chain read
  priorGrants: number; // delivered grants (reputation)
  priorFlags: number; // fraud flags
}

export interface Endorser {
  id: string;
  bondUsdc: number; // staked; slashed on fraud
}

export interface MilestonePlan {
  id: string;
  label: string;
  tranchePct: number;
  evidenceRequired: EvidenceType[];
}

export interface Application {
  id: string;
  programId: string;
  applicant: Applicant;
  category: string;
  geo: string;
  requestedAmount: number;
  narrative: string; // free-text plan; the LLM structures + scores this
  milestones: MilestonePlan[];
  submittedAt: string; // ISO
}

// ---- Scoring outputs ----

export interface CriterionScore {
  criterion: MeritCriterion;
  anchor: 0 | 1 | 2 | 3 | 4 | 5; // anchored rubric value
  weight: number;
  rationale: string; // 1-2 sentences — the explainability surface
}

export interface MeritResult {
  score: number; // 0-100
  breakdown: CriterionScore[];
  funded: boolean; // score >= fund_threshold
  summary: string;
}

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "BLOCK";

export interface RiskSignal {
  signal: string;
  source: string;
  delta: number; // contribution to risk score
  detail: string;
}

export interface RiskResult {
  score: number; // 0-100, higher = riskier
  tier: RiskTier;
  signals: RiskSignal[];
  sanctioned: boolean;
  summary: string;
}

// ---- Decision ----

export type DecisionKind = "AUTO_APPROVE" | "QUEUE_HUMAN" | "REJECT";

export interface Decision {
  kind: DecisionKind;
  merit: MeritResult;
  risk: RiskResult;
  rationale: string; // human-readable "what and why"
  firstTrancheCap?: number; // risk-adjusted ceiling on tranche 1
  requiresEndorser: boolean;
}

// ---- Milestone verification ----

export type VerifyVerdict = "PASS" | "PARTIAL" | "UNCERTAIN" | "FAIL";

export interface EvidenceItem {
  type: EvidenceType;
  blobRef: string; // IPFS / object-store ref; never the raw blob on-chain
  exifPresent?: boolean;
  geoConsistent?: boolean;
  reusedFromPriorTranche?: boolean;
  aiGeneratedLikelihood?: number; // 0-1
}

export interface VerifyResult {
  milestoneId: string;
  verdict: VerifyVerdict;
  confidence: number; // 0-1
  checks: { name: string; pass: boolean; detail: string }[];
  rationale: string;
}
