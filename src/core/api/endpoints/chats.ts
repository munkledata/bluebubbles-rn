import { z } from 'zod/v4';
import { Chat } from '@core/models';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import { apiResponse } from '@core/models/common';
import { isRcsProviderEpoch } from '@core/rcs/providerIdentity';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import { ApiError } from '../errors';
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
  /** Captured exact Google pairing required before the server may create/send under RCS. */
  providerEpoch?: string;
  /** Stable across retries of the same logical submission. */
  tempGuid?: string;
  /** RCS attempt generation echoed by the modern server; SHARE-02 persists generation one. */
  clientAttemptGeneration?: number;
  /** Fail closed unless the server returns exact RCS retry-correlation ownership. */
  requireAttemptReceipt?: boolean;
}

// A single chat read/mutation may be wrapped in a named key ({ chat }) — like the list's
// { chats } — or returned bare. /chat/new currently acknowledges only { guid }, before the
// Mac's chat database is guaranteed to show the new row.
const SingleChat = z.union([z.object({ chat: Chat }), Chat]);
const NewChatAttemptReceipt = z
  .object({
    guid: z.string(),
    tempGuid: z.string().min(1).max(256),
    attemptGuid: z.string().uuid(),
    clientAttemptGeneration: z.number().int().min(1),
  })
  .strict();
const CreateChatResponse = z.union([NewChatAttemptReceipt, SingleChat]);
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
  if (params.service === 'RCS' && !isRcsProviderEpoch(params.providerEpoch)) {
    throw new Error('Starting an RCS conversation requires the current Google pairing epoch.');
  }
  if (
    params.service === 'RCS' &&
    (params.tempGuid == null) !== (params.clientAttemptGeneration == null)
  ) {
    throw new Error('RCS retry identity requires both a stable id and generation.');
  }
  if (params.service === 'iMessage' && params.clientAttemptGeneration != null) {
    throw new Error('RCS attempt generation cannot be used for iMessage.');
  }
  const res = await http.post('/chat/new', CreateChatResponse, {
    captureErrorDetail: true,
    json: {
      addresses: [params.address],
      message: params.message,
      service: params.service,
      ...(params.service === 'iMessage'
        ? { tempGuid: params.tempGuid }
        : {
            providerEpoch: params.providerEpoch,
            ...(params.tempGuid
              ? {
                  tempGuid: params.tempGuid,
                  clientAttemptGeneration: params.clientAttemptGeneration,
                }
              : {}),
          }),
    },
  });
  const attemptReceipt = 'attemptGuid' in res ? res : null;
  if (
    params.service === 'RCS' &&
    params.requireAttemptReceipt === true &&
    (!attemptReceipt ||
      attemptReceipt.tempGuid !== params.tempGuid ||
      attemptReceipt.clientAttemptGeneration !== params.clientAttemptGeneration)
  ) {
    throw new Error('The server did not confirm exact durable RCS retry ownership.');
  }
  const chat = attemptReceipt ? Chat.parse({ guid: attemptReceipt.guid }) : unwrapChat(res);
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

const FoundRcsChat = z.object({ chat: Chat });

/**
 * POST /api/v1/rcs/chat/find-or-create — Google's get-or-create for one address. Nothing is sent:
 * an existing one-to-one thread comes back as it is, otherwise Google makes an empty one. The reply
 * must be a one-to-one RCS chat from the same Google pairing.
 */
export async function findOrCreateRcsChat(
  http: HttpClient,
  address: string,
  providerEpoch: string,
): Promise<Chat> {
  if (!isRcsProviderEpoch(providerEpoch)) {
    throw new Error('Finding an RCS conversation requires the current Google pairing epoch.');
  }
  const res = await http.post('/rcs/chat/find-or-create', FoundRcsChat, {
    captureErrorDetail: true,
    json: { address, providerEpoch },
  });
  const chat = res.chat;
  if (
    !chat.guid.startsWith('RCS;-;') ||
    (chat.providerEpoch != null && chat.providerEpoch !== providerEpoch) ||
    chat.style === 43
  ) {
    throw new Error('The server returned a conversation that is not this one-to-one RCS chat.');
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

const IMESSAGE_GROUP_GUID_MAX_BYTES = 1_024;
const IMESSAGE_GROUP_NAME_MAX_BYTES = 256;
const IMESSAGE_GROUP_RENAME_TEMP_GUID_MAX_BYTES = 256;
const IMESSAGE_GROUP_PHOTO_TEMP_GUID_MAX_BYTES = 256;
const IMESSAGE_GROUP_MEMBERSHIP_TEMP_GUID_MAX_BYTES = 256;
const IMESSAGE_GROUP_PHOTO_RESPONSE_MAX_BYTES = 64 * 1024;
const UNICODE_CONTROL_CHARACTER = /\p{Cc}/u;
const E164_IMESSAGE_ADDRESS = /^\+[1-9][0-9]{1,14}$/u;
const EmailIMessageAddress = z.string().max(254).email();
const IMessageGroupRenameAck = z
  .object({
    renamed: z.literal(true),
    guid: z.string(),
    displayName: z.string(),
  })
  .strict();

export interface RenameIMessageGroupParams {
  chatGuid: string;
  displayName: string;
  /** Stable idempotency identity for this one user-initiated attempt. */
  tempGuid: string;
}

export interface RenameIMessageGroupAck {
  renamed: true;
  guid: string;
  displayName: string;
}

function groupRenameOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid iMessage group rename acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_group_rename_outcome_unknown',
  );
}

