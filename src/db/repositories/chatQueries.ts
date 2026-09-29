import { and, eq, sql } from 'drizzle-orm';
import { normalizeInboxFilters, type InboxFilters } from '@core/models';
import { resolveTitle } from '@utils/chat';
import { chats } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { AppDatabase } from '../types';
import {
  chatUnreadCountSql,
  chatVisible,
  inboxFilterSql,
  messageHasVisibleContentSql,
  type InboxArchiveFilter,
  type InboxSenderFilter,
} from './chatVisibility';
import { MAX_CUSTOM_FOLDER_MEMBERS, type CustomFolderRow } from './customFolders';
import { foldInboxSearchText, uniqueInboxSearchBigrams } from './inboxSearchText';
import { searchCustomFolderChatGuidsByMessage } from './messageQueries';

export type { InboxArchiveFilter, InboxSenderFilter } from './chatVisibility';

/** Read-only inbox and conversation queries, separate from chat mutation ownership. */

// ---- Queries ---------------------------------------------------------------

/** Inbox: non-archived chats, most-recent first. Locally deleted chats are hidden (chatVisible). */
export function listChats(db: AppDatabase, opts: { includeArchived?: boolean } = {}) {
  const visible = chatVisible('chats');
  if (opts.includeArchived) {
    return db
      .select()
      .from(chats)
      .where(visible)
      .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
  }
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.isArchived, false), visible))
    .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
}

/**
 * One row per chat, ready to render a conversation tile: chat metadata, the
 * latest message preview, participant names/count, and an unread count — in a
 * single query. Raw SQL via db.all so it runs identically on op-sqlite (device)
 * and better-sqlite3 (tests). Booleans come back as 0/1 integers.
 */
export interface InboxRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  style: number | null;
  isPinned: number;
  /** Production inbox queries always provide the persisted manual rank. */
  pinOrder?: number | null;
  isArchived: number;
  muteType: string | null;
  latestMessageDate: number | null;
  lastReadMessageGuid: string | null;
  lastText: string | null;
  lastSubject: string | null;
  lastIsFromMe: number | null;
  lastHasAttachments: number | null;
  lastDate: number | null;
  lastGuid: string | null;
  lastAssociatedType: string | null;
  lastError: number | null;
  // Genmoji description of the latest message's first Genmoji attachment (or null) — the inbox
  // preview fallback in place of "📎 Attachment". Optional so hand-built InboxRow test literals need
  // not set it; the query below always provides it at runtime.
  lastAttachmentDescription?: string | null;
  /** Latest message's extension identifier, used only for a safe local fallback label. */
  lastBalloonBundleId?: string | null;
  /** 1 when the latest message has an attachment the UI does not hide. */
  lastHasVisibleAttachments?: number;
  participantCount: number;
  /** JSON string array ordered by handle id. */
  participantNames: string | null;
  /** JSON string/null array positionally aligned with participantNames. */
  participantAvatars: string | null;
  /** JSON string/null array positionally aligned with participant names/avatars. */
  participantColors?: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  unreadCount: number;
  /** 1 when any participant matched a device contact — the "unknown senders" filter signal. */
  hasKnownSender: number;
}

export interface InboxPageOptions {
  limit?: number;
  archive?: InboxArchiveFilter;
  sender?: InboxSenderFilter;
  filters?: InboxFilters;
}

export interface InboxPage {
  rows: InboxRow[];
  hasMore: boolean;
}

export interface InboxSearchOptions {
  query: string;
  /** Bounded conversation GUIDs whose visible message content matched the same query. */
  messageMatchGuids?: readonly string[];
  /** Search surfaces render at most 50 conversation tiles. */
  limit?: number;
  /** Stop an obsolete term/account scan between bounded SQL pages. */
  shouldContinue?: () => boolean;
}

export interface CustomFolderInboxPage extends InboxPage {
  folder: CustomFolderRow;
  /** Visible chat rows in the complete folder, not only the currently loaded prefix. */
  availableCount: number;
  /** Available chats matching the settled folder search, or availableCount when browsing. */
  matchingCount: number;
}

const MAX_CUSTOM_FOLDER_SEARCH_CODE_POINTS = 128;
const INBOX_SEARCH_CANDIDATE_PAGE_SIZE = 128;
const INBOX_SEARCH_PARTICIPANT_PAGE_SIZE = 128;
const INBOX_SEARCH_PAGES_PER_YIELD = 8;
const MAX_INBOX_SEARCH_RESULTS = 50;
const MAX_INBOX_MESSAGE_MATCH_GUIDS = 300;

interface CustomFolderSearchCandidate {
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null;
  participantSearchText: string | null;
}

interface InboxSearchCandidate extends Omit<
  CustomFolderSearchCandidate,
  'participantCount' | 'participantNames' | 'participantSearchText'
> {
  id: number;
  isPinned: number;
  pinOrder: number | null;
  latestMessageDate: number | null;
}

interface InboxSearchTextSummary {
  matched: boolean;
  prefix: string;
  suffix: string;
  hasText: boolean;
}

