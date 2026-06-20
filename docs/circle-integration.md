# Circle Agent Wallet — integration notes & the policy-enforcement reality

Researched June 2026 against Circle's Agent Stack docs and the official
[`circlefin/skills`](https://github.com/circlefin/skills) repo. This documents
what Circle's native spending policy **actually** enforces, the constraints that
shaped Almoner's design, and the exact CLI surface for the `live` adapter.

## TL;DR — the two findings that shaped the architecture

1. **Circle spending policies are mainnet-only.** The `agent-wallet-policy` skill
   states verbatim: *"Spending policies are mainnet-only. Testnet chains are
   rejected."*
2. **Arc is testnet-only — there is no Arc mainnet.** So Circle's native wallet
   policy **can never run on Arc**, today or later.

**Consequence:** the "hard wallet-level backstop independent of the agent" cannot
be Circle-enforced on Arc. Almoner therefore makes its own `SpendingPolicyGuard`
(`src/tools/spendingGuard.ts`) the always-on backstop — it runs in front of every
transfer on any chain and enforces the **full** cap set. When a program runs on a
policy-capable mainnet chain, the live adapter *additionally* pushes the
native-expressible subset to Circle's wallet layer as redundant defense
(`LiveCircleWallet.applyNativePolicy()`).

## What Circle's native policy can express

Only **monotonic amount caps**, policy-type `stablecoin`:

```bash
circle wallet limit set \
  --address <addr> --chain <MAINNET_CHAIN> \
  --policy-type stablecoin \
  --per-tx 1 --daily 5 --weekly 20 --monthly 50
```

Constraint: `per-tx ≤ daily ≤ weekly ≤ monthly` (monotonic, enforced by Circle).

| Almoner cap | Native Circle rule? | Where enforced |
|---|---|---|
| `per_grant_cap` (per-tx) | ✅ `--per-tx` | guard always; Circle on mainnet |
| `period_cap` 24h | ✅ `--daily` | guard always; Circle on mainnet |
| `total_pool` | ⚠️ closest is `--monthly` (resets monthly; no true lifetime cap) | guard (`total_budget_cap`) is authoritative |
| `per_recipient_cumulative_cap` | ❌ no native rule | guard only |
| `velocity_limit` (tx **count**/hr) | ❌ Circle caps are amount-based, not count-based | guard only |
| `auto_approve_ceiling` (co-sign gate) | ❌ not a wallet rule | app/operator |
| denylist | ◐ not in `limit set`; separate allow/block list, mainnet only | guard always |

Run `npm run circle:plan` to print the mapping + warnings for each preset.

## Live adapter CLI surface

Verified command names (flags marked ⚠️ need a `--help` confirmation when wiring):

```bash
# one-time operator setup
npm install -g @circle-fin/cli
circle skill install --tool claude-code          # or: npx skills add circlefin/skills -g
circle wallet login <email> --type agent --init
circle wallet login --type agent --request <request-id> --otp <code>
circle wallet create --output json               # program treasury wallet
# fund: https://faucet.circle.com  (testnet USDC)

# operations the agent uses
circle wallet balance  --address <addr> --chain <chain> --output json
circle wallet transfer --address <addr> --chain <chain> --to <addr> --amount <usdc> --output json   # ⚠️ verify flags
circle services pay "<url>" -X <METHOD> --address <addr> --chain <chain> --max-amount <usdc> --output json   # x402
circle wallet limit set ...                       # mainnet only (see above)
```

- **Arc testnet:** chain id `5042002` (viem `arcTestnet`, built-in). The exact
  string the CLI expects for `--chain` is case-sensitive and should be confirmed
  with `circle blockchain`; configs currently use `ARC-TESTNET` as a placeholder.
- **x402 `--chain` enum** documented as `BASE, MATIC, ETH, ARB, OP, AVAX, UNI` —
  Arc was **not** listed for `services pay`, so paid screening/image-verify may
  need to settle on a different chain than disbursements. Flag to verify before
  relying on x402-on-Arc in the demo.

## How this maps to the code

- `src/tools/spendingGuard.ts` — the real backstop (all caps, any chain).
- `src/tools/circlePolicy.ts` — `ProgramConfig` → native Circle limits, monotonic
  validation, testnet detection, `circle wallet limit set` argv builder.
- `src/tools/circleWalletLive.ts` — `LiveCircleWallet` over the Circle CLI
  (injectable `CliRunner` so command construction is unit-testable offline);
  `applyNativePolicy()` no-ops with a reason on testnet/Arc.
- `src/tools/circleWallet.ts` — `MockCircleWallet` runs the same guard so the
  offline demo behaves exactly like a policy-enforced wallet.

## Pitch framing (use this, it's stronger than "agent sends USDC")

> Circle's native spending policy is mainnet-only and expresses monotonic amount
> caps; Arc is testnet-only, so on our disbursement chain there is no on-chain
> policy at all. We treat that as a design constraint, not a gap: Almoner's own
> guard is the always-on hard backstop — it enforces per-recipient and velocity
> limits Circle can't express, on any chain, in front of every transfer — and on
> mainnet we delegate the native subset to Circle's wallet layer as redundant
> defense. We know exactly where the platform's guarantees end and ours begin.

## Sources

- Circle Agent Stack — https://www.circle.com/agent-stack
- Agent Wallets docs — https://developers.circle.com/agent-stack/agent-wallets
- `circlefin/skills` — https://github.com/circlefin/skills
  (`agent-wallet-policy`, `use-agent-wallet`, `pay-via-agent-wallet`, `use-arc`)
- Circle Arc public testnet — https://www.circle.com/pressroom/circle-launches-arc-public-testnet
- Testnet USDC faucet — https://faucet.circle.com
