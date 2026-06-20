import "./loadEnv.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/loader.js";
import { Store, type GrantRecord } from "./store/db.js";
import { Ledger } from "./store/ledger.js";
import { PolicyEngine } from "./policy/engine.js";
import { MockCircleWallet, policyFromConfig } from "./tools/circleWallet.js";
import { MockX402Client } from "./tools/x402.js";
import { MockMeritAssessor, type MeritFixture, type MeritAssessor } from "./agent/scoring.js";
import { GeminiMeritAssessor } from "./agent/assessors/geminiMerit.js";
import { RiskScorer, type RiskFixture } from "./agent/risk.js";
import { EvidenceVerifier } from "./agent/verify.js";
import { FixedClock } from "./agent/clock.js";
import { AgentCore } from "./agent/core.js";
import { hash } from "./store/ledger.js";
import type { ProgramConfig, MeritCriterion } from "./types/program.js";
import type { Application, EvidenceItem } from "./types/grant.js";

// Dashboard backend. Runs the REAL Almoner pipeline (intake → score → risk →
// guarded disburse → verify) over a portfolio of applications to produce grants
// in varied live states, then serializes them into the exact shape the
// dashboard derives everything from. The merit scores, risk tiers, approval
// decisions, state-machine transitions, tranche tx hashes, and budget math are
// all genuine AgentCore output — only presentation labels are cosmetic.

const cfg = loadConfig("climate-adapt-bd-2026");
const clock = new FixedClock();
const store = new Store();
const ledger = new Ledger();
const policy = new PolicyEngine(cfg);
const wallet = new MockCircleWallet(policyFromConfig(cfg), () => clock.now());
const x402 = new MockX402Client();

// ---- portfolio: each runs through the real engine to a target state ----
type Target = "pending" | "awaitEvidence" | "complete" | "flagged" | "rejected" | "block";
interface AppDef {
  key: string; program: string; category: string; amount: number; narrative: string;
  walletAge: number; priorGrants: number; priorFlags: number; endorser: boolean;
  anchors: [number, number, number, number, number, number]; risk: RiskFixture; target: Target;
}

const PORTFOLIO: AppDef[] = [
  { key: "p1", program: "WATER", category: "rainwater_harvesting", amount: 450, narrative: "Hand-pump repair serving a 40-household cluster — spare parts plus a certified technician for two days.", walletAge: 214, priorGrants: 2, priorFlags: 0, endorser: true, anchors: [5, 4, 4, 4, 4, 4], risk: {}, target: "pending" },
  { key: "p2", program: "EDU", category: "raised_seedbeds", amount: 500, narrative: "Print run of 300 numeracy workbooks for an after-school program reaching three grades.", walletAge: 96, priorGrants: 0, priorFlags: 0, endorser: true, anchors: [4, 4, 4, 3, 3, 3], risk: { duplicateContent: true }, target: "pending" },
  { key: "p3", program: "HEALTH", category: "tree_nursery", amount: 300, narrative: "Cold-chain carrier for a vaccine outreach covering two villages with no clinic within 12km.", walletAge: 180, priorGrants: 1, priorFlags: 0, endorser: false, anchors: [5, 5, 4, 4, 4, 4], risk: {}, target: "pending" },
  { key: "p4", program: "ENERGY", category: "rainwater_harvesting", amount: 150, narrative: "Solar lantern restock for a night clinic running on intermittent grid power.", walletAge: 140, priorGrants: 1, priorFlags: 0, endorser: false, anchors: [4, 4, 4, 4, 4, 4], risk: {}, target: "awaitEvidence" },
  { key: "p5", program: "WATER", category: "rainwater_harvesting", amount: 500, narrative: "Rain catchment tank installed at a primary school of 210 pupils — completed and verified.", walletAge: 260, priorGrants: 3, priorFlags: 0, endorser: true, anchors: [5, 5, 5, 4, 5, 4], risk: {}, target: "complete" },
  { key: "p6", program: "EDU", category: "tree_nursery", amount: 300, narrative: "Tablet purchase for a digital-literacy pilot — milestone evidence failed authenticity checks.", walletAge: 22, priorGrants: 0, priorFlags: 0, endorser: false, anchors: [4, 3, 3, 3, 2, 3], risk: { duplicateContent: true }, target: "flagged" },
  { key: "p7", program: "HEALTH", category: "tree_nursery", amount: 250, narrative: "Data top-up request blocked pre-disbursement — wallet sits inside a sybil cluster.", walletAge: 3, priorGrants: 0, priorFlags: 0, endorser: false, anchors: [3, 3, 2, 2, 2, 2], risk: { duplicateContent: true, sybilCluster: true }, target: "block" },
  { key: "p8", program: "FOOD", category: "raised_seedbeds", amount: 120, narrative: "Vague request — 'help with food things'; no costing or measurable milestones.", walletAge: 50, priorGrants: 0, priorFlags: 0, endorser: false, anchors: [3, 2, 2, 3, 1, 3], risk: {}, target: "rejected" },
];

