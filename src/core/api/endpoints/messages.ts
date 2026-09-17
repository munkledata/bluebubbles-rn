import { z } from 'zod/v4';
import { Message } from '@core/models';
import { MessageDeletedPayload } from '@core/realtime/events';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import type { HttpClient } from '../http';

export interface MessagePage {
  limit?: number;
  offset?: number;
  /** ROWID cursor for incremental sync on server >= 1.6.0. */
  after?: number;
}

// The server wraps list responses in a named key ({ messages: [...] }); the HttpClient
// already unwrapped the { status, message, data } envelope, so `data` IS that object.
export const MessageList = z.object({ messages: z.array(Message).nullish() });

/** Global server search is deliberately one bounded, newest-first page. */
export const SERVER_MESSAGE_SEARCH_LIMIT = 50;
export const ServerMessageSearchList = z
  .object({ messages: z.array(Message).max(SERVER_MESSAGE_SEARCH_LIMIT) })
  .strict();

/**
 * The Gator write ops (send/react/attachment) return a `SendResult`, NOT a Message:
 * `{ guid?: string, viaPrivateApi?: boolean, attemptGuid?: string }`. `viaPrivateApi` is accepted
 * only as inert legacy response data and never grants client capability. AppleScript plain text may
 * omit `guid`; RCS sends can return one. Newer RCS servers add `attemptGuid`: the server-owned
 * identity for this admitted send, used to reject a delayed failure from an older retry.
 */
export const SendAck = z
  .object({
    guid: z.string().nullish(),
    viaPrivateApi: z.boolean().nullish(),
    attemptGuid: z.string().min(1).max(128).nullish(),
    clientAttemptGeneration: z.number().int().min(1).max(2_147_483_647).nullish(),
  })
  .loose();
export type SendAck = z.infer<typeof SendAck>;

/** `unsend-message` returns a status object `{ unsent: true }`, not a Message. */
export const UnsendAck = z.object({ unsent: z.boolean().nullish() }).loose();
export type UnsendAck = z.infer<typeof UnsendAck>;

function requireMessagePartIndex(partIndex: number): number {
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex > 10_000) {
    throw new RangeError('A message action needs an exact part index from 0 through 10000');
  }
  return partIndex;
}

function requireRcsChatGuid(chatGuid: string): void {
  if (!chatGuid.startsWith('RCS;-;')) {
    throw new Error('This message action is available only for RCS conversations.');
  }
}

/** GET /api/v1/chat/{guid}/message — messages for a chat, newest first. */
export async function chatMessages(
  http: HttpClient,
  chatGuid: string,
  page: MessagePage = {},
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await http.get(`/chat/${encodeURIComponent(chatGuid)}/message`, MessageList, {
    signal,
    query: {
      limit: page.limit ?? 100,
      offset: page.offset ?? 0,
      with: SYNC_WITH_QUERY.join(','),
      sort: 'DESC',
    },
  });
  return res.messages ?? [];
}

/** An @mention: a span `[start, start+length)` in the message text pointing at a participant. */
export interface MessageMention {
  /** Start index (UTF-16) of the mentioned span in the message text. */
  start: number;
  /** Length of the mentioned span. */
  length: number;
  /** The mentioned participant's handle address. */
  address: string;
}

export interface SendTextParams {
  chatGuid: string;
  /** Client-generated temp GUID for optimistic send + reconciliation. */
  tempGuid: string;
  /** Local request generation echoed by attempt-aware RCS success/error events. */
  clientAttemptGeneration?: number;
  message: string;
  subject?: string;
  /** Reply target. */
  selectedMessageGuid?: string;
  /** Reply target part. Meaningful only when `selectedMessageGuid` is present. */
  partIndex?: number;
  effectId?: string;
  /** @mention spans — the server assembles the Private-API multipart `parts` from these. */
  mentions?: MessageMention[];
  /** Only `apple-script` is supported; retained as a field for the server wire contract. */
  method?: string;
}

