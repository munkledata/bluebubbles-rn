import { sql } from 'drizzle-orm';
import {
  check,
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
    /** Stable device-local order for pinned chats. Null whenever the chat is not pinned. */
    pinOrder: integer('pin_order'),
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
    /** When the user deliberately tapped "Mark as Unread" (epoch ms; null = never). Device-local.
     *  Distinguishes "I want to come back to this" from "never read" — both leave the marker NULL,
     *  and without it the Mac's read watermark silently undoes the flag on the next sync. */
    markedUnreadAt: integer('marked_unread_at'),
    /** When the user deleted this conversation on THIS device (epoch ms; null = never). Device-local
     *  tombstone: the row survives so the columns above do, and the chat is hidden from the inbox
     *  until a message NEWER than this arrives (see `deleteChatLocal` / `chatVisible`). */
    deletedAt: integer('deleted_at'),
    /** Denormalized for fast inbox sorting without a join. */
    latestMessageDate: integer('latest_message_date'),
  },
  (t) => ({
    guidIdx: uniqueIndex('chats_guid_idx').on(t.guid),
    sortIdx: index('chats_sort_idx').on(t.isArchived, t.latestMessageDate),
    pinOrderIdx: index('chats_pin_order_idx').on(t.isPinned, t.pinOrder, t.id),
    pinOrderNonnegative: check(
      'chats_pin_order_nonnegative',
      sql`${t.pinOrder} IS NULL OR (typeof(${t.pinOrder}) = 'integer' AND ${t.pinOrder} >= 0)`,
    ),
  }),
);

