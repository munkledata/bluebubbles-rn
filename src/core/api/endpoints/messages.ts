import { z } from 'zod/v4';
import { Message } from '@core/models';
import { MessageDeletedPayload } from '@core/realtime/events';
import { SYNC_WITH_QUERY } from '@core/config/constants';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import { graphemeBoundaries } from '@utils/grapheme';
import { isSupportedIMessageEffectId } from '@core/effects';
import { looksLikeRcsMessageGuid } from '@core/rcs/providerIdentity';
import { ApiError } from '../errors';
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

const CANONICAL_MESSAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The narrow plain-text route succeeds only with its exact key and native Messages GUID. */
export const IMessagePlainTextAck = z
  .object({
    guid: z.string().regex(CANONICAL_MESSAGE_UUID),
    tempGuid: z.string().min(1),
    viaPrivateApi: z.literal(true),
  })
  .strict();
export type IMessagePlainTextAck = z.infer<typeof IMessagePlainTextAck>;

const IMessageEffectAck = z.object({ guid: z.string(), viaPrivateApi: z.literal(true) }).loose();

const IMessageMentionAck = z.object({ guid: z.string(), viaPrivateApi: z.literal(true) }).strict();

const IMessageFormattedAck = z
  .object({ guid: z.string(), viaPrivateApi: z.literal(true) })
  .strict();

const DEFINITE_IMESSAGE_MENTION_ERRORS = new Map<string, number>([
  ['imessage_mention_invalid_target', 400],
  ['imessage_mention_unavailable', 503],
  ['imessage_mention_rejected', 409],
  ['idempotency_capacity_exhausted', 503],
  ['idempotency_persistence_unavailable', 503],
]);

const DEFINITE_IMESSAGE_FORMATTED_ERRORS = new Map<string, number>([
  ['imessage_formatted_message_invalid_target', 400],
  ['imessage_formatted_message_unavailable', 503],
  ['imessage_formatted_message_rejected', 409],
  ['idempotency_capacity_exhausted', 503],
  ['idempotency_persistence_unavailable', 503],
]);

const KNOWN_IMESSAGE_PLAIN_TEXT_ERRORS = new Map<string, number>([
  ['imessage_plain_text_invalid_target', 400],
  ['imessage_plain_text_unavailable', 503],
  ['imessage_plain_text_rejected', 409],
  ['imessage_plain_text_outcome_unknown', 409],
  ['idempotency_outcome_unknown', 500],
  // Refused by the retry cache before the helper runs; the failure handler reads them as not sent.
  ['idempotency_key_invalid', 400],
  ['idempotency_key_reused', 409],
]);

/** Only exact reviewed status/type pairs prove that the mention helper did not dispatch. */
export function isDefiniteIMessageMentionError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  const expectedStatus = DEFINITE_IMESSAGE_MENTION_ERRORS.get(error.serverErrorType);
  return expectedStatus !== undefined && error.status === expectedStatus;
}

/** Only exact reviewed status/type pairs prove that the formatted helper did not dispatch. */
export function isDefiniteIMessageFormattedError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  const expectedStatus = DEFINITE_IMESSAGE_FORMATTED_ERRORS.get(error.serverErrorType);
  return expectedStatus !== undefined && error.status === expectedStatus;
}

function isKnownIMessagePlainTextError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  return KNOWN_IMESSAGE_PLAIN_TEXT_ERRORS.get(error.serverErrorType) === error.status;
}

/** Typed server refusals raised before the plain-text helper runs (status/type pairs as served). */
const PRE_DISPATCH_IMESSAGE_PLAIN_TEXT_ERRORS = new Map<string, number>([
  ['imessage_plain_text_unavailable', 503],
  ['idempotency_capacity_exhausted', 503],
  ['idempotency_persistence_unavailable', 503],
]);

/**
 * True when the server never processed this plain-text send, so the same tempGuid may be POSTed
 * again: no response at all (no connection, timeout, cancelled), an HTTP error without a server
 * error type (a proxy 502/504 while bbd restarts), or a typed pre-dispatch refusal. Re-POSTing is
 * safe because bbd runs the route inside its durable idempotency cache keyed by tempGuid: a repeat
 * joins an in-flight attempt or replays a stored outcome and never sends twice. Only the server's
 * own outcome-unknown answers, and malformed acknowledgements, retire a message as possibly sent.
 */
