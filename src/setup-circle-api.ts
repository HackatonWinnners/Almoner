import "./loadEnv.js";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

// DCW SDK is CommonJS — load via createRequire for cross-Node ESM interop.
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient, registerEntitySecretCiphertext } = require("@circle-fin/developer-controlled-wallets") as typeof import("@circle-fin/developer-controlled-wallets");

// One-time setup for Circle Developer-Controlled Wallets (the deployable, no-CLI
// path). Run once with your TEST API key:
//
//   CIRCLE_API_KEY=TEST_API_KEY:... npm run setup:circle
//
// It registers an entity secret, creates a treasury wallet on Base Sepolia, and
// prints the env vars to set on the server. Then fund the printed address from
// https://faucet.circle.com and redeploy with ALMONER_WALLET=circle-api.

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  console.error("Set CIRCLE_API_KEY — a TEST key from https://console.circle.com (API Keys).");
  process.exit(1);
}
const blockchain = process.env.CIRCLE_BLOCKCHAIN ?? "BASE-SEPOLIA";
const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? randomBytes(32).toString("hex");

console.log(`\nRegistering entity secret (blockchain: ${blockchain})…`);
try {
  const reg = await registerEntitySecretCiphertext({ apiKey, entitySecret } as Parameters<typeof registerEntitySecretCiphertext>[0]);
  const recovery = (reg.data as { recoveryFile?: string } | undefined)?.recoveryFile;
  if (recovery) {
    writeFileSync("circle-recovery.dat", recovery);
    console.log("  ✓ registered · recovery file → circle-recovery.dat (keep it safe, gitignored)");
  } else {
    console.log("  ✓ registered");
  }
} catch (e) {
  console.log("  · skipped (entity secret likely already registered for this account):", (e as Error).message);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

console.log("Creating wallet set + treasury wallet…");
const ws = await client.createWalletSet({ name: "almoner-treasury" });
const walletSetId = (ws.data as { walletSet?: { id?: string } }).walletSet?.id;
if (!walletSetId) throw new Error("wallet set creation returned no id");

const w = await client.createWallets({
  walletSetId,
  blockchains: [blockchain],
  count: 1,
  accountType: "SCA",
} as unknown as Parameters<typeof client.createWallets>[0]);
const wallet = ((w.data as { wallets?: Array<{ id?: string; address?: string }> }).wallets ?? [])[0];

console.log("\n=== SET THESE ON THE SERVER (Coolify env / almoner.env) ===");
console.log("ALMONER_WALLET=circle-api");
console.log("CIRCLE_API_KEY=" + apiKey);
console.log("CIRCLE_ENTITY_SECRET=" + entitySecret);
console.log("CIRCLE_WALLET_ID=" + (wallet?.id ?? "(none)"));
console.log("\n=== FUND THIS ADDRESS (Base Sepolia USDC) — https://faucet.circle.com ===");
console.log("  " + (wallet?.address ?? "(none)"));
console.log("");
