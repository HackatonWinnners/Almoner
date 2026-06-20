import type { ProgramConfig } from "../types/program.js";
import type { Application, RiskResult, RiskSignal, RiskTier } from "../types/grant.js";
import type { X402Client } from "../tools/x402.js";

// Risk / fraud scoring (§6.2). Separate question from merit: "is it safe to pay?"
// Higher score = riskier. Sanctioned -> immediate BLOCK regardless of score.

export function tierFor(score: number, sanctioned: boolean): RiskTier {
  if (sanctioned || score >= 80) return "BLOCK";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

/** Demo hint: lets a fixture mark a wallet as sanctioned and flag duplicate content. */
export interface RiskFixture {
  sanctioned?: boolean;
  duplicateContent?: boolean;
  sybilCluster?: boolean;
}

export class RiskScorer {
  constructor(
    private readonly x402: X402Client,
    private readonly fixtures: Record<string, RiskFixture> = {},
  ) {}

  async assess(app: Application, cfg: ProgramConfig): Promise<RiskResult> {
    const fx = this.fixtures[app.id] ?? {};
    const wallet = app.applicant.wallet;
    const signals: RiskSignal[] = [];

    // 1. Paid x402 screening (sanctions + reputation).
    let sanctioned = false;
    if (cfg.risk_policy.screening_required) {
      const screen = await this.x402.screenWallet({ ...wallet, sanctioned: fx.sanctioned });
      sanctioned = screen.sanctioned;
      if (sanctioned) {
        signals.push({ signal: "sanctions", source: screen.source, delta: 100, detail: "wallet on sanctions/denylist" });
      } else if (screen.riskReputation >= 40) {
        signals.push({ signal: "reputation", source: screen.source, delta: 20, detail: `screening reputation ${screen.riskReputation}/100` });
      }
    }

    // 2. Wallet age / history (on-chain read).
    if (wallet.ageDays < cfg.risk_policy.min_wallet_age_days_for_auto) {
      signals.push({ signal: "new_wallet", source: "on-chain", delta: 20, detail: `wallet age ${wallet.ageDays}d < ${cfg.risk_policy.min_wallet_age_days_for_auto}d` });
    }

    // 3. On-chain reputation.
    if (wallet.priorGrants > 0) {
      signals.push({ signal: "reputation_good", source: "ledger", delta: -15, detail: `${wallet.priorGrants} delivered grant(s)` });
    }
    if (wallet.priorFlags > 0) {
      signals.push({ signal: "reputation_flag", source: "ledger", delta: 30 * wallet.priorFlags, detail: `${wallet.priorFlags} prior flag(s)` });
    }

    // 4. Duplicate / sybil signals (embedding similarity, shared funding source).
    if (fx.duplicateContent) {
      signals.push({ signal: "duplicate_content", source: "embedding", delta: 35, detail: "narrative near-duplicate of another application" });
    }
    if (fx.sybilCluster) {
      signals.push({ signal: "sybil_cluster", source: "graph", delta: 30, detail: "shares funding source with linked addresses" });
    }

    // 5. Endorser stake reduces risk.
    if (app.applicant.endorser) {
      signals.push({ signal: "endorser_bond", source: "stake", delta: -20, detail: `endorser bonded ${app.applicant.endorser.bondUsdc} USDC` });
    }

    const raw = signals.reduce((s, sig) => s + sig.delta, 0);
    const score = Math.max(0, Math.min(100, raw));
    const tier = tierFor(score, sanctioned);

    return {
      score,
      tier,
      signals,
      sanctioned,
      summary: `Risk ${score}/100 → ${tier}.${sanctioned ? " SANCTIONED → BLOCK." : ""} Drivers: ${signals.map((s) => s.signal).join(", ") || "none"}.`,
    };
  }
}
