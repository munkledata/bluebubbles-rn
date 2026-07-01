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
 * Implemented on the Gator server (Private API `new-chat` op). The server responds with
 * `{ guid }`; the rest of the chat hydrates from the chat sync. The tolerant
 * `{ chat }`-or-bare schema accepts either shape.
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
 * Implemented on the Gator server (`get-chat` op). Returns `{ chat }`; 404s for an unknown
 * guid, in which case callers may fall back to the list. Schema tolerates a `{ chat }`
 * wrapper or a bare chat.
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
// Implemented on the Gator server via the injected Private-API helper: add/remove
// participant, rename (PUT), and leave. Each mutation except leave returns the updated
// { chat } (read back from chat.db with participants). chat.db lags the action slightly, so
// the returned chat is best-effort; the app re-syncs to the authoritative state afterward.

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
