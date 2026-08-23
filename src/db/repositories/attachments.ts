import { eq, sql } from 'drizzle-orm';
import type { Attachment } from '@core/models';
import { STICKER_ASSOCIATED_TYPE } from '@core/reactions/reactionType';
import { firstUrl, mediaSection } from '@utils';
import { attachments, chats, messages, outgoingQueue } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';
import { requireChatIdByGuidWithinTransaction } from './chats';

/**
 * Transaction-only attachment ingestion. Temp-row identity/local-path reconciliation and the
 * final attachment upsert must remain in the owning message transaction.
 */
export function upsertAttachmentsWithinTransaction(
  context: DbTransactionContext,
  items: Array<{ att: Attachment; messageId: number }>,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const deduped = dedupeBy(
      items.filter((x) => !!x.att?.guid),
      (x) => x.att.guid,
    );
    if (deduped.length === 0) return;

    // Reconcile the optimistic-send path: the Gator attachment-send ack carries only the
    // MESSAGE guid (not the attachment guid — see SendAck), so the local temp attachment
    // row is reconciled here when the socket `new-message` echo lands. For each incoming
    // real attachment whose message still has a pending optimistic temp attachment
    // (guid like 'temp-…-att', identified by its retained local_path), re-point that temp
    // row to the real guid in place — preserving its on-disk local_path so the image keeps
    // rendering without a re-download, and avoiding a duplicate attachment on the bubble.
    for (const { att, messageId } of deduped) {
      const temp = await db.all<{ guid: string; localPath: string | null }>(
        sql`SELECT guid, local_path AS localPath FROM attachments
          WHERE message_id = ${messageId} AND guid LIKE '%-att' AND guid <> ${att.guid}
          LIMIT 1`,
      );
      const t = temp[0];
      if (!t) continue;
      // If the real guid already exists (a prior echo inserted it), just drop the temp row.
      const existing = await db.all<{ id: number }>(
        sql`SELECT id FROM attachments WHERE guid = ${att.guid} LIMIT 1`,
      );
      if (existing[0]) {
        await db.delete(attachments).where(eq(attachments.guid, t.guid));
      } else {
        await db
          .update(attachments)
          .set({ guid: att.guid, localPath: t.localPath })
          .where(eq(attachments.guid, t.guid));
      }
    }

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
          hideAttachment: att.hideAttachment ?? false,
          emojiImageContentIdentifier: att.emojiImageContentIdentifier ?? null,
          emojiImageShortDescription: att.emojiImageShortDescription ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: attachments.guid,
        set: {
          mimeType: sql`excluded.mime_type`,
          totalBytes: sql`excluded.total_bytes`,
          blurhash: sql`excluded.blurhash`,
          // COALESCE, not a plain overwrite: absence is not a value here. A file shared INTO Gator
          // carries no dimensions (SharedAttachment is uri/name/mimeType/size only) and is inserted
          // with NULL width/height, so the real dimensions the server sends on every later fetch
          // were being dropped on each re-upsert and the photo stayed boxed at the 0.78 fallback
          // ratio forever — the row already exists, so no re-sync could ever correct it. The reverse
          // must not happen either: a payload that legitimately omits them (the live socket echo)
          // must not wipe good ones. `transfer_name` has the same shape (the display filename).
          width: sql`COALESCE(excluded.width, ${attachments.width})`,
          height: sql`COALESCE(excluded.height, ${attachments.height})`,
          transferName: sql`COALESCE(excluded.transfer_name, ${attachments.transferName})`,
          emojiImageContentIdentifier: sql`excluded.emoji_image_content_identifier`,
          emojiImageShortDescription: sql`excluded.emoji_image_short_description`,
        },
      });
  });
}

/** Public standalone attachment ingestion. Never wrap this helper in another transaction. */
export async function upsertAttachments(
  db: AppDatabase,
  items: Array<{ att: Attachment; messageId: number }>,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => upsertAttachmentsWithinTransaction(context, items),
    commitGuard,
  );
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
  hideAttachment: number;
  /**
   * Genmoji (macOS 15.1+): the image content identifier (presence → render inline emoji-sized) and
   * the natural-language description (alt text / notification + preview fallback). Both NULL on
   * ordinary attachments. Optional so hand-built test literals need not set them; the SELECT lists
   * below always project them at runtime (NULL when absent).
   */
  emojiImageContentIdentifier?: string | null;
  emojiImageShortDescription?: string | null;
  localPath: string | null;
  /**
   * Owning chat's service — 'RCS' when the attachment belongs to an `RCS;-;` chat, else null.
   * Derived (via a chat-guid JOIN in the read queries), NOT a stored column. The downloader
   * branches the byte-fetch URL on this (RCS bytes are on `/rcs/attachment/…`).
   */
  service: string | null;
}

