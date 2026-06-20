import type { AgentCore } from "../core.js";
import type { Store } from "../../store/db.js";
import type { CircleWallet } from "../../tools/circleWallet.js";
import type { Application, EvidenceItem } from "../../types/grant.js";

// Model-agnostic grant-officer toolkit. The guarded operations an LLM brain can
// invoke, independent of any vendor SDK. Every money-moving method routes
// through AgentCore → PolicyEngine + SpendingPolicyGuard, so the LLM cannot move
// funds outside the caps or the milestone ordering, whatever model drives it.

export interface GrantToolkitDeps {
  core: AgentCore;
  store: Store;
  wallet: CircleWallet;
  resolveApplication: (id: string) => Application | undefined;
}

/** Vendor-neutral function schemas (JSON Schema). Adapt per SDK at the call site. */
export const GRANT_FUNCTION_DECLARATIONS = [
  {
    name: "get_treasury_balance",
    description: "Get the program treasury wallet's available USDC balance.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "evaluate_application",
    description:
      "Run deterministic risk screening, merit scoring, and the approval-policy decision for an application. Returns the decision (AUTO_APPROVE / QUEUE_HUMAN / REJECT) with scores and rationale. Does NOT move money.",
    parametersJsonSchema: {
      type: "object",
      properties: { applicationId: { type: "string", description: "The application id to evaluate" } },
      required: ["applicationId"],
    },
  },
  {
    name: "release_next_tranche",
    description:
      "Release the next milestone tranche of an approved grant (USDC transfer). Only valid for grants in DISBURSE state. Blocked for amounts above the auto-approve ceiling unless an operator has co-signed.",
    parametersJsonSchema: {
      type: "object",
      properties: { grantId: { type: "string", description: "The grant id to disburse the next tranche for" } },
      required: ["grantId"],
    },
  },
  {
    name: "verify_milestone_evidence",
    description:
      "Verify submitted milestone evidence (completeness, authenticity, AI-gen/reuse checks). On PASS the next tranche auto-releases; on FAIL the grant is flagged and unused funds reclaimed; on PARTIAL/UNCERTAIN it holds for human review.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        grantId: { type: "string" },
        evidenceJson: { type: "string", description: "JSON array of EvidenceItem objects for the current milestone" },
      },
      required: ["grantId", "evidenceJson"],
    },
  },
  {
    name: "reclaim_grant",
    description: "Reclaim a grant's undisbursed funds back to the treasury pool (abandoned, timed-out, or flagged grants).",
    parametersJsonSchema: {
      type: "object",
      properties: { grantId: { type: "string" } },
      required: ["grantId"],
    },
  },
] as const;

export class GrantOfficerToolkit {
  constructor(private readonly d: GrantToolkitDeps) {}

  /** Dispatch a function call by name. Always resolves to a text result (errors included). */
  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "get_treasury_balance":
          return `Treasury balance: ${await this.d.wallet.balance()} USDC`;
        case "evaluate_application":
          return await this.evaluate(String(args.applicationId ?? ""));
        case "release_next_tranche":
          return await this.release(String(args.grantId ?? ""));
        case "verify_milestone_evidence":
          return await this.verify(String(args.grantId ?? ""), String(args.evidenceJson ?? ""));
        case "reclaim_grant":
          return await this.reclaim(String(args.grantId ?? ""));
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
  }

  private async evaluate(applicationId: string): Promise<string> {
    const app = this.d.resolveApplication(applicationId);
    if (!app) return `ERROR: unknown application ${applicationId}`;
    const grant = await this.d.core.intake(app);
    const dec = grant.decision!;
    return JSON.stringify({
      grantId: grant.id,
      state: grant.state,
      decision: dec.kind,
      merit: dec.merit.score,
      risk: { score: dec.risk.score, tier: dec.risk.tier, sanctioned: dec.risk.sanctioned },
      requestedAmount: app.requestedAmount,
      firstTrancheCap: dec.firstTrancheCap ?? null,
      requiresEndorser: dec.requiresEndorser,
      rationale: dec.rationale,
    });
  }

  private async release(grantId: string): Promise<string> {
    const g = await this.d.core.releaseTranche(grantId);
    const t = g.tranches.at(-1)!;
    return `Released ${t.amount} USDC for ${t.milestoneId} (tx ${t.txHash}). State: ${g.state}.`;
  }

  private async verify(grantId: string, evidenceJson: string): Promise<string> {
    let evidence: EvidenceItem[];
    try {
      evidence = JSON.parse(evidenceJson);
    } catch {
      return "ERROR: evidenceJson is not valid JSON";
    }
    const g = await this.d.core.submitEvidence(grantId, evidence);
    const v = g.verifications.at(-1)!;
    return `Verdict ${v.verdict} (confidence ${v.confidence}). State: ${g.state}. ${v.rationale}`;
  }

  private async reclaim(grantId: string): Promise<string> {
    await this.d.core.reclaimRemaining(grantId);
    return `Reclaimed undisbursed funds for ${grantId}. State: ${this.d.store.get(grantId).state}.`;
  }
}