export function isRetryableIMessagePlainTextUnavailable(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (error.serverErrorType != null) {
    // Any other typed answer (including the status-less outcome-unknown wrapper) is not retry-safe.
    const status = PRE_DISPATCH_IMESSAGE_PLAIN_TEXT_ERRORS.get(error.serverErrorType);
    return status !== undefined && status === error.status;
  }
  return (
    error.kind === 'no_connection' ||
    error.kind === 'timeout' ||
    error.kind === 'cancelled' ||
    error.kind === 'server_error' ||
    error.kind === 'unauthorized' ||
    error.kind === 'bad_request'
  );
}

/** The narrow unsend route must confirm both the operation and its exact target identity. */
export const UnsendAck = z
  .object({ unsent: z.literal(true), guid: z.string().min(1).max(1_024) })
  .loose();
export type UnsendAck = z.infer<typeof UnsendAck>;

/** A remote delete is successful only when the server confirms the exact whole-message target. */
export const RemoteDeleteAck = z
  .object({ deleted: z.literal(true), guid: z.string().min(1).max(1_024) })
  .strict();
export type RemoteDeleteAck = z.infer<typeof RemoteDeleteAck>;

function requireMessagePartIndex(partIndex: number): number {
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex > 10_000) {
    throw new RangeError('A message action needs an exact part index from 0 through 10000');
  }
  return partIndex;
}

const IMESSAGE_REPLY_ID_MAX_BYTES = 1_024;
const IMESSAGE_REPLY_TEXT_MAX_BYTES = 65_536;
const IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES = 256;
const IMESSAGE_MENTION_ADDRESS_MAX_BYTES = 512;
const IMESSAGE_MENTION_MAX_COUNT = 64;
const IMESSAGE_FORMATTING_MAX_COUNT = 64;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MENTION_ID_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const REMOTE_DELETE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const DISALLOWED_MENTION_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const IMESSAGE_PLAIN_TEXT_DISALLOWED_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffc]/u;

function isWellFormedBoundedUtf8(value: string, maxBytes: number): boolean {
  const bytes = utf8Encode(value);
  return bytes.byteLength > 0 && bytes.byteLength <= maxBytes && utf8Decode(bytes) === value;
}

function requireWellFormedBoundedUtf8(value: string, maxBytes: number, label: string): string {
  const bytes = utf8Encode(value);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes || utf8Decode(bytes) !== value) {
    throw new Error(`${label} is not a well-formed bounded value.`);
  }
  return value;
}

function requireNarrowReply(params: SendTextParams): void {
  if (
    !/^(?:iMessage|any);-;.+$/u.test(params.chatGuid) ||
    CONTROL_CHARACTER.test(params.chatGuid)
  ) {
    throw new Error('An iMessage reply needs an existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(params.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  const target = params.selectedMessageGuid!;
  if (target.trim() !== target || CONTROL_CHARACTER.test(target)) {
    throw new Error('An iMessage reply needs an exact message target.');
  }
  requireWellFormedBoundedUtf8(target, IMESSAGE_REPLY_ID_MAX_BYTES, 'selectedMessageGuid');
  if (params.partIndex !== 0) {
    throw new Error('An iMessage reply needs exact message part zero.');
  }
  if (params.message.trim().length === 0 || params.message.includes('\u0000')) {
    throw new Error('An iMessage reply cannot be blank or contain NUL.');
  }
  requireWellFormedBoundedUtf8(params.message, IMESSAGE_REPLY_TEXT_MAX_BYTES, 'reply text');
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'reply tempGuid',
  );
}

/**
 * The text itself cannot go through the narrow iMessage route (blank, a control or inline-attachment
 * character, a broken character, or more than 64 KiB). Retrying or reconnecting cannot fix it.
 */
export class UnsupportedIMessageTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedIMessageTextError';
  }
}

export interface SendIMessagePlainTextParams {
  chatGuid: string;
  message: string;
  /** Durable idempotency identity generated before optimistic admission. */
  tempGuid: string;
}

