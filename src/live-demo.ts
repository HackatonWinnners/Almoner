import "./loadEnv.js";
import { loadConfig } from "./config/loader.js";
import { Store } from "./store/db.js";
import { Ledger } from "./store/ledger.js";
import { PolicyEngine } from "./policy/engine.js";
import { LiveCircleWallet } from "./tools/circleWalletLive.js";
import { policyFromConfig } from "./tools/spendingGuard.js";
import { MockX402Client } from "./tools/x402.js";
import { MockMeritAssessor, type MeritFixture } from "./agent/scoring.js";
import { RiskScorer } from "./agent/risk.js";
import { EvidenceVerifier } from "./agent/verify.js";
import { SystemClock } from "./agent/clock.js";
import { AgentCore } from "./agent/core.js";
import type { Application, EvidenceItem } from "./types/grant.js";

// LIVE demo — disburses REAL USDC tranches on Base Sepolia through the full
// Almoner pipeline (intake → score → risk → guarded disburse → verify → next
// tranche). Uses the operator's Circle CLI testnet session (run the agent
// `circle wallet login ... --testnet` first).
//
//   npm run live
//
// Spends real testnet USDC (no real value). Override the addresses via env.

const TREASURY = process.env.ALMONER_TREASURY ?? "0xd1345b0f3ce28fbc87388bd98e388413e5b81945";
const USDC = process.env.ALMONER_USDC ?? "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const RECIPIENT = process.env.ALMONER_RECIPIENT ?? "0x79fde131eec4fdea04316d75ce1b79040bffb9c5";
const EXPLORER = "https://sepolia.basescan.org/tx/";

const cfg = loadConfig("live-base-sepolia");
const clock = new SystemClock();
const store = new Store();
const ledger = new Ledger();
const policy = new PolicyEngine(cfg);
const x402 = new MockX402Client();

const wallet = new LiveCircleWallet({
  cfg,
  address: TREASURY,
  usdcTokenAddress: USDC,
  policy: policyFromConfig(cfg),
  clock: () => clock.now(),
});

const core = new AgentCore({
  cfg,
  store,
  ledger,
  wallet,
  policy,
  merit: new MockMeritAssessor(meritFixtures()),
  risk: new RiskScorer(x402),
  verifier: new EvidenceVerifier(x402),
  clock,
});

function meritFixtures(): Record<string, MeritFixture> {
  return {
    "live-grant-1": {
      need: { anchor: 4, rationale: "Direct program-relevant need." },
      feasibility: { anchor: 4, rationale: "Realistic for the amount." },
      impact_per_dollar: { anchor: 4, rationale: "Strong per-dollar impact." },
      plan_clarity: { anchor: 4, rationale: "Concrete plan and milestones." },
      local_legitimacy: { anchor: 4, rationale: "Established local presence + prior delivery." },
      sdg_alignment: { anchor: 4, rationale: "Direct SDG fit." },
    },
  };
}

const application: Application = {
  id: "live-grant-1",
  programId: cfg.program_id,
  applicant: {
    id: "live-recipient",
    displayName: "Live Test Grantee",
    wallet: { address: RECIPIENT, ageDays: 120, priorGrants: 1, priorFlags: 0 },
  },
  category: "microgrant",
  geo: "test",
  requestedAmount: 0.5,
  narrative: "Tiny live testnet grant demonstrating a real guarded USDC disbursement through the Almoner pipeline.",
  milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
  submittedAt: clock.now(),
};

const goodReceipt: EvidenceItem = { type: "receipt", blobRef: "ipfs://receipt", exifPresent: true, geoConsistent: true };
const goodPhoto: EvidenceItem = { type: "geo_photo", blobRef: "ipfs://photo", exifPresent: true, geoConsistent: true, aiGeneratedLikelihood: 0.03 };

function lastTranche(grantId: string) {
  const t = store.get(grantId).tranches.at(-1)!;
  return `${t.amount} USDC · ${t.milestoneId} · tx ${t.txHash}\n     ${EXPLORER}${t.txHash}`;
}

async function main() {
  console.log(`\n🌐 LIVE — ${cfg.title} on ${cfg.chain}`);
  console.log(`   treasury ${TREASURY}`);
  try {
    console.log(`   balance before: ${await wallet.balance()} USDC\n`);
  } catch (e) {
    console.error(
      `\nCould not read the treasury balance via the Circle CLI:\n  ${(e as Error).message}\n\n` +
        "Make sure the agent is logged into a TESTNET session:\n" +
        "  CIRCLE_ACCEPT_TERMS=1 circle wallet login <email> --type agent --testnet --init\n",
    );
    process.exit(1);
  }

  // INTAKE → SCREEN → SCORE → DECISION
  const grant = await core.intake(application);
  const d = grant.decision!;
  console.log(`▶ ${application.applicant.displayName} — $${application.requestedAmount}`);
  console.log(`  decision: ${d.kind} · merit ${d.merit.score}/100 · risk ${d.risk.score}/100 [${d.risk.tier}]`);
  console.log(`  rationale: ${d.rationale}\n`);

  if (d.kind === "REJECT") return;
  if (d.kind === "QUEUE_HUMAN") core.approve(grant.id); // simulate operator co-sign

  // m1 — REAL transfer
  console.log("• releasing milestone m1 (real USDC)…");
  await core.releaseTranche(grant.id);
  console.log(`  ✓ ${lastTranche(grant.id)}\n`);

  // evidence → verify → auto-release m2 (REAL transfer)
  console.log("• grantee submits valid evidence → agent verifies → releases m2…");
  await core.submitEvidence(grant.id, [goodReceipt, goodPhoto]);
  console.log(`  ✓ ${lastTranche(grant.id)}\n`);

  const g = store.get(grant.id);
  console.log(`  grant state: ${g.state} · disbursed ${g.disbursedTotal} USDC across ${g.tranches.length} tranches`);
  console.log(`  balance after: ${await wallet.balance()} USDC`);
  console.log("\n  on-chain ledger:");
  for (const r of ledger.all()) console.log(`   #${String(r.seq).padStart(2, "0")} ${r.event.type}`);
}

main().catch((e) => {
  console.error("LIVE DEMO FAILED:", e);
  process.exit(1);
});
