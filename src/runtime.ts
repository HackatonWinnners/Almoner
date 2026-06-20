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
import type { ProgramConfig } from "./types/program.js";
import type { Application, EvidenceItem } from "./types/grant.js";

// Shared demo runtime + fixtures, used by both the deterministic demo
// (src/index.ts) and the Claude Agent SDK brain demo (src/brain-demo.ts).

export function buildApplications(cfg: ProgramConfig): Record<string, Application> {
  const milestones = cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence }));
  return {
    "app-strong": {
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
      milestones,
      submittedAt: "2026-06-20T08:00:00.000Z",
    },
    "app-weak": {
      id: "app-weak",
      programId: cfg.program_id,
      applicant: { id: "anon-applicant-2", displayName: "Applicant 2", wallet: { address: "0xWEAK", ageDays: 40, priorGrants: 0, priorFlags: 0 } },
      category: "rainwater_harvesting",
      geo: "BD-coastal",
      requestedAmount: 450,
      narrative: "We want to do water things for the village. Please send funds.",
      milestones,
      submittedAt: "2026-06-20T08:05:00.000Z",
    },
    "app-fraud": {
      id: "app-fraud",
      programId: cfg.program_id,
      applicant: { id: "sybil-9", displayName: "Applicant 9", wallet: { address: "0xFRAUD", ageDays: 1, priorGrants: 0, priorFlags: 0 } },
      category: "tree_nursery",
      geo: "BD-coastal",
      requestedAmount: 500,
      narrative:
        "Establish a 500-sapling mangrove and fruit-tree nursery to stabilize embankments and provide income. " +
        "Materials costed; site secured.",
      milestones,
      submittedAt: "2026-06-20T08:07:00.000Z",
    },
    "app-auto": {
      id: "app-auto",
      programId: cfg.program_id,
      applicant: { id: "karim-seedbeds", displayName: "Karim Raised Seedbeds", wallet: { address: "0xAUTO", ageDays: 60, priorGrants: 0, priorFlags: 0 } },
      category: "raised_seedbeds",
      geo: "BD-coastal",
      requestedAmount: 150,
      narrative: "Build 4 raised seedbeds above flood line to keep seedlings alive through monsoon; bamboo + soil + labor costed for 3 households.",
      milestones,
      submittedAt: "2026-06-20T08:10:00.000Z",
    },
  };
}

export const DEMO_APP_ORDER = ["app-strong", "app-weak", "app-fraud", "app-auto"];

export const meritFixtures: Record<string, MeritFixture> = {
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

export const riskFixtures: Record<string, RiskFixture> = {
  "app-fraud": { duplicateContent: true, sybilCluster: true },
};

export const evidenceFixtures = {
  goodReceipt: { type: "receipt", blobRef: "ipfs://receipt-good", exifPresent: true, geoConsistent: true } as EvidenceItem,
  goodPhoto: { type: "geo_photo", blobRef: "ipfs://photo-good", exifPresent: true, geoConsistent: true, aiGeneratedLikelihood: 0.04 } as EvidenceItem,
  goodReport: { type: "report", blobRef: "ipfs://report-good" } as EvidenceItem,
  goodAttestation: { type: "attestation", blobRef: "ipfs://attest-good" } as EvidenceItem,
  aiPhoto: { type: "geo_photo", blobRef: "ipfs://photo-ai", exifPresent: false, geoConsistent: false, aiGeneratedLikelihood: 0.95, reusedFromPriorTranche: true } as EvidenceItem,
};

export interface Runtime {
  cfg: ProgramConfig;
  store: Store;
  ledger: Ledger;
  policy: PolicyEngine;
  wallet: MockCircleWallet;
  x402: MockX402Client;
  core: AgentCore;
  applications: Record<string, Application>;
}

export function buildRuntime(programId: string): Runtime {
  const cfg = loadConfig(programId);
  const clock = new FixedClock();
  const store = new Store();
  const ledger = new Ledger();
  const policy = new PolicyEngine(cfg);
  const wallet = new MockCircleWallet(policyFromConfig(cfg, ["0xDENY"]), () => clock.now());
  const x402 = new MockX402Client();
  const core = new AgentCore({
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
  return { cfg, store, ledger, policy, wallet, x402, core, applications: buildApplications(cfg) };
}
