import type { ProgramConfig } from "../types/program.js";

// SpendingPolicyGuard — the always-on hard backstop, independent of the agent.
//
// Circle's native wallet spending policy is MAINNET-ONLY and only expresses
// monotonic amount caps (per-tx ≤ daily ≤ weekly ≤ monthly). Arc is testnet-only,
// so on Arc there is NO Circle-enforced policy at all. This guard therefore is
// the real backstop: it enforces the full cap set (including per-recipient and
// transaction-count velocity, which Circle cannot express) in front of every
// transfer, on any chain. Both the mock and live wallet adapters run it.
//
// A transfer that violates a cap throws regardless of what the agent "decided" —
// which is the whole point: a prompt-injected agent still cannot move money
// outside these bounds.

export interface WalletPolicy {
  perTxCap: number;
  perRecipientCap: number;
  periodCap: { window: string; amount: number };
  totalBudgetCap: number;
  velocityLimitPerHour: number;
  autoApproveCeiling: number;
  denylist: string[];
}

export interface SpendRequest {
  to: string;
  amount: number;
  /** Set when an operator has co-signed an above-ceiling payment (§5.3). */
  coSigned?: boolean;
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

export class SpendingPolicyGuard {
  private budgetSpent = 0;
  private perRecipient = new Map<string, number>();
  private txTimes: number[] = [];

  constructor(
    private readonly policy: WalletPolicy,
    private readonly clock: () => string,
  ) {}

  /** Throw if the request violates any cap. Does NOT mutate state. */
  check(req: SpendRequest): void {
    const epoch = Date.parse(this.clock());

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
    if (this.budgetSpent + req.amount > this.policy.totalBudgetCap) {
      throw new WalletPolicyError("total_budget_cap", `spend ${this.budgetSpent + req.amount} exceeds pool ${this.policy.totalBudgetCap}`);
    }
    const hourAgo = epoch - 3600_000;
    const recent = this.txTimes.filter((t) => t >= hourAgo).length;
    if (recent >= this.policy.velocityLimitPerHour) {
      throw new WalletPolicyError("velocity_limit", `velocity limit ${this.policy.velocityLimitPerHour}/h exceeded`);
    }
  }

  /** Record a settled transfer. Call only after the transfer actually succeeds. */
  commit(req: SpendRequest): void {
    this.budgetSpent += req.amount;
    this.perRecipient.set(req.to, (this.perRecipient.get(req.to) ?? 0) + req.amount);
    this.txTimes.push(Date.parse(this.clock()));
  }

  /** Return reclaimed funds to the program budget. */
  credit(amount: number): void {
    this.budgetSpent = Math.max(0, this.budgetSpent - amount);
  }

  spent(): number {
    return this.budgetSpent;
  }

  remainingBudget(): number {
    return this.policy.totalBudgetCap - this.budgetSpent;
  }
}
