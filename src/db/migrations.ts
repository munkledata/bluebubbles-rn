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
    // Phase 7b: unsend (retract) + the legacy Open Graph preview cache. Additive only;
    // applied transactionally + idempotently by name (runMigrations skips applied).
    name: '0002_edit_unsend_url_previews',
    statements: [
      // Unsend marker. `date_edited` (0001) already serves the "Edited" flag.
      `ALTER TABLE messages ADD COLUMN date_retracted INTEGER`,

      // Legacy Open Graph preview cache, keyed by URL (shared across chats).
      // error=1 records the old fetcher's negative-cache result; current reads stay local.
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
    // Error-report capture queue: a durable buffer of privacy-projected `error`-level log lines that
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
  {
    // Retroactively strip the part-prefix from reaction linkage guids already stored raw.
    // Incoming reactions arrive as `p:0/<guid>` / `bp:0/<guid>`; the target message's own guid has
    // no prefix, so these rows were saved but never matched their target and stayed invisible. The
    // ingestion path now strips on parse (Message model), but rows written BEFORE this fix keep the
    // prefix — this one-time pass fixes the backlog so historical reactions surface. Reaction guids
    // carry exactly one `/`; a bare guid has none, so the `LIKE '%/%'` guard touches only prefixed
    // rows and `substr(..., instr(...,'/')+1)` keeps the segment after it. Additive; applied
    // transactionally + idempotently by name.
    name: '0026_strip_associated_guid_prefix',
    statements: [
      `UPDATE messages
         SET associated_message_guid = substr(associated_message_guid, instr(associated_message_guid, '/') + 1)
       WHERE associated_message_guid LIKE '%/%'`,
    ],
  },
  {
    // Apple rich-link preview metadata for URL balloons (server-decoded LPLinkMetadata as JSON
    // TEXT — the title/summary/image the SENDER's device already fetched). Lets the chat render
    // link cards without fetching the URL, which bot-hostile sites (X, Instagram, …) may serve a
    // blank shell to. NULL for all existing rows; no backfill — current history and metadata-less
    // links use only the read-only legacy cache or raw external link.
    name: '0027_message_payload_data',
    statements: [`ALTER TABLE messages ADD COLUMN payload_data TEXT`],
  },
  {
    // When the user deliberately tapped "Mark as Unread" (epoch ms), so that state is
    // distinguishable from "never read" — both of which leave `last_read_message_guid` NULL.
    // Without it the Mac's read watermark reconcile treated a NULL marker as `current = 0`, so
    // its guards were trivially true and the very next sync re-pointed the marker at the newest
    // received message: the blue dot the user asked for vanished on the next reconnect. DEVICE-
    // LOCAL, and deliberately absent from `upsertChats`' conflict set (the same mechanism that
    // protects is_pinned / custom_name). NULL for every existing row = "not marked unread".
    // Additive; applied transactionally + idempotently by name.
    name: '0028_chats_marked_unread_at',
    statements: [`ALTER TABLE chats ADD COLUMN marked_unread_at INTEGER`],
  },
  {
    // Local per-chat deletion TOMBSTONE (epoch ms), replacing the old hard `DELETE FROM chats`.
    // Two things the hard delete got wrong: the delete is local-only, so the very next sync
    // re-INSERTED the chat (the insert branch seeds only server fields, wiping pin/archive/mute,
    // custom name + colour, per-chat theme, wallpaper and the read marker — none of which any
    // re-sync can restore); and a resurrected row carried no memory of having been deleted.
    // A timestamp rather than a boolean so the chat un-hides BY ITSELF the moment genuinely new
    // activity arrives (a message created after the tombstone), which needs no edit to the
    // ingestion path. NULL for every existing row = never deleted.
    // Additive; applied transactionally + idempotently by name.
    name: '0029_chats_deleted_at',
    statements: [`ALTER TABLE chats ADD COLUMN deleted_at INTEGER`],
  },
  {
    // Durable, encrypted accounting for completed ordinary attachment-cache files. The path is the
    // identity because multiple attachment rows may reference one physical file. There is
    // intentionally NO attachment FK. `reserved` charges a final path before native streaming, so
    // a crash after promotion cannot create an untracked persistent file. A `retiring` row survives
    // until native deletion is confirmed. Retry metadata makes abandoned work discoverable later.
    name: '0030_attachment_cache_entries',
    statements: [
      `CREATE TABLE attachment_cache_entries (
        path TEXT PRIMARY KEY NOT NULL
          CONSTRAINT attachment_cache_entries_path_not_empty CHECK (length(path) > 0),
        bytes INTEGER NOT NULL
          CONSTRAINT attachment_cache_entries_bytes_nonnegative CHECK (bytes >= 0),
        last_used_at INTEGER NOT NULL
          CONSTRAINT attachment_cache_entries_last_used_at_nonnegative CHECK (last_used_at >= 0),
        state TEXT NOT NULL DEFAULT 'active'
          CONSTRAINT attachment_cache_entries_state_valid
            CHECK (state IN ('active', 'reserved', 'retiring')),
        attempts INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_cache_entries_attempts_nonnegative CHECK (attempts >= 0),
        next_retry_at INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_cache_entries_next_retry_at_nonnegative CHECK (next_retry_at >= 0)
      )`,
      `CREATE INDEX attachment_cache_entries_state_lru_idx
         ON attachment_cache_entries (state, last_used_at, path)`,
      `CREATE INDEX attachments_local_path_idx
         ON attachments (local_path) WHERE local_path IS NOT NULL`,
      `CREATE TRIGGER attachments_cache_path_insert_guard
         BEFORE INSERT ON attachments
         WHEN NEW.local_path IS NOT NULL
          AND EXISTS (SELECT 1 FROM attachment_cache_entries e
                       WHERE e.path = NEW.local_path AND e.state != 'active')
         BEGIN
           SELECT RAISE(ABORT, 'attachment cache path is not active');
         END`,
      `CREATE TRIGGER attachments_cache_path_update_guard
         BEFORE UPDATE OF local_path ON attachments
         WHEN NEW.local_path IS NOT NULL
          AND EXISTS (SELECT 1 FROM attachment_cache_entries e
                       WHERE e.path = NEW.local_path AND e.state != 'active')
         BEGIN
           SELECT RAISE(ABORT, 'attachment cache path is not active');
         END`,
    ],
  },
  {
    // Durable intake for validated socket/FCM envelopes. Pending payloads stay encrypted in the
    // SQLCipher database until one leased worker finishes. Terminal rows scrub the payload but
    // retain the event key as a bounded receipt, which keeps cross-transport/retry duplicates
    // suppressed across process death. No existing rows are backfilled: live intake owns identity,
    // canonicalization, ordering keys, and per-event expiry in PUSH-RETRY-01B.
    name: '0031_incoming_event_queue',
    statements: [
      `CREATE TABLE incoming_event_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL
          CONSTRAINT incoming_event_queue_event_key_valid
            CHECK (length(CAST(event_key AS BLOB)) BETWEEN 1 AND 256),
        payload_digest TEXT NOT NULL
          CONSTRAINT incoming_event_queue_payload_digest_valid
            CHECK (length(CAST(payload_digest AS BLOB)) = 64
                   AND payload_digest NOT GLOB '*[^0-9a-f]*'),
        ordering_key TEXT NOT NULL
          CONSTRAINT incoming_event_queue_ordering_key_valid
            CHECK (length(CAST(ordering_key AS BLOB)) BETWEEN 1 AND 256),
        schema_version INTEGER NOT NULL DEFAULT 1
          CONSTRAINT incoming_event_queue_schema_version_valid CHECK (schema_version >= 1),
        event_name TEXT NOT NULL
          CONSTRAINT incoming_event_queue_event_name_valid
            CHECK (length(CAST(event_name AS BLOB)) BETWEEN 1 AND 64),
        source TEXT NOT NULL
          CONSTRAINT incoming_event_queue_source_valid
            CHECK (source IN ('socket', 'fcm', 'dev')),
        payload TEXT
          CONSTRAINT incoming_event_queue_payload_bounded
            CHECK (payload IS NULL OR length(CAST(payload AS BLOB)) BETWEEN 1 AND 1048576),
        received_at INTEGER NOT NULL
          CONSTRAINT incoming_event_queue_received_at_nonnegative CHECK (received_at >= 0),
        expires_at INTEGER NOT NULL
          CONSTRAINT incoming_event_queue_expires_at_valid
            CHECK (expires_at > received_at AND (expires_at - received_at) <= 86400000),
        state TEXT NOT NULL DEFAULT 'pending'
          CONSTRAINT incoming_event_queue_state_valid
            CHECK (state IN ('pending', 'completed', 'poisoned')),
        attempts INTEGER NOT NULL DEFAULT 0
          CONSTRAINT incoming_event_queue_attempts_valid CHECK (attempts BETWEEN 0 AND 5),
        claim_version INTEGER NOT NULL DEFAULT 0
          CONSTRAINT incoming_event_queue_claim_version_nonnegative CHECK (claim_version >= 0),
        next_attempt_at INTEGER NOT NULL DEFAULT 0
          CONSTRAINT incoming_event_queue_next_attempt_at_nonnegative CHECK (next_attempt_at >= 0),
        lease_token TEXT
          CONSTRAINT incoming_event_queue_lease_token_valid
            CHECK (lease_token IS NULL OR length(CAST(lease_token AS BLOB)) BETWEEN 1 AND 128),
        lease_expires_at INTEGER NOT NULL DEFAULT 0
          CONSTRAINT incoming_event_queue_lease_expires_at_nonnegative
            CHECK (lease_expires_at >= 0),
        db_applied_at INTEGER
          CONSTRAINT incoming_event_queue_db_applied_at_nonnegative
            CHECK (db_applied_at IS NULL OR db_applied_at >= 0),
        terminal_at INTEGER
          CONSTRAINT incoming_event_queue_terminal_at_nonnegative
            CHECK (terminal_at IS NULL OR terminal_at >= 0),
        last_error_code TEXT
          CONSTRAINT incoming_event_queue_last_error_code_valid
            CHECK (last_error_code IS NULL OR length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 128),
        CONSTRAINT incoming_event_queue_state_shape_valid CHECK (
          (state = 'pending' AND payload IS NOT NULL AND terminal_at IS NULL)
          OR
          (state IN ('completed', 'poisoned') AND payload IS NULL AND terminal_at IS NOT NULL
           AND lease_token IS NULL AND lease_expires_at = 0 AND next_attempt_at = 0)
        ),
        CONSTRAINT incoming_event_queue_lease_shape_valid CHECK (
          (lease_token IS NULL AND lease_expires_at = 0)
          OR
          (state = 'pending' AND lease_token IS NOT NULL AND lease_expires_at > 0)
        )
      )`,
      `CREATE UNIQUE INDEX incoming_event_queue_event_key_idx
         ON incoming_event_queue (event_key)`,
      `CREATE INDEX incoming_event_queue_claim_idx
         ON incoming_event_queue
           (state, next_attempt_at, lease_expires_at, received_at, id)`,
      `CREATE INDEX incoming_event_queue_ordering_idx
         ON incoming_event_queue (state, ordering_key, id)`,
      `CREATE INDEX incoming_event_queue_terminal_idx
         ON incoming_event_queue (state, terminal_at, id)`,
    ],
  },
  {
    // Backup restore pairs same-named custom-theme twins one row at a time while holding the
    // process-wide write lock. Its lookup constrains is_preset/name/mode and walks an id range;
    // this matching index keeps each transaction bounded instead of rescanning every local theme.
    name: '0032_theme_restore_lookup_index',
    statements: [`CREATE INDEX themes_restore_lookup_idx ON themes (is_preset, name, mode, id)`],
  },
  {
    // A deletion event can arrive before its message row or before a later history backfill. Keep
    // a GUID-keyed ledger independent from messages so every future ingestion starts tombstoned,
    // even after a chat purge. Existing local tombstones are copied forward during the upgrade.
    name: '0033_message_deletion_ledger',
    statements: [
      `CREATE TABLE message_deletion_ledger (
        guid TEXT PRIMARY KEY NOT NULL,
        date_deleted INTEGER NOT NULL
      )`,
      `INSERT INTO message_deletion_ledger (guid, date_deleted)
       SELECT guid, date_deleted
         FROM messages
        WHERE date_deleted IS NOT NULL`,
    ],
  },
  {
    // Rows captured before LOG-01's strict finite diagnostic projector may contain free-form error
    // prose or raw stacks. They cannot be distinguished reliably from newer safe rows by shape,
    // and diagnostics are disposable cache, so purge the whole pre-policy queue once on upgrade.
    // Error reporting initializes only after migrations finish; every later row is projected before
    // insertion and the table remains available for the current bounded upload queue.
    name: '0034_purge_legacy_error_reports',
    statements: [`DELETE FROM error_reports`],
  },
  {
    // Internal release 0.1.40 could commit a local scheduled claim separately from its outgoing
    // queue handoff. After a process death, status='sending' therefore cannot tell us whether the
    // message is still unsent or already durably owned by outgoing_queue. Retire every ambiguous
    // LOCAL claim to visible uncertain history instead of re-arming it and risking a duplicate send.
    // Server-owned rows are authoritative remote state and are deliberately left untouched.
    name: '0035_retire_legacy_scheduled_sending',
    statements: [
      `UPDATE scheduled_messages
          SET status = 'uncertain',
              attempts = 5
        WHERE status = 'sending'
          AND server_id IS NULL`,
    ],
  },
  {
    // A destructive confirmation can retain a temp GUID while the send reconciles to its real
    // identity. Keep a bounded, account-scoped mapping independent from messages so the target is
    // still recoverable after a chat purge. No FK by design; clearLocalCache owns account removal.
    name: '0036_message_guid_aliases',
    statements: [
      `CREATE TABLE message_guid_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias_guid TEXT NOT NULL,
        canonical_guid TEXT NOT NULL,
        CONSTRAINT message_guid_aliases_alias_not_canonical
          CHECK (alias_guid <> canonical_guid),
        CONSTRAINT message_guid_aliases_alias_valid
          CHECK (length(alias_guid) BETWEEN 6 AND 128 AND alias_guid GLOB 'temp-*'),
        CONSTRAINT message_guid_aliases_canonical_valid
          CHECK (length(canonical_guid) BETWEEN 1 AND 4096 AND canonical_guid NOT GLOB 'temp-*')
      )`,
      `CREATE UNIQUE INDEX message_guid_aliases_alias_guid_idx
         ON message_guid_aliases (alias_guid)`,
    ],
  },
  {
    // Redacted Mode is permanently retired. Remove only its legacy preference while preserving
    // every unrelated setting and device-local kv row.
    name: '0037_purge_legacy_redacted_mode_setting',
    statements: [`DELETE FROM kv WHERE key = 'privacy.redactedMode'`],
  },
  {
    // Reaction retries need only their target GUID, reaction, and optional emoji. Older queue
    // payloads also copied the selected message's full text even though no send path reads it.
    // Scrub only that obsolete field from valid reaction JSON; malformed payloads and every other
    // queue kind remain byte-for-byte unchanged for their existing recovery/retirement paths.
    name: '0038_scrub_reaction_selected_message_text',
    statements: [
      `UPDATE outgoing_queue
          SET payload = json_remove(payload, '$.selectedMessageText')
        WHERE kind = 'reaction'
          AND CASE
                WHEN json_valid(payload)
                  THEN json_type(payload, '$.selectedMessageText') IS NOT NULL
                ELSE 0
              END`,
    ],
  },
  {
    // Retain only the already-projected server failure detail beside the failed message. Both
    // Unicode code points and encoded bytes are bounded because JavaScript and SQLite otherwise
    // measure non-ASCII text differently. Existing rows intentionally start with no detail.
    name: '0039_message_error_message',
    statements: [
      `ALTER TABLE messages ADD COLUMN error_message TEXT
        CONSTRAINT messages_error_message_bounded
        CHECK (
          error_message IS NULL OR (
            length(error_message) BETWEEN 1 AND 240
            AND length(CAST(error_message AS BLOB)) <= 512
          )
        )`,
    ],
  },
  {
    // Pinning used to be only a boolean, so new activity silently reordered pinned conversations.
    // Preserve the exact pre-upgrade visible order once, then let local pin/reorder actions own the
    // rank. A nullable integer keeps unpinning non-destructive: remaining ranks never need rewriting.
    name: '0040_chats_pin_order',
    statements: [
      `ALTER TABLE chats ADD COLUMN pin_order INTEGER
        CONSTRAINT chats_pin_order_nonnegative
        CHECK (
          pin_order IS NULL OR (typeof(pin_order) = 'integer' AND pin_order >= 0)
        )`,
      `WITH ranked AS (
         SELECT id,
                ROW_NUMBER() OVER (ORDER BY latest_message_date DESC, id DESC) - 1 AS pin_order
           FROM chats
          WHERE is_pinned = 1
       )
       UPDATE chats
          SET pin_order = (SELECT ranked.pin_order FROM ranked WHERE ranked.id = chats.id)
        WHERE is_pinned = 1`,
      `CREATE INDEX chats_pin_order_idx ON chats (is_pinned, pin_order, id)`,
    ],
  },
  {
    // Preserve the server's Messages extension identity so unsupported Digital Touch,
    // handwriting, and third-party balloons can render a safe local fallback instead of blank.
    // Existing messages intentionally start NULL and gain the identifier on their next sync.
    name: '0041_message_balloon_bundle_id',
    statements: [
      `ALTER TABLE messages ADD COLUMN balloon_bundle_id TEXT
        CONSTRAINT messages_balloon_bundle_id_bounded
        CHECK (
          balloon_bundle_id IS NULL OR (
            length(balloon_bundle_id) BETWEEN 1 AND 255
            AND length(CAST(balloon_bundle_id AS BLOB)) <= 1024
          )
        )`,
    ],
  },
  {
    // Preserve enough Apple message-part identity to stop hardcoding every reply/reaction/edit/
    // unsend to part zero. Existing rows intentionally start NULL: part_count refills on sync,
    // while old associated prefixes were already normalized and cannot be reconstructed locally.
    name: '0042_message_part_identity',
    statements: [
      `ALTER TABLE messages ADD COLUMN part_count INTEGER
        CONSTRAINT messages_part_count_bounded
        CHECK (
          part_count IS NULL OR (
            typeof(part_count) = 'integer' AND part_count BETWEEN 0 AND 10000
          )
        )`,
      `ALTER TABLE messages ADD COLUMN associated_message_part INTEGER
        CONSTRAINT messages_associated_message_part_bounded
        CHECK (
          associated_message_part IS NULL OR (
            typeof(associated_message_part) = 'integer'
            AND associated_message_part BETWEEN 0 AND 10000
          )
        )`,
      `ALTER TABLE messages ADD COLUMN thread_originator_part INTEGER
        CONSTRAINT messages_thread_originator_part_bounded
        CHECK (
          thread_originator_part IS NULL OR (
            typeof(thread_originator_part) = 'integer'
            AND thread_originator_part BETWEEN 0 AND 10000
          )
        )`,
    ],
  },
  {
    // Device-local folder membership points at stable chat GUIDs rather than chat-row ids. A Full
    // Repair or ordinary resync can therefore temporarily remove/recreate a chat without erasing
    // the user's classification. Disconnect explicitly wipes both account-private tables.
    name: '0043_custom_folders',
    statements: [
      `CREATE TABLE custom_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
          CONSTRAINT custom_folders_name_valid
          CHECK (
            length(name) BETWEEN 1 AND 64
            AND length(CAST(name AS BLOB)) <= 256
            AND name = trim(name)
            AND instr(name, char(0)) = 0
          ),
        sort_order INTEGER NOT NULL
          CONSTRAINT custom_folders_sort_order_nonnegative
          CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0)
      )`,
      `CREATE UNIQUE INDEX custom_folders_name_idx ON custom_folders (name)`,
      `CREATE INDEX custom_folders_order_idx ON custom_folders (sort_order, id)`,
      `CREATE TABLE custom_folder_members (
        folder_id INTEGER NOT NULL REFERENCES custom_folders(id) ON DELETE CASCADE,
        chat_guid TEXT NOT NULL
          CONSTRAINT custom_folder_members_chat_guid_valid
          CHECK (
            length(chat_guid) BETWEEN 1 AND 4096
            AND length(CAST(chat_guid AS BLOB)) <= 16384
            AND instr(chat_guid, char(0)) = 0
          ),
        PRIMARY KEY (folder_id, chat_guid)
      )`,
      `CREATE INDEX custom_folder_members_chat_guid_idx
        ON custom_folder_members (chat_guid, folder_id)`,
    ],
  },
  {
    // Match the original per-folder presentation preference without coupling it to message read
    // state. Existing folders opt in so adding the column does not silently remove their badge.
    name: '0044_custom_folder_unread_badge',
    statements: [
      `ALTER TABLE custom_folders
         ADD COLUMN show_unread_badge INTEGER NOT NULL DEFAULT 1
         CONSTRAINT custom_folders_show_unread_badge_boolean
         CHECK (typeof(show_unread_badge) = 'integer' AND show_unread_badge IN (0, 1))`,
    ],
  },
  {
    // Backup-v3 limit probes run while holding the one global DB transaction. These indexes let
    // both probes stop at their configured max+1 rows instead of walking unrelated table rows.
    name: '0045_backup_export_indexes',
    statements: [
      `CREATE INDEX themes_backup_export_idx ON themes (is_preset, id)`,
      `CREATE INDEX chats_backup_export_idx
        ON chats (id)
        WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
           OR is_pinned = 1 OR is_archived = 1`,
    ],
  },
  {
    // An attempt-aware RCS failure may arrive over socket/FCM after a later retry has begun. Keep
    // the server-owned physical-attempt identity beside the optimistic bubble, plus an explicit
    // pending bit for the request-to-ack window where the new identity is not known yet.
    name: '0046_message_send_attempt_owner',
    statements: [
      `ALTER TABLE messages
         ADD COLUMN active_send_attempt_guid TEXT
         CONSTRAINT messages_active_send_attempt_guid_bounded
         CHECK (active_send_attempt_guid IS NULL
                OR length(active_send_attempt_guid) BETWEEN 1 AND 128)`,
      `ALTER TABLE messages
         ADD COLUMN attempt_owner_pending INTEGER NOT NULL DEFAULT 0
         CONSTRAINT messages_attempt_owner_pending_boolean
         CHECK (typeof(attempt_owner_pending) = 'integer'
                AND attempt_owner_pending IN (0, 1))`,
      `ALTER TABLE messages
         ADD COLUMN attempt_owner_generation INTEGER NOT NULL DEFAULT 0
         CONSTRAINT messages_attempt_owner_generation_valid
         CHECK (typeof(attempt_owner_generation) = 'integer'
                AND attempt_owner_generation BETWEEN 0 AND 2147483647)`,
    ],
  },
  {
    // FEAT-03B: persist one conservative aggregate retraction result and exact server-proven part
    // ownership. Existing rows stay on the legacy date marker; future classified writes can keep a
    // surviving part visible while hiding only the attachments whose original part was retracted.
    name: '0047_message_retraction_topology',
    statements: [
      `ALTER TABLE messages
         ADD COLUMN retraction_state TEXT
         CONSTRAINT messages_retraction_state_valid
         CHECK (retraction_state IS NULL
                OR retraction_state IN ('intact', 'partial', 'fully-retracted', 'unknown'))`,
      `ALTER TABLE messages
         ADD COLUMN message_part_topology TEXT
         CONSTRAINT messages_part_topology_bounded
         CHECK (message_part_topology IS NULL OR (
           length(CAST(message_part_topology AS BLOB)) BETWEEN 2 AND 1048576
           AND instr(message_part_topology, char(0)) = 0
         ))`,
      `ALTER TABLE messages
         ADD COLUMN pending_retraction_part_index INTEGER
         CONSTRAINT messages_pending_retraction_part_index_valid
         CHECK (pending_retraction_part_index IS NULL OR (
           typeof(pending_retraction_part_index) = 'integer'
           AND pending_retraction_part_index BETWEEN 0 AND 10000
         ))`,
      `ALTER TABLE attachments
         ADD COLUMN message_part_index INTEGER
         CONSTRAINT attachments_message_part_index_valid
         CHECK (message_part_index IS NULL OR (
           typeof(message_part_index) = 'integer'
           AND message_part_index BETWEEN 0 AND 10000
         ))`,
      `ALTER TABLE attachments
         ADD COLUMN is_retracted INTEGER NOT NULL DEFAULT 0
         CONSTRAINT attachments_is_retracted_boolean
         CHECK (typeof(is_retracted) = 'integer' AND is_retracted IN (0, 1))`,
      // Reminder copies outlive later message updates and cannot be mapped back to one surviving
      // part. FEAT-03 adopts generic reminders, so remove every pre-migration plaintext copy.
      `UPDATE reminders SET message_preview = NULL, sender_name = NULL`,
    ],
  },
  {
    // DL-01: remember an automatic Gallery/Gator Album copy before its bounded app-cache
    // download starts. A foreground worker can then fulfill the copy after a killed/background
    // delivery has already committed attachments.local_path. There is deliberately no backfill:
    // historical local files were downloaded without a destination-bound user intent.
    name: '0048_attachment_media_exports',
    statements: [
      `CREATE TABLE attachment_media_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_guid TEXT NOT NULL
          REFERENCES attachments(guid) ON UPDATE CASCADE ON DELETE CASCADE
          CONSTRAINT attachment_media_exports_attachment_guid_valid
            CHECK (length(CAST(attachment_guid AS BLOB)) BETWEEN 1 AND 512),
        destination TEXT NOT NULL
          CONSTRAINT attachment_media_exports_destination_valid
            CHECK (destination IN ('gallery', 'album')),
        state TEXT NOT NULL DEFAULT 'pending'
          CONSTRAINT attachment_media_exports_state_valid
            CHECK (state IN ('pending', 'completed', 'terminal')),
        created_at INTEGER NOT NULL
          CONSTRAINT attachment_media_exports_created_at_nonnegative
            CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
        expires_at INTEGER NOT NULL
          CONSTRAINT attachment_media_exports_expires_at_valid
            CHECK (typeof(expires_at) = 'integer'
                   AND expires_at > created_at
                   AND (expires_at - created_at) <= 604800000),
        attempts INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_media_exports_attempts_valid
            CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 3),
        claim_version INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_media_exports_claim_version_nonnegative
            CHECK (typeof(claim_version) = 'integer' AND claim_version >= 0),
        next_attempt_at INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_media_exports_next_attempt_at_nonnegative
            CHECK (typeof(next_attempt_at) = 'integer' AND next_attempt_at >= 0),
        lease_token TEXT
          CONSTRAINT attachment_media_exports_lease_token_valid
            CHECK (lease_token IS NULL OR length(CAST(lease_token AS BLOB)) BETWEEN 1 AND 128),
        lease_expires_at INTEGER NOT NULL DEFAULT 0
          CONSTRAINT attachment_media_exports_lease_expires_at_nonnegative
            CHECK (typeof(lease_expires_at) = 'integer' AND lease_expires_at >= 0),
        terminal_at INTEGER
          CONSTRAINT attachment_media_exports_terminal_at_nonnegative
            CHECK (terminal_at IS NULL
                   OR (typeof(terminal_at) = 'integer' AND terminal_at >= 0)),
        last_error_code TEXT
          CONSTRAINT attachment_media_exports_last_error_code_valid
            CHECK (last_error_code IS NULL OR last_error_code IN (
              'expired', 'attempt-cap', 'ineligible', 'permission-denied',
              'source-missing', 'native-error'
            )),
        CONSTRAINT attachment_media_exports_state_shape_valid CHECK (
          (state = 'pending' AND terminal_at IS NULL)
          OR
          (state IN ('completed', 'terminal') AND terminal_at IS NOT NULL
           AND lease_token IS NULL AND lease_expires_at = 0 AND next_attempt_at = 0)
        ),
        CONSTRAINT attachment_media_exports_lease_shape_valid CHECK (
          (lease_token IS NULL AND lease_expires_at = 0)
          OR
          (state = 'pending' AND lease_token IS NOT NULL AND lease_expires_at > 0)
        )
      )`,
      `CREATE UNIQUE INDEX attachment_media_exports_attachment_guid_idx
         ON attachment_media_exports (attachment_guid)`,
      `CREATE INDEX attachment_media_exports_claim_idx
         ON attachment_media_exports
           (state, next_attempt_at, lease_expires_at, created_at, id)`,
      `CREATE INDEX attachment_media_exports_terminal_idx
         ON attachment_media_exports (state, terminal_at, id)`,
    ],
  },
  {
    // PERF-02: maintain exact JavaScript-search candidate postings without making a name change
    // depend on an app process surviving. Triggers invalidate the affected chat in the same SQL
    // transaction as the source write; a later bounded rebuilder replaces its postings.
    name: '0049_inbox_search_postings',
    statements: [
      `CREATE TABLE inbox_search_state (
        chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1
          CONSTRAINT inbox_search_state_revision_valid
            CHECK (typeof(revision) = 'integer' AND revision >= 1),
        is_dirty INTEGER NOT NULL DEFAULT 1
          CONSTRAINT inbox_search_state_dirty_boolean
            CHECK (typeof(is_dirty) = 'integer' AND is_dirty IN (0, 1)),
        rebuildable INTEGER NOT NULL DEFAULT 1
          CONSTRAINT inbox_search_state_rebuildable_boolean
            CHECK (typeof(rebuildable) = 'integer' AND rebuildable IN (0, 1))
      )`,
      `CREATE INDEX inbox_search_state_rebuild_idx
         ON inbox_search_state (is_dirty, rebuildable, chat_id)`,
      `CREATE INDEX inbox_search_state_dirty_idx
         ON inbox_search_state (is_dirty, chat_id)`,
      `CREATE TABLE inbox_search_postings (
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        gram INTEGER NOT NULL
          CONSTRAINT inbox_search_postings_gram_valid
            CHECK (typeof(gram) = 'integer' AND gram BETWEEN 0 AND 4294967295),
        PRIMARY KEY (chat_id, gram)
      )`,
      `CREATE INDEX inbox_search_postings_gram_idx
         ON inbox_search_postings (gram, chat_id)`,
      `CREATE INDEX chat_handles_handle_chat_idx ON chat_handles (handle_id, chat_id)`,
      `CREATE TRIGGER inbox_search_chats_insert AFTER INSERT ON chats BEGIN
         INSERT INTO inbox_search_state (chat_id) VALUES (NEW.id);
       END`,
      `CREATE TRIGGER inbox_search_chats_title_update
       AFTER UPDATE OF chat_identifier, display_name, custom_name, style ON chats
       WHEN OLD.chat_identifier IS NOT NEW.chat_identifier
         OR OLD.display_name IS NOT NEW.display_name
         OR OLD.custom_name IS NOT NEW.custom_name
         OR OLD.style IS NOT NEW.style
       BEGIN
         INSERT INTO inbox_search_state (chat_id) VALUES (NEW.id)
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
       END`,
      `CREATE TRIGGER inbox_search_chat_handles_insert AFTER INSERT ON chat_handles BEGIN
         INSERT INTO inbox_search_state (chat_id) VALUES (NEW.chat_id)
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
       END`,
      `CREATE TRIGGER inbox_search_chat_handles_delete AFTER DELETE ON chat_handles BEGIN
         INSERT INTO inbox_search_state (chat_id)
           SELECT OLD.chat_id WHERE EXISTS(SELECT 1 FROM chats WHERE id = OLD.chat_id)
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
       END`,
      `CREATE TRIGGER inbox_search_chat_handles_update
       AFTER UPDATE OF chat_id, handle_id ON chat_handles
       WHEN OLD.chat_id IS NOT NEW.chat_id OR OLD.handle_id IS NOT NEW.handle_id
       BEGIN
         INSERT INTO inbox_search_state (chat_id)
           SELECT OLD.chat_id WHERE EXISTS(SELECT 1 FROM chats WHERE id = OLD.chat_id)
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
         INSERT INTO inbox_search_state (chat_id) VALUES (NEW.chat_id)
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
       END`,
      `CREATE TRIGGER inbox_search_handles_name_update
       AFTER UPDATE OF address, display_name ON handles
       WHEN OLD.address IS NOT NEW.address OR OLD.display_name IS NOT NEW.display_name
       BEGIN
         INSERT INTO inbox_search_state (chat_id)
           SELECT chat_id FROM chat_handles WHERE handle_id = NEW.id
         ON CONFLICT(chat_id) DO UPDATE SET
           revision = revision + 1, is_dirty = 1, rebuildable = 1;
       END`,
      `INSERT INTO inbox_search_state (chat_id) SELECT id FROM chats`,
    ],
  },
  {
    // FEAT-06: a message/tombstone/optimistic alias belongs to one exact provider conversation.
    // Keep the stable chat GUID rather than a local numeric id so delete-before-hydration and a
    // later chat-row rebuild retain the same boundary. Legacy ownerless rows remain NULL and are
    // deliberately non-authoritative until a repository path can prove their owner.
    name: '0050_message_identity_owner_scope',
    statements: [
      `ALTER TABLE message_deletion_ledger ADD COLUMN chat_guid TEXT`,
      `UPDATE message_deletion_ledger
          SET chat_guid = (
                SELECT c.guid
                  FROM messages m
                  JOIN chats c ON c.id = m.chat_id
                 WHERE m.guid = message_deletion_ledger.guid
                 LIMIT 1
              )
        WHERE chat_guid IS NULL
          AND EXISTS (
                SELECT 1
                  FROM messages m
                  JOIN chats c ON c.id = m.chat_id
                 WHERE m.guid = message_deletion_ledger.guid
              )`,
      `ALTER TABLE message_guid_aliases ADD COLUMN chat_guid TEXT`,
      `UPDATE message_guid_aliases
          SET chat_guid = COALESCE(
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.alias_guid
                  LIMIT 1),
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.canonical_guid
                  LIMIT 1)
              )
        WHERE chat_guid IS NULL
          AND (
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.alias_guid
                  LIMIT 1) IS NULL
                OR
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.canonical_guid
                  LIMIT 1) IS NULL
                OR
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.alias_guid
                  LIMIT 1) =
                (SELECT c.guid
                   FROM messages m
                   JOIN chats c ON c.id = m.chat_id
                  WHERE m.guid = message_guid_aliases.canonical_guid
                  LIMIT 1)
      )`,
    ],
  },
  {
    // HANDLE-COLOR-01: valid legacy server-era values become the initial device preference;
    // malformed values fall back to Default so they cannot poison every future portable export.
    // The partial id index lets the max-plus-one selector skip the much larger uncolored set.
    name: '0051_handle_color_backup_index',
    statements: [
      `UPDATE handles
          SET color = CASE
            WHEN TRIM(color) GLOB
                 '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
              THEN UPPER(TRIM(color))
            ELSE NULL
          END
        WHERE color IS NOT NULL`,
      `CREATE INDEX handles_backup_color_export_idx
         ON handles (id)
         WHERE color IS NOT NULL`,
    ],
  },
  {
    // RECOVERY-02: keep the history-deletion boundary after new activity makes a locally deleted
    // chat visible. This provenance is separate from genuine per-message deletion receipts, so an
    // explicit restore can reveal only chat-deleted history without resurrecting deleted messages.
    // Full Repair's synthetic hidden shells use deleted_at=0 plus a KV owner and are deliberately
    // excluded: they are reconciliation state, not a user chat deletion.
    name: '0052_chat_history_deletion_boundary',
    statements: [
      `ALTER TABLE chats ADD COLUMN history_deleted_at INTEGER`,
      `UPDATE chats
          SET history_deleted_at = deleted_at
        WHERE deleted_at IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM kv
                 WHERE kv.key = 'sync.fullRepair.retiredChat.' || chats.guid
              )`,
    ],
  },
  {
    name: '0053_versioned_server_message_state',
    statements: [
      `CREATE TABLE message_server_states (
        guid TEXT PRIMARY KEY NOT NULL,
        chat_guid TEXT,
        provider_epoch TEXT NOT NULL,
        ledger_epoch TEXT NOT NULL,
        sequence TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('deleted', 'restored')),
        date_deleted INTEGER
      )`,
    ],
  },
];
