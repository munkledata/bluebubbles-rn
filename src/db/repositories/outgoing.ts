/**
 * The outgoing-message repository front door. The implementation lives in outgoingTypes.ts,
 * outgoingIdentity.ts, outgoingInserts.ts, outgoingClaims.ts, outgoingReconcile.ts and outgoingEcho.ts;
 * this file re-exports every public name, so importers and `export * from './outgoing'` are unchanged.
 */

// Star re-exports of exactly the five modules whose exports were this file's public names (the identity
// module's helpers stayed internal). A star re-export is not a named mutator reference, so the
// scheduled-recovery guard's closed set of insertOutgoingText uses is unchanged.
export * from './outgoingTypes';
export * from './outgoingInserts';
export * from './outgoingClaims';
export * from './outgoingReconcile';
export * from './outgoingEcho';

export {
  MESSAGE_GUID_ALIAS_LIMIT,
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  MessageGuidAliasConflictError,
  recordMessageGuidAliasWithinTransaction,
  type SendAttemptOwnerToken,
} from './outgoingAttemptOwnership';
export {
  imessagePlainTextQueueState,
  OUTGOING_GRACE_MS,
  OUTGOING_MAX_ATTEMPTS,
  outgoingBackoffMs,
} from './outgoingRetryPolicy';
export * from './outgoingRetry';