interface InboxSearchParticipantState {
  candidate: InboxSearchCandidate;
  participantCount: number;
  rawValueCount: number;
  participantTitlePartCount: number;
  rawParticipants: InboxSearchTextSummary;
  participantTitle: InboxSearchTextSummary;
  staticTitle: string | null;
}

export class InboxSearchCancelledError extends Error {
  constructor() {
    super('Inbox search was cancelled.');
    this.name = 'InboxSearchCancelledError';
  }
}

function emptyInboxSearchTextSummary(): InboxSearchTextSummary {
  return { matched: false, prefix: '', suffix: '', hasText: false };
}

function appendInboxSearchText(
  summary: InboxSearchTextSummary,
  text: string,
  foldedQuery: string,
): void {
  const folded = foldInboxSearchText(text);
  const retainedUnits = Math.max(0, foldedQuery.length - 1);
  if (summary.prefix.length < retainedUnits) {
    summary.prefix += folded.slice(0, retainedUnits - summary.prefix.length);
  }
  const window = `${summary.suffix}${folded}`;
  if (window.includes(foldedQuery)) summary.matched = true;
  summary.suffix = retainedUnits === 0 ? '' : window.slice(-retainedUnits);
  if (folded.length > 0) summary.hasText = true;
}

function summarizeInboxSearchText(text: string, foldedQuery: string): InboxSearchTextSummary {
  const summary = emptyInboxSearchTextSummary();
  appendInboxSearchText(summary, text, foldedQuery);
  return summary;
}

const INBOX_SEARCH_PARTICIPANT_TITLE_PROBE_A = '__gator_participant_title_probe_a__';
const INBOX_SEARCH_PARTICIPANT_TITLE_PROBE_B = '__gator_participant_title_probe_b__';

/**
 * Ask the shared title resolver whether participants own this title without duplicating its name
 * and weak-fallback rules here. Different participant-only probes can change the answer only when
 * the resolver reaches its participant fallback.
 */
function resolveStaticInboxSearchTitle(candidate: InboxSearchCandidate): string | null {
  const input = { ...candidate, participantCount: 0 };
  const first = resolveTitle({
    ...input,
    participantNames: JSON.stringify([INBOX_SEARCH_PARTICIPANT_TITLE_PROBE_A]),
  });
  const second = resolveTitle({
    ...input,
    participantNames: JSON.stringify([INBOX_SEARCH_PARTICIPANT_TITLE_PROBE_B]),
  });
  return first === second ? first : null;
}

/**
 * Verify participant text without asking SQLite to materialize a data-sized group_concat. The
 * row and bridge result of every call are capped; exact scans may still need multiple cancellable
 * pages for a very large group. Rolling prefix/suffix summaries preserve matches across both the
 * literal participant separator and the resolved-title/participant boundary.
 */