/** Device-local, account-private conversation folders. Server sync never owns these rows. */
export const customFolders = sqliteTable(
  'custom_folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull(),
    /** Presentation-only folder badge preference; never changes message read state. */
    showUnreadBadge: integer('show_unread_badge', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => ({
    nameIdx: uniqueIndex('custom_folders_name_idx').on(t.name),
    orderIdx: index('custom_folders_order_idx').on(t.sortOrder, t.id),
    nameValid: check(
      'custom_folders_name_valid',
      sql`length(${t.name}) BETWEEN 1 AND 64
          AND length(CAST(${t.name} AS BLOB)) <= 256
          AND ${t.name} = trim(${t.name})
          AND instr(${t.name}, char(0)) = 0`,
    ),
    sortOrderNonnegative: check(
      'custom_folders_sort_order_nonnegative',
      sql`typeof(${t.sortOrder}) = 'integer' AND ${t.sortOrder} >= 0`,
    ),
    showUnreadBadgeBoolean: check(
      'custom_folders_show_unread_badge_boolean',
      sql`typeof(${t.showUnreadBadge}) = 'integer' AND ${t.showUnreadBadge} IN (0, 1)`,
    ),
  }),
);

/**
 * Folder membership deliberately stores the stable chat GUID without an FK to `chats`.
 * A repair/resync may temporarily remove a chat row; that must not erase the user's folder choice.
 */
export const customFolderMembers = sqliteTable(
  'custom_folder_members',
  {
    folderId: integer('folder_id')
      .notNull()
      .references(() => customFolders.id, { onDelete: 'cascade' }),
    chatGuid: text('chat_guid').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.folderId, t.chatGuid] }),
    chatGuidIdx: index('custom_folder_members_chat_guid_idx').on(t.chatGuid, t.folderId),
    chatGuidValid: check(
      'custom_folder_members_chat_guid_valid',
      sql`length(${t.chatGuid}) BETWEEN 1 AND 4096
          AND length(CAST(${t.chatGuid} AS BLOB)) <= 16384
          AND instr(${t.chatGuid}, char(0)) = 0`,
    ),
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
    /** Apple Messages extension identifier. Used only for safe unsupported-content fallbacks. */
    balloonBundleId: text('balloon_bundle_id'),
    /** Bounded Apple aggregate part count; NULL when an older/lean payload omitted it. */
    partCount: integer('part_count'),
    isFromMe: integer('is_from_me', { mode: 'boolean' }).default(false),
    dateCreated: integer('date_created'),
    dateRead: integer('date_read'),
    dateDelivered: integer('date_delivered'),
    dateEdited: integer('date_edited'),
    /** Set when the message is unsent/retracted; renders a tombstone. */
    dateRetracted: integer('date_retracted'),
    /**
     * Set (Unix ms) when the message enters macOS "Recently Deleted" — the server's `message-deleted`
     * event. A TOMBSTONE, not a hard delete: the message stays in the Mac's chat.db (~30 days) and
     * the server's query/sync paths keep returning it, so hard-deleting the local row would let the
     * next sync RE-INSERT it. Every render/count query instead filters `date_deleted IS NULL`, so a
     * deleted message VANISHES from the UI (contrast `dateRetracted`, which keeps a tombstone bubble)
     * while the row survives the re-sync. There is deliberately NO wire model field for this — a
     * `MessageV1` never carries it (only the event does). `markMessageDeleted` records the event in
     * `message_deletion_ledger`; `upsertMessages` may then source this column from that LOCAL ledger
     * so an event-before-row backfill starts hidden. NULL on non-deleted rows.
     */
    dateDeleted: integer('date_deleted'),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).default(false),
    associatedMessageGuid: text('associated_message_guid'),
    /** Exact target part parsed from an associated message's outer p:N/ or bp:N/ prefix. */
    associatedMessagePart: integer('associated_message_part'),
    associatedMessageType: text('associated_message_type'),
    /** Glyph of an arbitrary-emoji tapback (associatedMessageType 'emoji'/'-emoji'). */
    associatedMessageEmoji: text('associated_message_emoji'),
    threadOriginatorGuid: text('thread_originator_guid'),
    /** Reply target part retained locally for optimistic and reconstructed retry payloads. */
    threadOriginatorPart: integer('thread_originator_part'),
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
    /** Bounded/redacted server prose for the failed-message action sheet only. */
    errorMessage: text('error_message'),
    /** Local send lifecycle for optimistic outgoing messages. */
    sendState: text('send_state').default('sent'),
    /** Apple delivery tiers: delivered without notifying ("Delivered Quietly")
        vs explicitly notified the recipient. Both arrive in the server payload. */
    wasDeliveredQuietly: integer('was_delivered_quietly', { mode: 'boolean' }).default(false),
    didNotifyRecipient: integer('did_notify_recipient', { mode: 'boolean' }).default(false),
    /** Apple "Send Later" flag (presence-driven from the server): 1 for a scheduled (schedule_type=2)
        row. The server keeps emitting it AFTER the message sends (it's gated on schedule_type, not
        is_sent), so on its own it can't tell pending from sent — the "Scheduled" badge is gated on
        `isScheduled && isSent !== 1` (see MessageBubble). Nullable (NULL = not scheduled). */
    isScheduled: integer('is_scheduled', { mode: 'boolean' }),
    /** Whether the message has actually been sent (Apple is_sent). Always on the wire (like
        is_from_me). Paired with isScheduled to hide the "Scheduled" badge once a Send-Later message
        delivers. Nullable (NULL = unknown, e.g. rows synced before this column existed → re-synced). */
    isSent: integer('is_sent', { mode: 'boolean' }),
    /** Apple `message_summary_info` (macOS 13+): per-part edit history + unsent parts, stored as a
        JSON TEXT blob (the parsed `{ editedParts?, retractedParts? }` shape). Presence-driven — the
        server emits it only on edited/retracted messages, so NULL on everything else. Powers the
        long-press "View Edit History" sheet; read back tolerantly via parseMessageSummaryInfo. */
    messageSummaryInfo: text('message_summary_info'),
    /** Apple rich-link preview of a URL balloon: server-decoded LPLinkMetadata (title/summary/
        site + image/icon/video URLs the SENDER's device fetched), stored as JSON TEXT. Presence-
        driven — NULL for non-URL messages, placeholders, and rows from older servers; the chat
        falls back to its own OG fetch then. Read back tolerantly via parsePayloadData. */
    payloadData: text('payload_data'),
  },
  (t) => ({
    guidIdx: uniqueIndex('messages_guid_idx').on(t.guid),
    chatDateIdx: index('messages_chat_date_idx').on(t.chatId, t.dateCreated),
    rowIdIdx: index('messages_row_id_idx').on(t.originalRowId),
    assocIdx: index('messages_assoc_idx').on(t.associatedMessageGuid),
    errorMessageBounded: check(
      'messages_error_message_bounded',
      sql`${t.errorMessage} IS NULL OR (length(${t.errorMessage}) BETWEEN 1 AND 240 AND length(CAST(${t.errorMessage} AS BLOB)) <= 512)`,
    ),
    balloonBundleIdBounded: check(
      'messages_balloon_bundle_id_bounded',
      sql`${t.balloonBundleId} IS NULL OR (length(${t.balloonBundleId}) BETWEEN 1 AND 255 AND length(CAST(${t.balloonBundleId} AS BLOB)) <= 1024)`,
    ),
  }),
);

