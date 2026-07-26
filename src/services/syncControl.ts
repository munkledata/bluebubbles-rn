import { logger } from '@core/secure';
import { getSyncMarker } from '@db/repositories';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { syncContacts } from './contacts/contactsService';
import {
  fullSync,
  httpSyncApi,
  incrementalSync,
  syncAllChats,
  syncChatMessages,
  syncDeletedMessages,
} from './sync';

/**
 * TWO slots, deliberately — they hold DIFFERENT work and must never substitute for each other.
 *
 * `syncInFlight` holds a full `runSync` (chat-list refresh + full/incremental branch + deletion
 * catch-up + the trailing contacts sync). `trackedInFlight` holds an out-of-band run published via
 * {@link runTrackedSync} — today the background WorkManager task, which pages ONLY an incremental
 * catch-up. Both are drained by {@link awaitSyncIdle}, which is what `forget()` needs; but a
 * foreground caller must never be handed the background run as if it were its own. It was, once:
 * one shared slot meant a boot / pull-to-refresh / resume arriving while the 15-minute task held
 * it returned that promise and did none of the pipeline — no chat-list refresh, no deletion
 * catch-up, no contacts sync, no first-sync branch, and no begin/progress/done for the banner, so
 * a refresh spinner tracked work the user had not asked for and cleared having done nothing.
 */
let syncInFlight: Promise<void> | null = null;
/**
 * The origin `syncInFlight` was published under. A run is only shareable with a caller belonging to
 * the SAME session — see {@link startSync}.
 */
let inFlightOrigin: string | null = null;
let trackedInFlight: Promise<void> | null = null;
let lastSyncAt = 0;
const RESUME_MIN_INTERVAL_MS = 10_000;
/** How many chained runs `awaitSyncIdle` will sit through before giving up on a quiet moment. */
const MAX_IDLE_WAITS = 3;

/** Resolve once every currently-published run has STOPPED (settled), however it settled. */
function settledAll(runs: Array<Promise<void> | null>): Promise<unknown> {
  return Promise.all(runs.map((p) => (p ? p.catch(() => undefined) : Promise.resolve())));
}

/**
 * Coalesced sync entrypoint. Concurrent callers (boot, pull-to-refresh, reconnect-resume) share ONE
 * in-flight run rather than stacking overlapping syncs that would hammer the server.
 *
 * Coalescing applies to OTHER foreground callers only. A tracked (background) run is waited on but
 * never returned in place of this one — see the slot comment above.
 *
 * And only to callers of the SAME SESSION. A run is bound to the origin it was published under,
 * because the slot can outlive its account: `forget()` gives a dying sync 20 seconds to unwind and
 * then wipes anyway, so a large account's backfill is routinely still in the slot when the user
 * connects to the next server. Coalescing on nothing but "a promise is present" handed `connect()`
 * the PREVIOUS account's doomed run as if it were the new server's initial sync — which therefore
 * never happened. Silently, too: that run resolves normally (its per-chat errors are isolated) and
 * reports `done`, so the banner clears over an empty inbox and nothing re-kicks it until a
 * pull-to-refresh or a relaunch. A mismatch chains behind the stale run instead of ignoring it, so
 * both stay visible to `awaitSyncIdle` and neither pages alongside the other.
 */