async function exactInboxSearchNameMatches(
  db: AppDatabase,
  candidates: readonly InboxSearchCandidate[],
  foldedQuery: string,
  checkCurrent: () => void,
): Promise<Set<number>> {
  const matches = new Set<number>();
  const candidateIds = new Set<number>();
  const states = new Map<number, InboxSearchParticipantState>();
  for (const candidate of candidates) {
    if (
      !Number.isSafeInteger(candidate.id) ||
      candidate.id <= 0 ||
      candidateIds.has(candidate.id)
    ) {
      throw new Error('Inbox search participant candidate id is invalid.');
    }
    candidateIds.add(candidate.id);
    const staticTitle = resolveStaticInboxSearchTitle(candidate);
    if (staticTitle != null && summarizeInboxSearchText(staticTitle, foldedQuery).matched) {
      matches.add(candidate.id);
      continue;
    }
    states.set(candidate.id, {
      candidate,
      participantCount: 0,
      rawValueCount: 0,
      participantTitlePartCount: 0,
      rawParticipants: emptyInboxSearchTextSummary(),
      participantTitle: emptyInboxSearchTextSummary(),
      staticTitle,
    });
  }

  let cursorChatId = 0;
  let cursorHandleId = 0;
  let pages = 0;
  while (states.size > 0) {
    checkCurrent();
    if (pages > 0 && pages % INBOX_SEARCH_PAGES_PER_YIELD === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCurrent();
    }
    const activeIdsJson = JSON.stringify([...states.keys()]);
    const participants = await db.all<{
      chatId: number;
      handleId: number;
      participantName: string | null;
    }>(sql`
      SELECT ch.chat_id AS chatId, h.id AS handleId,
             COALESCE(h.display_name, h.address) AS participantName
        FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
       WHERE ch.chat_id IN (
               SELECT CAST(value AS INTEGER) FROM json_each(${activeIdsJson})
             )
         AND (ch.chat_id > ${cursorChatId}
              OR (ch.chat_id = ${cursorChatId} AND h.id > ${cursorHandleId}))
       ORDER BY ch.chat_id ASC, h.id ASC
       LIMIT ${INBOX_SEARCH_PARTICIPANT_PAGE_SIZE}
    `);
    checkCurrent();
    if (participants.length > INBOX_SEARCH_PARTICIPANT_PAGE_SIZE) {
      throw new Error('Inbox search participant page exceeds its safety bound.');
    }
    if (participants.length === 0) break;

    let previousChatId = cursorChatId;
    let previousHandleId = cursorHandleId;
    for (const participant of participants) {
      if (
        !Number.isSafeInteger(participant.chatId) ||
        !Number.isSafeInteger(participant.handleId) ||
        participant.chatId <= 0 ||
        participant.handleId <= 0 ||
        !candidateIds.has(participant.chatId) ||
        participant.chatId < previousChatId ||
        (participant.chatId === previousChatId && participant.handleId <= previousHandleId)
      ) {
        throw new Error('Inbox search participant cursor is invalid.');
      }
      previousChatId = participant.chatId;
      previousHandleId = participant.handleId;

      const state = states.get(participant.chatId);
      if (!state) continue;
      state.participantCount += 1;
      if (!Number.isSafeInteger(state.participantCount)) {
        throw new Error('Inbox search participant count is invalid.');
      }
      if (participant.participantName == null) continue;
      if (typeof participant.participantName !== 'string') {
        throw new Error('Inbox search participant name is invalid.');
      }

      if (state.rawValueCount > 0) {
        appendInboxSearchText(state.rawParticipants, ', ', foldedQuery);
      }
      appendInboxSearchText(state.rawParticipants, participant.participantName, foldedQuery);
      state.rawValueCount += 1;

      const titlePart = participant.participantName.trim();
      if (titlePart) {
        if (state.participantTitlePartCount > 0) {
          appendInboxSearchText(state.participantTitle, ', ', foldedQuery);
        }
        appendInboxSearchText(state.participantTitle, titlePart, foldedQuery);
        state.participantTitlePartCount += 1;
      }

      if (
        state.rawParticipants.matched ||
        (state.staticTitle == null && state.participantTitle.matched)
      ) {
        matches.add(participant.chatId);
        states.delete(participant.chatId);
      }
    }

    const last = participants[participants.length - 1]!;
    cursorChatId = last.chatId;
    cursorHandleId = last.handleId;
    pages += 1;
    if (participants.length < INBOX_SEARCH_PARTICIPANT_PAGE_SIZE) break;
  }

  checkCurrent();
  for (const state of states.values()) {
    const title =
      state.staticTitle != null
        ? summarizeInboxSearchText(state.staticTitle, foldedQuery)
        : state.participantTitle.hasText
          ? state.participantTitle
          : summarizeInboxSearchText(
              resolveTitle({
                ...state.candidate,
                participantCount: state.participantCount,
                participantNames: null,
              }),
              foldedQuery,
            );
    if (
      title.matched ||
      state.rawParticipants.matched ||
      `${title.suffix} ${state.rawParticipants.prefix}`.includes(foldedQuery)
    ) {
      matches.add(state.candidate.id);
    }
  }
  return matches;
}

function requireCustomFolderId(folderId: number): void {
  if (!Number.isSafeInteger(folderId) || folderId <= 0) {
    throw new RangeError('Folder id must be a positive safe integer.');
  }
}

function customFolderMembershipSql(folderId: number | undefined) {
  if (folderId == null) return sql``;
  requireCustomFolderId(folderId);
  return sql`AND EXISTS(
    SELECT 1 FROM custom_folder_members cfm
     WHERE cfm.folder_id = ${folderId} AND cfm.chat_guid = c.guid
  )`;
}

function normalizeCustomFolderSearch(input: string | undefined): string {
  if (input == null) return '';
  if (typeof input !== 'string') throw new TypeError('Folder search must be text.');
  const normalized = Array.from(input.normalize('NFC').trim())
    .slice(0, MAX_CUSTOM_FOLDER_SEARCH_CODE_POINTS)
    .join('');
  return Array.from(normalized).length >= 2 ? normalized : '';
}

function inboxChatGuidRestrictionSql(chatGuids: readonly string[] | undefined) {
  if (chatGuids == null) return sql``;
  if (chatGuids.length === 0) return sql`AND 0`;
  return sql`AND c.guid IN (
    SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(chatGuids)})
  )`;
}

