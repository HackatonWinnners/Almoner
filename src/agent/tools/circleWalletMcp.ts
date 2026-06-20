import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentCore } from "../core.js";
import type { Store } from "../../store/db.js";
import type { CircleWallet } from "../../tools/circleWallet.js";
import type { Application, EvidenceItem } from "../../types/grant.js";

// In-process MCP server exposing Circle-wallet + workflow operations as tools
// the Claude Agent SDK calls. Circle ships no MCP server (its "Skills" are
// markdown CLI docs), so we build the tool surface ourselves with the SDK's
// createSdkMcpServer / tool helpers.
//
// Crucial property: every money-moving tool routes through AgentCore, which
// enforces the PolicyEngine (app-level) AND the SpendingPolicyGuard (hard
// backstop). The LLM reasons and sequences; it cannot move funds outside the
// caps or the milestone ordering. A prompt-injected brain still hits the wall.

export interface CircleWalletMcpDeps {
  core: AgentCore;
  store: Store;
  wallet: CircleWallet;
  /** Resolve an application id to its full record (off-chain store). */
  resolveApplication: (id: string) => Application | undefined;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function createCircleWalletMcp(deps: CircleWalletMcpDeps) {
  const { core, store, wallet, resolveApplication } = deps;

  const getBalance = tool(
    "get_treasury_balance",
    "Get the program treasury wallet's available USDC balance.",
    {},
    async () => ok(`Treasury balance: ${await wallet.balance()} USDC`),
    { annotations: { readOnlyHint: true } },
  );

  const evaluate = tool(
    "evaluate_application",
    "Run deterministic risk screening, merit scoring, and the approval-policy decision for an application. Returns the decision (AUTO_APPROVE / QUEUE_HUMAN / REJECT) with scores and rationale. Does NOT move money.",
    { applicationId: z.string().describe("The application id to evaluate") },
    async ({ applicationId }) => {
      const app = resolveApplication(applicationId);
      if (!app) return err(`unknown application: ${applicationId}`);
      const grant = await core.intake(app);
      const d = grant.decision!;
      return ok(
        JSON.stringify(
          {
            grantId: grant.id,
            state: grant.state,
            decision: d.kind,
            merit: d.merit.score,
            risk: { score: d.risk.score, tier: d.risk.tier, sanctioned: d.risk.sanctioned },
            requestedAmount: app.requestedAmount,
            firstTrancheCap: d.firstTrancheCap ?? null,
            requiresEndorser: d.requiresEndorser,
            rationale: d.rationale,
          },
          null,
          2,
        ),
      );
    },
  );

  const release = tool(
    "release_next_tranche",
    "Release the next milestone tranche of an approved grant (USDC transfer). Only valid for grants in DISBURSE state. Blocked by the wallet guard for amounts above the auto-approve ceiling unless an operator has co-signed.",
    { grantId: z.string().describe("The grant id to disburse the next tranche for") },
    async ({ grantId }) => {
      try {
        const g = await core.releaseTranche(grantId);
        const t = g.tranches.at(-1)!;
        return ok(`Released ${t.amount} USDC for ${t.milestoneId} (tx ${t.txHash}). State: ${g.state}.`);
      } catch (e) {
        return err(`tranche blocked: ${(e as Error).message}`);
      }
    },
  );

  const verify = tool(
    "verify_milestone_evidence",
    "Verify submitted milestone evidence (completeness, authenticity, AI-gen/reuse checks, content match). On PASS the next tranche auto-releases; on FAIL the grant is flagged and unused funds reclaimed; on PARTIAL/UNCERTAIN it holds for human review.",
    {
      grantId: z.string(),
      evidenceJson: z.string().describe("JSON array of EvidenceItem objects for the current milestone"),
    },
    async ({ grantId, evidenceJson }) => {
      let evidence: EvidenceItem[];
      try {
        evidence = JSON.parse(evidenceJson);
      } catch {
        return err("evidenceJson is not valid JSON");
      }
      try {
        const g = await core.submitEvidence(grantId, evidence);
        const v = g.verifications.at(-1)!;
        return ok(`Verdict ${v.verdict} (confidence ${v.confidence}). State: ${g.state}. ${v.rationale}`);
      } catch (e) {
        return err(`verification error: ${(e as Error).message}`);
      }
    },
  );

  const reclaim = tool(
    "reclaim_grant",
    "Reclaim a grant's undisbursed funds back to the treasury pool (for abandoned, timed-out, or flagged grants).",
    { grantId: z.string() },
    async ({ grantId }) => {
      try {
        await core.reclaimRemaining(grantId);
        return ok(`Reclaimed undisbursed funds for ${grantId}. State: ${store.get(grantId).state}.`);
      } catch (e) {
        return err(`reclaim error: ${(e as Error).message}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "circle_wallet",
    version: "0.1.0",
    tools: [getBalance, evaluate, release, verify, reclaim],
  });
}

/** Fully-qualified tool names the agent is allowed to call. */
export const CIRCLE_WALLET_TOOLS = [
  "mcp__circle_wallet__get_treasury_balance",
  "mcp__circle_wallet__evaluate_application",
  "mcp__circle_wallet__release_next_tranche",
  "mcp__circle_wallet__verify_milestone_evidence",
  "mcp__circle_wallet__reclaim_grant",
];
