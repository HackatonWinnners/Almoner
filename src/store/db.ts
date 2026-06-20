import type { Application, Decision, RiskResult, VerifyResult } from "../types/grant.js";

// Off-chain store (PII + application content + evidence + rationale).
// In-memory for the MVP; the same interface backs SQLite/Postgres later.

export type GrantState =
  | "INTAKE"
  | "SCREEN"
  | "SCORE"
  | "DECISION"
  | "AWAIT_APPROVAL"
  | "DISBURSE"
  | "AWAIT_EVIDENCE"
  | "VERIFY"
  | "COMPLETE"
  | "REJECTED"
  | "FLAGGED"
  | "RECLAIMED";

export interface TrancheRecord {
  milestoneId: string;
  amount: number;
  txHash: string;
  releasedAt: string;
}

export interface GrantRecord {
  id: string;
  application: Application;
  state: GrantState;
  decision?: Decision;
  risk?: RiskResult;
  tranches: TrancheRecord[];
  verifications: VerifyResult[];
  disbursedTotal: number;
  currentMilestoneIdx: number;
  history: { state: GrantState; at: string; note?: string }[];
}

export class Store {
  private grants = new Map<string, GrantRecord>();

  create(application: Application, now: string): GrantRecord {
    const rec: GrantRecord = {
      id: application.id,
      application,
      state: "INTAKE",
      tranches: [],
      verifications: [],
      disbursedTotal: 0,
      currentMilestoneIdx: 0,
      history: [{ state: "INTAKE", at: now }],
    };
    this.grants.set(rec.id, rec);
    return rec;
  }

  get(id: string): GrantRecord {
    const g = this.grants.get(id);
    if (!g) throw new Error(`grant not found: ${id}`);
    return g;
  }

  transition(id: string, state: GrantState, now: string, note?: string): GrantRecord {
    const g = this.get(id);
    g.state = state;
    g.history.push({ state, at: now, note });
    return g;
  }

  all(): GrantRecord[] {
    return [...this.grants.values()];
  }

  /** Cumulative USDC already disbursed to a given wallet across all grants. */
  cumulativeToWallet(address: string): number {
    let total = 0;
    for (const g of this.grants.values()) {
      if (g.application.applicant.wallet.address === address) total += g.disbursedTotal;
    }
    return total;
  }
}
