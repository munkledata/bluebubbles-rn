import { sql } from 'drizzle-orm';
import { normalizeInboxFilters, type InboxFilters } from '@core/models';
import { resolveTitle } from '@utils/chat';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { AppDatabase } from '../types';
import {
  attachmentIsUserFileSql,
  chatUnreadCountSql,
  chatVisible,
  inboxFilterSql,
  messageHasVisibleContentSql,
  type InboxArchiveFilter,
  type InboxSenderFilter,
} from './chatVisibility';
import { MAX_CUSTOM_FOLDER_MEMBERS, type CustomFolderRow } from './customFolders';
import { foldInboxSearchText, uniqueInboxSearchBigrams } from './inboxSearchText';
import { toFtsQuery } from './_shared';
import {
  queryCustomFolderMessageMatchBatch,
  type CustomFolderMessageMatchBatch,
} from './messageQueries';

export type { InboxArchiveFilter, InboxSenderFilter } from './chatVisibility';

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
  /** 'active' (the inbox default) or 'all', which also finds archived chats (folder picker). */
  archive?: 'active' | 'all';
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
const INBOX_SEARCH_INLINE_NAME_BYTES = 512;
const INBOX_SEARCH_NAME_CHUNK_BYTES = 4096;
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

type InboxSearchRankedIdentity = Pick<
  InboxSearchCandidate,
  'id' | 'guid' | 'isPinned' | 'pinOrder' | 'latestMessageDate'
>;

type InboxSearchRawCandidate = {
  id: number;
  isCandidate: number;
  candidateId: number | null;
} & {
  [Key in keyof Omit<InboxSearchCandidate, 'id'>]: InboxSearchCandidate[Key] | null;
};

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

class InboxSearchTextChangedError extends Error {
  constructor() {
    super('Inbox search text changed while reading. Please try again.');
    this.name = 'InboxSearchTextChangedError';
  }
}

/**
 * Bound each oversized-name transfer, not total name memory or native SQLite work. Byte slices
 * preserve embedded NULs; hex avoids native/host blob-shape differences. Decode across slices,
 * then let the existing matcher fold the COMPLETE name: NFC and contextual lowercasing cannot
 * safely be applied to independent chunks. Preserve an initial U+FEFF just like a text read.
 */
