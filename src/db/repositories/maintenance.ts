import { eq, sql } from 'drizzle-orm';
import { kv } from '../schema';
import { withDbTransaction, withDbWriteLock } from '../transaction';
import type { AppDatabase } from '../types';
import { setSyncMarkerWithinTransaction } from './sync';

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
 * Prefix of encrypted FaceTime notification routes. Defined in the DB layer so notification
 * routing can import the same value without reversing the dependency: these rows contain an old
 * server's call UUID and must not survive when native notification cleanup is unavailable.
 */
export const NOTIFICATION_ROUTE_KV_PREFIX = 'notification.route.v2.facetime.';

/** Maximum rows one cache-delete statement may hold the shared write queue for. */
const CACHE_DELETE_BATCH_SIZE = 500;

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
 * NOT one SQL transaction, and that is deliberate: this deletes every message on the device, so a
 * transaction that long would build a large rollback journal and enrol unrelated plain writes in
 * its atomicity. The statements commit independently, which means an outcome BETWEEN them remains
 * reachable (see the caller: `forget()` confirms the result and re-runs).
 *
 * Each statement takes and releases the shared writer queue: this function opens one short marker
 * transaction, then the bounded deletes use `withDbWriteLock`. No serialized transaction can open
 * around a delete and roll it back after this function reports success, while an unbounded
 * whole-cache lock cannot monopolize the queue or look permanently wedged to its watchdog. Ordinary
 * writers not yet migrated to the queue can still interleave, which is why the separate,
 * queue-fenced `localCacheDirty` confirmation remains load-bearing.
 */
