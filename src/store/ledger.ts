import { createHash } from "node:crypto";

// On-chain ledger mirror. In the MVP this is an append-only in-memory log that
// mirrors the events the agent would emit on Arc testnet. Each event carries
// only amounts, hashes, tx refs, statuses, and rationale HASHES — never PII.

export type LedgerEvent =
  | { type: "GrantCreated"; grantId: string; recipientHash: string; amount: number; programId: string }
  | { type: "GrantRejected"; grantId: string; recipientHash: string; rationaleHash: string }
  | { type: "RiskAssessed"; grantId: string; tier: string; rationaleHash: string }
  | { type: "TrancheReleased"; grantId: string; mId: string; amount: number; txHash: string }
  | { type: "MilestoneVerified"; grantId: string; mId: string; confidence: number }
  | { type: "MilestoneFlagged"; grantId: string; mId: string; reasonHash: string }
  | { type: "GrantCompleted"; grantId: string }
  | { type: "FundsReclaimed"; grantId: string; amount: number }
  | { type: "ReputationUpdated"; recipientHash: string; delta: number };

export interface LedgerRecord {
  seq: number;
  at: string; // ISO timestamp
  event: LedgerEvent;
}

/** keccak-style stand-in. (Swap for real keccak256 when wiring on-chain writes.) */
export function hash(input: string): string {
  return "0x" + createHash("sha256").update(input).digest("hex").slice(0, 40);
}

export class Ledger {
  private records: LedgerRecord[] = [];
  private seq = 0;

  emit(event: LedgerEvent, now: string): LedgerRecord {
    const record: LedgerRecord = { seq: ++this.seq, at: now, event };
    this.records.push(record);
    return record;
  }

  all(): readonly LedgerRecord[] {
    return this.records;
  }

  forGrant(grantId: string): LedgerRecord[] {
    return this.records.filter((r) => "grantId" in r.event && r.event.grantId === grantId);
  }
}
