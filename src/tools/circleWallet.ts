import { createHash } from "node:crypto";
import type { ProgramConfig } from "../types/program.js";

// Circle Agent Wallet adapter.
//
// This is the agent's ONLY path to money. The spending policy configured on the
// Circle wallet itself is the hard backstop (§5.1): it must hold even if the
// agent is jailbroken by a prompt-injection inside an application. We mirror
// those caps here as `WalletPolicy` so the mock can enforce them locally and so
// the live adapter can assert the on-chain policy matches what we expect.
//
// MODE=mock  -> deterministic fake txs, fully offline (default for the demo).
// MODE=live  -> wire Circle CLI / SDK calls here.

export interface WalletPolicy {
  perTxCap: number;
  perRecipientCap: number;
  periodCap: { window: string; amount: number };
  totalBudgetCap: number;
  velocityLimitPerHour: number;
  autoApproveCeiling: number;
  denylist: string[];
}

export interface TransferRequest {
  to: string;
  amount: number;
  grantId: string;
  milestoneId: string;
  /** Set when an operator has co-signed an above-ceiling payment (§5.3). */
  coSigned?: boolean;
}

export interface TransferReceipt {
  txHash: string;
  to: string;
  amount: number;
  at: string;
}

export class WalletPolicyError extends Error {
  constructor(public readonly rule: string, message: string) {
    super(message);
    this.name = "WalletPolicyError";
  }
}

export function policyFromConfig(cfg: ProgramConfig, denylist: string[] = []): WalletPolicy {
  return {
    perTxCap: cfg.budget.per_grant_cap,
    perRecipientCap: cfg.budget.per_recipient_cumulative_cap,
    periodCap: cfg.budget.period_cap,
    totalBudgetCap: cfg.budget.total_pool,
    velocityLimitPerHour: 20,
    autoApproveCeiling: cfg.approval_policy.auto_approve_ceiling,
    denylist,
  };
}

export interface CircleWallet {
  balance(): Promise<number>;
  transfer(req: TransferRequest): Promise<TransferReceipt>;
  reclaim(grantId: string, amount: number): Promise<TransferReceipt>;
}

/**
 * Mock wallet that ENFORCES the spending policy the same way the real Circle
 * wallet would. Enforcing here proves the backstop is independent of the agent:
 * a transfer that violates a cap throws regardless of what the agent "decided".
 */
export class MockCircleWallet implements CircleWallet {
  private remaining: number;
  private perRecipient = new Map<string, number>();
  private txTimes: number[] = [];

  constructor(
    private readonly policy: WalletPolicy,
    private readonly clock: () => string,
    initialBalance?: number,
  ) {
    this.remaining = initialBalance ?? policy.totalBudgetCap;
  }

  async balance(): Promise<number> {
    return this.remaining;
  }

  async transfer(req: TransferRequest): Promise<TransferReceipt> {
    const now = this.clock();
    const epoch = Date.parse(now);

    if (this.policy.denylist.includes(req.to)) {
      throw new WalletPolicyError("denylist", `recipient ${req.to} is denylisted`);
    }
    if (req.amount > this.policy.perTxCap) {
      throw new WalletPolicyError("per_tx_cap", `amount ${req.amount} exceeds per_tx_cap ${this.policy.perTxCap}`);
    }
    if (req.amount > this.policy.autoApproveCeiling && !req.coSigned) {
      throw new WalletPolicyError(
        "auto_approve_ceiling",
        `amount ${req.amount} above auto_approve_ceiling ${this.policy.autoApproveCeiling} requires operator co-signature`,
      );
    }
    const recipTotal = (this.perRecipient.get(req.to) ?? 0) + req.amount;
    if (recipTotal > this.policy.perRecipientCap) {
      throw new WalletPolicyError("per_recipient_cap", `recipient cumulative ${recipTotal} exceeds ${this.policy.perRecipientCap}`);
    }
    if (req.amount > this.remaining) {
      throw new WalletPolicyError("total_budget_cap", `amount ${req.amount} exceeds remaining pool ${this.remaining}`);
    }
    // Velocity: count txs in the trailing hour.
    const hourAgo = epoch - 3600_000;
    this.txTimes = this.txTimes.filter((t) => t >= hourAgo);
    if (this.txTimes.length >= this.policy.velocityLimitPerHour) {
      throw new WalletPolicyError("velocity_limit", `velocity limit ${this.policy.velocityLimitPerHour}/h exceeded`);
    }

    // Commit.
    this.remaining -= req.amount;
    this.perRecipient.set(req.to, recipTotal);
    this.txTimes.push(epoch);

    return {
      txHash: "0x" + createHash("sha256").update(`${req.grantId}:${req.milestoneId}:${req.amount}:${now}`).digest("hex"),
      to: req.to,
      amount: req.amount,
      at: now,
    };
  }

  async reclaim(grantId: string, amount: number): Promise<TransferReceipt> {
    const now = this.clock();
    this.remaining += amount;
    return {
      txHash: "0x" + createHash("sha256").update(`reclaim:${grantId}:${amount}:${now}`).digest("hex"),
      to: "TREASURY",
      amount,
      at: now,
    };
  }
}
