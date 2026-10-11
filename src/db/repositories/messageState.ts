import { eq, sql } from 'drizzle-orm';
import {
  MessageStateAuthority,
  compareMessageStateSequence,
  type MessageStateChanged,
} from '@core/models/messageState';
import { kv, messageServerStates } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { AppDatabase } from '../types';
import { kvGet, kvGetWithinTransaction, kvSetWithinTransaction } from './kv';
import type { FullRepairMessageExposure } from './repair';

export const MESSAGE_STATE_AUTHORITY_KEY = 'sync.messageState.imessage';
/** Progress of checking messages that were already on the phone when a checkpoint installed. */
export const MESSAGE_STATE_AUDIT_KEY = 'sync.messageState.imessage.audit';
/** When an automatic provider repair may next run after a failure, for one provider pairing. */
export const PROVIDER_REPAIR_BACKOFF_KEY = 'sync.messageState.imessage.repairBackoff';

function parseAuthority(raw: string | null): MessageStateAuthority | null {
  if (raw == null) return null;
  try {
    const parsed = MessageStateAuthority.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getMessageStateAuthority(
  db: AppDatabase,
): Promise<MessageStateAuthority | null> {
  return parseAuthority(await kvGet(db, MESSAGE_STATE_AUTHORITY_KEY));
}

export async function getMessageStateAuthorityWithinTransaction(
  context: DbTransactionContext,
): Promise<MessageStateAuthority | null> {
  return runInTransactionContext(context, async () =>
    parseAuthority(await kvGetWithinTransaction(context, MESSAGE_STATE_AUTHORITY_KEY)),
  );
}

export async function setMessageStateAuthorityWithinTransaction(
  context: DbTransactionContext,
  authority: MessageStateAuthority,
): Promise<void> {
  return runInTransactionContext(context, async () => {
    await kvSetWithinTransaction(
      context,
      MESSAGE_STATE_AUTHORITY_KEY,
      JSON.stringify(MessageStateAuthority.parse(authority)),
    );
  });
}

export interface ProviderRepairBackoff {
  readonly version: 1;
  readonly providerEpoch: string;
  /** Consecutive failed repairs for this pairing; resets on success or a new pairing. */
  readonly failures: number;
  readonly nextAttemptAt: number;
}

function parseProviderRepairBackoff(raw: string | null): ProviderRepairBackoff | null {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProviderRepairBackoff> | null;
    return value?.version === 1 &&
      typeof value.providerEpoch === 'string' &&
      Number.isSafeInteger(value.failures) &&
      (value.failures ?? 0) > 0 &&
      Number.isSafeInteger(value.nextAttemptAt)
      ? (value as ProviderRepairBackoff)
      : null;
  } catch {
    return null;
  }
}

export async function getProviderRepairBackoff(
  db: AppDatabase,
): Promise<ProviderRepairBackoff | null> {
  return parseProviderRepairBackoff(await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY));
}

/** Count one more failed repair for this pairing and persist when the next one may run. */
export async function recordProviderRepairFailureWithinTransaction(
  context: DbTransactionContext,
  providerEpoch: string,
  nextAttemptAt: (failures: number) => number,
): Promise<void> {
  return runInTransactionContext(context, async () => {
    const previous = parseProviderRepairBackoff(
      await kvGetWithinTransaction(context, PROVIDER_REPAIR_BACKOFF_KEY),
    );
    const failures = previous?.providerEpoch === providerEpoch ? previous.failures + 1 : 1;
    const backoff: ProviderRepairBackoff = {
      version: 1,
      providerEpoch,
      failures,
      nextAttemptAt: nextAttemptAt(failures),
    };
    await kvSetWithinTransaction(context, PROVIDER_REPAIR_BACKOFF_KEY, JSON.stringify(backoff));
  });
}

/** A finished repair ends any wait; called in the transaction that installs its authority. */
export async function clearProviderRepairBackoffWithinTransaction(
  context: DbTransactionContext,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db.delete(kv).where(eq(kv.key, PROVIDER_REPAIR_BACKOFF_KEY));
  });
}

