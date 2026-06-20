import { spawn } from "node:child_process";
import type { ProgramConfig } from "../types/program.js";
import type { CircleWallet, TransferRequest, TransferReceipt } from "./circleWallet.js";
import { SpendingPolicyGuard, WalletPolicyError, type WalletPolicy } from "./spendingGuard.js";
import { mapConfigToCircleLimits, circleLimitSetArgs, isTestnetChain } from "./circlePolicy.js";

// Live Circle Agent Wallet adapter — drives the Circle CLI.
//
// Setup (one-time, by the operator):
//   npm install -g @circle-fin/cli
//   circle skill install --tool claude-code      # or: npx skills add circlefin/skills -g
//   circle wallet login <email> --type agent --init
//   circle wallet create --output json           # the program treasury wallet
//   # fund with testnet USDC from https://faucet.circle.com
//
// CLI command/flag names are taken from Circle's June-2026 skills. The exact
// transfer flags are not fully documented publicly — verify once against
// `circle wallet transfer --help` and adjust CMD below if needed. They are kept
// as pure builders so they can be unit-tested without invoking the binary.

export interface CliRunner {
  run(args: string[]): Promise<string>; // resolves stdout, rejects on non-zero exit
}

/** Default runner: spawns the `circle` binary. */
export class CircleCliRunner implements CliRunner {
  constructor(private readonly bin = "circle") {}
  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // CIRCLE_ACCEPT_TERMS=1 lets the CLI run non-interactively (already
      // accepted interactively during operator login).
      const env = { ...process.env, CIRCLE_ACCEPT_TERMS: "1" };
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`circle ${args.join(" ")} exited ${code}: ${err.trim()}`))));
    });
  }
}

export interface LiveWalletConfig {
  cfg: ProgramConfig;
  address: string; // treasury (source) wallet address
  usdcTokenAddress: string; // USDC contract on this chain (omit → sends native ETH!)
  treasuryReclaimAddress?: string; // where reclaimed funds go (defaults to self)
  policy: WalletPolicy;
  clock: () => string;
  runner?: CliRunner;
}

// --- pure argv builders (verified against `circle wallet transfer --help`) ---
// Usage: circle wallet transfer <toAddress> --amount <n> --token <usdc> --address <src> --chain <c>
export function balanceArgs(address: string, chain: string): string[] {
  return ["wallet", "balance", "--address", address, "--chain", chain, "--output", "json"];
}
export function transferArgs(sourceAddress: string, chain: string, to: string, amount: number, tokenAddress: string): string[] {
  // toAddress is POSITIONAL; --address is the SOURCE; --token is required for USDC.
  return ["wallet", "transfer", to, "--amount", String(amount), "--token", tokenAddress, "--address", sourceAddress, "--chain", chain, "--output", "json"];
}

/**
 * Best-effort extraction of a transaction reference from Circle CLI JSON.
 * Agent-wallet transfers are async MPC ops that return a transaction ID (under
 * `data`), not an immediate on-chain hash; we capture whichever is present.
 */
function pickTxRef(stdout: string): string {
  try {
    const j = JSON.parse(stdout);
    const d = j.data ?? j;
    return d.txHash ?? d.transactionHash ?? d.hash ?? d.transactionId ?? d.id ?? d.tx ?? "PENDING";
  } catch {
    const m = stdout.match(/0x[a-fA-F0-9]{64}/);
    return m?.[0] ?? "PENDING";
  }
}
function pickAmount(stdout: string): number {
  try {
    const j = JSON.parse(stdout);
    // Shape: { data: { balances: [ { amount: "19.9", token: { symbol: "USDC" } } ] } }
    const balances = j.data?.balances ?? j.balances ?? [];
    if (Array.isArray(balances) && balances.length) {
      const usdc = balances.find((b: { token?: { symbol?: string } }) => b?.token?.symbol === "USDC") ?? balances[0];
      return Number(usdc?.amount ?? 0);
    }
    const v = j.data?.balance ?? j.balance ?? j.amount;
    return v != null ? Number(v) : 0;
  } catch {
    return 0;
  }
}

export class LiveCircleWallet implements CircleWallet {
  private readonly guard: SpendingPolicyGuard;
  private readonly runner: CliRunner;
  private readonly chain: string;

  constructor(private readonly c: LiveWalletConfig) {
    this.guard = new SpendingPolicyGuard(c.policy, c.clock);
    this.runner = c.runner ?? new CircleCliRunner();
    this.chain = c.cfg.chain;
  }

  async balance(): Promise<number> {
    return pickAmount(await this.runner.run(balanceArgs(this.c.address, this.chain)));
  }

  async transfer(req: TransferRequest): Promise<TransferReceipt> {
    // Hard backstop runs FIRST — on Arc testnet this is the only enforcement
    // there is, since Circle's native policy cannot be set on a testnet.
    this.guard.check(req);
    const stdout = await this.runner.run(transferArgs(this.c.address, this.chain, req.to, req.amount, this.c.usdcTokenAddress));
    const receipt: TransferReceipt = { txHash: pickTxRef(stdout), to: req.to, amount: req.amount, at: this.c.clock() };
    this.guard.commit(req);
    return receipt;
  }

  async reclaim(grantId: string, amount: number): Promise<TransferReceipt> {
    const to = this.c.treasuryReclaimAddress ?? this.c.address;
    const stdout = await this.runner.run(transferArgs(this.c.address, this.chain, to, amount, this.c.usdcTokenAddress));
    this.guard.credit(amount);
    return { txHash: pickTxRef(stdout), to, amount, at: this.c.clock() };
  }

  /**
   * Push the native-expressible subset of the policy to Circle's wallet layer
   * as a redundant backstop. No-op (with reason) on testnet/Arc, where Circle
   * rejects policies and the guard is the sole enforcer.
   */
  async applyNativePolicy(): Promise<{ applied: boolean; reason: string }> {
    if (isTestnetChain(this.chain)) {
      return { applied: false, reason: `Circle spending policies are mainnet-only; ${this.chain} is a testnet → enforced app-side by SpendingPolicyGuard.` };
    }
    const { native, warnings } = mapConfigToCircleLimits(this.c.cfg);
    const bad = warnings.find((w) => w.includes("non-monotonic"));
    if (bad) return { applied: false, reason: bad };
    await this.runner.run(circleLimitSetArgs(this.c.address, this.chain, native));
    return { applied: true, reason: `set per-tx=${native.perTx} daily=${native.daily} weekly=${native.weekly} monthly=${native.monthly} (stablecoin)` };
  }
}

export { WalletPolicyError };
