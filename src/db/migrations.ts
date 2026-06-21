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
];
