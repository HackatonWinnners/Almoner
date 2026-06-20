# Almoner — Autonomous AI Microgrant Officer

> An autonomous agent that works as a grant officer: it intakes applications,
> scores merit, screens risk, disburses USDC in tranches under a hard wallet
> policy, verifies milestone evidence, and keeps a public, auditable ledger.
> The goal is to collapse overhead so that **$50–500 microgrants to vulnerable
> recipients become economically possible.**

**Hackathon:** BGA (Blockchain for Good) + Circle Agent Wallet (dual-track).

The engine is **program-agnostic**: one program = one `ProgramConfig`. The same
agent runs climate-adaptation grants, post-disaster recovery, refugee support,
women's co-ops, or data bounties by swapping a config file.

---

## Quick start

```bash
npm install
npm run demo            # climate-adaptation preset (Bangladesh coastal)
npm run demo:disaster   # post-typhoon preset (Philippines) — proves config-swap
npm run circle:plan     # show how each program maps to Circle's native caps
npm run typecheck

# Gemini brain (Gemini operates the wallet). Needs a free Gemini key:
GEMINI_API_KEY=... npm run brain

# REAL USDC tranches on Base Sepolia (needs a Circle CLI testnet session):
npm run live

# Dashboard (funder / applicant / public-ledger views) → http://localhost:5173
npm run dashboard
```

### Dashboard

`npm run dashboard` serves `web/index.html` — a self-contained React UI (no build
step, no framework deps; React via CDN) with three role views:

- **Funder** — pool/disbursed/reclaimed/available metrics, budget burndown,
  wallet-spending-policy caps strip, the operator co-signature queue, and a
  grants table; click any grant for a full audit-trail drawer (merit breakdown,
  risk signals, milestone tracker, decision log, co-sign action).
- **Applicant** — application status, milestone evidence upload + live
  verification pipeline, tranche history, plus rejected / flagged states with
  rationale and appeal paths.
- **Public ledger** — anonymized on-chain event feed (no PII; rationale as hash),
  filterable by program / event / risk tier.

A kill-switch in the top bar freezes all disbursements. The design came from a
Claude Design composition (`Almoner.dc.html`); this is its standalone
implementation. Data is currently seeded in-component — wiring it to the live
`AgentCore` state is the next step.

