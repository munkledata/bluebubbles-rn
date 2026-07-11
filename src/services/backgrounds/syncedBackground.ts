import { Directory, File, Paths } from 'expo-file-system';
import { chatsApi } from '@core/api';
import { logger } from '@core/secure';
import {
  getChatTheme,
  getSyncedBackgroundState,
  persistServerChat,
  setBackgroundIsLight,
  setSyncedBackgroundUri,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { HttpClient } from '@core/api';
import { computeBackgroundIsLight } from './luminance';

/** Only GUID-shaped channel ids are used in a filename (defensive; the value is server-supplied). */
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Ensure a chat's macOS 26 synced "transcript background" is downloaded locally, so the chat
 * screen can render it (via `useChatBackgroundUri` → local `background_uri` ?? this synced uri).
 *
 * The server exposes the current `backgroundChannelGuid` on each chat (persisted by upsertChats
 * into `synced_background_channel` — the version key). This compares that to the file already on
 * disk and only downloads when it changed. Auth rides the header (`http.buildHeaders()`), so the
 * URL stays clean — same pattern as server contact avatars. Best-effort: any failure is logged
 * and swallowed (a missing background must never break opening a chat).
 *
 * - no channel  → clear any stale local uri (the background was removed).
 * - channel set → download `<guid>-<channel>.jpg` if not already present, then point the DB at it.
 */
export async function ensureSyncedBackground(
  http: HttpClient,
  db: AppDatabase,
  guid: string,
): Promise<void> {
  try {
    // Refresh THIS chat's metadata FIRST. The version key (server `backgroundChannelGuid` →
    // `synced_background_channel`) is written ONLY by upsertChats, which the chat-open path never
    // runs (it syncs messages only). Without this, a background a participant set/changed after the
    // last full sync is invisible on open — a null/stale channel makes the compare below a no-op —
    // until some unrelated sync happens. The server always serializes the channel on the chat, so
    // one small GET refreshes it; the `alreadyCurrent` check still skips a redundant re-download.
    try {
      await persistServerChat(db, await chatsApi.getChat(http, guid));
    } catch {
      // best-effort: proceed with whatever channel we already have if the refresh fails.
    }

    const state = await getSyncedBackgroundState(db, guid);
    const channel = state?.channel ?? null;

    // Background removed on the server → drop the local reference (file left for GC; harmless).
    if (!channel) {
      if (state?.uri) await setSyncedBackgroundUri(db, guid, null);
      return;
    }

    // Already have the file for THIS channel? (filename embeds the channel).
    const alreadyCurrent = !!state?.uri && state.uri.includes(sanitize(channel));

    let effectiveUri = state?.uri ?? null;
    if (!alreadyCurrent) {
      const dir = new Directory(Paths.document, 'synced-backgrounds');
      dir.create({ intermediates: true, idempotent: true });
      const dest = new File(dir, `${sanitize(guid)}-${sanitize(channel)}.jpg`);
      if (!dest.exists) {
        const task = File.createDownloadTask(chatsApi.chatBackgroundUrl(http, guid), dest, {
          headers: http.buildHeaders(),
        });
        const file = await task.downloadAsync();
        // A 404 (no background / asset not ready yet) yields no usable file — bail without writing.
        if (!file || !dest.exists) return;
      }
      await setSyncedBackgroundUri(db, guid, dest.uri);
      effectiveUri = dest.uri;
    }

    // Wallpaper luminance (for legible overlay text). The LOCAL background (the user's own pick)
    // takes precedence and owns its own luminance (set in chat-settings), so only manage the
    // synced one when there's no local override. Recompute when we just downloaded a new channel,
    // or when it's still unknown for an already-cached file (e.g. a background from before this column).
    if (effectiveUri) {
      const theme = await getChatTheme(db, guid);
      if (!theme?.backgroundUri && (!alreadyCurrent || theme?.backgroundIsLight == null)) {
        const isLight = await computeBackgroundIsLight(effectiveUri);
        if (isLight !== null) await setBackgroundIsLight(db, guid, isLight);
      }
    }
  } catch (e) {
    logger.warn('[background] synced-background fetch failed', e);
  }
}
