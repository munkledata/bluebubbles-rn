import { logger } from '@core/secure';
import { getSyncMarker } from '@db/repositories';
import { useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { syncContacts } from './contacts/contactsService';
import { fullSync, httpSyncApi, incrementalSync, syncAllChats, syncChatMessages } from './sync';

/** Run a full sync on first connect, otherwise an incremental catch-up sync. */
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;
const RESUME_MIN_INTERVAL_MS = 10_000;

/**
 * Coalesced sync entrypoint. Concurrent callers (boot, pull-to-refresh, reconnect-resume) share ONE
 * in-flight run rather than stacking overlapping syncs that would hammer the server.
 */
export function startSync(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync().finally(() => {
    syncInFlight = null;
    lastSyncAt = Date.now();
  });
  return syncInFlight;
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
 * Auto-resume hook (reachability watch / socket reconnect): kick a sync unless one is already in
 * flight or just finished — so connectivity coming back re-syncs without a manual pull.
 */
export function maybeResumeSync(): void {
  if (syncInFlight) return;
  if (Date.now() - lastSyncAt < RESUME_MIN_INTERVAL_MS) return;
  void startSync();
}

async function runSync(): Promise<void> {
  const sync = useSyncStore.getState();
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