export interface MessageStateAudit {
  readonly version: 1;
  readonly providerEpoch: string;
  readonly ledgerEpoch: string;
  /** The checkpoint the authority was installed at; a check never stamps an older position. */
  readonly snapshotSequence: string;
  /** First recheck retained deletions (older ledger, or this ledger before the checkpoint). */
  readonly phase: 'restore' | 'hide';
  readonly afterGuid: string | null;
  readonly afterMessageId: number;
  /** Messages above this id arrived after the checkpoint, so they were active when fetched. */
  readonly throughMessageId: number;
}

/** Record which messages still need a server check, or clear the record with null. */
export async function setMessageStateAuditWithinTransaction(
  context: DbTransactionContext,
  audit: MessageStateAudit | null,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (audit)
      await kvSetWithinTransaction(context, MESSAGE_STATE_AUDIT_KEY, JSON.stringify(audit));
    else await db.delete(kv).where(eq(kv.key, MESSAGE_STATE_AUDIT_KEY));
  });
}

/**
 * Install a ledger-checkpoint authority and end any repair wait. Messages already on the phone,
 * and deletions retained from before the checkpoint (an older ledger, or this one before a
 * re-setup), are recorded for a later server check; nothing is hidden or restored here.
 */
export async function installCheckpointAuthorityWithinTransaction(
  context: DbTransactionContext,
  authority: MessageStateAuthority,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const checkpoint = authority.snapshotSequence;
    const scope = (
      await db.all<{ retained: number; visibleApple: number; throughMessageId: number }>(sql`
        SELECT EXISTS (SELECT 1 FROM message_server_states
                        WHERE provider_epoch != ${authority.providerEpoch}
                           OR ledger_epoch != ${authority.ledgerEpoch}
                           OR (kind = 'deleted'
                               AND (length(sequence) < length(${checkpoint})
                                    OR (length(sequence) = length(${checkpoint})
                                        AND sequence < ${checkpoint})))) AS retained,
               EXISTS (SELECT 1 FROM messages
                        WHERE date_deleted IS NULL
                          AND guid NOT LIKE 'temp-%'
                          AND guid NOT LIKE 'rcs-%') AS visibleApple,
               COALESCE((SELECT MAX(id) FROM messages), 0) AS throughMessageId
      `)
    )[0];
    await setMessageStateAuthorityWithinTransaction(context, authority);
    await clearProviderRepairBackoffWithinTransaction(context);
    await setMessageStateAuditWithinTransaction(
      context,
      scope && (scope.retained || scope.visibleApple)
        ? {
            version: 1,
            providerEpoch: authority.providerEpoch,
            ledgerEpoch: authority.ledgerEpoch,
            snapshotSequence: checkpoint,
            phase: scope.retained ? 'restore' : 'hide',
            afterGuid: null,
            afterMessageId: 0,
            throughMessageId: scope.throughMessageId,
          }
        : null,
    );
  });
}

/** Eviction does not release an exact owner retained by local deletion or outgoing promotion. */
async function hasRetainedMessageOwnerConflictWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  chatGuid: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    // Unknown local owners remain independently quarantined; this check never adopts or rewrites them.
    if (chatGuid == null) return false;
    const conflicts = await db.all<{ conflict: number }>(sql`
      SELECT 1 AS conflict FROM message_deletion_ledger
       WHERE guid = ${guid} AND chat_guid IS NOT NULL AND chat_guid != ${chatGuid}
      UNION ALL
      SELECT 1 AS conflict FROM message_guid_aliases
       WHERE canonical_guid = ${guid} AND chat_guid IS NOT NULL AND chat_guid != ${chatGuid}
      LIMIT 1
    `);
    return conflicts.length > 0;
  });
}