/** Validate the exact helper envelope before optimistic admission and again at the endpoint. */
export function requireIMessagePlainTextRequest(params: SendIMessagePlainTextParams): void {
  if (
    !/^(?:iMessage|any);-;.+$/u.test(params.chatGuid) ||
    params.chatGuid.trim() !== params.chatGuid ||
    CONTROL_CHARACTER.test(params.chatGuid)
  ) {
    throw new Error('A narrow iMessage text needs an exact existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(params.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  if (
    params.message.trim().length === 0 ||
    IMESSAGE_PLAIN_TEXT_DISALLOWED_CHARACTER.test(params.message) ||
    !isWellFormedBoundedUtf8(params.message, IMESSAGE_REPLY_TEXT_MAX_BYTES)
  ) {
    throw new UnsupportedIMessageTextError(
      'A narrow iMessage text cannot be blank, contain unsupported control or attachment characters, or exceed 65,536 well-formed UTF-8 bytes.',
    );
  }
  if (params.tempGuid.length === 0) {
    throw new Error('A narrow iMessage text needs a nonempty temporary identity.');
  }
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'plain iMessage tempGuid',
  );
}

function imessagePlainTextOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'The iMessage delivery outcome is unknown',
    undefined,
    cause,
    undefined,
    'imessage_plain_text_outcome_unknown',
  );
}

/** POST one proven one-to-one iMessage body and require its exact durable/native identities. */
export async function sendIMessagePlainText(
  http: HttpClient,
  params: SendIMessagePlainTextParams,
): Promise<IMessagePlainTextAck> {
  requireIMessagePlainTextRequest(params);
  let ack: IMessagePlainTextAck;
  try {
    const raw = await http.post('/message/imessage-text', IMessagePlainTextAck, {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: params.chatGuid,
        message: params.message,
        tempGuid: params.tempGuid,
      },
    });
    ack = IMessagePlainTextAck.parse(raw);
  } catch (error) {
    // Keep retry-safe failures intact so callers arm the retry ladder for the same tempGuid.
    if (isKnownIMessagePlainTextError(error) || isRetryableIMessagePlainTextUnavailable(error)) {
      throw error;
    }
    throw imessagePlainTextOutcomeUnknown(error);
  }
  if (ack.tempGuid !== params.tempGuid || ack.guid === params.tempGuid) {
    throw imessagePlainTextOutcomeUnknown(
      new Error('iMessage plain-text acknowledgement echoed a different temporary identity'),
    );
  }
  return ack;
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

export const IMESSAGE_TEXT_STYLES = ['bold', 'italic', 'underline', 'strikethrough'] as const;
export type IMessageTextStyle = (typeof IMESSAGE_TEXT_STYLES)[number];

