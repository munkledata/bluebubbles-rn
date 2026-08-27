import { logger } from '@core/secure';
import type { SyncMarker } from '@core/sync';
import {
  captureFullRepairPruneExposure,
  chatExistsAndIsVisible,
  getSyncMarker,
  reconcileFullRepairPruneExposure,
  restoreDeletedChatWithinTransaction,
  setSyncMarkerWithinTransaction,
  type FullRepairPruneExposure,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { syncContacts } from './contacts/contactsService';
import { createAttachmentCacheAccountScope } from './download/attachmentCacheAccountScope';
import { attachmentCacheCoordinator } from './download/attachmentCacheCoordinator';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import {
  fullSync,
  httpSyncApi,
  incrementalSync,
  sameFullSyncServerView,
  syncAllChats,
  syncChatMessageRange,
  syncChatMessages,
  syncSingleChat,
  syncDeletedMessages,
  type FullSyncServerView,
} from './sync';

/**
 * THREE slots, deliberately — they hold DIFFERENT work and must never substitute for each other.
 *
 * `syncInFlight` holds a full `runSync` (chat-list refresh + full/incremental branch + deletion
 * catch-up + the trailing contacts sync). `trackedInFlight` holds an out-of-band run published via
 * {@link runTrackedSync} — today the background WorkManager task, which pages ONLY an incremental
 * catch-up. `targetedRepairInFlight` holds the serialized user-invoked repair of one chat. All
 * three are drained by {@link awaitSyncIdle}, which is what `forget()` needs; but a
 * foreground caller must never be handed the background run as if it were its own. It was, once:
 * one shared slot meant a boot / pull-to-refresh / resume arriving while the 15-minute task held
 * it returned that promise and did none of the pipeline — no chat-list refresh, no deletion
 * catch-up, no contacts sync, no first-sync branch, and no begin/progress/done for the banner, so
 * a refresh spinner tracked work the user had not asked for and cleared having done nothing.
 */
let syncInFlight: Promise<void> | null = null;
/**
 * The session epoch `syncInFlight` was published under. A run is only shareable with a caller
 * belonging to the SAME session instance — see {@link startSync}.
 */
let inFlightEpoch: number | null = null;
let trackedInFlight: Promise<void> | null = null;
/** Manual per-chat repairs serialize with the two global sync owners without impersonating one. */
let targetedRepairInFlight: Promise<void> | null = null;
/** On-demand chat backfills run alongside the main pipeline but still belong to its teardown. */
const auxiliaryInFlight = new Set<Promise<unknown>>();
interface ActiveRepairRun {
  readonly epoch: number;
  readonly lease: RealtimeDeliveryLease;
  readonly abortController: AbortController;
  readonly releaseInvalidation: () => void;
  cancelled: boolean;
  slot: Promise<void> | null;
}
let activeRepair: ActiveRepairRun | null = null;
export interface ChatRepairResult {
  messages: number;
  historyExhausted: boolean;
  restored: boolean;
}

interface TargetedRepairRun {
  readonly epoch: number;
  readonly key: string;
  readonly result: Promise<ChatRepairResult>;
  readonly slot: Promise<void>;
}

const targetedRepairByKey = new Map<string, TargetedRepairRun>();
let lastSyncAt = 0;
const RESUME_MIN_INTERVAL_MS = 10_000;
const TARGETED_CHAT_REPAIR_MAX_MESSAGES = 500;

/** Resolve once every currently-published run has STOPPED (settled), however it settled. */
function settledAll(runs: Array<Promise<void> | null>): Promise<unknown> {
  return Promise.all(runs.map((p) => (p ? p.catch(() => undefined) : Promise.resolve())));
}

/** Publish non-coalesced sync work before it starts, so Disconnect cannot miss its first await. */
function runTrackedAuxiliarySync<T>(run: () => Promise<T>): Promise<T> {
  let slot!: Promise<T>;
  slot = Promise.resolve()
    .then(run)
    .finally(() => {
      auxiliaryInFlight.delete(slot);
    });
  auxiliaryInFlight.add(slot);
  return slot;
}

/**
 * Coalesced sync entrypoint. Concurrent callers (boot, pull-to-refresh, reconnect-resume) share ONE
 * in-flight run rather than stacking overlapping syncs that would hammer the server.
 *
 * Coalescing applies to OTHER foreground callers only. A tracked (background) run is waited on but
 * never returned in place of this one — see the slot comment above.
 *
 * And only to callers of the SAME SESSION INSTANCE. A run is bound to the session epoch it was
 * published under, because the slot can outlive its account: `forget()` gives a dying sync 20
 * seconds to unwind and then wipes anyway, so a large account's backfill is routinely still in the
 * slot when the user connects to the next server. Coalescing on nothing but "a promise is present"
 * handed `connect()` the PREVIOUS account's doomed run as if it were the new server's initial sync
 * — which therefore never happened. Silently, too: that run resolves normally (its per-chat errors
 * are isolated) and reports `done`, so the banner clears over an empty inbox and nothing re-kicks
 * it until a pull-to-refresh or a relaunch. A mismatch chains behind the stale run instead of
 * ignoring it, so both stay visible to `awaitSyncIdle` and neither pages alongside the other.
 *
 * The EPOCH and not the origin, because the origin cannot tell "a different server" from "this
 * session was destroyed and re-created": reconnecting to the SAME server after a Disconnect —
 * a changed password, a rotated tunnel URL, an accidental tap, i.e. the ordinary reason people
 * disconnect — restores a byte-identical origin string and so re-matched the dead run.
 */
export function startSync(): Promise<void> {
  const epoch = sessionAccessors.getEpoch();
  if (syncInFlight && inFlightEpoch === epoch) return syncInFlight;
  // Serialize behind a background catch-up (and behind a previous session's run) rather than
  // paging alongside it: both walk the same cursor, so overlapping them doubles the fetching and
  // interleaves two writers' marker writes.
  const slot: Promise<void> = settledAll([syncInFlight, trackedInFlight, targetedRepairInFlight])
    .then(() => runSync())
    .finally(() => {
      // Only the run that still OWNS the slot may clear it — a successor may already have
      // published itself here, and nulling that out would make `awaitSyncIdle` — and therefore
      // `forget()` — blind to a pipeline that is still writing.
      if (syncInFlight === slot) {
        syncInFlight = null;
        inFlightEpoch = null;
      }
      lastSyncAt = Date.now();
    });
  syncInFlight = slot;
  inFlightEpoch = epoch;
  return slot;
}

/**
 * Publish an out-of-band sync run into the tracked slot, so it takes part in the same drain
 * `startSync`'s runs do.
 *
 * The background WorkManager task pages its own catch-up rather than calling `startSync` (which
 * would drag the first-sync/full-sync branch and the contacts sync onto a 15-minute timer), so
 * without this its run was INVISIBLE: `forget()`'s `awaitSyncIdle()` awaited a null slot, returned
 * immediately and wiped the DB — then the task's in-flight page landed AFTER the deletes,
 * re-creating the old account's chats/handles/messages and committing a non-null sync marker over
 * the reset. Exactly the two failures the wipe exists to prevent.
 *
 * CHAINS rather than joins, behind BOTH slots. A run already in flight is doing the same kind of
 * work against the same cursor, so waiting for it is both cheaper and safer than paging alongside
 * it — and unlike joining, the caller's own work still happens. A failed predecessor is swallowed:
 * it has stopped writing, which is all this cares about. The wait graph only ever points from a
 * newer slot to older ones, so the two slots can never wait on each other.
 */
export function runTrackedSync(run: () => Promise<void>): Promise<void> {
  const slot: Promise<void> = settledAll([syncInFlight, trackedInFlight, targetedRepairInFlight])
    .then(run)
    .finally(() => {
      if (trackedInFlight === slot) trackedInFlight = null;
      lastSyncAt = Date.now();
    });
  trackedInFlight = slot;
  return slot;
}

/**
 * Inbox pull-to-refresh: a LIGHT sync (chat-list refresh + incremental). It deliberately does NOT
 * bulk re-fetch existing chats' messages — that wedges this single-threaded server (one conversation
 * with a pathological hydration hangs the daemon). To fill in a conversation's stale/empty bodies
 * (e.g. SMS/edited text the server now recovers), OPEN it — its own on-demand backfill re-pulls just
 * that thread.
 */
export function refreshInbox(): Promise<void> {
  return startSync();
}

/**
 * Queue a full local-cache repair behind every older sync owner.
 *
 * The repair logically resets the full-sync branch without clearing the durable incremental marker
 * until success. Existing domain rows remain in place while full-sync upserts authoritative server
 * data over them, so device-local pins,
 * names, archive/mute state, wallpapers, themes, reminders, drafts, and deletion ledgers survive.
 * Cancellation/failure leaves the old marker usable; success replaces it from server responses only.
 */
export function startFullRepair(): Promise<void> {
  const epoch = sessionAccessors.getEpoch();
  const existing = activeRepair;
  if (existing?.slot && existing.epoch === epoch && !existing.cancelled) return existing.slot;

  // Capture account authority and publish the successor slot synchronously, before its first await,
  // so Disconnect can see/drain it and a queued account-A repair can never recapture account B.
  const lease = captureRealtimeDeliveryLease();
  const abortController = new AbortController();
  const releaseInvalidation = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    abortController.abort();
  });
  const controller: ActiveRepairRun = {
    epoch,
    lease,
    abortController,
    releaseInvalidation,
    cancelled: false,
    slot: null,
  };
  const predecessors = [syncInFlight, trackedInFlight, targetedRepairInFlight];
  useSyncStore.getState().queueRepair();

  let slot!: Promise<void>;
  slot = settledAll(predecessors)
    .then(() =>
      runSync({
        repair: true,
        expectedEpoch: controller.epoch,
        accountLease: controller.lease,
        shouldCancel: () => controller.cancelled,
        signal: controller.abortController.signal,
      }),
    )
    .finally(() => {
      controller.releaseInvalidation();
      if (activeRepair === controller) activeRepair = null;
      if (syncInFlight === slot) {
        syncInFlight = null;
        inFlightEpoch = null;
      }
      lastSyncAt = Date.now();
    });
  controller.slot = slot;
  activeRepair = controller;
  syncInFlight = slot;
  inFlightEpoch = epoch;
  return slot;
}

