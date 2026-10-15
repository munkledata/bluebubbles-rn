import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import type { ProviderRepairLease } from '@core/api/endpoints/repairSnapshot';
import { ApiError } from '@core/api/errors';
import { compareMessageStateSequence, type MessageStateAuthority } from '@core/models/messageState';
import type { ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import {
  looksLikeRcsChatGuid,
  looksLikeRcsMessageGuid,
  classifyRcsChatRecord,
  classifyRcsMessageRecord,
} from '@core/rcs';
import { advanceMarker, type SyncMarker } from '@core/sync';
import {
  captureFullRepairPruneExposure,
  getSyncMarker,
  listRcsChatNewestMessageGuids,
  setSyncMarkerWithinTransaction,
} from '@db/repositories';
import {
  getMessageStateAuthority,
  getMessageStateAuthorityWithinTransaction,
  getMessageStateAudit,
  getProviderRepairBackoff,
  installCheckpointAuthorityWithinTransaction,
  messageStateAuditIsCurrentWithinTransaction,
  readMessageStateAuditCandidates,
  readMessageStateAuditReceiptsWithinTransaction,
  reconcileMessageStateAuditReceiptsWithinTransaction,
  setMessageStateAuditWithinTransaction,
  type MessagePresenceAnswer,
  type MessageStateAudit,
  recordProviderRepairFailureWithinTransaction,
  clearProviderRepairBackoffWithinTransaction,
  bindSnapshotMessageOwnersWithinTransaction,
  rebaseOldMessageStateBatchWithinTransaction,
  hideSnapshotMessagesWithinTransaction,
  restoreSnapshotMessagesWithinTransaction,
  setMessageStateAuthorityWithinTransaction,
  setPendingMessageStateRepairWithinTransaction,
  clearPendingMessageStateRepairWithinTransaction,
} from '@db/repositories/messageState';
import {
  captureDbWriteFence,
  DbCommitGuardRejectedError,
  withDbTransaction,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  fullSync,
  incrementalSync,
  syncAllChats,
  syncChatMessages,
  type FullSyncServerView,
  type SyncProgress,
} from './engine';
import { syncMessageState, MESSAGE_STATE_FOREGROUND_MAX_PAGES } from './messageStateSync';
import type { SyncApi } from './types';

export function supportsMessageStateSync(info: ServerInfo): boolean {
  return (
    info.supports_message_state_sync === true &&
    info.message_state_sync_version === 1 &&
    info.supports_provider_repair_snapshot === true &&
    typeof info.imessage_provider_epoch === 'string'
  );
}

const PROVIDER_REPAIR_FIRST_DELAY_MS = 15 * 60 * 1000;
const PROVIDER_REPAIR_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/** 15 minutes after the first failure, doubling up to a day, with ±20% jitter that never exceeds it. */
function providerRepairDelayMs(failures: number): number {
  const base = Math.min(
    PROVIDER_REPAIR_FIRST_DELAY_MS * 2 ** (failures - 1),
    PROVIDER_REPAIR_MAX_DELAY_MS,
  );
  return Math.min(Math.round(base * (0.8 + 0.4 * Math.random())), PROVIDER_REPAIR_MAX_DELAY_MS);
}

/** A failed automatic repair waits; a wait further ahead than the maximum means the clock moved. */
async function providerRepairIsWaiting(db: AppDatabase, providerEpoch: string): Promise<boolean> {
  const backoff = await getProviderRepairBackoff(db);
  const now = Date.now();
  return (
    backoff?.providerEpoch === providerEpoch &&
    now < backoff.nextAttemptAt &&
    backoff.nextAttemptAt - now <= PROVIDER_REPAIR_MAX_DELAY_MS
  );
}

const PROVIDER_REPAIR_BEGIN_ATTEMPTS = 3;

/** The server answers 409 only while it prepares the snapshot boundary, which clears quickly. */
async function beginProviderRepairWhenReady(
  controlApi: SyncApi,
  signal?: AbortSignal,
): Promise<ProviderRepairLease> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await controlApi.beginProviderRepair!(signal);
    } catch (error) {
      const preparing =
        error instanceof ApiError &&
        error.status === 409 &&
        error.serverErrorType === 'repair_snapshot_changed';
      if (!preparing || attempt >= PROVIDER_REPAIR_BEGIN_ATTEMPTS) throw error;
    }
  }
}