/**
 * Durable server-deletion knowledge, independent from message rows by design.
 *
 * A deletion may arrive before history ingestion, and an ordinary chat purge may later remove the
 * tombstoned message row. Retaining this GUID marker makes every future re-ingestion start hidden.
 * It is account-scoped and is therefore explicitly cleared by `clearLocalCache`.
 */
export const messageDeletionLedger = sqliteTable('message_deletion_ledger', {
  guid: text('guid').primaryKey(),
  dateDeleted: integer('date_deleted').notNull(),
});

/**
 * Bounded, account-scoped identity handoffs for optimistic outgoing messages.
 *
 * This deliberately has no FK to `messages`: a stale destructive confirmation may arrive after
 * the temp row was promoted and the real row was later purged. Keeping the learned temp → real
 * mapping lets that confirmation write the deletion ledger under the canonical GUID so a future
 * server re-ingest is born hidden. The repository retains only a fixed number of newest mappings.
 */
export const messageGuidAliases = sqliteTable(
  'message_guid_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    aliasGuid: text('alias_guid').notNull(),
    canonicalGuid: text('canonical_guid').notNull(),
  },
  (t) => ({
    aliasGuidIdx: uniqueIndex('message_guid_aliases_alias_guid_idx').on(t.aliasGuid),
    aliasNotCanonical: check(
      'message_guid_aliases_alias_not_canonical',
      sql`${t.aliasGuid} <> ${t.canonicalGuid}`,
    ),
    aliasValid: check(
      'message_guid_aliases_alias_valid',
      sql`length(${t.aliasGuid}) BETWEEN 6 AND 128 AND ${t.aliasGuid} GLOB 'temp-*'`,
    ),
    canonicalValid: check(
      'message_guid_aliases_canonical_valid',
      sql`length(${t.canonicalGuid}) BETWEEN 1 AND 4096 AND ${t.canonicalGuid} NOT GLOB 'temp-*'`,
    ),
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
    // Retirement clears every duplicate reference to one physical path. Keep NULL-heavy rows out
    // of the index; outgoing/user-owned paths are classified by the coordinator before deletion.
    localPathIdx: index('attachments_local_path_idx')
      .on(t.localPath)
      .where(sql`${t.localPath} IS NOT NULL`),
  }),
);

/**
 * Durable accounting for completed files in the ordinary attachment cache.
 *
 * This is deliberately path-centric and has no attachment foreign key: more than one attachment
 * row can reference one physical file. A `reserved` row charges a not-yet-committed native write
 * across process death; a `retiring` row survives after references are cleared until exact native
 * deletion is confirmed. The whole table lives in the SQLCipher database.
 */