/** Request a cooperative stop. The current bounded request/owner settles before the next phase. */
export function cancelFullRepair(): boolean {
  const repair = activeRepair;
  if (!repair || repair.cancelled || repair.epoch !== sessionAccessors.getEpoch()) return false;
  repair.cancelled = true;
  repair.abortController.abort();
  useSyncStore.getState().requestRepairCancel();
  return true;
}

interface TargetedRepairOptions {
  readonly expectedDeletedAt?: number;
}

/**
 * Re-download one conversation's server metadata and latest 500 messages.
 *
 * This uses its own serialized slot: returning the promise from `syncInFlight` would make a pull
 * to refresh incorrectly believe that a chat-only repair had performed the global sync pipeline.
 * Capture/publish happens before the first await so Disconnect can abort and drain the owner.
 */
function startTargetedChatRepair(
  chatGuid: string,
  options: TargetedRepairOptions = {},
): Promise<ChatRepairResult> {
  const guid = chatGuid.trim();
  if (!guid) return Promise.reject(new Error('A conversation is required for repair.'));
  if (
    options.expectedDeletedAt != null &&
    (!Number.isSafeInteger(options.expectedDeletedAt) || options.expectedDeletedAt < 0)
  ) {
    return Promise.reject(new Error('The deleted-conversation marker is invalid.'));
  }

  const epoch = sessionAccessors.getEpoch();
  const key = `${epoch}\u0000${guid}\u0000${options.expectedDeletedAt ?? 'repair'}`;
  const existing = targetedRepairByKey.get(key);
  if (existing) return existing.result;

  const lease = captureRealtimeDeliveryLease();
  const abortController = new AbortController();
  const releaseInvalidation = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    abortController.abort();
  });
  const predecessor = targetedRepairInFlight;

  const result = settledAll([syncInFlight, trackedInFlight, predecessor]).then(async () => {
    const stopped = (): boolean =>
      abortController.signal.aborted || sessionAccessors.getEpoch() !== epoch || !lease.isCurrent();
    if (stopped()) throw new Error('Conversation repair stopped because the account changed.');
    const db = await ensureDatabase();
    if (stopped()) throw new Error('Conversation repair stopped because the account changed.');
    const api = httpSyncApi(http);

    const synced = await syncSingleChat(db, api, guid, {
      shouldAbort: stopped,
      signal: abortController.signal,
    });
    if (!synced || stopped()) {
      throw new Error('Conversation repair stopped before the chat was refreshed.');
    }

    const history = await syncChatMessageRange(db, api, guid, {
      maxMessages: TARGETED_CHAT_REPAIR_MAX_MESSAGES,
      shouldAbort: stopped,
      signal: abortController.signal,
      probeExhaustion: options.expectedDeletedAt != null,
      readFloorAtOrBefore: options.expectedDeletedAt,
    });
    if (stopped()) throw new Error('Conversation repair stopped before completion.');

    let restored = false;
    if (options.expectedDeletedAt != null) {
      restored = await withDbTransaction(
        db,
        (context) =>
          restoreDeletedChatWithinTransaction(context, {
            guid,
            expectedDeletedAt: options.expectedDeletedAt!,
            historyExhausted: history.exhausted,
            repairedReadFloor: history.readFloorCandidate,
          }),
        () => !stopped(),
      );
      if (!restored && !stopped()) {
        // A genuinely new message may have retired the tombstone while the repair was paging. That
        // is already a successful restore. A still-hidden row failed the CAS or lacks a safe floor.
        restored = await chatExistsAndIsVisible(db, guid);
        if (stopped()) {
          throw new Error('Conversation repair stopped because the account changed.');
        }
      }
      if (!restored) {
        throw new Error(
          'This conversation could not be restored safely from the bounded server history.',
        );
      }
    }

    if (stopped()) throw new Error('Conversation repair stopped because the account changed.');

    return {
      messages: history.messages,
      historyExhausted: history.exhausted,
      restored,
    };
  });

  let slot!: Promise<void>;
  slot = result
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      releaseInvalidation();
      const current = targetedRepairByKey.get(key);
      if (current?.slot === slot) targetedRepairByKey.delete(key);
      if (targetedRepairInFlight === slot) targetedRepairInFlight = null;
    });
  const run: TargetedRepairRun = { epoch, key, result, slot };
  targetedRepairByKey.set(key, run);
  targetedRepairInFlight = slot;
  return result;
}

