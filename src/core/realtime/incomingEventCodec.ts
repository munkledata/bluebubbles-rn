import type { Message } from '@core/models';
import { resolveMessageChatGuid } from '@core/models';
import { utf8Encode } from '@utils/bytes';
import type { NormalizedEvent, ServerEventName } from './events';
import type { EventSource } from './eventRouter';
import { normalizeRealtimeEvent } from './eventRouter';

export const INCOMING_EVENT_SCHEMA_VERSION = 1;

const MAX_OCCURRENCE_ID_BYTES = 512;
const SHA256_BYTES = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 100_000;

export interface DigestBackend {
  sha256(input: Uint8Array): Promise<Uint8Array>;
}

export type IncomingEventIdentityQuality = 'exact' | 'content-revision' | 'best-effort';
export type IncomingEventConflictRecovery =
  | { readonly kind: 'sync-chat'; readonly chatGuid: string }
  | { readonly kind: 'sync-deletions' }
  | { readonly kind: 'sync-account' }
  | { readonly kind: 'none' };

export interface IncomingEventMetadata {
  readonly source: EventSource;
  /** Local intake clock, never a caller/server timestamp. */
  readonly receivedAt: number;
  /** Future authenticated server occurrence id shared by socket + FCM copies. */
  readonly serverEventId?: string;
  /** Current transport-local occurrence id (FCM message id or socket connection+sequence). */
  readonly transportOccurrenceId?: string;
}

/** Core-owned shape that intentionally mirrors, but does not import, the DB repository input. */
export interface DurableIncomingEnvelope {
  readonly schemaVersion: typeof INCOMING_EVENT_SCHEMA_VERSION;
  readonly eventName: ServerEventName;
  readonly source: EventSource;
  readonly payload: string;
  readonly payloadDigest: string;
  readonly eventKey: string;
  readonly orderingKey: string;
  readonly receivedAt: number;
  readonly expiresAt: number;
}

export interface EncodedIncomingEvent {
  readonly envelope: DurableIncomingEnvelope;
  readonly identityQuality: IncomingEventIdentityQuality;
  readonly conflictRecovery: IncomingEventConflictRecovery;
}

export type IncomingEventCodecErrorCode =
  | 'invalid-metadata'
  | 'missing-occurrence-id'
  | 'missing-identity'
  | 'non-json-value'
  | 'work-limit'
  | 'digest-failure'
  | 'unsupported-version'
  | 'invalid-json'
  | 'non-canonical-payload'
  | 'invalid-event'
  | 'digest-mismatch';

export class IncomingEventCodecError extends Error {
  constructor(readonly code: IncomingEventCodecErrorCode) {
    super(`incoming event codec rejected input: ${code}`);
    this.name = 'IncomingEventCodecError';
  }
}

type JsonPrimitive = null | boolean | number | string;
type CanonicalJsonValue =
  JsonPrimitive | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

/**
 * Deterministic JSON used by both the stored payload digest and identity projections.
 *
 * Objects are key-sorted and omit undefined members like JSON.stringify. Arrays preserve order and
 * reject holes/undefined because JSON.stringify silently turns those into null, erasing the input
 * distinction. Only plain JSON objects are accepted; cycles, accessors, symbols, and non-finite
 * numbers fail closed.
 */
export function canonicalizeJson(value: unknown): string {
  const active = new WeakSet<object>();
  let visitedNodes = 0;

  const visit = (
    current: unknown,
    inArray: boolean,
    depth: number,
  ): CanonicalJsonValue | undefined => {
    visitedNodes += 1;
    if (depth > MAX_CANONICAL_DEPTH || visitedNodes > MAX_CANONICAL_NODES) {
      throw new IncomingEventCodecError('work-limit');
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new IncomingEventCodecError('non-json-value');
      return current;
    }
    if (current === undefined) {
      if (inArray) throw new IncomingEventCodecError('non-json-value');
      return undefined;
    }
    if (typeof current !== 'object') throw new IncomingEventCodecError('non-json-value');
    if (active.has(current)) throw new IncomingEventCodecError('non-json-value');

    active.add(current);
    try {
      if (Array.isArray(current)) {
        const output: CanonicalJsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!(index in current)) throw new IncomingEventCodecError('non-json-value');
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new IncomingEventCodecError('non-json-value');
          }
          const item = visit(descriptor.value, true, depth + 1);
          if (item === undefined) throw new IncomingEventCodecError('non-json-value');
          output.push(item);
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new IncomingEventCodecError('non-json-value');
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new IncomingEventCodecError('non-json-value');
      }

      // A normal `{}` would route the JSON key "__proto__" through Object.prototype's legacy
      // setter. A null-prototype dictionary preserves it as ordinary data.
      const output = Object.create(null) as Record<string, CanonicalJsonValue>;
      for (const key of Object.keys(current).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new IncomingEventCodecError('non-json-value');
        }
        const item = visit(descriptor.value, false, depth + 1);
        if (item !== undefined) output[key] = item;
      }
      return output;
    } finally {
      active.delete(current);
    }
  };

  const normalized = visit(value, false, 0);
  if (normalized === undefined) throw new IncomingEventCodecError('non-json-value');
  return JSON.stringify(normalized);
}