function requireRoundTripUtf8(value: string, maxBytes: number, label: string): void {
  const bytes = utf8Encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || utf8Decode(bytes) !== value) {
    throw new Error(`${label} is not a well-formed bounded value.`);
  }
}

export function isValidIMessageGroupGuid(value: string): boolean {
  const bytes = utf8Encode(value);
  return (
    /^iMessage;\+;.+$/su.test(value) &&
    !UNICODE_CONTROL_CHARACTER.test(value) &&
    bytes.byteLength <= IMESSAGE_GROUP_GUID_MAX_BYTES &&
    utf8Decode(bytes) === value
  );
}

export function isValidIMessageGroupName(value: string): boolean {
  const bytes = utf8Encode(value);
  return (
    value.trim().length > 0 &&
    !UNICODE_CONTROL_CHARACTER.test(value) &&
    bytes.byteLength <= IMESSAGE_GROUP_NAME_MAX_BYTES &&
    utf8Decode(bytes) === value
  );
}

/** Canonical address shape shared with the server's narrow iMessage address contracts. */
export function isCanonicalIMessageParticipantAddress(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    !UNICODE_CONTROL_CHARACTER.test(value) &&
    (E164_IMESSAGE_ADDRESS.test(value) || EmailIMessageAddress.safeParse(value).success)
  );
}

/** POST one exact existing iMessage-group rename with no automatic HTTP retry. */
export async function renameIMessageGroup(
  http: HttpClient,
  params: RenameIMessageGroupParams,
): Promise<RenameIMessageGroupAck> {
  if (!isValidIMessageGroupGuid(params.chatGuid)) {
    throw new Error('An Apple group rename needs an exact existing iMessage group.');
  }
  if (
    params.displayName.trim().length === 0 ||
    UNICODE_CONTROL_CHARACTER.test(params.displayName)
  ) {
    throw new Error('An Apple group name must contain non-control text.');
  }
  if (!isValidIMessageGroupName(params.displayName)) {
    throw new Error('An Apple group name must be a well-formed bounded value.');
  }
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    UNICODE_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('An Apple group rename needs a client-generated temporary GUID.');
  }
  requireRoundTripUtf8(
    params.tempGuid,
    IMESSAGE_GROUP_RENAME_TEMP_GUID_MAX_BYTES,
    'rename tempGuid',
  );

  let ack: RenameIMessageGroupAck;
  try {
    const raw = await http.post(
      `/chat/${encodeURIComponent(params.chatGuid)}/rename`,
      IMessageGroupRenameAck,
      {
        captureErrorDetail: true,
        retry: false,
        json: { displayName: params.displayName, tempGuid: params.tempGuid },
      },
    );
    ack = IMessageGroupRenameAck.parse(raw);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw groupRenameOutcomeUnknown(error);
    }
    throw error;
  }

  if (ack.guid !== params.chatGuid || ack.displayName !== params.displayName) {
    throw groupRenameOutcomeUnknown(new Error('Group rename acknowledgement did not match input.'));
  }
  return ack;
}

const IMessageGroupPhotoSetAck = z
  .object({
    updated: z.literal(true),
    guid: z.string(),
    operation: z.literal('set'),
  })
  .strict();
const IMessageGroupPhotoRemoveAck = z
  .object({
    removed: z.literal(true),
    guid: z.string(),
    operation: z.literal('remove'),
  })
  .strict();

export type IMessageGroupPhotoSetAck = z.infer<typeof IMessageGroupPhotoSetAck>;
export type IMessageGroupPhotoRemoveAck = z.infer<typeof IMessageGroupPhotoRemoveAck>;

export interface RemoveIMessageGroupPhotoParams {
  readonly chatGuid: string;
  /** Stable idempotency identity for this one user-initiated attempt. */
  readonly tempGuid: string;
}

function groupPhotoOutcomeUnknown(message: string, cause: unknown, status?: number): ApiError {
  return new ApiError(
    'parse_error',
    message,
    status,
    cause,
    undefined,
    'imessage_group_photo_outcome_unknown',
  );
}

