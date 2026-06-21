import { z } from 'zod';
import { Chat } from '@core/models';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import type { HttpClient } from '../http';

export interface ChatQuery {
  limit?: number;
  offset?: number;
  /** Sort key, e.g. "lastmessage". */
  sort?: string;
}

/** POST /api/v1/chat/query — paginated chat list. */
export function queryChats(http: HttpClient, q: ChatQuery = {}): Promise<Chat[]> {
  return http.post('/chat/query', z.array(Chat), {
    json: {
      limit: q.limit ?? 1000,
      offset: q.offset ?? 0,
      with: ['participants', 'lastMessage'],
      sort: q.sort ?? 'lastmessage',
    },
  });
}

export interface CreateChatParams {
  addresses: string[]; // recipient handles (phone/email)
  message: string; // initial message (the server requires one to create the thread)
  service?: string; // 'iMessage' | 'SMS'
  method?: string; // 'private-api' | 'apple-script'
}

/** POST /api/v1/chat/new — create a chat with the given addresses + an initial message. */
export function createChat(http: HttpClient, params: CreateChatParams): Promise<Chat> {
  return http.post('/chat/new', Chat, {
    json: {
      addresses: params.addresses,
      message: params.message,
      service: params.service ?? 'iMessage',
      method: params.method ?? 'private-api',
    },
  });
}

/** GET /api/v1/chat/{guid} — single chat with participants. */
export function getChat(http: HttpClient, guid: string): Promise<Chat> {
  return http.get(`/chat/${encodeURIComponent(guid)}`, Chat, {
    query: { with: 'participants,lastmessage' },
  });
}

/** POST /api/v1/chat/{guid}/read — mark a chat as read. */
export function markChatRead(http: HttpClient, guid: string): Promise<unknown> {
  return http.post(`/chat/${encodeURIComponent(guid)}/read`, z.unknown());
}

// ── Group management ─────────────────────────────────────────────────────────
// SERVER-GATED: these mutate an iMessage group via the BlueBubbles **private API**
// (must be enabled on the server). They can't be verified without a live server.

/** POST /api/v1/chat/{guid}/participant/{add|remove} — add/remove a member by address. */
export function updateParticipant(
  http: HttpClient,
  guid: string,
  action: 'add' | 'remove',
  address: string,
): Promise<Chat> {
  return http.post(`/chat/${encodeURIComponent(guid)}/participant/${action}`, Chat, {
    json: { address },
  });
}

/** PUT /api/v1/chat/{guid} — rename a group chat. */
export function renameChat(http: HttpClient, guid: string, displayName: string): Promise<Chat> {
  return http.put(`/chat/${encodeURIComponent(guid)}`, Chat, { json: { displayName } });
}

/** POST /api/v1/chat/{guid}/leave — leave a group chat. */
export function leaveChat(http: HttpClient, guid: string): Promise<unknown> {
  return http.post(`/chat/${encodeURIComponent(guid)}/leave`, z.unknown());
}

export { SYNC_WITH_QUERY };