export function canonicalizeIncomingEvent(event: NormalizedEvent): {
  readonly eventName: ServerEventName;
  readonly payload: string;
} {
  return { eventName: event.type, payload: canonicalizeJson(payloadBody(event)) };
}

export interface CapturedIncomingEvent {
  readonly eventName: ServerEventName;
  /** Owned canonical JSON; callers may safely carry it across an await. */
  readonly rawData: unknown;
}

/** Validate and detach a native callback payload into the durable codec's exact value domain. */
export function captureIncomingEvent(
  eventName: string,
  rawData: unknown,
): CapturedIncomingEvent | null {
  const event = normalizeRealtimeEvent(eventName, rawData);
  if (!event) return null;
  const canonical = canonicalizeIncomingEvent(event);
  return { eventName: canonical.eventName, rawData: JSON.parse(canonical.payload) };
}

/**
 * Validate and detach one native callback payload before its first asynchronous handoff.
 *
 * Canonical JSON is the durable envelope's exact value domain. Round-tripping through it gives
 * intake an owned deep snapshot, so a transport that retains and mutates its callback object
 * cannot change the event while it waits behind an earlier FIFO admission.
 */
export function snapshotIncomingEvent(eventName: string, rawData: unknown): NormalizedEvent | null {
  const captured = captureIncomingEvent(eventName, rawData);
  return captured ? normalizeRealtimeEvent(captured.eventName, captured.rawData) : null;
}

export async function encodeIncomingEvent(
  event: NormalizedEvent,
  metadata: IncomingEventMetadata,
  digest: DigestBackend,
): Promise<EncodedIncomingEvent> {
  assertMetadata(metadata);
  const canonical = canonicalizeIncomingEvent(event);
  // Snapshot through the exact canonical body before the first hash await. Transport/dev callers
  // retain their original object and must not be able to mutate identity/order between digests.
  const snapshotEvent = normalizeRealtimeEvent(canonical.eventName, JSON.parse(canonical.payload));
  if (!snapshotEvent) throw new IncomingEventCodecError('invalid-event');
  const snapshotMetadata: IncomingEventMetadata = { ...metadata };
  const payloadDigest = await digestHex(digest, utf8Encode(canonical.payload));
  const identity = identityDescriptor(snapshotEvent, snapshotMetadata);
  const order = orderingDescriptor(snapshotEvent, snapshotMetadata);
  const eventKeyDigest = await digestDescriptor(digest, 'event-key', identity.value);
  const orderingKeyDigest = await digestDescriptor(digest, 'ordering-key', order.value);
  const expiresAt = snapshotMetadata.receivedAt + ttlMs(snapshotEvent);
  if (!Number.isSafeInteger(expiresAt)) throw new IncomingEventCodecError('invalid-metadata');

  return {
    envelope: {
      schemaVersion: INCOMING_EVENT_SCHEMA_VERSION,
      eventName: canonical.eventName,
      source: snapshotMetadata.source,
      payload: canonical.payload,
      payloadDigest,
      eventKey: `ie1:${canonical.eventName}:${eventKeyDigest}`,
      orderingKey: `io1:${order.domain}:${orderingKeyDigest}`,
      receivedAt: snapshotMetadata.receivedAt,
      expiresAt,
    },
    identityQuality: snapshotMetadata.serverEventId ? 'exact' : identity.quality,
    conflictRecovery: identity.recovery,
  };
}