/** One disjoint UTF-16 range carrying a canonical, nonempty set of Apple text styles. */
export interface IMessageTextFormattingRange {
  start: number;
  length: number;
  styles: IMessageTextStyle[];
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
  const hasReplyGuid = params.selectedMessageGuid !== undefined;
  const hasReplyPart = params.partIndex !== undefined;
  if (hasReplyGuid !== hasReplyPart) {
    throw new Error('An iMessage reply needs both an exact message GUID and part index.');
  }
  if (hasReplyGuid) {
    if (
      params.method !== undefined ||
      params.clientAttemptGeneration !== undefined ||
      params.effectId !== undefined ||
      params.subject !== undefined ||
      params.mentions !== undefined
    ) {
      throw new Error('iMessage text replies do not support other rich-message fields.');
    }
    requireNarrowReply(params);
    return http.post('/message/text', SendAck, {
      captureErrorDetail: true,
      json: {
        chatGuid: params.chatGuid,
        tempGuid: params.tempGuid,
        text: params.message,
        selectedMessageGuid: params.selectedMessageGuid,
        partIndex: 0,
      },
    });
  }
  if (
    params.method === 'private-api' ||
    (params.method !== undefined && params.method !== 'apple-script') ||
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

/** Exact address shape required for both mentioned and unmentioned members of the target group. */
export function isExactIMessageMentionAddress(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    MENTION_ID_CONTROL_CHARACTER.test(value)
  ) {
    return false;
  }
  try {
    requireWellFormedBoundedUtf8(value, IMESSAGE_MENTION_ADDRESS_MAX_BYTES, 'mention address');
    return true;
  } catch {
    return false;
  }
}

/** Validate the exact mention content before optimistic admission and again at the HTTP boundary. */
export function requireIMessageMentionContent(
  chatGuid: string,
  message: string,
  mentions: readonly MessageMention[],
): void {
  if (
    !/^iMessage;\+;.+$/u.test(chatGuid) ||
    chatGuid.trim() !== chatGuid ||
    MENTION_ID_CONTROL_CHARACTER.test(chatGuid)
  ) {
    throw new Error('An iMessage mention needs an exact existing iMessage group.');
  }
  requireWellFormedBoundedUtf8(chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'mention chatGuid');
  if (message.trim().length === 0 || DISALLOWED_MENTION_CONTROL_CHARACTER.test(message)) {
    throw new Error('An iMessage mention cannot be blank or contain unsupported controls.');
  }
  requireWellFormedBoundedUtf8(message, IMESSAGE_REPLY_TEXT_MAX_BYTES, 'mention text');
  if (
    !Array.isArray(mentions) ||
    mentions.length < 1 ||
    mentions.length > IMESSAGE_MENTION_MAX_COUNT
  ) {
    throw new Error('An iMessage mention needs between 1 and 64 exact ranges.');
  }

  const boundaries = graphemeBoundaries(message);
  let previousEnd = 0;
  for (const mention of mentions) {
    if (
      typeof mention !== 'object' ||
      mention === null ||
      Array.isArray(mention) ||
      !Number.isSafeInteger(mention.start) ||
      !Number.isSafeInteger(mention.length) ||
      mention.start < previousEnd ||
      mention.length <= 0
    ) {
      throw new Error('iMessage mention ranges must be sorted and non-overlapping.');
    }
    const end = mention.start + mention.length;
    if (
      !Number.isSafeInteger(end) ||
      end > message.length ||
      !boundaries.has(mention.start) ||
      !boundaries.has(end) ||
      message.slice(mention.start, end).trim().length === 0
    ) {
      throw new Error('An iMessage mention range must cover one or more complete visible labels.');
    }
    if (!isExactIMessageMentionAddress(mention.address)) {
      throw new Error('An iMessage mention needs an exact participant address.');
    }
    previousEnd = end;
  }
}

export interface SendMentionParams {
  chatGuid: string;
  /** Durable idempotency identity generated before optimistic admission. */
  tempGuid: string;
  message: string;
  mentions: MessageMention[];
}

function mentionOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'The iMessage mention delivery outcome is unknown',
    undefined,
    cause,
    undefined,
    'imessage_mention_outcome_unknown',
  );
}

/** POST one exact group message with bounded Apple mention ranges and no automatic HTTP retry. */
export async function sendMention(http: HttpClient, params: SendMentionParams): Promise<SendAck> {
  requireIMessageMentionContent(params.chatGuid, params.message, params.mentions);
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    MENTION_ID_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('An iMessage mention needs a client-generated temporary GUID.');
  }
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'mention tempGuid',
  );

  let ack: z.infer<typeof IMessageMentionAck>;
  try {
    const raw = await http.post('/message/mention', IMessageMentionAck, {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: params.chatGuid,
        tempGuid: params.tempGuid,
        message: params.message,
        mentions: params.mentions.map(({ start, length, address }) => ({ start, length, address })),
      },
    });
    ack = IMessageMentionAck.parse(raw);
  } catch (error) {
    if (isDefiniteIMessageMentionError(error)) throw error;
    // Once the non-retrying request begins, a transport/parse failure cannot prove whether the
    // server admitted the durable key. Give every ambiguous failure one typed client outcome.
    throw mentionOutcomeUnknown(error);
  }

  try {
    if (
      ack.guid === params.tempGuid ||
      ack.guid.startsWith('temp-') ||
      ack.guid.trim() !== ack.guid ||
      MENTION_ID_CONTROL_CHARACTER.test(ack.guid)
    ) {
      throw new Error('mention acknowledgement is missing its exact helper GUID');
    }
    requireWellFormedBoundedUtf8(ack.guid, IMESSAGE_REPLY_ID_MAX_BYTES, 'mention guid');
  } catch (error) {
    throw mentionOutcomeUnknown(error);
  }
  return ack;
}