/** SQL fragment: 'RCS' when the joined chat guid is an RCS bridge chat, else NULL. */
const RCS_SERVICE_CASE = sql`CASE WHEN c.guid LIKE 'RCS;-;%' THEN 'RCS' ELSE NULL END`;

/**
 * Attachments for a set of message ids, grouped by messageId (stable id ASC order).
 *
 * `rowLimit`, when supplied, is applied by SQLite before rows cross into JavaScript. Invalid
 * explicit limits fail closed with an empty result; omitting it preserves the complete-read
 * behavior used by conversation rendering and reconciliation. Deleted owners remain readable by
 * default for cleanup/reconciliation; ingestion auto-download opts into excluding them.
 */
export interface ListAttachmentsByMessageIdsOptions {
  excludeDeletedMessages?: boolean;
}

export async function listAttachmentsByMessageIds(
  db: AppDatabase,
  messageIds: number[],
  rowLimit?: number,
  options: ListAttachmentsByMessageIdsOptions = {},
): Promise<Map<number, AttachmentRow[]>> {
  const out = new Map<number, AttachmentRow[]>();
  if (messageIds.length === 0) return out;
  if (rowLimit !== undefined && (!Number.isSafeInteger(rowLimit) || rowLimit <= 0)) return out;
  const inList = sql.join(
    messageIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const deletedMessageFilter = options.excludeDeletedMessages
    ? sql`AND m.date_deleted IS NULL`
    : sql``;
  const rows = await db.all<AttachmentRow>(sql`
    SELECT
      a.id, a.guid, a.message_id AS messageId, a.mime_type AS mimeType,
      a.transfer_name AS transferName, a.total_bytes AS totalBytes,
      a.height, a.width, a.blurhash, a.has_live_photo AS hasLivePhoto,
      a.is_sticker AS isSticker, a.hide_attachment AS hideAttachment,
      a.emoji_image_content_identifier AS emojiImageContentIdentifier,
      a.emoji_image_short_description AS emojiImageShortDescription,
      a.local_path AS localPath,
      ${RCS_SERVICE_CASE} AS service
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE a.message_id IN (${inList})
      ${deletedMessageFilter}
    ORDER BY a.id ASC
    LIMIT ${rowLimit ?? -1}
  `);
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push(r);
    out.set(r.messageId, list);
  }
  return out;
}

/**
 * A sticker targeting one of your messages: the sticker MESSAGE plus its image, if the image row
 * has arrived yet.
 *
 * `attachment` is nullable on purpose. A sticker delivered on the LIVE socket/FCM path carries no
 * attachment rows at all (the server's live fanout serializes with `extra = {chats, handle}` only,
 * so `serializeMessage` omits `attachments` — the same reason an incoming photo has no attachment
 * row until the next sync). The image lands on the next `ensureChatSynced`, i.e. chat open. The
 * overlay therefore has to render a pending tile rather than assume an image exists.
 */
/** The sticker MESSAGE columns, before its image is joined on. */
interface StickerMessageRow {
  stickerMessageGuid: string;
  stickerMessageId: number;
  targetGuid: string;
  isFromMe: number;
  dateCreated: number;
}

export interface StickerRow extends StickerMessageRow {
  attachment: AttachmentRow | null;
}

/**
 * Stickers grouped by the guid of the message they were placed on.
 *
 * Two plain SELECTs, no transaction (and never call this from inside one — this module also holds
 * helpers that transact internally, e.g. `insertOutgoingAttachment`).
 *
 * NOTE the discriminator is the sticker MESSAGE's associated type, never `attachments.is_sticker`:
 * a legacy (Apple code 1000) sticker can arrive with `is_sticker = 0` on its attachment row and
 * must still render. The `is_sticker = 0` filters in the shared-media queries below are a
 * different concern (keeping stickers out of the media gallery) and stay as they are.
 */
