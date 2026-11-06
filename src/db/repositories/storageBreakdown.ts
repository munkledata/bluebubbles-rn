import { sql } from 'drizzle-orm';
import type { Queryable } from '../types';

export interface ChatStorageUsage {
  chatGuid: string;
  files: number;
  bytes: number;
}

/** Downloaded-file space on this phone, for the Storage Analyzer. */
export interface StorageBreakdown {
  /** Every cached file (active and still-being-deleted), as the cache policy counts it. */
  totalFiles: number;
  totalBytes: number;
  /** The chats using the most space, largest first. A file shared by two chats counts in both. */
  topChats: ChatStorageUsage[];
  /** Cached files no message points at: wallpapers, group photos, contact pictures and the like. */
  otherFiles: number;
  otherBytes: number;
}

const MAX_TOP_CHATS = 50;

/**
 * Bounded read over `attachment_cache_entries` (the cache policy caps it at a few thousand files).
 * Per-chat space joins cached files to the attachments that use them through
 * `attachments_local_path_idx`; each file counts once per chat. Read-only.
 */
export async function getStorageBreakdown(
  db: Queryable,
  topChatLimit = 10,
): Promise<StorageBreakdown> {
  const limit = Math.max(1, Math.min(MAX_TOP_CHATS, Math.floor(topChatLimit)));
  const totals = await db.all<{ files: number; bytes: number }>(sql`
    SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM attachment_cache_entries
  `);
  const other = await db.all<{ files: number; bytes: number }>(sql`
    SELECT COUNT(*) AS files, COALESCE(SUM(e.bytes), 0) AS bytes
      FROM attachment_cache_entries e
     WHERE NOT EXISTS (
       SELECT 1 FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE a.local_path = e.path
     )
  `);
  const topChats = await db.all<ChatStorageUsage>(sql`
    WITH chat_files AS (
      SELECT DISTINCT c.guid AS chatGuid, e.path AS path, e.bytes AS bytes
        FROM attachment_cache_entries e
        JOIN attachments a ON a.local_path = e.path
        JOIN messages m ON m.id = a.message_id
        JOIN chats c ON c.id = m.chat_id
    )
    SELECT chatGuid, COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes
      FROM chat_files
     GROUP BY chatGuid
     ORDER BY bytes DESC, chatGuid ASC
     LIMIT ${limit}
  `);
  return {
    totalFiles: totals[0]?.files ?? 0,
    totalBytes: totals[0]?.bytes ?? 0,
    topChats,
    otherFiles: other[0]?.files ?? 0,
    otherBytes: other[0]?.bytes ?? 0,
  };
}