function requireIMessageGroupPhotoIdentity(chatGuid: string, tempGuid: string): void {
  if (!isValidIMessageGroupGuid(chatGuid)) {
    throw new Error('An Apple group photo change needs an exact existing iMessage group.');
  }
  if (
    !tempGuid.startsWith('temp-') ||
    tempGuid.trim() !== tempGuid ||
    UNICODE_CONTROL_CHARACTER.test(tempGuid)
  ) {
    throw new Error('An Apple group photo change needs a client-generated temporary GUID.');
  }
  requireRoundTripUtf8(tempGuid, IMESSAGE_GROUP_PHOTO_TEMP_GUID_MAX_BYTES, 'group photo tempGuid');
}

/**
 * Parse the bounded response returned by the native multipart uploader. The data object is strict,
 * and the exact target + operation must match the submitted mutation before it can be accepted.
 */
export function parseIMessageGroupPhotoSetResponse(
  body: string,
  status: number,
  params: RemoveIMessageGroupPhotoParams,
): IMessageGroupPhotoSetAck {
  requireIMessageGroupPhotoIdentity(params.chatGuid, params.tempGuid);
  if (body.length > IMESSAGE_GROUP_PHOTO_RESPONSE_MAX_BYTES) {
    throw groupPhotoOutcomeUnknown(
      'Server returned an oversized iMessage group photo acknowledgement',
      new Error('group photo response exceeded the client limit'),
      status,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw groupPhotoOutcomeUnknown(
      'Server returned an invalid iMessage group photo acknowledgement',
      error,
      status,
    );
  }
  const parsed = apiResponse(IMessageGroupPhotoSetAck).safeParse(json);
  if (!parsed.success || parsed.data.data.guid !== params.chatGuid) {
    throw groupPhotoOutcomeUnknown(
      'Server returned an invalid iMessage group photo acknowledgement',
      parsed.success ? new Error('Group photo acknowledgement did not match input.') : parsed.error,
      status,
    );
  }
  return parsed.data.data;
}

/** DELETE one exact existing iMessage-group photo with no automatic HTTP retry. */
export async function removeIMessageGroupPhoto(
  http: HttpClient,
  params: RemoveIMessageGroupPhotoParams,
  signal?: AbortSignal,
): Promise<IMessageGroupPhotoRemoveAck> {
  requireIMessageGroupPhotoIdentity(params.chatGuid, params.tempGuid);

  let ack: IMessageGroupPhotoRemoveAck;
  try {
    const raw = await http.delete(
      `/chat/${encodeURIComponent(params.chatGuid)}/icon`,
      IMessageGroupPhotoRemoveAck,
      {
        captureErrorDetail: true,
        retry: false,
        signal,
        json: { tempGuid: params.tempGuid },
      },
    );
    ack = IMessageGroupPhotoRemoveAck.parse(raw);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw groupPhotoOutcomeUnknown(
        'Server returned an invalid iMessage group photo removal acknowledgement',
        error,
      );
    }
    throw error;
  }

  if (ack.guid !== params.chatGuid) {
    throw groupPhotoOutcomeUnknown(
      'Server returned an invalid iMessage group photo removal acknowledgement',
      new Error('Group photo removal acknowledgement did not match input.'),
    );
  }
  return ack;
}

const IMessageGroupParticipantAddAck = z
  .object({
    added: z.literal(true),
    guid: z.string(),
    address: z.string(),
  })
  .strict();

export type IMessageGroupParticipantAddAck = z.infer<typeof IMessageGroupParticipantAddAck>;

export interface AddIMessageGroupParticipantParams {
  readonly chatGuid: string;
  readonly address: string;
  /** Stable idempotency identity for this one user-initiated attempt. */
  readonly tempGuid: string;
}

const IMessageGroupParticipantRemoveAck = z
  .object({
    removed: z.literal(true),
    guid: z.string(),
    address: z.string(),
  })
  .strict();

export type IMessageGroupParticipantRemoveAck = z.infer<typeof IMessageGroupParticipantRemoveAck>;

export interface RemoveIMessageGroupParticipantParams {
  readonly chatGuid: string;
  readonly address: string;
  /** Stable idempotency identity for this one user-initiated attempt. */
  readonly tempGuid: string;
}

const IMessageGroupLeaveAck = z
  .object({
    left: z.literal(true),
    guid: z.string(),
  })
  .strict();

export type IMessageGroupLeaveAck = z.infer<typeof IMessageGroupLeaveAck>;

export interface LeaveIMessageGroupParams {
  readonly chatGuid: string;
  /** Stable idempotency identity for this one user-initiated attempt. */
  readonly tempGuid: string;
}

function groupParticipantAddOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid iMessage group participant acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_group_participant_add_outcome_unknown',
  );
}