/**
 * POST /api/v1/message/text — send plain text through the supported AppleScript path.
 * The socket `new-message` echo reconciles the optimistic row by tempGuid. Rich helper fields are
 * rejected here so a stale caller cannot restore retired Private API behavior.
 *
 * Server contract: it reads the body under `text` (NOT `message`, which it ignores → a
 * blank send). We keep `message` on the params and map it to `text` on the wire here.
 */
export function sendText(http: HttpClient, params: SendTextParams): Promise<SendAck> {
  if (
    params.method === 'private-api' ||
    (params.method !== undefined && params.method !== 'apple-script') ||
    params.selectedMessageGuid !== undefined ||
    params.partIndex !== undefined ||
    params.effectId !== undefined ||
    params.subject !== undefined ||
    !!params.mentions?.length
  ) {
    throw new Error('Private API message features were retired in this release.');
  }
  return http.post('/message/text', SendAck, {
    captureErrorDetail: true,
    json: {
      chatGuid: params.chatGuid,
      tempGuid: params.tempGuid,
      clientAttemptGeneration: params.clientAttemptGeneration,
      method: 'apple-script',
      text: params.message,
    },
  });
}

/** One phone number on a contact card being sent. `label` (e.g. "cell", "home") is optional. */
export interface ContactPhone {
  number: string;
  label?: string;
}
/** One email on a contact card being sent. `label` (e.g. "home", "work") is optional. */
export interface ContactEmail {
  address: string;
  label?: string;
}

export interface SendContactParams {
  chatGuid: string;
  /** Client-generated temp GUID for optimistic send + reconciliation. */
  tempGuid: string;
  /** Local request generation echoed by attempt-aware RCS success/error events. */
  clientAttemptGeneration?: number;
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones?: ContactPhone[];
  emails?: ContactEmail[];
  subject?: string;
  effectId?: string;
  /** Reply target. */
  selectedMessageGuid?: string;
  /** Reply target part. Meaningful only when `selectedMessageGuid` is present. */
  partIndex?: number;
}

/**
 * POST /api/v1/message/contact — send a contact card. The client sends STRUCTURED fields; the
 * server assembles a vCard 3.0 and ships it through the same attachment pipeline as
 * send-attachment (so the ack is the same `{ guid? }` SendAck, and the live `new-message` echo
 * carries the real `.vcf` attachment). Canonical RCS capability gates this retained path; the
 * historical helper-era `supports_send_contact` flag is no longer advertised.
 *
 * Empty phone/email arrays are omitted so the server's "a contact needs at least a name, org,
 * phone, or email" refinement isn't tripped by an all-empty body.
 */
export function sendContact(http: HttpClient, params: SendContactParams): Promise<SendAck> {
  requireRcsChatGuid(params.chatGuid);
  if (
    params.subject !== undefined ||
    params.effectId !== undefined ||
    params.selectedMessageGuid !== undefined ||
    params.partIndex !== undefined
  ) {
    throw new Error('Private API contact-card features were retired in this release.');
  }
  return http.post('/message/contact', SendAck, {
    captureErrorDetail: true,
    json: {
      chatGuid: params.chatGuid,
      tempGuid: params.tempGuid,
      clientAttemptGeneration: params.clientAttemptGeneration,
      firstName: params.firstName,
      lastName: params.lastName,
      organization: params.organization,
      phones: params.phones?.length ? params.phones : undefined,
      emails: params.emails?.length ? params.emails : undefined,
    },
  });
}

export interface MessageQuery {
  limit?: number;
  /** ROWID cursor (server >= 1.6.0). */
  afterRowId?: number;
  /** Epoch-millis cursor (older servers). */
  afterTimestamp?: number;
}

/**
 * POST /api/v1/message/query — messages after a cursor, oldest-first, with their
 * chats embedded (so incremental sync can resolve each message's chat).
 */