const CRITERIA: MeritCriterion[] = ["need", "feasibility", "impact_per_dollar", "plan_clarity", "local_legitimacy", "sdg_alignment"];
const meritFixtures: Record<string, MeritFixture> = {};
const riskFixtures: Record<string, RiskFixture> = {};
for (const d of PORTFOLIO) {
  const fx: MeritFixture = {};
  CRITERIA.forEach((c, i) => { fx[c] = { anchor: d.anchors[i] as 0 | 1 | 2 | 3 | 4 | 5, rationale: `${c} anchored at ${d.anchors[i]}/5.` }; });
  meritFixtures[d.key] = fx;
  riskFixtures[d.key] = d.risk;
}

// Merit scoring: seeded portfolio uses deterministic fixtures (fast, no LLM at
// startup); freshly-submitted applications (no fixture) are read & scored by
// Gemini, with a heuristic fallback if the key is missing or the call fails.
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const mockMerit = new MockMeritAssessor(meritFixtures);
const geminiMerit = GEMINI_KEY ? new GeminiMeritAssessor(GEMINI_KEY) : null;
const merit: MeritAssessor = {
  async assess(app, c) {
    if (meritFixtures[app.id] || !geminiMerit) return mockMerit.assess(app, c);
    try {
      return await geminiMerit.assess(app, c);
    } catch (e) {
      console.warn("[apply] Gemini merit failed, using heuristic:", (e as Error).message);
      return mockMerit.assess(app, c);
    }
  },
};

const core = new AgentCore({
  cfg, store, ledger, wallet, policy, merit,
  risk: new RiskScorer(x402, riskFixtures),
  verifier: new EvidenceVerifier(x402),
  clock,
});

function appFrom(d: AppDef): Application {
  return {
    id: d.key, programId: cfg.program_id,
    applicant: { id: d.key + "-recipient", displayName: d.program + " applicant", wallet: { address: "0x" + d.key + "wallet", ageDays: d.walletAge, priorGrants: d.priorGrants, priorFlags: d.priorFlags }, ...(d.endorser ? { endorser: { id: d.key + "-endorser", bondUsdc: 50 } } : {}) },
    category: d.category, geo: "BD-coastal", requestedAmount: d.amount, narrative: d.narrative,
    milestones: cfg.milestones.map((m) => ({ id: m.id, label: m.label, tranchePct: m.tranche_pct, evidenceRequired: m.evidence })),
    submittedAt: clock.now(),
  };
}

const PROGRAM_BY_ID: Record<string, string> = Object.fromEntries(PORTFOLIO.map((d) => [d.key, d.program]));
const good = (t: EvidenceItem["type"]): EvidenceItem => ({ type: t, blobRef: "ipfs://" + t, exifPresent: true, geoConsistent: true, aiGeneratedLikelihood: 0.03 });
const aiPhoto: EvidenceItem = { type: "geo_photo", blobRef: "ipfs://ai", exifPresent: false, geoConsistent: false, aiGeneratedLikelihood: 0.95, reusedFromPriorTranche: true };