/** Validate one exact, bounded formatted-message body at every client trust boundary. */
export function requireIMessageFormattedContent(
  chatGuid: string,
  message: string,
  textFormatting: readonly IMessageTextFormattingRange[],
): void {
  if (
    !/^(?:iMessage|any);-;.+$/u.test(chatGuid) ||
    chatGuid.trim() !== chatGuid ||
    MENTION_ID_CONTROL_CHARACTER.test(chatGuid)
  ) {
    throw new Error('A formatted iMessage needs an exact existing one-to-one conversation.');
  }
  requireWellFormedBoundedUtf8(chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'formatted chatGuid');
  if (message.trim().length === 0 || DISALLOWED_MENTION_CONTROL_CHARACTER.test(message)) {
    throw new Error('A formatted iMessage cannot be blank or contain unsupported controls.');
  }
  requireWellFormedBoundedUtf8(message, IMESSAGE_REPLY_TEXT_MAX_BYTES, 'formatted text');
  if (
    !Array.isArray(textFormatting) ||
    textFormatting.length < 1 ||
    textFormatting.length > IMESSAGE_FORMATTING_MAX_COUNT
  ) {
    throw new Error('A formatted iMessage needs between 1 and 64 exact ranges.');
  }

  const boundaries = graphemeBoundaries(message);
  let previousEnd = 0;
  for (const range of textFormatting as readonly unknown[]) {
    if (
      typeof range !== 'object' ||
      range === null ||
      Array.isArray(range) ||
      Object.keys(range).sort().join(',') !== 'length,start,styles'
    ) {
      throw new Error('Formatted iMessage ranges must use the exact fixed shape.');
    }
    const { start, length, styles } = range as Record<string, unknown>;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      (start as number) < previousEnd ||
      (length as number) <= 0
    ) {
      throw new Error('Formatted iMessage ranges must be sorted and non-overlapping.');
    }
    const end = (start as number) + (length as number);
    if (
      !Number.isSafeInteger(end) ||
      end > message.length ||
      !boundaries.has(start as number) ||
      !boundaries.has(end)
    ) {
      throw new Error('A formatted iMessage range must cover complete characters.');
    }
    if (
      !Array.isArray(styles) ||
      styles.length < 1 ||
      styles.length > IMESSAGE_TEXT_STYLES.length
    ) {
      throw new Error('A formatted iMessage range needs at least one supported style.');
    }
    let previousStyle = -1;
    for (const style of styles) {
      const styleIndex = IMESSAGE_TEXT_STYLES.indexOf(style as IMessageTextStyle);
      if (styleIndex <= previousStyle) {
        throw new Error('Formatted iMessage styles must be unique and canonically ordered.');
      }
      previousStyle = styleIndex;
    }
    previousEnd = end;
  }
}

export interface SendFormattedParams {
  chatGuid: string;
  /** Durable idempotency identity generated before optimistic admission. */
  tempGuid: string;
  message: string;
  textFormatting: IMessageTextFormattingRange[];
}

function formattedOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'The formatted iMessage delivery outcome is unknown',
    undefined,
    cause,
    undefined,
    'imessage_formatted_message_outcome_unknown',
  );
}