> **This is live, not simulated.** `npm run live` disburses real USDC on Base
> Sepolia through the full pipeline (score → risk → guarded release → verify →
> next tranche), e.g.
> [m1 0.2 USDC](https://sepolia.basescan.org/tx/0xebf9c224f322f131180764dfb5817a5d6c793c5408477c0aeb472a06ce1dd4d7)
> → verify PASS →
> [m2 0.2 USDC](https://sepolia.basescan.org/tx/0x321f26d7947bc9a7c9204ac6e5a674cc92a73e7181c70450d15c52adae3a1bec).
> Setup + the Circle integration reality (testnet sessions, mainnet-only policy,
> verified CLI surface) are in [`docs/circle-integration.md`](docs/circle-integration.md).

The default demo is **fully offline and deterministic** — no API keys, no
network. All external services (Circle wallet, x402 screening/image-check, the
scoring LLM) run as mocks behind interfaces so the whole lifecycle plays the
same every run.

### Three ways to drive the same engine

| | `npm run demo` | `npm run brain` | `npm run live` |
|---|---|---|---|
| Driver | deterministic script | **Gemini** decides + calls tools | deterministic script |
| Needs | nothing | `GEMINI_API_KEY` (free tier) | Circle CLI testnet session |
| Money | mock (guarded) | mock (guarded) | **real USDC on Base Sepolia** |

The brain (`src/agent/geminiBrain.ts`) runs **Gemini** as the grant officer via
function calling. It calls the vendor-neutral `GrantOfficerToolkit`
(`src/agent/tools/grantToolkit.ts`) — `evaluate_application`,
`release_next_tranche`, `verify_milestone_evidence`, etc. — but every call routes
through `AgentCore` → `PolicyEngine` + `SpendingPolicyGuard`, so **the LLM cannot
move funds outside the caps**, and a co-sign gate denies releasing human-band
grants without operator approval. The LLM reasons; the deterministic core
enforces. The toolkit is model-agnostic, so swapping the brain (Gemini, or any
function-calling model) doesn't touch the money path.

> **Note on "Circle Skills":** Circle ships *no* MCP server — its "Skills" are
> markdown docs that teach an agent to drive the `circle` CLI. The live adapter
> shells out to that CLI directly; Circle Skills are the knowledge layer behind it.

It walks the §11 scenario end-to-end: 4 applications → score + risk-screen →
auto-approve / human-queue / reject / **block** → tranche disbursement with tx
hashes → milestone verification → an **AI-generated photo caught** → flag +
reclaim → public ledger + budget burndown.

---

## What's real vs. mocked

| Layer | MVP (this repo) | `live` seam |
|---|---|---|
| Grant lifecycle / state machine | ✅ real | — |
| Merit + risk scoring logic | ✅ real (anchored rubric, weighted) | LLM returns the anchors |
| Two-layer policy enforcement | ✅ real (`SpendingPolicyGuard` actually blocks transfers) | + native subset on mainnet |
| Milestone verification pipeline | ✅ real (completeness/authenticity/reuse) | vision-LLM + x402 image API |
| USDC transfers | mock wallet running the real guard | `LiveCircleWallet` over Circle CLI, Arc testnet |
| Circle CLI adapter | ✅ pure argv builders + policy mapping (unit-testable) | inject `CircleCliRunner` (spawns `circle`) |
| Wallet screening / image check | mock x402 client | x402 marketplace (paid nanopayments) |
| Scoring "LLM" | deterministic fixtures | Gemini (`@google/genai`) |
| On-chain ledger | in-memory append-only mirror | Arc testnet events |

> **Circle policy reality (researched, see [`docs/circle-integration.md`](docs/circle-integration.md)):**
> Circle's native spending policy is **mainnet-only** and expresses only monotonic
> amount caps (`per-tx ≤ daily ≤ weekly ≤ monthly`). **Arc is testnet-only**, so on
> the disbursement chain there is *no* Circle-enforced policy. Almoner's
> `SpendingPolicyGuard` is therefore the always-on backstop (full cap set, any
> chain); on mainnet the live adapter additionally pushes the native subset to
> Circle. Run `npm run circle:plan` to see the mapping per program.

Switch via `ALMONER_MODE` in `.env` (see `.env.example`). The `mock`
implementations live next to their interfaces, so wiring `live` is a matter of
adding a second implementation, not rewriting the agent.

---

## Architecture

```
ProgramConfig ──► AgentCore (state machine: intake→screen→score→decision→
                            disburse→await-evidence→verify→complete/reclaim)
                     │
        ┌────────────┼───────────────┬──────────────┐
        ▼            ▼               ▼              ▼
   MeritAssessor  RiskScorer   PolicyEngine   EvidenceVerifier
   (rubric/LLM)   (x402+chain) (app-level)    (vision/x402)
                     │               │
                     ▼               ▼
              x402 client     CircleWallet  ◄── hard spending policy (backstop)
                                    │
                                    ▼
                              Ledger (on-chain mirror, no PII)
```

### Two-layer policy (the security story)

Money is governed in **two independent places** because one agent isn't enough:

1. **Wallet-level (hard backstop)** — `src/tools/circleWallet.ts`. Per-tx cap,
   per-recipient cap, period cap, total budget cap, velocity limit, denylist,
   auto-approve ceiling. These hold **even if the agent is jailbroken by a
   prompt-injection inside an application** — the mock wallet *enforces* them, so
   a policy-violating transfer throws no matter what the agent "decided."
2. **App-level (soft reasoning)** — `src/policy/engine.ts`. Vets every proposed
   action *before* the wallet call: milestone ordering (no m2 before m1 verified),
   `ProgramConfig` conformance, risk tier, cumulative caps, endorser requirement.

Above the auto-approve ceiling, the agent only produces a **proposed payment**
(score + rationale + risk report) and waits for an operator co-signature — it
cannot unilaterally move large sums.

### Privacy

PII and application content stay **off-chain** (`src/store/db.ts`). The on-chain
ledger (`src/store/ledger.ts`) carries only amounts, hashes, tx refs, statuses,
and **rationale hashes** — public and auditable, privacy preserved.

---

## Layout

```
configs/                 ProgramConfig presets (.jsonc) — swap to repurpose
src/
  types/                 shared contracts (program.ts, grant.ts)
  config/loader.ts       JSONC loader + invariant validation
  agent/
    core.ts              orchestrator + buildDecision() (the lifecycle)
    geminiBrain.ts       Gemini function-calling grant-officer loop (needs key)
    tools/
      grantToolkit.ts    vendor-neutral guarded tools (used by the brain)
    scoring.ts           merit / impact rubric (§6.1)
    risk.ts              risk / fraud scoring + tiers (§6.2)
    verify.ts            milestone evidence pipeline (§7)
    clock.ts             injectable clock (deterministic demo)
  runtime.ts             shared wiring + demo fixtures (used by demo & brain)
  brain-demo.ts          entrypoint for `npm run brain`
  policy/engine.ts       app-level guardrails (§5.2)
  tools/
    spendingGuard.ts     the hard backstop — full cap set, any chain (§5.1)
    circleWallet.ts      wallet interface + offline mock (runs the guard)
    circleWalletLive.ts  live adapter over the Circle CLI (Arc testnet)
    circlePolicy.ts      ProgramConfig → Circle native limits + monotonic check
    x402.ts              paid screening / image-check adapter
  store/
    db.ts                off-chain store (PII, applications, evidence)
    ledger.ts            on-chain event mirror (no PII)
  index.ts               end-to-end offline demo (§11 scenario)
```

---

## Scoring model

Two **independent** scores — "should we fund?" (merit) is a different question
from "is it safe to pay?" (risk).

- **Merit (0–100):** anchored rubric, weighted per config. `merit = Σ(anchor/5 ·
  weight) · 100`. Below `fund_threshold` → reject with reasons. Each criterion
  emits 1–2 sentences of rationale — that's the explainability surface for judges
  and for applicant appeals.
- **Risk (0–100, higher = worse):** sanctions/reputation (x402), wallet age &
  on-chain history, sybil/duplicate signals, endorser stake → tiers
  LOW / MEDIUM / HIGH / **BLOCK**. Anti-sybil math: tranches + reputation-gating
  + stake bonds make a fake cost more than it can extract.

On genuine verification uncertainty the agent escalates to a human — it never
auto-rejects. Erring against a poor applicant is costlier than erring against
the fund.

---

## Roadmap / not yet built

- `live` adapters: Circle CLI/SDK wallet ops on Arc testnet; x402 paid calls;
  Gemini as the scoring/verification brain.
- React dashboard (funder / applicant / public-ledger views).
- SQLite/Postgres + IPFS/object store behind the `Store` interface.
- Stretch: endorser staking & slashing, sybil-cluster graph analysis, on-chain
  reputation history, offline/SMS intake, FL privacy for cross-org applicant data.

See the full v1.0 spec for track-criteria mapping, pitch, and open decisions.