export interface StoredCanonicalIncomingEvent {
  readonly schemaVersion: number;
  readonly eventName: string;
  readonly payload: string;
  readonly payloadDigest: string;
}

/** Verify a stored payload's digest/canonical form and re-run the current event schema. */
export async function verifyAndParseIncomingEvent(
  stored: StoredCanonicalIncomingEvent,
  digest: DigestBackend,
): Promise<NormalizedEvent> {
  // Primitive snapshot before the await prevents a mutable repository/test object from changing
  // the bytes, digest, version, or event name between verification phases.
  const { schemaVersion, eventName, payload, payloadDigest } = stored;
  if (schemaVersion !== INCOMING_EVENT_SCHEMA_VERSION) {
    throw new IncomingEventCodecError('unsupported-version');
  }
  if (!SHA256_HEX.test(payloadDigest)) {
    throw new IncomingEventCodecError('digest-mismatch');
  }
  const actualDigest = await digestHex(digest, utf8Encode(payload));
  if (actualDigest !== payloadDigest) {
    throw new IncomingEventCodecError('digest-mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new IncomingEventCodecError('invalid-json');
  }
  const event = normalizeRealtimeEvent(eventName, parsed);
  if (!event || event.type !== eventName) {
    throw new IncomingEventCodecError('invalid-event');
  }
  if (canonicalizeIncomingEvent(event).payload !== payload) {
    throw new IncomingEventCodecError('non-canonical-payload');
  }
  return event;
}

function payloadBody(event: NormalizedEvent): unknown {
  switch (event.type) {
    case 'new-message':
    case 'updated-message':
      return canonicalMessageBody(event.message);
    case 'new-server':
      return { url: event.url };
    default:
      return event.payload;
  }
}

function canonicalMessageBody(message: Message): Message {
  const embeddedChatGuid = message.chats?.[0]?.guid;
  if (!embeddedChatGuid || message.chatGuid !== embeddedChatGuid) return message;
  // FCM hoists its envelope chatGuid into the body even when the socket payload already carries the
  // same identity in chats[0]. Treat that transport-only duplicate as one semantic payload; a real
  // disagreement remains in the digest and takes the first-wins + sync-recovery conflict path.
  return { ...message, chatGuid: undefined };
}

function identityDescriptor(
  event: NormalizedEvent,
  metadata: IncomingEventMetadata,
): {
  readonly value: unknown;
  readonly quality: IncomingEventIdentityQuality;
  readonly recovery: IncomingEventConflictRecovery;
} {
  if (metadata.serverEventId) {
    return {
      value: ['server-event', event.type, metadata.serverEventId],
      quality: 'exact',
      recovery: recoveryFor(event),
    };
  }

  switch (event.type) {
    case 'new-message':
      if (event.message.associatedMessageType != null) {
        return {
          // RCS add/remove/re-add deltas deliberately reuse one synthetic guid. Project only the
          // semantic delta fields: socket and FCM serializers intentionally differ in rich
          // hydration, so a full payload digest would execute the same reaction twice.
          value: ['reaction-delta', event.message.guid, reactionRevisionProjection(event.message)],
          quality: 'content-revision',
          recovery: recoveryFor(event),
        };
      }
      return {
        value: ['new-message', event.message.guid],
        quality: 'exact',
        recovery: recoveryFor(event),
      };
    case 'updated-message':
      return {
        value: ['updated-message', event.message.guid, updateRevisionProjection(event.message)],
        quality: 'content-revision',
        recovery: recoveryFor(event),
      };
    case 'message-deleted':
      return event.payload.dateDeleted != null
        ? {
            value: ['message-deleted', event.payload.guid, event.payload.dateDeleted],
            quality: 'exact',
            recovery: recoveryFor(event),
          }
        : bestEffortIdentity(event, metadata, recoveryFor(event));
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left': {
      const mutationId = groupMutationId(event.payload);
      return mutationId
        ? {
            // The helper system-message id already identifies this exact occurrence. Keeping the
            // full payload digest here would process harmless hydration variants twice.
            value: [event.type, mutationId],
            quality: 'exact',
            recovery: recoveryFor(event),
          }
        : bestEffortIdentity(event, metadata, recoveryFor(event));
    }
    case 'ft-call-status-changed': {
      const uuid = nonEmptyString(event.payload.uuid);
      const status = event.payload.status_id;
      if (!uuid || status == null) throw new IncomingEventCodecError('missing-identity');
      return {
        value: ['facetime-status', uuid, status],
        quality: 'exact',
        recovery: { kind: 'none' },
      };
    }
    case 'incoming-facetime': {
      const uuid = nonEmptyString(event.payload.uuid);
      if (!uuid) throw new IncomingEventCodecError('missing-identity');
      return {
        value: ['incoming-facetime', uuid],
        quality: 'exact',
        recovery: { kind: 'none' },
      };
    }
    case 'typing-indicator':
    case 'chat-read-status-changed':
    case 'imessage-aliases-removed':
    case 'new-server':
    case 'rcs-alert':
    case 'rcs-bridge-down':
    case 'test-notification':
      return bestEffortIdentity(event, metadata, recoveryFor(event));
    case 'message-send-error': {
      const explicitAttemptGuid = nonEmptyString(event.payload.attemptGuid);
      if (explicitAttemptGuid) {
        return {
          // Additive protocol target: one immutable id is generated when a real dispatch is
          // admitted and reused for every socket/FCM/webhook/redelivery copy of that attempt.
          // A later retry gets a new id even though it deliberately reuses tempGuid.
          value: ['message-send-error-attempt', explicitAttemptGuid],
          quality: 'exact',
          recovery: { kind: 'none' },
        };
      }
      const fallbackAttemptGuid = sendErrorFallbackAttemptGuid(event.payload);
      if (!fallbackAttemptGuid) {
        return bestEffortIdentity(event, metadata, recoveryFor(event));
      }
      const embedded = isRecord(event.payload.message) ? event.payload.message : {};
      return {
        // The stock server fans ONE serialized failure object to socket and FCM. When it carries a
        // real per-attempt message guid in addition to the optimistic tempGuid, that real guid is
        // the only cross-transport identity available. Keep temp-only bridge failures best-effort:
        // retries deliberately reuse tempGuid, so treating it as an occurrence id would suppress a
        // genuine later attempt for the full terminal-receipt lifetime.
        value: [
          'message-send-error',
          fallbackAttemptGuid,
          event.payload.error ?? embedded.error ?? null,
          event.payload.retryable ?? embedded.retryable ?? null,
        ],
        quality: 'content-revision',
        recovery: { kind: 'none' },
      };
    }
  }
}

