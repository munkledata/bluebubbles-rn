import { eq, sql } from 'drizzle-orm';
import type { Attachment } from '@core/models';
import { firstUrl, mediaSection } from '@utils';
import { attachments, chats, messages, outgoingQueue } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';

export async function upsertAttachments(
  db: AppDatabase,
  items: Array<{ att: Attachment; messageId: number }>,
): Promise<void> {
  const deduped = dedupeBy(
    items.filter((x) => !!x.att?.guid),
    (x) => x.att.guid,
  );
  if (deduped.length === 0) return;

  await db
    .insert(attachments)
    .values(
      deduped.map(({ att, messageId }) => ({
        guid: att.guid,
        messageId,
        mimeType: att.mimeType ?? null,
        transferName: att.transferName ?? null,
        totalBytes: att.totalBytes ?? null,
        height: att.height ?? null,
        width: att.width ?? null,
        blurhash: att.blurhash ?? null,
        hasLivePhoto: att.hasLivePhoto ?? false,
        isSticker: att.isSticker ?? false,
      })),
    )
    .onConflictDoUpdate({
      target: attachments.guid,
      set: {
        mimeType: sql`excluded.mime_type`,
        totalBytes: sql`excluded.total_bytes`,
        blurhash: sql`excluded.blurhash`,
      },
    });
}

// ---- Attachments -----------------------------------------------------------

export interface AttachmentRow {
  id: number;
  guid: string;
  messageId: number;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number | null;
  height: number | null;
  width: number | null;
  blurhash: string | null;
  hasLivePhoto: number;
  isSticker: number;
  localPath: string | null;
}

/** Attachments for a set of message ids, grouped by messageId (stable id ASC order). */
export async function listAttachmentsByMessageIds(
  db: AppDatabase,
  messageIds: number[],
): Promise<Map<number, AttachmentRow[]>> {
  const out = new Map<number, AttachmentRow[]>();
  if (messageIds.length === 0) return out;
  const inList = sql.join(
    messageIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.all<AttachmentRow>(sql`
    SELECT
      id, guid, message_id AS messageId, mime_type AS mimeType,
      transfer_name AS transferName, total_bytes AS totalBytes,
      height, width, blurhash, has_live_photo AS hasLivePhoto,
      is_sticker AS isSticker, local_path AS localPath
    FROM attachments
    WHERE message_id IN (${inList})
    ORDER BY id ASC
  `);
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push(r);
    out.set(r.messageId, list);
  }
  return out;
}

