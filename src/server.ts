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
import { LiveCircleWallet } from "./tools/circleWalletLive.js";
import { CircleApiWallet } from "./tools/circleApiWallet.js";
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
// Generic intake: the apply form is sector-agnostic, so accept any category /
// region and let the agent decide on merit + risk (the program is the policy,
// not a fixed taxonomy). Seeded fixtures still drive their own categories.
cfg.eligibility.categories = ["*"];
cfg.eligibility.geo_allow = ["*"];
// ...and the fund's IDENTITY is generic too, so the LLM scores need/impact/SDG
// on universal humanitarian merit rather than one program's mission/geography.
cfg.title = "Open Microgrants Fund";
cfg.country = "any region";
cfg.sdg_tags = [1, 2, 3, 4, 5, 6, 7, 11, 13, 16];
const clock = new FixedClock();
const store = new Store();
const ledger = new Ledger();
const policy = new PolicyEngine(cfg);
// LIVE wallet mode: every disbursement is a real USDC transfer on Base Sepolia,
// capped to FIRST_TRANCHE_USDC so it always settles against the testnet balance.
const TREASURY = process.env.ALMONER_TREASURY ?? "0xd1345b0f3ce28fbc87388bd98e388413e5b81945";
const USDC = process.env.ALMONER_USDC ?? "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const LIVE_CHAIN = process.env.ALMONER_CHAIN ?? "BASE-SEPOLIA";
// Real transfers need a valid EVM destination — applicant wallet addresses are
// synthetic, so on-chain disbursements route to this controlled testnet address.
const RECIPIENT = process.env.ALMONER_RECIPIENT ?? "0x79fde131eec4fdea04316d75ce1b79040bffb9c5";
const FIRST_TRANCHE_USDC = 0.1;
// Wallet mode:
//   mock       – simulated disbursement (default; safe for any deploy)
//   live       – real Circle transfers via the `circle` CLI session (local only)
//   circle-api – real Circle transfers via the Developer-Controlled-Wallets REST
//                API (api key + entity secret) — works in a container / on a VPS
const WALLET_MODE = (process.env.ALMONER_WALLET ?? "mock").toLowerCase();
const LIVE = WALLET_MODE !== "mock"; // both live + circle-api move real USDC
const wallet =
  WALLET_MODE === "live"
    ? new LiveCircleWallet({ cfg: { ...cfg, chain: LIVE_CHAIN }, address: TREASURY, usdcTokenAddress: USDC, policy: policyFromConfig(cfg), clock: () => clock.now() })
    : WALLET_MODE === "circle-api"
      ? new CircleApiWallet({ apiKey: process.env.CIRCLE_API_KEY ?? "", entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? "", walletId: process.env.CIRCLE_WALLET_ID ?? "", policy: policyFromConfig(cfg), clock: () => clock.now() })
      : new MockCircleWallet(policyFromConfig(cfg), () => clock.now());
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
  { key: "p4", program: "ENERGY", category: "rainwater_harvesting", amount: 130, narrative: "Vague request for 'some lights' with no plan, costs, or beneficiaries named.", walletAge: 60, priorGrants: 0, priorFlags: 0, endorser: false, anchors: [3, 2, 2, 2, 1, 3], risk: {}, target: "rejected" },
  { key: "p5", program: "WATER", category: "rainwater_harvesting", amount: 500, narrative: "Rain catchment tank for a primary school of 210 pupils — itemized parts, mason quote, and three checkable milestones.", walletAge: 260, priorGrants: 3, priorFlags: 0, endorser: true, anchors: [5, 5, 5, 4, 5, 4], risk: {}, target: "pending" },
  { key: "p6", program: "EDU", category: "tree_nursery", amount: 300, narrative: "Data top-up request from a wallet inside a tightly-linked cluster.", walletAge: 5, priorGrants: 0, priorFlags: 0, endorser: false, anchors: [4, 3, 3, 3, 2, 3], risk: { duplicateContent: true, sybilCluster: true }, target: "block" },
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
const mediaByApp = new Map<string, { mimeType: string; data: string }[]>(); // attachments for the in-flight application
const merit: MeritAssessor = {
  async assess(app, c) {
    if (meritFixtures[app.id] || !geminiMerit) return mockMerit.assess(app, c);
    try {
      return await geminiMerit.assess(app, c, mediaByApp.get(app.id));
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
    applicant: { id: d.key + "-recipient", displayName: d.program + " applicant", wallet: { address: RECIPIENT, ageDays: d.walletAge, priorGrants: d.priorGrants, priorFlags: d.priorFlags }, ...(d.endorser ? { endorser: { id: d.key + "-endorser", bondUsdc: 50 } } : {}) },
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
    // Released milestones show the REAL on-chain amount (the capped 0.1 USDC);
    // unreleased ones show the nominal awarded tranche.
    const amount = tr ? tr.amount : Math.round((rec.application.requestedAmount * m.tranche_pct) / 100);
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
  return { grants, meta: { pool: cfg.budget.total_pool, reclaimed, chain: LIVE_CHAIN, gemini: !!geminiMerit, trancheUsdc: FIRST_TRANCHE_USDC, walletLive: LIVE } };
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
        const category = String(body.category || "other").slice(0, 40) || "other";
        const title = String(body.title ?? "").slice(0, 160).trim();
        const location = (String(body.location ?? "").slice(0, 120).trim()) || "unspecified";
        const beneficiaries = String(body.beneficiaries ?? "").slice(0, 80).trim();
        const userNarrative = String(body.narrative ?? "").slice(0, 4000);
        const header = [title && `Project: ${title}`, `Location: ${location}`, beneficiaries && `Beneficiaries: ${beneficiaries}`].filter(Boolean).join("\n");
        const narrative = header ? `${header}\n\n${userNarrative}` : userNarrative;
        // recipient: a valid EVM address from the form, else the controlled demo address
        const recipRaw = String(body.recipientWallet ?? "").trim();
        const toAddress = /^0x[0-9a-fA-F]{40}$/.test(recipRaw) ? recipRaw : RECIPIENT;
        // image attachments → multimodal merit scoring (cap count + size)
        const atts = Array.isArray(body.attachments) ? (body.attachments as Record<string, unknown>[]).slice(0, 4) : [];
        const media = atts
          .filter((a) => typeof a?.data === "string" && /^image\//.test(String(a?.type)) && String(a.data).length < 3_000_000)
          .map((a) => ({ mimeType: String(a.type), data: String(a.data) }))
          .slice(0, 3);

        const app: Application = {
          id, programId: cfg.program_id,
          applicant: { id: id + "-r", displayName: title || "New applicant", wallet: { address: toAddress, ageDays: Math.max(0, Number(body.walletAge) || 90), priorGrants: Math.max(0, Number(body.priorGrants) || 0), priorFlags: 0 }, ...(body.endorser ? { endorser: { id: id + "-e", bondUsdc: 50 } } : {}) },
          category, geo: location, requestedAmount: Math.max(1, Number(body.amount) || 100),
          narrative,
          milestones: cfg.milestones.map((mm) => ({ id: mm.id, label: mm.label, tranchePct: mm.tranche_pct, evidenceRequired: mm.evidence })),
          submittedAt: clock.now(),
        };
        PROGRAM_BY_ID[id] = String(body.program || category).toUpperCase().slice(0, 12);
        if (media.length) mediaByApp.set(id, media);
        let rec;
        try {
          rec = await core.intake(app);
          if (LIVE && rec.decision) rec.decision.firstTrancheCap = FIRST_TRANCHE_USDC; // cap the real on-chain transfer
          if (rec.decision?.kind === "AUTO_APPROVE" && store.get(id).state === "DISBURSE") await core.releaseTranche(id);
        } finally {
          mediaByApp.delete(id);
        }
        return json(res, { grant: serializeGrant(store.get(id), 1000 + n), decision: decisionPayload(store.get(id)), attachments: atts.map((a) => String(a?.name ?? "file")), mediaUsed: media.length });
      } catch (e) { return json(res, { error: (e as Error).message }, 400); }
    }
    const m = url.match(/^\/api\/grants\/([^/]+)\/(cosign|reject)$/);
    if (m && req.method === "POST") {
      const [, id, action] = m;
      try {
        if (action === "cosign") { const gr = store.get(id!); if (LIVE && gr.decision) gr.decision.firstTrancheCap = FIRST_TRANCHE_USDC; if (gr.state === "AWAIT_APPROVAL") core.approve(id!); if (store.get(id!).state === "DISBURSE") await core.releaseTranche(id!); }
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
}).listen(port, async () => {
  const snap = snapshot();
  console.log(`\n  Almoner dashboard → http://localhost:${port}  ·  Gemini scoring: ${snap.meta.gemini ? "on" : "off (heuristic)"}`);
  if (LIVE) {
    let bal = "?";
    try { bal = String(await wallet.balance()); } catch { /* session/credentials may be inactive */ }
    const label = WALLET_MODE === "circle-api" ? `circle-api wallet (DCW) · ${LIVE_CHAIN} · ${process.env.CIRCLE_WALLET_ID ?? "?"}` : `LIVE wallet (CLI) · ${LIVE_CHAIN} · ${TREASURY}`;
    console.log(`  ${label} · balance ${bal} USDC · each disbursement = ${FIRST_TRANCHE_USDC} USDC real on-chain`);
  } else {
    console.log(`  mock wallet (simulated disbursements) — set ALMONER_WALLET=live with a Circle CLI session for real transfers`);
  }
  console.log(`  ${snap.grants.length} grants seeded — apply or co-sign to disburse\n`);
});