/** Recompute only an exact owner. Local message receipts and chat-history boundaries always win. */
export async function projectMessageStateWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  chatGuid: string,
  snapshotAuthority?: MessageStateAuthority,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const authority =
      snapshotAuthority ?? (await getMessageStateAuthorityWithinTransaction(context));
    await db.run(sql`
      UPDATE messages SET date_deleted = (
        SELECT MAX(value) FROM (
          SELECT date_deleted AS value FROM message_deletion_ledger
           WHERE guid = ${guid} AND (chat_guid = ${chatGuid} OR chat_guid IS NULL)
          UNION ALL
          SELECT COALESCE(date_deleted, 0) FROM message_server_states
           WHERE guid = ${guid} AND chat_guid = ${chatGuid} AND kind = 'deleted'
             AND provider_epoch = ${authority?.providerEpoch ?? null} AND ledger_epoch = ${authority?.ledgerEpoch ?? null}
          UNION ALL
          SELECT history_deleted_at FROM chats
           WHERE guid = ${chatGuid} AND history_deleted_at IS NOT NULL
             AND (messages.date_created IS NULL OR messages.date_created <= history_deleted_at)
        )
      ) WHERE guid = ${guid} AND chat_id = (SELECT id FROM chats WHERE guid = ${chatGuid})
    `);
    await db.run(sql`
      UPDATE chats SET latest_message_date = COALESCE(
        (SELECT MAX(date_created) FROM messages WHERE chat_id = chats.id AND date_deleted IS NULL AND associated_message_type IS NULL),
        (SELECT MAX(date_created) FROM messages WHERE chat_id = chats.id AND date_deleted IS NULL)
      ) WHERE guid = ${chatGuid}
    `);
  });
}

/** Snapshot absence hides the captured row without manufacturing a permanent user deletion. */
export async function hideSnapshotMessagesWithinTransaction(
  context: DbTransactionContext,
  rows: ReadonlyArray<FullRepairMessageExposure & { chatGuid: string }>,
  authority: MessageStateAuthority,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (rows.length > 25) throw new Error('Snapshot absence batch exceeds its bound.');
    for (const row of rows) {
      const prior = (
        await db.select().from(messageServerStates).where(eq(messageServerStates.guid, row.guid))
      )[0];
      if (
        prior?.providerEpoch === authority.providerEpoch &&
        prior.ledgerEpoch === authority.ledgerEpoch &&
        compareMessageStateSequence(prior.sequence, authority.snapshotSequence) > 0
      )
        continue;
      const eligible = await db.all<{ guid: string }>(sql`
        SELECT messages.guid FROM messages JOIN chats ON chats.id = messages.chat_id
         WHERE messages.id = ${row.id} AND messages.guid = ${row.guid} AND messages.chat_id = ${row.chatId}
           AND chats.guid = ${row.chatGuid} AND messages.original_row_id IS ${row.originalRowId}
           AND messages.date_created IS ${row.dateCreated} AND messages.date_deleted IS NULL
           AND (messages.send_state IS NULL OR messages.send_state = 'sent')
           AND NOT EXISTS (SELECT 1 FROM outgoing_queue WHERE temp_guid = messages.guid OR temp_guid IN (
             SELECT alias_guid FROM message_guid_aliases WHERE canonical_guid = messages.guid
           ))
           AND NOT EXISTS (SELECT 1 FROM reminders WHERE message_guid = messages.guid)
         LIMIT 1
      `);
      if (eligible.length === 0) continue;
      await db
        .insert(messageServerStates)
        .values({
          guid: row.guid,
          chatGuid: row.chatGuid,
          providerEpoch: authority.providerEpoch,
          ledgerEpoch: authority.ledgerEpoch,
          sequence: authority.snapshotSequence,
          kind: 'deleted',
          dateDeleted: 0,
        })
        .onConflictDoUpdate({
          target: messageServerStates.guid,
          set: {
            chatGuid: row.chatGuid,
            providerEpoch: authority.providerEpoch,
            ledgerEpoch: authority.ledgerEpoch,
            sequence: authority.snapshotSequence,
            kind: 'deleted',
            dateDeleted: 0,
          },
        });
      await projectMessageStateWithinTransaction(context, row.guid, row.chatGuid, authority);
    }
  });
}

