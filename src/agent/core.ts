import type { ProgramConfig } from "../types/program.js";
import type { Application, Decision, EvidenceItem, MeritResult, RiskResult } from "../types/grant.js";
import { Store, type GrantRecord } from "../store/db.js";
import { Ledger, hash } from "../store/ledger.js";
import { PolicyEngine } from "../policy/engine.js";
import { type CircleWallet, WalletPolicyError } from "../tools/circleWallet.js";
import type { MeritAssessor } from "./scoring.js";
import type { RiskScorer } from "./risk.js";
import type { EvidenceVerifier } from "./verify.js";
import type { Clock } from "./clock.js";

// Agent core — orchestrates the grant lifecycle (§4). This is the "real agent
// workflow, not a script" surface: intake → screen → score → decision →
// disburse → await evidence → verify → next tranche → complete / reclaim.
//
// Every state-changing decision writes a human-readable rationale, and the
// hash of that rationale is mirrored to the on-chain ledger (§4, §8).

export interface AgentDeps {
  cfg: ProgramConfig;
  store: Store;
  ledger: Ledger;
  wallet: CircleWallet;
  policy: PolicyEngine;
  merit: MeritAssessor;
  risk: RiskScorer;
  verifier: EvidenceVerifier;
  clock: Clock;
}

/** Build the funding decision from merit + risk + approval policy. */
export function buildDecision(app: Application, cfg: ProgramConfig, merit: MeritResult, risk: RiskResult): Decision {
  const ap = cfg.approval_policy;
  const amount = app.requestedAmount;
  const requiresEndorser = amount > cfg.risk_policy.require_endorser_above;

  // Hard rejections.
  if (risk.tier === "BLOCK" || merit.score < ap.hard_reject_below_score || !merit.funded) {
    const why =
      risk.tier === "BLOCK"
        ? risk.summary
        : !merit.funded
          ? `merit ${merit.score} below fund threshold ${cfg.scoring.fund_threshold}`
          : `merit ${merit.score} below hard-reject floor ${ap.hard_reject_below_score}`;
    return { kind: "REJECT", merit, risk, requiresEndorser, rationale: `REJECT: ${why}. ${merit.summary}` };
  }

  // Risk-adjusted first-tranche cap.
  let firstTrancheCap: number | undefined;
  if (app.applicant.wallet.ageDays < cfg.risk_policy.min_wallet_age_days_for_auto) {
    firstTrancheCap = cfg.risk_policy.new_wallet_first_tranche_cap;
  }
  if (risk.tier === "MEDIUM") {
    const reduced = Math.round(amount * cfg.milestones[0]!.tranche_pct * 0.005); // half of m1
    firstTrancheCap = Math.min(firstTrancheCap ?? Infinity, reduced);
  }

  // Approval routing.
  const aboveCeiling = amount > ap.auto_approve_ceiling;
  const inHumanBand = amount >= ap.human_review_band[0] && amount <= ap.human_review_band[1];
  const needsHuman = aboveCeiling || inHumanBand || risk.tier === "MEDIUM" || risk.tier === "HIGH";

  const kind = needsHuman ? "QUEUE_HUMAN" : "AUTO_APPROVE";
  const rationale =
    `${kind}: merit ${merit.score}/100, risk ${risk.score}/100 (${risk.tier}). ` +
    (needsHuman
      ? `Amount ${amount} ${aboveCeiling ? `above auto ceiling ${ap.auto_approve_ceiling}` : "in human-review band"}${risk.tier !== "LOW" ? ` and risk ${risk.tier}` : ""} → operator co-signature required. `
      : `Within auto-approve ceiling ${ap.auto_approve_ceiling} and risk LOW → agent approves. `) +
    merit.summary;

  return { kind, merit, risk, firstTrancheCap, requiresEndorser, rationale };
}

export class AgentCore {
  constructor(private readonly d: AgentDeps) {}

  /** INTAKE → SCREEN → SCORE → DECISION. Returns the grant record with a decision. */
  async intake(app: Application): Promise<GrantRecord> {
    const { store, ledger, clock, cfg, policy } = this.d;
    const grant = store.create(app, clock.now());
    const recipientHash = hash(app.applicant.id);

    // SCREEN
    store.transition(grant.id, "SCREEN", clock.now());
    const risk = await this.d.risk.assess(app, cfg);
    grant.risk = risk;
    ledger.emit({ type: "RiskAssessed", grantId: grant.id, tier: risk.tier, rationaleHash: hash(risk.summary) }, clock.now());

    // SCORE
    store.transition(grant.id, "SCORE", clock.now());
    const merit = await this.d.merit.assess(app, cfg);

    // DECISION
    store.transition(grant.id, "DECISION", clock.now());
    const decision = buildDecision(app, cfg, merit, risk);
    grant.decision = decision;

    // App-level policy gate — only run on decisions the agent would approve.
    // A REJECT from buildDecision already carries the substantive reason
    // (merit/risk); we must not overwrite it with a secondary policy check.
    if (decision.kind !== "REJECT") {
      const verdict = policy.checkDecision(app, decision);
      if (!verdict.allowed) {
        decision.kind = "REJECT";
        decision.rationale = `REJECT (policy.${verdict.rule}): ${verdict.detail}`;
      }
    }

    if (decision.kind === "REJECT") {
      store.transition(grant.id, "REJECTED", clock.now(), decision.rationale);
      ledger.emit({ type: "GrantRejected", grantId: grant.id, recipientHash, rationaleHash: hash(decision.rationale) }, clock.now());
      return grant;
    }

    // Approved (auto) or queued for human co-signature.
    ledger.emit({ type: "GrantCreated", grantId: grant.id, recipientHash, amount: app.requestedAmount, programId: cfg.program_id }, clock.now());
    store.transition(grant.id, decision.kind === "AUTO_APPROVE" ? "DISBURSE" : "AWAIT_APPROVAL", clock.now(), decision.rationale);
    return grant;
  }