function bestEffortIdentity(
  event: NormalizedEvent,
  metadata: IncomingEventMetadata,
  recovery: IncomingEventConflictRecovery,
): {
  readonly value: unknown;
  readonly quality: 'best-effort';
  readonly recovery: IncomingEventConflictRecovery;
} {
  const occurrence = occurrenceId(metadata);
  return {
    // FCM provider ids and socket connection/sequence ids are separate namespaces. Include the
    // transport so an accidental equal spelling cannot collapse unrelated occurrences.
    value: ['transport-occurrence', metadata.source, event.type, occurrence],
    quality: 'best-effort',
    recovery,
  };
}

function orderingDescriptor(
  event: NormalizedEvent,
  metadata: IncomingEventMetadata,
): { readonly domain: string; readonly value: unknown } {
  switch (event.type) {
    case 'new-message':
    case 'updated-message': {
      // Use one transport-independent domain for the whole lifecycle. Socket carries chats[] while
      // the real FCM updated-message intentionally omits it; switching between chat/message keys
      // lets a later update/delete overtake a backed-off new-message notification.
      const messageGuid = nonEmptyString(event.message.guid);
      if (!messageGuid) throw new IncomingEventCodecError('missing-identity');
      return { domain: 'message', value: ['message', messageGuid] };
    }
    case 'message-deleted':
      return { domain: 'message', value: ['message', event.payload.guid] };
    case 'typing-indicator': {
      const target = nonEmptyString(event.payload.chatGuid) ?? nonEmptyString(event.payload.guid);
      if (!target) throw new IncomingEventCodecError('missing-identity');
      return { domain: 'typing', value: ['typing', target] };
    }
    case 'chat-read-status-changed':
      return { domain: 'chat', value: ['chat', event.payload.chatGuid] };
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left': {
      const chatGuid = firstGroupChatGuid(event.payload);
      if (chatGuid) return { domain: 'chat', value: ['chat', chatGuid] };
      return {
        domain: 'group',
        value: ['group', groupMutationId(event.payload) ?? occurrenceId(metadata)],
      };
    }
    case 'ft-call-status-changed':
    case 'incoming-facetime': {
      const uuid = nonEmptyString(event.payload.uuid);
      if (!uuid) throw new IncomingEventCodecError('missing-identity');
      return { domain: 'facetime', value: ['facetime', uuid] };
    }
    case 'imessage-aliases-removed':
      return { domain: 'aliases', value: ['imessage-aliases'] };
    case 'message-send-error': {
      const chatGuid = sendErrorChatGuid(event.payload);
      if (chatGuid) return { domain: 'chat', value: ['chat', chatGuid] };
      const guid = sendErrorGuid(event.payload);
      if (!guid) throw new IncomingEventCodecError('missing-identity');
      return { domain: 'outgoing', value: ['outgoing', guid] };
    }
    case 'new-server':
      return { domain: 'server', value: ['server-origin'] };
    case 'rcs-alert':
    case 'rcs-bridge-down':
      return { domain: 'rcs', value: ['rcs-health'] };
    case 'test-notification':
      return { domain: 'test', value: ['test-notification'] };
  }
}

