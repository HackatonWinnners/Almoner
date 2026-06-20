import { loadConfig } from "./config/loader.js";
import { Store } from "./store/db.js";
import { Ledger } from "./store/ledger.js";
import { PolicyEngine } from "./policy/engine.js";
import { MockCircleWallet, policyFromConfig } from "./tools/circleWallet.js";
import { MockX402Client } from "./tools/x402.js";
import { MockMeritAssessor, type MeritFixture } from "./agent/scoring.js";
import { RiskScorer, type RiskFixture } from "./agent/risk.js";
import { EvidenceVerifier } from "./agent/verify.js";
import { FixedClock } from "./agent/clock.js";
import { AgentCore } from "./agent/core.js";
import type { Application, EvidenceItem } from "./types/grant.js";

// End-to-end offline demo (§11). Run: `npm run demo` (climate preset) or
// `npm run demo:disaster`. All services are deterministic mocks — no network,
// no keys — so the same story plays every time.

const programId = process.argv[2] ?? "climate-adapt-bd-2026";
const cfg = loadConfig(programId);

// ---- demo narrator ----
const line = (c = "─") => console.log(c.repeat(72));
const h = (t: string) => {
  console.log("\n" + "━".repeat(72));
  console.log("  " + t);
  console.log("━".repeat(72));
};

// ---- applications (the §11 cast) ----
const strong: Application = {
  id: "app-strong",
  programId: cfg.program_id,
  applicant: {
    id: "rashida-coop",
    displayName: "Rashida Women's Tree Nursery Co-op",
    wallet: { address: "0xSTRONG", ageDays: 120, priorGrants: 1, priorFlags: 0 },
    endorser: { id: "union-parishad-ward3", bondUsdc: 50 },
  },
  category: "tree_nursery",
  geo: "BD-coastal",
  requestedAmount: 300,
  narrative:
    "Establish a 500-sapling mangrove and fruit-tree nursery to stabilize embankments and provide income. " +
    "Materials (seeds, polybags, shade net) costed; 6 women trained; site secured with ward endorsement.",
  milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
  submittedAt: "2026-06-20T08:00:00.000Z",
};

const weak: Application = {
  id: "app-weak",
  programId: cfg.program_id,
  applicant: { id: "anon-applicant-2", displayName: "Applicant 2", wallet: { address: "0xWEAK", ageDays: 40, priorGrants: 0, priorFlags: 0 } },
  category: "rainwater_harvesting",
  geo: "BD-coastal",
  requestedAmount: 450,
  narrative: "We want to do water things for the village. Please send funds.",
  milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
  submittedAt: "2026-06-20T08:05:00.000Z",
};

const fraud: Application = {
  id: "app-fraud",
  programId: cfg.program_id,
  applicant: { id: "sybil-9", displayName: "Applicant 9", wallet: { address: "0xFRAUD", ageDays: 1, priorGrants: 0, priorFlags: 0 } },
  category: "tree_nursery",
  geo: "BD-coastal",
  requestedAmount: 500,
  narrative:
    "Establish a 500-sapling mangrove and fruit-tree nursery to stabilize embankments and provide income. " +
    "Materials costed; site secured.", // near-duplicate of the strong application
  milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
  submittedAt: "2026-06-20T08:07:00.000Z",
};

const auto: Application = {
  id: "app-auto",
  programId: cfg.program_id,
  applicant: { id: "karim-seedbeds", displayName: "Karim Raised Seedbeds", wallet: { address: "0xAUTO", ageDays: 60, priorGrants: 0, priorFlags: 0 } },
  category: "raised_seedbeds",
  geo: "BD-coastal",
  requestedAmount: 150,
  narrative: "Build 4 raised seedbeds above flood line to keep seedlings alive through monsoon; bamboo + soil + labor costed for 3 households.",
  milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
  submittedAt: "2026-06-20T08:10:00.000Z",
};

