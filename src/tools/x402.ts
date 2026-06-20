import type { WalletInfo } from "../types/grant.js";

// x402 marketplace adapter — paid per-call services (nanopayments).
// Two services used by the agent:
//   1. wallet screening (sanctions / risk reputation)
//   2. image authenticity / AI-gen detection (used at VERIFY)
//
// In `live` mode these are real x402 402-Payment-Required calls settled in USDC
// via Circle. In `mock` mode we return deterministic results keyed off fixtures
// so the demo runs offline AND the "fraudulent" actor reliably trips the checks.

export interface ScreeningResult {
  sanctioned: boolean;
  riskReputation: number; // 0-100
  source: string;
  costUsdc: number; // nanopayment charged
}

export interface ImageCheckResult {
  aiGeneratedLikelihood: number; // 0-1
  reverseImageHit: boolean;
  source: string;
  costUsdc: number;
}

export interface X402Client {
  screenWallet(wallet: WalletInfo & { sanctioned?: boolean }): Promise<ScreeningResult>;
  checkImage(blobRef: string, hints?: { aiGeneratedLikelihood?: number }): Promise<ImageCheckResult>;
}

export class MockX402Client implements X402Client {
  public spentUsdc = 0;

  async screenWallet(wallet: WalletInfo & { sanctioned?: boolean }): Promise<ScreeningResult> {
    const cost = 0.05;
    this.spentUsdc += cost;
    // Deterministic: brand-new empty wallets read as higher reputation risk.
    const reputation = wallet.sanctioned
      ? 100
      : Math.min(100, (wallet.ageDays < 7 ? 45 : 10) + wallet.priorFlags * 25);
    return {
      sanctioned: Boolean(wallet.sanctioned),
      riskReputation: reputation,
      source: "x402://screening-mock",
      costUsdc: cost,
    };
  }

  async checkImage(_blobRef: string, hints?: { aiGeneratedLikelihood?: number }): Promise<ImageCheckResult> {
    const cost = 0.1;
    this.spentUsdc += cost;
    const likelihood = hints?.aiGeneratedLikelihood ?? 0.05;
    return {
      aiGeneratedLikelihood: likelihood,
      reverseImageHit: likelihood > 0.8,
      source: "x402://image-verify-mock",
      costUsdc: cost,
    };
  }
}
