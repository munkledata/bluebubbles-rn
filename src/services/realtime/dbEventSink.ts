import { Chat, resolveMessageChatGuid } from '@core/models';
import type { EventDeliveryContext, EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';
import {
  applyServerSendErrorWithinTransaction,
  getChatIdByGuid,
  getChatGuidByMessageGuid,
  getNewestReceivedGuid,
  linkHandlesToContacts,
  markMessageDeletedWithinTransaction,
  reconcileEchoByContent,
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

/** Private rollback signal for a delivery whose account generation changed mid-transaction. */
const STALE_REALTIME_DELIVERY = Symbol('stale-realtime-delivery');

/**
 * A durable message event could not yet be attached to a local chat row.
 *
 * Throwing keeps the queue receipt retryable instead of falsely marking an event complete. The
 * recovery hook can hydrate the missing chat before the drain's next attempt.
 */
export class RealtimeMessageChatUnavailableError extends Error {
  override readonly name = 'RealtimeMessageChatUnavailableError';

  constructor(
    readonly messageGuid: string,
    readonly chatGuid: string | null,
  ) {
    super(
      chatGuid
        ? `Realtime message ${messageGuid} references unavailable chat ${chatGuid}`
        : `Realtime message ${messageGuid} has no resolvable chat`,
    );
  }
}

type GroupMutationEventType =
  'group-name-change' | 'participant-added' | 'participant-removed' | 'participant-left';

/** A durable group mutation carried no chat snapshot the DB could safely apply. */
export class RealtimeGroupMutationUnavailableError extends Error {
  override readonly name = 'RealtimeGroupMutationUnavailableError';

  constructor(readonly eventType: GroupMutationEventType) {
    super(`Realtime ${eventType} event has no usable chat snapshot`);
  }
}

/** A durable remote-read event arrived before its local chat/message prerequisite. */
export class RealtimeReadStatusUnavailableError extends Error {
  override readonly name = 'RealtimeReadStatusUnavailableError';

  constructor(
    readonly chatGuid: string,
    readonly reason: 'chat-unavailable' | 'message-unavailable',
  ) {
    super(
      reason === 'chat-unavailable'
        ? `Realtime read status references unavailable chat ${chatGuid}`
        : `Realtime read status for ${chatGuid} has no received message to mark read`,
    );
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
): Promise<T | null> {
  try {
    return await withDbTransaction(
      db,
      async (transactionContext) => {
        if (context && !context.isCurrent()) return null;
        const result = await task(transactionContext);
        if (context && !context.isCurrent()) throw STALE_REALTIME_DELIVERY;
        return result;
      },
      context ? () => context.isCurrent() : undefined,
    );
  } catch (error) {
    if (error === STALE_REALTIME_DELIVERY) return null;
    if (error instanceof DbCommitGuardRejectedError && context && !context.isCurrent()) return null;
    throw error;
  }
}

function hasAuthoritativeDbPhase(event: NormalizedEvent): boolean {
  switch (event.type) {
    case 'new-message':
    case 'updated-message':
    case 'message-deleted':
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
   * @param onMessageStored optional detached hook fired with a persisted message's row id
   *   (new/updated message). It deliberately receives no delivery context or durable checkpoint;
   *   long-lived work must capture its own account-generation lease. Injected by the app to trigger
   *   attachment auto-download; left undefined in unit tests so the Node import graph never pulls
   *   the native download/media modules.
   */
  constructor(
    private readonly db: AppDatabase,
    private readonly onMessageStored?: (messageId: number) => void | Promise<void>,
    /** Runs after a deletion transaction commits, never while the DB write lock is held. */
    private readonly onAttachmentCacheRetirement?: (
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
    /** Requests bounded recovery when a durable DB event is missing prerequisite synced data. */
    private readonly onRecoveryNeeded?: (
      chatGuid: string | null,
      context?: EventDeliveryContext,
    ) => void | Promise<void>,
  ) {}

  private async requestRecovery(
    chatGuid: string | null,
    context: EventDeliveryContext,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.onRecoveryNeeded?.(chatGuid, context);
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
  ): Promise<void> {
    const unique = [...new Set(addresses.filter((address) => address.length > 0))];
    if (unique.length === 0 || (context && !context.isCurrent())) return;
    try {
      await linkHandlesToContacts(
        this.db,
        unique,
        undefined,
        context ? () => context.isCurrent() : undefined,
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError && context && !context.isCurrent()) return;
      logger.debug('[dbEventSink] post-commit contact linking skipped', error);
    }
  }

  async onEvent(
    event: NormalizedEvent,
    _source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<void> {
    if (context && !context.isCurrent()) return;
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
        const idMap = await withCurrentDeliveryTransaction(
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
            // and chatGuid, so recover their owner from the message row already in the DB.
            let chatId =
              targetChatGuid == null
                ? undefined
                : (chatMap.get(targetChatGuid) ??
                  (await getChatIdByGuid(this.db, targetChatGuid)) ??
                  undefined);
            if (chatId == null && event.type === 'updated-message') {
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
            await reconcileEchoByContent(transactionContext, message, chatId);
            const stored = await upsertMessagesWithinTransaction(
              transactionContext,
              [message],
              () => chatId,
              handleMap,
            );
            await markDurableDbPhase(transactionContext, context);
            return stored;
          },
        );
        if (idMap == null) {
          // A stale delivery also returns null, but was deliberately rolled back and needs no
          // recovery request or misleading "chat not found" diagnostic.
          if (context && !context.isCurrent()) break;
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
        await this.linkContactsAfterCommit(contactAddresses, context);
        // Notify the app (attachment auto-download) that this message + its rows are persisted.
        // Deliberately after COMMIT: it kicks off network/native work, which must never run with
        // the write lock held.
        const storedId = idMap.get(message.guid);
        // Downloads can take minutes and must not hold account teardown open. Their generation
        // guard owns the eventual file/DB commit; this event owns only launching the best-effort
        // task after the row committed.
        if (storedId != null && (!context || context.isCurrent())) {
          void Promise.resolve()
            .then(() => this.onMessageStored?.(storedId))
            .catch((error: unknown) => {
              logger.debug('[dbEventSink] post-commit message hook failed', error);
            });
        }
        break;
      }
      case 'message-deleted': {
        // The server saw a message enter macOS "Recently Deleted". TOMBSTONE the local row (never a
        // hard delete): the message REMAINS in the Mac's chat.db (~30 days) and the server's
        // query/sync paths keep returning it, so a hard delete would be UNDONE by the next sync
        // re-inserting the row. markMessageDeleted resolves the owning chat from the message row
        // itself (the payload's chatGuid, when present, is not needed) and recomputes the chat's
        // inbox position. An absent dateDeleted (some transports omit it) falls back to now() — fine
        // for a tombstone whose only job is to hide the row. An unknown guid is still a durable
        // write: markMessageDeleted records it in the deletion ledger, so a later message backfill
        // is born hidden instead of briefly resurrecting the deleted content.
        //
        // A delete event missed while the app was DEAD or APP-LOCKED (deliverRespectingLock does
        // not touch the DB while locked) is reconciled by the R1 CATCH-UP SYNC (2026-07-23): every
        // boot/reconnect sync runs syncDeletedMessages (sync/engine.ts), which pages
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
              const result = await markMessageDeletedWithinTransaction(
                transactionContext,
                guid,
                dateDeleted,
              );
              // `result` says whether a local MESSAGE row existed. The ledger write is authoritative
              // either way, so checkpoint the durable event in this same transaction.
              await markDurableDbPhase(transactionContext, context);
              return result;
            },
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
          logger.debug('[dbEventSink] durable deletion ledger recorded for unknown guid', { guid });
        }
        if (applied && (!context || context.isCurrent())) {
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
        );
        if (result == null || result === 'applied' || !context?.durableEvent) break;
        // This event carries no remote read boundary. A chat-only message backfill cannot recover
        // the Mac's watermark, so request the normal account sync before the short-lived receipt
        // backs off/expires.
        await this.requestRecovery(null, context, {
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
        // `retryable: true` = a SEND-PHASE bridge failure (nothing reached Google) — safe to
        // re-arm the automatic retry ladder even though the immediate ack already consumed the
        // queue row. Absent/false (older servers, delivery-phase failures) → bubble-only.
        const retryable = p.retryable === true || embedded.retryable === true;
        const now = Date.now();
        const onCommitted = await withCurrentDeliveryTransaction(
          this.db,
          context,
          async (transactionContext) => {
            let commitEffect: (() => void) | null = null;
            for (const guid of candidates) {
              const result = await applyServerSendErrorWithinTransaction(
                transactionContext,
                guid,
                code,
                now,
                retryable,
                context?.generation ?? 'direct',
              );
              if (result.matched) {
                commitEffect = result.onCommitted;
                break;
              }
            }
            await markDurableDbPhase(transactionContext, context);
            return commitEffect;
          },
        );
        onCommitted?.();
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
          await this.requestRecovery(null, context, { type: event.type });
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
        );
        if (applied) await this.linkContactsAfterCommit(contactAddresses, context);
        break;
      }
      default:
        // typing-indicator, facetime, alias events: notification-only / later phases.
        break;
    }
  }
}