/** Apply one sequence without advancing the REST cursor (also used by realtime delivery). */
export async function applyMessageStateWithinTransaction(
  context: DbTransactionContext,
  event: MessageStateChanged,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const authority = await getMessageStateAuthorityWithinTransaction(context);
    if (
      !authority ||
      authority.providerEpoch !== event.providerEpoch ||
      authority.ledgerEpoch !== event.ledgerEpoch ||
      compareMessageStateSequence(event.sequence, authority.snapshotSequence) <= 0
    )
      return false;
    const prior = (
      await db.select().from(messageServerStates).where(eq(messageServerStates.guid, event.guid))
    )[0];
    if (
      prior &&
      prior.providerEpoch === event.providerEpoch &&
      prior.ledgerEpoch === event.ledgerEpoch &&
      compareMessageStateSequence(event.sequence, prior.sequence) <= 0
    )
      return false;
    const owners = await db.all<{ chatGuid: string }>(sql`
      SELECT chats.guid AS chatGuid FROM messages JOIN chats ON chats.id = messages.chat_id WHERE messages.guid = ${event.guid} LIMIT 1
    `);
    const localOwner = owners[0]?.chatGuid;
    const owner = event.chatGuid ?? localOwner ?? prior?.chatGuid ?? null;
    if ((localOwner && owner !== localOwner) || (prior?.chatGuid && owner !== prior.chatGuid))
      return false;
    if (await hasRetainedMessageOwnerConflictWithinTransaction(context, event.guid, owner))
      return false;
    // Ownerless observations remain quarantined and cannot hide an unrelated future claimant.
    await db
      .insert(messageServerStates)
      .values({
        guid: event.guid,
        chatGuid: owner,
        providerEpoch: event.providerEpoch,
        ledgerEpoch: event.ledgerEpoch,
        sequence: event.sequence,
        kind: event.kind,
        dateDeleted: event.dateDeleted,
      })
      .onConflictDoUpdate({
        target: messageServerStates.guid,
        set: {
          chatGuid: owner,
          providerEpoch: event.providerEpoch,
          ledgerEpoch: event.ledgerEpoch,
          sequence: event.sequence,
          kind: event.kind,
          dateDeleted: event.dateDeleted,
        },
      });
    if (owner) await projectMessageStateWithinTransaction(context, event.guid, owner);
    return localOwner != null;
  });
}

/** Exact active hydration may supply a missing owner, but cannot change an ordered transition. */
export async function bindHydratedMessageOwnerWithinTransaction(
  context: DbTransactionContext,
  event: MessageStateChanged,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const authority = await getMessageStateAuthorityWithinTransaction(context);
    if (
      event.kind !== 'restored' ||
      event.dateDeleted !== null ||
      event.chatGuid == null ||
      !authority ||
      authority.providerEpoch !== event.providerEpoch ||
      authority.ledgerEpoch !== event.ledgerEpoch ||
      compareMessageStateSequence(event.sequence, authority.snapshotSequence) <= 0
    )
      throw new Error('Message-state authority changed during restore hydration.');
    const localOwners = await db.all<{ chatGuid: string }>(sql`
      SELECT c.guid AS chatGuid FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${event.guid} LIMIT 1
    `);
    if (localOwners[0] && localOwners[0].chatGuid !== event.chatGuid)
      throw new Error('Restored message owner conflicts with local history.');
    if (await hasRetainedMessageOwnerConflictWithinTransaction(context, event.guid, event.chatGuid))
      throw new Error('Restored message owner conflicts with retained history.');
    const prior = await db.all<{ chatGuid: string | null; sequence: string; kind: string }>(sql`
      SELECT chat_guid AS chatGuid, sequence, kind FROM message_server_states
       WHERE guid = ${event.guid} AND provider_epoch = ${event.providerEpoch}
         AND ledger_epoch = ${event.ledgerEpoch} LIMIT 1
    `);
    if (prior[0]?.chatGuid != null && prior[0].chatGuid !== event.chatGuid)
      throw new Error('Restored message owner conflicts with retained state.');
    if (prior[0]?.sequence === event.sequence && prior[0].kind !== event.kind)
      throw new Error('Restored message conflicts with an existing transition.');
    // A newer deletion can arrive during the request. Bind its exact owner while retaining its
    // sequence, kind, and date, so the following upsert is born hidden instead of losing that delete.
    await db.run(sql`
      UPDATE message_server_states SET chat_guid = ${event.chatGuid}
       WHERE guid = ${event.guid} AND chat_guid IS NULL
         AND provider_epoch = ${event.providerEpoch} AND ledger_epoch = ${event.ledgerEpoch}
    `);
  });
}