async function queryChatsForInbox(
  db: AppDatabase,
  options: {
    archive: InboxArchiveFilter;
    sender: InboxSenderFilter;
    filters?: InboxFilters;
    limit?: number;
    folderId?: number;
    chatGuids?: readonly string[];
  },
): Promise<InboxRow[]> {
  const filters = inboxFilterSql(options);
  const folderMembership = customFolderMembershipSql(options.folderId);
  const chatGuidRestriction = inboxChatGuidRestrictionSql(options.chatGuids);
  const limit = options.limit == null ? sql`` : sql`LIMIT ${options.limit}`;
  return db.all<InboxRow>(sql`
    -- Bound the chat identities FIRST. Pinned rows use their device-local manual rank; unpinned
    -- rows retain newest-first ordering. Splitting the branches lets each use its own index and
    -- keeps the final merge bounded, while new pinned activity cannot perturb the manual order.
    WITH pinned AS (
      SELECT c.id, c.is_pinned,
             COALESCE(c.pin_order, 9223372036854775807) AS pin_sort,
             NULL AS date_sort
       FROM chats c
       WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender} ${filters.criteria}
         ${folderMembership}
         ${chatGuidRestriction}
         AND c.is_pinned = 1
       ORDER BY pin_sort ASC, c.id DESC
       ${limit}
    ),
    unpinned AS (
      SELECT c.id, c.is_pinned, NULL AS pin_sort, c.latest_message_date AS date_sort
       FROM chats c
       WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender} ${filters.criteria}
         ${folderMembership}
         ${chatGuidRestriction}
         AND c.is_pinned = 0
       ORDER BY c.latest_message_date DESC, c.id DESC
       ${limit}
    ),
    page AS (
      SELECT id, is_pinned, pin_sort, date_sort FROM pinned
      UNION ALL
      SELECT id, is_pinned, pin_sort, date_sort FROM unpinned
      ORDER BY is_pinned DESC, pin_sort ASC, date_sort DESC, id DESC
      ${limit}
    )
    SELECT
      c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor,
      c.style, c.is_pinned AS isPinned, c.pin_order AS pinOrder,
      c.is_archived AS isArchived, c.mute_type AS muteType,
      c.latest_message_date AS latestMessageDate, c.last_read_message_guid AS lastReadMessageGuid,
      l.text AS lastText, l.subject AS lastSubject, l.is_from_me AS lastIsFromMe,
      l.has_attachments AS lastHasAttachments, l.date_created AS lastDate, l.guid AS lastGuid,
      l.balloon_bundle_id AS lastBalloonBundleId,
      l.associated_message_type AS lastAssociatedType, l.error AS lastError,
      (SELECT a.emoji_image_short_description FROM attachments a
         WHERE a.message_id = l.id
           AND l.balloon_bundle_id IS NULL
           AND a.hide_attachment = 0
           AND a.is_retracted = 0
           AND a.emoji_image_short_description IS NOT NULL
         ORDER BY a.id ASC LIMIT 1) AS lastAttachmentDescription,
      CASE WHEN l.balloon_bundle_id IS NULL THEN
        EXISTS(SELECT 1 FROM attachments a
                 WHERE a.message_id = l.id AND a.hide_attachment = 0 AND a.is_retracted = 0)
      ELSE 0 END AS lastHasVisibleAttachments,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT json_group_array(participant.name)
         FROM (SELECT COALESCE(h.display_name, h.address) AS name
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantNames,
      (SELECT json_group_array(participant.avatar)
         FROM (SELECT h.avatar
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantAvatars,
      (SELECT json_group_array(participant.color)
         FROM (SELECT h.color
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantColors,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices,
      -- The shared helper retains the last-read + local-deletion floor used by inbox filtering and
      -- folder unread badges. A re-synced pre-delete history must never become unread again.
      ${chatUnreadCountSql('c')} AS unreadCount,
      EXISTS(SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
              WHERE ck.chat_id = c.id AND hk.contact_id IS NOT NULL) AS hasKnownSender
    FROM page p
    JOIN chats c ON c.id = p.id
    LEFT JOIN messages l ON l.id = (
      SELECT m.id FROM messages m
       WHERE m.chat_id = c.id AND m.associated_message_type IS NULL
         AND ${messageHasVisibleContentSql('m')} AND m.date_deleted IS NULL
       ORDER BY m.date_created DESC, m.id DESC LIMIT 1
    )
    ORDER BY p.is_pinned DESC, p.pin_sort ASC, p.date_sort DESC, p.id DESC
  `);
}

/**
 * Inbox rows for the conversation list: manually ordered pins first, then unpinned chats by newest
 * message. The "last message" is resolved dedupe-safely (max date, then max id) so chats never
 * appear twice.
 */
export async function listChatsForInbox(
  db: AppDatabase,
  opts: { includeArchived?: boolean; filters?: InboxFilters } = {},
): Promise<InboxRow[]> {
  const filters = normalizeInboxFilters(opts.filters);
  return queryChatsForInbox(db, {
    archive: opts.includeArchived ? 'all' : 'active',
    sender: filters.sender,
    filters,
  });
}