/** User-facing bounded repair for one live conversation. */
export function startChatRepair(chatGuid: string): Promise<ChatRepairResult> {
  return startTargetedChatRepair(chatGuid);
}

/** Re-fetch while still hidden, then atomically hand off the unread floor and restore the chat. */
export function restoreDeletedChat(
  chatGuid: string,
  expectedDeletedAt: number,
): Promise<ChatRepairResult> {
  return startTargetedChatRepair(chatGuid, { expectedDeletedAt });
}

/**
 * Resolve once no sync is in flight (immediately when none is).
 *
 * `forget()` awaits this before wiping the DB. A sync that is still paging when the wipe lands
 * re-inserts the OLD server's chats/handles/messages AFTER the deletes and then writes a NON-NULL
 * sync marker — precisely the two failures the wipe exists to prevent. There is no cancellation to
 * offer here (a run never abandons a page mid-flight), but once `forget()` has cleared the origin
 * every in-flight request fails fast, so the run unwinds in seconds — and the phases that would
 * write WITHOUT a request first ask `sessionEnded` and skip themselves (see `runSync`), because
 * this drain is bounded by the caller's deadline and a big account can outlive it.
 *
 * Covers the AWAITED body of `runSync` plus anything published via `runTrackedSync` (the
 * background catch-up) — BOTH slots, since a wipe cares about every writer, not about which
 * entry point started it.
 *
 * `runSync`'s trailing fire-and-forget `syncContacts()` can still outlive this sync-specific drain,
 * because Android's permission/address-book promises are deliberately not teardown blockers.
 * Contact sync therefore carries the account-generation lease itself: each short DB statement is
 * admitted through the realtime drain, a late native/server result cannot enter the next DB, and
 * the final Direct Share refresh uses the same lease. Device contact rows remain intentionally
 * global across accounts; handle names/server avatars/system shortcuts do not.
 *
 * Never rejects: a run that failed is still an idle one, and the caller only cares that it stopped.
 */
