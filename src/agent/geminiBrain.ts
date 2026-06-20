import { GoogleGenAI, type FunctionCall, type Part } from "@google/genai";
import type { ProgramConfig } from "../types/program.js";
import type { Store } from "../store/db.js";
import { GrantOfficerToolkit, GRANT_FUNCTION_DECLARATIONS, type GrantToolkitDeps } from "./tools/grantToolkit.js";

// The Gemini "brain" — Gemini operating as the grant officer via function
// calling. It calls the same guarded GrantOfficerToolkit the deterministic core
// exposes, so the LLM provides orchestration + judgment + rationale, NOT
// unbounded control of money. Vendor-neutral toolkit → no Anthropic dependency.
//
// Requires GEMINI_API_KEY (or GOOGLE_API_KEY). The MODE=mock demo needs no key.

export interface GrantOfficerDeps extends GrantToolkitDeps {
  cfg: ProgramConfig;
  store: Store;
}

export interface GrantOfficerOptions {
  approveQueuedGrants?: boolean;
  model?: string;
  maxTurns?: number;
  apiKey?: string;
  onEvent?: (e: { kind: "text" | "tool" | "denied"; detail: string }) => void;
}

function systemPrompt(cfg: ProgramConfig): string {
  return [
    `You are an autonomous microgrant officer for the program "${cfg.title}" (${cfg.country}).`,
    `Currency is USDC on ${cfg.chain}. Pool ${cfg.budget.total_pool}, per-grant cap ${cfg.budget.per_grant_cap}.`,
    `Auto-approve ceiling ${cfg.approval_policy.auto_approve_ceiling}; amounts in [${cfg.approval_policy.human_review_band.join(", ")}] need an operator co-signature.`,
    "",
    "For each application id you are given:",
    "1. Call evaluate_application to get the deterministic risk + merit decision. Do NOT invent scores — the tool is authoritative.",
    "2. If AUTO_APPROVE: call release_next_tranche to disburse the first tranche, then briefly explain what and why.",
    "3. If QUEUE_HUMAN: do NOT release. Produce a concise 'proposed payment' summary for the operator to co-sign out-of-band.",
    "4. If REJECT: explain the reason in one or two sentences (for low merit, what the applicant could improve).",
    "",
    "Never try to bypass a blocked tool. If a tool returns an ERROR or DENIED, report it plainly — that is the system working as intended.",
    "When you have handled every application, reply with a one-paragraph summary and no further function calls.",
  ].join("\n");
}

export interface GrantOfficerRun {
  result: string;
  turns: number;
}

export async function runGrantOfficer(
  applicationIds: string[],
  deps: GrantOfficerDeps,
  opts: GrantOfficerOptions = {},
): Promise<GrantOfficerRun> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required to run the Gemini brain");

  const ai = new GoogleGenAI({ apiKey });
  const toolkit = new GrantOfficerToolkit(deps);

  const chat = ai.chats.create({
    model: opts.model ?? "gemini-2.5-flash",
    config: {
      systemInstruction: systemPrompt(deps.cfg),
      tools: [{ functionDeclarations: GRANT_FUNCTION_DECLARATIONS as unknown as object[] }],
    },
  });

  // Defense-in-depth co-sign gate: deny releasing a human-band grant unless an
  // operator has approved, regardless of what the model decides to call.
  const gateDenied = (call: FunctionCall): string | null => {
    if (call.name !== "release_next_tranche") return null;
    const grantId = String((call.args as { grantId?: unknown } | undefined)?.grantId ?? "");
    try {
      const g = deps.store.get(grantId);
      if (g.decision?.kind === "QUEUE_HUMAN" && !opts.approveQueuedGrants) {
        return `DENIED: grant ${grantId} ($${g.application.requestedAmount}) is in the human-review band; an operator must co-sign out-of-band before release.`;
      }
    } catch {
      /* unknown grant — let the tool report it */
    }
    return null;
  };

  const maxTurns = opts.maxTurns ?? 24;
  let message: Parameters<typeof chat.sendMessage>[0]["message"] =
    `Process these grant applications now: ${applicationIds.join(", ")}. ` +
    "Handle each fully (evaluate, then disburse / queue / reject), then summarize.";

  let result = "";
  let turns = 0;

  for (; turns < maxTurns; turns++) {
    const resp = await chat.sendMessage({ message });
    if (resp.text) {
      result = resp.text;
      opts.onEvent?.({ kind: "text", detail: resp.text });
    }
    const calls = resp.functionCalls;
    if (!calls || calls.length === 0) break;

    const parts: Part[] = [];
    for (const call of calls) {
      opts.onEvent?.({ kind: "tool", detail: call.name ?? "?" });
      const denied = gateDenied(call);
      const out = denied ?? (await toolkit.dispatch(call.name ?? "", call.args ?? {}));
      if (denied) opts.onEvent?.({ kind: "denied", detail: denied });
      parts.push({ functionResponse: { id: call.id, name: call.name, response: { result: out } } });
    }
    message = parts;
  }

  return { result, turns };
}
