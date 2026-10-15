import { isExactMessagePartTopology, MAX_RETRACTION_PART_INDEX } from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
import { isRcsChatGuid } from '@utils/chat';
import { sql } from 'drizzle-orm';
import {
  DbCommitGuardRejectedError,
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

export type MessageTargetPartKind = 'any' | 'text';

/**
 * Current server-capability proof used only when an old row has no exact part topology.
 * `undefined` is deliberately "unknown", not "modern": callers must defer durable work until a
 * current ServerInfo result can distinguish the two.
 */
export interface MessageTargetServerAuthorization {
  readonly allowsLegacyPartZero: boolean;
  isCurrent(): boolean;
}

export interface ExactMessageTarget {
  /** Exact conversation owner; a GUID alone never authorizes a reply or message action. */
  readonly chatGuid: string;
  readonly messageGuid: string;
  readonly partIndex: number;
  readonly partKind?: MessageTargetPartKind;
  /** Reaction-only opt-in: RCS addresses one confirmed message, not an Apple message part. */
  readonly allowRcsWholeMessage?: boolean;
  /** Current, revision-bound ServerInfo proof for the legacy no-topology compatibility case. */
  readonly serverAuthorization?: MessageTargetServerAuthorization;
}

export interface ExplicitMessageTargetPart {
  readonly messageGuid: string;
  readonly partIndex: number;
}

export interface ResolvedMessageTarget {
  readonly messageGuid: string;
  readonly partIndex: number;
  readonly partKind?: MessageTargetPartKind;
  /**
   * What proved this target. Only 'exact-topology' verifies Apple's current part layout;
   * 'pending-unsend-fence' proves only that this row holds the caller's own pending unsend.
   */
  readonly basis:
    'exact-topology' | 'legacy-part-zero' | 'rcs-whole-message' | 'pending-unsend-fence';
}

/** A target could not be proved safe from the durable message-part projection. */
export class MessageTargetUnavailableError extends Error {
  constructor(message = 'The selected message part is no longer available') {
    super(message);
    this.name = 'MessageTargetUnavailableError';
  }
}

/** A durable target may be legacy, but no current ServerInfo result exists to decide safely. */
export class MessageTargetCapabilityUnknownError extends Error {
  constructor() {
    super('Message target validation is waiting for current server capabilities');
    this.name = 'MessageTargetCapabilityUnknownError';
  }
}

function isBoundedPartIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RETRACTION_PART_INDEX
  );
}

/**
 * Normalize the paired outbound target fields. A message GUID never silently implies part zero:
 * callers must preserve the exact part chosen by the UI (including an explicit legacy zero).
 */
export function explicitMessageTargetPart(
  messageGuid: unknown,
  partIndex: unknown,
): ExplicitMessageTargetPart | null {
  const hasGuid = messageGuid !== undefined && messageGuid !== null;
  const hasPart = partIndex !== undefined && partIndex !== null;
  if (!hasGuid && !hasPart) return null;
  if (
    !hasGuid ||
    typeof messageGuid !== 'string' ||
    messageGuid.length === 0 ||
    !hasPart ||
    !isBoundedPartIndex(partIndex)
  ) {
    throw new MessageTargetUnavailableError('A reply or message action needs an exact target part');
  }
  return { messageGuid, partIndex };
}

/**
 * Verify one exact target against committed DB truth while joining the caller's transaction.
 *
 * Complete topology is authoritative. A topology-bearing but malformed/incomplete row is never
 * allowed to fall back to part zero. The sole compatibility path is an unretracted legacy row with
 * no topology at all, and even there only an explicit part zero is accepted.
 */
