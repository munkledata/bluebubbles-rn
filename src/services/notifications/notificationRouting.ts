import { sql } from 'drizzle-orm';
import type { AppDatabase } from '@db/types';
import { kvSetWithinTransaction, NOTIFICATION_ROUTE_KV_PREFIX } from '@db/repositories';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';

/**
 * Native notification payloads are persisted by Android outside SQLCipher. Never put a server
 * GUID, phone number, email address, or call UUID in an id/data/person field. Versioned owner
 * markers let transition code positively identify notifications that this app knows how to rebuild.
 */
export const NOTIFICATION_DATA_OWNER = 'gator';
export const NOTIFICATION_DATA_SCHEMA = '2';

export type NotificationRouteKind =
  'message' | 'send-failure' | 'reminder' | 'facetime' | 'locked' | 'rcs' | 'test' | 'alias';

export interface LocalNotificationRoute {
  chatId: number;
  messageId?: number;
}

export interface FailedMessageNotificationRoute {
  chatGuid: string;
  messageGuid: string;
  route: LocalNotificationRoute & { messageId: number };
}

/**
 * Everything needed to rebuild one future reminder without putting server identifiers back into
 * Android-owned state. The encrypted DB row remains authoritative if Android loses its alarm.
 */
export interface DurableReminderTriggerRoute {
  oldId: string;
  newId: string;
  scheduledFor: number;
  route: LocalNotificationRoute;
  messageDate?: number;
}

interface DurableReminderTriggerRow {
  reminderId: number;
  oldId: string;
  scheduledFor: number;
  chatId: number;
  messageId: number | null;
  messageDate: number | null;
}

export interface ResolvedNotificationData {
  [key: string]: unknown;
  chatGuid?: string;
  messageGuid?: string;
  messageDate?: string;
  reminder?: '1';
  faceTimeUuid?: string;
}

const FACE_TIME_ROUTE_PREFIX = NOTIFICATION_ROUTE_KV_PREFIX;
const SAFE_CHAT_NOTIFICATION_PREFIX = 'gator-message-';
const SAFE_SEND_FAILURE_NOTIFICATION_PREFIX = 'gator-send-failure-';
const SAFE_REMINDER_NOTIFICATION_PREFIX = 'gator-reminder-';
const SAFE_FACETIME_NOTIFICATION_PREFIX = 'gator-facetime-';
const RANDOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REMINDER_ID = new RegExp(
  `^${SAFE_REMINDER_NOTIFICATION_PREFIX}(?:message-\\d+|row-\\d+|random-${RANDOM_UUID.source.slice(1, -1)})-\\d+$`,
  'i',
);

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Keep op-sqlite out of Node/pure-service import graphs until a route actually needs the DB. */
async function notificationDatabase(): Promise<AppDatabase> {
  const { openNotificationDatabase } = await import('./notificationDatabase');
  return openNotificationDatabase();
}

/** Resolve server identifiers to non-identifying local integer primary keys. */
export async function localRouteForGuids(
  chatGuid: string,
  messageGuid?: string,
  db?: AppDatabase,
): Promise<LocalNotificationRoute | null> {
  const database = db ?? (await notificationDatabase());
  const rows = await database.all<{ chatId: number; messageId: number | null }>(sql`
    SELECT c.id AS chatId,
      ${messageGuid == null ? sql`NULL` : sql`m.id`} AS messageId
    FROM chats c
    ${messageGuid == null ? sql`` : sql`LEFT JOIN messages m ON m.guid = ${messageGuid} AND m.chat_id = c.id`}
    WHERE c.guid = ${chatGuid}
    LIMIT 1
  `);
  const chatId = positiveInteger(rows[0]?.chatId);
  if (chatId == null) return null;
  const messageId = positiveInteger(rows[0]?.messageId);
  return { chatId, ...(messageId == null ? {} : { messageId }) };
}

