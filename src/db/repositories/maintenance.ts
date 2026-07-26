import { eq, like, sql } from 'drizzle-orm';
import {
  attachments,
  chatHandles,
  chats,
  errorReports,
  handles,
  kv,
  messages,
  outgoingQueue,
  reminders,
  scheduledMessages,
  urlPreviews,
} from '../schema';
import { withDbTransaction } from '../transaction';
import type { AppDatabase } from '../types';
import { setSyncMarker } from './sync';

// ---- Whole-cache maintenance ----------------------------------------------

/**
 * kv key holding the deletion catch-up watermark. Duplicated from `DELETIONS_SYNCED_AT_KEY`
 * (`src/services/sync/engine.ts`) rather than imported, because `src/db` must never import
 * `src/services` — the sync engine imports THIS layer, so the reverse edge would be a cycle.
 * `test/db/clearLocalCache.test.ts` asserts the two strings still agree.
 */
export const DELETIONS_WATERMARK_KV_KEY = 'sync.deletionsSyncedAt';

/**
 * Prefix of the per-chat composer-draft kv keys (`draft.<chat guid>`), written by the chat screen
 * (`app/(app)/chat/[guid].tsx`). Duplicated here for the same no-cycle reason as the watermark key
 * above — that writer lives in the route layer, which `src/db` must not reach into.
 */
export const DRAFT_KV_PREFIX = 'draft.';

/**
 * Drop every row this device cached FROM a server, so the next connection starts clean.
 *
 * Called from `forget()`. Without it, Disconnect only clears the credentials: connecting to a
 * DIFFERENT server afterwards leaves the previous account's conversations, message bodies and
 * attachments in the inbox, interleaved with the new server's — on a shared device that is a
 * straight leak of someone else's threads. The stale `sync_markers` row is just as bad: it sends
 * the next sync down the INCREMENTAL branch with a cursor built from the OLD server's max ROWID,
 * so the new server's older messages are never fetched at all.
 *
 * Deletes CHILDREN-FIRST. FK enforcement is on (`PRAGMA foreign_keys = ON`, database.ts) and
 * `messages.handle_id` references `handles` with NO cascade, so wiping `handles` before `messages`
 * raises a constraint error. The order also front-loads the tables that actually carry content, so
 * a mid-way failure cannot leave message bodies behind.
 *
 * KEPT: the vault (`forget()` clears the credentials itself), `contacts` (the device address book,
 * owned by contact sync), `themes` (user-authored presets) and the GLOBAL `kv` settings rows.
 *
 * NOT kept, and worth stating plainly because no re-sync can bring it back: the device-local
 * columns of a chat go with the chat row — pin/archive/mute, custom name and colour, per-chat theme
 * tokens and wallpaper (`upsertChats` deliberately keeps them OUT of its conflict set, so a re-sync
 * never rewrites them). Preserving them across the wipe is not an option: a 1:1 chat guid is
 * `service;-;address`, i.e. byte-identical across servers, so the NEXT account's thread with the
 * same number would inherit the previous user's custom name, colour and wallpaper — the exact
 * cross-account leak this wipe exists to close. Reminders, scheduled messages, queued unsent
 * messages and composer drafts are destroyed for the same reason. The Disconnect confirmation
 * (`app/(app)/settings.tsx`) names all of it, so the destruction is at least consented to.
 *
 * `messages_fts` needs no explicit pass — the `messages_ad` AFTER DELETE trigger removes each row
 * from the FTS index, and SQLite's truncate optimization (which would skip triggers on a bare
 * `DELETE FROM`) is disabled on any table that has triggers.
 *
 * NOT one transaction, and that is deliberate: this deletes every message on the device, and
 * `withDbTransaction` is a process-wide mutex on one shared connection — a transaction that long
 * would block every other writer for the whole wipe and enrol each of their autocommit writes in
 * its atomicity. It is therefore a sequence of independent statements, which means an outcome
 * BETWEEN them is reachable (see the caller: `forget()` confirms the result and re-runs).
 */
