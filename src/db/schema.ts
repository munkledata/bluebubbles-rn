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
    addressIdx: uniqueIndex('handles_address_idx').on(t.address),
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
    /** Per-chat chat-background image uri (null → no background). */
    backgroundUri: text('background_uri'),
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
    threadOriginatorGuid: text('thread_originator_guid'),
    expressiveSendStyleId: text('expressive_send_style_id'),
    error: integer('error').default(0),
    /** Local send lifecycle for optimistic outgoing messages. */
    sendState: text('send_state').default('sent'),
    /** Apple delivery tiers: delivered without notifying ("Delivered Quietly")
        vs explicitly notified the recipient. Both arrive in the server payload. */
    wasDeliveredQuietly: integer('was_delivered_quietly', { mode: 'boolean' }).default(false),
    didNotifyRecipient: integer('did_notify_recipient', { mode: 'boolean' }).default(false),
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
  serverId: integer('server_id'),
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