/** Resolve one message to opaque local keys without requiring its chat GUID at the call site. */
export async function localRouteForMessageGuid(
  messageGuid: string,
  db?: AppDatabase,
): Promise<(LocalNotificationRoute & { messageId: number }) | null> {
  const database = db ?? (await notificationDatabase());
  const rows = await database.all<{ chatId: number; messageId: number }>(sql`
    SELECT c.id AS chatId, m.id AS messageId
      FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.guid = ${messageGuid}
        OR m.guid = (
          SELECT canonical_guid
            FROM message_guid_aliases
           WHERE alias_guid = ${messageGuid}
           LIMIT 1
        )
     ORDER BY CASE WHEN m.guid = ${messageGuid} THEN 0 ELSE 1 END
     LIMIT 1
  `);
  const chatId = positiveInteger(rows[0]?.chatId);
  const messageId = positiveInteger(rows[0]?.messageId);
  return chatId == null || messageId == null ? null : { chatId, messageId };
}

/**
 * Re-check current encrypted-DB truth immediately before a failed-send notice is derived or posted.
 * A durable retry must not resurrect a notice after success, retry admission, or local deletion.
 */
export async function localFailedMessageRoute(
  messageGuid: string,
  db?: AppDatabase,
): Promise<FailedMessageNotificationRoute | null> {
  const database = db ?? (await notificationDatabase());
  const rows = await database.all<{
    chatGuid: string;
    messageGuid: string;
    chatId: number;
    messageId: number;
  }>(sql`
    SELECT c.guid AS chatGuid, m.guid AS messageGuid,
           c.id AS chatId, m.id AS messageId
      FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.guid = ${messageGuid}
       AND m.is_from_me = 1
       AND m.send_state = 'error'
       AND m.date_deleted IS NULL
       AND m.date_retracted IS NULL
     LIMIT 1
  `);
  const row = rows[0];
  const chatGuid = stringValue(row?.chatGuid);
  const resolvedMessageGuid = stringValue(row?.messageGuid);
  const chatId = positiveInteger(row?.chatId);
  const messageId = positiveInteger(row?.messageId);
  if (!chatGuid || !resolvedMessageGuid || chatId == null || messageId == null) return null;
  return {
    chatGuid,
    messageGuid: resolvedMessageGuid,
    route: { chatId, messageId },
  };
}

/** Resolve local route keys back to server identifiers only after the app owns the press. */
async function guidsForLocalRoute(
  chatId: number,
  messageId?: number,
): Promise<{ chatGuid: string; messageGuid?: string } | null> {
  const db = await notificationDatabase();
  const rows = await db.all<{ chatGuid: string; messageGuid: string | null }>(sql`
    SELECT c.guid AS chatGuid,
      ${messageId == null ? sql`NULL` : sql`m.guid`} AS messageGuid
    FROM chats c
    ${messageId == null ? sql`` : sql`LEFT JOIN messages m ON m.id = ${messageId} AND m.chat_id = c.id`}
    WHERE c.id = ${chatId}
    LIMIT 1
  `);
  const chatGuid = stringValue(rows[0]?.chatGuid);
  if (!chatGuid) return null;
  const messageGuid = stringValue(rows[0]?.messageGuid);
  return { chatGuid, ...(messageGuid == null ? {} : { messageGuid }) };
}

export function chatNotificationId(chatId: number): string {
  return `${SAFE_CHAT_NOTIFICATION_PREFIX}${chatId}`;
}

/** Stable per-message id; duplicate delivery updates one notice and alerts only once. */
export function sendFailureNotificationId(messageId: number): string {
  return `${SAFE_SEND_FAILURE_NOTIFICATION_PREFIX}${messageId}`;
}

export function chatChannelIdForLocalId(chatId: number): string {
  return `com.bluegreengatorapps.messages.new_messages.chat.route_${chatId}`;
}

export function reminderNotificationId(routeKey: number | string, scheduledFor: number): string {
  return `${SAFE_REMINDER_NOTIFICATION_PREFIX}${routeKey}-${scheduledFor}`;
}

export function faceTimeNotificationId(token: string): string {
  return `${SAFE_FACETIME_NOTIFICATION_PREFIX}${token}`;
}

export function isSafeReminderNotificationId(value: string | undefined): boolean {
  return value != null && SAFE_REMINDER_ID.test(value);
}

