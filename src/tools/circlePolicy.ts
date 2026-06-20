import { strict as assert } from "node:assert";
import type { ProgramConfig } from "../types/program.js";

// Maps a ProgramConfig's budget policy onto what Circle's native wallet spending
// policy can actually enforce, and reports the gap.
//
// Verified from Circle's agent-wallet-policy skill (June 2026):
//   - Spending policies are MAINNET-ONLY ("Testnet chains are rejected").
//   - Only monotonic amount caps: per-tx ≤ daily ≤ weekly ≤ monthly.
//   - policy-type: stablecoin.
//   - No per-recipient cumulative cap, no transaction-count velocity limit in
//     the limit command.
//   - Arc is testnet-only (no Arc mainnet exists) → Circle policy can never run
//     on Arc. The SpendingPolicyGuard is the backstop there.

export interface CircleNativeLimits {
  policyType: "stablecoin";
  perTx: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface PolicyMapping {
  native: CircleNativeLimits;
  /** Almoner caps Circle's native policy cannot express → enforced app-side. */
  appEnforcedOnly: string[];
  warnings: string[];
}

/** Chains where Circle will accept a spending policy. Arc is excluded by design. */
const TESTNET_MARKERS = ["TESTNET", "SEPOLIA", "GOERLI", "FUJI", "AMOY", "ARC"];

export function isTestnetChain(chain: string): boolean {
  const c = chain.toUpperCase();
  // Arc is testnet-only regardless of suffix; treat any ARC chain as testnet.
  return TESTNET_MARKERS.some((m) => c.includes(m));
}

export function mapConfigToCircleLimits(cfg: ProgramConfig): PolicyMapping {
  const b = cfg.budget;
  const warnings: string[] = [];

  // per-tx  := per_grant_cap
  // daily   := period_cap.amount (assumes a 24h window)
  // monthly := total_pool (closest native expression of the program ceiling)
  // weekly  := interpolated to satisfy monotonicity (daily ≤ weekly ≤ monthly)
  const perTx = b.per_grant_cap;
  const daily = b.period_cap.amount;
  const monthly = b.total_pool;
  const weekly = Math.min(monthly, Math.max(daily, daily * 7));

  if (b.period_cap.window !== "24h") {
    warnings.push(`period_cap.window is "${b.period_cap.window}", mapped to Circle's --daily as if 24h; adjust if not daily.`);
  }
  warnings.push("Circle has no lifetime/pool cap; total_pool mapped to --monthly (resets monthly). True pool exhaustion is enforced by SpendingPolicyGuard.total_budget_cap.");

  if (isTestnetChain(cfg.chain)) {
    warnings.push(
      `chain "${cfg.chain}" is a testnet (Arc is testnet-only). Circle rejects spending policies on testnets, so NONE of these native caps are set on-chain — the SpendingPolicyGuard enforces the full set app-side.`,
    );
  }

  // Monotonicity is a hard Circle requirement; surface a violation early.
  if (!(perTx <= daily && daily <= weekly && weekly <= monthly)) {
    warnings.push(
      `non-monotonic mapping (per-tx ${perTx} ≤ daily ${daily} ≤ weekly ${weekly} ≤ monthly ${monthly} fails); Circle would reject. Reconcile per_grant_cap/period_cap/total_pool.`,
    );
  }

  return {
    native: { policyType: "stablecoin", perTx, daily, weekly, monthly },
    appEnforcedOnly: [
      "per_recipient_cumulative_cap (no native Circle rule)",
      "velocity_limit by tx count (Circle limits are amount-based, not count-based)",
      "auto_approve_ceiling co-signature gate (app/operator concern, not a wallet rule)",
      "denylist (not part of the limit command; configure via wallet allow/block list separately if on mainnet)",
    ],
    warnings,
  };
}

/** Build the `circle wallet limit set` argv for a mapping. Verify flags with `circle wallet limit set --help`. */
export function circleLimitSetArgs(address: string, chain: string, m: CircleNativeLimits): string[] {
  return [
    "wallet",
    "limit",
    "set",
    "--address",
    address,
    "--chain",
    chain,
    "--policy-type",
    m.policyType,
    "--per-tx",
    String(m.perTx),
    "--daily",
    String(m.daily),
    "--weekly",
    String(m.weekly),
    "--monthly",
    String(m.monthly),
  ];
}

// --- runnable self-check: `npx tsx src/tools/circlePolicy.ts [programId]` ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  const { loadConfig } = await import("../config/loader.js");
  for (const id of ["climate-adapt-bd-2026", "post-disaster-ph-2026"]) {
    const cfg = loadConfig(id);
    const map = mapConfigToCircleLimits(cfg);
    console.log(`\n# ${cfg.program_id}  (chain=${cfg.chain}, testnet=${isTestnetChain(cfg.chain)})`);
    console.log("  native (mainnet-only):", map.native);
    console.log("  enforced app-side:", map.appEnforcedOnly);
    console.log("  warnings:");
    for (const w of map.warnings) console.log("   - " + w);
    // Monotonicity must hold for both presets.
    const { perTx, daily, weekly, monthly } = map.native;
    assert.ok(perTx <= daily && daily <= weekly && weekly <= monthly, `${id}: non-monotonic limits`);
  }
  console.log("\n✓ both presets map to monotonic Circle limits");
}
