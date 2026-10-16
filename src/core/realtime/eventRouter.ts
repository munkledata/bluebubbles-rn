import { Message } from '@core/models';
import { MessageStateChanged } from '@core/models/messageState';
import { MAX_SERVER_ORIGIN_INPUT_LENGTH } from '@core/config';
import {
  AliasesRemovedPayload,
  FaceTimeStatusPayload,
  GroupChangePayload,
  MessageDeletedPayload,
  MessageSendErrorPayload,
  ReadStatusPayload,
  RcsAlertPayload,
  RcsBridgeDownPayload,
  TestNotificationPayload,
  TypingIndicatorPayload,
  type NormalizedEvent,
  type ServerEventName,
} from './events';

/**
 * Sink for normalized events. Implemented by the sync/notification layer in the
 * app; the router itself stays free of side effects so it is fully unit-testable
 * and reusable from the headless FCM handler (no React).
 */
export interface EventSink {
  onEvent(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): void | Promise<void>;
}

export type EventSource = 'socket' | 'fcm' | 'dev';

declare const durableEventTransactionContextBrand: unique symbol;

/**
 * Platform-free opaque token for an already-open authoritative event transaction.
 *
 * The database layer supplies the runtime-authenticated implementation. Core names only the
 * capability shape so realtime contracts never import a database, repository, or native type.
 */
export type DurableEventTransactionContext = Readonly<{
  readonly [durableEventTransactionContextBrand]: true;
}>;

/** Queue-owned DB checkpoint hook, kept free of repository/native types for the core boundary. */
export interface DurableEventCheckpoint {
  readonly dbAppliedAt: number | null;
  /** Must be invoked only at the end of an already-open authoritative domain transaction. */
  markDbAppliedWithinTransaction(context: DurableEventTransactionContext): Promise<void>;
}

/** Authenticated occurrence metadata supplied by a transport, never raw payload/ciphertext. */
export interface EventOccurrenceMetadata {
  readonly serverEventId?: string;
  readonly transportOccurrenceId?: string;
  /** Native callback receipt time captured before transport-specific asynchronous gates. */
  readonly receivedAt?: number;
  /** Authenticated transport deadline which may shorten, but never extend, local queue expiry. */
  readonly authenticatedExpiresAt?: number;
}

/** Optional account-lifetime guard supplied by native realtime transports. */
export interface EventDeliveryContext {
  readonly generation: number;
  readonly durableEvent?: DurableEventCheckpoint;
  /** Optional shorter native-callback lifetime layered over the account generation. */
  readonly signal?: AbortSignal;
  /** Optional event-identity guard that deliberately outlives a single durable receipt attempt. */
  readonly isProviderCurrent?: () => boolean;
  isCurrent(): boolean;
}

export type NormalizedEventDeliveryResult = 'processed' | 'stale';

/**
 * Delivers validated realtime events to the sink. Durable intake normalizes each raw socket or FCM
 * event with {@link normalizeRealtimeEvent}, deduplicates it through queue receipts, and replays it
 * here. The old raw `handle` path and its in-memory "seen" set were only used by tests (review
 * M110).
 */
export class EventRouter {
  constructor(private readonly sink: EventSink) {}

  /** Deliver one already-validated event, unless its delivery context has gone stale. */
  async handleNormalized(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<NormalizedEventDeliveryResult> {
    if (context && !context.isCurrent()) return 'stale';
    await this.sink.onEvent(event, source, context);
    return context && !context.isCurrent() ? 'stale' : 'processed';
  }
}

/**
 * The one side-effect-free raw transport -> validated event boundary.
 *
 * Durable intake calls this before canonicalization, so socket, FCM, dev injection, and replay
 * cannot drift into separate payload interpretations.
 */
export function normalizeRealtimeEvent(
  eventName: string,
  rawData: unknown,
): NormalizedEvent | null {
  const data = coerceRealtimeData(rawData);
  const serverEventName = eventName as ServerEventName;
  switch (serverEventName) {
    case 'new-message': {
      const m = Message.safeParse(data);
      return m.success ? { type: 'new-message', message: m.data } : null;
    }
    case 'updated-message': {
      const m = Message.safeParse(data);
      return m.success ? { type: 'updated-message', message: m.data } : null;
    }
    case 'message-deleted': {
      const p = MessageDeletedPayload.safeParse(data);
      return p.success ? { type: 'message-deleted', payload: p.data } : null;
    }
    case 'message-state-changed': {
      const p = MessageStateChanged.safeParse(data);
      return p.success ? { type: 'message-state-changed', payload: p.data } : null;
    }
    case 'typing-indicator': {
      const p = TypingIndicatorPayload.safeParse(data);
      return p.success ? { type: 'typing-indicator', payload: p.data } : null;
    }
    case 'chat-read-status-changed': {
      const p = ReadStatusPayload.safeParse(data);
      return p.success ? { type: 'chat-read-status-changed', payload: p.data } : null;
    }
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left': {
      const p = GroupChangePayload.safeParse(data);
      return p.success ? { type: serverEventName, payload: p.data } : null;
    }
    case 'ft-call-status-changed':
    case 'incoming-facetime': {
      // New Gator payloads use uuid/status_id/is_audio. Older helper frames use
      // call_uuid/call_status/is_sending_audio; normalize both before schema validation.
      const raw = isRecord(data) ? data : {};
      const candidate = {
        ...raw,
        uuid: raw.uuid ?? raw.call_uuid,
        status_id: raw.status_id ?? raw.call_status,
        is_audio: raw.is_audio ?? raw.is_sending_audio,
      };
      const p = FaceTimeStatusPayload.safeParse(candidate);
      return p.success ? { type: serverEventName, payload: p.data } : null;
    }
    case 'imessage-aliases-removed': {
      const p = AliasesRemovedPayload.safeParse(data);
      return p.success ? { type: 'imessage-aliases-removed', payload: p.data } : null;
    }
    case 'message-send-error': {
      const p = MessageSendErrorPayload.safeParse(data);
      return p.success ? { type: 'message-send-error', payload: p.data } : null;
    }
    case 'rcs-alert': {
      const p = RcsAlertPayload.safeParse(data);
      return p.success ? { type: 'rcs-alert', payload: p.data } : null;
    }
    case 'rcs-bridge-down': {
      const p = RcsBridgeDownPayload.safeParse(data);
      return p.success ? { type: 'rcs-bridge-down', payload: p.data } : null;
    }
    case 'test-notification': {
      const p = TestNotificationPayload.safeParse(data);
      return p.success ? { type: 'test-notification', payload: p.data } : null;
    }
    case 'new-server': {
      // Payload is the new server URL (a bare string, or wrapped as { url } / { server }).
      const url =
        typeof data === 'string'
          ? data
          : isRecord(data)
            ? (data.url ?? data.server ?? data.server_address)
            : undefined;
      return typeof url === 'string' &&
        url.length > 0 &&
        url.length <= MAX_SERVER_ORIGIN_INPUT_LENGTH
        ? { type: 'new-server', url }
        : null;
    }
    default:
      return null;
  }
}

/** FCM data messages often deliver the payload as a JSON string; unwrap it. */
export function coerceRealtimeData(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