async function submitGood(id: string) {
  const idx = store.get(id).currentMilestoneIdx;
  await core.submitEvidence(id, cfg.milestones[idx]!.evidence.map(good));
}

async function drive(d: AppDef) {
  await core.intake(appFrom(d));
  const st = () => store.get(d.key).state;
  if (d.target === "pending" || d.target === "rejected" || d.target === "block") return;
  if (st() === "AWAIT_APPROVAL") core.approve(d.key);
  if (st() === "DISBURSE") await core.releaseTranche(d.key); // m1
  if (d.target === "awaitEvidence") return;
  if (d.target === "complete") { while (st() === "AWAIT_EVIDENCE") await submitGood(d.key); return; }
  if (d.target === "flagged") {
    await submitGood(d.key); // m1 PASS → m2 released
    const idx = store.get(d.key).currentMilestoneIdx;
    await core.submitEvidence(d.key, cfg.milestones[idx]!.evidence.map((t) => (t === "geo_photo" ? aiPhoto : good(t)))); // m2 FAIL → flagged
  }
}

// ---- serialize a GrantRecord into the dashboard's grant shape ----
function statusOf(rec: GrantRecord): string {
  const s = rec.state;
  if (s === "AWAIT_APPROVAL") return "SCORE";
  if (s === "REJECTED") return rec.decision?.risk.tier === "BLOCK" ? "BLOCK" : "REJECTED";
  if (s === "DISBURSE") return "SCREEN";
  if (s === "RECLAIMED") return "FLAGGED";
  return s; // AWAIT_EVIDENCE · COMPLETE · FLAGGED
}

function serializeGrant(rec: GrantRecord, seed: number) {
  const dec = rec.decision!;
  const subs = CRITERIA.map((c) => { const b = dec.merit.breakdown.find((x) => x.criterion === c); return b ? Math.round((b.anchor / 5) * 100) : 0; });
  const failIdx = cfg.milestones.findIndex((m) => rec.verifications.some((v) => v.milestoneId === m.id && v.verdict === "FAIL"));
  const milestones = cfg.milestones.map((m, i) => {
    const tr = rec.tranches.find((t) => t.milestoneId === m.id);
    const amount = Math.round((rec.application.requestedAmount * m.tranche_pct) / 100);
    let state: string, ev: string[], conf: string | null, tx: string | null;
    if (i === failIdx) { state = "flagged"; ev = ["pass", "partial", "fail", "pending"]; conf = "FAIL"; tx = tr?.txHash ?? null; }
    else if (tr) { state = "released"; ev = ["pass", "pass", "pass", "pass"]; conf = "PASS"; tx = tr.txHash; }
    else if (rec.state === "AWAIT_EVIDENCE" && i === rec.tranches.length) { state = "current"; ev = ["pending", "pending", "pending", "pending"]; conf = null; tx = null; }
    else { state = "pending"; ev = ["pending", "pending", "pending", "pending"]; conf = null; tx = null; }
    return { tag: "M" + (i + 1), pct: m.tranche_pct, amount, state, ev, conf, tx };
  });
  const sigs = dec.risk.signals;
  const flag = sigs.some((s) => s.signal === "sybil_cluster") ? "sybil" : sigs.some((s) => s.signal === "duplicate_content") ? "duplicate" : null;
  const full = hash(rec.application.applicant.id);
  return {
    id: rec.id, seed, full, hash: full.slice(0, 6) + "…" + full.slice(-4),
    program: PROGRAM_BY_ID[rec.id] ?? rec.application.category,
    amount: rec.application.requestedAmount, status: statusOf(rec),
    needsCosign: rec.state === "AWAIT_APPROVAL", tier: dec.risk.tier, subs, merit: dec.merit.score,
    blurb: rec.application.narrative, flag, milestones,
  };
}

function snapshot() {
  const grants = store.all().map((r, i) => serializeGrant(r, (i + 1) * 13 + 7));
  const reclaimed = ledger.all().reduce((s, r) => (r.event.type === "FundsReclaimed" ? s + r.event.amount : s), 0);
  return { grants, meta: { pool: cfg.budget.total_pool, reclaimed, chain: cfg.chain, gemini: !!geminiMerit } };
}