function ttlMs(event: NormalizedEvent): number {
  switch (event.type) {
    case 'typing-indicator':
    case 'chat-read-status-changed':
      // These payloads carry no durable boundary/version; do not replay them after first backoff.
      return 15_000;
    case 'incoming-facetime':
      return 90_000;
    case 'ft-call-status-changed':
      return 10 * 60_000;
    case 'rcs-alert':
    case 'test-notification':
      return 5 * 60_000;
    case 'new-server':
      // No server rotation sequence exists yet, so a long-delayed old URL must not win.
      return 15 * 60_000;
    case 'rcs-bridge-down':
      return 60 * 60_000;
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left':
    case 'imessage-aliases-removed':
      return 6 * 60 * 60_000;
    case 'new-message':
    case 'updated-message':
    case 'message-deleted':
    case 'message-send-error':
      return 24 * 60 * 60_000;
  }
}

function updateRevisionProjection(message: Message): unknown {
  return {
    text: message.text,
    subject: message.subject,
    dateCreated: message.dateCreated,
    dateRead: message.dateRead,
    dateDelivered: message.dateDelivered,
    dateEdited: message.dateEdited,
    dateRetracted: message.dateRetracted,
    error: message.error,
    isSent: message.isSent,
    isScheduled: message.isScheduled,
    hasAttachments: message.hasAttachments,
    partCount: message.partCount,
    // Both serializers carry these stable attachment identity fields. Rich-only transfer flags,
    // metadata and dimensions must not manufacture a second update occurrence.
    attachments: message.attachments?.map((attachment) => ({
      originalROWID: attachment.originalROWID,
      guid: attachment.guid,
      uti: attachment.uti,
      mimeType: attachment.mimeType,
      transferName: attachment.transferName,
      totalBytes: attachment.totalBytes,
    })),
    associatedMessageGuid: message.associatedMessageGuid,
    associatedMessagePart: message.associatedMessagePart,
    associatedMessageType: message.associatedMessageType,
    associatedMessageEmoji: message.associatedMessageEmoji,
    threadOriginatorGuid: message.threadOriginatorGuid,
    threadOriginatorPart: message.threadOriginatorPart,
    expressiveSendStyleId: message.expressiveSendStyleId,
    itemType: message.itemType,
    groupActionType: message.groupActionType,
    groupTitle: message.groupTitle,
    otherHandle: message.otherHandle,
  };
}

function reactionRevisionProjection(message: Message): unknown {
  return {
    dateCreated: message.dateCreated,
    partCount: message.partCount,
    associatedMessageGuid: message.associatedMessageGuid,
    associatedMessagePart: message.associatedMessagePart,
    associatedMessageType: message.associatedMessageType,
    associatedMessageEmoji: message.associatedMessageEmoji,
    handleId: message.handleId,
    handleAddress: message.handle?.address,
    otherHandle: message.otherHandle,
    itemType: message.itemType,
    groupActionType: message.groupActionType,
  };
}

