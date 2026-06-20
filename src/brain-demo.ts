import { buildRuntime, DEMO_APP_ORDER } from "./runtime.js";
import { runGrantOfficer } from "./agent/geminiBrain.js";

// Gemini brain demo — Gemini operates as the grant officer, calling the guarded
// grant-officer toolkit. Requires GEMINI_API_KEY (or GOOGLE_API_KEY).
//
//   GEMINI_API_KEY=... npm run brain
//
// Contrast with `npm run demo` (deterministic, no LLM, no key) and `npm run
// live` (real USDC). Same guarded AgentCore underneath all three.

const programId = process.argv[2] ?? "climate-adapt-bd-2026";
const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error(
    [
      "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.",
      "",
      "Get a free key at https://aistudio.google.com/apikey, then:",
      "  export GEMINI_API_KEY=...",
      "  npm run brain",
      "",
      "No key? `npm run demo` runs the full lifecycle deterministically with no LLM.",
    ].join("\n"),
  );
  process.exit(1);
}

const rt = buildRuntime(programId);

console.log(`\n🤖 Gemini grant officer — program "${rt.cfg.title}"`);
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
console.log(`  AGENT SUMMARY (${run.turns} turns)`);
console.log("━".repeat(72));
console.log(run.result);

console.log("\n" + "─".repeat(72));
const disbursed = rt.store.all().reduce((s, g) => s + g.disbursedTotal, 0);
console.log(`  treasury remaining: $${await rt.wallet.balance()} · disbursed: $${disbursed} · x402 spent: $${rt.x402.spentUsdc.toFixed(2)}`);