/** POST one canonical address to one exact existing iMessage group with no automatic retry. */
export async function addIMessageGroupParticipant(
  http: HttpClient,
  params: AddIMessageGroupParticipantParams,
): Promise<IMessageGroupParticipantAddAck> {
  if (!isValidIMessageGroupGuid(params.chatGuid)) {
    throw new Error('Adding an Apple group participant needs an exact existing iMessage group.');
  }
  if (!isCanonicalIMessageParticipantAddress(params.address)) {
    throw new Error('An Apple group participant needs a canonical E.164 number or email address.');
  }
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    UNICODE_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('Adding an Apple group participant needs a client-generated temporary GUID.');
  }
  requireRoundTripUtf8(
    params.tempGuid,
    IMESSAGE_GROUP_MEMBERSHIP_TEMP_GUID_MAX_BYTES,
    'participant-add tempGuid',
  );

  let ack: IMessageGroupParticipantAddAck;
  try {
    const raw = await http.post(
      `/chat/${encodeURIComponent(params.chatGuid)}/participants/add`,
      IMessageGroupParticipantAddAck,
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: params.address, tempGuid: params.tempGuid },
      },
    );
    ack = IMessageGroupParticipantAddAck.parse(raw);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw groupParticipantAddOutcomeUnknown(error);
    }
    throw error;
  }

  if (ack.guid !== params.chatGuid || ack.address !== params.address) {
    throw groupParticipantAddOutcomeUnknown(
      new Error('Group participant acknowledgement did not match input.'),
    );
  }
  return ack;
}

function groupParticipantRemoveOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid iMessage group participant removal acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_group_participant_remove_outcome_unknown',
  );
}

/** POST removal of one exact member from one exact iMessage group with no automatic retry. */
export async function removeIMessageGroupParticipant(
  http: HttpClient,
  params: RemoveIMessageGroupParticipantParams,
): Promise<IMessageGroupParticipantRemoveAck> {
  if (!isValidIMessageGroupGuid(params.chatGuid)) {
    throw new Error('Removing an Apple group participant needs an exact existing iMessage group.');
  }
  if (!isCanonicalIMessageParticipantAddress(params.address)) {
    throw new Error('An Apple group participant needs a canonical E.164 number or email address.');
  }
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    UNICODE_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('Removing an Apple group participant needs a client-generated temporary GUID.');
  }
  requireRoundTripUtf8(
    params.tempGuid,
    IMESSAGE_GROUP_MEMBERSHIP_TEMP_GUID_MAX_BYTES,
    'participant-remove tempGuid',
  );

  let ack: IMessageGroupParticipantRemoveAck;
  try {
    const raw = await http.post(
      `/chat/${encodeURIComponent(params.chatGuid)}/participants/remove`,
      IMessageGroupParticipantRemoveAck,
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: params.address, tempGuid: params.tempGuid },
      },
    );
    ack = IMessageGroupParticipantRemoveAck.parse(raw);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw groupParticipantRemoveOutcomeUnknown(error);
    }
    throw error;
  }

  if (ack.guid !== params.chatGuid || ack.address !== params.address) {
    throw groupParticipantRemoveOutcomeUnknown(
      new Error('Group participant removal acknowledgement did not match input.'),
    );
  }
  return ack;
}

function groupLeaveOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid iMessage group leave acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_group_leave_outcome_unknown',
  );
}

/** POST one exact existing iMessage-group leave with no automatic HTTP retry. */
export async function leaveIMessageGroup(
  http: HttpClient,
  params: LeaveIMessageGroupParams,
): Promise<IMessageGroupLeaveAck> {
  if (!isValidIMessageGroupGuid(params.chatGuid)) {
    throw new Error('Leaving an Apple group needs an exact existing iMessage group.');
  }
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    UNICODE_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('Leaving an Apple group needs a client-generated temporary GUID.');
  }
  requireRoundTripUtf8(
    params.tempGuid,
    IMESSAGE_GROUP_MEMBERSHIP_TEMP_GUID_MAX_BYTES,
    'group-leave tempGuid',
  );

  let ack: IMessageGroupLeaveAck;
  try {
    const raw = await http.post(
      `/chat/${encodeURIComponent(params.chatGuid)}/leave`,
      IMessageGroupLeaveAck,
      {
        captureErrorDetail: true,
        retry: false,
        json: { tempGuid: params.tempGuid },
      },
    );
    ack = IMessageGroupLeaveAck.parse(raw);
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw groupLeaveOutcomeUnknown(error);
    }
    throw error;
  }

  if (ack.guid !== params.chatGuid) {
    throw groupLeaveOutcomeUnknown(new Error('Group leave acknowledgement did not match input.'));
  }
  return ack;
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
