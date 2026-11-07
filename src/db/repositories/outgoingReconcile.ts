/**
 * Outgoing success and acknowledgement reconciliation (moved from outgoing.ts): settling a server
 * success, a no-guid send or an attempt acknowledgement onto the exact outgoing attempt.
 */

import { eq, sql } from 'drizzle-orm';
import { messageDeletionLedger, messages, outgoingQueue } from '../schema';
import {
  type DbCommitGuard,
  type DbTransactionContext,
  runInTransactionContext,
  withDbTransaction,
} from '../transaction';
import type { ReadDb } from '../types';
import { projectMessageStateWithinTransaction } from './messageState';
import {
  findAttemptOwnerSnapshotWithinTransaction,
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  recordMessageGuidAliasWithinTransaction,
  type SendAttemptOwnerToken,
} from './outgoingAttemptOwnership';
import {
  handoverOutgoingIdentityWithinTransaction,
  hasOutgoingIdentityHandoverConflictWithinTransaction,
  settleConfirmedLegacyIdentityConflictWithinTransaction,
  settleProvenExactOwnerConflictWithinTransaction,
} from './outgoingIdentity';
import {
  type ExactOutgoingAttemptSuccess,
  type ExactOutgoingAttemptSuccessDisposition,
} from './outgoingTypes';

/** Server identity installed when the exact local request generation acknowledges. */
export interface OutgoingAttemptSettlement {
  readonly attemptGuid: string;
  readonly attemptOwnerToken: SendAttemptOwnerToken;
}
export type OutgoingAckDisposition = 'sent' | 'sticky-error' | 'stale-attempt-owner' | 'missing';
/** Server fields used to promote an optimistic message to its real identity. */
export interface ServerMsgFields {
  /**
   * The real server GUID. ABSENT on the AppleScript send path (the helper isn't
   * connected, so the server can't ack a GUID) — callers MUST NOT invoke this with an
   * undefined guid; instead they call `markOutgoingSentNoGuid`, and the live socket
   * `new-message` echo reconciles the optimistic row by CONTENT (`reconcileEchoByContent`,
   * since Gator's echo carries no tempGuid). The guard below is a belt-and-braces backstop.
   */
  guid: string;
  dateCreated: number | null;
  dateDelivered: number | null;
}
/**
 * Reconcile a successful send. If the real message already exists (the socket
 * echo landed first via DbEventSink), drop the temp row; otherwise promote the
 * temp row to the real guid in place. Either way, no duplicate (guid is unique).
 *
 * A send the user CANCELLED needs no branch of its own: the discard left a TOMBSTONED temp row
 * (see the rule at the top of this file), the promote below carries both `date_deleted` and its
 * independent deletion-ledger key onto the real identity, so the message stays hidden through a
 * later re-page or purge/re-ingestion. The dup branch has to move it by hand — that is the one place
 * the temp row is destroyed rather than promoted.
 *
 * The promote (or dup-drop) and the queue-row delete commit in ONE transaction. As two
 * autocommits, a process death in the gap left an orphan queue row whose temp_guid no longer
 * names any message: after the grace window the drain re-POSTs that payload, and once the
 * server's idempotency TTL has lapsed (an overnight kill) the recipient gets the message twice,
 * with no local bubble for the second copy until its echo inserts one. Same reasoning as
 * `DbEventSink`, which reconciles inside its own transaction for exactly this pair of writes.
 */