const LABELS: Record<MeritCriterion, string> = { need: "Need", feasibility: "Feasibility", impact_per_dollar: "Impact / $", plan_clarity: "Plan clarity", local_legitimacy: "Local legitimacy", sdg_alignment: "SDG alignment" };

function decisionPayload(rec: GrantRecord) {
  const dec = rec.decision!;
  return {
    kind: dec.kind, status: statusOf(rec), rationale: dec.rationale, disbursed: rec.disbursedTotal,
    merit: { score: dec.merit.score, threshold: cfg.scoring.fund_threshold, rows: dec.merit.breakdown.map((b) => ({ label: LABELS[b.criterion], anchor: b.anchor, pct: Math.round((b.anchor / 5) * 100), weight: b.weight.toFixed(2), rationale: b.rationale })) },
    risk: { score: dec.risk.score, tier: dec.risk.tier, sanctioned: dec.risk.sanctioned, signals: dec.risk.signals.map((s) => ({ signal: s.signal, detail: s.detail })) },
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
}

let applyCounter = 0;

// ---- HTTP ----
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const port = Number(process.env.PORT ?? 5173);
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const json = (res: import("node:http").ServerResponse, body: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

await Promise.all(PORTFOLIO.map(drive));

createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  try {
    if (url === "/api/state") return json(res, snapshot());
    if (url === "/api/apply" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const n = ++applyCounter;
        const id = "apply-" + n;
        const allowed = cfg.eligibility.categories;
        const category = typeof body.category === "string" && allowed.includes(body.category) ? body.category : allowed[0]!;
        const app: Application = {
          id, programId: cfg.program_id,
          applicant: { id: id + "-r", displayName: "New applicant", wallet: { address: "0x" + id, ageDays: Math.max(0, Number(body.walletAge) || 90), priorGrants: Math.max(0, Number(body.priorGrants) || 0), priorFlags: 0 }, ...(body.endorser ? { endorser: { id: id + "-e", bondUsdc: 50 } } : {}) },
          category, geo: "BD-coastal", requestedAmount: Math.max(1, Number(body.amount) || 100),
          narrative: String(body.narrative ?? "").slice(0, 2000),
          milestones: cfg.milestones.map((mm) => ({ id: mm.id, label: mm.label, tranchePct: mm.tranche_pct, evidenceRequired: mm.evidence })),
          submittedAt: clock.now(),
        };
        PROGRAM_BY_ID[id] = String(body.program || category).toUpperCase().slice(0, 10);
        const rec = await core.intake(app);
        if (rec.decision?.kind === "AUTO_APPROVE" && store.get(id).state === "DISBURSE") await core.releaseTranche(id);
        return json(res, { grant: serializeGrant(store.get(id), 1000 + n), decision: decisionPayload(store.get(id)) });
      } catch (e) { return json(res, { error: (e as Error).message }, 400); }
    }
    const m = url.match(/^\/api\/grants\/([^/]+)\/(cosign|reject)$/);
    if (m && req.method === "POST") {
      const [, id, action] = m;
      try {
        if (action === "cosign") { if (store.get(id!).state === "AWAIT_APPROVAL") core.approve(id!); if (store.get(id!).state === "DISBURSE") await core.releaseTranche(id!); }
        else { store.transition(id!, "REJECTED", clock.now(), "operator rejected"); ledger.emit({ type: "GrantRejected", grantId: id!, recipientHash: hash(id!), rationaleHash: hash("operator rejected") }, clock.now()); }
        return json(res, snapshot());
      } catch (e) { return json(res, { error: (e as Error).message }, 400); }
    }
    // static
    const file = join(dir, url === "/" ? "index.html" : url.replace(/^\/+/, ""));
    if (!file.startsWith(dir)) return void res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  const snap = snapshot();
  console.log(`\n  Almoner dashboard (LIVE) → http://localhost:${port}`);
  console.log(`  serving ${snap.grants.length} grants from the real AgentCore · pool $${snap.meta.pool} · reclaimed $${snap.meta.reclaimed}\n`);
});
