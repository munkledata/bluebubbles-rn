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

// The server wraps the list in a named key ({ chats: [...] }) inside the unwrapped `data`.
export const ChatList = z.object({ chats: z.array(Chat).nullish() });

/** POST /api/v1/chat/query — paginated chat list. */
export async function queryChats(http: HttpClient, q: ChatQuery = {}): Promise<Chat[]> {
  const res = await http.post('/chat/query', ChatList, {
    json: {
      limit: q.limit ?? 1000,
      offset: q.offset ?? 0,
      with: ['participants', 'lastMessage'],
      sort: q.sort ?? 'lastmessage',
    },
  });
  return res.chats ?? [];
}

export interface CreateChatParams {
  addresses: string[]; // recipient handles (phone/email)
  message: string; // initial message (the server requires one to create the thread)
  service?: string; // 'iMessage' | 'SMS'
  method?: string; // 'private-api' | 'apple-script'
}

// A single chat read/mutation may be wrapped in a named key ({ chat }) — like the list's
// { chats } — or returned bare. Accept either so we're robust to the server's shape.
const SingleChat = z.union([z.object({ chat: Chat }), Chat]);
function unwrapChat(res: z.infer<typeof SingleChat>): Chat {
  return 'chat' in res ? res.chat : res;
}

/**
 * POST /api/v1/chat/new — create a chat with the given addresses + an initial message.
 *
 * NOTE: UNIMPLEMENTED on the Gator server (no `/api/v1/chat/new` operation as of this
 * audit — verified against bbd/src/api/operations/*). This call will 404; the new-chat
 * UI alerts on the rejection. The tolerant `{ chat }`-or-bare schema is kept so the app
 * works unchanged if/when the server adds the op.
 */
export async function createChat(http: HttpClient, params: CreateChatParams): Promise<Chat> {
  const res = await http.post('/chat/new', SingleChat, {
    json: {
      addresses: params.addresses,
      message: params.message,
      service: params.service ?? 'iMessage',
      method: params.method ?? 'private-api',
    },
  });
  return unwrapChat(res);
}

/**
 * GET /api/v1/chat/{guid} — single chat with participants.
 *
 * NOTE: UNIMPLEMENTED on the Gator server (no single-chat read op — the only chat read is
 * the `POST /chat/query` list). This will 404; callers should fall back to the list.
 * Schema tolerates a `{ chat }` wrapper or a bare chat for forward compatibility.
 */
export async function getChat(http: HttpClient, guid: string): Promise<Chat> {
  const res = await http.get(`/chat/${encodeURIComponent(guid)}`, SingleChat, {
    query: { with: 'participants,lastmessage' },
  });
  return unwrapChat(res);
}

/** POST /api/v1/chat/{guid}/read — mark a chat as read. */
export function markChatRead(http: HttpClient, guid: string): Promise<unknown> {
  return http.post(`/chat/${encodeURIComponent(guid)}/read`, z.unknown());
}

// ── Group management ─────────────────────────────────────────────────────────
// UNIMPLEMENTED on the Gator server: there are NO chat-mutation operations (verified
// against bbd/src/api/operations/* — the chat surface is only `POST /chat/query` list and
// the read/action message ops). Every call below 404s; the group-management UI alerts on
// the rejection, so the app degrades gracefully. The functions + tolerant `{ chat }`-or-
// bare schema are kept so the app works unchanged if/when the server adds these ops.

/** POST /api/v1/chat/{guid}/participant/{add|remove} — add/remove a member by address. */
export async function updateParticipant(
  http: HttpClient,
  guid: string,
  action: 'add' | 'remove',
  address: string,
): Promise<Chat> {
  const res = await http.post(
    `/chat/${encodeURIComponent(guid)}/participant/${action}`,
    SingleChat,
    {
      json: { address },
    },
  );
  return unwrapChat(res);
}

/** PUT /api/v1/chat/{guid} — rename a group chat. */
export async function renameChat(
  http: HttpClient,
  guid: string,
  displayName: string,
): Promise<Chat> {
  const res = await http.put(`/chat/${encodeURIComponent(guid)}`, SingleChat, {
    json: { displayName },
  });
  return unwrapChat(res);
}

/** POST /api/v1/chat/{guid}/leave — leave a group chat. */
export function leaveChat(http: HttpClient, guid: string): Promise<unknown> {
  return http.post(`/chat/${encodeURIComponent(guid)}/leave`, z.unknown());
}

export { SYNC_WITH_QUERY };