export function startSync(): Promise<void> {
  const origin = sessionAccessors.getOrigin();
  if (syncInFlight && inFlightOrigin === origin) return syncInFlight;
  // Serialize behind a background catch-up (and behind a previous session's run) rather than
  // paging alongside it: both walk the same cursor, so overlapping them doubles the fetching and
  // interleaves two writers' marker writes.
  const slot: Promise<void> = settledAll([syncInFlight, trackedInFlight])
    .then(runSync)
    .finally(() => {
      // Only the run that still OWNS the slot may clear it — a successor may already have
      // published itself here, and nulling that out would make `awaitSyncIdle` — and therefore
      // `forget()` — blind to a pipeline that is still writing.
      if (syncInFlight === slot) {
        syncInFlight = null;
        inFlightOrigin = null;
      }
      lastSyncAt = Date.now();
    });
  syncInFlight = slot;
  inFlightOrigin = origin;
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
  const slot: Promise<void> = settledAll([syncInFlight, trackedInFlight])
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
 * `runSync`'s trailing fire-and-forget `syncContacts()` can still outlive this. Its DB writes are
 * survivable (it rewrites `contacts`, which the wipe keeps, and UPDATEs handle rows, which an
 * emptied `handles` table matches none of), but the run also touches state OUTSIDE the DB — a
 * server round trip for avatars, and the system's Direct Share shortcuts. Those are guarded at the
 * source: `runContactsSync` publishes shortcuts only while a session exists, and `forget()` clears
 * the credentials before it drains, so a trailing run cannot re-publish the old account's chips.
 *
 * Never rejects: a run that failed is still an idle one, and the caller only cares that it stopped.
 */
export async function awaitSyncIdle(): Promise<void> {
  // Wait the slots out REPEATEDLY, not once: a run can be chained into either slot while we are
  // already awaiting its predecessor, and returning at that moment would hand the wipe a pipeline
  // that is still paging. Bounded, so a pathological chain can never wedge Disconnect (the caller
  // applies its own deadline on top).
  for (let waits = 0; waits < MAX_IDLE_WAITS && (syncInFlight || trackedInFlight); waits++) {
    // Never rethrows — a failed run is still an idle one; the caller only needs it to have
    // STOPPED writing.
    await settledAll([syncInFlight, trackedInFlight]);
  }
}

/**
 * Auto-resume hook (reachability watch / socket reconnect): kick a sync unless one is already in
 * flight or just finished — so connectivity coming back re-syncs without a manual pull.
 */
export function maybeResumeSync(): void {
  if (syncInFlight || trackedInFlight) return;
  if (Date.now() - lastSyncAt < RESUME_MIN_INTERVAL_MS) return;
  void startSync();
}

async function runSync(): Promise<void> {
  const sync = useSyncStore.getState();
  // Nothing cancels a sync, and `forget()` only waits 20s for one to unwind before wiping the DB —
  // so a run can still be alive after the session it belongs to is gone (or replaced). Every phase
  // that FETCHES before it writes is already neutralised by the credential clear (a reset origin
  // builds a relative URL, so the request fails), but the phases that write from memory or from the
  // local DB are not: they would re-create the previous account's rows after the wipe. This is how
  // they find out. Captured here, not at `startSync`, so it names the session the work is actually
  // being done under.
  const originAtStart = sessionAccessors.getOrigin();
  const sessionEnded = (): boolean => sessionAccessors.getOrigin() !== originAtStart;
  try {
    const db = await ensureDatabase();
    const api = httpSyncApi(http);
    sync.begin();

    const marker = await getSyncMarker(db);
    const isFirstSync = marker.lastSyncedRowId == null && marker.lastSyncedTimestamp == null;
    if (isFirstSync) {
      // Honor the "Messages per Chat" initial-sync cap (0 = all). Full history still backfills on
      // demand when a chat is opened, so a cap only bounds the first bulk pass.
      const perChat = useSyncSettingsStore.getState().messagesPerChat;
      const result = await fullSync(db, api, {
        onProgress: (p) => sync.progress(p),
        shouldAbort: sessionEnded,
        ...(perChat > 0 ? { maxMessagesPerChat: perChat } : {}),
      });
      sync.done(result);
    } else {
      // Refresh the FULL chat list first so conversations the interrupted first sync never reached
      // (disproportionately older SMS threads) appear in the inbox; their history backfills on open.
      // Best-effort — a failure here must not block the incremental message sync below.
      await syncAllChats(db, api).catch((e) => logger.debug('[sync] chat-list refresh failed', e));
      const version =
        useSessionStore.getState().serverInfo?.server_version ?? (await api.serverVersion());
      // Per-page progress so the DB-reactive inbox hydrates mid-sync (not just at the end).
      const result = await incrementalSync(db, api, {
        serverVersion: version,
        onProgress: (p) => sync.progress(p),
      });
      sync.done(result);
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
    if (!sessionEnded()) {
      await syncDeletedMessages(db, api, {
        supported: sessionAccessors.messageDeletedSupported(),
      }).catch((e) => logger.debug('[sync] deletion catch-up failed', e));
    }
  } catch (e) {
    sync.fail(e instanceof Error ? e.message : 'Sync failed');
  }

  // Resolve device contacts onto handles so chats — especially GROUPS — show contact names
  // instead of raw phone numbers in the inbox/headers. Fire-and-forget with its own catch:
  // a denied contacts permission (or any IO error) must NOT affect the message-sync status.
  // Runs after connect and on every boot-with-session (both call startSync); idempotent.
  void syncContacts().catch((e) => logger.debug('[contacts] auto-sync skipped', e));
}

/**
 * Backfill ONE chat's message history from the server, on demand (called when a thread opens).
 * Makes a thread show its full history even if the large initial sync hasn't reached it yet or
 * was interrupted — independent of the global sync marker. Best-effort; never throws to the UI.
 */
export async function ensureChatSynced(chatGuid: string): Promise<number> {
  try {
    const db = await ensureDatabase();
    return await syncChatMessages(db, httpSyncApi(http), chatGuid, { maxMessages: 500 });
  } catch (e) {
    logger.warn('[sync] on-demand chat backfill failed', e);
    return 0;
  }
}