export async function listStickersForTargets(
  db: AppDatabase,
  targetGuids: string[],
): Promise<Map<string, StickerRow[]>> {
  const out = new Map<string, StickerRow[]>();
  if (targetGuids.length === 0) return out;
  const inList = sql.join(
    targetGuids.map((g) => sql`${g}`),
    sql`, `,
  );
  // Annotated because AppDatabase's generics are `any`, so `db.all<T>()` resolves to `any` and a
  // `.map(r => …)` callback below would otherwise trip noImplicitAny (a for-of does not).
  const rows: StickerMessageRow[] = await db.all<StickerMessageRow>(sql`
    SELECT
      m.guid AS stickerMessageGuid,
      m.id AS stickerMessageId,
      m.associated_message_guid AS targetGuid,
      m.is_from_me AS isFromMe,
      m.date_created AS dateCreated
    FROM messages m
    WHERE m.associated_message_guid IN (${inList})
      AND m.associated_message_type = ${STICKER_ASSOCIATED_TYPE}
      AND m.date_deleted IS NULL
      AND m.date_retracted IS NULL
    ORDER BY m.date_created ASC, m.id ASC
  `);
  if (rows.length === 0) return out;

  // Reuse the existing projection so blurhash/width/height/localPath and the RCS service CASE
  // all come along for free.
  const attsByMessage = await listAttachmentsByMessageIds(
    db,
    rows.map((r) => r.stickerMessageId),
  );

  for (const r of rows) {
    const atts = attsByMessage.get(r.stickerMessageId) ?? [];
    const list = out.get(r.targetGuid) ?? [];
    if (atts.length === 0) {
      list.push({ ...r, attachment: null });
    } else {
      for (const att of atts) list.push({ ...r, attachment: att });
    }
    out.set(r.targetGuid, list);
  }
  return out;
}