/**
 * List durable FUTURE reminders in a native-safe form.
 *
 * Privacy sanitation must cancel Android's whole trigger store because a tagged legacy trigger
 * cannot be targeted reliably. If re-arming then fails, a later sanitation pass cannot discover
 * the missing alarm from Android anymore. Reading the encrypted DB as the source of truth lets the
 * next pass restore it. Past rows are intentionally excluded: their alarm may already have fired
 * and be waiting in the notification tray, so re-arming one could notify twice.
 */
export async function listFutureReminderTriggerRoutes(
  now: number = Date.now(),
): Promise<DurableReminderTriggerRoute[]> {
  const db = await notificationDatabase();
  const rows = (await db.all<DurableReminderTriggerRow>(sql`
    SELECT r.id AS reminderId,
      r.notification_id AS oldId,
      r.scheduled_for AS scheduledFor,
      c.id AS chatId,
      m.id AS messageId,
      m.date_created AS messageDate
    FROM reminders r
    JOIN chats c ON c.guid = r.chat_guid
    LEFT JOIN messages m ON m.guid = r.message_guid AND m.chat_id = c.id
    WHERE r.scheduled_for > ${now}
    ORDER BY r.scheduled_for ASC, r.id ASC
  `)) as DurableReminderTriggerRow[];

  return rows.flatMap((row): DurableReminderTriggerRoute[] => {
    const reminderId = positiveInteger(row.reminderId);
    const chatId = positiveInteger(row.chatId);
    const messageId = positiveInteger(row.messageId);
    const scheduledFor = Number(row.scheduledFor);
    if (
      reminderId == null ||
      chatId == null ||
      typeof row.oldId !== 'string' ||
      row.oldId.length === 0 ||
      !Number.isFinite(scheduledFor)
    ) {
      return [];
    }

    const newId = isSafeReminderNotificationId(row.oldId)
      ? row.oldId
      : reminderNotificationId(
          messageId == null ? `row-${reminderId}` : `message-${messageId}`,
          scheduledFor,
        );
    const messageDate = typeof row.messageDate === 'number' ? row.messageDate : Number.NaN;
    return [
      {
        oldId: row.oldId,
        newId,
        scheduledFor,
        route: { chatId, ...(messageId == null ? {} : { messageId }) },
        ...(Number.isFinite(messageDate) ? { messageDate } : {}),
      },
    ];
  });
}

export function nativeRouteData(
  kind: Exclude<NotificationRouteKind, 'facetime' | 'locked' | 'rcs' | 'test' | 'alias'>,
  route: LocalNotificationRoute,
  messageDate?: number | string,
): Record<string, string> {
  return {
    gatorOwner: NOTIFICATION_DATA_OWNER,
    gatorSchema: NOTIFICATION_DATA_SCHEMA,
    gatorKind: kind,
    chatId: String(route.chatId),
    ...(route.messageId == null ? {} : { messageId: String(route.messageId) }),
    ...(messageDate == null ? {} : { messageDate: String(messageDate) }),
  };
}

export function nativeStatusData(
  kind: Extract<NotificationRouteKind, 'locked' | 'rcs' | 'test' | 'alias'>,
): Record<string, string> {
  return {
    gatorOwner: NOTIFICATION_DATA_OWNER,
    gatorSchema: NOTIFICATION_DATA_SCHEMA,
    gatorKind: kind,
  };
}

/**
 * A FaceTime UUID is server-controlled, so even a prefixed UUID is not a safe native id. Store the
 * UUID behind a random token in the encrypted database; only the token crosses into Android state.
 */