/**
 * The ledger checkpoint is a complete authority for everything fetched afterwards: server reads
 * exclude Recently Deleted, so each such row was active when fetched, and later deletions replay
 * from the checkpoint. Messages already on the phone are recorded for a later check that trusts
 * only the server's typed presence answers. A new provider identity means a different Messages
 * database, whose row numbers the old sync bookmark does not describe: clearing it in this same
 * owner makes sync restart it from the server, retried on later syncs until a refresh finishes.
 */
async function installAuthorityFromCheckpoint(
  db: AppDatabase,
  controlApi: SyncApi,
  providerEpoch: string,
  signal?: AbortSignal,
): Promise<void> {
  const lease = await beginProviderRepairWhenReady(controlApi, signal);
  // The checkpoint is a self-contained ledger cursor; the snapshot lease itself is not needed.
  await controlApi.cancelProviderRepair?.(lease.token).catch(() => undefined);
  if (lease.providerEpoch !== providerEpoch) throw new MessageStateRepairRequiredError();
  await withDbTransaction(db, async (context) => {
    const previous = await getMessageStateAuthorityWithinTransaction(context);
    await installCheckpointAuthorityWithinTransaction(context, {
      version: 1,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch: lease.ledgerEpoch,
      cursor: lease.checkpoint,
      snapshotSequence: lease.sequence,
      sequence: lease.sequence,
    });
    if (previous && previous.providerEpoch !== providerEpoch)
      await setSyncMarkerWithinTransaction(context, NO_SYNC_MARKER);
  });
}

const NO_SYNC_MARKER: SyncMarker = { lastSyncedRowId: null, lastSyncedTimestamp: null };

function hasSyncPosition(marker: SyncMarker | null): marker is SyncMarker {
  return marker != null && (marker.lastSyncedRowId != null || marker.lastSyncedTimestamp != null);
}

const MESSAGE_STATE_AUDIT_BUDGET = 2_000;
const MESSAGE_STATE_AUDIT_TIME_BOX_MS = 15_000;
const MESSAGE_STATE_AUDIT_REQUEST = 200;
const MESSAGE_STATE_AUDIT_WRITE_BATCH = 25;
/** Far longer than any real Apple GUID, yet a full request stays well inside the server's limits. */
const MESSAGE_STATE_AUDIT_MAX_GUID_LENGTH = 256;

/** One odd local id must never make the server reject, and so stall, a whole batch. */
function askable(guid: string): boolean {
  return guid.length > 0 && guid.length <= MESSAGE_STATE_AUDIT_MAX_GUID_LENGTH;
}