/** A finished, provider-scoped snapshot is positive restoration evidence for these exact owners. */
export async function restoreSnapshotMessagesWithinTransaction(
  context: DbTransactionContext,
  rows: ReadonlyArray<{ guid: string; chatGuid: string }>,
  authority: MessageStateAuthority,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (rows.length > 25) throw new Error('Snapshot restoration batch exceeds its bound.');
    for (const row of rows) {
      const changed = await db.all<{ guid: string }>(sql`
        UPDATE message_server_states SET kind = 'restored', date_deleted = NULL,
          provider_epoch = ${authority.providerEpoch}, ledger_epoch = ${authority.ledgerEpoch}, sequence = ${authority.snapshotSequence}
        WHERE guid = ${row.guid} AND chat_guid = ${row.chatGuid}
          AND NOT (provider_epoch = ${authority.providerEpoch} AND ledger_epoch = ${authority.ledgerEpoch}
            AND (length(sequence) > length(${authority.snapshotSequence}) OR
              (length(sequence) = length(${authority.snapshotSequence}) AND sequence > ${authority.snapshotSequence})))
        RETURNING guid
      `);
      if (changed.length > 0)
        await projectMessageStateWithinTransaction(context, row.guid, row.chatGuid, authority);
    }
  });
}

/** Bind only a server-owned ownerless receipt using an active snapshot page's exact route owner. */
export async function bindSnapshotMessageOwnersWithinTransaction(
  context: DbTransactionContext,
  rows: ReadonlyArray<{ guid: string; chatGuid: string }>,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (rows.length > 25) throw new Error('Snapshot ownership batch exceeds its bound.');
    for (const row of rows) {
      if (await hasRetainedMessageOwnerConflictWithinTransaction(context, row.guid, row.chatGuid))
        throw new Error('Snapshot message owner conflicts with retained history.');
      await db.run(
        sql`UPDATE message_server_states SET chat_guid = ${row.chatGuid} WHERE guid = ${row.guid} AND chat_guid IS NULL`,
      );
    }
  });
}

/** Retire a replaced provider/ledger namespace in bounded owners after snapshot finish. */
export async function rebaseOldMessageStateBatchWithinTransaction(
  context: DbTransactionContext,
  afterGuid: string | null,
  present: ReadonlyMap<string, { chatGuid: string }>,
  authority: MessageStateAuthority,
): Promise<string | null> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<{
      guid: string;
      chatGuid: string | null;
      localOwner: string | null;
      kind: string;
      dateDeleted: number | null;
    }>(sql`
      SELECT s.guid, s.chat_guid AS chatGuid, c.guid AS localOwner, s.kind, s.date_deleted AS dateDeleted FROM message_server_states s
        LEFT JOIN messages m ON m.guid = s.guid LEFT JOIN chats c ON c.id = m.chat_id
       WHERE (s.provider_epoch != ${authority.providerEpoch} OR s.ledger_epoch != ${authority.ledgerEpoch})
         AND (${afterGuid} IS NULL OR s.guid > ${afterGuid}) ORDER BY s.guid LIMIT 25
    `);
    for (const row of rows) {
      if (!row.chatGuid || !row.localOwner || row.chatGuid !== row.localOwner) {
        await db.delete(messageServerStates).where(eq(messageServerStates.guid, row.guid));
        continue;
      }
      const restored = present.get(row.guid)?.chatGuid === row.chatGuid;
      await db
        .update(messageServerStates)
        .set({
          providerEpoch: authority.providerEpoch,
          ledgerEpoch: authority.ledgerEpoch,
          sequence: authority.snapshotSequence,
          // Absence changes remain owned by the separately captured eligibility set. Merely
          // changing epoch must not hide a restored row retained for a draft, send, or reminder.
          kind: restored ? 'restored' : row.kind,
          dateDeleted: restored ? null : row.dateDeleted,
        })
        .where(eq(messageServerStates.guid, row.guid));
      await projectMessageStateWithinTransaction(context, row.guid, row.chatGuid, authority);
    }
    return rows.at(-1)?.guid ?? null;
  });
}
