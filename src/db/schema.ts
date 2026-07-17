import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema for the encrypted local store (op-sqlite + SQLCipher).
 *
 * This is the offline-first source of truth: the sync engine and the headless
 * FCM handler write here; the UI observes via op-sqlite reactive queries.
 * Replaces ObjectBox (model version 5). Timestamps are epoch-millis integers.
 *
 * FTS5 (messages_fts) is a virtual table created via raw SQL in the first
 * migration — Drizzle does not model virtual tables. See db/migrations.
 */

export const handles = sqliteTable(
  'handles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    originalRowId: integer('original_row_id'),
    address: text('address').notNull(),
    service: text('service'),
    country: text('country'),
    color: text('color'),
    /** Resolved name shown in the UI (a matched contact's name, else the server name). */
    displayName: text('display_name'),
    /** The server-supplied name, kept even when a contact owns display_name, so a
        handle can revert here if its device contact is later removed. */
    serverDisplayName: text('server_display_name'),
    /** Contact-sync owned: photo uri + the contact that won the address match. */
    avatar: text('avatar'),
    contactId: integer('contact_id'),
  },
  (t) => ({
    // Identity is (address, service): the same number is a DIFFERENT handle on iMessage vs
    // SMS (mirrors Apple's chat.db). Unknown service is stored as '' — never NULL — because
    // SQLite unique indexes treat NULLs as distinct, which would break the upsert.
    addressServiceIdx: uniqueIndex('handles_address_service_idx').on(t.address, t.service),
  }),
);

export const chats = sqliteTable(
  'chats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guid: text('guid').notNull(),
    originalRowId: integer('original_row_id'),
    chatIdentifier: text('chat_identifier'),
    displayName: text('display_name'),
    style: integer('style'),
    isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
    isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
    muteType: text('mute_type'),
    /** Local per-chat customizations (never overwritten by a server re-sync). */
    customName: text('custom_name'),
    customColor: text('custom_color'),
    /** Per-chat theme override: JSON `ThemeTokens` blob (null → inherit the global theme). */
    themeTokens: text('theme_tokens'),
    /** Per-chat chat-background image uri (null → no background). Device-local (the user's own
     *  pick) — never overwritten by a server re-sync. */
    backgroundUri: text('background_uri'),
    /** macOS 26 synced background: server-owned channel GUID (the version), refreshed on sync. */
    syncedBackgroundChannel: text('synced_background_channel'),
    /** macOS 26 synced background: local file downloaded for `syncedBackgroundChannel`. */
    syncedBackgroundUri: text('synced_background_uri'),
    /** Luminance of the effective wallpaper (true = light image → dark overlay text). Null = unknown. */
    backgroundIsLight: integer('background_is_light', { mode: 'boolean' }),
    lastReadMessageGuid: text('last_read_message_guid'),
    /** Denormalized for fast inbox sorting without a join. */
    latestMessageDate: integer('latest_message_date'),
  },
  (t) => ({
    guidIdx: uniqueIndex('chats_guid_idx').on(t.guid),
    sortIdx: index('chats_sort_idx').on(t.isArchived, t.latestMessageDate),
  }),
);

