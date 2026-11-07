/**
 * Outgoing identity handover (moved from outgoing.ts): settling proven-owner and legacy-identity
 * conflicts, and handing an optimistic outgoing row over to the server's message identity.
 */

import { and, eq, sql } from 'drizzle-orm';
import { messageDeletionLedger, messages, outgoingQueue } from '../schema';
import { type DbTransactionContext, runInTransactionContext } from '../transaction';
import {
  getTrustedMessageStateLedgersWithinTransaction,
  trustedMessageStateLedgerSql,
} from './messageState';
import {
  type AttemptOwnerSnapshot,
  MessageGuidAliasConflictError,
  recordMessageGuidAliasWithinTransaction,
} from './outgoingAttemptOwnership';
import { deletionRecordAppliesSql } from './chatVisibility';
import { type ExactOutgoingAttemptSuccess } from './outgoingTypes';

/**
 * Contain a confirmed exact success whose canonical identity conflicts with retained ownership.
 * The source bubble is independently proven before this helper is called. Never install the
 * disputed attempt GUID or alter the canonical/alias/ledger reservation.
 */
export function settleProvenExactOwnerConflictWithinTransaction(
  context: DbTransactionContext,
  owner: AttemptOwnerSnapshot,
  success: ExactOutgoingAttemptSuccess,
  stickyError: boolean,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(messages)
      .set({
        attemptOwnerPending: false,
        ...(stickyError ? {} : { sendState: 'sent' as const, error: 0, errorMessage: null }),
      })
      .where(
        and(
          eq(messages.guid, owner.guid),
          eq(messages.chatId, owner.chatId),
          eq(messages.attemptOwnerGeneration, owner.attemptOwnerGeneration),
        ),
      );
    if (!stickyError) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
    }
  });
}
/** Keep a confirmed legacy/private-API send from retrying when identity promotion is ambiguous. */
export function settleConfirmedLegacyIdentityConflictWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(messages)
      .set({
        sendState: 'sent',
        error: 0,
        errorMessage: null,
        activeSendAttemptGuid: null,
        attemptOwnerPending: false,
      })
      .where(eq(messages.guid, tempGuid));
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}
/** Check before mutating attempt ownership whether a temp-to-canonical handoff is ambiguous. */
export async function hasOutgoingIdentityHandoverConflictWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  realGuid: string,
  ownerChatGuid: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    if (tempGuid === realGuid) return false;
    const trustedLedgers = await getTrustedMessageStateLedgersWithinTransaction(context);
    const messageOwners: Array<{ guid: string; chatGuid: string }> = await db.all(sql`
      SELECT m.guid, c.guid AS chatGuid
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid IN (${tempGuid}, ${realGuid})
    `);
    if (messageOwners.some((owner) => owner.chatGuid !== ownerChatGuid)) return true;
    const messageOwnerByGuid = new Map(messageOwners.map((owner) => [owner.guid, owner.chatGuid]));
    const tombstones: Array<{ guid: string; chatGuid: string | null }> = await db.all(sql`
      SELECT guid, chat_guid AS chatGuid
        FROM message_deletion_ledger
       WHERE guid IN (${tempGuid}, ${realGuid})
      UNION ALL
      SELECT guid, chat_guid AS chatGuid FROM message_server_states
       WHERE guid = ${realGuid}
         AND ${trustedMessageStateLedgerSql('message_server_states', trustedLedgers)}
    `);
    for (const tombstone of tombstones) {
      if (tombstone.chatGuid != null && tombstone.chatGuid !== ownerChatGuid) {
        return true;
      }
      if (
        tombstone.chatGuid == null &&
        tombstone.guid === realGuid &&
        messageOwnerByGuid.get(realGuid) !== ownerChatGuid
      ) {
        return true;
      }
    }
    const aliases = await db.all<{ canonicalGuid: string; chatGuid: string | null }>(sql`
      SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${tempGuid}
       LIMIT 1
    `);
    const alias = aliases[0];
    if (
      alias &&
      (alias.canonicalGuid !== realGuid ||
        (alias.chatGuid != null && alias.chatGuid !== ownerChatGuid))
    ) {
      return true;
    }
    return false;
  });
}
/**
 * Record an optimistic temp GUID's canonical server identity and move durable deletion knowledge.
 *
 * Call only from an already-owned transaction, immediately before the message-row identity
 * update. Keeping the row's `date_deleted` is not enough: a later chat purge removes that row,
 * and `upsertMessages` consults this independent ledger by the NEW GUID before re-ingesting it.
 * The independent alias survives a later message purge; merge both deletion keys so a marker that
 * arrived under the real GUID also wins over an older temp marker.
 */
export async function handoverOutgoingIdentityWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  realGuid: string,
  ownerChatGuid: string,
): Promise<number | null> {
  return runInTransactionContext(context, async (db) => {
    if (tempGuid === realGuid) return null;
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        tempGuid,
        realGuid,
        ownerChatGuid,
      )
    ) {
      throw new MessageGuidAliasConflictError();
    }
    const tombstones: Array<{
      guid: string;
      dateDeleted: number;
      chatGuid: string | null;
    }> = await db.all(sql`
      SELECT guid, date_deleted AS dateDeleted, chat_guid AS chatGuid
        FROM message_deletion_ledger
       WHERE guid IN (${tempGuid}, ${realGuid})
    `);
    await recordMessageGuidAliasWithinTransaction(context, tempGuid, realGuid, ownerChatGuid);
    // Hiding inherited from the chat's deleted history is not a message deletion: an explicit chat
    // restore must still undo it, so it is not carried onto the real identity (review of M069).
    // A cancelled send's tombstone also has its own ledger record, read above.
    const messageTombstones: Array<{ dateDeleted: number }> = await db.all(sql`
      SELECT m.date_deleted AS dateDeleted
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${tempGuid}
         AND m.date_deleted IS NOT NULL
         AND c.guid = ${ownerChatGuid}
         AND m.date_deleted IS NOT c.history_deleted_at
    `);
    const dateDeleted = tombstones.reduce<number | null>(
      (latest, row) => (latest == null || row.dateDeleted > latest ? row.dateDeleted : latest),
      messageTombstones[0]?.dateDeleted ?? null,
    );
    const trustedLedgers = await getTrustedMessageStateLedgersWithinTransaction(context);
    const serverStates = await db.all<{ dateDeleted: number }>(sql`
      SELECT COALESCE(date_deleted, 0) AS dateDeleted FROM message_server_states
       WHERE guid = ${realGuid} AND chat_guid = ${ownerChatGuid} AND kind = 'deleted'
         AND ${trustedMessageStateLedgerSql('message_server_states', trustedLedgers)}
       LIMIT 1
    `);
    const serverDate = serverStates[0]?.dateDeleted ?? null;
    // Server deletion knowledge affects visibility but never becomes a permanent local receipt.
    if (dateDeleted == null) {
      if (serverDate != null)
        await db
          .update(messages)
          .set({ dateDeleted: serverDate })
          .where(eq(messages.guid, tempGuid));
      return serverDate;
    }

    await db
      .insert(messageDeletionLedger)
      .values({ guid: realGuid, dateDeleted, chatGuid: ownerChatGuid })
      .onConflictDoUpdate({
        target: messageDeletionLedger.guid,
        setWhere: sql`${messageDeletionLedger.chatGuid} IS NULL OR ${messageDeletionLedger.chatGuid} = excluded.chat_guid`,
        set: {
          dateDeleted: sql`MAX(${messageDeletionLedger.dateDeleted}, excluded.date_deleted)`,
          chatGuid: sql`COALESCE(${messageDeletionLedger.chatGuid}, excluded.chat_guid)`,
        },
      });
    await db
      .update(messages)
      .set({
        dateDeleted: sql`COALESCE(MAX(${messages.dateDeleted}, ${dateDeleted}), ${messages.dateDeleted}, ${dateDeleted})`,
      })
      .where(eq(messages.guid, tempGuid));
    await db.run(sql`
      DELETE FROM message_deletion_ledger
       WHERE guid = ${tempGuid}
         AND ${deletionRecordAppliesSql('message_deletion_ledger', ownerChatGuid)}
    `);
    return serverDate == null ? dateDeleted : Math.max(dateDeleted, serverDate);
  });
}
