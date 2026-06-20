import { createHash } from "node:crypto";
import {
  SpendingPolicyGuard,
  WalletPolicyError,
  policyFromConfig,
  type WalletPolicy,
} from "./spendingGuard.js";

// Circle Agent Wallet adapter — interface + offline mock.
//
// This is the agent's ONLY path to money. The SpendingPolicyGuard is the hard
// backstop (§5.1) and runs in front of every transfer here. See spendingGuard.ts
// for why the guard — not Circle's native policy — is the real backstop on Arc.
//
// The `live` implementation lives in circleWalletLive.ts.

export { WalletPolicyError, policyFromConfig };
export type { WalletPolicy };

export interface TransferRequest {
  to: string;
  amount: number;
  grantId: string;
  milestoneId: string;
  coSigned?: boolean;
}

export interface TransferReceipt {
  txHash: string;
  to: string;
  amount: number;
  at: string;
}

export interface CircleWallet {
  balance(): Promise<number>;
  transfer(req: TransferRequest): Promise<TransferReceipt>;
  reclaim(grantId: string, amount: number): Promise<TransferReceipt>;
}

/**
 * Mock wallet that ENFORCES the spending policy exactly as the live adapter
 * does — both run the same SpendingPolicyGuard. Enforcing here proves the
 * backstop is independent of the agent: a transfer that violates a cap throws
 * regardless of what the agent decided.
 */
export class MockCircleWallet implements CircleWallet {
  private readonly guard: SpendingPolicyGuard;
  private readonly initialBalance: number;

  constructor(
    policy: WalletPolicy,
    private readonly clock: () => string,
    initialBalance?: number,
  ) {
    this.guard = new SpendingPolicyGuard(policy, clock);
    this.initialBalance = initialBalance ?? policy.totalBudgetCap;
  }

  async balance(): Promise<number> {
    return this.initialBalance - this.guard.spent();
  }

  async transfer(req: TransferRequest): Promise<TransferReceipt> {
    this.guard.check(req);
    const now = this.clock();
    const receipt: TransferReceipt = {
      txHash: "0x" + createHash("sha256").update(`${req.grantId}:${req.milestoneId}:${req.amount}:${now}`).digest("hex"),
      to: req.to,
      amount: req.amount,
      at: now,
    };
    this.guard.commit(req);
    return receipt;
  }

  async reclaim(grantId: string, amount: number): Promise<TransferReceipt> {
    const now = this.clock();
    this.guard.credit(amount);
    return {
      txHash: "0x" + createHash("sha256").update(`reclaim:${grantId}:${amount}:${now}`).digest("hex"),
      to: "TREASURY",
      amount,
      at: now,
    };
  }
}
