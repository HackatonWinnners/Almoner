import { createRequire } from "node:module";
import type { CircleWallet, TransferRequest, TransferReceipt } from "./circleWallet.js";

// The DCW SDK is CommonJS; ESM named-import interop is flaky across Node
// versions, so load it via createRequire (forces CJS, works everywhere).
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as typeof import("@circle-fin/developer-controlled-wallets");
import { SpendingPolicyGuard, type WalletPolicy } from "./spendingGuard.js";

// Circle Developer-Controlled Wallet adapter. Unlike the agent-wallet CLI (which
// needs an interactive, machine-bound session), DCW authenticates with an API
// key + entity secret — so it works inside a container / on a VPS. This is what
// lets the DEPLOYED instance send real USDC. Set ALMONER_WALLET=circle-api.

type Client = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

export interface CircleApiWalletConfig {
  apiKey: string;
  entitySecret: string;
  walletId: string; // the treasury wallet (created via `npm run setup:circle`)
  policy: WalletPolicy;
  clock: () => string;
  treasuryReclaimAddress?: string;
}

export class CircleApiWallet implements CircleWallet {
  private readonly client: Client;
  private readonly guard: SpendingPolicyGuard;
  private usdcTokenId?: string;

  constructor(private readonly c: CircleApiWalletConfig) {
    this.client = initiateDeveloperControlledWalletsClient({ apiKey: c.apiKey, entitySecret: c.entitySecret });
    this.guard = new SpendingPolicyGuard(c.policy, c.clock);
  }

  private async usdc(): Promise<{ id: string; amount: number }> {
    const res = await this.client.getWalletTokenBalance({ id: this.c.walletId });
    const balances = ((res.data as { tokenBalances?: unknown[] }).tokenBalances ?? []) as Array<{ token?: { id?: string; symbol?: string }; amount?: string }>;
    const usdc = balances.find((b) => b.token?.symbol === "USDC") ?? balances[0];
    if (!usdc?.token?.id) throw new Error("no USDC token balance — fund the wallet from faucet.circle.com (Base Sepolia)");
    this.usdcTokenId = usdc.token.id;
    return { id: usdc.token.id, amount: Number(usdc.amount ?? 0) };
  }

  async balance(): Promise<number> {
    try {
      return (await this.usdc()).amount;
    } catch {
      return 0;
    }
  }

  async transfer(req: TransferRequest): Promise<TransferReceipt> {
    this.guard.check(req);
    const tokenId = this.usdcTokenId ?? (await this.usdc()).id;
    const created = await this.client.createTransaction({
      walletId: this.c.walletId,
      tokenId,
      destinationAddress: req.to,
      amount: [String(req.amount)],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    } as unknown as Parameters<Client["createTransaction"]>[0]);
    const txId = (created.data as { id?: string }).id;
    if (!txId) throw new Error("createTransaction returned no id");

    // Poll until the transaction has a broadcast tx hash (testnet ~5–30s).
    let txHash = "";
    for (let i = 0; i < 24 && !txHash; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const got = await this.client.getTransaction({ id: txId });
      const t = ((got.data as { transaction?: unknown }).transaction ?? got.data) as { txHash?: string; state?: string };
      if (t?.state === "FAILED" || t?.state === "CANCELLED") throw new Error(`transfer ${t.state}`);
      txHash = t?.txHash ?? "";
    }

    this.guard.commit(req);
    return { txHash: txHash || `pending:${txId}`, to: req.to, amount: req.amount, at: this.c.clock() };
  }

  async reclaim(_grantId: string, amount: number): Promise<TransferReceipt> {
    // Already-disbursed funds can't be clawed back on-chain; reclaim only returns
    // the undisbursed remainder to the program-budget accounting.
    this.guard.credit(amount);
    return { txHash: "reclaim", to: this.c.treasuryReclaimAddress ?? "TREASURY", amount, at: this.c.clock() };
  }
}
