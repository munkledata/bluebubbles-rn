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
const MessageList = z.object({ messages: z.array(Message).nullish() });

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

/** POST /api/v1/message/text — send a text message (private API for effects/replies). */
export function sendText(http: HttpClient, params: SendTextParams): Promise<Message> {
  return http.post('/message/text', Message, {
    json: {
      chatGuid: params.chatGuid,
      tempGuid: params.tempGuid,
      method: params.method ?? 'private-api',
      message: params.message,
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
  selectedMessageGuid: string;
  /** The reacted-to message's text (the server echoes it on the reaction). */
  selectedMessageText?: string;
  /** 'love' | 'like' | … or '-love' etc. to remove. */
  reaction: string;
  /** Target part for multipart messages; defaults to 0. */
  partIndex?: number;
}

/** POST /api/v1/message/react — send (or remove, with a `-` prefix) a tapback. */
export function sendReaction(http: HttpClient, params: SendReactionParams): Promise<Message> {
  return http.post('/message/react', Message, {
    json: {
      chatGuid: params.chatGuid,
      selectedMessageGuid: params.selectedMessageGuid,
      selectedMessageText: params.selectedMessageText,
      reaction: params.reaction,
      partIndex: params.partIndex ?? 0,
    },
  });
}

export interface EditMessageParams {
  /** Server GUID of the message to edit (your own, sent < ~15 min ago). */
  messageGuid: string;
  editedMessage: string;
  /** Shown on un-updated devices; mirrors the Flutter client. */
  backwardsCompatibilityMessage: string;
  partIndex?: number;
}

/** POST /api/v1/message/{guid}/edit — edit a sent message's text (Private API, Ventura+). */
export function editMessage(http: HttpClient, p: EditMessageParams): Promise<Message> {
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/edit`, Message, {
    json: {
      editedMessage: p.editedMessage,
      backwardsCompatibilityMessage: p.backwardsCompatibilityMessage,
      partIndex: p.partIndex ?? 0,
    },
  });
}

export interface UnsendMessageParams {
  messageGuid: string;
  partIndex?: number;
}

/** POST /api/v1/message/{guid}/unsend — retract a sent message (Private API, Ventura+). */
export function unsendMessage(http: HttpClient, p: UnsendMessageParams): Promise<Message> {
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/unsend`, Message, {
    json: { partIndex: p.partIndex ?? 0 },
  });
}
