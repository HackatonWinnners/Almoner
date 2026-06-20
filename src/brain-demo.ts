import { buildRuntime, DEMO_APP_ORDER } from "./runtime.js";
import { runGrantOfficer } from "./agent/brain.js";

// Claude Agent SDK brain demo — Claude operates as the grant officer, calling
// the in-process Circle wallet MCP tools. Requires ANTHROPIC_API_KEY.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run brain
//
// Contrast with `npm run demo`, which runs the same lifecycle deterministically
// with no LLM and no key. Same guarded AgentCore underneath either way.

const programId = process.argv[2] ?? "climate-adapt-bd-2026";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      "ANTHROPIC_API_KEY is not set.",
      "",
      "The Claude Agent SDK requires an API key (a Claude Pro/Max subscription will NOT work).",
      "Get one at https://platform.claude.com or use hackathon credits, then:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "  npm run brain",
      "",
      "No key? `npm run demo` runs the full lifecycle deterministically with no LLM.",
    ].join("\n"),
  );
  process.exit(1);
}

const rt = buildRuntime(programId);

console.log(`\n🤖 Claude grant officer — program "${rt.cfg.title}"`);
console.log(`   pool $${rt.cfg.budget.total_pool} · auto-approve <$${rt.cfg.approval_policy.auto_approve_ceiling} · ${DEMO_APP_ORDER.length} applications\n`);

const run = await runGrantOfficer(
  DEMO_APP_ORDER,
  {
    cfg: rt.cfg,
    core: rt.core,
    store: rt.store,
    wallet: rt.wallet,
    resolveApplication: (id) => rt.applications[id],
  },
  {
    onEvent: (e) => {
      if (e.kind === "tool") console.log(`   ⚙︎  tool: ${e.detail}`);
      else if (e.kind === "denied") console.log(`   🛑 co-sign gate: ${e.detail}`);
      else if (e.kind === "text" && e.detail.trim()) console.log(`   💬 ${e.detail.trim()}`);
    },
  },
);

console.log("\n" + "━".repeat(72));
console.log(`  AGENT SUMMARY (${run.numTurns} turns${run.isError ? ", with errors" : ""})`);
console.log("━".repeat(72));
console.log(run.result);

console.log("\n" + "─".repeat(72));
const disbursed = rt.store.all().reduce((s, g) => s + g.disbursedTotal, 0);
console.log(`  treasury remaining: $${await rt.wallet.balance()} · disbursed: $${disbursed} · x402 spent: $${rt.x402.spentUsdc.toFixed(2)}`);
