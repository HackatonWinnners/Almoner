# Almoner — 3-Minute Pitch

> *An autonomous AI grant officer that disburses real USDC microgrants — under a hard wallet policy it cannot break.*

**Read aloud: ~3 minutes. [⏱ markers] are pacing cues, not spoken.**

---

## [0:00 — The problem]

A $50 to $500 grant can change a life — a coastal farmer's seawall, a refugee family's first month, a post-typhoon roof.

But nobody funds them. The overhead kills it. A human grant officer costs more to review, approve, and audit a $200 grant than the grant is worth. So the smallest grants — the ones that matter most to the most vulnerable people — never get made.

**The bottleneck isn't money. It's the cost of the decision.**

## [0:30 — The solution]

Almoner is an autonomous AI agent that *is* the grant officer.

It intakes an application, scores its merit, screens it for risk, disburses USDC in tranches, verifies the milestone evidence, and writes everything to a public, auditable ledger. End to end. No human in the loop for small grants.

Collapse the overhead to near-zero, and **$50 microgrants become economically possible again.**

## [1:00 — The demo]

Here's the live pipeline. An applicant submits a form — title, amount, a narrative, and *photos*.

- **Gemini reads the narrative and looks at the photos** — multimodal — and scores six merit criteria, each with a written rationale.
- It risk-screens the wallet: sanctions, wallet age, sybil signals.
- The policy decides: under $200 and low-risk → **auto-approve and disburse**. $200–$500 → **queue for a human co-signature**. High-risk → **reject or block**.

And this is the part that matters: **the disbursement is real.** A live USDC transfer on Base Sepolia, with a tx hash you can click and verify on Basescan. Not a simulation.

Later, the applicant uploads milestone evidence. The agent catches an **AI-generated photo**, flags the grant, and reclaims the funds — automatically.

## [2:00 — Why it's safe: the security story]

The obvious objection: *you gave an LLM a wallet?*

No. We gave it a wallet **wrapped in two independent layers of policy.**

1. **A hard wallet backstop** — per-transaction caps, per-recipient caps, budget caps, velocity limits, a denylist. These hold **even if the agent is jailbroken by a prompt injection hidden inside an application.** The wallet itself throws. The LLM reasons; the deterministic core enforces.
2. **An app-level policy engine** — milestone ordering, risk tiers, co-sign gates for anything large.

The LLM can *propose*. It can never *unilaterally move large sums.* And PII never touches the chain — only amounts, hashes, and tx refs. Public and auditable, privacy preserved.

## [2:40 — The kicker]

And it's **program-agnostic.** One program equals one config file.

The same agent runs climate-adaptation grants today, post-disaster recovery tomorrow, refugee support or women's co-ops the day after — by swapping a JSON file. No code change.

**One autonomous officer. Any cause. Real money. Real guardrails.**

That's Almoner.