export async function getAttachmentByGuid(
  db: AppDatabase,
  guid: string,
): Promise<AttachmentRow | null> {
  const rows = await db.all<AttachmentRow>(sql`
    SELECT a.id, a.guid, a.message_id AS messageId, a.mime_type AS mimeType,
      a.transfer_name AS transferName, a.total_bytes AS totalBytes, a.height, a.width, a.blurhash,
      a.has_live_photo AS hasLivePhoto, a.is_sticker AS isSticker,
      a.hide_attachment AS hideAttachment,
      a.emoji_image_content_identifier AS emojiImageContentIdentifier,
      a.emoji_image_short_description AS emojiImageShortDescription,
      a.local_path AS localPath,
      ${RCS_SERVICE_CASE} AS service
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE a.guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * All IMAGE attachments in the same chat as `guid`, chronological, plus the index of `guid` among
 * them — for the fullscreen swipe-carousel (page left/right through every photo in the chat).
 * Stickers, hidden rich-link payloads, and retracted messages are excluded. Videos/documents are
 * NOT included (a tapped video opens singly). `index` is -1 when `guid` isn't an image in the set.
 */
export async function listChatImageAttachmentsByAttachmentGuid(
  db: AppDatabase,
  guid: string,
): Promise<{ items: AttachmentRow[]; index: number }> {
  const rows = await db.all<AttachmentRow>(sql`
    SELECT a.id, a.guid, a.message_id AS messageId, a.mime_type AS mimeType,
      a.transfer_name AS transferName, a.total_bytes AS totalBytes, a.height, a.width, a.blurhash,
      a.has_live_photo AS hasLivePhoto, a.is_sticker AS isSticker,
      a.hide_attachment AS hideAttachment,
      a.emoji_image_content_identifier AS emojiImageContentIdentifier,
      a.emoji_image_short_description AS emojiImageShortDescription,
      a.local_path AS localPath,
      ${RCS_SERVICE_CASE} AS service
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE m.chat_id = (
        SELECT chat_id FROM messages
        WHERE id = (SELECT message_id FROM attachments WHERE guid = ${guid})
      )
      AND a.mime_type LIKE 'image/%'
      AND a.is_sticker = 0
      AND a.hide_attachment = 0
      AND m.date_retracted IS NULL
      AND m.date_deleted IS NULL
    ORDER BY m.date_created ASC, a.id ASC
  `);
  return { items: rows, index: rows.findIndex((r: AttachmentRow) => r.guid === guid) };
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
 * `mediaSection` (Photos / Videos / Documents); stickers, hidden rich-link/plugin-payload
 * attachments, and unsent (retracted) messages are excluded. Links are the first http(s) URL
 * of each text message, deduped to the most
 * recent occurrence. `limit` caps each bucket so the strip stays lightweight.
 */
export async function listChatAttachmentsByKind(
  db: AppDatabase,
  chatGuid: string,
  limit = 60,
): Promise<ChatMediaByKind> {
  const out: ChatMediaByKind = { photos: [], videos: [], documents: [], links: [] };

  // Bound the scan: a chat can have thousands of attachments, but each of the 3 buckets
  // only needs `limit`. Pull a generous window (limit*bucketCount, with headroom for an
  // uneven kind distribution) instead of the whole chat, and stop bucketing once all
  // three buckets are full.
  const attRows = await db.all<AttachmentRow & { dateCreated: number | null }>(sql`
    SELECT
      a.id, a.guid, a.message_id AS messageId, a.mime_type AS mimeType,
      a.transfer_name AS transferName, a.total_bytes AS totalBytes,
      a.height, a.width, a.blurhash, a.has_live_photo AS hasLivePhoto,
      a.is_sticker AS isSticker, a.hide_attachment AS hideAttachment,
      a.emoji_image_content_identifier AS emojiImageContentIdentifier,
      a.emoji_image_short_description AS emojiImageShortDescription,
      a.local_path AS localPath, ${RCS_SERVICE_CASE} AS service, m.date_created AS dateCreated
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE c.guid = ${chatGuid}
      AND a.is_sticker = 0
      AND a.hide_attachment = 0
      AND m.date_retracted IS NULL
      AND m.date_deleted IS NULL
    ORDER BY m.date_created DESC, a.id DESC
    LIMIT ${limit * 4}
  `);
  for (const r of attRows) {
    const bucket =
      mediaSection(r.mimeType) === 'photo'
        ? out.photos
        : mediaSection(r.mimeType) === 'video'
          ? out.videos
          : out.documents;
    if (bucket.length < limit) bucket.push(r);
    // All three buckets full → nothing more to gather (rows are newest-first).
    if (out.photos.length >= limit && out.videos.length >= limit && out.documents.length >= limit) {
      break;
    }
  }

  // Links: scan text messages for a first URL. Most-recent first; one entry per URL.
  // Bounded too (dedup can drop rows, so allow headroom over `limit`).
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
      AND m.date_deleted IS NULL
      AND m.associated_message_type IS NULL
    ORDER BY m.date_created DESC, m.id DESC
    LIMIT ${limit * 4}
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

/**
 * Optimistically insert an outgoing image message + its local attachment + queue row.
 *
 * ALL THREE IN ONE TRANSACTION, unlike the text/contact/reaction helpers (which only order the
 * queue row first). Here the unit that owns recovery is the queue row TOGETHER WITH the attachment
 * row — the drain re-streams the file from `attachments.local_path`, so a queue row on its own is
 * retired the first time it is drained and the picture is silently lost, while a message row on
 * its own is a bubble frozen on 'sending' that nothing will ever retry. No ordering of three
 * autocommits avoids both, so they commit together or not at all.
 */
export interface InsertOutgoingAttachmentArgs {
  tempGuid: string;
  attachmentGuid: string;
  /** @deprecated Ignored. The transaction resolves `chatGuid` to its committed local id. */
  chatId?: number;
  chatGuid: string;
  localPath: string;
  mimeType: string;
  transferName: string;
  totalBytes: number;
  width?: number;
  height?: number;
  now: number;
}

export async function insertOutgoingAttachment(
  db: AppDatabase,
  args: InsertOutgoingAttachmentArgs,
): Promise<void> {
  await withDbTransaction(db, async () => {
    const chatId = await requireChatIdByGuidWithinTransaction(db, args.chatGuid);
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
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
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
  });
}

/**
 * Transaction-scoped form of {@link updateAttachmentLocalPath}. Use only when the caller already
 * owns the process-wide DB transaction and needs this path change to commit atomically with other
 * writes (currently attachment-cache ledger promotion).
 */
export function updateAttachmentLocalPathWithinTransaction(
  context: DbTransactionContext,
  attachmentGuid: string,
  localPath: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const updated = await db.all<{ id: number }>(sql`
    UPDATE attachments
       SET local_path = ${localPath}
     WHERE guid = ${attachmentGuid}
       AND EXISTS (
         SELECT 1 FROM messages m
         JOIN chats c ON c.id = m.chat_id
          WHERE m.id = attachments.message_id
            AND m.date_deleted IS NULL
            AND m.date_retracted IS NULL
            AND (
              c.deleted_at IS NULL
              OR (m.date_created IS NOT NULL AND m.date_created > c.deleted_at)
            )
       )
    RETURNING id
  `);
    return updated.length > 0;
  });
}

/**
 * Persist a downloaded file path (fires the reactive `attachments` watcher).
 *
 * Returns false when the attachment disappeared, or its owning message was locally deleted,
 * while native transfer work was in flight. The caller must then discard the newly downloaded
 * file instead of reporting a success that no visible row owns.
 */
export async function updateAttachmentLocalPath(
  db: AppDatabase,
  attachmentGuid: string,
  localPath: string,
): Promise<boolean> {
  return withDbTransaction(db, (context) =>
    updateAttachmentLocalPathWithinTransaction(context, attachmentGuid, localPath),
  );
}