function recoveryFor(event: NormalizedEvent): IncomingEventConflictRecovery {
  switch (event.type) {
    case 'new-message':
    case 'updated-message': {
      const chatGuid = resolveMessageChatGuid(event.message);
      return chatGuid ? { kind: 'sync-chat', chatGuid } : { kind: 'sync-account' };
    }
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left': {
      const chatGuid = firstGroupChatGuid(event.payload);
      return chatGuid ? { kind: 'sync-chat', chatGuid } : { kind: 'sync-account' };
    }
    case 'message-deleted':
      return event.payload.chatGuid
        ? { kind: 'sync-chat', chatGuid: event.payload.chatGuid }
        : { kind: 'sync-deletions' };
    default:
      return { kind: 'none' };
  }
}

function occurrenceId(metadata: IncomingEventMetadata): string {
  const occurrence = nonEmptyString(metadata.transportOccurrenceId);
  if (!occurrence) throw new IncomingEventCodecError('missing-occurrence-id');
  if (utf8Encode(occurrence).byteLength > MAX_OCCURRENCE_ID_BYTES) {
    throw new IncomingEventCodecError('invalid-metadata');
  }
  return occurrence;
}

function assertMetadata(metadata: IncomingEventMetadata): void {
  if (!Number.isSafeInteger(metadata.receivedAt) || metadata.receivedAt < 0) {
    throw new IncomingEventCodecError('invalid-metadata');
  }
  if (metadata.source !== 'socket' && metadata.source !== 'fcm' && metadata.source !== 'dev') {
    throw new IncomingEventCodecError('invalid-metadata');
  }
  if (metadata.serverEventId !== undefined) {
    const serverEventId = nonEmptyString(metadata.serverEventId);
    if (!serverEventId || utf8Encode(serverEventId).byteLength > MAX_OCCURRENCE_ID_BYTES) {
      throw new IncomingEventCodecError('invalid-metadata');
    }
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function groupMutationId(payload: Record<string, unknown>): string | undefined {
  const guid = nonEmptyString(payload.guid);
  if (guid) return `guid:${guid}`;
  const rowId = payload.originalROWID;
  return typeof rowId === 'number' && Number.isSafeInteger(rowId) ? `row:${rowId}` : undefined;
}

function firstGroupChatGuid(payload: { readonly chats?: unknown[] | null }): string | undefined {
  const first = payload.chats?.[0];
  return isRecord(first) ? nonEmptyString(first.guid) : undefined;
}

function sendErrorGuid(payload: Record<string, unknown>): string | undefined {
  const message = isRecord(payload.message) ? payload.message : {};
  return [payload.tempGuid, payload.messageGuid, payload.guid, message.guid]
    .map(nonEmptyString)
    .find((value) => value !== undefined);
}

/** A legacy server identity distinct from the optimistic temp id, suitable as a content fallback. */
function sendErrorFallbackAttemptGuid(payload: Record<string, unknown>): string | undefined {
  const message = isRecord(payload.message) ? payload.message : {};
  const tempGuid = nonEmptyString(payload.tempGuid);
  return [payload.guid, payload.messageGuid, message.guid]
    .map(nonEmptyString)
    .find((value) => value !== undefined && value !== tempGuid && !value.startsWith('temp-'));
}

function sendErrorChatGuid(payload: Record<string, unknown>): string | undefined {
  const direct = nonEmptyString(payload.chatGuid);
  if (direct) return direct;
  const rootFirst = Array.isArray(payload.chats) ? payload.chats[0] : undefined;
  if (isRecord(rootFirst)) {
    const rootChatGuid = nonEmptyString(rootFirst.guid);
    if (rootChatGuid) return rootChatGuid;
  }
  const message = isRecord(payload.message) ? payload.message : {};
  const nested = nonEmptyString(message.chatGuid);
  if (nested) return nested;
  const first = Array.isArray(message.chats) ? message.chats[0] : undefined;
  return isRecord(first) ? nonEmptyString(first.guid) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function digestDescriptor(
  backend: DigestBackend,
  domain: string,
  value: unknown,
): Promise<string> {
  return digestHex(
    backend,
    utf8Encode(`gator/incoming-event/v1/${domain}\u0000${canonicalizeJson(value)}`),
  );
}

async function digestHex(backend: DigestBackend, input: Uint8Array): Promise<string> {
  let output: Uint8Array;
  try {
    output = await backend.sha256(input);
  } catch {
    throw new IncomingEventCodecError('digest-failure');
  }
  if (!(output instanceof Uint8Array) || output.byteLength !== SHA256_BYTES) {
    throw new IncomingEventCodecError('digest-failure');
  }
  let hex = '';
  for (const byte of output) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
