import { z } from 'zod/v4';
import { Chat } from '@core/models';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import { utf8Decode, utf8Encode } from '@utils/bytes';
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
  address: string; // exactly one recipient handle (phone/email)
  message: string; // initial message (the server requires one to create the thread)
  service: 'RCS' | 'iMessage';
  /** Stable across retries of the same iMessage submission. */
  tempGuid?: string;
}

// A single chat read/mutation may be wrapped in a named key ({ chat }) — like the list's
// { chats } — or returned bare. /chat/new currently acknowledges only { guid }, before the
// Mac's chat database is guaranteed to show the new row.
const SingleChat = z.union([z.object({ chat: Chat }), Chat]);
function unwrapChat(res: z.infer<typeof SingleChat>): Chat {
  return 'chat' in res ? res.chat : res;
}

/**
 * POST /api/v1/chat/new — create a one-recipient chat with an initial message. iMessage creation
 * requires a stable client identity so retrying an ambiguous response cannot send twice.
 * A guid-only acknowledgement gets a provisional participant so the route has a local chat
 * immediately. The normal sync path later replaces it with authoritative Messages metadata.
 */
export async function createChat(http: HttpClient, params: CreateChatParams): Promise<Chat> {
  if (params.service !== 'RCS' && params.service !== 'iMessage') {
    throw new Error('This conversation service cannot be started.');
  }
  if (params.service === 'iMessage' && !params.tempGuid?.trim()) {
    throw new Error('Starting an iMessage conversation requires a stable request identity.');
  }
  const res = await http.post('/chat/new', SingleChat, {
    captureErrorDetail: true,
    json: {
      addresses: [params.address],
      message: params.message,
      service: params.service,
      ...(params.service === 'iMessage' ? { tempGuid: params.tempGuid } : {}),
    },
  });
  const chat = unwrapChat(res);
  // Messages may return its native service-agnostic ID for a new iMessage thread. That `any` ID
  // must name the requested address. An iMessage-prefixed ID may instead use a canonical alias;
  // its service prefix is not independent proof of the recipient, so the paired server/helper
  // remains responsible for binding this acknowledgement to the submitted address.
  const isRequestedNativeIMessageGuid =
    params.service === 'iMessage' && chat.guid === `any;-;${params.address}`;
  if (!chat.guid.startsWith(`${params.service};-;`) && !isRequestedNativeIMessageGuid) {
    throw new Error('The server returned a conversation for the wrong service.');
  }
  return {
    ...chat,
    participants: chat.participants?.length
      ? chat.participants
      : [{ address: params.address, service: params.service }],
  };
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

const MAX_IMESSAGE_READ_STATE_GUID_BYTES = 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Match the server/helper's bounded wire-safe one-to-one iMessage identifier rule. */
export function isIMessageReadStateGuid(guid: string): boolean {
  const parts = guid.split(';-;');
  if (
    parts.length !== 2 ||
    (parts[0] !== 'iMessage' && parts[0] !== 'any') ||
    (parts[1]?.length ?? 0) === 0 ||
    CONTROL_CHARACTER.test(guid)
  ) {
    return false;
  }
  const bytes = utf8Encode(guid);
  return bytes.byteLength <= MAX_IMESSAGE_READ_STATE_GUID_BYTES && utf8Decode(bytes) === guid;
}

/** POST /api/v1/chat/{guid}/read — propagate one supported RCS/iMessage read marker. */
export function markChatRead(http: HttpClient, guid: string): Promise<unknown> {
  if (!guid.startsWith('RCS;-;') && !isIMessageReadStateGuid(guid)) {
    throw new Error('Remote read markers require an RCS or one-to-one iMessage conversation.');
  }
  return http.post(`/chat/${encodeURIComponent(guid)}/read`, z.unknown(), { retry: false });
}

/** POST /api/v1/chat/{guid}/unread — mark one existing one-to-one iMessage chat unread. */
export function markChatUnread(http: HttpClient, guid: string): Promise<unknown> {
  if (!isIMessageReadStateGuid(guid)) {
    throw new Error('Remote unread markers require a one-to-one iMessage conversation.');
  }
  return http.post(`/chat/${encodeURIComponent(guid)}/unread`, z.unknown(), { retry: false });
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