export async function getOrCreateFaceTimeRoute(
  uuid: string,
  commitGuard?: DbCommitGuard,
): Promise<string> {
  const db = await notificationDatabase();
  // Generate outside the DB mutex: expo-crypto is a native boundary and transaction callbacks
  // must stay short and DB-only. An existing route simply leaves this candidate unused.
  const Crypto = await import('expo-crypto');
  const candidateToken = Crypto.randomUUID();
  return withDbTransaction(
    db,
    async (context) => {
      // Lookup and insert share one queue slot. A plain pre-transaction read could see another
      // transaction's temporary row, return its token, then leave no route after that neighbour
      // rolled back.
      const existing: Array<{ token: string }> = await db.all<{ token: string }>(sql`
        SELECT substr(key, ${FACE_TIME_ROUTE_PREFIX.length + 1}) AS token
        FROM kv
        WHERE key LIKE ${`${FACE_TIME_ROUTE_PREFIX}%`} AND value = ${uuid}
      `);
      const existingToken = existing
        .map((row) => stringValue(row.token))
        .find((token): token is string => token != null && RANDOM_UUID.test(token));
      if (existingToken) return existingToken;

      await kvSetWithinTransaction(context, `${FACE_TIME_ROUTE_PREFIX}${candidateToken}`, uuid);
      return candidateToken;
    },
    commitGuard,
  );
}

export async function findFaceTimeRoute(uuid: string): Promise<string | null> {
  const db = await notificationDatabase();
  const rows: Array<{ token: string }> = await db.all<{ token: string }>(sql`
    SELECT substr(key, ${FACE_TIME_ROUTE_PREFIX.length + 1}) AS token
    FROM kv
    WHERE key LIKE ${`${FACE_TIME_ROUTE_PREFIX}%`} AND value = ${uuid}
  `);
  return (
    rows
      .map((row) => stringValue(row.token))
      .find((token): token is string => token != null && RANDOM_UUID.test(token)) ?? null
  );
}

async function resolveFaceTimeToken(token: string): Promise<string | null> {
  if (!RANDOM_UUID.test(token)) return null;
  const db = await notificationDatabase();
  const rows = await db.all<{ value: string | null }>(sql`
    SELECT value FROM kv WHERE key = ${`${FACE_TIME_ROUTE_PREFIX}${token}`} LIMIT 1
  `);
  return stringValue(rows[0]?.value) ?? null;
}

export function nativeFaceTimeData(token: string): Record<string, string> {
  return {
    gatorOwner: NOTIFICATION_DATA_OWNER,
    gatorSchema: NOTIFICATION_DATA_SCHEMA,
    gatorKind: 'facetime',
    routeToken: token,
  };
}

/**
 * Decode a native payload. Schema 2 is fail-closed; legacy raw payloads remain read-compatible so
 * actions/deep links on notifications posted by an older app build keep working during migration.
 */
export async function resolveNotificationData(
  data: Record<string, unknown> | undefined,
): Promise<ResolvedNotificationData | null> {
  if (!data) return null;
  const owner = stringValue(data.gatorOwner);
  const schema = stringValue(data.gatorSchema);
  if (owner == null && schema == null) {
    const chatGuid = stringValue(data.chatGuid);
    const faceTimeUuid = stringValue(data.faceTimeUuid);
    if (faceTimeUuid) return { faceTimeUuid };
    if (!chatGuid) return null;
    const messageGuid = stringValue(data.messageGuid);
    const messageDate = stringValue(data.messageDate);
    return {
      chatGuid,
      ...(messageGuid == null ? {} : { messageGuid }),
      ...(messageDate == null ? {} : { messageDate }),
      ...(data.reminder === '1' ? { reminder: '1' as const } : {}),
    };
  }
  if (owner !== NOTIFICATION_DATA_OWNER || schema !== NOTIFICATION_DATA_SCHEMA) return null;

  const kind = stringValue(data.gatorKind) as NotificationRouteKind | undefined;
  if (kind === 'facetime') {
    const token = stringValue(data.routeToken);
    if (!token) return null;
    const faceTimeUuid = await resolveFaceTimeToken(token);
    return faceTimeUuid ? { faceTimeUuid } : null;
  }
  if (kind !== 'message' && kind !== 'send-failure' && kind !== 'reminder') return null;
  const chatId = positiveInteger(data.chatId);
  if (chatId == null) return null;
  const messageId = positiveInteger(data.messageId);
  const route = await guidsForLocalRoute(chatId, messageId);
  if (!route) return null;
  const messageDate = stringValue(data.messageDate);
  return {
    ...route,
    ...(messageDate == null ? {} : { messageDate }),
    ...(kind === 'reminder' ? { reminder: '1' as const } : {}),
  };
}

