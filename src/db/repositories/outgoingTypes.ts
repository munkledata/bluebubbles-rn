/** Types shared by the outgoing-message repository modules (moved from outgoing.ts). */

/** Exact correlation carried by capable RCS message DTOs and live success fanout. */
export interface ExactOutgoingAttemptSuccess {
  readonly tempGuid: string;
  readonly attemptGuid: string;
  readonly clientAttemptGeneration: number;
  readonly guid: string;
  /** Exact chat resolved by the ingestion owner. Required to recover after the temp row is purged. */
  readonly claimedChatId?: number;
  readonly dateCreated: number | null;
  readonly dateDelivered: number | null;
}
export type ExactOutgoingAttemptSuccessDisposition =
  | 'reconciled'
  | 'already-reconciled'
  | 'attempt-owner-pending'
  | 'stale-attempt'
  | 'owner-conflict'
  | 'unmatched';