/** One growing-prefix page; the extra row is consumed only as the `hasMore` sentinel. */
export async function listChatsForInboxPage(
  db: AppDatabase,
  opts: InboxPageOptions = {},
): Promise<InboxPage> {
  const requested = opts.limit ?? 50;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 50;
  const rows = await queryChatsForInbox(db, {
    archive: opts.archive ?? 'active',
    sender: opts.sender ?? 'any',
    filters: opts.filters,
    limit: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

function compareInboxSearchCandidates(
  left: InboxSearchCandidate,
  right: InboxSearchCandidate,
): number {
  if (left.isPinned !== right.isPinned) return left.isPinned === 1 ? -1 : 1;

  if (left.isPinned === 1) {
    if (left.pinOrder == null && right.pinOrder != null) return 1;
    if (left.pinOrder != null && right.pinOrder == null) return -1;
    if (left.pinOrder != null && right.pinOrder != null && left.pinOrder !== right.pinOrder) {
      return left.pinOrder < right.pinOrder ? -1 : 1;
    }
  } else {
    if (left.latestMessageDate == null && right.latestMessageDate != null) return 1;
    if (left.latestMessageDate != null && right.latestMessageDate == null) return -1;
    if (
      left.latestMessageDate != null &&
      right.latestMessageDate != null &&
      left.latestMessageDate !== right.latestMessageDate
    ) {
      return left.latestMessageDate > right.latestMessageDate ? -1 : 1;
    }
  }

  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function normalizeInboxSearch(input: string): string {
  if (typeof input !== 'string') throw new TypeError('Inbox search must be text.');
  const normalized = Array.from(input.normalize('NFC').trim())
    .slice(0, MAX_CUSTOM_FOLDER_SEARCH_CODE_POINTS)
    .join('');
  return Array.from(normalized).length >= 2 ? normalized : '';
}

function boundedMessageMatchSet(guids: readonly string[] | undefined): Set<string> {
  const bounded = new Set<string>();
  for (const guid of guids ?? []) {
    if (typeof guid === 'string' && guid.length > 0) bounded.add(guid);
    if (bounded.size >= MAX_INBOX_MESSAGE_MATCH_GUIDS) break;
  }
  return bounded;
}

/**
 * Search active inbox identities without retaining/decorating the entire inbox. A persisted bigram
 * postings narrow indexed identities; dirty/unindexable identities and bounded message hits are
 * unioned in, so indexing never decides exact text matches. One SQL statement snapshots all three
 * candidate sources per page; an indexer cannot move an id from dirty to indexed between reads.
 * Each source first contributes a bounded raw id window, and only that merged raw page receives
 * the remaining-gram checks. The immutable AUTOINCREMENT chat id is the cursor, and a starting
 * high-water mark prevents sustained inserts from extending one refresh forever. Common bigrams
 * or a dirty migration backlog can still require many pages; each candidate-id call, returned row
 * set, decorated set, and participant result page remain capped. An exact participant scan may
 * still require data-sized total pages, and an individual participant field remains data-sized.
 */
export async function searchChatsForInboxPage(
  db: AppDatabase,
  opts: InboxSearchOptions,
): Promise<InboxPage> {
  const query = normalizeInboxSearch(opts.query);
  if (!query) return { rows: [], hasMore: false };

  const requested = opts.limit ?? MAX_INBOX_SEARCH_RESULTS;
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_INBOX_SEARCH_RESULTS, Math.max(1, Math.floor(requested)))
    : MAX_INBOX_SEARCH_RESULTS;
  const retainedLimit = limit + 1;
  const foldedQuery = foldInboxSearchText(query);
  const [firstGram, ...otherGrams] = uniqueInboxSearchBigrams(foldedQuery);
  if (firstGram == null) throw new Error('Inbox search has no bigram.');
  const otherGramsJson = JSON.stringify(otherGrams);
  const checkCurrent = (): void => {
    if (opts.shouldContinue?.() === false) throw new InboxSearchCancelledError();
  };
  checkCurrent();
  const messageMatchGuids = boundedMessageMatchSet(opts.messageMatchGuids);
  const messageMatchJson = JSON.stringify([...messageMatchGuids]);
  const horizonRows = await db.all<{ maxId: number | null }>(sql`
    SELECT MAX(id) AS maxId FROM chats
  `);
  const highWater = horizonRows[0]?.maxId ?? 0;
  checkCurrent();
  if (!Number.isSafeInteger(highWater) || highWater < 0) {
    throw new Error('Inbox search high-water id is invalid.');
  }
  if (highWater === 0) return { rows: [], hasMore: false };

  let cursor = 0;
  let pages = 0;
  const retained: InboxSearchCandidate[] = [];
  while (cursor < highWater) {
    checkCurrent();
    if (pages > 0 && pages % INBOX_SEARCH_PAGES_PER_YIELD === 0) {
      // Let a changed term/account retire this scan without monopolizing the JS turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCurrent();
    }
    const rawCandidates = (await db.all<{ id: number; isCandidate: number }>(sql`
      WITH posting_window AS MATERIALIZED (
        SELECT p.chat_id AS id FROM inbox_search_postings p
         WHERE p.gram = ${firstGram} AND p.chat_id > ${cursor} AND p.chat_id <= ${highWater}
         ORDER BY p.chat_id ASC LIMIT ${INBOX_SEARCH_CANDIDATE_PAGE_SIZE}
      ), dirty_window AS MATERIALIZED (
        SELECT chat_id AS id FROM inbox_search_state
         WHERE is_dirty = 1 AND chat_id > ${cursor} AND chat_id <= ${highWater}
         ORDER BY chat_id ASC LIMIT ${INBOX_SEARCH_CANDIDATE_PAGE_SIZE}
      ), message_window AS MATERIALIZED (
        SELECT id FROM chats
         WHERE id > ${cursor} AND id <= ${highWater}
           AND guid IN (SELECT CAST(value AS TEXT) FROM json_each(${messageMatchJson}))
         ORDER BY id ASC LIMIT ${INBOX_SEARCH_CANDIDATE_PAGE_SIZE}
      ), raw_ids AS MATERIALIZED (
        SELECT id FROM (
          SELECT id FROM posting_window
          UNION SELECT id FROM dirty_window
          UNION SELECT id FROM message_window
        )
        ORDER BY id ASC LIMIT ${INBOX_SEARCH_CANDIDATE_PAGE_SIZE}
      )
      SELECT raw.id,
             CASE WHEN
               EXISTS (SELECT 1 FROM inbox_search_state dirty
                        WHERE dirty.chat_id = raw.id AND dirty.is_dirty = 1)
               OR EXISTS (SELECT 1 FROM chats message_match
                           WHERE message_match.id = raw.id
                             AND message_match.guid IN (
                               SELECT CAST(value AS TEXT) FROM json_each(${messageMatchJson})
                             ))
               OR (
                 EXISTS (SELECT 1 FROM posting_window source WHERE source.id = raw.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(${otherGramsJson}) required
                    WHERE NOT EXISTS (
                      SELECT 1 FROM inbox_search_postings present
                       WHERE present.chat_id = raw.id
                         AND present.gram = CAST(required.value AS INTEGER)
                    )
                 )
               )
             THEN 1 ELSE 0 END AS isCandidate
        FROM raw_ids raw ORDER BY raw.id ASC
    `)) as Array<{ id: number; isCandidate: number }>;
    checkCurrent();
    if (rawCandidates.length === 0) break;
    for (const row of rawCandidates) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= cursor ||
        row.id > highWater ||
        (row.isCandidate !== 0 && row.isCandidate !== 1)
      ) {
        throw new Error('Inbox search candidate cursor is invalid.');
      }
    }
    const candidateIds = rawCandidates.filter((row) => row.isCandidate === 1).map((row) => row.id);
    const candidates: InboxSearchCandidate[] =
      candidateIds.length === 0
        ? []
        : await db.all<InboxSearchCandidate>(sql`
            SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier,
                   c.display_name AS displayName, c.custom_name AS customName, c.style,
                   c.is_pinned AS isPinned, c.pin_order AS pinOrder,
                   c.latest_message_date AS latestMessageDate
              FROM chats c
             WHERE c.id IN (
               SELECT CAST(value AS INTEGER) FROM json_each(${JSON.stringify(candidateIds)})
             )
               AND c.is_archived = 0
               AND c.is_pinned IN (0, 1)
               AND ${chatVisible('c')}
             ORDER BY c.id ASC
          `);
    checkCurrent();

    const nameMatches = await exactInboxSearchNameMatches(
      db,
      candidates.filter((candidate) => !messageMatchGuids.has(candidate.guid)),
      foldedQuery,
      checkCurrent,
    );
    checkCurrent();

    for (const candidate of candidates) {
      if (!nameMatches.has(candidate.id) && !messageMatchGuids.has(candidate.guid)) continue;
      retained.push(candidate);
      retained.sort(compareInboxSearchCandidates);
      if (retained.length > retainedLimit) retained.pop();
    }

    const nextCursor = rawCandidates[rawCandidates.length - 1]!.id;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor || nextCursor > highWater) {
      throw new Error('Inbox search candidate cursor did not advance.');
    }
    cursor = nextCursor;
    pages += 1;
    if (rawCandidates.length < INBOX_SEARCH_CANDIDATE_PAGE_SIZE) break;
  }

  checkCurrent();
  const selectedGuids = retained.slice(0, limit).map((candidate) => candidate.guid);
  const rows =
    selectedGuids.length === 0
      ? []
      : await queryChatsForInbox(db, {
          archive: 'active',
          sender: 'any',
          chatGuids: selectedGuids,
          limit,
        });
  checkCurrent();
  return { rows, hasMore: retained.length > limit };
}