  /** Operator co-signs a queued grant → moves it to DISBURSE. */
  approve(grantId: string): GrantRecord {
    const g = this.d.store.get(grantId);
    if (g.state !== "AWAIT_APPROVAL") throw new Error(`grant ${grantId} not awaiting approval (state ${g.state})`);
    return this.d.store.transition(grantId, "DISBURSE", this.d.clock.now(), "operator co-signed");
  }

  /** Release the next pending tranche. Goes through the app-level policy gate
   *  AND the wallet's hard spending policy. Either can block. */
  async releaseTranche(grantId: string): Promise<GrantRecord> {
    const { store, ledger, clock, cfg, policy, wallet } = this.d;
    const g = store.get(grantId);
    const idx = g.currentMilestoneIdx;
    const ms = cfg.milestones[idx];
    if (!ms) throw new Error(`no milestone at index ${idx} for grant ${grantId}`);

    // Round to USDC precision (6 dp) — NOT to integer, or sub-dollar tranches
    // (e.g. 0.5 × 40% = 0.2) collapse to 0.
    let amount = Math.round(g.application.requestedAmount * (ms.tranche_pct / 100) * 1e6) / 1e6;
    if (idx === 0 && g.decision?.firstTrancheCap !== undefined) {
      amount = Math.min(amount, g.decision.firstTrancheCap);
    }

    // App-level gate.
    const verdict = policy.checkTranche(g, idx, amount);
    if (!verdict.allowed) {
      throw new Error(`app-policy blocked tranche ${ms.id}: ${verdict.rule} — ${verdict.detail}`);
    }

    // Wallet hard backstop.
    let receipt;
    try {
      receipt = await wallet.transfer({
        to: g.application.applicant.wallet.address,
        amount,
        grantId,
        milestoneId: ms.id,
        coSigned: g.decision?.kind === "QUEUE_HUMAN",
      });
    } catch (e) {
      if (e instanceof WalletPolicyError) {
        throw new Error(`wallet backstop blocked tranche ${ms.id}: ${e.rule} — ${e.message}`);
      }
      throw e;
    }

    g.tranches.push({ milestoneId: ms.id, amount, txHash: receipt.txHash, releasedAt: receipt.at });
    g.disbursedTotal += amount;
    ledger.emit({ type: "TrancheReleased", grantId, mId: ms.id, amount, txHash: receipt.txHash }, clock.now());
    store.transition(grantId, "AWAIT_EVIDENCE", clock.now(), `tranche ${ms.id} released: ${amount} USDC`);
    return g;
  }

  /** Applicant submits milestone evidence → VERIFY → release next or flag/reclaim. */
  async submitEvidence(grantId: string, evidence: EvidenceItem[]): Promise<GrantRecord> {
    const { store, ledger, clock, cfg } = this.d;
    const g = store.get(grantId);
    const idx = g.currentMilestoneIdx;
    const ms = cfg.milestones[idx];
    if (!ms) throw new Error(`no milestone at index ${idx}`);

    store.transition(grantId, "VERIFY", clock.now());
    const result = await this.d.verifier.verify(ms, evidence);
    g.verifications.push(result);

    if (result.verdict === "PASS") {
      ledger.emit({ type: "MilestoneVerified", grantId, mId: ms.id, confidence: result.confidence }, clock.now());
      g.currentMilestoneIdx += 1;
      if (g.currentMilestoneIdx >= cfg.milestones.length) {
        store.transition(grantId, "COMPLETE", clock.now(), "all milestones verified");
        ledger.emit({ type: "GrantCompleted", grantId }, clock.now());
        ledger.emit({ type: "ReputationUpdated", recipientHash: hash(g.application.applicant.id), delta: +1 }, clock.now());
      } else {
        store.transition(grantId, "DISBURSE", clock.now(), `milestone ${ms.id} verified → next tranche`);
        await this.releaseTranche(grantId);
      }
    } else if (result.verdict === "FAIL") {
      ledger.emit({ type: "MilestoneFlagged", grantId, mId: ms.id, reasonHash: hash(result.rationale) }, clock.now());
      store.transition(grantId, "FLAGGED", clock.now(), result.rationale);
      ledger.emit({ type: "ReputationUpdated", recipientHash: hash(g.application.applicant.id), delta: -1 }, clock.now());
      await this.reclaimRemaining(grantId);
    } else {
      // PARTIAL or UNCERTAIN → hold for human; do not advance, do not reclaim.
      store.transition(grantId, "AWAIT_EVIDENCE", clock.now(), result.rationale);
    }
    return g;
  }

  /** Return undisbursed budget for a grant to the pool. */
  async reclaimRemaining(grantId: string): Promise<void> {
    const { store, ledger, clock, wallet } = this.d;
    const g = store.get(grantId);
    const remaining = g.application.requestedAmount - g.disbursedTotal;
    if (remaining > 0) {
      await wallet.reclaim(grantId, remaining);
      ledger.emit({ type: "FundsReclaimed", grantId, amount: remaining }, clock.now());
    }
    if (g.state !== "FLAGGED") store.transition(grantId, "RECLAIMED", clock.now(), `reclaimed ${remaining} USDC`);
  }
}