/** Many-to-many: chats <-> participant handles. */
export const chatHandles = sqliteTable(
  'chat_handles',
  {
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    handleId: integer('handle_id')
      .notNull()
      .references(() => handles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.handleId] }),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guid: text('guid').notNull(),
    originalRowId: integer('original_row_id'),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    handleId: integer('handle_id').references(() => handles.id),
    text: text('text'),
    subject: text('subject'),
    /** Apple typedstream rich text, stored as base64; parsed lazily. */
    attributedBody: text('attributed_body'),
    isFromMe: integer('is_from_me', { mode: 'boolean' }).default(false),
    dateCreated: integer('date_created'),
    dateRead: integer('date_read'),
    dateDelivered: integer('date_delivered'),
    dateEdited: integer('date_edited'),
    /** Set when the message is unsent/retracted; renders a tombstone. */
    dateRetracted: integer('date_retracted'),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).default(false),
    associatedMessageGuid: text('associated_message_guid'),
    associatedMessageType: text('associated_message_type'),
    /** Glyph of an arbitrary-emoji tapback (associatedMessageType 'emoji'/'-emoji'). */
    associatedMessageEmoji: text('associated_message_emoji'),
    threadOriginatorGuid: text('thread_originator_guid'),
    expressiveSendStyleId: text('expressive_send_style_id'),
    /** iMessage group/chat-event metadata. item_type 0 = a normal message; >0 = a system event
        (1 add/remove participant, 2 rename, 3 leave/photo/chat-background change, 4 location,
        5 kept audio, 6 SharePlay). group_action_type disambiguates within a type (e.g. add vs
        remove; under item_type 3: 0 left, 1 photo set, 2 photo removed, 4 bg changed, 6 bg removed).
        group_title carries the new name on a rename; other_handle is the affected participant's
        server ROWID (resolved to a name at read time). See utils/groupEvent.ts. */
    itemType: integer('item_type').default(0),
    groupActionType: integer('group_action_type').default(0),
    groupTitle: text('group_title'),
    otherHandle: integer('other_handle'),
    error: integer('error').default(0),
    /** Local send lifecycle for optimistic outgoing messages. */
    sendState: text('send_state').default('sent'),
    /** Apple delivery tiers: delivered without notifying ("Delivered Quietly")
        vs explicitly notified the recipient. Both arrive in the server payload. */
    wasDeliveredQuietly: integer('was_delivered_quietly', { mode: 'boolean' }).default(false),
    didNotifyRecipient: integer('did_notify_recipient', { mode: 'boolean' }).default(false),
    /** Apple "Send Later" pending flag (presence-driven from the server): 1 while the message is a
        pending scheduled row, cleared once it actually sends. Drives the "Scheduled" badge.
        Nullable (NULL = not scheduled) — no default, matching the presence-driven wire semantics. */
    isScheduled: integer('is_scheduled', { mode: 'boolean' }),
    /** Apple `message_summary_info` (macOS 13+): per-part edit history + unsent parts, stored as a
        JSON TEXT blob (the parsed `{ editedParts?, retractedParts? }` shape). Presence-driven — the
        server emits it only on edited/retracted messages, so NULL on everything else. Powers the
        long-press "View Edit History" sheet; read back tolerantly via parseMessageSummaryInfo. */
    messageSummaryInfo: text('message_summary_info'),
  },
  (t) => ({
    guidIdx: uniqueIndex('messages_guid_idx').on(t.guid),
    chatDateIdx: index('messages_chat_date_idx').on(t.chatId, t.dateCreated),
    rowIdIdx: index('messages_row_id_idx').on(t.originalRowId),
    assocIdx: index('messages_assoc_idx').on(t.associatedMessageGuid),
  }),
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guid: text('guid').notNull(),
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    mimeType: text('mime_type'),
    transferName: text('transfer_name'),
    totalBytes: integer('total_bytes'),
    height: integer('height'),
    width: integer('width'),
    blurhash: text('blurhash'),
    hasLivePhoto: integer('has_live_photo', { mode: 'boolean' }).default(false),
    isSticker: integer('is_sticker', { mode: 'boolean' }).default(false),
    /** iMessage's hidden rich-link/plugin-payload attachments — skipped when rendering. */
    hideAttachment: integer('hide_attachment', { mode: 'boolean' }).default(false),
    /** Genmoji (macOS 15.1+ AI-generated emoji image): the image's content identifier. Presence
     *  marks a Genmoji so the UI renders it inline emoji-sized, not full-width. NULL otherwise. */
    emojiImageContentIdentifier: text('emoji_image_content_identifier'),
    /** Genmoji natural-language description (alt text + notification/preview fallback). NULL otherwise. */
    emojiImageShortDescription: text('emoji_image_short_description'),
    /** Local filesystem path once downloaded. */
    localPath: text('local_path'),
  },
  (t) => ({
    guidIdx: uniqueIndex('attachments_guid_idx').on(t.guid),
    messageIdx: index('attachments_message_idx').on(t.messageId),
  }),
);

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id'),
  displayName: text('display_name'),
  givenName: text('given_name'),
  familyName: text('family_name'),
  /** JSON arrays of addresses. */
  phones: text('phones'),
  emails: text('emails'),
  avatar: text('avatar'),
});