/**
 * Transaction-only folder browse snapshot. Folder identity/counts and the decorated growing page
 * share the exact membership state, so add-before-prune replacement cannot leak its intermediate
 * superset to the UI.
 */
export function listCustomFolderInboxPageWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
  requestedLimit = 50,
  searchText = '',
): Promise<CustomFolderInboxPage | null> {
  return runInTransactionContext(context, async (db) => {
    requireCustomFolderId(folderId);
    const finiteLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.floor(requestedLimit))
      : 50;
    const limit = Math.min(finiteLimit, MAX_CUSTOM_FOLDER_MEMBERS);
    const folderRows = await db.all<CustomFolderRow>(sql`
      SELECT f.id, f.name, f.sort_order AS sortOrder, COUNT(m.chat_guid) AS chatCount
        FROM custom_folders f
        LEFT JOIN custom_folder_members m ON m.folder_id = f.id
       WHERE f.id = ${folderId}
       GROUP BY f.id, f.name, f.sort_order
       LIMIT 1
    `);
    const folder = folderRows[0];
    if (!folder) return null;
    if (
      !Number.isSafeInteger(folder.chatCount) ||
      folder.chatCount < 0 ||
      folder.chatCount > MAX_CUSTOM_FOLDER_MEMBERS
    ) {
      throw new Error('Custom folder membership exceeds its safety bound.');
    }

    const membership = customFolderMembershipSql(folderId);
    const availableRows = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count
        FROM chats c
       WHERE ${chatVisible('c')} ${membership}
    `);
    const availableCount = availableRows[0]?.count ?? 0;
    if (
      !Number.isSafeInteger(availableCount) ||
      availableCount < 0 ||
      availableCount > folder.chatCount
    ) {
      throw new Error('Custom folder availability count is invalid.');
    }

    const searchQuery = normalizeCustomFolderSearch(searchText);
    let matchingChatGuids: string[] | undefined;
    if (searchQuery) {
      const candidates = await db.all<CustomFolderSearchCandidate>(sql`
        SELECT c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
               c.custom_name AS customName, c.style,
               (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
               (SELECT json_group_array(participant.name)
                  FROM (SELECT COALESCE(h.display_name, h.address) AS name
                          FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                         WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantNames,
               (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
                  FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                 WHERE ch.chat_id = c.id) AS participantSearchText
          FROM chats c
         WHERE ${chatVisible('c')} ${membership}
         ORDER BY c.is_pinned DESC,
                  CASE WHEN c.is_pinned = 1
                    THEN COALESCE(c.pin_order, 9223372036854775807) END ASC,
                  CASE WHEN c.is_pinned = 0 THEN c.latest_message_date END DESC,
                  c.id DESC
         LIMIT ${MAX_CUSTOM_FOLDER_MEMBERS + 1}
      `);
      if (candidates.length !== availableCount) {
        throw new Error('Custom folder search candidates do not match availability.');
      }
      const foldedQuery = searchQuery.toLowerCase();
      const messageMatchGuids = new Set(
        await searchCustomFolderChatGuidsByMessage(db, folderId, searchQuery),
      );
      matchingChatGuids = candidates
        .filter(
          (candidate: CustomFolderSearchCandidate) =>
            `${resolveTitle(candidate)} ${candidate.participantSearchText ?? ''}`
              .normalize('NFC')
              .toLowerCase()
              .includes(foldedQuery) || messageMatchGuids.has(candidate.guid),
        )
        .map((candidate: CustomFolderSearchCandidate) => candidate.guid);
    }
    const matchingCount = matchingChatGuids?.length ?? availableCount;
    if (
      !Number.isSafeInteger(matchingCount) ||
      matchingCount < 0 ||
      matchingCount > availableCount
    ) {
      throw new Error('Custom folder search count is invalid.');
    }

    const pageChatGuids = matchingChatGuids?.slice(0, limit + 1);
    const rows =
      pageChatGuids?.length === 0
        ? []
        : await queryChatsForInbox(db, {
            archive: 'all',
            sender: 'any',
            folderId,
            chatGuids: pageChatGuids,
            limit: limit + 1,
          });
    return {
      folder,
      availableCount,
      matchingCount,
      rows: rows.slice(0, limit),
      hasMore: matchingCount > limit,
    };
  });
}

/** Lightweight exact count for page-external affordances such as the Unknown Senders footer. */
export async function countChatsForInbox(
  db: AppDatabase,
  opts: Omit<InboxPageOptions, 'limit'> = {},
): Promise<number> {
  const filters = inboxFilterSql({
    archive: opts.archive ?? 'active',
    sender: opts.sender ?? 'any',
    filters: opts.filters,
  });
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM chats c
     WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender} ${filters.criteria}
  `);
  return rows[0]?.count ?? 0;
}

/**
 * True when any participant of the chat matched a device contact. The "unknown senders"
 * feature treats contact-less chats as unknown (separate list + muted notifications).
 */
export async function chatHasKnownSender(db: AppDatabase, guid: string): Promise<boolean> {
  const rows = await db.all<{ known: number }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
       WHERE ch.chat_id = (SELECT id FROM chats WHERE guid = ${guid} LIMIT 1)
         AND h.contact_id IS NOT NULL
    ) AS known
  `);
  return rows[0]?.known === 1;
}

/** Resolve a chat's local integer id from its server guid. */
export async function getChatIdByGuid(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ id: number }>(sql`SELECT id FROM chats WHERE guid = ${guid} LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** Minimal chat row for the conversation header (title + avatar + group state). */
export interface ChatHeaderRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  style: number | null;
  participantCount: number;
  /** JSON string array ordered by handle id. */
  participantNames: string | null;
  /** JSON string/null array positionally aligned with participantNames. */
  participantAvatars: string | null;
  /** JSON string/null array positionally aligned with participant names/avatars. */
  participantColors?: string | null;
  /**
   * `|||`-joined participant handle ADDRESSES (the raw phone/email), positionally aligned with
   * `participantNames`/`participantAvatars`. Distinct from the names, which are
   * `COALESCE(display_name, address)` — for a SAVED contact the name is the contact's name, so the
   * address is the only place the actual number survives. The chat header shows it under the name.
   *
   * `|||` (not `, `) because an address must round-trip exactly. Optional so hand-built
   * `ChatHeaderRow` test literals need not set it; the query below always provides it at runtime.
   */
  participantAddresses?: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  /**
   * The local deletion tombstone (ms) or null — REPORTED, not filtered on (see the fn). The
   * notification-intent builder needs it to decide whether an arriving message is one that would
   * bring the chat back. Optional so hand-built `ChatHeaderRow` test literals need not set it; the
   * query below always provides it at runtime.
   */
  deletedAt?: number | null;
}

/**
 * Identity + preferences for ONE chat, by guid. Deliberately NOT filtered by `chatVisible`.
 *
 * This is a lookup, not a list: its two callers are the open conversation's own header and the
 * notification-intent builder, and neither is deciding what to enumerate. Hiding a tombstoned chat
 * here returns null, and null is indistinguishable from "no such chat" — which silently turned OFF
 * the per-chat MUTE (`header?.muteType === 'mute'`, so an absent header reads as "not muted") and
 * degraded the notification title to the sender's name. A chat can be tombstoned while messages are
 * still arriving in it, so a muted-and-deleted conversation started buzzing. Suppression decisions
 * must never treat "unknown" as "allowed"; and the chat screen is reachable for a tombstoned chat
 * (deep link, notification tap), where a null header rendered the literal fallback title.
 * Visibility belongs on the genuine LIST queries above.
 *
 * It DOES report `deleted_at`, which is a different thing from filtering on it: the caller that
 * must not be lied to about mute is also the caller that must not raise a notification for an event
 * which can never make the chat findable again (a tapback in a deleted thread). Reporting the stamp
 * lets it apply the tombstone itself; filtering on it would take mute down with it.
 */
export async function getChatHeader(db: AppDatabase, guid: string): Promise<ChatHeaderRow | null> {
  const rows = await db.all<ChatHeaderRow>(sql`
    SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor, c.mute_type AS muteType, c.style,
      c.deleted_at AS deletedAt,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT json_group_array(participant.name)
         FROM (SELECT COALESCE(h.display_name, h.address) AS name
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantNames,
      (SELECT json_group_array(participant.avatar)
         FROM (SELECT h.avatar
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantAvatars,
      (SELECT json_group_array(participant.color)
         FROM (SELECT h.color
                 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
                WHERE ch.chat_id = c.id ORDER BY h.id) AS participant) AS participantColors,
      (SELECT group_concat(COALESCE(h.address, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAddresses,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices
    FROM chats c WHERE c.guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/** New iMessage creation admits E.164 numbers, where the country code is part of identity. */
function normalizeIMessageAddrForMatch(a: string): string {
  return a.includes('@') ? a.trim().toLowerCase() : a.trim();
}

/**
 * Find an existing iMessage chat whose participant set equals `addresses` (order-independent).
 *
 * RCS deliberately returns no local match. Its cached participant string is presentation data: the
 * sidecar may supply a display name, formatted number, or opaque participant id without canonical
 * endpoint provenance. It therefore cannot authorize navigation to a Google conversation, even on
 * exact string equality. Starting an RCS message uses the server's Google-owned find/create route.
 */
export async function findChatByParticipantAddresses(
  db: AppDatabase,
  addresses: string[],
  service: 'RCS' | 'iMessage',
): Promise<string | null> {
  if (service !== 'iMessage') return null;
  const want = new Set(addresses.map(normalizeIMessageAddrForMatch).filter(Boolean));
  if (want.size === 0) return null;
  const rows = await db.all<{
    guid: string;
    style: number | null;
    address: string;
    handleService: string | null;
  }>(sql`
    SELECT c.guid AS guid, c.style AS style, h.address AS address, h.service AS handleService
      FROM chats c
      JOIN chat_handles ch ON ch.chat_id = c.id
      JOIN handles h ON h.id = ch.handle_id
     WHERE ${chatVisible('c')}
  `);
  const byChat = new Map<
    string,
    { style: number | null; addresses: Set<string>; allIMessageHandles: boolean }
  >();
  for (const r of rows) {
    const match = byChat.get(r.guid) ?? {
      style: r.style,
      addresses: new Set<string>(),
      allIMessageHandles: true,
    };
    match.addresses.add(normalizeIMessageAddrForMatch(r.address));
    match.allIMessageHandles &&= r.handleService === 'iMessage';
    byChat.set(r.guid, match);
  }
  const singleWantedAddress = want.size === 1 ? want.values().next().value : undefined;
  for (const [guid, match] of byChat) {
    const { addresses: set } = match;
    const exactNativeIMessage =
      singleWantedAddress !== undefined &&
      match.allIMessageHandles &&
      guid.startsWith('any;-;') &&
      normalizeIMessageAddrForMatch(guid.slice('any;-;'.length)) === singleWantedAddress;
    // A service-prefixed GUID alone is not DM proof: sparse group and SMS rows can carry one
    // matching handle. Wait for authoritative style/handle data after a create.
    if (
      match.style !== 45 ||
      !match.allIMessageHandles ||
      (!guid.startsWith('iMessage;-;') && !exactNativeIMessage)
    ) {
      continue;
    }
    if (set.size === want.size && [...want].every((a) => set.has(a))) return guid;
  }
  return null;
}

export interface ChatParticipant {
  address: string;
  name: string;
  service: string | null;
  color: string | null;
}

/** A chat's exact participant handles for details and device-local color customization. */
export async function getChatParticipants(
  db: AppDatabase,
  guid: string,
): Promise<ChatParticipant[]> {
  return db.all<ChatParticipant>(sql`
    SELECT h.address AS address, COALESCE(h.display_name, h.address) AS name,
           NULLIF(h.service, '') AS service, h.color
      FROM chat_handles ch
      JOIN handles h ON h.id = ch.handle_id
      JOIN chats c ON c.id = ch.chat_id
     WHERE c.guid = ${guid}
     ORDER BY h.id
  `);
}