/** Generate a safe id for a newly scheduled reminder, preferring its local message key. */
export async function newReminderNotificationId(
  db: AppDatabase,
  messageGuid: string,
  scheduledFor: number,
): Promise<string> {
  const rows = await db.all<{ id: number }>(
    sql`SELECT id FROM messages WHERE guid = ${messageGuid} LIMIT 1`,
  );
  const messageId = positiveInteger(rows[0]?.id);
  if (messageId != null) return reminderNotificationId(`message-${messageId}`, scheduledFor);
  const Crypto = await import('expo-crypto');
  return reminderNotificationId(`random-${Crypto.randomUUID()}`, scheduledFor);
}

/** Find a deterministic safe replacement for a legacy reminder id. */
export async function replacementReminderNotificationId(
  oldNotificationId: string,
  messageGuid: string,
  scheduledFor?: number,
): Promise<string | null> {
  const db = await notificationDatabase();
  const rows = await db.all<{
    reminderId: number;
    messageId: number | null;
    scheduledFor: number;
  }>(sql`
    SELECT r.id AS reminderId, m.id AS messageId, r.scheduled_for AS scheduledFor
    FROM reminders r
    LEFT JOIN messages m ON m.guid = r.message_guid
    WHERE r.notification_id = ${oldNotificationId} OR r.message_guid = ${messageGuid}
    ORDER BY CASE WHEN r.notification_id = ${oldNotificationId} THEN 0 ELSE 1 END
    LIMIT 1
  `);
  const effectiveTime = Number.isFinite(scheduledFor) ? scheduledFor : rows[0]?.scheduledFor;
  if (typeof effectiveTime !== 'number' || !Number.isFinite(effectiveTime)) return null;
  const messageId = positiveInteger(rows[0]?.messageId);
  if (messageId != null) return reminderNotificationId(`message-${messageId}`, effectiveTime);
  const reminderId = positiveInteger(rows[0]?.reminderId);
  return reminderId == null ? null : reminderNotificationId(`row-${reminderId}`, effectiveTime);
}

/** Move the durable reminder row to its privacy-safe native id. Idempotent across two OS stores. */
export async function migrateReminderNotificationId(
  oldNotificationId: string,
  newNotificationId: string,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  const db = await notificationDatabase();
  return withDbTransaction(
    db,
    async () => {
      if (oldNotificationId !== newNotificationId) {
        const moved = await db.all<{ id: number }>(sql`
          UPDATE reminders SET notification_id = ${newNotificationId}
          WHERE notification_id = ${oldNotificationId}
          RETURNING id
        `);
        if (moved.length > 0) return true;
      }
      const already = await db.all<{ id: number }>(sql`
        SELECT id FROM reminders WHERE notification_id = ${newNotificationId} LIMIT 1
      `);
      return already.length > 0;
    },
    commitGuard,
  );
}

export async function deleteFaceTimeRoute(
  token: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  const db = await notificationDatabase();
  await withDbTransaction(
    db,
    async () => {
      await db.run(sql`DELETE FROM kv WHERE key = ${`${FACE_TIME_ROUTE_PREFIX}${token}`}`);
    },
    commitGuard,
  );
}

/** Account teardown: remove UUID route material after native notifications are cancelled. */
export async function clearNotificationRoutes(): Promise<void> {
  const db = await notificationDatabase();
  while (true) {
    const deletedCount = await withDbTransaction(db, async () => {
      const deleted = await db.all<{ rowid: number }>(sql`
        DELETE FROM kv
        WHERE rowid IN (
          SELECT rowid
          FROM kv
          WHERE key LIKE ${`${FACE_TIME_ROUTE_PREFIX}%`}
          ORDER BY rowid
          LIMIT 500
        )
        RETURNING rowid
      `);
      return deleted.length;
    });
    if (deletedCount < 500) return;
  }
}
