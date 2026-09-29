import { sql } from 'drizzle-orm';
import { resolveTitle } from '@utils/chat';
import { withDbTransaction, withDbWriteLock, type DbCommitGuard } from '../transaction';
import type { AppDatabase } from '../types';
import { foldInboxSearchText, uniqueInboxSearchBigrams } from './inboxSearchText';

/** Keep one rebuild short enough to yield the global writer queue between batches. */
const MAX_CHATS_PER_BATCH = 8;
const MAX_GRAMS_PER_BATCH = 1024;
const MAX_INDEXED_TEXT_UNITS = 1024;
// Bound text sent across the native SQL bridge before folding. A source beyond this conservative
// threshold stays on the existing exact dirty-search fallback, even if normalization shrinks it.
const MAX_SEARCH_SOURCE_BYTES = MAX_INDEXED_TEXT_UNITS * 4;
// A group beyond this sample cannot fit the index text cap once its separators are included.
// Keep the preflight itself short even when a group has arbitrarily many participants.
const MAX_PREFLIGHT_PARTICIPANTS = Math.floor(MAX_INDEXED_TEXT_UNITS / 2) + 1;

interface SearchIndexPreflight {
  id: number;
  revision: number;
  chatIdentifierBytes: number;
  displayNameBytes: number;
  customNameBytes: number;
  participantSampleCount: number;
  participantBytesUpper: number;
}

interface SearchIndexSnapshot {
  id: number;
  revision: number;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null;
  oversized: boolean;
}

type SearchIndexText = Omit<SearchIndexSnapshot, 'revision' | 'oversized'>;

interface PreparedChat {
  id: number;
  revision: number;
  grams: number[] | null;
}

function parseSearchIndexParticipantNames(value: string | null): (string | null)[] {
  if (value == null) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((name): name is string | null => name == null || typeof name === 'string')
  ) {
    throw new Error('Inbox search index participant snapshot is invalid.');
  }
  return parsed;
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

  const snapshots = await withDbWriteLock(async () => {
    const preflight = (await db.all<SearchIndexPreflight>(sql`
      SELECT s.chat_id AS id, s.revision,
             COALESCE(length(substr(CAST(COALESCE(c.chat_identifier, '') AS BLOB), 1, ${MAX_SEARCH_SOURCE_BYTES + 1})), 0) AS chatIdentifierBytes,
             COALESCE(length(substr(CAST(COALESCE(c.display_name, '') AS BLOB), 1, ${MAX_SEARCH_SOURCE_BYTES + 1})), 0) AS displayNameBytes,
             COALESCE(length(substr(CAST(COALESCE(c.custom_name, '') AS BLOB), 1, ${MAX_SEARCH_SOURCE_BYTES + 1})), 0) AS customNameBytes,
             (SELECT COUNT(*) FROM (
                SELECT 1 FROM chat_handles ch WHERE ch.chat_id = c.id
                 ORDER BY ch.handle_id LIMIT ${MAX_PREFLIGHT_PARTICIPANTS}
              )) AS participantSampleCount,
             (SELECT COALESCE(SUM(COALESCE(length(substr(CAST(COALESCE(h.display_name, h.address) AS BLOB),
                                                        1, ${MAX_SEARCH_SOURCE_BYTES + 1})), 0) + 2), 0)
                FROM (SELECT handle_id FROM chat_handles ch WHERE ch.chat_id = c.id
                       ORDER BY ch.handle_id LIMIT ${MAX_PREFLIGHT_PARTICIPANTS}) sampled
                JOIN handles h ON h.id = sampled.handle_id) AS participantBytesUpper
        FROM inbox_search_state s JOIN chats c ON c.id = s.chat_id
       WHERE s.is_dirty = 1 AND s.rebuildable = 1 AND s.chat_id > ${afterChatId}
       ORDER BY s.chat_id ASC
       LIMIT ${MAX_CHATS_PER_BATCH}
    `)) as SearchIndexPreflight[];
    const safeIds: number[] = [];
    for (const row of preflight) {
      if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.revision)) {
        throw new Error('Inbox search index snapshot has an invalid id or revision.');
      }
      if (
        [
          row.chatIdentifierBytes,
          row.displayNameBytes,
          row.customNameBytes,
          row.participantBytesUpper,
        ].every(
          (bytes) => Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_SEARCH_SOURCE_BYTES,
        ) &&
        Number.isSafeInteger(row.participantSampleCount) &&
        row.participantSampleCount < MAX_PREFLIGHT_PARTICIPANTS
      ) {
        safeIds.push(row.id);
      }
    }
    const safeIdsJson = JSON.stringify(safeIds);
    const texts: SearchIndexText[] =
      safeIds.length === 0
        ? []
        : ((await db.all<SearchIndexText>(sql`
            SELECT c.id, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
                   c.custom_name AS customName, c.style,
                   (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
                   (SELECT json_group_array(participant.name)
                      FROM (SELECT COALESCE(h.display_name, h.address) AS name
                              FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                             WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantNames
              FROM chats c
             WHERE c.id IN (SELECT CAST(value AS INTEGER) FROM json_each(${safeIdsJson}))
        `)) as SearchIndexText[]);
    const textById = new Map<number, SearchIndexText>(texts.map((row) => [row.id, row]));
    return preflight.map((row): SearchIndexSnapshot => {
      const text = textById.get(row.id);
      if (text) return { ...text, revision: row.revision, oversized: false };
      if (safeIds.includes(row.id)) throw new Error('Inbox search index text snapshot is missing.');
      return {
        id: row.id,
        revision: row.revision,
        chatIdentifier: null,
        displayName: null,
        customName: null,
        style: null,
        participantCount: 0,
        participantNames: null,
        oversized: true,
      };
    });
  });
  if (snapshots.length === 0 || (commitGuard && !commitGuard())) return empty;

  const prepared: PreparedChat[] = [];
  let gramBudget = MAX_GRAMS_PER_BATCH;
  for (const snapshot of snapshots) {
    if (!Number.isSafeInteger(snapshot.id) || !Number.isSafeInteger(snapshot.revision)) {
      throw new Error('Inbox search index snapshot has an invalid id or revision.');
    }
    const participantNames = snapshot.oversized
      ? []
      : parseSearchIndexParticipantNames(snapshot.participantNames);
    const title = snapshot.oversized
      ? ''
      : resolveTitle({
          ...snapshot,
          participantNames: JSON.stringify(participantNames),
        });
    const participantSearchText = participantNames
      .filter((name): name is string => name != null)
      .join(', ');
    const folded = snapshot.oversized
      ? ''
      : foldInboxSearchText(`${title} ${participantSearchText}`);
    const grams =
      snapshot.oversized || folded.length > MAX_INDEXED_TEXT_UNITS
        ? null
        : uniqueInboxSearchBigrams(folded);
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