export async function getAttachmentByGuid(
  db: AppDatabase,
  guid: string,
): Promise<AttachmentRow | null> {
  const rows = await db.all<AttachmentRow>(sql`
    SELECT id, guid, message_id AS messageId, mime_type AS mimeType,
      transfer_name AS transferName, total_bytes AS totalBytes, height, width, blurhash,
      has_live_photo AS hasLivePhoto, is_sticker AS isSticker, local_path AS localPath
    FROM attachments WHERE guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/** A shared link surfaced in conversation details (derived from message text). */
export interface ChatLink {
  url: string;
  messageGuid: string;
  dateCreated: number | null;
}

/** Shared media + links for a chat, bucketed for the conversation-details sections. */
export interface ChatMediaByKind {
  photos: AttachmentRow[];
  videos: AttachmentRow[];
  documents: AttachmentRow[];
  links: ChatLink[];
}

/**
 * Shared attachments + links for a chat (for the conversation-details media sections),
 * newest-first. Attachments are joined to their messages and bucketed by MIME via
 * `mediaSection` (Photos / Videos / Documents); stickers and unsent (retracted) messages
 * are excluded. Links are the first http(s) URL of each text message, deduped to the most
 * recent occurrence. `limit` caps each bucket so the strip stays lightweight.
 */
export async function listChatAttachmentsByKind(
  db: AppDatabase,
  chatGuid: string,
  limit = 60,
): Promise<ChatMediaByKind> {
  const out: ChatMediaByKind = { photos: [], videos: [], documents: [], links: [] };

  const attRows = await db.all<AttachmentRow & { dateCreated: number | null }>(sql`
    SELECT
      a.id, a.guid, a.message_id AS messageId, a.mime_type AS mimeType,
      a.transfer_name AS transferName, a.total_bytes AS totalBytes,
      a.height, a.width, a.blurhash, a.has_live_photo AS hasLivePhoto,
      a.is_sticker AS isSticker, a.local_path AS localPath, m.date_created AS dateCreated
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE c.guid = ${chatGuid}
      AND a.is_sticker = 0
      AND m.date_retracted IS NULL
    ORDER BY m.date_created DESC, a.id DESC
  `);
  for (const r of attRows) {
    const bucket =
      mediaSection(r.mimeType) === 'photo'
        ? out.photos
        : mediaSection(r.mimeType) === 'video'
          ? out.videos
          : out.documents;
    if (bucket.length < limit) bucket.push(r);
  }

  // Links: scan text messages for a first URL. Most-recent first; one entry per URL.
  const textRows = await db.all<{
    guid: string;
    text: string | null;
    dateCreated: number | null;
  }>(sql`
    SELECT m.guid, m.text, m.date_created AS dateCreated
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE c.guid = ${chatGuid}
      AND m.text LIKE '%http%'
      AND m.date_retracted IS NULL
      AND m.associated_message_type IS NULL
    ORDER BY m.date_created DESC, m.id DESC
  `);
  const seen = new Set<string>();
  for (const r of textRows) {
    if (out.links.length >= limit) break;
    const url = firstUrl(r.text);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.links.push({ url, messageGuid: r.guid, dateCreated: r.dateCreated });
  }

  return out;
}

/** Optimistically insert an outgoing image message + its local attachment + queue row. */
export async function insertOutgoingAttachment(
  db: AppDatabase,
  args: {
    tempGuid: string;
    attachmentGuid: string;
    chatId: number;
    chatGuid: string;
    localPath: string;
    mimeType: string;
    transferName: string;
    totalBytes: number;
    width?: number;
    height?: number;
    now: number;
  },
): Promise<void> {
  await db.insert(messages).values({
    guid: args.tempGuid,
    chatId: args.chatId,
    isFromMe: true,
    dateCreated: args.now,
    hasAttachments: true,
    sendState: 'sending',
    error: 0,
  });
  const inserted = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.guid, args.tempGuid))
    .limit(1);
  await db.insert(attachments).values({
    guid: args.attachmentGuid,
    messageId: inserted[0]!.id,
    mimeType: args.mimeType,
    transferName: args.transferName,
    totalBytes: args.totalBytes,
    width: args.width ?? null,
    height: args.height ?? null,
    localPath: args.localPath,
  });
  await db.insert(outgoingQueue).values({
    tempGuid: args.tempGuid,
    chatGuid: args.chatGuid,
    kind: 'attachment',
    payload: JSON.stringify({ attachmentGuid: args.attachmentGuid, localPath: args.localPath }),
  });
  await db.update(chats).set({ latestMessageDate: args.now }).where(eq(chats.id, args.chatId));
}

/** Persist a downloaded file path (fires the reactive 'attachments' watcher). */
export async function updateAttachmentLocalPath(
  db: AppDatabase,
  attachmentGuid: string,
  localPath: string,
): Promise<void> {
  await db.update(attachments).set({ localPath }).where(eq(attachments.guid, attachmentGuid));
}

/** Re-point a temp attachment to its server guid after an upload reconcile (no dup). */
export async function promoteAttachmentGuid(
  db: AppDatabase,
  tempAttachmentGuid: string,
  serverAttachmentGuid: string,
  localPath: string,
): Promise<void> {
  const dup = await db.all<{ id: number }>(
    sql`SELECT id FROM attachments WHERE guid = ${serverAttachmentGuid} LIMIT 1`,
  );
  if (dup[0]) {
    await db.delete(attachments).where(eq(attachments.guid, tempAttachmentGuid));
  } else {
    await db
      .update(attachments)
      .set({ guid: serverAttachmentGuid, localPath })
      .where(eq(attachments.guid, tempAttachmentGuid));
  }
}