/** Ask for presence and refuse any answer that does not name exactly the requested messages. */
async function presenceOf(
  fetchPresence: NonNullable<SyncApi['fetchMessagePresence']>,
  providerEpoch: string,
  guids: readonly string[],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof fetchPresence>>> {
  const answer = await fetchPresence(providerEpoch, guids, signal);
  if (
    answer.providerEpoch !== providerEpoch ||
    answer.results.length !== guids.length ||
    answer.results.some((result, index) => result.guid !== guids[index])
  )
    throw new Error('Message presence answer does not match its request.');
  return answer;
}

/** Stamp at the answer's ledger position, which is never older than the audit's checkpoint. */
function stampAt(authority: MessageStateAuthority, sequence: string): MessageStateAuthority {
  return compareMessageStateSequence(sequence, authority.snapshotSequence) > 0
    ? { ...authority, snapshotSequence: sequence }
    : authority;
}

/**
 * Reconcile messages that were already on the phone when a checkpoint authority installed, using
 * only the server's typed batch presence answers: first settle retained deletions (restoring what
 * the server positively still has in the same chat), then hide visible messages it positively
 * reports absent. Ambiguous answers prove nothing. Each write batch rechecks its plan and the audit
 * inside its own transaction and commits with its progress; any error pauses without advancing.
 */
async function auditMessagesOnPhone(
  db: AppDatabase,
  options: ProviderSyncOptions,
  providerEpoch: string,
): Promise<void> {
  const { api, serverInfo, shouldAbort, signal } = options;
  const fetchPresence = api.fetchMessagePresence;
  if (serverInfo.supports_message_state_presence !== true || !fetchPresence) return;
  const keepGoing = () => !shouldAbort();
  // A user-started repair checks every message; an automatic sync spends a bounded share of its run.
  let budget = options.repair
    ? Number.POSITIVE_INFINITY
    : (options.auditBudget ?? MESSAGE_STATE_AUDIT_BUDGET);
  const deadline = options.repair
    ? Number.POSITIVE_INFINITY
    : Date.now() + MESSAGE_STATE_AUDIT_TIME_BOX_MS;
  try {
    while (budget > 0 && !shouldAbort() && Date.now() < deadline) {
      const audit = await getMessageStateAudit(db);
      const authority = await getMessageStateAuthority(db);
      if (
        !audit ||
        authority?.providerEpoch !== providerEpoch ||
        audit.providerEpoch !== providerEpoch ||
        audit.ledgerEpoch !== authority.ledgerEpoch ||
        audit.snapshotSequence !== authority.snapshotSequence
      )
        return;
      if (audit.phase === 'restore') {
        // Planned inside an owner, so another writer's uncommitted rows are never planned.
        const planned = await withDbTransaction(
          db,
          (context) =>
            readMessageStateAuditReceiptsWithinTransaction(
              context,
              audit,
              Math.min(MESSAGE_STATE_AUDIT_REQUEST, budget),
            ),
          keepGoing,
        );
        budget -= Math.max(planned.length, 1);
        if (planned.length === 0) {
          const advanced = await withDbTransaction(
            db,
            async (context) => {
              if (!(await messageStateAuditIsCurrentWithinTransaction(context, audit)))
                return false;
              await setMessageStateAuditWithinTransaction(context, { ...audit, phase: 'hide' });
              return true;
            },
            keepGoing,
          );
          if (!advanced) return;
          continue;
        }
        // Ask about every retained deletion a positive answer could settle, including this
        // ledger's deletions of messages the phone never downloaded.
        const asked = planned.filter(
          (receipt) =>
            receipt.kind === 'deleted' &&
            askable(receipt.guid) &&
            ((receipt.providerEpoch === audit.providerEpoch &&
              receipt.ledgerEpoch === audit.ledgerEpoch) ||
              (receipt.chatGuid != null && receipt.chatGuid === receipt.localOwner)),
        );
        let stamp = authority;
        const answers = new Map<string, MessagePresenceAnswer>();
        if (asked.length > 0) {
          const answer = await presenceOf(
            fetchPresence,
            providerEpoch,
            asked.map((receipt) => receipt.guid),
            signal,
          );
          if (shouldAbort() || answer.ledgerEpoch !== authority.ledgerEpoch) return;
          stamp = stampAt(authority, answer.sequence);
          for (const result of answer.results) answers.set(result.guid, result);
        }
        let expected = audit;
        for (let offset = 0; offset < planned.length; offset += MESSAGE_STATE_AUDIT_WRITE_BATCH) {
          const slice = planned.slice(offset, offset + MESSAGE_STATE_AUDIT_WRITE_BATCH);
          const settled = expected;
          const next: MessageStateAudit = { ...settled, afterGuid: slice.at(-1)!.guid };
          const advanced = await withDbTransaction(
            db,
            async (context) => {
              if (!(await messageStateAuditIsCurrentWithinTransaction(context, settled)))
                return false;
              // Writes nothing if a planned receipt or its local owner changed meanwhile.
              if (
                !(await reconcileMessageStateAuditReceiptsWithinTransaction(
                  context,
                  settled,
                  slice,
                  answers,
                  stamp,
                ))
              )
                return false;
              await setMessageStateAuditWithinTransaction(context, next);
              return true;
            },
            keepGoing,
          );
          if (!advanced) return;
          expected = next;
        }
        continue;
      }
      const candidates = await readMessageStateAuditCandidates(
        db,
        audit,
        Math.min(MESSAGE_STATE_AUDIT_REQUEST, budget),
        Date.now(),
      );
      if (candidates.length === 0) {
        await withDbTransaction(
          db,
          async (context) => {
            if (await messageStateAuditIsCurrentWithinTransaction(context, audit))
              await setMessageStateAuditWithinTransaction(context, null);
          },
          keepGoing,
        );
        return;
      }
      budget -= candidates.length;
      const asked = candidates.filter((row) => askable(row.guid));
      let stamp = authority;
      const absent = new Set<string>();
      if (asked.length > 0) {
        const answer = await presenceOf(
          fetchPresence,
          providerEpoch,
          asked.map((row) => row.guid),
          signal,
        );
        if (shouldAbort() || answer.ledgerEpoch !== authority.ledgerEpoch) return;
        stamp = stampAt(authority, answer.sequence);
        for (const result of answer.results) if (result.state === 'absent') absent.add(result.guid);
      }
      let planned = audit;
      for (let offset = 0; offset < candidates.length; offset += MESSAGE_STATE_AUDIT_WRITE_BATCH) {
        const chunk = candidates.slice(offset, offset + MESSAGE_STATE_AUDIT_WRITE_BATCH);
        const expected = planned;
        const next: MessageStateAudit = { ...expected, afterMessageId: chunk.at(-1)!.id };
        const advanced = await withDbTransaction(
          db,
          async (context) => {
            if (!(await messageStateAuditIsCurrentWithinTransaction(context, expected)))
              return false;
            // Ambiguous and elsewhere-filed messages stay visible; only positive absence hides.
            await hideSnapshotMessagesWithinTransaction(
              context,
              chunk.filter((row) => absent.has(row.guid)),
              stamp,
            );
            await setMessageStateAuditWithinTransaction(context, next);
            return true;
          },
          keepGoing,
        );
        if (!advanced) return;
        planned = next;
      }
    }
  } catch (error) {
    if (shouldAbort()) return;
    logger.warn('[sync] deleted-message check paused; it resumes on a later sync', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

/** A user-started repair also says how it settled, for the repair screen. */
export interface ProviderSyncProgress extends SyncProgress {
  /**
   * 'snapshot': a finished snapshot crawl. 'checked': every chat re-downloaded and every message
   * checked with the server. 'check-paused': re-downloaded, but the check continues on later syncs.
   */
  readonly repairResult?: 'snapshot' | 'checked' | 'check-paused';
}

/**
 * Full Repair's reader: Apple history only (RCS keeps its own bounded refresh). Before a page is
 * saved, its chat is bound to any ownerless server receipt of its messages, as the snapshot crawl
 * did: ordinary reads skip Recently Deleted, so the page's chat is each message's active chat, and an
 * ownerless receipt would otherwise keep the message out. Pages are read by offset, so a deletion on
 * the Mac during a chat's download can shift one older message past the next page; a later Full
 * Repair reads it.
 */
function fullRepairReader(db: AppDatabase, api: SyncApi, shouldAbort: () => boolean): SyncApi {
  return {
    ...api,
    fetchChatMessages: async (chatGuid, offset, limit, signal) => {
      if (looksLikeRcsChatGuid(chatGuid)) return [];
      const messages = await api.fetchChatMessages(chatGuid, offset, limit, signal);
      for (let index = 0; index < messages.length; index += 25) {
        const slice = messages.slice(index, index + 25);
        await withDbTransaction(
          db,
          (context) =>
            bindSnapshotMessageOwnersWithinTransaction(
              context,
              slice.map((message) => ({ guid: message.guid, chatGuid })),
            ),
          () => !shouldAbort(),
        );
      }
      return messages;
    },
  };
}

export interface ProviderSyncOptions {
  api: SyncApi;
  /** Pinned transport; the bound reader must verify the server's snapshot header echo. */
  controlApi: SyncApi;
  bindSnapshot: (token: string) => SyncApi;
  serverInfo: ServerInfo;
  repair: boolean;
  /** The user's "Messages per Chat" first-sync cap (0 = all), used when a repair cannot finish. */
  messagesPerChat?: number;
  /** Set only by this module when the ledger demands a repair mid-run; a failure stays silent. */
  forceRepair?: boolean;
  /** Most messages one automatic sync checks against presence answers; a user repair checks all. */
  auditBudget?: number;
  /** A user-started repair's progress notes for the repair screen. */
  onRepairNote?: (phase: string, message: string) => void;
  shouldAbort: () => boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
}

/**
 * Versioned Apple authority is initialized only by a finished complete provider snapshot. A repair
 * that cannot finish never blocks ordinary sync: the chat list, RCS refresh and incremental (or
 * first) sync still run, and only a user-started repair reports its failure afterwards.
 */
export async function syncProviderMessages(
  db: AppDatabase,
  options: ProviderSyncOptions,
): Promise<ProviderSyncProgress> {
  const { api, controlApi, serverInfo, shouldAbort, signal } = options;
  const providerEpoch = serverInfo.imessage_provider_epoch;
  if (!providerEpoch) throw new Error('The iMessage provider identity is unavailable.');
  const authority = await getMessageStateAuthority(db);
  // A new provider identity is a different Messages database; see installAuthorityFromCheckpoint.
  const providerChanged = authority != null && authority.providerEpoch !== providerEpoch;
  let needsRepair =
    options.repair ||
    options.forceRepair === true ||
    !authority ||
    authority.providerEpoch !== providerEpoch;
  let progress: SyncProgress = { chats: 0, messages: 0 };
  if (!needsRepair) {
    try {
      await syncMessageState(db, api, {
        providerEpoch,
        maxPages: MESSAGE_STATE_FOREGROUND_MAX_PAGES,
        shouldAbort,
        signal,
      });
    } catch (error) {
      if (error instanceof MessageStateRepairRequiredError) needsRepair = true;
      else if (error instanceof DbCommitGuardRejectedError) throw error;
      // Deleted/edited-message catch-up must not hold back the chat refresh and new iMessages
      // below. The pass after them tries again and reports what still fails.
      else logger.debug('[sync] message-state catch-up failed; ordinary sync continues', error);
    }
  }
  if (shouldAbort()) return progress;
  let repaired = false;
  let installedFromCheckpoint = false;
  let refreshAll = false;
  const presenceCapable =
    serverInfo.supports_message_state_presence === true && api.fetchMessagePresence != null;
  let repairFailed = false;
  let repairFailure: unknown;
  if (needsRepair && !options.repair && (await providerRepairIsWaiting(db, providerEpoch))) {
    logger.debug('[sync] provider repair is waiting for its next attempt; ordinary sync continues');
  } else if (needsRepair) {
    try {
      if (!controlApi.beginProviderRepair || !controlApi.finishProviderRepair)
        throw new Error('The advertised provider snapshot endpoint is unavailable.');
      if (!options.repair || presenceCapable) {
        await installAuthorityFromCheckpoint(db, controlApi, providerEpoch, signal);
        installedFromCheckpoint = true;
        // A user-started repair on such a server re-downloads every chat below and checks each
        // message, instead of crawling a frozen snapshot that a busy account changes first.
        refreshAll = options.repair;
      } else {
        const lease = await controlApi.beginProviderRepair(signal);
        let consumed = false;
        try {
          if (shouldAbort()) return progress;
          if (lease.providerEpoch !== providerEpoch) throw new MessageStateRepairRequiredError();
          const fence = await captureDbWriteFence(() => !shouldAbort());
          const exposure = await captureFullRepairPruneExposure(db, fence.commitGuard);
          const snapshot: { view: FullSyncServerView | null; marker: SyncMarker | null } = {
            view: null,
            marker: null,
          };
          const bound = options.bindSnapshot(lease.token);
          const scoped: SyncApi = {
            ...bound,
            fetchChats: async (offset, limit, requestSignal) => {
              const chats = await bound.fetchChats(offset, limit, requestSignal);
              if (
                chats.some(
                  (chat) =>
                    classifyRcsChatRecord(null, chat) !== 'non-rcs' ||
                    (chat.lastMessage &&
                      classifyRcsMessageRecord(null, chat.lastMessage, chat.guid) !== 'non-rcs'),
                )
              )
                throw new Error('Provider snapshot returned a mixed-provider page.');
              return chats;
            },
            fetchChatMessages: async (chatGuid, offset, limit, requestSignal) => {
              const messages = await bound.fetchChatMessages(
                chatGuid,
                offset,
                limit,
                requestSignal,
              );
              if (
                messages.some(
                  (message) => classifyRcsMessageRecord(null, message, chatGuid) !== 'non-rcs',
                )
              )
                throw new Error('Provider snapshot returned a mixed-provider page.');
              for (let offset = 0; offset < messages.length; offset += 25) {
                await withDbTransaction(
                  db,
                  (context) =>
                    bindSnapshotMessageOwnersWithinTransaction(
                      context,
                      messages
                        .slice(offset, offset + 25)
                        .map((message) => ({ guid: message.guid, chatGuid })),
                    ),
                  fence.commitGuard,
                );
              }
              return messages;
            },
          };
          progress = await fullSync(db, scoped, {
            maxMessagesPerChat: 0,
            failOnChatError: true,
            commitMarker: false,
            commitGuard: fence.commitGuard,
            shouldAbort,
            signal,
            rcsProviderInfo: serverInfo,
            onProgress: options.onProgress,
            onServerView: (view) => {
              snapshot.view = view;
            },
            onServerMarker: (marker) => {
              snapshot.marker = marker;
            },
          });
          if (shouldAbort()) return progress;
          const { view, marker } = snapshot;
          if (
            !view ||
            !marker ||
            [...view.chats.keys()].some(looksLikeRcsChatGuid) ||
            [...view.messages.keys()].some(looksLikeRcsMessageGuid)
          )
            throw new Error('Provider snapshot returned an incomplete or mixed-provider view.');
          const finish = await controlApi.finishProviderRepair(lease.token, signal);
          consumed = true;
          if (
            finish.providerEpoch !== lease.providerEpoch ||
            finish.ledgerEpoch !== lease.ledgerEpoch ||
            finish.checkpoint !== lease.checkpoint ||
            finish.sequence !== lease.sequence
          )
            throw new Error('Provider snapshot finish did not match its captured boundary.');
          if (shouldAbort()) return progress;
          const nextAuthority: MessageStateAuthority = {
            version: 1,
            provider: 'imessage',
            providerEpoch,
            ledgerEpoch: lease.ledgerEpoch,
            cursor: lease.checkpoint,
            snapshotSequence: lease.sequence,
            sequence: lease.sequence,
          };
          const present = [...view.messages].map(([guid, owner]) => ({
            guid,
            chatGuid: owner.chatGuid,
          }));
          // Trust this repair's rows from its first step: if it stops before the install below,
          // ordinary sync must still honour the deletions it already recorded (review M053).
          await withDbTransaction(
            db,
            (context) => setPendingMessageStateRepairWithinTransaction(context, nextAuthority),
            fence.commitGuard,
          );
          let rebaseAfter: string | null = null;
          do {
            const after: string | null = rebaseAfter;
            rebaseAfter = await withDbTransaction(
              db,
              (context) =>
                rebaseOldMessageStateBatchWithinTransaction(
                  context,
                  after,
                  view.messages,
                  nextAuthority,
                ),
              fence.commitGuard,
            );
          } while (rebaseAfter != null);
          for (let offset = 0; offset < present.length; offset += 25) {
            await withDbTransaction(
              db,
              (context) =>
                restoreSnapshotMessagesWithinTransaction(
                  context,
                  present.slice(offset, offset + 25),
                  nextAuthority,
                ),
              fence.commitGuard,
            );
          }
          const chatOwners = new Map(exposure.chats.map((chat) => [chat.id, chat.guid]));
          const absent = exposure.messages.flatMap((row) => {
            const chatGuid = chatOwners.get(row.chatId);
            return !view.messages.has(row.guid) &&
              chatGuid &&
              !looksLikeRcsMessageGuid(row.guid) &&
              !looksLikeRcsChatGuid(chatGuid)
              ? [{ ...row, chatGuid }]
              : [];
          });
          for (let offset = 0; offset < absent.length; offset += 25) {
            await withDbTransaction(
              db,
              (context) =>
                hideSnapshotMessagesWithinTransaction(
                  context,
                  absent.slice(offset, offset + 25),
                  nextAuthority,
                ),
              fence.commitGuard,
            );
          }
          await withDbTransaction(
            db,
            async (context) => {
              await setSyncMarkerWithinTransaction(context, marker);
              await setMessageStateAuthorityWithinTransaction(context, nextAuthority);
              await clearPendingMessageStateRepairWithinTransaction(context);
              await clearProviderRepairBackoffWithinTransaction(context);
              // A finished crawl reconciled every local row; any pending presence audit is obsolete.
              await setMessageStateAuditWithinTransaction(context, null);
            },
            fence.commitGuard,
          );
          repaired = true;
        } finally {
          if (!consumed)
            await controlApi.cancelProviderRepair?.(lease.token).catch(() => undefined);
        }
      }
    } catch (error) {
      if (shouldAbort()) return progress;
      repairFailed = true;
      repairFailure = error;
      logger.warn('[sync] provider repair failed; ordinary sync continues', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await withDbTransaction(db, (context) =>
        recordProviderRepairFailureWithinTransaction(
          context,
          providerEpoch,
          (failures) => Date.now() + providerRepairDelayMs(failures),
        ),
      );
    }
  }
  if (shouldAbort()) return progress;
  // The general chat refresh is additive; RCS pages never participate in Apple absence cleanup
  // or advance its message cursor. Their independently owned history remains bounded per run.
  // It also notes the newest Apple message the server lists before any history is fetched. A
  // first sync's bookmark there stays below anything that arrives after the listing; a message
  // arriving during a multi-page listing is read by the history pass that follows.
  let listed = NO_SYNC_MARKER;
  // Read before the listing stores each chat's newest server message; see the RCS refresh below.
  const rcsNewestBefore = await listRcsChatNewestMessageGuids(db);
  const rcsNewestListed = new Map<string, string | null>();
  // With a bookmark, the chat refresh is best-effort, as in the legacy pipeline: new messages come
  // from the incremental sync below. A first sync or Full Repair still needs the whole listing.
  const listingOptional = !refreshAll && hasSyncPosition(await getSyncMarker(db));
  let chats: Awaited<ReturnType<typeof syncAllChats>> = [];
  try {
    chats = await syncAllChats(
      db,
      api,
      200,
      shouldAbort,
      signal,
      (messages, chatGuidByMessage) => {
        listed = advanceMarker(
          listed,
          messages
            .filter(
              (message) =>
                !looksLikeRcsMessageGuid(message.guid) &&
                !looksLikeRcsChatGuid(chatGuidByMessage.get(message.guid) ?? ''),
            )
            .map((message) => ({
              rowId: message.originalROWID ?? null,
              timestamp: message.dateCreated ?? null,
            })),
        );
      },
      (serverChats) => {
        for (const chat of serverChats)
          if (looksLikeRcsChatGuid(chat.guid))
            rcsNewestListed.set(chat.guid, chat.lastMessage?.guid ?? null);
      },
      undefined,
      serverInfo,
    );
  } catch (error) {
    if (!listingOptional || error instanceof DbCommitGuardRejectedError) throw error;
    logger.debug('[sync] chat-list refresh failed; the iMessage catch-up continues', error);
  }
  if (!repaired && !shouldAbort()) {
    // Without a marker, incremental sync would page the whole history from the epoch, so an
    // unfinished repair falls back to the ordinary first sync and the user's per-chat cap.
    const hasMarker = hasSyncPosition(await getSyncMarker(db));
    if (hasMarker && !refreshAll) {
      // Until a new Messages database is set up, the old bookmark describes none of its rows, so
      // only the chat list above refreshes; setup then clears the bookmark for a first sync.
      if (providerChanged && !installedFromCheckpoint)
        logger.debug('[sync] holding incremental sync until the new Messages database is set up');
      else
        progress = await incrementalSync(db, api, {
          serverVersion: serverInfo.server_version ?? '',
          shouldAbort,
          signal,
          rcsProviderInfo: serverInfo,
          onProgress: options.onProgress,
        });
    } else {
      let crawled: SyncMarker | null = null;
      // A first sync reads each chat's newest messages. A Full Repair reads every Apple chat's whole
      // history and fails rather than finish with a chat missing.
      progress = await fullSync(db, refreshAll ? fullRepairReader(db, api, shouldAbort) : api, {
        maxMessagesPerChat: refreshAll ? 0 : options.messagesPerChat,
        failOnChatError: refreshAll,
        commitMarker: false,
        shouldAbort,
        signal,
        rcsProviderInfo: serverInfo,
        onProgress: options.onProgress,
        onServerMarker: (marker) => {
          crawled = marker;
        },
      });
      // The bookmark comes from the server, never from this phone's rows, which may still carry
      // another Messages database's row numbers. The history pass is only a first sync's fallback;
      // a Full Repair keeps an existing bookmark when the server lists no newest message.
      const restart = hasSyncPosition(listed) ? listed : hasMarker ? null : crawled;
      if (!shouldAbort() && hasSyncPosition(restart))
        await withDbTransaction(
          db,
          (context) => setSyncMarkerWithinTransaction(context, restart),
          () => !shouldAbort(),
        );
    }
  }
  // RCS history is not part of the Apple bookmark. Re-read it after the iMessage catch-up, only for
  // conversations the listing shows something new in (every one on a user-started repair), and let
  // one conversation's failure skip just that conversation. It used to re-read up to 100 messages
  // of every RCS chat on each sync, before iMessage, and one failure failed the whole run.
  for (const chat of chats) {
    if (shouldAbort()) return progress;
    if (!looksLikeRcsChatGuid(chat.guid)) continue;
    const seenNewest = rcsNewestBefore.get(chat.guid) ?? null;
    const listedNewest = rcsNewestListed.get(chat.guid) ?? null;
    if (
      !options.repair &&
      seenNewest != null &&
      (listedNewest == null || listedNewest === seenNewest)
    )
      continue;
    try {
      await syncChatMessages(db, api, chat.guid, {
        maxMessages: 100,
        shouldAbort,
        signal,
        rcsProviderInfo: serverInfo,
      });
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      logger.debug('[sync] an RCS conversation could not be refreshed; the rest continue', error);
    }
  }
  // Message-state catch-up needs a usable authority of this exact provider. One whose repair failed
  // in this run is known to be stale, so it waits for the next attempt instead of failing the run.
  if (
    !shouldAbort() &&
    (!needsRepair || repaired || installedFromCheckpoint) &&
    (await getMessageStateAuthority(db))?.providerEpoch === providerEpoch
  ) {
    try {
      await syncMessageState(db, api, {
        providerEpoch,
        maxPages: MESSAGE_STATE_FOREGROUND_MAX_PAGES,
        shouldAbort,
        signal,
      });
    } catch (error) {
      // One bounded repair attempt per run; a source changing again during repair remains retryable.
      if (error instanceof MessageStateRepairRequiredError && !needsRepair)
        return syncProviderMessages(db, { ...options, forceRepair: true });
      // New messages above have already arrived; like the legacy deletion catch-up, ordinary sync
      // only logs this. A user-started repair reports it.
      if (options.repair || error instanceof DbCommitGuardRejectedError) throw error;
      logger.warn('[sync] message-state catch-up failed; it will retry on the next sync', error);
    }
  }
  if (!shouldAbort() && (!needsRepair || repaired || installedFromCheckpoint)) {
    if (refreshAll)
      options.onRepairNote?.(
        'Checking deleted messages',
        'Asking the server which messages on this phone it still has.',
      );
    await auditMessagesOnPhone(db, options, providerEpoch);
  }
  if (options.repair && repairFailed) throw repairFailure;
  if (!options.repair) return progress;
  return {
    ...progress,
    repairResult: !refreshAll
      ? 'snapshot'
      : (await getMessageStateAudit(db))
        ? 'check-paused'
        : 'checked',
  };
}
