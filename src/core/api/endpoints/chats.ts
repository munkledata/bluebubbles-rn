import { z } from 'zod/v4';
import { Chat } from '@core/models';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import type { HttpClient, HttpUrlBuilder } from '../http';

export interface ChatQuery {
  limit?: number;
  offset?: number;
  /** Sort key, e.g. "lastmessage". */
  sort?: string;
}

// The server wraps the list in a named key ({ chats: [...] }) inside the unwrapped `data`.
export const ChatList = z.object({ chats: z.array(Chat).nullish() });

/** POST /api/v1/chat/query — paginated chat list. */
export async function queryChats(
  http: HttpClient,
  q: ChatQuery = {},
  signal?: AbortSignal,
): Promise<Chat[]> {
  const res = await http.post('/chat/query', ChatList, {
    signal,
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
  address: string; // exactly one RCS recipient handle (phone/email)
  message: string; // initial message (the server requires one to create the thread)
}

// A single chat read/mutation may be wrapped in a named key ({ chat }) — like the list's
// { chats } — or returned bare. Accept either so we're robust to the server's shape.
const SingleChat = z.union([z.object({ chat: Chat }), Chat]);
function unwrapChat(res: z.infer<typeof SingleChat>): Chat {
  return 'chat' in res ? res.chat : res;
}

/**
 * POST /api/v1/chat/new — create a one-recipient RCS chat with an initial message. iMessage/SMS
 * creation and their helper `method` selector are intentionally absent from this client contract.
 * The tolerant `{ chat }`-or-bare schema accepts either server response shape.
 */
export async function createChat(http: HttpClient, params: CreateChatParams): Promise<Chat> {
  const res = await http.post('/chat/new', SingleChat, {
    json: {
      addresses: [params.address],
      message: params.message,
      service: 'RCS',
    },
  });
  const chat = unwrapChat(res);
  if (!chat.guid.startsWith('RCS;-;')) {
    throw new Error('The server returned a non-RCS conversation for an RCS create request.');
  }
  return chat;
}

/**
 * GET /api/v1/chat/{guid} — single chat with participants.
 * Implemented on the Gator server (`get-chat` op). Returns `{ chat }`; 404s for an unknown
 * guid, in which case callers may fall back to the list. Schema tolerates a `{ chat }`
 * wrapper or a bare chat.
 */
export async function getChat(http: HttpClient, guid: string, signal?: AbortSignal): Promise<Chat> {
  const res = await http.get(`/chat/${encodeURIComponent(guid)}`, SingleChat, {
    signal,
    query: { with: 'participants,lastmessage' },
  });
  return unwrapChat(res);
}

/** POST /api/v1/chat/{guid}/read — propagate a read marker through the supported RCS bridge. */
export function markChatRead(http: HttpClient, guid: string): Promise<unknown> {
  if (!guid.startsWith('RCS;-;')) {
    throw new Error('Remote read markers are available only for RCS conversations.');
  }
  return http.post(`/chat/${encodeURIComponent(guid)}/read`, z.unknown());
}

/**
 * Authed URL for a chat's synced "transcript background" JPEG (macOS 26). Consumed by the
 * file downloader. Build it and its headers from the SAME `http.snapshotTransport()` so an
 * account transition cannot mix identities — same pattern as the attachment download URL.
 * Returns 404 when the chat has no background (or its asset isn't available yet).
 */
export function chatBackgroundUrl(http: HttpUrlBuilder, guid: string): string {
  return http.buildUrl(`/chat/${encodeURIComponent(guid)}/background`);
}

export { SYNC_WITH_QUERY };