export const attachmentCacheEntries = sqliteTable(
  'attachment_cache_entries',
  {
    path: text('path').primaryKey(),
    bytes: integer('bytes').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    state: text('state', { enum: ['active', 'reserved', 'retiring'] })
      .notNull()
      .default('active'),
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: integer('next_retry_at').notNull().default(0),
  },
  (t) => ({
    pathNotEmpty: check('attachment_cache_entries_path_not_empty', sql`length(${t.path}) > 0`),
    bytesNonnegative: check('attachment_cache_entries_bytes_nonnegative', sql`${t.bytes} >= 0`),
    lastUsedAtNonnegative: check(
      'attachment_cache_entries_last_used_at_nonnegative',
      sql`${t.lastUsedAt} >= 0`,
    ),
    stateValid: check(
      'attachment_cache_entries_state_valid',
      sql`${t.state} IN ('active', 'reserved', 'retiring')`,
    ),
    attemptsNonnegative: check(
      'attachment_cache_entries_attempts_nonnegative',
      sql`${t.attempts} >= 0`,
    ),
    nextRetryAtNonnegative: check(
      'attachment_cache_entries_next_retry_at_nonnegative',
      sql`${t.nextRetryAt} >= 0`,
    ),
    stateLruIdx: index('attachment_cache_entries_state_lru_idx').on(t.state, t.lastUsedAt, t.path),
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
  /** NULL = one-shot; 'daily' | 'weekly' | 'monthly' = re-armed after each send (local-only). */
  recurrence: text('recurrence'),
  // pending → (claimed) sending → sent | error. `uncertain` is reserved for the one-time 0035
  // repair of pre-atomic local claims whose outgoing ownership cannot be reconstructed.
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

/**
 * Durable intake for validated realtime envelopes.
 *
 * Pending rows keep the canonical payload until one leased worker finishes. Successful and poison
 * rows scrub that payload but retain bounded encrypted identity/ordering metadata as a receipt, so
 * a socket/FCM redelivery remains suppressed across process death without retaining message text.
 */
export const incomingEventQueue = sqliteTable(
  'incoming_event_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Intake-derived stable identity. The repository deliberately does not guess event identity. */
    eventKey: text('event_key').notNull(),
    /** SHA-256 hex of the canonical payload, retained to detect an event-key collision. */
    payloadDigest: text('payload_digest').notNull(),
    /** Events sharing this key are processed in insertion order (for example, message updates). */
    orderingKey: text('ordering_key').notNull(),
    /** Version of the persisted canonical envelope format, independent from app/database versions. */
    schemaVersion: integer('schema_version').notNull().default(1),
    eventName: text('event_name').notNull(),
    source: text('source', { enum: ['socket', 'fcm', 'dev'] }).notNull(),
    /** Canonical validated JSON while pending; scrubbed on every terminal outcome. */
    payload: text('payload'),
    receivedAt: integer('received_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    state: text('state', { enum: ['pending', 'completed', 'poisoned'] })
      .notNull()
      .default('pending'),
    /** Incremented when a worker CLAIMS, so process death still consumes an attempt. */
    attempts: integer('attempts').notNull().default(0),
    /** Monotonic lease fence; a reclaimed row rejects results from an older worker. */
    claimVersion: integer('claim_version').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    leaseToken: text('lease_token'),
    leaseExpiresAt: integer('lease_expires_at').notNull().default(0),
    /**
     * Set in the SAME transaction as the event's authoritative DB writes. A crash after that
     * commit can then resume post-commit presentation without applying non-idempotent DB effects
     * (for example, incrementing an outgoing failure attempt) a second time.
     */
    dbAppliedAt: integer('db_applied_at'),
    terminalAt: integer('terminal_at'),
    /** Bounded machine code only; never persist a raw exception or payload excerpt here. */
    lastErrorCode: text('last_error_code'),
  },
  (t) => ({
    eventKeyIdx: uniqueIndex('incoming_event_queue_event_key_idx').on(t.eventKey),
    claimIdx: index('incoming_event_queue_claim_idx').on(
      t.state,
      t.nextAttemptAt,
      t.leaseExpiresAt,
      t.receivedAt,
      t.id,
    ),
    orderingIdx: index('incoming_event_queue_ordering_idx').on(t.state, t.orderingKey, t.id),
    terminalIdx: index('incoming_event_queue_terminal_idx').on(t.state, t.terminalAt, t.id),
    eventKeyValid: check(
      'incoming_event_queue_event_key_valid',
      sql`length(CAST(${t.eventKey} AS BLOB)) BETWEEN 1 AND 256`,
    ),
    payloadDigestValid: check(
      'incoming_event_queue_payload_digest_valid',
      sql`length(CAST(${t.payloadDigest} AS BLOB)) = 64
          AND ${t.payloadDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    orderingKeyValid: check(
      'incoming_event_queue_ordering_key_valid',
      sql`length(CAST(${t.orderingKey} AS BLOB)) BETWEEN 1 AND 256`,
    ),
    schemaVersionValid: check(
      'incoming_event_queue_schema_version_valid',
      sql`${t.schemaVersion} >= 1`,
    ),
    eventNameValid: check(
      'incoming_event_queue_event_name_valid',
      sql`length(CAST(${t.eventName} AS BLOB)) BETWEEN 1 AND 64`,
    ),
    sourceValid: check(
      'incoming_event_queue_source_valid',
      sql`${t.source} IN ('socket', 'fcm', 'dev')`,
    ),
    payloadBounded: check(
      'incoming_event_queue_payload_bounded',
      sql`${t.payload} IS NULL OR length(CAST(${t.payload} AS BLOB)) BETWEEN 1 AND 1048576`,
    ),
    receivedAtNonnegative: check(
      'incoming_event_queue_received_at_nonnegative',
      sql`${t.receivedAt} >= 0`,
    ),
    expiresAtValid: check(
      'incoming_event_queue_expires_at_valid',
      sql`${t.expiresAt} > ${t.receivedAt}
          AND (${t.expiresAt} - ${t.receivedAt}) <= 86400000`,
    ),
    stateValid: check(
      'incoming_event_queue_state_valid',
      sql`${t.state} IN ('pending', 'completed', 'poisoned')`,
    ),
    attemptsValid: check('incoming_event_queue_attempts_valid', sql`${t.attempts} BETWEEN 0 AND 5`),
    claimVersionNonnegative: check(
      'incoming_event_queue_claim_version_nonnegative',
      sql`${t.claimVersion} >= 0`,
    ),
    nextAttemptAtNonnegative: check(
      'incoming_event_queue_next_attempt_at_nonnegative',
      sql`${t.nextAttemptAt} >= 0`,
    ),
    leaseTokenValid: check(
      'incoming_event_queue_lease_token_valid',
      sql`${t.leaseToken} IS NULL OR length(CAST(${t.leaseToken} AS BLOB)) BETWEEN 1 AND 128`,
    ),
    leaseExpiresAtNonnegative: check(
      'incoming_event_queue_lease_expires_at_nonnegative',
      sql`${t.leaseExpiresAt} >= 0`,
    ),
    dbAppliedAtNonnegative: check(
      'incoming_event_queue_db_applied_at_nonnegative',
      sql`${t.dbAppliedAt} IS NULL OR ${t.dbAppliedAt} >= 0`,
    ),
    terminalAtNonnegative: check(
      'incoming_event_queue_terminal_at_nonnegative',
      sql`${t.terminalAt} IS NULL OR ${t.terminalAt} >= 0`,
    ),
    lastErrorCodeValid: check(
      'incoming_event_queue_last_error_code_valid',
      sql`${t.lastErrorCode} IS NULL OR length(CAST(${t.lastErrorCode} AS BLOB)) BETWEEN 1 AND 128`,
    ),
    stateShapeValid: check(
      'incoming_event_queue_state_shape_valid',
      sql`(
        ${t.state} = 'pending'
        AND ${t.payload} IS NOT NULL
        AND ${t.terminalAt} IS NULL
      ) OR (
        ${t.state} IN ('completed', 'poisoned')
        AND ${t.payload} IS NULL
        AND ${t.terminalAt} IS NOT NULL
        AND ${t.leaseToken} IS NULL
        AND ${t.leaseExpiresAt} = 0
        AND ${t.nextAttemptAt} = 0
      )`,
    ),
    leaseShapeValid: check(
      'incoming_event_queue_lease_shape_valid',
      sql`(
        ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} = 0
      ) OR (
        ${t.state} = 'pending'
        AND ${t.leaseToken} IS NOT NULL
        AND ${t.leaseExpiresAt} > 0
      )`,
    ),
  }),
);

/**
 * Durable buffer of captured error reports awaiting upload to the server (a lightweight
 * self-hosted crash reporter). The capture sink inserts a strict structured projection of
 * `error`-level lines; the upload queue validates it again before leasing + uploading + deleting
 * rows (backoff + attempt cap), mirroring outgoing_queue.
 */
export const errorReports = sqliteTable(
  'error_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull(),
    /** Finite event code plus allowlisted classifier, e.g. `runtime.uncaught [TypeError]`. */
    message: text('message').notNull(),
    /** Synthetic opaque call-site grouping frame; never a raw Error stack. */
    stack: text('stack'),
    /** Finite event category (server fingerprints on it). */
    tag: text('tag'),
    /** Versioned JSON containing only event-owned typed fields. */
    meta: text('meta'),
    /** Capture time (epoch ms). */
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    attempts: integer('attempts').notNull().default(0),
    /** When the next upload attempt is due (ms epoch; 0 = now). Doubles as an in-flight lease. */
    nextRetryAt: integer('next_retry_at').notNull().default(0),
  },
  (t) => ({
    retryIdx: index('error_reports_retry_idx').on(t.nextRetryAt),
  }),
);

/** Incremental-sync markers (one row, id=1). */
export const syncMarkers = sqliteTable('sync_markers', {
  id: integer('id').primaryKey(),
  lastSyncedRowId: integer('last_synced_row_id'),
  lastSyncedTimestamp: integer('last_synced_timestamp'),
});

export const themes = sqliteTable(
  'themes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    mode: text('mode').notNull(), // 'light' | 'dark'
    /** JSON token blob. */
    tokens: text('tokens').notNull(),
    isPreset: integer('is_preset', { mode: 'boolean' }).default(false),
  },
  (t) => ({
    // Backup restore claims one original twin at a time by this exact equality-prefix + id range.
    // Without the index, each short global-lock transaction can scan the whole themes table.
    restoreLookupIdx: index('themes_restore_lookup_idx').on(t.isPreset, t.name, t.mode, t.id),
  }),
);

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
  customFolders,
  customFolderMembers,
  chatHandles,
  messages,
  messageDeletionLedger,
  messageGuidAliases,
  attachments,
  attachmentCacheEntries,
  contacts,
  scheduledMessages,
  outgoingQueue,
  incomingEventQueue,
  errorReports,
  syncMarkers,
  themes,
  kv,
  urlPreviews,
  reminders,
};
