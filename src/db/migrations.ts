/**
 * Ordered SQL migrations for the encrypted local store.
 *
 * Hand-written (rather than drizzle-kit generated) so we can include the FTS5
 * virtual table + triggers, which Drizzle cannot model. The CREATE TABLE columns
 * must stay in sync with src/db/schema.ts. Booleans are INTEGER 0/1; timestamps
 * are epoch-millis INTEGER.
 */
export interface Migration {
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_init',
    statements: [
      `CREATE TABLE handles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_row_id INTEGER,
        address TEXT NOT NULL,
        service TEXT,
        country TEXT,
        color TEXT,
        display_name TEXT
      )`,
      `CREATE UNIQUE INDEX handles_address_idx ON handles (address)`,

      `CREATE TABLE chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL,
        original_row_id INTEGER,
        chat_identifier TEXT,
        display_name TEXT,
        style INTEGER,
        is_archived INTEGER DEFAULT 0,
        is_pinned INTEGER DEFAULT 0,
        mute_type TEXT,
        last_read_message_guid TEXT,
        latest_message_date INTEGER
      )`,
      `CREATE UNIQUE INDEX chats_guid_idx ON chats (guid)`,
      `CREATE INDEX chats_sort_idx ON chats (is_archived, latest_message_date)`,

      `CREATE TABLE chat_handles (
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        handle_id INTEGER NOT NULL REFERENCES handles(id) ON DELETE CASCADE,
        PRIMARY KEY (chat_id, handle_id)
      )`,

      `CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL,
        original_row_id INTEGER,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        handle_id INTEGER REFERENCES handles(id),
        text TEXT,
        subject TEXT,
        attributed_body TEXT,
        is_from_me INTEGER DEFAULT 0,
        date_created INTEGER,
        date_read INTEGER,
        date_delivered INTEGER,
        date_edited INTEGER,
        has_attachments INTEGER DEFAULT 0,
        associated_message_guid TEXT,
        associated_message_type TEXT,
        thread_originator_guid TEXT,
        expressive_send_style_id TEXT,
        error INTEGER DEFAULT 0,
        send_state TEXT DEFAULT 'sent'
      )`,
      `CREATE UNIQUE INDEX messages_guid_idx ON messages (guid)`,
      `CREATE INDEX messages_chat_date_idx ON messages (chat_id, date_created)`,
      `CREATE INDEX messages_row_id_idx ON messages (original_row_id)`,
      `CREATE INDEX messages_assoc_idx ON messages (associated_message_guid)`,

      `CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        mime_type TEXT,
        transfer_name TEXT,
        total_bytes INTEGER,
        height INTEGER,
        width INTEGER,
        blurhash TEXT,
        has_live_photo INTEGER DEFAULT 0,
        is_sticker INTEGER DEFAULT 0,
        local_path TEXT
      )`,
      `CREATE UNIQUE INDEX attachments_guid_idx ON attachments (guid)`,
      `CREATE INDEX attachments_message_idx ON attachments (message_id)`,

      `CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT,
        display_name TEXT,
        given_name TEXT,
        family_name TEXT,
        phones TEXT,
        emails TEXT,
        avatar TEXT
      )`,

      `CREATE TABLE scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER,
        chat_guid TEXT NOT NULL,
        payload TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        schedule TEXT,
        status TEXT DEFAULT 'pending'
      )`,

      `CREATE TABLE outgoing_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        temp_guid TEXT NOT NULL,
        chat_guid TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000)
      )`,

      `CREATE TABLE sync_markers (
        id INTEGER PRIMARY KEY,
        last_synced_row_id INTEGER,
        last_synced_timestamp INTEGER
      )`,
      `INSERT INTO sync_markers (id, last_synced_row_id, last_synced_timestamp) VALUES (1, NULL, NULL)`,

      `CREATE TABLE themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        tokens TEXT NOT NULL,
        is_preset INTEGER DEFAULT 0
      )`,

      `CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,

      // Full-text search over message text (external-content FTS5 over messages).
      `CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id')`,
      `CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END`,
      `CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END`,
      `CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END`,
    ],
  },
  {
    // Phase 7b: unsend (retract) + a local Open Graph preview cache. Additive only;
    // applied transactionally + idempotently by name (runMigrations skips applied).
    name: '0002_edit_unsend_url_previews',
    statements: [
      // Unsend marker. `date_edited` (0001) already serves the "Edited" flag.
      `ALTER TABLE messages ADD COLUMN date_retracted INTEGER`,

      // Open Graph preview cache, keyed by URL (shared across chats).
      // error=1 is a negative cache so dead URLs aren't re-fetched every render.
      `CREATE TABLE url_previews (
        url TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        image_url TEXT,
        site_name TEXT,
        fetched_at INTEGER,
        error INTEGER DEFAULT 0
      )`,
    ],
  },
  {
    // Phase 7c: contact sync writes a display name + avatar onto each matched
    // handle; contact_id records which contact won (so a server re-sync doesn't
    // clobber it). Additive only; applied transactionally + idempotently by name.
    name: '0003_handle_avatar_contact',
    statements: [
      `ALTER TABLE handles ADD COLUMN avatar TEXT`,
      `ALTER TABLE handles ADD COLUMN contact_id INTEGER`,
    ],
  },
  {
    // Scheduled-message state machine: an attempts counter so a permanently
    // failing send (e.g. its chat was deleted) is retired to status='error'
    // instead of retrying every tick forever. Additive; applied by name.
    name: '0004_scheduled_attempts',
    statements: [`ALTER TABLE scheduled_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`],
  },
  {
    // Per-chat customization: a local override name + accent color. These are
    // device-local and excluded from upsertChats' conflict set so a server
    // re-sync never clobbers them. Additive; applied by name.
    name: '0005_chat_customization',
    statements: [
      `ALTER TABLE chats ADD COLUMN custom_name TEXT`,
      `ALTER TABLE chats ADD COLUMN custom_color TEXT`,
    ],
  },
  {
    // Message reminders: a local Notifee trigger notification per saved reminder.
    name: '0006_reminders',
    statements: [
      `CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_guid TEXT NOT NULL,
        chat_guid TEXT NOT NULL,
        message_preview TEXT,
        sender_name TEXT,
        scheduled_for INTEGER NOT NULL,
        notification_id TEXT NOT NULL,
        created_at INTEGER
      )`,
      `CREATE INDEX reminders_scheduled_for_idx ON reminders (scheduled_for)`,
      `CREATE INDEX reminders_message_guid_idx ON reminders (message_guid)`,
    ],
  },
  {
    // Keep the server-supplied handle name separately so a handle can revert to it
    // when its matched device contact is later deleted (contacts re-sync). Additive.
    name: '0007_handle_server_name',
    statements: [`ALTER TABLE handles ADD COLUMN server_display_name TEXT`],
  },
  {
    // Outgoing-queue retry scheduling: when the next automatic retry is due (ms epoch;
    // 0 = retry-eligible now). Set to now+backoff on each failure; used as a short lease
    // while a retry is in flight. Additive; applied by name.
    name: '0008_outgoing_next_retry',
    statements: [`ALTER TABLE outgoing_queue ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0`],
  },
  {
    // Phase 3.2 per-chat theming: a JSON ThemeTokens override (recolors the whole
    // conversation) and a chat-background image uri. Both device-local and excluded
    // from upsertChats' conflict set so a server re-sync never clobbers them.
    // Additive only; applied transactionally + idempotently by name.
    name: '0009_chat_theme',
    statements: [
      `ALTER TABLE chats ADD COLUMN theme_tokens TEXT`,
      `ALTER TABLE chats ADD COLUMN background_uri TEXT`,
    ],
  },
  {
    // Phase 2.2 delivered tiers: Apple's "Delivered Quietly" / "Did Not Notify".
    // was_delivered_quietly && !did_notify_recipient → the "Delivered Quietly"
    // status label. Both fields arrive in the server message payload. Additive
    // only; applied transactionally + idempotently by name.
    name: '0010_delivered_tiers',
    statements: [
      `ALTER TABLE messages ADD COLUMN was_delivered_quietly INTEGER DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN did_notify_recipient INTEGER DEFAULT 0`,
    ],
  },
  {
    // Backfill has_attachments for already-synced rows. The server never sends a
    // `hasAttachments` flag, so earlier syncs stored it as 0 even when the message had
    // (and persisted) attachment rows — which left images unrendered and reply previews
    // blank. Recompute it from the attachments table. Idempotent (re-running re-sets 1).
    name: '0011_backfill_has_attachments',
    statements: [
      `UPDATE messages SET has_attachments = 1
         WHERE id IN (SELECT DISTINCT message_id FROM attachments WHERE message_id IS NOT NULL)`,
    ],
  },
  {
    // Rich-link / plugin-payload attachments (URL previews, App Store, Apple Music, …) are
    // flagged hide_attachment=1 by iMessage: they back a rich card, not a real file, and must
    // NOT render as file boxes. The server sends `hideAttachment`; carry it so the UI can skip
    // them. Additive; applied transactionally + idempotently by name.
    name: '0012_attachment_hide',
    statements: [`ALTER TABLE attachments ADD COLUMN hide_attachment INTEGER DEFAULT 0`],
  },
  {
    // macOS 26 synced "transcript background" (a chat wallpaper that syncs to all iMessage
    // participants). `synced_background_channel` is SERVER-owned (the server's current
    // backgroundChannelGuid, refreshed on sync — the version key); `synced_background_uri`
    // is the LOCAL file the app downloaded for that channel. Distinct from the device-local
    // `background_uri` (the user's own pick), which the render resolves as local ?? synced.
    // Additive; applied transactionally + idempotently by name.
    name: '0013_synced_background',
    statements: [
      `ALTER TABLE chats ADD COLUMN synced_background_channel TEXT`,
      `ALTER TABLE chats ADD COLUMN synced_background_uri TEXT`,
    ],
  },
  {
    // Legibility: the effective chat wallpaper's luminance (1 = light image, 0 = dark, NULL =
    // unknown/none), computed once when the background is set. Overlay text (sender names,
    // timestamps) picks dark-on-light / light-on-dark from this so it stays readable on any
    // wallpaper. Additive; applied transactionally + idempotently by name.
    name: '0014_background_luminance',
    statements: [`ALTER TABLE chats ADD COLUMN background_is_light INTEGER`],
  },
  {
    // Arbitrary-emoji tapbacks (iOS 18 / macOS 15): the server sends
    // associatedMessageType 'emoji'/'-emoji' with the glyph in associatedMessageEmoji.
    // Persist the glyph so the reaction cluster can render it (and removals can match
    // per-glyph). Additive; applied transactionally + idempotently by name.
    name: '0015_message_assoc_emoji',
    statements: [`ALTER TABLE messages ADD COLUMN associated_message_emoji TEXT`],
  },
  {
    // A handle's identity is (address, service) — Apple's chat.db keeps SEPARATE handle rows
    // for the same number on iMessage vs SMS. Keying by address alone made every incoming
    // message overwrite the one row's `service` (last-writer-wins), so an SMS from a person
    // flipped their iMessage chat's badge/bubble colour to SMS and back. NULL services are
    // normalized to '' first because SQLite unique indexes treat NULLs as always-distinct,
    // which would break the ON CONFLICT upsert. Safe: address was globally unique before,
    // so (address, service) cannot collide.
    name: '0016_handle_service_identity',
    statements: [
      `UPDATE handles SET service = '' WHERE service IS NULL`,
      `DROP INDEX IF EXISTS handles_address_idx`,
      `CREATE UNIQUE INDEX handles_address_service_idx ON handles (address, service)`,
    ],
  },
  {
    // Cleanup for a 0016 side effect: message-sender linking could attach BOTH service-variant
    // rows of the same person to one chat (participant synced as iMessage, a fallback message's
    // sender handle as SMS), rendering the person twice in the tile collage. Keep one link per
    // (chat, address) — which variant survives doesn't matter for display, and the next chat
    // sync replaces links with the canonical participant set anyway. The write path now guards
    // against re-adding (upsertMessages links by address, not handle id).
    name: '0017_dedupe_chat_participant_links',
    statements: [
      `DELETE FROM chat_handles WHERE rowid NOT IN (
        SELECT MIN(ch.rowid) FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        GROUP BY ch.chat_id, h.address
      )`,
    ],
  },
  {
    // Group / chat-event system messages: iMessage emits in-thread events (someone was
    // added/removed, the group was named/renamed, the photo changed, someone left, a location
    // was shared, an audio was kept, a FaceTime started) as messages carrying `item_type` +
    // `group_action_type` (+ `group_title` for a rename, `other_handle` = the affected
    // participant's server ROWID). Persist them so the thread can render a centered event line
    // instead of silently dropping the message. Additive; applied transactionally + by name.
    name: '0018_message_group_event',
    statements: [
      `ALTER TABLE messages ADD COLUMN item_type INTEGER DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN group_action_type INTEGER DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN group_title TEXT`,
      `ALTER TABLE messages ADD COLUMN other_handle INTEGER`,
    ],
  },
  {
    // Apple "Send Later" (macOS 15+/iOS 18+): the server emits `isScheduled: true` ONLY while a
    // message is a PENDING scheduled row (presence-driven; omitted once it sends). Persist it so a
    // synced pending row can render a "Scheduled" badge that survives restarts. Nullable (NULL =
    // not scheduled / pre-migration rows). Additive; applied transactionally + idempotently by name.
    name: '0019_message_is_scheduled',
    statements: [`ALTER TABLE messages ADD COLUMN is_scheduled INTEGER`],
  },
  {
    // Genmoji attachments (macOS 15.1+ AI-generated emoji images): the server sends
    // `emojiImageContentIdentifier` (presence marks a Genmoji → render inline emoji-sized) and
    // `emojiImageShortDescription` (natural-language alt text; also the notification/preview
    // fallback text). Both presence-driven — NULL on ordinary attachments (and pre-migration rows).
    // Additive; applied transactionally + idempotently by name.
    name: '0020_attachment_genmoji',
    statements: [
      `ALTER TABLE attachments ADD COLUMN emoji_image_content_identifier TEXT`,
      `ALTER TABLE attachments ADD COLUMN emoji_image_short_description TEXT`,
    ],
  },
  {
    // Apple `message_summary_info` (macOS 13+): per-part EDIT HISTORY + unsent ("retracted") parts.
    // The server emits `messageSummaryInfo` (parsed `{ editedParts?, retractedParts? }`) only on
    // edited/retracted messages; persist it as a JSON TEXT blob so the long-press "View Edit
    // History" sheet can show the revision timeline offline. NULL on ordinary (and pre-migration)
    // rows. Additive; applied transactionally + idempotently by name.
    name: '0021_message_summary_info',
    statements: [`ALTER TABLE messages ADD COLUMN message_summary_info TEXT`],
  },
  {
    // Message deletion tombstone (macOS 13+ "Recently Deleted"). The server's `message-deleted`
    // live event carries the deleted message's guid + delete date; we set this column (Unix ms)
    // instead of HARD-deleting the row. A deleted message REMAINS in the Mac's chat.db for ~30 days
    // (Recently Deleted) and the server's QUERY/SYNC paths still return it — only the live event
    // signals the deletion — so a hard delete would be UNDONE by the very next sync re-inserting the
    // row (the re-sync hazard). Instead the row is TOMBSTONED and every render/count query filters
    // `date_deleted IS NULL`, so a deleted message VANISHES from the UI (unlike an unsend's
    // `date_retracted`, which keeps a visible tombstone bubble) while the row survives the re-sync.
    // NULL on all non-deleted (and pre-migration) rows. Additive; applied transactionally + by name.
    name: '0022_message_date_deleted',
    statements: [`ALTER TABLE messages ADD COLUMN date_deleted INTEGER`],
  },
  {
    // Apple "Send Later" sent-state (is_sent). The server emits `isScheduled: true` for ANY
    // scheduled (schedule_type=2) row — pending AND after it sends — so isScheduled alone can't
    // hide the badge on a delivered Send-Later message. Persist is_sent (which flips 0→1 on send)
    // so the "Scheduled" badge can gate on `isScheduled && is_sent != 1`. Nullable (NULL = unknown
    // on pre-migration rows; re-synced on the next upsert). Additive; applied transactionally + by name.
    name: '0023_message_is_sent',
    statements: [`ALTER TABLE messages ADD COLUMN is_sent INTEGER`],
  },
  {
    // Scheduled-message recurrence: NULL = one-shot (all pre-migration rows), else
    // 'daily' | 'weekly' | 'monthly'. A recurring row is LOCAL-ONLY (the server has no
    // repeat concept, so scheduleTextMessage skips the server create when recurrence is
    // set) and, on a successful send, is RE-ARMED to its next occurrence instead of being
    // marked sent (see runDueScheduled + rearmScheduled). Additive; applied
    // transactionally + idempotently by name.
    name: '0024_scheduled_recurrence',
    statements: [`ALTER TABLE scheduled_messages ADD COLUMN recurrence TEXT`],
  },
  {
    // Error-report capture queue: a durable buffer of already-redacted `error`-level log lines that
    // the app batch-uploads to the server (which fingerprints + writes them to disk). Leased +
    // uploaded + deleted like outgoing_queue (attempts cap + next_retry_at backoff/lease). A NEW
    // table (not an ALTER), created transactionally + idempotently by name.
    name: '0025_error_reports',
    statements: [
      `CREATE TABLE error_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        stack TEXT,
        tag TEXT,
        meta TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX error_reports_retry_idx ON error_reports (next_retry_at)`,
    ],
  },
];
