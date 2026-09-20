import { sql } from 'drizzle-orm';
import { resolveTitle } from '@utils/chat';
import { withDbTransaction, withDbWriteLock, type DbCommitGuard } from '../transaction';
import type { AppDatabase } from '../types';
import { foldInboxSearchText, uniqueInboxSearchBigrams } from './inboxSearchText';

/** Keep one rebuild short enough to yield the global writer queue between batches. */
const MAX_CHATS_PER_BATCH = 8;
const MAX_GRAMS_PER_BATCH = 1024;
const MAX_INDEXED_TEXT_UNITS = 1024;

interface SearchIndexSnapshot {
  id: number;
  revision: number;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null;
}

interface PreparedChat {
  id: number;
  revision: number;
  grams: number[] | null;
}

export interface InboxSearchRebuildBatch {
  visited: number;
  lastChatId: number;
  settled: number;
  deferred: number;
}

/**
 * Rebuild a small id-ordered slice. Reads take the shared lock so a snapshot never sees another
 * owner's uncommitted same-connection writes. Preparation runs outside the lock; the short settle
 * transaction accepts a snapshot only while its permanent revision row still matches.
 *
 * Oversized text remains dirty and is searched directly, so the index never changes results or
 * holds the writer queue while building an unbounded posting set.
 */
export async function rebuildInboxSearchIndexBatch(
  db: AppDatabase,
  afterChatId = 0,
  commitGuard?: DbCommitGuard,
): Promise<InboxSearchRebuildBatch> {
  const empty = { visited: 0, lastChatId: afterChatId, settled: 0, deferred: 0 };
  if (commitGuard && !commitGuard()) return empty;

  const snapshots = (await withDbWriteLock(() =>
    db.all<SearchIndexSnapshot>(sql`
      SELECT s.chat_id AS id, s.revision,
             c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
             c.custom_name AS customName, c.style,
             (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
             (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
                FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
               WHERE ch.chat_id = c.id) AS participantNames
        FROM inbox_search_state s JOIN chats c ON c.id = s.chat_id
       WHERE s.is_dirty = 1 AND s.rebuildable = 1 AND s.chat_id > ${afterChatId}
       ORDER BY s.chat_id ASC
       LIMIT ${MAX_CHATS_PER_BATCH}
    `),
  )) as SearchIndexSnapshot[];
  if (snapshots.length === 0 || (commitGuard && !commitGuard())) return empty;

  const prepared: PreparedChat[] = [];
  let gramBudget = MAX_GRAMS_PER_BATCH;
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.id) || !Number.isSafeInteger(snapshot.revision)) {
      throw new Error('Inbox search index snapshot has an invalid id or revision.');
    }
    const title = resolveTitle(snapshot);
    const folded = foldInboxSearchText(`${title} ${snapshot.participantNames ?? ''}`);
    const grams = folded.length > MAX_INDEXED_TEXT_UNITS ? null : uniqueInboxSearchBigrams(folded);
    if (grams != null && grams.length > gramBudget && prepared.length > 0) break;
    prepared.push({
      id: snapshot.id,
      revision: snapshot.revision,
      grams: grams != null && grams.length <= gramBudget ? grams : null,
    });
    gramBudget -= grams?.length ?? 0;
  }

  let settled = 0;
  let deferred = 0;
  await withDbTransaction(
    db,
    async () => {
      for (const chat of prepared) {
        const state = await db.all<{ revision: number }>(sql`
          SELECT revision FROM inbox_search_state
           WHERE chat_id = ${chat.id} AND is_dirty = 1 AND rebuildable = 1
        `);
        if (state[0]?.revision !== chat.revision) continue;
        if (chat.grams == null) {
          await db.run(sql`
            UPDATE inbox_search_state SET rebuildable = 0
             WHERE chat_id = ${chat.id} AND revision = ${chat.revision} AND is_dirty = 1
          `);
          deferred += 1;
          continue;
        }

        const gramsJson = JSON.stringify(chat.grams);
        // Add before pruning: same-connection readers may see intermediate writes even while
        // this transaction is open. The dirty row remains visible until the final state write.
        await db.run(sql`
          INSERT OR IGNORE INTO inbox_search_postings (chat_id, gram)
          SELECT ${chat.id}, CAST(value AS INTEGER) FROM json_each(${gramsJson})
        `);
        await db.run(sql`
          DELETE FROM inbox_search_postings
           WHERE chat_id = ${chat.id}
             AND gram NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(${gramsJson}))
        `);
        await db.run(sql`
          UPDATE inbox_search_state SET is_dirty = 0
           WHERE chat_id = ${chat.id} AND revision = ${chat.revision} AND is_dirty = 1
        `);
        settled += 1;
      }
    },
    commitGuard,
  );

  return {
    visited: prepared.length,
    lastChatId: prepared[prepared.length - 1]!.id,
    settled,
    deferred,
  };
}
