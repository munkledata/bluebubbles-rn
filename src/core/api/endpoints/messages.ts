import { z } from 'zod';
import { Message } from '@core/models';
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

/**
 * The Gator write ops (send/react/attachment) return a `SendResult`, NOT a Message:
 * `{ guid?: string, viaPrivateApi: boolean }`. `guid` is the REAL message GUID on the
 * Private-API path (the ack) and is ABSENT on the AppleScript fallback (plain text only).
 * We parse only what we consume — the optional guid — and tolerate the extra `viaPrivateApi`.
 */
export const SendAck = z
  .object({ guid: z.string().nullish(), viaPrivateApi: z.boolean().nullish() })
  .passthrough();
export type SendAck = z.infer<typeof SendAck>;

/** `unsend-message` returns a status object `{ unsent: true }`, not a Message. */
export const UnsendAck = z.object({ unsent: z.boolean().nullish() }).passthrough();
export type UnsendAck = z.infer<typeof UnsendAck>;

/** GET /api/v1/chat/{guid}/message — messages for a chat, newest first. */
export async function chatMessages(
  http: HttpClient,
  chatGuid: string,
  page: MessagePage = {},
): Promise<Message[]> {
  const res = await http.get(`/chat/${encodeURIComponent(chatGuid)}/message`, MessageList, {
    query: {
      limit: page.limit ?? 100,
      offset: page.offset ?? 0,
      with: SYNC_WITH_QUERY.join(','),
      sort: 'DESC',
    },
  });
  return res.messages ?? [];
}

export interface SendTextParams {
  chatGuid: string;
  /** Client-generated temp GUID for optimistic send + reconciliation. */
  tempGuid: string;
  message: string;
  subject?: string;
  /** Reply target. */
  selectedMessageGuid?: string;
  effectId?: string;
  /** 'private-api' (effects/replies) or 'apple-script' (stock server). */
  method?: string;
}

/**
 * POST /api/v1/message/text — send a text message (private API for effects/replies).
 * Returns the send ack: `{ guid? }` — the real GUID on the Private-API path, ABSENT on
 * the AppleScript fallback (in which case the socket `new-message` echo reconciles by
 * tempGuid). NOT a Message — see {@link SendAck}.
 *
 * Server contract: it reads the body under `text` (NOT `message`, which it ignores → a
 * blank send). We keep `message` on the params and map it to `text` on the wire here.
 */
export function sendText(http: HttpClient, params: SendTextParams): Promise<SendAck> {
  return http.post('/message/text', SendAck, {
    json: {
      chatGuid: params.chatGuid,
      tempGuid: params.tempGuid,
      method: params.method ?? 'private-api',
      text: params.message,
      subject: params.subject,
      selectedMessageGuid: params.selectedMessageGuid,
      effectId: params.effectId,
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
export async function queryMessages(http: HttpClient, q: MessageQuery): Promise<Message[]> {
  const res = await http.post('/message/query', MessageList, {
    json: {
      limit: q.limit ?? 1000,
      after: q.afterTimestamp,
      afterRowId: q.afterRowId,
      with: ['chats', 'chats.participants', 'handle', 'attachment', 'attributedBody'],
      sort: 'ASC',
    },
  });
  return res.messages ?? [];
}

export interface SendReactionParams {
  chatGuid: string;
  /** Server GUID of the message being reacted to. */
  selectedMessageGuid: string;
  /** 'love' | 'like' | … or '-love' etc. to remove; 'emoji'/'-emoji' for an arbitrary-emoji tapback. */
  reaction: string;
  /** The glyph for an 'emoji'/'-emoji' tapback. REQUIRED then; must be ABSENT for classic types. */
  emoji?: string;
  /** Target part for multipart messages; defaults to 0. */
  partIndex?: number;
}

/**
 * POST /api/v1/message/react — send (or remove, with a `-` prefix) a tapback. Returns
 * the send ack `{ guid? }` (reactions require the Private API, so the guid is present on
 * success), NOT a Message — see {@link SendAck}.
 *
 * Server contract: it requires `{ chatGuid, messageGuid, reactionType }` — NOT the
 * `selectedMessage*`/`reaction` keys the older client sent (which the server dropped → no
 * tapback). We map our params onto the server's names here.
 */
export function sendReaction(http: HttpClient, params: SendReactionParams): Promise<SendAck> {
  return http.post('/message/react', SendAck, {
    json: {
      chatGuid: params.chatGuid,
      messageGuid: params.selectedMessageGuid,
      reactionType: params.reaction,
      // The server REJECTS reactionEmoji on classic tapbacks (and requires it on
      // 'emoji'/'-emoji'), so the key must be ABSENT — not null — unless a glyph is given.
      ...(params.emoji ? { reactionEmoji: params.emoji } : {}),
      partIndex: params.partIndex ?? 0,
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
  partIndex?: number;
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
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/edit`, SendAck, {
    json: {
      chatGuid: p.chatGuid,
      editedText: p.editedMessage,
      backwardsCompatText: p.backwardsCompatibilityMessage,
      partIndex: p.partIndex ?? 0,
    },
  });
}

export interface UnsendMessageParams {
  /** Chat the message lives in — the server REQUIRES this (min 1). */
  chatGuid: string;
  messageGuid: string;
  partIndex?: number;
}

/**
 * POST /api/v1/message/{guid}/unsend — retract a sent message (Private API, Ventura+).
 * Returns a status object `{ unsent: true }`, NOT a Message — see {@link UnsendAck}.
 *
 * Server contract: it requires `chatGuid` (min 1) — omitting it (as the old client did)
 * failed validation server-side. We thread it through from the caller.
 */
export function unsendMessage(http: HttpClient, p: UnsendMessageParams): Promise<UnsendAck> {
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/unsend`, UnsendAck, {
    json: { chatGuid: p.chatGuid, partIndex: p.partIndex ?? 0 },
  });
}