// ---- fixtures: per-application anchors + risk hints (the "LLM" output, deterministic) ----
const meritFixtures: Record<string, MeritFixture> = {
  "app-strong": {
    need: { anchor: 4, rationale: "Embankment erosion is an acute, program-relevant flood risk." },
    feasibility: { anchor: 4, rationale: "Scope and budget are realistic for $300." },
    impact_per_dollar: { anchor: 3, rationale: "500 saplings + 6 trained women is solid per-dollar impact." },
    plan_clarity: { anchor: 4, rationale: "Concrete materials list and milestones." },
    local_legitimacy: { anchor: 5, rationale: "Ward endorsement + one prior delivered grant." },
    sdg_alignment: { anchor: 4, rationale: "Direct SDG 13/1 fit." },
  },
  "app-weak": {
    need: { anchor: 3, rationale: "Water access is relevant but severity unstated." },
    feasibility: { anchor: 2, rationale: "No costing; $450 unjustified." },
    impact_per_dollar: { anchor: 2, rationale: "No quantified output." },
    plan_clarity: { anchor: 3, rationale: "Vague — 'do water things'." },
    local_legitimacy: { anchor: 1, rationale: "No presence or endorser." },
    sdg_alignment: { anchor: 3, rationale: "Plausible SDG fit but unspecified." },
  },
  "app-auto": {
    need: { anchor: 4, rationale: "Seedling loss to flooding is a direct program harm." },
    feasibility: { anchor: 3, rationale: "Modest, achievable build." },
    impact_per_dollar: { anchor: 3, rationale: "Reasonable output for $150." },
    plan_clarity: { anchor: 3, rationale: "Has steps; light on detail." },
    local_legitimacy: { anchor: 3, rationale: "Some local presence." },
    sdg_alignment: { anchor: 4, rationale: "Clear SDG 13/1 fit." },
  },
};

const riskFixtures: Record<string, RiskFixture> = {
  "app-fraud": { duplicateContent: true, sybilCluster: true }, // + brand-new wallet from intake
};

// ---- wire up dependencies (the `mock` runtime) ----
const clock = new FixedClock();
const store = new Store();
const ledger = new Ledger();
const policy = new PolicyEngine(cfg);
const wallet = new MockCircleWallet(policyFromConfig(cfg, ["0xDENY"]), () => clock.now());
const x402 = new MockX402Client();
const agent = new AgentCore({
  cfg,
  store,
  ledger,
  wallet,
  policy,
  merit: new MockMeritAssessor(meritFixtures),
  risk: new RiskScorer(x402, riskFixtures),
  verifier: new EvidenceVerifier(x402),
  clock,
});

// ---- evidence fixtures ----
const goodReceipt: EvidenceItem = { type: "receipt", blobRef: "ipfs://receipt-good", exifPresent: true, geoConsistent: true };
const goodPhoto: EvidenceItem = { type: "geo_photo", blobRef: "ipfs://photo-good", exifPresent: true, geoConsistent: true, aiGeneratedLikelihood: 0.04 };
const goodReport: EvidenceItem = { type: "report", blobRef: "ipfs://report-good" };
const goodAttestation: EvidenceItem = { type: "attestation", blobRef: "ipfs://attest-good" };
const aiPhoto: EvidenceItem = { type: "geo_photo", blobRef: "ipfs://photo-ai", exifPresent: false, geoConsistent: false, aiGeneratedLikelihood: 0.95, reusedFromPriorTranche: true };

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
  for (const app of [strong, weak, fraud, auto]) {
    await agent.intake(app);
  }
  printDecision("STRONG ", strong.id);
  printDecision("WEAK   ", weak.id);
  printDecision("FRAUD  ", fraud.id);
  printDecision("AUTO   ", auto.id);

  h("DISBURSEMENT");
  // Strong: queued for human → operator co-signs → run all milestones.
  console.log("\n• STRONG is in the human-review band → operator co-signs out-of-band.");
  agent.approve(strong.id);
  await agent.releaseTranche(strong.id);
  console.log(`  m1 released: tx=${store.get(strong.id).tranches.at(-1)!.txHash.slice(0, 18)}…  $${store.get(strong.id).tranches.at(-1)!.amount}`);

  console.log("• STRONG submits valid geo-tagged evidence for each milestone…");
  await agent.submitEvidence(strong.id, [goodReceipt, goodPhoto]); // m1 PASS → auto-release m2
  await agent.submitEvidence(strong.id, [goodPhoto, goodReport]); // m2 PASS → auto-release m3
  await agent.submitEvidence(strong.id, [goodPhoto, goodAttestation]); // m3 PASS → COMPLETE
  const sg = store.get(strong.id);
  console.log(`  STRONG state=${sg.state}, disbursed=$${sg.disbursedTotal} across ${sg.tranches.length} tranches.`);

  // Auto: auto-approved small grant → release m1 → submits AI-generated evidence → caught.
  console.log("\n• AUTO was auto-approved (under ceiling, LOW risk) → release m1.");
  await agent.releaseTranche(auto.id);
  console.log(`  m1 released: $${store.get(auto.id).tranches.at(-1)!.amount}`);
  console.log("• AUTO submits AI-generated photo (no EXIF, geo mismatch, reused)…");
  await agent.submitEvidence(auto.id, [goodReceipt, aiPhoto]);
  const ag = store.get(auto.id);
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

function formatEvent(e: import("./store/ledger.js").LedgerEvent): string {
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
