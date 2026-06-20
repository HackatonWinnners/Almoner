import type { ProgramConfig } from "../types/program.js";
import type { Decision, Application } from "../types/grant.js";
import type { GrantRecord } from "../store/db.js";

// App-level policy engine (§5.2). The SOFT guardrail. Runs in the backend and
// checks every action the agent proposes BEFORE it reaches the Circle wallet:
// tranche ordering, ProgramConfig conformance, risk tier, duplicates, caps.
//
// This is layer 2 of the two-layer defense. Layer 1 (wallet spending policy)
// is the hard backstop that holds even if the agent is compromised; this layer
// catches logic errors and keeps the agent honest with explainable blocks.

export interface PolicyVerdict {
  allowed: boolean;
  rule: string;
  detail: string;
}

const OK: PolicyVerdict = { allowed: true, rule: "ok", detail: "passes app-level policy" };

export class PolicyEngine {
  constructor(private readonly cfg: ProgramConfig) {}

  /** Gate the DECISION before any money moves. */
  checkDecision(app: Application, decision: Decision): PolicyVerdict {
    if (app.requestedAmount > this.cfg.budget.per_grant_cap) {
      return { allowed: false, rule: "per_grant_cap", detail: `requested ${app.requestedAmount} > cap ${this.cfg.budget.per_grant_cap}` };
    }
    if (!this.cfg.eligibility.categories.includes(app.category)) {
      return { allowed: false, rule: "eligibility.category", detail: `category ${app.category} not allowed` };
    }
    if (!this.cfg.eligibility.geo_allow.includes(app.geo)) {
      return { allowed: false, rule: "eligibility.geo", detail: `geo ${app.geo} not in allow-list` };
    }
    if (decision.risk.sanctioned) {
      return { allowed: false, rule: "risk.sanctioned", detail: "sanctioned wallet cannot be funded" };
    }
    if (decision.requiresEndorser && !app.applicant.endorser) {
      return { allowed: false, rule: "risk.endorser_required", detail: `amount above ${this.cfg.risk_policy.require_endorser_above} requires endorser bond` };
    }
    return OK;
  }

  /** Gate a tranche release. Enforces milestone ordering + cumulative caps. */
  checkTranche(grant: GrantRecord, milestoneIdx: number, amount: number): PolicyVerdict {
    // Milestone ordering: cannot release mN until m(N-1) verified PASS.
    if (milestoneIdx > 0) {
      const prev = this.cfg.milestones[milestoneIdx - 1];
      const prevVerified = grant.verifications.find((v) => v.milestoneId === prev?.id && v.verdict === "PASS");
      if (!prevVerified) {
        return { allowed: false, rule: "tranche_order", detail: `milestone ${prev?.id} not yet verified PASS` };
      }
    }

    // Risk-adjusted first-tranche cap for new wallets.
    if (milestoneIdx === 0 && grant.decision?.firstTrancheCap !== undefined && amount > grant.decision.firstTrancheCap) {
      return { allowed: false, rule: "first_tranche_cap", detail: `first tranche ${amount} > risk cap ${grant.decision.firstTrancheCap}` };
    }

    // Cumulative per-recipient cap (app-level mirror of the wallet backstop).
    const projected = grant.disbursedTotal + amount;
    if (projected > this.cfg.budget.per_recipient_cumulative_cap) {
      return { allowed: false, rule: "per_recipient_cap", detail: `cumulative ${projected} > cap ${this.cfg.budget.per_recipient_cumulative_cap}` };
    }
    return OK;
  }
}