export async function awaitSyncIdle(): Promise<void> {
  // Wait REPEATEDLY, not once: a run can be chained/published while we are awaiting its predecessor.
  // The caller owns the 20-second deadline; returning early after an arbitrary number of chains
  // would falsely report idle and let a still-live account-A page land after the wipe.
  while (syncInFlight || trackedInFlight || targetedRepairInFlight || auxiliaryInFlight.size > 0) {
    const auxiliary = [...auxiliaryInFlight];
    // Never rethrows — a failed run is still an idle one; the caller only needs it to have
    // STOPPED writing.
    await Promise.all([
      settledAll([syncInFlight, trackedInFlight, targetedRepairInFlight]),
      ...auxiliary.map((run) => run.catch(() => undefined)),
    ]);
  }
}

/**
 * Auto-resume hook (reachability watch / socket reconnect): kick a sync unless one is already in
 * flight or just finished — so connectivity coming back re-syncs without a manual pull.
 */
export function maybeResumeSync(): void {
  if (syncInFlight || trackedInFlight || targetedRepairInFlight) return;
  if (Date.now() - lastSyncAt < RESUME_MIN_INTERVAL_MS) return;
  void startSync();
}

interface SyncRunOptions {
  readonly repair?: boolean;
  readonly expectedEpoch?: number;
  readonly accountLease?: RealtimeDeliveryLease;
  readonly shouldCancel?: () => boolean;
  readonly signal?: AbortSignal;
}