async function readLargeInboxSearchParticipantName(
  db: AppDatabase,
  chatId: number,
  handleId: number,
  checkCurrent: () => void,
): Promise<string> {
  type Chunk = {
    byteLength: number;
    revision: number;
    changes: number;
    participantChunk: string;
  };
  for (let attempt = 0; ; attempt += 1) {
    checkCurrent();
    try {
      // Retry owns fresh fragments/decoder state; never stitch two versions of a name together.
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      const parts: string[] = [];
      let snapshot: Omit<Chunk, 'participantChunk'> | undefined;
      let offset = 0;
      let pages = 0;
      for (;;) {
        checkCurrent();
        if (pages > 0 && pages % INBOX_SEARCH_PAGES_PER_YIELD === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          checkCurrent();
        }
        const chunks = await db.all<Chunk>(sql`
          SELECT length(CAST(COALESCE(h.display_name, h.address) AS BLOB)) AS byteLength,
                 s.revision, total_changes() AS changes,
                 hex(substr(CAST(COALESCE(h.display_name, h.address) AS BLOB),
                            ${offset + 1}, ${INBOX_SEARCH_NAME_CHUNK_BYTES})) AS participantChunk
            FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
            JOIN inbox_search_state s ON s.chat_id = ch.chat_id
           WHERE ch.chat_id = ${chatId} AND ch.handle_id = ${handleId}
           LIMIT 1
        `);
        checkCurrent();
        if (chunks.length === 0) throw new InboxSearchTextChangedError();
        const chunk = chunks[0]!;
        if (
          chunks.length !== 1 ||
          !Number.isSafeInteger(chunk.byteLength) ||
          chunk.byteLength < 0 ||
          !Number.isSafeInteger(chunk.revision) ||
          chunk.revision < 1 ||
          !Number.isSafeInteger(chunk.changes) ||
          chunk.changes < 0
        ) {
          throw new Error('Inbox search participant text snapshot is invalid.');
        }
        if (
          snapshot &&
          (chunk.byteLength !== snapshot.byteLength ||
            chunk.revision !== snapshot.revision ||
            chunk.changes !== snapshot.changes)
        ) {
          throw new InboxSearchTextChangedError();
        }
        // Revision catches rollback; the connection counter catches rollback + same-revision
        // rewrite. Unrelated writes can also retire this rare oversized-name read conservatively.
        snapshot ??= {
          byteLength: chunk.byteLength,
          revision: chunk.revision,
          changes: chunk.changes,
        };
        const byteCount = Math.min(INBOX_SEARCH_NAME_CHUNK_BYTES, snapshot.byteLength - offset);
        const hex = chunk.participantChunk;
        if (typeof hex !== 'string' || hex.length !== byteCount * 2 || !/^[0-9A-F]*$/.test(hex)) {
          throw new Error('Inbox search participant text chunk is invalid.');
        }
        const bytes = new Uint8Array(byteCount);
        for (let index = 0; index < byteCount; index += 1) {
          bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        }
        parts.push(decoder.decode(bytes, { stream: true }));
        offset += byteCount;
        if (offset === snapshot.byteLength) {
          parts.push(decoder.decode());
          return parts.join('');
        }
        pages += 1;
      }
    } catch (error) {
      if (!(error instanceof InboxSearchTextChangedError) || attempt >= 1) throw error;
      checkCurrent();
      // One fresh attempt lets a completed rename/index update settle, without unbounded retries.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Verify participant text without asking SQLite to materialize a data-sized group_concat. The
 * participant pages cap both row count and inline name bytes; larger names use cancellable byte
 * reads. Full-name folding and total group work remain data-sized. Rolling prefix/suffix summaries
 * preserve matches across the participant separator and resolved-title/participant boundary.
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
      participantBytes: number | null;
    }>(sql`
      SELECT ch.chat_id AS chatId, h.id AS handleId,
             length(CAST(COALESCE(h.display_name, h.address) AS BLOB)) AS participantBytes,
             CASE WHEN length(CAST(COALESCE(h.display_name, h.address) AS BLOB))
                         <= ${INBOX_SEARCH_INLINE_NAME_BYTES}
                  THEN COALESCE(h.display_name, h.address) ELSE NULL END AS participantName
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
      const nameBytes = participant.participantBytes;
      if (nameBytes == null) {
        if (participant.participantName == null) continue;
        throw new Error('Inbox search participant text length is invalid.');
      }
      if (!Number.isSafeInteger(nameBytes) || nameBytes < 0) {
        throw new Error('Inbox search participant text length is invalid.');
      }
      const participantName =
        nameBytes > INBOX_SEARCH_INLINE_NAME_BYTES
          ? await readLargeInboxSearchParticipantName(
              db,
              participant.chatId,
              participant.handleId,
              checkCurrent,
            )
          : participant.participantName;
      if (typeof participantName !== 'string') {
        throw new Error('Inbox search participant name is invalid.');
      }

      if (state.rawValueCount > 0) {
        appendInboxSearchText(state.rawParticipants, ', ', foldedQuery);
      }
      appendInboxSearchText(state.rawParticipants, participantName, foldedQuery);
      state.rawValueCount += 1;

      const titlePart = participantName.trim();
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

/**
 * The search term as the UI normalizes it (NFC, trimmed, capped), or '' below two code points. The
 * database boundary re-checks it rather than trusting callers.
 */
function normalizeSearchTerm(input: string, label: 'Folder' | 'Inbox'): string {
  if (typeof input !== 'string') throw new TypeError(`${label} search must be text.`);
  const normalized = Array.from(input.normalize('NFC').trim())
    .slice(0, MAX_CUSTOM_FOLDER_SEARCH_CODE_POINTS)
    .join('');
  return Array.from(normalized).length >= 2 ? normalized : '';
}

function normalizeCustomFolderSearch(input: string | undefined): string {
  return input == null ? '' : normalizeSearchTerm(input, 'Folder');
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
           AND ${attachmentIsUserFileSql('a', 'l')}
           AND a.hide_attachment = 0
           AND a.is_retracted = 0
           AND a.emoji_image_short_description IS NOT NULL
         ORDER BY a.id ASC LIMIT 1) AS lastAttachmentDescription,
      EXISTS(SELECT 1 FROM attachments a
               WHERE a.message_id = l.id AND a.hide_attachment = 0 AND a.is_retracted = 0
                 AND ${attachmentIsUserFileSql('a', 'l')}) AS lastHasVisibleAttachments,
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
              WHERE ck.chat_id = c.id
                AND (hk.contact_id IS NOT NULL OR hk.contact_ambiguous = 1)) AS hasKnownSender
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
  left: InboxSearchRankedIdentity,
  right: InboxSearchRankedIdentity,
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
 * still require data-sized total pages. Participant transfers are byte-bounded, but reconstructing
 * and folding one full name, candidate title fields, and final decoration remain data-sized.
 */
export async function searchChatsForInboxPage(
  db: AppDatabase,
  opts: InboxSearchOptions,
): Promise<InboxPage> {
  const query = normalizeSearchTerm(opts.query, 'Inbox');
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
  const archive = opts.archive ?? 'active';
  const activeOnly = archive === 'active' ? sql`AND c.is_archived = 0` : sql``;
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
  const retained: InboxSearchRankedIdentity[] = [];
  while (cursor < highWater) {
    checkCurrent();
    if (pages > 0 && pages % INBOX_SEARCH_PAGES_PER_YIELD === 0) {
      // Let a changed term/account retire this scan without monopolizing the JS turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkCurrent();
    }
    const rawCandidates = await db.all<InboxSearchRawCandidate>(sql`
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
      ), classified_ids AS MATERIALIZED (
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
        FROM raw_ids raw
      ), candidate_details AS MATERIALIZED (
        SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier,
               c.display_name AS displayName, c.custom_name AS customName, c.style,
               c.is_pinned AS isPinned, c.pin_order AS pinOrder,
               c.latest_message_date AS latestMessageDate
          -- Resolve capped ids by rowid, not an archive-index scan of the active inbox per page.
          FROM chats c NOT INDEXED
         WHERE c.id IN (SELECT id FROM classified_ids WHERE isCandidate = 1)
           ${activeOnly}
           AND c.is_pinned IN (0, 1)
           AND ${chatVisible('c')}
      )
      SELECT raw.id, raw.isCandidate, details.id AS candidateId,
             details.guid, details.chatIdentifier, details.displayName, details.customName,
             details.style, details.isPinned, details.pinOrder, details.latestMessageDate
        FROM classified_ids raw
        LEFT JOIN candidate_details details ON details.id = raw.id
       ORDER BY raw.id ASC
    `);
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
    // Until the extra exact match is known, even a worse-ranked candidate may establish hasMore.
    // Once full, the retained threshold can only improve; a dominated candidate cannot affect
    // either the result page or its sentinel, regardless of its title/participants.
    const worstRetained =
      retained.length === retainedLimit ? retained[retained.length - 1] : undefined;
    const candidates: InboxSearchCandidate[] = [];
    for (const row of rawCandidates) {
      // Hidden/rejected rows still advance the raw cursor even though their details are absent.
      if (row.candidateId === null) continue;
      if (
        row.candidateId !== row.id ||
        row.isCandidate !== 1 ||
        typeof row.guid !== 'string' ||
        (row.isPinned !== 0 && row.isPinned !== 1)
      ) {
        throw new Error('Inbox search candidate details are invalid.');
      }
      const candidate: InboxSearchCandidate = {
        id: row.id,
        guid: row.guid,
        chatIdentifier: row.chatIdentifier,
        displayName: row.displayName,
        customName: row.customName,
        style: row.style,
        isPinned: row.isPinned,
        pinOrder: row.pinOrder,
        latestMessageDate: row.latestMessageDate,
      };
      if (worstRetained && compareInboxSearchCandidates(candidate, worstRetained) >= 0) continue;
      candidates.push(candidate);
    }
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
      // The complete title fields are needed only during this page's exact match, not while
      // keeping the best identities across every later candidate page.
      const { id, guid, isPinned, pinOrder, latestMessageDate } = candidate;
      retained.push({ id, guid, isPinned, pinOrder, latestMessageDate });
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
          archive,
          sender: 'any',
          chatGuids: selectedGuids,
          limit,
        });
  checkCurrent();
  return { rows, hasMore: retained.length > limit };
}

/** One folder-search batch plus the folder's visible member count. */
export type CustomFolderMessageMatchBatchResult = CustomFolderMessageMatchBatch & {
  readonly folderChatCount: number;
};

/**
 * One short folder-search batch (review M060), plus the folder's visible member count so the caller
 * can stop once every member has matched. Null when the search text has no words to match.
 */
export function readCustomFolderMessageMatchBatchWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
  searchText: string,
  beforeRowid: number | null,
): Promise<CustomFolderMessageMatchBatchResult | null> {
  return runInTransactionContext(context, async (db) => {
    requireCustomFolderId(folderId);
    const match = toFtsQuery(normalizeCustomFolderSearch(searchText));
    if (!match) return null;
    const members = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM chats c
       WHERE ${chatVisible('c')} ${customFolderMembershipSql(folderId)}
    `);
    const batch = await queryCustomFolderMessageMatchBatch(db, folderId, match, beforeRowid);
    return { ...batch, folderChatCount: members[0]?.count ?? 0 };
  });
}