/** POST one exact formatted message with no automatic HTTP retry. */
export async function sendFormatted(
  http: HttpClient,
  params: SendFormattedParams,
): Promise<SendAck> {
  requireIMessageFormattedContent(params.chatGuid, params.message, params.textFormatting);
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    MENTION_ID_CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('A formatted iMessage needs a client-generated temporary GUID.');
  }
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'formatted tempGuid',
  );

  let ack: z.infer<typeof IMessageFormattedAck>;
  try {
    const raw = await http.post('/message/formatted', IMessageFormattedAck, {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: params.chatGuid,
        tempGuid: params.tempGuid,
        message: params.message,
        textFormatting: params.textFormatting.map(({ start, length, styles }) => ({
          start,
          length,
          styles: [...styles],
        })),
      },
    });
    ack = IMessageFormattedAck.parse(raw);
  } catch (error) {
    if (isDefiniteIMessageFormattedError(error)) throw error;
    throw formattedOutcomeUnknown(error);
  }

  try {
    if (
      ack.guid === params.tempGuid ||
      ack.guid.startsWith('temp-') ||
      ack.guid.trim() !== ack.guid ||
      MENTION_ID_CONTROL_CHARACTER.test(ack.guid)
    ) {
      throw new Error('formatted acknowledgement is missing its exact helper GUID');
    }
    requireWellFormedBoundedUtf8(ack.guid, IMESSAGE_REPLY_ID_MAX_BYTES, 'formatted guid');
  } catch (error) {
    throw formattedOutcomeUnknown(error);
  }
  return ack;
}

export interface SendEffectParams {
  chatGuid: string;
  /** Durable idempotency identity generated before optimistic admission. */
  tempGuid: string;
  message: string;
  effectId: string;
}

function effectOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid iMessage effect acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_effect_outcome_unknown',
  );
}