export function resolveMessageTargetWithinTransaction(
  context: DbTransactionContext,
  target: ExactMessageTarget,
): Promise<ResolvedMessageTarget | null> {
  return runInTransactionContext(context, async (db) => {
    if (
      !target.chatGuid ||
      !target.messageGuid ||
      !isBoundedPartIndex(target.partIndex) ||
      (target.partKind !== undefined && target.partKind !== 'any' && target.partKind !== 'text') ||
      (target.allowRcsWholeMessage !== undefined &&
        typeof target.allowRcsWholeMessage !== 'boolean')
    ) {
      return null;
    }

    const rows = await db.all<{
      guid: string;
      chatGuid: string;
      dateDeleted: number | null;
      dateRetracted: number | null;
      retractionState: string | null;
      messagePartTopology: string | null;
    }>(sql`
      SELECT m.guid, c.guid AS chatGuid, m.date_deleted AS dateDeleted,
             m.date_retracted AS dateRetracted,
             m.retraction_state AS retractionState,
             m.message_part_topology AS messagePartTopology
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE c.guid = ${target.chatGuid}
         AND (m.guid = ${target.messageGuid}
          OR m.guid IN (
               SELECT canonical_guid
                 FROM message_guid_aliases a
                WHERE a.alias_guid = ${target.messageGuid}
                  AND a.chat_guid = c.guid
             ))
       ORDER BY CASE WHEN m.guid = ${target.messageGuid} THEN 0 ELSE 1 END
       LIMIT 2
    `);
    // A direct row plus a differently resolved alias is inconsistent identity, not permission to
    // choose whichever happens to sort first.
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (row.chatGuid !== target.chatGuid) return null;
    if (row.dateDeleted != null) return null;
    if (row.retractionState === 'fully-retracted' || row.retractionState === 'unknown') return null;
    if (row.dateRetracted != null && row.retractionState !== 'partial') return null;

    // Google Messages reactions address the whole RCS message and expose no Apple part topology.
    // This exception is explicit and reaction-only at every caller; it must never authorize a
    // threaded reply, edit, unsend, attachment reply, or an arbitrary/noncanonical message id.
    if (target.allowRcsWholeMessage === true) {
      if (
        !isRcsChatGuid(target.chatGuid) ||
        !isRcsChatGuid(row.chatGuid) ||
        !row.guid.startsWith('rcs-') ||
        row.retractionState === 'partial' ||
        target.partIndex !== 0 ||
        target.partKind === 'text'
      ) {
        return null;
      }
      return {
        messageGuid: row.guid,
        partIndex: 0,
        partKind: target.partKind,
        basis: 'rcs-whole-message',
      };
    }

    if (row.messagePartTopology != null) {
      const topology = parseMessagePartTopology(row.messagePartTopology);
      if (!isExactMessagePartTopology(topology)) return null;
      const part = topology.currentParts.find((candidate) => candidate.index === target.partIndex);
      if (!part || (target.partKind === 'text' && part.kind !== 'text')) return null;
      return {
        messageGuid: row.guid,
        partIndex: target.partIndex,
        partKind: target.partKind,
        basis: 'exact-topology',
      };
    }

    // Partial rows require exact topology to prove what survived. Only a genuinely legacy intact
    // row retains the compatibility target, and it is always explicit zero rather than a default.
    if (row.retractionState === 'partial') return null;
    const authorization = target.serverAuthorization;
    if (!authorization) throw new MessageTargetCapabilityUnknownError();
    if (!authorization.isCurrent()) throw new DbCommitGuardRejectedError();
    if (!authorization.allowsLegacyPartZero || target.partIndex !== 0) return null;
    return {
      messageGuid: row.guid,
      partIndex: target.partIndex,
      partKind: target.partKind,
      basis: 'legacy-part-zero',
    };
  });
}

export async function isMessageTargetAvailableWithinTransaction(
  context: DbTransactionContext,
  target: ExactMessageTarget,
): Promise<boolean> {
  return (await resolveMessageTargetWithinTransaction(context, target)) !== null;
}

/** Resolve aliases and return the canonical GUID that must be sent on the wire. */
export function resolveMessageTarget(
  db: AppDatabase,
  target: ExactMessageTarget,
  commitGuard?: DbCommitGuard,
): Promise<ResolvedMessageTarget | null> {
  return withDbTransaction(
    db,
    (context) => resolveMessageTargetWithinTransaction(context, target),
    commitGuard,
  );
}

/** Resolve the exact optimistic-unsend fence, including a target GUID promoted to its alias. */
export function resolvePendingUnsendTarget(
  db: AppDatabase,
  target: ExactMessageTarget,
  commitGuard?: DbCommitGuard,
): Promise<ResolvedMessageTarget | null> {
  return withDbTransaction(
    db,
    (context) =>
      runInTransactionContext(context, async (owner) => {
        if (!target.chatGuid || !target.messageGuid || !isBoundedPartIndex(target.partIndex)) {
          return null;
        }
        const rows = await owner.all<{
          guid: string;
          chatGuid: string;
          pendingPartIndex: number | null;
        }>(sql`
          SELECT m.guid, c.guid AS chatGuid,
                 m.pending_retraction_part_index AS pendingPartIndex
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
           WHERE c.guid = ${target.chatGuid}
             AND (m.guid = ${target.messageGuid}
              OR m.guid IN (
                   SELECT canonical_guid
                     FROM message_guid_aliases a
                    WHERE a.alias_guid = ${target.messageGuid}
                      AND a.chat_guid = c.guid
                 ))
             AND m.date_deleted IS NULL
           ORDER BY CASE WHEN m.guid = ${target.messageGuid} THEN 0 ELSE 1 END
           LIMIT 2
        `);
        if (rows.length !== 1) return null;
        const row = rows[0]!;
        if (row.chatGuid !== target.chatGuid) return null;
        if (row.pendingPartIndex !== target.partIndex) return null;
        return {
          messageGuid: row.guid,
          partIndex: target.partIndex,
          partKind: target.partKind,
          // The fence re-locates the row (possibly promoted to its alias); it does not re-check
          // part topology, so it must not claim that proof (review M056).
          basis: 'pending-unsend-fence',
        };
      }),
    commitGuard,
  );
}

export type QueuedMessageTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'target'; readonly messageGuid: string; readonly partIndex: number }
  | { readonly kind: 'invalid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse only the target identity from a durable outgoing payload; message content stays opaque. */
export function queuedMessageTarget(kind: string, payload: string): QueuedMessageTarget {
  if (kind !== 'text' && kind !== 'reaction' && kind !== 'attachment' && kind !== 'contact') {
    return { kind: 'none' };
  }

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value)) return { kind: 'invalid' };

  try {
    const target = explicitMessageTargetPart(value.selectedMessageGuid, value.partIndex);
    if (kind === 'reaction' && target == null) return { kind: 'invalid' };
    return target
      ? { kind: 'target', messageGuid: target.messageGuid, partIndex: target.partIndex }
      : { kind: 'none' };
  } catch {
    return { kind: 'invalid' };
  }
}
