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
npm run typecheck
```

The demo is **fully offline and deterministic** — no API keys, no network. All
external services (Circle wallet, x402 screening/image-check, the scoring LLM)
run as mocks behind interfaces so the whole lifecycle plays the same every run.

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
| Two-layer policy enforcement | ✅ real (caps actually block transfers) | mirrors on-chain wallet policy |
| Milestone verification pipeline | ✅ real (completeness/authenticity/reuse) | vision-LLM + x402 image API |
| USDC transfers | mock wallet enforcing the spending policy | Circle Agent Wallet, Arc testnet |
| Wallet screening / image check | mock x402 client | x402 marketplace (paid nanopayments) |
| Scoring "LLM" | deterministic fixtures | Claude Agent SDK |
| On-chain ledger | in-memory append-only mirror | Arc testnet events |

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
    scoring.ts           merit / impact rubric (§6.1)
    risk.ts              risk / fraud scoring + tiers (§6.2)
    verify.ts            milestone evidence pipeline (§7)
    clock.ts             injectable clock (deterministic demo)
  policy/engine.ts       app-level guardrails (§5.2)
  tools/
    circleWallet.ts      Circle wallet adapter + hard spending policy (§5.1)
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
  Claude Agent SDK as the scoring/verification brain.
- React dashboard (funder / applicant / public-ledger views).
- SQLite/Postgres + IPFS/object store behind the `Store` interface.
- Stretch: endorser staking & slashing, sybil-cluster graph analysis, on-chain
  reputation history, offline/SMS intake, FL privacy for cross-org applicant data.

See the full v1.0 spec for track-criteria mapping, pitch, and open decisions.