export const scheduledMessages = sqliteTable('scheduled_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Gator's server-side scheduled id is a uuid STRING. SQLite INTEGER affinity stored a
  // non-numeric value as text already, so no SQL migration is needed for existing rows.
  serverId: text('server_id'),
  chatGuid: text('chat_guid').notNull(),
  payload: text('payload').notNull(),
  scheduledFor: integer('scheduled_for').notNull(),
  schedule: text('schedule'),
  // pending → (claimed) sending → sent | error. attempts caps prod retries.
  status: text('status').default('pending'),
  attempts: integer('attempts').notNull().default(0),
});

/** Outgoing send queue with temp-GUID reconciliation (outgoing_queue.dart). */
export const outgoingQueue = sqliteTable('outgoing_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tempGuid: text('temp_guid').notNull(),
  chatGuid: text('chat_guid').notNull(),
  kind: text('kind').notNull(), // 'text' | 'attachment' | 'reaction'
  payload: text('payload').notNull(),
  attempts: integer('attempts').default(0),
  createdAt: integer('created_at').default(sql`(unixepoch() * 1000)`),
  // When the next automatic retry is due (ms epoch; 0 = now). Set to now+backoff on
  // each failure; doubles as a short lease while a retry attempt is in flight.
  nextRetryAt: integer('next_retry_at').notNull().default(0),
});

/** Incremental-sync markers (one row, id=1). */
export const syncMarkers = sqliteTable('sync_markers', {
  id: integer('id').primaryKey(),
  lastSyncedRowId: integer('last_synced_row_id'),
  lastSyncedTimestamp: integer('last_synced_timestamp'),
});

export const themes = sqliteTable('themes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  mode: text('mode').notNull(), // 'light' | 'dark'
  /** JSON token blob. */
  tokens: text('tokens').notNull(),
  isPreset: integer('is_preset', { mode: 'boolean' }).default(false),
});

/** Generic non-secret key-value prefs (secrets live in the SecureVault). */
export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/** Cached Open Graph metadata for message URLs, keyed by URL (shared across chats). */
export const urlPreviews = sqliteTable('url_previews', {
  url: text('url').primaryKey(),
  title: text('title'),
  description: text('description'),
  imageUrl: text('image_url'),
  siteName: text('site_name'),
  fetchedAt: integer('fetched_at'),
  error: integer('error').default(0),
});

/** "Remind me about this message later": a local Notifee trigger notification. */
export const reminders = sqliteTable(
  'reminders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageGuid: text('message_guid').notNull(),
    chatGuid: text('chat_guid').notNull(),
    messagePreview: text('message_preview'),
    senderName: text('sender_name'),
    scheduledFor: integer('scheduled_for').notNull(),
    /** Notifee notification id, persisted so we can cancel/reschedule it. */
    notificationId: text('notification_id').notNull(),
    createdAt: integer('created_at'),
  },
  (t) => ({
    scheduledForIdx: index('reminders_scheduled_for_idx').on(t.scheduledFor),
    messageGuidIdx: index('reminders_message_guid_idx').on(t.messageGuid),
  }),
);

export const schema = {
  handles,
  chats,
  chatHandles,
  messages,
  attachments,
  contacts,
  scheduledMessages,
  outgoingQueue,
  syncMarkers,
  themes,
  kv,
  urlPreviews,
  reminders,
};