/** POST one allowlisted text effect through the separately gated, one-shot helper command. */
export async function sendEffect(http: HttpClient, params: SendEffectParams): Promise<SendAck> {
  if (
    !/^(?:iMessage|any);-;.+$/u.test(params.chatGuid) ||
    params.chatGuid.trim() !== params.chatGuid ||
    CONTROL_CHARACTER.test(params.chatGuid)
  ) {
    throw new Error('An iMessage effect needs an existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(params.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  if (
    !params.tempGuid.startsWith('temp-') ||
    params.tempGuid.trim() !== params.tempGuid ||
    CONTROL_CHARACTER.test(params.tempGuid)
  ) {
    throw new Error('An iMessage effect needs a client-generated temporary GUID.');
  }
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'effect tempGuid',
  );
  if (params.message.trim().length === 0 || params.message.includes('\u0000')) {
    throw new Error('An iMessage effect cannot be blank or contain NUL.');
  }
  requireWellFormedBoundedUtf8(params.message, IMESSAGE_REPLY_TEXT_MAX_BYTES, 'effect text');
  if (!isSupportedIMessageEffectId(params.effectId)) {
    throw new Error('This iMessage effect is not supported.');
  }

  let ack: z.infer<typeof IMessageEffectAck>;
  try {
    ack = await http.post('/message/effect', IMessageEffectAck, {
      captureErrorDetail: true,
      retry: false,
      json: {
        chatGuid: params.chatGuid,
        tempGuid: params.tempGuid,
        message: params.message,
        effectId: params.effectId,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) throw effectOutcomeUnknown(error);
    throw error;
  }

  try {
    if (
      ack.guid.trim() !== ack.guid ||
      ack.guid.startsWith('temp-') ||
      CONTROL_CHARACTER.test(ack.guid)
    ) {
      throw new Error('effect acknowledgement is missing its exact helper GUID');
    }
    requireWellFormedBoundedUtf8(ack.guid, IMESSAGE_REPLY_ID_MAX_BYTES, 'effect guid');
  } catch (error) {
    throw effectOutcomeUnknown(error);
  }
  return ack;
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
 * server assembles a vCard 3.0. RCS keeps its media pipeline; iMessage uses the dedicated narrow
 * contact command. Both return the same `{ guid? }` SendAck, and the live `new-message` echo carries
 * the real `.vcf` attachment. The two services are authorized separately by the calling service.
 *
 * Empty phone/email arrays are omitted so the server's "a contact needs at least a name, org,
 * phone, or email" refinement isn't tripped by an all-empty body.
 */
export function sendContact(http: HttpClient, params: SendContactParams): Promise<SendAck> {
  if (
    !/^(?:RCS|iMessage|any);-;.+$/s.test(params.chatGuid) ||
    /[\u0000\r\n]/.test(params.chatGuid)
  ) {
    throw new Error('This contact card needs a supported conversation.');
  }
  if (
    params.subject !== undefined ||
    params.effectId !== undefined ||
    params.selectedMessageGuid !== undefined ||
    params.partIndex !== undefined
  ) {
    throw new Error('Contact-card captions, effects, and replies are not supported.');
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

export interface SendLocationParams {
  chatGuid: string;
  /** Stable client key reused by every retry of this exact location send. */
  tempGuid: string;
  latitude: number;
  longitude: number;
}

/** A queued snapshot stops being truthful as "Current Location" after this bounded retry window. */
export const CURRENT_LOCATION_MAX_REPLAY_AGE_MS = 15 * 60 * 1000;

/** POST one bounded, server-built Apple current-location card. */
function locationOutcomeUnknown(cause: unknown): ApiError {
  return new ApiError(
    'parse_error',
    'Server returned an invalid current-location acknowledgement',
    undefined,
    cause,
    undefined,
    'imessage_location_outcome_unknown',
  );
}

export async function sendLocation(http: HttpClient, params: SendLocationParams): Promise<SendAck> {
  if (
    !/^(?:iMessage|any);-;.+$/u.test(params.chatGuid) ||
    CONTROL_CHARACTER.test(params.chatGuid) ||
    params.chatGuid.trim() !== params.chatGuid
  ) {
    throw new Error('A current location needs an existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(params.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  requireWellFormedBoundedUtf8(
    params.tempGuid,
    IMESSAGE_REPLY_TEMP_GUID_MAX_BYTES,
    'location tempGuid',
  );
  if (!Number.isFinite(params.latitude) || params.latitude < -90 || params.latitude > 90) {
    throw new RangeError('latitude must be finite and between -90 and 90');
  }
  if (!Number.isFinite(params.longitude) || params.longitude < -180 || params.longitude > 180) {
    throw new RangeError('longitude must be finite and between -180 and 180');
  }
  let ack: SendAck;
  try {
    ack = await http.post('/message/location', SendAck, {
      captureErrorDetail: true,
      json: {
        chatGuid: params.chatGuid,
        tempGuid: params.tempGuid,
        latitude: Object.is(params.latitude, -0) ? 0 : params.latitude,
        longitude: Object.is(params.longitude, -0) ? 0 : params.longitude,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.kind !== 'parse_error') throw error;
    if (error instanceof ApiError || error instanceof z.ZodError) {
      throw locationOutcomeUnknown(error);
    }
    throw error;
  }
  try {
    if (
      ack.viaPrivateApi !== true ||
      typeof ack.guid !== 'string' ||
      ack.guid === params.tempGuid ||
      ack.guid.trim() !== ack.guid ||
      CONTROL_CHARACTER.test(ack.guid)
    ) {
      throw new Error('location acknowledgement is missing its exact helper GUID');
    }
    requireWellFormedBoundedUtf8(ack.guid, IMESSAGE_REPLY_ID_MAX_BYTES, 'location guid');
  } catch (error) {
    throw locationOutcomeUnknown(error);
  }
  return ack;
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
 * the send ack `{ guid? }`, NOT a Message — see {@link SendAck}. Callers must separately prove
 * either an RCS reaction or the narrow one-to-one iMessage reaction capability.
 *
 * Server contract: it requires `{ chatGuid, messageGuid, reactionType }` — NOT the
 * `selectedMessage*`/`reaction` keys the older client sent (which the server dropped → no
 * tapback). We map our params onto the server's names here.
 */
export function sendReaction(http: HttpClient, params: SendReactionParams): Promise<SendAck> {
  if (
    !params.chatGuid.startsWith('RCS;-;') &&
    !params.chatGuid.startsWith('iMessage;-;') &&
    !params.chatGuid.startsWith('any;-;')
  ) {
    throw new Error('This message action needs a supported conversation.');
  }
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
  /** The narrow helper command accepts only exact text part zero. */
  partIndex: 0;
}

/**
 * POST /api/v1/message/{guid}/edit — edit exact text part zero through the separately gated
 * helper command. This does not restore the broad Private API surface.
 * Returns the sender's send ack `{ guid? }`, NOT a Message — see {@link SendAck}.
 */
export function editMessage(http: HttpClient, p: EditMessageParams): Promise<SendAck> {
  if (!/^(?:iMessage|any);-;.+$/u.test(p.chatGuid) || CONTROL_CHARACTER.test(p.chatGuid)) {
    throw new Error('An iMessage edit needs an existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(p.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  if (
    p.messageGuid.trim() !== p.messageGuid ||
    CONTROL_CHARACTER.test(p.messageGuid) ||
    p.partIndex !== 0
  ) {
    throw new Error('An iMessage edit needs exact message part zero.');
  }
  requireWellFormedBoundedUtf8(p.messageGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'messageGuid');
  if (p.editedMessage.trim().length === 0 || p.editedMessage.includes('\u0000')) {
    throw new Error('An iMessage edit cannot be blank or contain NUL.');
  }
  requireWellFormedBoundedUtf8(p.editedMessage, IMESSAGE_REPLY_TEXT_MAX_BYTES, 'edited text');
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/edit`, SendAck, {
    captureErrorDetail: true,
    retry: false,
    json: {
      chatGuid: p.chatGuid,
      editedText: p.editedMessage,
      partIndex: 0,
    },
  });
}

export interface UnsendMessageParams {
  /** Chat the message lives in — the server REQUIRES this (min 1). */
  chatGuid: string;
  messageGuid: string;
  /** The narrow helper command accepts only exact text part zero. */
  partIndex: 0;
}

/**
 * POST /api/v1/message/{guid}/unsend — retract exact text part zero through the separately gated
 * helper command. This does not restore the broad Private API surface.
 */
export function unsendMessage(http: HttpClient, p: UnsendMessageParams): Promise<UnsendAck> {
  if (!/^(?:iMessage|any);-;.+$/u.test(p.chatGuid) || CONTROL_CHARACTER.test(p.chatGuid)) {
    throw new Error('An iMessage unsend needs an existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(p.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  if (
    p.messageGuid.trim() !== p.messageGuid ||
    CONTROL_CHARACTER.test(p.messageGuid) ||
    p.partIndex !== 0
  ) {
    throw new Error('An iMessage unsend needs exact message part zero.');
  }
  requireWellFormedBoundedUtf8(p.messageGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'messageGuid');
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/unsend`, UnsendAck, {
    captureErrorDetail: true,
    retry: false,
    json: { chatGuid: p.chatGuid, partIndex: 0 },
  });
}

export interface RemoteDeleteMessageParams {
  /** Exact existing iMessage chat that owns the whole message. */
  chatGuid: string;
  /** Exact server GUID of the whole message. Part deletion is deliberately unsupported. */
  messageGuid: string;
}

/**
 * POST /api/v1/message/{guid}/remote-delete — delete one whole message from Messages on the Mac.
 * This is neither phone-local Delete nor Unsend, accepts no part index, and is never retried.
 */
export function remoteDeleteMessage(
  http: HttpClient,
  p: RemoteDeleteMessageParams,
): Promise<RemoteDeleteAck> {
  if (
    !/^(?:(?:iMessage|any);-;.+|iMessage;\+;.+)$/u.test(p.chatGuid) ||
    p.chatGuid.trim() !== p.chatGuid ||
    REMOTE_DELETE_CONTROL_CHARACTER.test(p.chatGuid)
  ) {
    throw new Error('Remote deletion needs an exact existing iMessage conversation.');
  }
  requireWellFormedBoundedUtf8(p.chatGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'chatGuid');
  if (
    p.messageGuid.startsWith('temp-') ||
    looksLikeRcsMessageGuid(p.messageGuid as unknown) ||
    p.messageGuid.trim() !== p.messageGuid ||
    REMOTE_DELETE_CONTROL_CHARACTER.test(p.messageGuid)
  ) {
    throw new Error('Remote deletion needs an exact stored message GUID.');
  }
  requireWellFormedBoundedUtf8(p.messageGuid, IMESSAGE_REPLY_ID_MAX_BYTES, 'messageGuid');
  return http.post(`/message/${encodeURIComponent(p.messageGuid)}/remote-delete`, RemoteDeleteAck, {
    captureErrorDetail: true,
    retry: false,
    json: { chatGuid: p.chatGuid },
  });
}
