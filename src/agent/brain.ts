import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ProgramConfig } from "../types/program.js";
import type { Store } from "../store/db.js";
import { createCircleWalletMcp, CIRCLE_WALLET_TOOLS, type CircleWalletMcpDeps } from "./tools/circleWalletMcp.js";

// The Claude Agent SDK "brain" — Claude operating as the grant officer. It calls
// the in-process Circle wallet MCP tools to evaluate applications and disburse
// USDC. The deterministic AgentCore behind those tools enforces all scoring,
// policy, and spending caps, so the LLM provides orchestration + judgment +
// natural-language rationale, NOT unbounded control of money.
//
// Requires ANTHROPIC_API_KEY (the Agent SDK does not accept Pro/Max OAuth).
// The MODE=mock demo (src/index.ts) does not use this and needs no key.

export interface GrantOfficerDeps extends CircleWalletMcpDeps {
  cfg: ProgramConfig;
  store: Store;
}

export interface GrantOfficerOptions {
  /** When true, the agent may release tranches for human-band grants (simulated co-sign). */
  approveQueuedGrants?: boolean;
  model?: string;
  maxTurns?: number;
  /** Stream callback for assistant text + tool calls (for the live demo UI). */
  onEvent?: (e: { kind: "text" | "tool" | "denied"; detail: string }) => void;
}

function systemPrompt(cfg: ProgramConfig): string {
  return [
    `You are an autonomous microgrant officer for the program "${cfg.title}" (${cfg.country}).`,
    `Currency is USDC on ${cfg.chain}. The program pool is ${cfg.budget.total_pool}, per-grant cap ${cfg.budget.per_grant_cap}.`,
    `Auto-approve ceiling is ${cfg.approval_policy.auto_approve_ceiling}; amounts in [${cfg.approval_policy.human_review_band.join(", ")}] need an operator co-signature.`,
    "",
    "Your job, for each application id you are given:",
    "1. Call evaluate_application to get the deterministic risk + merit decision. Do NOT invent scores — the tool is authoritative.",
    "2. If the decision is AUTO_APPROVE: call release_next_tranche to disburse the first milestone tranche, then briefly explain what and why.",
    "3. If the decision is QUEUE_HUMAN: do NOT release. Produce a concise 'proposed payment' summary (amount, scores, rationale) for the operator to co-sign out-of-band.",
    "4. If the decision is REJECT: explain the reason in one or two sentences, including (for low merit) what the applicant could improve.",
    "",
    "Never attempt to bypass a blocked tool. If a tool reports a policy/guard block, report it plainly — that is the system working as intended.",
    "Be concise and explain every money decision (what was paid, to which milestone, and why).",
  ].join("\n");
}

export interface GrantOfficerRun {
  result: string;
  numTurns: number;
  isError: boolean;
}

export async function runGrantOfficer(
  applicationIds: string[],
  deps: GrantOfficerDeps,
  opts: GrantOfficerOptions = {},
): Promise<GrantOfficerRun> {
  const server = createCircleWalletMcp(deps);

  // Defense-in-depth co-sign gate: even if the LLM tries to release a
  // human-band grant, the callback denies it unless an operator has approved.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "mcp__circle_wallet__release_next_tranche") {
      const grantId = String((input as { grantId?: unknown }).grantId ?? "");
      try {
        const g = deps.store.get(grantId);
        if (g.decision?.kind === "QUEUE_HUMAN" && !opts.approveQueuedGrants) {
          const msg = `Grant ${grantId} ($${g.application.requestedAmount}) is in the human-review band; an operator must co-sign out-of-band before release.`;
          opts.onEvent?.({ kind: "denied", detail: msg });
          return { behavior: "deny", message: msg };
        }
      } catch {
        /* unknown grant — let the tool itself report the error */
      }
    }
    return { behavior: "allow", updatedInput: input };
  };

  const prompt =
    `Process these grant applications now: ${applicationIds.join(", ")}.\n` +
    "Handle each one fully (evaluate, then disburse / queue / reject as appropriate), then give a one-paragraph summary of what you did.";

  let result = "";
  let numTurns = 0;
  let isError = false;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: systemPrompt(deps.cfg),
      mcpServers: { circle_wallet: server },
      allowedTools: CIRCLE_WALLET_TOOLS,
      canUseTool,
      maxTurns: opts.maxTurns ?? 24,
      ...(opts.model ? { model: opts.model } : {}),
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") opts.onEvent?.({ kind: "text", detail: block.text });
        else if (block.type === "tool_use") opts.onEvent?.({ kind: "tool", detail: block.name });
      }
    } else if (message.type === "result") {
      numTurns = message.num_turns;
      isError = message.is_error;
      if (message.subtype === "success") result = message.result;
      else result = `agent ended: ${message.subtype}`;
    }
  }

  return { result, numTurns, isError };
}
