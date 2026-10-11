import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import type { ProviderRepairLease } from '@core/api/endpoints/repairSnapshot';
import { ApiError } from '@core/api/errors';
import type { MessageStateAuthority } from '@core/models/messageState';
import type { ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import {
  looksLikeRcsChatGuid,
  looksLikeRcsMessageGuid,
  classifyRcsChatRecord,
  classifyRcsMessageRecord,
} from '@core/rcs';
import type { SyncMarker } from '@core/sync';
import {
  captureFullRepairPruneExposure,
  getSyncMarker,
  setSyncMarkerWithinTransaction,
} from '@db/repositories';
import {
  getMessageStateAuthority,
  getProviderRepairBackoff,
  installCheckpointAuthorityWithinTransaction,
  providerRepairHasNothingToReconcile,
  recordProviderRepairFailureWithinTransaction,
  clearProviderRepairBackoffWithinTransaction,
  bindSnapshotMessageOwnersWithinTransaction,
  rebaseOldMessageStateBatchWithinTransaction,
  hideSnapshotMessagesWithinTransaction,
  restoreSnapshotMessagesWithinTransaction,
  setMessageStateAuthorityWithinTransaction,
} from '@db/repositories/messageState';
import { captureDbWriteFence, withDbTransaction } from '@db/transaction';
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
 * With no local Apple history to reconcile, the ledger checkpoint alone is a complete authority:
 * every row fetched afterwards was active when fetched, and later deletions replay from it. Returns
 * false, installing nothing, when local rows still need reconciling.
 */
async function installAuthorityFromCheckpoint(
  db: AppDatabase,
  controlApi: SyncApi,
  providerEpoch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await providerRepairHasNothingToReconcile(db))) return false;
  const lease = await beginProviderRepairWhenReady(controlApi, signal);
  // The checkpoint is a self-contained ledger cursor; the snapshot lease itself is not needed.
  await controlApi.cancelProviderRepair?.(lease.token).catch(() => undefined);
  if (lease.providerEpoch !== providerEpoch) throw new MessageStateRepairRequiredError();
  return withDbTransaction(db, (context) =>
    installCheckpointAuthorityWithinTransaction(context, {
      version: 1,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch: lease.ledgerEpoch,
      cursor: lease.checkpoint,
      snapshotSequence: lease.sequence,
      sequence: lease.sequence,
    }),
  );
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
): Promise<SyncProgress> {
  const { api, controlApi, serverInfo, shouldAbort, signal } = options;
  const providerEpoch = serverInfo.imessage_provider_epoch;
  if (!providerEpoch) throw new Error('The iMessage provider identity is unavailable.');
  const authority = await getMessageStateAuthority(db);
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
      else throw error;
    }
  }
  if (shouldAbort()) return progress;
  let repaired = false;
  let installedFromCheckpoint = false;
  let repairFailed = false;
  let repairFailure: unknown;
  if (needsRepair && !options.repair && (await providerRepairIsWaiting(db, providerEpoch))) {
    logger.debug('[sync] provider repair is waiting for its next attempt; ordinary sync continues');
  } else if (needsRepair) {
    try {
      if (!controlApi.beginProviderRepair || !controlApi.finishProviderRepair)
        throw new Error('The advertised provider snapshot endpoint is unavailable.');
      if (
        !options.repair &&
        (await installAuthorityFromCheckpoint(db, controlApi, providerEpoch, signal))
      ) {
        installedFromCheckpoint = true;
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
              await clearProviderRepairBackoffWithinTransaction(context);
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
  const chats = await syncAllChats(
    db,
    api,
    200,
    shouldAbort,
    signal,
    undefined,
    undefined,
    undefined,
    serverInfo,
  );
  for (const chat of chats) {
    if (shouldAbort()) return progress;
    if (looksLikeRcsChatGuid(chat.guid))
      await syncChatMessages(db, api, chat.guid, {
        maxMessages: 100,
        shouldAbort,
        signal,
        rcsProviderInfo: serverInfo,
      });
  }
  if (!repaired && !shouldAbort()) {
    const marker = await getSyncMarker(db);
    // Without a marker, incremental sync would page the whole history from the epoch, so an
    // unfinished repair falls back to the ordinary first sync and the user's per-chat cap.
    progress =
      marker.lastSyncedRowId == null && marker.lastSyncedTimestamp == null
        ? await fullSync(db, api, {
            maxMessagesPerChat: options.messagesPerChat,
            shouldAbort,
            signal,
            rcsProviderInfo: serverInfo,
            onProgress: options.onProgress,
          })
        : await incrementalSync(db, api, {
            serverVersion: serverInfo.server_version ?? '',
            shouldAbort,
            signal,
            rcsProviderInfo: serverInfo,
            onProgress: options.onProgress,
          });
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
      throw error;
    }
  }
  if (options.repair && repairFailed) throw repairFailure;
  return progress;
}