export async function clearLocalCache(db: AppDatabase): Promise<void> {
  // FIRST, before a single delete, and the ONE statement here that takes the write lock. What that
  // buys is narrow and worth stating exactly: it cannot be joined to a neighbouring writer's open
  // transaction and undone by that writer's rollback. Everything below is a plain autocommit and
  // CAN be.
  //
  // Marker-first also bounds what a mid-wipe process death (the user swipes the app away, Android
  // reclaims it) can leave behind — a wipe on a large account is seconds of work, since the FTS
  // delete trigger runs per message row. Reset LAST and a death right after `delete(messages)`
  // leaves zero messages PLUS the old server's ROWID cursor, sending the next sync down the
  // incremental branch so the history just deleted is never re-fetched. Reset FIRST and every
  // partial outcome still re-syncs correctly — but it is NOT harmless: rows that survive are the
  // previous account's, which is the leak this whole function exists to close, so a partial wipe
  // must be detected and repeated rather than tolerated (`localCacheDirty`).
  //
  // The row itself must SURVIVE (id = 1, seeded by 0001_init): `setSyncMarker` is an UPDATE, so
  // deleting it would silently stop every future marker write.
  await withDbTransaction(db, () =>
    setSyncMarker(db, { lastSyncedRowId: null, lastSyncedTimestamp: null }),
  );

  await db.delete(attachments);
  await db.delete(messages);
  await db.delete(chatHandles);
  await db.delete(chats);
  await db.delete(handles);
  // Queued work is addressed to the OLD server: an undrained outgoing row would be re-sent to
  // whichever server connects next, and scheduled messages / reminders point at chat guids that
  // no longer resolve. Reminders additionally cache a message preview + sender name.
  await db.delete(outgoingQueue);
  await db.delete(scheduledMessages);
  await db.delete(reminders);
  await db.delete(urlPreviews);
  // Captured error reports are addressed to the old server too, and nothing binds a row to the
  // origin it was captured under. They pile up indefinitely when that server has ingestion
  // disabled (it acks them as `disabled` without burning an attempt), and `flushErrorReports`
  // gates only on "are we connected now" — so the whole backlog from someone else's session would
  // be POSTed to the NEXT server's operator, stacks and meta included.
  await db.delete(errorReports);

  // The deletion watermark is a server-relative timestamp. Removing the key makes the next run
  // re-seed it to now() instead of replaying the new server's entire deletion history.
  await db.delete(kv).where(eq(kv.key, DELETIONS_WATERMARK_KV_KEY));
  // Composer drafts are the one CHAT-SCOPED thing in kv: unsent, user-authored text about a chat
  // whose row was deleted five statements ago, keyed by a guid that is identical across servers.
  // Left behind, the next account opening its own thread with the same number finds the previous
  // user's draft pre-filled in the composer — and the rows would otherwise accumulate forever, one
  // per chat ever typed in, outliving the chat itself.
  await db.delete(kv).where(like(kv.key, `${DRAFT_KV_PREFIX}%`));
}

/**
 * Did {@link clearLocalCache} actually take? Cheap enough to call after every wipe (three counts in
 * one round trip).
 *
 * There is no way to make the wipe atomic without holding the process-wide write lock for its whole
 * multi-second run (see the note on `clearLocalCache`), so the wipe is CONFIRMED instead of trusted.
 * Three things can leave it half-done, none of which raises anything the caller sees:
 *  - a statement lands inside a neighbouring writer's open transaction and dies with its ROLLBACK;
 *  - `delete(handles)` throws on the FK from `messages.handle_id` (NO ACTION) because a concurrent
 *    sync slice inserted messages after `delete(messages)` ran — `forget()` logs that at `warn` and
 *    carries on, leaving chats, queued sends, reminders and drafts untouched;
 *  - the process dies part-way through.
 * Every one of them ends with the PREVIOUS account's rows still on the device, which is exactly what
 * the wipe exists to prevent — so the caller re-runs on a dirty answer.
 *
 * Checks the three tables that carry identity (chats/messages/handles) plus the sync marker; the
 * remaining tables are emptied between them, so a survivor there implies a survivor here.
 */
export async function localCacheDirty(db: AppDatabase): Promise<boolean> {
  const rows = await db.all<{ dirty: number }>(sql`
    SELECT (SELECT COUNT(*) FROM chats)
         + (SELECT COUNT(*) FROM messages)
         + (SELECT COUNT(*) FROM handles)
         + (SELECT COUNT(*) FROM sync_markers
             WHERE last_synced_row_id IS NOT NULL OR last_synced_timestamp IS NOT NULL)
        AS dirty
  `);
  return (rows[0]?.dirty ?? 0) > 0;
}