type SyncRunOutcome = 'running' | 'completed' | 'cancelled' | 'stale' | 'failed';

async function runSync(options: SyncRunOptions = {}): Promise<void> {
  const sync = useSyncStore.getState();
  // Ordinary sync has no user cancellation, and `forget()` only waits 20s for one to unwind before
  // wiping the DB — so a run can still be alive after the session it belongs to is gone (or
  // replaced). Every phase
  // that FETCHES before it writes is already neutralised by the credential clear (a reset origin
  // builds a relative URL, so the request fails), but the phases that write from memory or from the
  // local DB are not: they would re-create the previous account's rows after the wipe. This is how
  // they find out. Captured here, not at `startSync`, so it names the session the work is actually
  // being done under.
  //
  // Compared by EPOCH, not by origin: `reset()` then `connected()` to the same server restores an
  // identical origin string, so an origin comparison went FALSE again exactly when the run was at
  // its most dangerous — the wipe had already emptied the DB, and the closing phases would put the
  // pre-wipe chat snapshot back and commit a marker over the reset. The epoch never repeats.
  const repair = options.repair === true;
  const epochAtStart = options.expectedEpoch ?? sessionAccessors.getEpoch();
  const accountLease = options.accountLease ?? captureRealtimeDeliveryLease();
  const sessionEnded = (): boolean =>
    sessionAccessors.getEpoch() !== epochAtStart || !accountLease.isCurrent();
  const cancelled = (): boolean => options.shouldCancel?.() ?? false;
  const shouldAbort = (): boolean => sessionEnded() || cancelled();
  const stoppedOutcome = (): SyncRunOutcome => (cancelled() ? 'cancelled' : 'stale');
  let outcome: SyncRunOutcome = 'running';
  let failureMessage = 'Sync failed';
  let rebuiltRepairMarker: SyncMarker | null = null;
  const repairReconciliation: {
    exposure: FullRepairPruneExposure | null;
    confirmedView: FullSyncServerView | null;
  } = { exposure: null, confirmedView: null };

  try {
    if (shouldAbort()) {
      outcome = stoppedOutcome();
      return;
    }
    const db = await ensureDatabase();
    if (shouldAbort()) {
      outcome = stoppedOutcome();
      return;
    }
    const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
    // The session passed bootstrap's durable credential gates before startSync. Recover exact-file
    // retirements only now—not from generic DB open paths used by locked/forgotten callers.
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[sync] attachment cache retirement deferred', error));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((error) => logger.debug('[sync] attachment cache recovery deferred', error));
    if (shouldAbort()) {
      outcome = stoppedOutcome();
      return;
    }
    const api = httpSyncApi(http);
    if (repair) sync.beginRepair();
    else sync.begin();

    if (repair) {
      sync.noteRepair(
        'Preparing full cursor rebuild',
        'Keeping local customizations and deletion protections in place.',
      );
      sync.noteRepair(
        'Downloading all chats and messages',
        'The previous sync marker stays usable until the full download succeeds.',
      );
    }

    const marker = await getSyncMarker(db);
    if (shouldAbort()) {
      outcome = stoppedOutcome();
      return;
    }
    const isFirstSync =
      repair || (marker.lastSyncedRowId == null && marker.lastSyncedTimestamp == null);
    if (isFirstSync) {
      // Honor the "Messages per Chat" initial-sync cap (0 = all). Full history still backfills on
      // demand when a chat is opened, so a cap only bounds the first bulk pass.
      const perChat = useSyncSettingsStore.getState().messagesPerChat;
      if (repair) {
        repairReconciliation.exposure = await captureFullRepairPruneExposure(
          db,
          () => !shouldAbort(),
        );
        if (shouldAbort()) {
          outcome = stoppedOutcome();
          return;
        }
      }

      const firstRepair: {
        view: FullSyncServerView | null;
        marker: SyncMarker | null;
      } = { view: null, marker: null };
      let result = await fullSync(db, api, {
        onProgress: (p) => {
          if (!shouldAbort()) sync.progress(p);
        },
        shouldAbort,
        // Pass zero rather than omitting it: zero is the user's explicit "All" choice, while an
        // absent engine option deliberately keeps the conservative 100-message default.
        // A repair is explicitly a FULL re-download, independent of the first-install tuning.
        maxMessagesPerChat: repair ? 0 : perChat,
        failOnChatError: repair,
        commitMarker: !repair,
        signal: options.signal,
        onServerMarker: repair
          ? (nextMarker) => {
              firstRepair.marker = nextMarker;
            }
          : undefined,
        onServerView: repair
          ? (view) => {
              firstRepair.view = view;
            }
          : undefined,
      });
      if (shouldAbort()) {
        outcome = stoppedOutcome();
        return;
      }
      if (repair) {
        if (firstRepair.marker == null || firstRepair.view == null) {
          throw new Error('Repair finished without a server-derived sync marker.');
        }
        sync.noteRepair(
          'Confirming a stable server view',
          'A second complete pass must match before stale local rows can be removed.',
        );
        const secondRepair: {
          view: FullSyncServerView | null;
          marker: SyncMarker | null;
        } = { view: null, marker: null };
        result = await fullSync(db, api, {
          onProgress: (p) => {
            if (!shouldAbort()) sync.progress(p);
          },
          shouldAbort,
          maxMessagesPerChat: 0,
          failOnChatError: true,
          commitMarker: false,
          signal: options.signal,
          onServerMarker: (nextMarker) => {
            secondRepair.marker = nextMarker;
          },
          onServerView: (view) => {
            secondRepair.view = view;
          },
        });
        if (shouldAbort()) {
          outcome = stoppedOutcome();
          return;
        }
        if (secondRepair.marker == null || secondRepair.view == null) {
          throw new Error('Repair validation finished without a complete server view.');
        }
        if (!sameFullSyncServerView(firstRepair.view, secondRepair.view)) {
          throw new Error(
            'The server changed while repair was reading it. Restart repair to avoid removing current data.',
          );
        }
        rebuiltRepairMarker = secondRepair.marker;
        repairReconciliation.confirmedView = secondRepair.view;
        sync.noteRepair('Reconciling deletions', 'Chat and message download finished.');
      } else {
        sync.done(result);
      }
    } else {
      // Refresh the FULL chat list first so conversations the interrupted first sync never reached
      // (disproportionately older SMS threads) appear in the inbox; their history backfills on open.
      // Best-effort — a failure here must not block the incremental message sync below.
      await syncAllChats(db, api, 200, shouldAbort, options.signal).catch((e) =>
        logger.debug('[sync] chat-list refresh failed', e),
      );
      if (shouldAbort()) {
        outcome = stoppedOutcome();
        return;
      }
      const version =
        useSessionStore.getState().serverInfo?.server_version ??
        (await api.serverVersion(options.signal));
      if (shouldAbort()) {
        outcome = stoppedOutcome();
        return;
      }
      // Per-page progress so the DB-reactive inbox hydrates mid-sync (not just at the end).
      const result = await incrementalSync(db, api, {
        serverVersion: version,
        onProgress: (p) => {
          if (!shouldAbort()) sync.progress(p);
        },
        shouldAbort,
        signal: options.signal,
      });
      if (!shouldAbort()) sync.done(result);
    }

    // R1 deletion catch-up: apply `message-deleted` events missed while the app was dead or
    // app-locked (the locked FCM path never touches the DB — see DbEventSink). Runs AFTER the
    // chat/message sync so tombstones land on freshly-synced rows. Gated on the server's
    // `supports_message_deleted` capability (older servers would 404); best-effort — a failure
    // must never flip the sync status, which `sync.done` already reported above.
    //
    // Skipped outright once the session has ended: its FIRST run seeds the kv watermark with NO
    // network call at all, so it is another write the credential clear cannot stop — it would
    // re-seed the key `clearLocalCache` had just removed, with the old server's clock.
    if (!shouldAbort()) {
      const deletionCatchup = syncDeletedMessages(db, api, {
        supported: sessionAccessors.messageDeletedSupported(),
        shouldAbort,
        signal: options.signal,
      });
      if (repair) await deletionCatchup;
      else await deletionCatchup.catch((e) => logger.debug('[sync] deletion catch-up failed', e));
      if (!shouldAbort()) {
        const retireInactive = attachmentCacheCoordinator.retireInactiveEntries(db, {
          scope: attachmentCacheScope,
        });
        if (repair) await retireInactive;
        else {
          await retireInactive.catch((error) =>
            logger.debug('[sync] deleted-message cache retirement deferred', error),
          );
        }
        const drainRetirements = attachmentCacheCoordinator.drainDueRetirements(db, {
          scope: attachmentCacheScope,
        });
        if (repair) await drainRetirements;
        else {
          await drainRetirements.catch((error) =>
            logger.debug('[sync] deleted-message cache cleanup deferred', error),
          );
        }
      }
    }
    if (shouldAbort()) {
      outcome = stoppedOutcome();
      return;
    }
    if (repair) {
      const repairExposure = repairReconciliation.exposure;
      const confirmedRepairView = repairReconciliation.confirmedView;
      if (repairExposure == null || confirmedRepairView == null) {
        throw new Error('Repair finished without a confirmed reconciliation view.');
      }
      sync.noteRepair(
        'Removing stale local rows',
        'The two complete server passes matched; only pre-existing absent rows are eligible.',
      );
      const reconciliation = await reconcileFullRepairPruneExposure(
        db,
        repairExposure,
        {
          chatGuids: new Set(confirmedRepairView.chats.keys()),
          messageGuids: new Set(confirmedRepairView.messages.keys()),
          attachmentGuidsByMessage: confirmedRepairView.attachmentsByMessage,
        },
        () => !shouldAbort(),
      );
      if (shouldAbort()) {
        outcome = stoppedOutcome();
        return;
      }
      // Reconciliation can orphan cached attachment paths. Let the existing short DB owners mark
      // and settle those exact files; all native delete work remains outside their transactions.
      await attachmentCacheCoordinator.retireInactiveEntries(db, {
        scope: attachmentCacheScope,
      });
      await attachmentCacheCoordinator.drainDueRetirements(db, {
        scope: attachmentCacheScope,
      });
      sync.noteRepair(
        'Finalizing local cache',
        `Removed ${reconciliation.messagesRemoved} messages, ${reconciliation.attachmentsRemoved} attachments, and ${reconciliation.chatsRemoved} chats; retained ${reconciliation.chatShellsRetired} customized chat shells and ${reconciliation.chatsPreservedForLocalWork} chats with local work.`,
      );
      if (rebuiltRepairMarker == null) {
        throw new Error('Repair finished without a server-derived sync marker.');
      }
      const finalRepairMarker = rebuiltRepairMarker;
      // The only repair marker write: one short guarded owner after every page and finalizer
      // succeeded. A cancel/failure/process death before this point leaves the old marker usable.
      await withDbTransaction(
        db,
        (context) => setSyncMarkerWithinTransaction(context, finalRepairMarker),
        () => !shouldAbort(),
      );
      // Once the guarded commit returns, the repair is complete. A cancel tap racing immediately
      // after this terminal commit is too late and correctly resolves to Complete, not Cancelled.
      outcome = 'completed';
      sync.noteRepair('Repair complete', 'Installed the rebuilt server-derived sync marker.');
      return;
    }
    outcome = 'completed';
  } catch (e) {
    // A retired account's late failure belongs to that retired run, not to the replacement
    // account's banner. Its DB writes are guarded separately in the engine.
    if (cancelled()) outcome = 'cancelled';
    else if (sessionEnded()) outcome = 'stale';
    else {
      failureMessage = e instanceof Error ? e.message : 'Sync failed';
      outcome = 'failed';
      if (!repair) sync.fail(failureMessage);
    }
  } finally {
    // Resolve device contacts onto handles so chats — especially GROUPS — show contact names
    // instead of raw phone numbers in the inbox/headers. Fire-and-forget with its own catch:
    // a denied contacts permission (or any IO error) must NOT affect the message-sync status.
    // Runs after connect and on every boot-with-session (both call startSync); idempotent.
    if (!shouldAbort()) {
      void syncContacts().catch((e) => logger.debug('[contacts] auto-sync skipped', e));
    }

    // Never let an old account publish into a replacement account's global store. A same-epoch
    // lease retirement (for example a transport rotation) is still useful feedback to this account.
    if (repair && sessionAccessors.getEpoch() === epochAtStart) {
      if (outcome === 'completed') sync.finishRepair();
      else if (outcome === 'cancelled') sync.cancelRepair();
      else if (outcome === 'failed') sync.failRepair(failureMessage);
      else if (outcome === 'stale') {
        sync.cancelRepair('Repair stopped because the connection changed. Restart it to continue.');
      }
    }
  }
}

/**
 * Backfill ONE chat's message history from the server, on demand (called when a thread opens).
 * Makes a thread show its full history even if the large initial sync hasn't reached it yet or
 * was interrupted — independent of the global sync marker. Best-effort; never throws to the UI.
 */
export async function ensureChatSynced(chatGuid: string): Promise<number> {
  const epochAtStart = sessionAccessors.getEpoch();
  const sessionEnded = (): boolean => {
    const session = useSessionStore.getState();
    return session.epoch !== epochAtStart || session.origin == null || session.password == null;
  };
  return runTrackedAuxiliarySync(async () => {
    try {
      if (sessionEnded()) return 0;
      const db = await ensureDatabase();
      if (sessionEnded()) return 0;
      return await syncChatMessages(db, httpSyncApi(http), chatGuid, {
        maxMessages: 500,
        shouldAbort: sessionEnded,
      });
    } catch (e) {
      // A retired request is expected teardown noise and must not become account B's diagnostic.
      if (!sessionEnded()) logger.warn('[sync] on-demand chat backfill failed', e);
      return 0;
    }
  });
}