export async function queryMessages(
  http: HttpClient,
  q: MessageQuery,
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await http.post('/message/query', MessageList, {
    signal,
    json: {
      limit: q.limit ?? 1000,
      after: q.afterTimestamp,
      afterRowId: q.afterRowId,
      with: SYNC_WITH_QUERY.join(','),
      sort: 'ASC',
    },
  });
  return res.messages ?? [];
}

/**
 * POST /api/v1/message/search/bounded — bounded text search over the Mac's Messages database.
 *
 * Call only after `supports_message_search` is explicitly true. Chats are required so a result can
 * be adopted into the encrypted local DB before navigation; handles preserve its sender identity.
 */
export async function searchMessagesOnServer(
  http: HttpClient,
  text: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await http.post('/message/search/bounded', ServerMessageSearchList, {
    signal,
    retry: false,
    json: {
      text,
      limit: SERVER_MESSAGE_SEARCH_LIMIT,
    },
  });
  return res.messages;
}

/**
 * Response of GET /message/deleted: each row is the SAME wire DTO (`MessageDeletedV1`) as the
 * realtime `message-deleted` event — `{ guid, chatGuid, dateDeleted }` — so the catch-up sync
 * applies both through the one `markMessageDeleted` path.
 */
export const DELETED_MESSAGE_PAGE_LIMIT = 500;

// Realtime deletion events stay deliberately tolerant, but pagination cannot safely reinterpret a
// malformed cursor timestamp as `null`. Accept the server's finite number / numeric-string shapes
// plus a genuinely absent value, and reject everything else at the REST boundary.
const DeletedMessageTimestamp = z
  .union([
    z.number().finite(),
    z
      .string()
      .trim()
      .min(1)
      .refine((value) => Number.isFinite(Number(value)), 'Expected a finite numeric timestamp')
      .transform(Number),
  ])
  .nullish()
  .transform((value) => value ?? null);

export const DeletedMessageResponseRow = MessageDeletedPayload.extend({
  dateDeleted: DeletedMessageTimestamp,
});
export type DeletedMessage = z.infer<typeof DeletedMessageResponseRow>;

const DeletedMessageRows = z.array(DeletedMessageResponseRow).max(DELETED_MESSAGE_PAGE_LIMIT);

// Keep the two wire shapes disjoint. In particular, a response with only one of `cursor` or
// `hasMore` must fail instead of having the cursor field silently stripped and being mistaken for
// an older server response.
const ContinuedDeletedMessageList = z
  .object({
    deleted: DeletedMessageRows,
    cursor: z.string().min(1).max(512),
    hasMore: z.boolean(),
  })
  .strict();
const LegacyDeletedMessageList = z
  .object({
    deleted: DeletedMessageRows.nullish(),
    cursor: z.undefined().optional(),
    hasMore: z.undefined().optional(),
  })
  .strict();

export const DeletedMessageList = z.union([ContinuedDeletedMessageList, LegacyDeletedMessageList]);

export type DeletedMessagePage =
  | { protocol: 'legacy'; deleted: DeletedMessage[] }
  | {
      protocol: 'continuation';
      deleted: DeletedMessage[];
      cursor: string;
      hasMore: boolean;
    };

export interface DeletedMessageRequest {
  afterMs: number;
  cursor: string | null;
}

/**
 * GET /api/v1/message/deleted. New servers return an opaque continuation cursor and `hasMore`;
 * older servers ignore the extra query field and return only `{ deleted }`. `after` is always
 * included as the old-server fallback. `ledger=1` advertises support for ledger-ordered v2 cursors
 * and is ignored by older servers. Gate calls on `supports_message_deleted`.
 */