export async function clearLocalCache(db: AppDatabase): Promise<void> {
  // FIRST, before a single delete. Marker-first bounds what a mid-wipe process death (the user
  // swipes the app away, Android reclaims it) can leave behind — a wipe on a large account is
  // seconds of work, since the FTS delete trigger runs per message row. Reset LAST and a death
  // right after `delete(messages)` leaves zero messages PLUS the old server's ROWID cursor,
  // sending the next sync down the incremental branch so the history just deleted is never
  // re-fetched. Reset FIRST and every partial outcome still re-syncs correctly — but it is NOT
  // harmless: rows that survive are the previous account's, so `localCacheDirty` must detect and
  // repeat a partial wipe.
  //
  // The row itself must SURVIVE (id = 1, seeded by 0001_init): the scoped marker write is an UPDATE,
  // so deleting it would silently stop every future marker write.
  await withDbTransaction(db, (context) =>
    setSyncMarkerWithinTransaction(context, {
      lastSyncedRowId: null,
      lastSyncedTimestamp: null,
    }),
  );

  // Validated incoming envelopes may still contain message text. Remove them before the larger
  // content tables; a terminal receipt is account-scoped too and must never suppress account B.
  let deletedIncomingEvents = CACHE_DELETE_BATCH_SIZE;
  while (deletedIncomingEvents === CACHE_DELETE_BATCH_SIZE) {
    deletedIncomingEvents = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM incoming_event_queue
         WHERE rowid IN (
           SELECT rowid FROM incoming_event_queue ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  // Temp → real identity mappings are account-scoped even though they deliberately have no
  // message FK (they must survive ordinary chat purges). Remove them explicitly so identical GUID
  // bytes under a later account cannot redirect a destructive action at that account's message.
  let deletedMessageGuidAliases = CACHE_DELETE_BATCH_SIZE;
  while (deletedMessageGuidAliases === CACHE_DELETE_BATCH_SIZE) {
    deletedMessageGuidAliases = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM message_guid_aliases
         WHERE rowid IN (
           SELECT rowid FROM message_guid_aliases
            ORDER BY rowid
            LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  // Server-deletion GUIDs must survive ordinary message/chat purges, but never an account change:
  // the same GUID bytes under account B must not inherit account A's hidden-message decision.
  let deletedMessageDeletionLedger = CACHE_DELETE_BATCH_SIZE;
  while (deletedMessageDeletionLedger === CACHE_DELETE_BATCH_SIZE) {
    deletedMessageDeletionLedger = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM message_deletion_ledger
         WHERE rowid IN (
           SELECT rowid FROM message_deletion_ledger
            ORDER BY rowid
            LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedCacheEntries = CACHE_DELETE_BATCH_SIZE;
  while (deletedCacheEntries === CACHE_DELETE_BATCH_SIZE) {
    deletedCacheEntries = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM attachment_cache_entries
         WHERE rowid IN (
           SELECT rowid FROM attachment_cache_entries
            ORDER BY rowid
            LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedAttachments = CACHE_DELETE_BATCH_SIZE;
  while (deletedAttachments === CACHE_DELETE_BATCH_SIZE) {
    deletedAttachments = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM attachments
         WHERE rowid IN (
           SELECT rowid FROM attachments ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedMessages = CACHE_DELETE_BATCH_SIZE;
  while (deletedMessages === CACHE_DELETE_BATCH_SIZE) {
    deletedMessages = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM messages
         WHERE rowid IN (
           SELECT rowid FROM messages ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedChatHandles = CACHE_DELETE_BATCH_SIZE;
  while (deletedChatHandles === CACHE_DELETE_BATCH_SIZE) {
    deletedChatHandles = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM chat_handles
         WHERE rowid IN (
           SELECT rowid FROM chat_handles ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedChats = CACHE_DELETE_BATCH_SIZE;
  while (deletedChats === CACHE_DELETE_BATCH_SIZE) {
    deletedChats = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM chats
         WHERE rowid IN (
           SELECT rowid FROM chats ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedHandles = CACHE_DELETE_BATCH_SIZE;
  while (deletedHandles === CACHE_DELETE_BATCH_SIZE) {
    deletedHandles = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM handles
         WHERE rowid IN (
           SELECT rowid FROM handles ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }
  // Queued work is addressed to the OLD server: an undrained outgoing row would be re-sent to
  // whichever server connects next, and scheduled messages / reminders point at chat guids that
  // no longer resolve. Reminders additionally cache a message preview + sender name.
  let deletedOutgoing = CACHE_DELETE_BATCH_SIZE;
  while (deletedOutgoing === CACHE_DELETE_BATCH_SIZE) {
    deletedOutgoing = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM outgoing_queue
         WHERE rowid IN (
           SELECT rowid FROM outgoing_queue ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedScheduled = CACHE_DELETE_BATCH_SIZE;
  while (deletedScheduled === CACHE_DELETE_BATCH_SIZE) {
    deletedScheduled = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM scheduled_messages
         WHERE rowid IN (
           SELECT rowid FROM scheduled_messages ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedReminders = CACHE_DELETE_BATCH_SIZE;
  while (deletedReminders === CACHE_DELETE_BATCH_SIZE) {
    deletedReminders = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM reminders
         WHERE rowid IN (
           SELECT rowid FROM reminders ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  let deletedPreviews = CACHE_DELETE_BATCH_SIZE;
  while (deletedPreviews === CACHE_DELETE_BATCH_SIZE) {
    deletedPreviews = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM url_previews
         WHERE rowid IN (
           SELECT rowid FROM url_previews ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  // Captured error reports are addressed to the old server too, and nothing binds a row to the
  // origin it was captured under. They pile up indefinitely when that server has ingestion
  // disabled (it acks them as `disabled` without burning an attempt), and `flushErrorReports`
  // gates only on "are we connected now" — so the whole backlog from someone else's session would
  // be POSTed to the NEXT server's operator, stacks and meta included.
  let deletedReports = CACHE_DELETE_BATCH_SIZE;
  while (deletedReports === CACHE_DELETE_BATCH_SIZE) {
    deletedReports = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM error_reports
         WHERE rowid IN (
           SELECT rowid FROM error_reports ORDER BY rowid LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  // The deletion watermark is a server-relative timestamp. Removing the key makes the next run
  // re-seed it to now() instead of replaying the new server's entire deletion history.
  await withDbWriteLock(async () => db.delete(kv).where(eq(kv.key, DELETIONS_WATERMARK_KV_KEY)));
  // Composer drafts are the one CHAT-SCOPED thing in kv: unsent, user-authored text about a chat
  // whose row was deleted five statements ago, keyed by a guid that is identical across servers.
  // Left behind, the next account opening its own thread with the same number finds the previous
  // user's draft pre-filled in the composer — and the rows would otherwise accumulate forever, one
  // per chat ever typed in, outliving the chat itself.
  let deletedDrafts = CACHE_DELETE_BATCH_SIZE;
  while (deletedDrafts === CACHE_DELETE_BATCH_SIZE) {
    deletedDrafts = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM kv
         WHERE rowid IN (
           SELECT rowid
             FROM kv
            WHERE key LIKE ${`${DRAFT_KV_PREFIX}%`}
            ORDER BY rowid
            LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }

  // Account-bound call UUIDs used to resolve privacy-safe native notification tokens.
  let deletedNotificationRoutes = CACHE_DELETE_BATCH_SIZE;
  while (deletedNotificationRoutes === CACHE_DELETE_BATCH_SIZE) {
    deletedNotificationRoutes = await withDbWriteLock(async () => {
      const rows = await db.all<{ rowid: number }>(sql`
        DELETE FROM kv
         WHERE rowid IN (
           SELECT rowid
             FROM kv
            WHERE key LIKE ${`${NOTIFICATION_ROUTE_KV_PREFIX}%`}
            ORDER BY rowid
            LIMIT ${CACHE_DELETE_BATCH_SIZE}
         )
        RETURNING rowid
      `);
      return rows.length;
    });
  }
}

/**
 * Did {@link clearLocalCache} actually take? One result row after every wipe. Each `EXISTS` probe
 * stops at its first matching row, so this confirms residue without counting an entire table.
 *
 * The wipe deliberately commits each statement independently, so it is CONFIRMED instead of
 * trusted. This read takes its own queue slot after the wipe: it cannot accept an uncommitted empty
 * view from a neighbouring transaction that later rolls back. Two things can still leave the wipe
 * half-done:
 *  - `delete(handles)` throws on the FK from `messages.handle_id` (NO ACTION) because an ordinary
 *    sync slice inserted messages after `delete(messages)` ran — `forget()` logs that at `warn` and
 *    carries on, leaving chats, queued sends, reminders and drafts untouched;
 *  - the process dies part-way through.
 * Every one of them ends with the PREVIOUS account's rows still on the device, which is exactly what
 * the wipe exists to prevent — so the caller re-runs on a dirty answer.
 *
 * Every account-scoped table and scoped kv key is checked independently. A later delete can fail
 * after chats/messages/handles are already empty (for example, `error_reports` can be held by its
 * own upload lease), so using only those identity tables would report a false clean result and let
 * account B inherit queued sends, diagnostics, reminders, previews, schedules, or draft text.
 */
export async function localCacheDirty(db: AppDatabase): Promise<boolean> {
  return withDbWriteLock(async () => {
    const rows = await db.all<{ dirty: number }>(sql`
      SELECT CASE WHEN
             EXISTS (SELECT 1 FROM incoming_event_queue)
          OR EXISTS (SELECT 1 FROM message_guid_aliases)
          OR EXISTS (SELECT 1 FROM message_deletion_ledger)
          OR EXISTS (SELECT 1 FROM attachments)
          OR EXISTS (SELECT 1 FROM attachment_cache_entries)
          OR EXISTS (SELECT 1 FROM messages)
          OR EXISTS (SELECT 1 FROM chat_handles)
          OR EXISTS (SELECT 1 FROM chats)
          OR EXISTS (SELECT 1 FROM handles)
          OR EXISTS (SELECT 1 FROM outgoing_queue)
          OR EXISTS (SELECT 1 FROM scheduled_messages)
          OR EXISTS (SELECT 1 FROM reminders)
          OR EXISTS (SELECT 1 FROM url_previews)
          OR EXISTS (SELECT 1 FROM error_reports)
          OR EXISTS (SELECT 1 FROM sync_markers
                       WHERE last_synced_row_id IS NOT NULL
                          OR last_synced_timestamp IS NOT NULL)
          OR EXISTS (SELECT 1 FROM kv
                       WHERE key = ${DELETIONS_WATERMARK_KV_KEY}
                          OR key LIKE ${`${DRAFT_KV_PREFIX}%`}
                          OR key LIKE ${`${NOTIFICATION_ROUTE_KV_PREFIX}%`})
        THEN 1 ELSE 0 END AS dirty
    `);
    return (rows[0]?.dirty ?? 0) > 0;
  });
}