/**
 * The message half of a folder search, read in short batches (review M060). `readBatch` runs one
 * batch in its own short transaction (callers own transactions, as with every folder command); the
 * shared transaction queue is first-in, first-out, so sends and sync that queued during a batch run
 * before the next one. Stops once every visible folder chat has matched. Null when `isCurrent`
 * reports that a newer search or another account replaced this one.
 */
export async function collectCustomFolderMessageMatches(
  readBatch: (beforeRowid: number | null) => Promise<CustomFolderMessageMatchBatchResult | null>,
  isCurrent: () => boolean = () => true,
): Promise<ReadonlySet<string> | null> {
  const matches = new Set<string>();
  let beforeRowid: number | null = null;
  for (;;) {
    if (!isCurrent()) return null;
    const batch: CustomFolderMessageMatchBatchResult | null = await readBatch(beforeRowid);
    if (batch == null) return matches;
    for (const guid of batch.chatGuids) matches.add(guid);
    if (matches.size > MAX_CUSTOM_FOLDER_MEMBERS) {
      throw new Error('Custom folder message matches exceed their safety bound.');
    }
    if (batch.nextBeforeRowid == null || matches.size >= batch.folderChatCount) return matches;
    beforeRowid = batch.nextBeforeRowid;
  }
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
  /** From collectCustomFolderMessageMatches, read in batches first; required when searching. */
  messageMatches?: ReadonlySet<string>,
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
      if (messageMatches == null) {
        throw new Error('A folder search needs its message matches read in batches first.');
      }
      const foldedQuery = searchQuery.toLowerCase();
      const messageMatchGuids = messageMatches;
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
         AND (h.contact_id IS NOT NULL OR h.contact_ambiguous = 1)
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

/**
 * Addresses compare exactly, except that emails ignore case. Callers standardize what was typed
 * (`canonicalRecipientAddress`); a stored number is never given a country code.
 */
function normalizeIMessageAddrForMatch(a: string): string {
  return a.includes('@') ? a.trim().toLowerCase() : a.trim();
}

/** One existing chat that New Message can offer for the chosen recipients. */
export interface ExistingChatMatch {
  guid: string;
  /** Newest message time (epoch ms), or null when the chat has none yet. */
  latestMessageDate: number | null;
  /** The custom name, else the chat's own name; null when it has neither. */
  name: string | null;
  isGroup: boolean;
}

/**
 * Every visible iMessage chat whose members are exactly `addresses` (order-independent), newest
 * first, so New Message can list them and preselect the most recent.
 *
 * - One address: a one-to-one chat (style 45) whose handles are all iMessage, keyed
 *   `iMessage;-;…` or the native `any;-;<that address>`.
 * - Two or more: a group (style 43) whose handles are all iMessage, keyed `iMessage;+;…` or the
 *   native `any;+;…`. Two groups with the same members stay separate matches (FEAT-06 §2).
 *
 * RCS deliberately returns no local match. Its cached participant string is presentation data: the
 * sidecar may supply a display name, formatted number, or opaque participant id without canonical
 * endpoint provenance. It therefore cannot authorize navigation to a Google conversation, even on
 * exact string equality. Starting an RCS message uses the server's Google-owned find/create route.
 */
export async function findChatsByParticipantAddresses(
  db: AppDatabase,
  addresses: string[],
  service: 'RCS' | 'iMessage',
): Promise<ExistingChatMatch[]> {
  if (service !== 'iMessage') return [];
  const want = new Set(addresses.map(normalizeIMessageAddrForMatch).filter(Boolean));
  if (want.size === 0) return [];
  const rows = await db.all<{
    guid: string;
    style: number | null;
    latestMessageDate: number | null;
    name: string | null;
    address: string;
    handleService: string | null;
  }>(sql`
    SELECT c.guid AS guid, c.style AS style, c.latest_message_date AS latestMessageDate,
           COALESCE(NULLIF(TRIM(c.custom_name), ''), NULLIF(TRIM(c.display_name), '')) AS name,
           h.address AS address, h.service AS handleService
      FROM chats c
      JOIN chat_handles ch ON ch.chat_id = c.id
      JOIN handles h ON h.id = ch.handle_id
     WHERE ${chatVisible('c')}
  `);
  const byChat = new Map<
    string,
    {
      style: number | null;
      latestMessageDate: number | null;
      name: string | null;
      addresses: Set<string>;
      allIMessageHandles: boolean;
    }
  >();
  for (const r of rows) {
    const match = byChat.get(r.guid) ?? {
      style: r.style,
      latestMessageDate: r.latestMessageDate,
      name: r.name,
      addresses: new Set<string>(),
      allIMessageHandles: true,
    };
    match.addresses.add(normalizeIMessageAddrForMatch(r.address));
    match.allIMessageHandles &&= r.handleService === 'iMessage';
    byChat.set(r.guid, match);
  }
  const singleWantedAddress = want.size === 1 ? want.values().next().value : undefined;
  const found: ExistingChatMatch[] = [];
  for (const [guid, match] of byChat) {
    const { addresses: set } = match;
    if (!match.allIMessageHandles) continue;
    if (set.size !== want.size || ![...want].every((a) => set.has(a))) continue;
    if (singleWantedAddress !== undefined) {
      const exactNativeIMessage =
        guid.startsWith('any;-;') &&
        normalizeIMessageAddrForMatch(guid.slice('any;-;'.length)) === singleWantedAddress;
      // A service-prefixed GUID alone is not DM proof: sparse group and SMS rows can carry one
      // matching handle. Wait for authoritative style/handle data after a create.
      if (match.style !== 45 || (!guid.startsWith('iMessage;-;') && !exactNativeIMessage)) {
        continue;
      }
    } else if (match.style !== 43 || !/^(?:iMessage|any);\+;./su.test(guid)) {
      continue;
    }
    found.push({
      guid,
      latestMessageDate: match.latestMessageDate,
      name: match.name,
      isGroup: singleWantedAddress === undefined,
    });
  }
  return found.sort(
    (a, b) =>
      (b.latestMessageDate ?? -Infinity) - (a.latestMessageDate ?? -Infinity) ||
      a.guid.localeCompare(b.guid),
  );
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
