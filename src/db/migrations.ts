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
    // link cards without re-fetching the URL, which bot-hostile sites (X, Instagram, …) serve a
    // blank shell to. NULL for all existing rows; no backfill — the OG-fetch path stays the
    // fallback for history and metadata-less links.
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
];
