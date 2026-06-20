import { buildRuntime, DEMO_APP_ORDER, evidenceFixtures } from "./runtime.js";
import type { LedgerEvent } from "./store/ledger.js";

// End-to-end offline demo (§11). Run: `npm run demo` (climate preset) or
// `npm run demo:disaster`. All services are deterministic mocks — no network,
// no keys — so the same story plays every time.

const programId = process.argv[2] ?? "climate-adapt-bd-2026";
const { cfg, store, ledger, wallet, x402, core, applications } = buildRuntime(programId);

// ---- demo narrator ----
const line = (c = "─") => console.log(c.repeat(72));
const h = (t: string) => {
  console.log("\n" + "━".repeat(72));
  console.log("  " + t);
  console.log("━".repeat(72));
};

const { goodReceipt, goodPhoto, goodReport, goodAttestation, aiPhoto } = evidenceFixtures;

function printDecision(label: string, grantId: string) {
  const g = store.get(grantId);
  const d = g.decision!;
  console.log(`\n▶ ${label} (${g.application.applicant.displayName}, $${g.application.requestedAmount})`);
  console.log(`  merit ${d.merit.score}/100 · risk ${d.risk.score}/100 [${d.risk.tier}] · state=${g.state}`);
  console.log(`  decision: ${d.kind}`);
  console.log(`  rationale: ${d.rationale}`);
}

async function main() {
  h(`PROGRAM: ${cfg.title}  [${cfg.program_id}]`);
  console.log(`  country=${cfg.country}  pool=$${cfg.budget.total_pool}  per-grant cap=$${cfg.budget.per_grant_cap}`);
  console.log(`  auto-approve <$${cfg.approval_policy.auto_approve_ceiling}  human band $${cfg.approval_policy.human_review_band.join("–$")}  fund threshold=${cfg.scoring.fund_threshold}`);

  h("INTAKE → SCREEN → SCORE → DECISION (4 applications)");
  for (const id of DEMO_APP_ORDER) {
    await core.intake(applications[id]!);
  }
  printDecision("STRONG ", "app-strong");
  printDecision("WEAK   ", "app-weak");
  printDecision("FRAUD  ", "app-fraud");
  printDecision("AUTO   ", "app-auto");

  h("DISBURSEMENT");
  console.log("\n• STRONG is in the human-review band → operator co-signs out-of-band.");
  core.approve("app-strong");
  await core.releaseTranche("app-strong");
  console.log(`  m1 released: tx=${store.get("app-strong").tranches.at(-1)!.txHash.slice(0, 18)}…  $${store.get("app-strong").tranches.at(-1)!.amount}`);

  console.log("• STRONG submits valid geo-tagged evidence for each milestone…");
  await core.submitEvidence("app-strong", [goodReceipt, goodPhoto]); // m1 PASS → auto-release m2
  await core.submitEvidence("app-strong", [goodPhoto, goodReport]); // m2 PASS → auto-release m3
  await core.submitEvidence("app-strong", [goodPhoto, goodAttestation]); // m3 PASS → COMPLETE
  const sg = store.get("app-strong");
  console.log(`  STRONG state=${sg.state}, disbursed=$${sg.disbursedTotal} across ${sg.tranches.length} tranches.`);

  console.log("\n• AUTO was auto-approved (under ceiling, LOW risk) → release m1.");
  await core.releaseTranche("app-auto");
  console.log(`  m1 released: $${store.get("app-auto").tranches.at(-1)!.amount}`);
  console.log("• AUTO submits AI-generated photo (no EXIF, geo mismatch, reused)…");
  await core.submitEvidence("app-auto", [goodReceipt, aiPhoto]);
  const ag = store.get("app-auto");
  console.log(`  → verdict=${ag.verifications.at(-1)!.verdict}: ${ag.verifications.at(-1)!.rationale}`);
  console.log(`  AUTO state=${ag.state} (flagged + remaining funds reclaimed).`);

  h("PUBLIC LEDGER (on-chain mirror — no PII)");
  for (const r of ledger.all()) {
    console.log(`  #${String(r.seq).padStart(2, "0")} ${r.at}  ${formatEvent(r.event)}`);
  }

  h("BUDGET BURNDOWN");
  const grants = store.all();
  const disbursed = grants.reduce((s, g) => s + g.disbursedTotal, 0);
  const completed = grants.filter((g) => g.state === "COMPLETE").length;
  const rejected = grants.filter((g) => g.state === "REJECTED").length;
  const flagged = grants.filter((g) => g.state === "FLAGGED").length;
  console.log(`  pool=$${cfg.budget.total_pool}  disbursed=$${disbursed}  remaining=$${await wallet.balance()}`);
  console.log(`  grants: ${grants.length} intake · ${completed} completed · ${rejected} rejected · ${flagged} flagged`);
  console.log(`  x402 nanopayments spent: $${x402.spentUsdc.toFixed(2)} (screening + image checks)`);
  line();
  console.log(`  ✓ ${disbursed > 0 ? "Disbursed under policy" : "No funds moved"}; every decision carries an on-chain rationale hash; 100% auditable.`);
}

function formatEvent(e: LedgerEvent): string {
  switch (e.type) {
    case "GrantCreated": return `GrantCreated      grant=${e.grantId} amount=$${e.amount}`;
    case "GrantRejected": return `GrantRejected     grant=${e.grantId} rationaleHash=${e.rationaleHash.slice(0, 12)}…`;
    case "RiskAssessed": return `RiskAssessed      grant=${e.grantId} tier=${e.tier}`;
    case "TrancheReleased": return `TrancheReleased   grant=${e.grantId} ${e.mId} $${e.amount} tx=${e.txHash.slice(0, 12)}…`;
    case "MilestoneVerified": return `MilestoneVerified grant=${e.grantId} ${e.mId} conf=${e.confidence}`;
    case "MilestoneFlagged": return `MilestoneFlagged  grant=${e.grantId} ${e.mId} reason=${e.reasonHash.slice(0, 12)}…`;
    case "GrantCompleted": return `GrantCompleted    grant=${e.grantId}`;
    case "FundsReclaimed": return `FundsReclaimed    grant=${e.grantId} amount=$${e.amount}`;
    case "ReputationUpdated": return `ReputationUpdated recipient=${e.recipientHash.slice(0, 12)}… delta=${e.delta > 0 ? "+" : ""}${e.delta}`;
  }
}

main().catch((e) => {
  console.error("DEMO FAILED:", e);
  process.exit(1);
});