export async function deletedMessages(
  http: HttpClient,
  request: DeletedMessageRequest,
  signal?: AbortSignal,
): Promise<DeletedMessagePage> {
  const res = await http.get('/message/deleted', DeletedMessageList, {
    signal,
    query: {
      after: request.afterMs,
      continuation: request.cursor == null ? 1 : undefined,
      cursor: request.cursor ?? undefined,
      ledger: 1,
    },
  });
  if ('cursor' in res && typeof res.cursor === 'string') {
    return {
      protocol: 'continuation',
      deleted: res.deleted ?? [],
      cursor: res.cursor,
      hasMore: res.hasMore,
    };
  }
  return { protocol: 'legacy', deleted: res.deleted ?? [] };
}

export interface SendReactionParams {
  chatGuid: string;
  /** Server GUID of the message being reacted to. */
  selectedMessageGuid: string;
  /** 'love' | 'like' | … or '-love' etc. to remove; 'emoji'/'-emoji' for an arbitrary-emoji tapback. */
  reaction: string;
  /** The glyph for an 'emoji'/'-emoji' tapback. REQUIRED then; must be ABSENT for classic types. */
  emoji?: string;
  /** Exact target part for multipart messages, including an explicit 0 on legacy servers. */
  partIndex: number;
}

/**
 * POST /api/v1/message/react — send (or remove, with a `-` prefix) a tapback. Returns
 * the send ack `{ guid? }`, NOT a Message — see {@link SendAck}. The current client reaches this
 * endpoint only for an independently authorized RCS reaction.
 *
 * Server contract: it requires `{ chatGuid, messageGuid, reactionType }` — NOT the
 * `selectedMessage*`/`reaction` keys the older client sent (which the server dropped → no
 * tapback). We map our params onto the server's names here.
 */
export function sendReaction(http: HttpClient, params: SendReactionParams): Promise<SendAck> {
  requireRcsChatGuid(params.chatGuid);
  return http.post('/message/react', SendAck, {
    captureErrorDetail: true,
    json: {
      chatGuid: params.chatGuid,
      messageGuid: params.selectedMessageGuid,
      reactionType: params.reaction,
      // The server REJECTS reactionEmoji on classic tapbacks (and requires it on
      // 'emoji'/'-emoji'), so the key must be ABSENT — not null — unless a glyph is given.
      ...(params.emoji ? { reactionEmoji: params.emoji } : {}),
      partIndex: requireMessagePartIndex(params.partIndex),
    },
  });
}

export interface EditMessageParams {
  /** Chat the message lives in — the server REQUIRES this (min 1). */
  chatGuid: string;
  /** Server GUID of the message to edit (your own, sent < ~15 min ago). */
  messageGuid: string;
  editedMessage: string;
  /** Shown on un-updated devices; mirrors the Flutter client. */
  backwardsCompatibilityMessage: string;
  partIndex: number;
}

/**
 * POST /api/v1/message/{guid}/edit — edit a sent message's text (Private API, Ventura+).
 * Returns the sender's send ack `{ guid? }`, NOT a Message — see {@link SendAck}.
 *
 * Server contract: it requires `chatGuid` and reads `editedText`/`backwardsCompatText`
 * (NOT `editedMessage`/`backwardsCompatibilityMessage`, which it ignored → no edit). We map
 * our params onto the server's names here.
 */
export function editMessage(http: HttpClient, p: EditMessageParams): Promise<SendAck> {
  void http;
  void p;
  throw new Error('Editing iMessages was retired with the Private API helper.');
}

export interface UnsendMessageParams {
  /** Chat the message lives in — the server REQUIRES this (min 1). */
  chatGuid: string;
  messageGuid: string;
  partIndex: number;
}

/**
 * POST /api/v1/message/{guid}/unsend — retract a sent message (Private API, Ventura+).
 * Returns a status object `{ unsent: true }`, NOT a Message — see {@link UnsendAck}.
 *
 * Server contract: it requires `chatGuid` (min 1) — omitting it (as the old client did)
 * failed validation server-side. We thread it through from the caller.
 */
export function unsendMessage(http: HttpClient, p: UnsendMessageParams): Promise<UnsendAck> {
  void http;
  void p;
  throw new Error('Unsend was retired with the Private API helper.');
}
