import { projectServerErrorDetail } from '@core/api/serverErrorDetail';
import { Chat, resolveMessageChatGuid } from '@core/models';
import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';
import {
  classifyRcsEventAdmission,
  classifyRcsMessageRecord,
  isCurrentRcsChatGuid,
  looksLikeRcsChatGuid,
  looksLikeRcsMessageGuid,
  type RcsProviderServerInfo,
} from '@core/rcs';
import {
  applyServerSendErrorWithinTransaction,
  applyMessageStateWithinTransaction,
  getMessageStateAuthorityWithinTransaction,
  getChatIdByGuid,
  getChatGuidByMessageGuid,
  getMessageTextByGuid,
  getNewestReceivedGuid,
  linkHandlesToContacts,
  markMessageDeletedWithinTransaction,
  reconcileEchoByContent,
  resolveServerSendErrorOwnersWithinTransaction,
  setLastReadMessageGuidWithinTransaction,
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import {
  type DbTransactionContext,
  DbCommitGuardRejectedError,
  withDbTransaction,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { supportsMessageStateSync } from '../sync/providerRepair';
import { IncomingEventDependencyPendingError } from './incomingEventErrors';

/** Private rollback signal for a delivery whose account generation changed mid-transaction. */
const STALE_REALTIME_DELIVERY = Symbol('stale-realtime-delivery');

/**
 * A durable message event could not yet be attached to a local chat row.
 *
 * Throwing keeps the queue receipt retryable instead of falsely marking an event complete. The
 * recovery hook can hydrate the missing chat before the drain's next attempt.
 */
export class RealtimeMessageChatUnavailableError extends IncomingEventDependencyPendingError {
  override readonly name = 'RealtimeMessageChatUnavailableError';

  constructor(
    readonly messageGuid: string,
    readonly chatGuid: string | null,
  ) {
    super();
  }
}

type GroupMutationEventType =
  'group-name-change' | 'participant-added' | 'participant-removed' | 'participant-left';

/** A durable group mutation carried no chat snapshot the DB could safely apply. */
export class RealtimeGroupMutationUnavailableError extends IncomingEventDependencyPendingError {
  override readonly name = 'RealtimeGroupMutationUnavailableError';

  constructor(readonly eventType: GroupMutationEventType) {
    super();
  }
}

/** A durable remote-read event arrived before its local chat/message prerequisite. */
export class RealtimeReadStatusUnavailableError extends IncomingEventDependencyPendingError {
  override readonly name = 'RealtimeReadStatusUnavailableError';

  constructor(
    readonly chatGuid: string,
    readonly reason: 'chat-unavailable' | 'message-unavailable',
  ) {
    super();
  }
}

/**
 * Keep one realtime event's DB writes atomic with its account-generation check.
 *
 * Checking only at sink entry is insufficient: the process-wide write lock may queue behind
 * another handler, or one of the statements may yield long enough for Disconnect to revoke the
 * lease. The second check runs before COMMIT; throwing rolls every write in this callback back.
 */
async function withCurrentDeliveryTransaction<T>(
  db: AppDatabase,
  context: EventDeliveryContext | undefined,
  task: (transactionContext: DbTransactionContext) => Promise<T>,
  additionalGuard?: () => boolean,
): Promise<T | null> {
  try {
    return await withDbTransaction(
      db,
      async (transactionContext) => {
        if ((context && !context.isCurrent()) || additionalGuard?.() === false) return null;
        const result = await task(transactionContext);
        if ((context && !context.isCurrent()) || additionalGuard?.() === false) {
          throw STALE_REALTIME_DELIVERY;
        }
        return result;
      },
      context || additionalGuard
        ? () => (context?.isCurrent() ?? true) && (additionalGuard?.() ?? true)
        : undefined,
    );
  } catch (error) {
    if (error === STALE_REALTIME_DELIVERY) return null;
    if (
      error instanceof DbCommitGuardRejectedError &&
      ((context && !context.isCurrent()) || additionalGuard?.() === false)
    ) {
      return null;
    }
    throw error;
  }
}

function hasAuthoritativeDbPhase(event: NormalizedEvent): boolean {
  switch (event.type) {
    case 'new-message':
    case 'updated-message':
    case 'message-deleted':
    case 'message-state-changed':
    case 'chat-read-status-changed':
    case 'message-send-error':
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left':
      return true;
    default:
      return false;
  }
}

async function markDurableDbPhase(
  transactionContext: DbTransactionContext,
  context?: EventDeliveryContext,
): Promise<void> {
  await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
}

/**
 * EventSink that persists realtime events into the DB. This is the "stays in
 * sync" live path: socket (and later FCM) events flow through the EventRouter
 * into here, writing the same tables the sync engine fills. Pure DB logic, so it
 * is unit-tested in Node against better-sqlite3.
 */
export class DbEventSink implements EventSink {
  /**
   * @param onMessageStored optional detached hook fired synchronously after a message commit with
   *   its row id, source, and originating context. The hook must capture its own long-lived account
   *   lease; production uses the source/context only to let a background-FCM collector adopt the
   *   returned task before this method settles. Left undefined in unit tests so the Node import
   *   graph never pulls native download/media modules.
   */
  constructor(
    private readonly db: AppDatabase,
    private readonly onMessageStored?: (
      messageId: number,
      source: EventSource,
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
    /** Runs after a deletion/retraction transaction commits, never while the DB write lock is held. */
    private readonly onAttachmentCacheRetirement?: (
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
    /**
     * Requests bounded recovery: 'missing-data' when a durable DB event lacks prerequisite synced
     * data (the event waits on it), 'restored-message' when an applied live restore only needs the
     * message-state catch-up (review M111).
     */
    private readonly onRecoveryNeeded?: (
      chatGuid: string | null,
      context?: EventDeliveryContext,
      reason?: 'missing-data' | 'restored-message',
    ) => void | Promise<void>,
    /** Production admission snapshot; omitted only by legacy unit tests with non-RCS fixtures. */
    private readonly getRcsProviderInfo?: () =>
      | (RcsProviderServerInfo & {
          imessage_provider_epoch?: string | null;
          supports_message_state_sync?: boolean | null;
          message_state_sync_version?: number | null;
          supports_provider_repair_snapshot?: boolean | null;
        })
      | null
      | undefined,
  ) {}

  private async requestRecovery(
    chatGuid: string | null,
    context: EventDeliveryContext,
    details: Record<string, unknown>,
    reason: 'missing-data' | 'restored-message' = 'missing-data',
  ): Promise<void> {
    try {
      await this.onRecoveryNeeded?.(chatGuid, context, reason);
    } catch (error) {
      logger.warn('[dbEventSink] durable-event recovery request failed', { ...details, error });
    }
  }

  /**
   * Apply presentation-only device-contact names after the authoritative event transaction.
   * Contact indexing can scan the whole address book, so it must never run while the global DB
   * mutex is held. Each actual match owns a separately guarded short transaction; a stale account
   * or presentation failure cannot invalidate the message/group change that already committed.
   */
  private async linkContactsAfterCommit(
    addresses: string[],
    context?: EventDeliveryContext,
    additionalGuard?: () => boolean,
  ): Promise<void> {
    const unique = [...new Set(addresses.filter((address) => address.length > 0))];
    if (unique.length === 0 || (context && !context.isCurrent()) || additionalGuard?.() === false) {
      return;
    }
    try {
      await linkHandlesToContacts(
        this.db,
        unique,
        undefined,
        context || additionalGuard
          ? () => (context?.isCurrent() ?? true) && (additionalGuard?.() ?? true)
          : undefined,
      );
    } catch (error) {
      if (
        error instanceof DbCommitGuardRejectedError &&
        ((context && !context.isCurrent()) || additionalGuard?.() === false)
      ) {
        return;
      }
      logger.debug('[dbEventSink] post-commit contact linking skipped', error);
    }
  }

  async onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (context && !context.isCurrent()) return;
    let entryProviderAdmission: ReturnType<typeof classifyRcsEventAdmission> = 'non-rcs';
    if (this.getRcsProviderInfo) {
      entryProviderAdmission = classifyRcsEventAdmission(this.getRcsProviderInfo(), event);
      if (entryProviderAdmission === 'stale') return;
      if (entryProviderAdmission === 'unavailable') {
        if (context?.durableEvent) throw new IncomingEventDependencyPendingError();
        return;
      }
    }
    let providerAdmissionRevoked = false;
    const providerAdmissionIsCurrent = (): boolean => {
      if (!this.getRcsProviderInfo) return true;
      if (providerAdmissionRevoked) return false;
      if (event.type === 'message-state-changed') {
        const liveEpoch = this.getRcsProviderInfo()?.imessage_provider_epoch;
        if (liveEpoch != null && liveEpoch !== event.payload.providerEpoch) {
          providerAdmissionRevoked = true;
          return false;
        }
      }
      const liveAdmission = classifyRcsEventAdmission(this.getRcsProviderInfo(), event);
      const current =
        entryProviderAdmission === 'current'
          ? liveAdmission === 'current'
          : liveAdmission === 'non-rcs';
      if (!current) providerAdmissionRevoked = true;
      return current;
    };
    // A prior attempt committed the authoritative DB writes and their queue checkpoint together.
    // Replay resumes only the outer presentation/optional side-effect phases.
    if (context?.durableEvent?.dbAppliedAt != null && hasAuthoritativeDbPhase(event)) return;
    switch (event.type) {
      case 'new-message':
      case 'updated-message': {
        const message = event.message;
        // Resolve the target chat: prefer the hydrated `chats[0].guid`, else fall back to the
        // top-level `chatGuid` a live event may carry when the server didn't embed `chats[]`.
        // Without this fallback a chats-less event was silently filtered out by upsertMessages
        // (no resolvable chat) → no row, no notification. Pure (no DB), so it runs BEFORE the
        // transaction — an unusable event must not take the write lock at all.
        let targetChatGuid: string | null = resolveMessageChatGuid(message) ?? null;
        const providerInfo = this.getRcsProviderInfo?.();
        if (providerInfo && classifyRcsMessageRecord(providerInfo, message) === 'current') {
          // Lean updated-message events may omit both chat fields. Resolve the already-stored owner
          // with a read, then require that owner to be current before taking a write lock.
          targetChatGuid ??= await getChatGuidByMessageGuid(this.db, message.guid);
          if (!targetChatGuid) {
            // A lean current-epoch receipt may precede its chat/message. Keep its durable payload
            // until recovery supplies that owner; absence is not proof of a conflicting owner.
            if (context?.durableEvent && context.isCurrent() && providerAdmissionIsCurrent()) {
              await this.requestRecovery(null, context, { chatGuid: null, guid: message.guid });
              throw new RealtimeMessageChatUnavailableError(message.guid, null);
            }
            return;
          }
          if (!isCurrentRcsChatGuid(providerInfo, targetChatGuid)) return;
        }
        const messageProviderAdmissionIsCurrent = (): boolean =>
          providerAdmissionIsCurrent() &&
          (entryProviderAdmission !== 'current' ||
            (targetChatGuid != null &&
              classifyRcsMessageRecord(this.getRcsProviderInfo?.(), message, targetChatGuid) ===
                'current'));
        if (!targetChatGuid && event.type === 'new-message' && !context?.durableEvent) {
          // The legacy direct path has no receipt to retry. Keep its historical fail-safe skip;
          // durable delivery below instead requests recovery and retains the queue row.
          logger.warn('[dbEventSink] message event has no chat reference — skipped', {
            type: event.type,
            guid: message.guid,
          });
          break;
        }
        const embeddedChats = message.chats ?? [];
        // EVERY write for this event — handles, chats, echo-reconcile, message — goes in ONE
        // transaction. Two reasons, and the first is the non-obvious one:
        //
        //  1. There is a single shared connection, so a statement issued OUTSIDE a transaction
        //     while another handler's transaction is open silently JOINS it. Left as plain
        //     autocommit writes, these handle/chat upserts would be erased by a rollback on the
        //     other side — while `handleMap`/`chatId` here still held the ids of rows that no
        //     longer exist, so `upsertMessages` would then hit the `messages.chat_id REFERENCES
        //     chats(id)` FK (foreign keys are ON) and lose this message too. Being inside the
        //     serialized transaction is what makes those ids trustworthy for the rest of the body.
        //  2. The queue-delete and the temp→real guid promote must commit atomically — a hard
        //     crash in the gap could otherwise strand a queue-less unpromoted temp row (a
        //     permanent duplicate bubble).
        //
        // Everything in here is DB-only and short (no network, no native calls, and nothing that
        // re-enters withDbTransaction — a nested call would deadlock on its own caller's lock).
        // The auto-download hook stays OUTSIDE, below, for exactly that reason.
        const contactAddresses = [
          ...embeddedChats.flatMap((c) => c.participants ?? []),
          ...(message.handle ? [message.handle] : []),
        ].map((handle) => handle.address);
        const messageResult = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            const handleMap = await upsertHandlesWithinTransaction(transactionContext, [
              ...embeddedChats.flatMap((c) => c.participants ?? []),
              ...(message.handle ? [message.handle] : []),
            ]);
            const chatMap = await upsertChatsWithinTransaction(
              transactionContext,
              embeddedChats,
              handleMap,
            );
            // The chat may already exist locally (from a prior sync) even when this event didn't
            // embed it. Real FCM `updated-message` payloads are leaner still: they omit BOTH chats
            // and chatGuid, so recover their owner from the message row already in the DB. A
            // `new-message` with no chat reference (its server hydration failed) resolves the same
            // way once recovery has stored it, instead of waiting until it expires. One that names
            // a chat keeps that name, so recovery targets the chat rather than the whole account.
            let chatId =
              targetChatGuid == null
                ? undefined
                : (chatMap.get(targetChatGuid) ??
                  (await getChatIdByGuid(this.db, targetChatGuid)) ??
                  undefined);
            if (chatId == null && (event.type === 'updated-message' || targetChatGuid == null)) {
              targetChatGuid = await getChatGuidByMessageGuid(this.db, message.guid);
              chatId =
                targetChatGuid == null
                  ? undefined
                  : ((await getChatIdByGuid(this.db, targetChatGuid)) ?? undefined);
            }
            // Keep a durable receipt retryable until sync has hydrated the missing owner. The
            // handle/chat prologue still commits; the recovery callback runs after this transaction.
            if (chatId == null) {
              return null;
            }
            // Reconcile our own optimistic send against this LIVE echo before the upsert: Gator's
            // echo carries no tempGuid, so match by content and promote the `temp-…` row in place
            // (id + attachments + local_path preserved) rather than inserting a duplicate bubble.
            // Live path only — never the sync path (see reconcileEchoByContent).
            // A capped push copy of a long message carries a cut preview ("…", textTruncated). Its
            // socket copy has another intake key and may be stored first: keep that whole body.
            // The preview only fills a row that has no text yet; recovery fetches the rest.
            const storedText =
              message.textTruncated === true
                ? (await getMessageTextByGuid(this.db, message.guid))?.text
                : null;
            const applied = storedText ? { ...message, text: storedText } : message;
            const reconciliation = await reconcileEchoByContent(
              transactionContext,
              applied,
              chatId,
            );
            const stored = await upsertMessagesWithinTransaction(
              transactionContext,
              [applied],
              () => chatId,
              handleMap,
            );
            if (reconciliation !== 'attempt-owner-pending') {
              await markDurableDbPhase(transactionContext, context);
            }
            return { stored, reconciliation };
          },
          messageProviderAdmissionIsCurrent,
        );
        if (messageResult == null) {
          // A stale delivery also returns null, but was deliberately rolled back and needs no
          // recovery request or misleading "chat not found" diagnostic.
          if ((context && !context.isCurrent()) || !messageProviderAdmissionIsCurrent()) {
            break;
          }
          if (context?.durableEvent) {
            await this.requestRecovery(targetChatGuid, context, {
              chatGuid: targetChatGuid,
              guid: message.guid,
            });
            throw new RealtimeMessageChatUnavailableError(message.guid, targetChatGuid);
          }
          logger.info('[dbEventSink] chat not found for live message — skipped (will sync)', {
            chatGuid: targetChatGuid,
            guid: message.guid,
          });
          break;
        }
        if (!messageProviderAdmissionIsCurrent()) break;
        if (messageResult.reconciliation === 'attempt-owner-pending' && context?.durableEvent) {
          // Keep this exact success queued until the newer local request installs its owner. The
          // canonical server message was still upserted above, so history remains truthful.
          throw new IncomingEventDependencyPendingError();
        }
        await this.linkContactsAfterCommit(
          contactAddresses,
          context,
          messageProviderAdmissionIsCurrent,
        );
        // Notify the app (attachment auto-download) that this message + its rows are persisted.
        // Deliberately after COMMIT: it kicks off network/native work, which must never run with
        // the write lock held.
        const storedId = messageResult.stored.get(message.guid);
        const hasRetractionSignal =
          message.messageSummaryInfoInvalid === true ||
          message.dateRetracted != null ||
          (message.messageSummaryInfo?.retractedParts?.length ?? 0) > 0;
        if (
          storedId != null &&
          hasRetractionSignal &&
          (!context || context.isCurrent()) &&
          messageProviderAdmissionIsCurrent()
        ) {
          try {
            // Retraction can make an already-downloaded attachment unreachable. Retire it only
            // after the visibility transaction commits; a cleanup failure is recoverable later.
            await this.onAttachmentCacheRetirement?.(context);
          } catch (error) {
            logger.debug('[dbEventSink] attachment cache cleanup deferred', error);
          }
        }
        // Invoke the hook synchronously so a background-FCM callback can register the returned task
        // before this delivery settles. The task itself remains detached: downloads can take much
        // longer than this queue attempt and must not hold its transaction or teardown slot open.
        if (
          storedId != null &&
          (!context || context.isCurrent()) &&
          messageProviderAdmissionIsCurrent()
        ) {
          try {
            const task = this.onMessageStored?.(storedId, source, context);
            void Promise.resolve(task).catch((error: unknown) => {
              logger.debug('[dbEventSink] post-commit message hook failed', error);
            });
          } catch (error) {
            logger.debug('[dbEventSink] post-commit message hook failed', error);
          }
        }
        break;
      }
      case 'message-state-changed': {
        const applied = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            const result = await applyMessageStateWithinTransaction(
              transactionContext,
              event.payload,
            );
            await markDurableDbPhase(transactionContext, context);
            return result;
          },
          providerAdmissionIsCurrent,
        );
        if (applied && event.payload.kind === 'deleted' && (!context || context.isCurrent())) {
          await this.onAttachmentCacheRetirement?.(context);
        }
        // REST remains the authority for gaps and unknown restored payloads. A realtime receipt
        // deliberately never moves its checkpoint, even when a higher sequence arrived first.
        if (event.payload.kind === 'restored' && context?.isCurrent()) {
          await this.requestRecovery(null, context, { eventType: event.type }, 'restored-message');
        }
        break;
      }
      case 'message-deleted': {
        // The server saw a message enter macOS "Recently Deleted". TOMBSTONE the local row (never a
        // hard delete): the message REMAINS in the Mac's chat.db (~30 days) and the server's
        // query/sync paths keep returning it, so a hard delete would be UNDONE by the next sync
        // re-inserting the row. markMessageDeleted resolves the owning chat from the message row
        // and requires any payload chatGuid to agree before it changes either the row or ledger.
        // A scoped delete-before-message receipt can be retained safely; an ownerless legacy
        // receipt stays quarantined. The helper also recomputes the chat's
        // inbox position. An absent dateDeleted (some transports omit it) falls back to now() — fine
        // for a tombstone whose only job is to hide the row. An unknown guid is still a durable
        // write: markMessageDeleted records it in the deletion ledger, so a later message backfill
        // is born hidden instead of briefly resurrecting the deleted content.
        //
        // A delete event missed while the app was DEAD or APP-LOCKED (deliverRespectingLock does
        // not touch the DB while locked) is reconciled by the R1 CATCH-UP SYNC (2026-07-23): every
        // boot/reconnect sync runs syncDeletedMessages (sync/deletionSync.ts), which pages
        // GET /message/deleted after the persisted `sync.deletionsSyncedAt` watermark and applies
        // each row through this same markMessageDeleted tombstone (idempotent, so a row this live
        // event already handled re-applying is a no-op). This live event is the FAST path, no
        // longer the only path.
        const p = event.payload;
        const guid = p.guid;
        if (!guid) break;
        const dateDeleted = p.dateDeleted ?? Date.now();
        let applied = false;
        try {
          const found = await withCurrentDeliveryTransaction(
            this.db,
            context,
            async (transactionContext) => {
              // Only a server whose message-state sync actually runs owns iMessage deletes; the
              // flag alone does not, and dropping the event there lost the delete (review M019).
              const info = this.getRcsProviderInfo?.();
              if (
                !looksLikeRcsMessageGuid(guid) &&
                ((info != null && supportsMessageStateSync(info)) ||
                  (await getMessageStateAuthorityWithinTransaction(transactionContext)))
              ) {
                await markDurableDbPhase(transactionContext, context);
                return false;
              }
              const result = await markMessageDeletedWithinTransaction(
                transactionContext,
                guid,
                dateDeleted,
                p.chatGuid ?? undefined,
              );
              // `result` says whether the exact local MESSAGE owner was tombstoned. A matching
              // scoped ledger write is authoritative even without a row; a conflict is safely
              // rejected and checkpointed rather than retried forever.
              await markDurableDbPhase(transactionContext, context);
              return result;
            },
            providerAdmissionIsCurrent,
          );
          if (found == null) break;
          applied = found;
        } catch (e) {
          // Durable delivery must retry a failed authoritative tombstone. Preserve the historical
          // direct-path containment only when no queue owns this attempt.
          logger.warn('[dbEventSink] failed to apply message-deleted', { guid, error: e });
          if (context?.durableEvent) throw e;
          break;
        }
        if (!applied) {
          logger.debug('[dbEventSink] message deletion had no matching stored row', { guid });
        }
        if (applied && (!context || context.isCurrent()) && providerAdmissionIsCurrent()) {
          try {
            // markMessageDeleted claimed ledger paths in the transaction above. Physical deletion
            // is deliberately post-commit and remains part of this tracked realtime delivery.
            await this.onAttachmentCacheRetirement?.(context);
          } catch (error) {
            logger.debug('[dbEventSink] attachment cache cleanup deferred', error);
          }
        }
        break;
      }
      case 'chat-read-status-changed': {
        // Remote read (e.g. on the Mac/another device): advance the local read
        // marker to the newest received message so the unread badge clears.
        const chatGuid = event.payload.chatGuid;
        const result = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            const chatId = await getChatIdByGuid(this.db, chatGuid);
            if (chatId == null) return 'chat-unavailable' as const;
            const newest = await getNewestReceivedGuid(this.db, chatId);
            if (!newest) return 'message-unavailable' as const;
            await setLastReadMessageGuidWithinTransaction(transactionContext, chatGuid, newest);
            await markDurableDbPhase(transactionContext, context);
            return 'applied' as const;
          },
          providerAdmissionIsCurrent,
        );
        if (result == null || result === 'applied' || !context?.durableEvent) break;
        // The exact-chat refresh carries the Mac watermark and latest message. It is both faster
        // and safer for this short-lived receipt than paging unrelated account history.
        await this.requestRecovery(chatGuid, context, {
          chatGuid,
          reason: result,
          type: event.type,
        });
        throw new RealtimeReadStatusUnavailableError(chatGuid, result);
      }
      case 'message-send-error': {
        // The server (helper / RCS bridge) reports an outgoing send failed. Match the message by
        // any guid the payload carries and flip it to the error state so the bubble shows the
        // error + retry. Queue-aware: if the guid still owns an outgoing_queue row (a fast RCS
        // bridge failure around the immediate ack), this also bumps attempts + reschedules the
        // backoff so the automatic retry ladder stays honest (see applyServerSendError).
        const p = event.payload;
        const embedded = (p.message ?? {}) as Record<string, unknown>;
        const candidates = [...new Set([p.tempGuid, p.messageGuid, p.guid, embedded.guid])].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (candidates.length === 0) break;
        const code = Number(p.error ?? embedded.error ?? 1) || 1;
        const errorMessage = projectServerErrorDetail(p.errorMessage ?? p.message?.errorMessage);
        // `retryable: true` = a SEND-PHASE bridge failure (nothing reached Google) — safe to
        // re-arm the automatic retry ladder even though the immediate ack already consumed the
        // queue row. Absent/false (older servers, delivery-phase failures) → bubble-only.
        const retryable = p.retryable === true || embedded.retryable === true;
        const clientAttemptGeneration =
          p.clientAttemptGeneration ?? p.message?.clientAttemptGeneration;
        const hasModernAttemptMetadata = p.attemptGuid != null || clientAttemptGeneration != null;
        const attemptIdentity =
          p.tempGuid && p.attemptGuid && clientAttemptGeneration != null
            ? {
                tempGuid: p.tempGuid,
                attemptGuid: p.attemptGuid,
                clientAttemptGeneration,
              }
            : undefined;
        const incompleteAttemptIdentity = hasModernAttemptMetadata && attemptIdentity == null;
        const canonicalRcsIds = candidates.filter(looksLikeRcsMessageGuid);
        let resolvedRcsOwner: string | null = null;
        let rcsMutationAdmission: 'unresolved' | 'non-rcs' | 'current' | 'unavailable' | 'stale' =
          'unresolved';
        const errorIdentityIsCurrent = (): boolean => {
          if (!providerAdmissionIsCurrent()) return false;
          if (rcsMutationAdmission !== 'current') return true;
          const providerInfo = this.getRcsProviderInfo?.();
          return (
            providerInfo != null &&
            resolvedRcsOwner != null &&
            p.chatGuid === resolvedRcsOwner &&
            isCurrentRcsChatGuid(providerInfo, resolvedRcsOwner) &&
            canonicalRcsIds.every(
              (guid) =>
                classifyRcsMessageRecord(providerInfo, {
                  guid,
                  chatGuid: resolvedRcsOwner,
                }) === 'current',
            )
          );
        };
        const now = Date.now();
        const sendErrorResult = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            const ownerResolution = await resolveServerSendErrorOwnersWithinTransaction(
              transactionContext,
              candidates,
            );
            const rcsOwners = ownerResolution.chatGuids.filter(looksLikeRcsChatGuid);
            const requiresRcsOwnership =
              rcsOwners.length > 0 ||
              looksLikeRcsChatGuid(p.chatGuid) ||
              canonicalRcsIds.length > 0;
            if (requiresRcsOwnership) {
              const providerInfo = this.getRcsProviderInfo?.();
              if (providerInfo == null) {
                rcsMutationAdmission = 'unavailable';
                return {
                  commitEffect: null,
                  disposition: 'provider-unavailable' as const,
                };
              }
              resolvedRcsOwner =
                ownerResolution.chatGuids.length === 1
                  ? (ownerResolution.chatGuids[0] ?? null)
                  : null;
              const exactOwnerIsCurrent =
                ownerResolution.hasEvidence &&
                !ownerResolution.hasConflict &&
                resolvedRcsOwner != null &&
                typeof p.chatGuid === 'string' &&
                p.chatGuid === resolvedRcsOwner &&
                isCurrentRcsChatGuid(providerInfo, resolvedRcsOwner) &&
                canonicalRcsIds.every(
                  (guid) =>
                    classifyRcsMessageRecord(providerInfo, {
                      guid,
                      chatGuid: resolvedRcsOwner,
                    }) === 'current',
                ) &&
                (canonicalRcsIds.length > 0 || attemptIdentity != null);
              if (!exactOwnerIsCurrent) {
                rcsMutationAdmission = 'stale';
                return { commitEffect: null, disposition: 'provider-rejected' as const };
              }
              rcsMutationAdmission = 'current';
            } else {
              rcsMutationAdmission = 'non-rcs';
            }
            let commitEffect: (() => void) | null = null;
            let disposition:
              | 'applied'
              | 'attempt-owner-pending'
              | 'attempt-identity-missing'
              | 'stale-attempt'
              | 'owner-conflict'
              | 'unmatched' = incompleteAttemptIdentity ? 'attempt-identity-missing' : 'unmatched';
            if (!incompleteAttemptIdentity) {
              for (const guid of candidates) {
                const result = await applyServerSendErrorWithinTransaction(
                  transactionContext,
                  guid,
                  code,
                  now,
                  retryable,
                  context?.generation ?? 'direct',
                  errorMessage,
                  attemptIdentity,
                );
                if (result.matched) {
                  commitEffect = result.onCommitted;
                  disposition = result.disposition;
                  break;
                }
              }
            }
            if (
              disposition !== 'attempt-owner-pending' &&
              disposition !== 'attempt-identity-missing'
            ) {
              await markDurableDbPhase(transactionContext, context);
            }
            return { commitEffect, disposition };
          },
          errorIdentityIsCurrent,
        );
        if (sendErrorResult == null) {
          if (
            resolvedRcsOwner != null &&
            this.getRcsProviderInfo?.() == null &&
            context?.durableEvent
          ) {
            throw new IncomingEventDependencyPendingError();
          }
          break;
        }
        if (sendErrorResult.disposition === 'provider-unavailable') {
          if (context?.durableEvent) throw new IncomingEventDependencyPendingError();
          break;
        }
        if (sendErrorResult.disposition === 'provider-rejected') break;
        if (!errorIdentityIsCurrent()) break;
        sendErrorResult.commitEffect?.();
        if (sendErrorResult.disposition === 'attempt-owner-pending' && context?.durableEvent) {
          throw new IncomingEventDependencyPendingError();
        }
        if (sendErrorResult.disposition === 'attempt-identity-missing' && context?.durableEvent) {
          // A modern row must never fall through to the legacy temp-guid heuristic. Let the
          // durable queue's bounded poison policy contain this malformed server event.
          throw new Error('attempt-aware send error omitted exact correlation');
        }
        break;
      }
      case 'group-name-change':
      case 'participant-added':
      case 'participant-removed':
      case 'participant-left': {
        // Payload carries the updated chat(s); re-upsert to reflect name/members.
        const parsed = (event.payload.chats ?? [])
          .map((c) => Chat.safeParse(c))
          .flatMap((r) => (r.success && r.data.guid.trim().length > 0 ? [r.data] : []));
        if (parsed.length === 0) {
          if (!context?.durableEvent || !context.isCurrent()) break;
          const recoveryChatGuid = (event.payload.chats ?? [])
            .map((raw) => {
              if (typeof raw !== 'object' || raw == null) return null;
              const guid = (raw as Record<string, unknown>).guid;
              return typeof guid === 'string' && guid.trim().length > 0 ? guid.trim() : null;
            })
            .find((guid): guid is string => guid != null);
          await this.requestRecovery(recoveryChatGuid ?? null, context, { type: event.type });
          throw new RealtimeGroupMutationUnavailableError(event.type);
        }
        const contactAddresses = parsed
          .flatMap((chat) => chat.participants ?? [])
          .map((handle) => handle.address);
        const applied = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            const handleMap = await upsertHandlesWithinTransaction(
              transactionContext,
              parsed.flatMap((c) => c.participants ?? []),
            );
            await upsertChatsWithinTransaction(transactionContext, parsed, handleMap);
            await markDurableDbPhase(transactionContext, context);
            return true;
          },
          providerAdmissionIsCurrent,
        );
        if (applied && providerAdmissionIsCurrent()) {
          await this.linkContactsAfterCommit(contactAddresses, context, providerAdmissionIsCurrent);
        }
        break;
      }
      default:
        // typing-indicator, facetime, alias events: notification-only / later phases.
        break;
    }
  }
}