export async function reconcileOutgoingSuccess(
  db: ReadDb,
  tempGuid: string,
  server: ServerMsgFields,
  commitGuard?: DbCommitGuard,
  expectedChatGuid?: string,
): Promise<void> {
  // Preserve the standalone helper's exact historical backstops before it opens an owner. A false
  // guard must not turn an invalid empty-GUID input from a quiet no-op into a rejection.
  if (!server.guid) return;
  if (server.guid === tempGuid) {
    await withDbTransaction(
      db,
      (db, context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid),
      commitGuard,
    );
    return;
  }
  await withDbTransaction(
    db,
    (db, context) =>
      reconcileOutgoingSuccessWithinTransaction(context, tempGuid, server, expectedChatGuid),
    commitGuard,
  );
}
/**
 * Transaction-only body for one successful-send identity handoff.
 *
 * The shared send-outcome service uses this form so its account lease guards the exact final
 * promotion/dequeue owner. Standalone repository callers must use {@link reconcileOutgoingSuccess}
 * so the identity handoff and queue-row removal cannot split across commits.
 */
export function reconcileOutgoingSuccessWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  server: ServerMsgFields,
  expectedChatGuid?: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    // Backstop transaction-context callers too: only a distinct server identity belongs in this
    // body. The public wrapper and shared send-outcome service route absent/self GUIDs through the
    // no-GUID settlement instead.
    if (!server.guid || server.guid === tempGuid) return;
    const dup = await db.all<{ id: number; chatGuid: string }>(
      sql`SELECT m.id, c.guid AS chatGuid
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
           WHERE m.guid = ${server.guid}
           LIMIT 1`,
    );
    const tempOwner = await db.all<{ chatId: number; chatGuid: string }>(sql`
      SELECT m.chat_id AS chatId, c.guid AS chatGuid
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${tempGuid}
       LIMIT 1
    `);
    const queuedOwner = await db.all<{ chatGuid: string }>(sql`
      SELECT chat_guid AS chatGuid
        FROM outgoing_queue
       WHERE temp_guid = ${tempGuid}
       LIMIT 1
    `);
    const retainedAliases = await db.all<{
      canonicalGuid: string;
      chatGuid: string | null;
    }>(sql`
      SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${tempGuid}
       LIMIT 1
    `);
    const retainedAlias = retainedAliases[0];
    const aliasCanonicalConflict =
      retainedAlias != null && retainedAlias.canonicalGuid !== server.guid;
    const tempChatGuid = tempOwner[0]?.chatGuid ?? null;
    const queuedChatGuid = queuedOwner[0]?.chatGuid ?? null;
    const independentlyProvenOwners = [
      tempChatGuid,
      queuedChatGuid,
      expectedChatGuid ?? null,
    ].filter((value): value is string => value != null);
    if (retainedAlias?.chatGuid == null && independentlyProvenOwners.length === 0) {
      // No source row/queue/expected chat remains to settle. Preserve the quarantine and treat the
      // confirmed response as terminal instead of turning it into a retryable transport failure.
      return;
    }
    const sourceOwners = [retainedAlias?.chatGuid ?? null, ...independentlyProvenOwners].filter(
      (value): value is string => value != null,
    );
    const distinctSourceOwners = new Set(sourceOwners);
    const sourceOwnersConflict = distinctSourceOwners.size > 1;
    const sourceChatGuid = sourceOwners[0] ?? null;
    const canonicalOwnerConflict = dup[0] != null && sourceChatGuid !== dup[0].chatGuid;
    if (
      aliasCanonicalConflict ||
      sourceOwnersConflict ||
      sourceChatGuid == null ||
      canonicalOwnerConflict
    ) {
      // The server confirmed this send, but its canonical GUID either belongs to another exact
      // conversation or the source evidence disagrees. Never guess from a GUID alone: keep the
      // foreign canonical row/ledger untouched. When the source bubble still exists, settle it
      // under its temp identity; dequeue any surviving request so a confirmed send is not retried.
      // A purged, cancelled send retains its temp ledger marker without a cross-chat alias.
      await settleConfirmedLegacyIdentityConflictWithinTransaction(context, tempGuid);
      return;
    }
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      )
    ) {
      // A server-confirmed physical send must not be retried merely because the canonical GUID is
      // reserved by a scoped/ownerless deletion. Preserve that reservation and settle only source.
      await settleConfirmedLegacyIdentityConflictWithinTransaction(context, tempGuid);
      return;
    }
    if (dup[0]) {
      // The live echo already inserted the real message (it beat this ack, and content-match
      // didn't promote our temp row — e.g. an edge where the text differs). Carry any on-disk
      // local_path from the temp row's attachment onto the real row's attachment BEFORE the
      // cascade-delete, so a just-sent image isn't lost to a re-download. (One attachment per
      // outgoing message in this app.)
      const tempAtt = await db.all<{ localPath: string | null }>(
        sql`SELECT ta.local_path AS localPath FROM attachments ta
              JOIN messages tm ON tm.id = ta.message_id
              WHERE tm.guid = ${tempGuid} AND ta.local_path IS NOT NULL LIMIT 1`,
      );
      const lp = tempAtt[0]?.localPath;
      if (lp) {
        // db.run (not db.all) — a non-returning UPDATE; db.all throws "use run()" on better-sqlite3.
        await db.run(
          sql`UPDATE attachments SET local_path = ${lp} WHERE message_id = ${dup[0].id} AND local_path IS NULL`,
        );
      }
      // Carry a local DELETION across too. This is the ONE path that destroys the temp row instead
      // of promoting it, and the row may already be gone after a chat purge. Move the durable
      // ledger key first, then tombstone the real row from that retained timestamp.
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      );
      // A live/content echo can materialize the canonical row before the HTTP acknowledgement.
      // Carry the temp row's attempt-owner state onto that canonical row before deleting it; a
      // later RCS acknowledgement can then resolve the alias and install the exact attempt id.
      const tempOwnership = await db.all<{
        activeSendAttemptGuid: string | null;
        attemptOwnerPending: number;
        attemptOwnerGeneration: number;
      }>(sql`
        SELECT active_send_attempt_guid AS activeSendAttemptGuid,
               attempt_owner_pending AS attemptOwnerPending,
               attempt_owner_generation AS attemptOwnerGeneration
          FROM messages
         WHERE guid = ${tempGuid}
         LIMIT 1
      `);
      const ownership = tempOwnership[0];
      if (ownership) {
        await db
          .update(messages)
          .set({
            activeSendAttemptGuid: ownership.activeSendAttemptGuid,
            attemptOwnerPending: ownership.attemptOwnerPending !== 0,
            attemptOwnerGeneration: ownership.attemptOwnerGeneration,
          })
          .where(eq(messages.guid, server.guid));
      }
      if (dateDeleted != null)
        await projectMessageStateWithinTransaction(context, server.guid, sourceChatGuid);
      await db.delete(messages).where(eq(messages.guid, tempGuid));
    } else if (tempOwner[0]) {
      await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      );
      await db
        .update(messages)
        .set({
          guid: server.guid,
          dateCreated: server.dateCreated ?? undefined,
          dateDelivered: server.dateDelivered ?? null,
          isFromMe: true,
          sendState: 'sent',
          error: 0,
          errorMessage: null,
          activeSendAttemptGuid: null,
          attemptOwnerPending: false,
        })
        .where(eq(messages.guid, tempGuid));
    } else {
      // A chat purge can remove both the optimistic row and its queue while the HTTP request is
      // still in flight. The active request's exact chat GUID is then the only surviving ownership
      // proof. Materialize a minimal canonical row under that owner before moving an alias or
      // deletion marker. A later echo in the same chat safely hydrates it; a conflicting provider
      // or phone-number chat is rejected by immutable message ownership instead of inheriting the
      // deleted send's ledger entry.
      const sourceChat = await db.all<{ id: number }>(sql`
        SELECT id
          FROM chats
         WHERE guid = ${sourceChatGuid}
         LIMIT 1
      `);
      const sourceChatId = sourceChat[0]?.id;
      if (sourceChatId == null) {
        if (queuedOwner[0]) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        }
        return;
      }
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      );
      await db.insert(messages).values({
        guid: server.guid,
        chatId: sourceChatId,
        isFromMe: true,
        dateCreated: server.dateCreated,
        dateDelivered: server.dateDelivered,
        dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: null,
        attemptOwnerPending: false,
      });
    }
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}
export function markOutgoingSentNoGuidWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  settlement?: OutgoingAttemptSettlement,
): Promise<OutgoingAckDisposition> {
  return runInTransactionContext(context, async (db) => {
    const owner = await findAttemptOwnerSnapshotWithinTransaction(context, tempGuid);
    if (!owner) {
      // Preserve the historical orphan cleanup: a successful request must not be blindly re-sent
      // merely because its optimistic bubble was purged before the acknowledgement committed.
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'missing';
    }

    if (settlement) {
      const tokenMatchesPending =
        owner.attemptOwnerPending !== 0 &&
        owner.attemptOwnerGeneration === settlement.attemptOwnerToken.generation;
      const alreadyInstalled =
        owner.attemptOwnerPending === 0 && owner.activeSendAttemptGuid === settlement.attemptGuid;
      if (!tokenMatchesPending && !alreadyInstalled) return 'stale-attempt-owner';
      if (tokenMatchesPending) {
        // The generation check is the durable compare-and-set. In particular, acknowledgement A
        // cannot install itself after retry B increments the row, even if A waited for the DB lock.
        const installed = await db.all<{ id: number }>(sql`
          UPDATE messages
             SET active_send_attempt_guid = ${settlement.attemptGuid},
                 attempt_owner_pending = 0
           WHERE guid = ${owner.guid}
             AND attempt_owner_pending = 1
             AND attempt_owner_generation = ${settlement.attemptOwnerToken.generation}
          RETURNING id
        `);
        if (installed.length === 0) return 'stale-attempt-owner';
      }
    } else if (
      owner.attemptOwnerGeneration !== 0 ||
      owner.attemptOwnerPending !== 0 ||
      owner.activeSendAttemptGuid != null
    ) {
      // A legacy/no-token acknowledgement may settle only a row born in legacy mode. Silently
      // downgrading a modern row would allow a delayed failure from an older retry to own it.
      return 'stale-attempt-owner';
    }

    // Never downgrade a row the server already told us FAILED. With the RCS bridge's immediate
    // "sending" ack, a genuine send failure (`message-send-error`) can land just BEFORE this
    // success ack; promoting to 'sent' would clobber it and hide the failure. 'error' is sticky —
    // leave the errored row (and its retry-queue entry) exactly as reconcileOutgoingError set them.
    //
    // The guard is IN the write: as a separate SELECT it answered for an instant that had already
    // passed by the time the UPDATE ran, so an error frame landing between the two was overwritten
    // and the message showed as sent with no error badge and no retry row — silently never
    // delivered. Same shape as `retireOutgoing` / `claimOutgoingForSend`.
    const promoted = await db.all<{ id: number }>(sql`
      UPDATE messages
         SET send_state = 'sent', error = 0, error_message = NULL
       WHERE guid = ${owner.guid} AND (send_state IS NULL OR send_state <> 'error')
      RETURNING id`);
    if (promoted.length > 0) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'sent';
    }
    // Ownership installation is independent from the sticky visible failure. A server error that
    // won the race remains visible and keeps its retry ladder, but subsequent exact events can now
    // be classified against the installed attempt.
    return 'sticky-error';
  });
}
/**
 * Reconcile the exact capable-RCS success triple while the caller owns the event transaction.
 * The client generation fences the unresolved request window; after ownership is settled, the
 * server attempt GUID is authoritative so an idempotency replay may safely echo an older client
 * generation. Exact payloads never fall through to heuristic content matching.
 */
function reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(
  context: DbTransactionContext,
  success: ExactOutgoingAttemptSuccess,
  preservePendingError: boolean,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return runInTransactionContext(context, async (db) => {
    if (
      !success.tempGuid ||
      !success.attemptGuid ||
      !success.guid ||
      !Number.isInteger(success.clientAttemptGeneration) ||
      success.clientAttemptGeneration < 1 ||
      success.clientAttemptGeneration > MAX_SEND_ATTEMPT_OWNER_GENERATION
    ) {
      return 'unmatched';
    }

    const owner = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      success.tempGuid,
      success.guid,
    );
    if (!owner) {
      if (success.claimedChatId == null) {
        const blockedAliases = await db.all<{ aliasGuid: string }>(sql`
          SELECT alias_guid AS aliasGuid
            FROM message_guid_aliases
           WHERE alias_guid = ${success.tempGuid}
           LIMIT 1
        `);
        if (!blockedAliases[0]) return 'unmatched';
        // The exact event proves that this temp request reached a terminal success, but the
        // quarantined alias does not prove which canonical row owns it. Leave every message row
        // untouched; only prevent the same temp request from being POSTed again on the live-event
        // path. The HTTP-ack path retains its sticky retry/error behavior.
        if (!preservePendingError) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        }
        return 'owner-conflict';
      }
      const claimedChats = await db.all<{ chatGuid: string }>(sql`
        SELECT guid AS chatGuid
          FROM chats
         WHERE id = ${success.claimedChatId}
         LIMIT 1
      `);
      const claimedChatGuid = claimedChats[0]?.chatGuid;
      if (!claimedChatGuid) return 'owner-conflict';
      const retained = await db.all<{ dateDeleted: number; chatGuid: string | null }>(sql`
        SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
          FROM message_deletion_ledger
         WHERE guid = ${success.tempGuid}
         LIMIT 1
      `);
      const aliases = await db.all<{ canonicalGuid: string; chatGuid: string | null }>(sql`
        SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
          FROM message_guid_aliases
         WHERE alias_guid = ${success.tempGuid}
         LIMIT 1
      `);
      const deletionReservation = retained[0];
      const aliasReservation = aliases[0];
      if (!deletionReservation && !aliasReservation) return 'unmatched';
      if (
        (deletionReservation && deletionReservation.chatGuid !== claimedChatGuid) ||
        (aliasReservation &&
          (aliasReservation.chatGuid !== claimedChatGuid ||
            aliasReservation.canonicalGuid !== success.guid))
      ) {
        return 'owner-conflict';
      }
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          success.tempGuid,
          success.guid,
          claimedChatGuid,
        )
      ) {
        if (!preservePendingError) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        }
        return 'owner-conflict';
      }
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        claimedChatGuid,
      );
      await db.insert(messages).values({
        guid: success.guid,
        chatId: success.claimedChatId,
        isFromMe: true,
        dateCreated: success.dateCreated,
        dateDelivered: success.dateDelivered,
        dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: success.attemptGuid,
        attemptOwnerPending: false,
        attemptOwnerGeneration: success.clientAttemptGeneration,
      });
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
      return 'reconciled';
    }
    if (success.claimedChatId != null && owner.chatId !== success.claimedChatId) {
      return 'owner-conflict';
    }

    const wasPending = owner.attemptOwnerPending !== 0;
    if (wasPending) {
      if (owner.attemptOwnerGeneration !== success.clientAttemptGeneration) {
        // Keep the durable event pending. A later HTTP acknowledgement or matching exact event
        // will settle the newer local generation, after which this attempt becomes match/stale.
        return 'attempt-owner-pending';
      }
    } else if (owner.activeSendAttemptGuid !== success.attemptGuid) {
      return 'stale-attempt';
    }

    const stickyError = owner.sendState === 'error' && (!wasPending || preservePendingError);
    if (owner.guid !== success.tempGuid && owner.guid !== success.guid) {
      await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
      return 'owner-conflict';
    }

    let duplicate: { id: number; chatId: number } | undefined;
    if (owner.guid === success.tempGuid && success.guid !== success.tempGuid) {
      const duplicates = await db.all<{ id: number; chatId: number }>(
        sql`SELECT id, chat_id AS chatId FROM messages WHERE guid = ${success.guid} LIMIT 1`,
      );
      duplicate = duplicates[0];
      if (duplicate && duplicate.chatId !== owner.chatId) {
        await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
        return 'owner-conflict';
      }
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          success.tempGuid,
          success.guid,
          owner.chatGuid,
        )
      ) {
        await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
        return 'owner-conflict';
      }
    }

    if (wasPending) {
      const installed = await db.all<{ id: number }>(sql`
        UPDATE messages
           SET active_send_attempt_guid = ${success.attemptGuid}, attempt_owner_pending = 0
         WHERE guid = ${owner.guid}
           AND attempt_owner_pending = 1
           AND attempt_owner_generation = ${success.clientAttemptGeneration}
        RETURNING id
      `);
      if (installed.length === 0) return 'attempt-owner-pending';
    }

    const alreadyCanonical = owner.guid === success.guid;
    if (alreadyCanonical) {
      // When exact success itself installs a pending owner, it is affirmative evidence that the
      // current attempt succeeded and may clear a preceding local/HTTP error. A duplicate success
      // for an already-settled attempt does not erase a server failure that arrived afterward.
      if (wasPending && !stickyError) {
        await db
          .update(messages)
          .set({ sendState: 'sent', error: 0, errorMessage: null })
          .where(eq(messages.guid, owner.guid));
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        return 'reconciled';
      }
      return wasPending ? 'reconciled' : 'already-reconciled';
    }

    // A canonical fallback without an alias is possible only after bounded alias pruning or a
    // repaired database. Re-establish the exact mapping; a conflicting existing mapping throws and
    // fails closed instead of attaching the event to the wrong bubble.
    if (owner.guid !== success.tempGuid) {
      await recordMessageGuidAliasWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      if (wasPending && !stickyError) {
        await db
          .update(messages)
          .set({ sendState: 'sent', error: 0, errorMessage: null })
          .where(eq(messages.guid, owner.guid));
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        return 'reconciled';
      }
      return wasPending ? 'reconciled' : 'already-reconciled';
    }

    if (duplicate) {
      // Cross-chat duplicates returned above before attempt ownership changed. The remaining row
      // is the same exact conversation and may safely receive the temp row's local attachment.
      const tempAttachment = await db.all<{ localPath: string | null }>(sql`
        SELECT a.local_path AS localPath
          FROM attachments a
          JOIN messages m ON m.id = a.message_id
         WHERE m.guid = ${success.tempGuid} AND a.local_path IS NOT NULL
         LIMIT 1
      `);
      const localPath = tempAttachment[0]?.localPath;
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      if (localPath) {
        await db.run(sql`
          UPDATE attachments
             SET local_path = ${localPath}
           WHERE message_id = ${duplicate.id} AND local_path IS NULL
        `);
      }
      await db
        .update(messages)
        .set({
          activeSendAttemptGuid: success.attemptGuid,
          attemptOwnerPending: false,
          attemptOwnerGeneration: owner.attemptOwnerGeneration,
          ...(stickyError
            ? {
                sendState: 'error' as const,
                error: owner.error,
                errorMessage: owner.errorMessage,
              }
            : { sendState: 'sent' as const, error: 0, errorMessage: null }),
        })
        .where(eq(messages.guid, success.guid));
      if (dateDeleted != null) {
        await projectMessageStateWithinTransaction(context, success.guid, owner.chatGuid);
      }
      await db.delete(messages).where(eq(messages.guid, success.tempGuid));
    } else {
      await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      await db
        .update(messages)
        .set({
          guid: success.guid,
          // A send hidden by its chat's deletion keeps a date inside that deleted history, so an
          // explicit restore still shows it (review of M069).
          dateCreated:
            success.dateCreated == null
              ? undefined
              : sql`CASE WHEN ${messages.dateDeleted} IS NOT NULL AND ${messages.dateDeleted} = (
                  SELECT c.history_deleted_at FROM chats c WHERE c.id = ${messages.chatId}
                ) THEN MIN(${success.dateCreated}, ${messages.dateDeleted})
                ELSE ${success.dateCreated} END`,
          dateDelivered: success.dateDelivered ?? null,
          isFromMe: true,
          activeSendAttemptGuid: success.attemptGuid,
          attemptOwnerPending: false,
          ...(stickyError ? {} : { sendState: 'sent' as const, error: 0, errorMessage: null }),
        })
        .where(eq(messages.guid, success.tempGuid));
    }
    if (!stickyError) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
    }
    return 'reconciled';
  });
}
export function reconcileExactOutgoingAttemptSuccessWithinTransaction(
  context: DbTransactionContext,
  success: ExactOutgoingAttemptSuccess,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(context, success, false);
}
export interface OutgoingAttemptAck {
  readonly guid?: string | null;
  readonly attemptGuid: string;
  /** The local generation captured before this request began. */
  readonly attemptOwnerToken: SendAttemptOwnerToken;
  /** Exact locally selected conversation retained by the active request. */
  readonly expectedChatGuid?: string;
  readonly dateCreated: number | null;
  readonly dateDelivered: number | null;
}
/**
 * Settle one capable-RCS HTTP acknowledgement under the request's local ownership token.
 *
 * The server also echoes the generation that originally created a replayed physical attempt, but
 * that value may be older after a process restart. The local token is therefore the compare-and-set
 * authority here. A server error that committed first remains sticky, while the acknowledgement
 * can still install the attempt identity and promote a distinct real message GUID atomically.
 */
export function reconcileOutgoingAttemptAckWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  ack: OutgoingAttemptAck,
): Promise<OutgoingAckDisposition> {
  return runInTransactionContext(context, async (db) => {
    const distinctGuid = ack.guid && ack.guid !== tempGuid ? ack.guid : undefined;
    const ownerBefore = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      tempGuid,
      distinctGuid,
    );
    if (!ownerBefore) {
      const queuedOwner = await db.all<{ chatGuid: string }>(sql`
        SELECT chat_guid AS chatGuid
          FROM outgoing_queue
         WHERE temp_guid = ${tempGuid}
         LIMIT 1
      `);
      const sourceOwners = [queuedOwner[0]?.chatGuid ?? null, ack.expectedChatGuid ?? null].filter(
        (value): value is string => value != null,
      );
      const distinctSourceOwners = new Set(sourceOwners);
      const sourceChatGuid = sourceOwners[0] ?? null;
      if (distinctSourceOwners.size > 1) {
        // The request-local expected chat and durable queue disagree. Do not let the ack mutate or
        // retire the legitimate queued source until its owner resolves that contradiction.
        return 'stale-attempt-owner';
      }
      if (sourceChatGuid == null) {
        // Preserve the historical orphan cleanup. A successful request must not remain eligible
        // for blind re-send solely because its optimistic bubble was independently purged.
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }
      const retainedAliases = await db.all<{ aliasGuid: string }>(sql`
        SELECT alias_guid AS aliasGuid
          FROM message_guid_aliases
         WHERE alias_guid = ${tempGuid}
         LIMIT 1
      `);
      if (retainedAliases[0]) {
        // Owner lookup already proved that this retained alias could not safely join its canonical
        // row. The exact HTTP response retires only its temp request; it must not recreate the temp
        // identity, adopt an ownerless alias, or collide with the retained canonical row.
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }
      const sourceChat = await db.all<{ id: number; historyDeletedAt: number | null }>(sql`
        SELECT id, history_deleted_at AS historyDeletedAt
          FROM chats
         WHERE guid = ${sourceChatGuid}
         LIMIT 1
      `);
      const sourceChatId = sourceChat[0]?.id;
      if (sourceChatId == null) {
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }

      // A local chat purge can remove both optimistic ownership records while this exact request
      // remains in flight. Recreate only a minimal, request-owned row before moving any deletion
      // ledger. The exact success fanout can hydrate/promote it later; another provider/chat cannot
      // claim it first and inherit this send's tombstone.
      let dateDeleted: number | null;
      if (distinctGuid) {
        if (
          await hasOutgoingIdentityHandoverConflictWithinTransaction(
            context,
            tempGuid,
            distinctGuid,
            sourceChatGuid,
          )
        ) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
          return 'missing';
        }
        dateDeleted = await handoverOutgoingIdentityWithinTransaction(
          context,
          tempGuid,
          distinctGuid,
          sourceChatGuid,
        );
      } else {
        const deletion = await db.all<{ dateDeleted: number; chatGuid: string | null }>(sql`
          SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
            FROM message_deletion_ledger
           WHERE guid = ${tempGuid}
           LIMIT 1
        `);
        if (deletion[0]?.chatGuid != null && deletion[0].chatGuid !== sourceChatGuid) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
          return 'stale-attempt-owner';
        }
        if (deletion[0]?.chatGuid == null && deletion[0]) {
          await db
            .update(messageDeletionLedger)
            .set({ chatGuid: sourceChatGuid })
            .where(eq(messageDeletionLedger.guid, tempGuid));
        }
        dateDeleted = deletion[0]?.dateDeleted ?? null;
      }
      // A whole-chat delete hides history through chats.history_deleted_at, not per-message
      // records, and it is what purged this request's rows. Keep the recreated row inside that
      // deleted history (dated no later than its boundary) so it neither shows nor revives the
      // chat, and an explicit restore still brings it back with the rest (review M069).
      const historyFloor = sourceChat[0]?.historyDeletedAt ?? null;
      const hiddenByChatDelete = dateDeleted === null && historyFloor !== null;
      await db.insert(messages).values({
        guid: distinctGuid ?? tempGuid,
        chatId: sourceChatId,
        isFromMe: true,
        dateCreated:
          hiddenByChatDelete && (ack.dateCreated === null || ack.dateCreated > historyFloor)
            ? historyFloor
            : ack.dateCreated,
        dateDelivered: ack.dateDelivered,
        dateDeleted: hiddenByChatDelete ? historyFloor : dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: ack.attemptGuid,
        attemptOwnerPending: false,
        attemptOwnerGeneration: ack.attemptOwnerToken.generation,
      });
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'sent';
    }
    if (ack.expectedChatGuid) {
      const expectedChat = await db.all<{ id: number }>(sql`
        SELECT id
          FROM chats
         WHERE guid = ${ack.expectedChatGuid}
         LIMIT 1
      `);
      if (expectedChat[0]?.id !== ownerBefore.chatId) return 'stale-attempt-owner';
    }

    const result = await reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(
      context,
      {
        tempGuid,
        attemptGuid: ack.attemptGuid,
        clientAttemptGeneration: ack.attemptOwnerToken.generation,
        guid: distinctGuid ?? ownerBefore.guid,
        dateCreated: ack.dateCreated,
        dateDelivered: ack.dateDelivered,
      },
      true,
    );
    if (result === 'attempt-owner-pending' || result === 'stale-attempt') {
      return 'stale-attempt-owner';
    }
    if (result === 'owner-conflict') {
      // The core either settled the independently proven source or retained a sticky server error.
      // Surface that terminal state so callers do not retry a confirmed request and can clear a
      // stale failure notice only for the settled case.
      return ownerBefore.sendState === 'error' ? 'sticky-error' : 'sent';
    }
    if (result === 'unmatched') return 'missing';

    const ownerAfter = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      tempGuid,
      distinctGuid ?? ownerBefore.guid,
    );
    if (!ownerAfter) return 'missing';
    return ownerAfter.sendState === 'error' ? 'sticky-error' : 'sent';
  });
}
