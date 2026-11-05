import { sql } from 'drizzle-orm';
import { mediaSection } from '@utils';
import type { AppDatabase } from '../types';
import { attachmentIsUserFileSql, messageVisibleInChatSql } from './chatVisibility';

/** Counts for one chat's Details screen, from what is stored on this phone. */
export interface ChatStats {
  sent: number;
  received: number;
  photos: number;
  videos: number;
  otherFiles: number;
  /** Earliest stored visible message (epoch ms), or null when the chat has none. */
  firstMessageAt: number | null;
}

/** Distinct attachment types to classify; far more than any chat realistically has. */
const MAX_MIME_GROUPS = 500;

/**
 * Per-chat stats with the same rules the Details media lists use: visible messages only (not
 * deleted, retracted or behind a local chat deletion), no reactions or group events; attachments
 * that are real user files (no stickers, hidden or retracted parts). Two aggregate reads: messages
 * by sender, and attachments grouped by type, which `mediaSection` then classifies in JS exactly as
 * the media lists do, so the numbers can't disagree with what Details shows.
 */
export async function getChatStats(db: AppDatabase, chatGuid: string): Promise<ChatStats> {
  const messageRows = await db.all<{
    sent: number | null;
    received: number | null;
    firstMessageAt: number | null;
  }>(sql`
    SELECT
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN m.is_from_me = 1 THEN 0 ELSE 1 END) AS received,
      MIN(m.date_created) AS firstMessageAt
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    WHERE c.guid = ${chatGuid}
      AND m.associated_message_type IS NULL
      AND COALESCE(m.item_type, 0) = 0
      AND ${messageVisibleInChatSql('m', 'c')}
  `);
  const mimeRows = await db.all<{ mimeType: string | null; count: number }>(sql`
    SELECT LOWER(a.mime_type) AS mimeType, COUNT(*) AS count
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN chats c ON c.id = m.chat_id
    WHERE c.guid = ${chatGuid}
      AND a.is_sticker = 0
      AND a.hide_attachment = 0
      AND a.is_retracted = 0
      AND ${attachmentIsUserFileSql('a', 'm')}
      AND ${messageVisibleInChatSql('m', 'c')}
    GROUP BY LOWER(a.mime_type)
    LIMIT ${MAX_MIME_GROUPS}
  `);
  let photos = 0;
  let videos = 0;
  let otherFiles = 0;
  for (const row of mimeRows) {
    const section = mediaSection(row.mimeType);
    if (section === 'photo') photos += row.count;
    else if (section === 'video') videos += row.count;
    else otherFiles += row.count;
  }
  const totals = messageRows[0];
  return {
    sent: totals?.sent ?? 0,
    received: totals?.received ?? 0,
    photos,
    videos,
    otherFiles,
    firstMessageAt: totals?.firstMessageAt ?? null,
  };
}
