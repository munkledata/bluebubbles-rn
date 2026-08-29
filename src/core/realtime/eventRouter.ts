import { Message } from '@core/models';
import { MAX_SERVER_ORIGIN_INPUT_LENGTH } from '@core/config';
import { logger } from '@core/secure';
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
}

/** Optional account-lifetime guard supplied by native realtime transports. */
export interface EventDeliveryContext {
  readonly generation: number;
  readonly durableEvent?: DurableEventCheckpoint;
  isCurrent(): boolean;
}

export type NormalizedEventDeliveryResult = 'processed' | 'stale';

/**
 * Normalizes raw realtime events (from the socket OR an FCM data message) into a
 * validated {@link NormalizedEvent} and forwards them to the sink. Direct port
 * of ActionHandler.handleEvent — one place that understands every event name.
 *
 * Returns the normalized event (or null if unrecognized/invalid) to make testing
 * and dedup decisions easy for the caller.
 */
export class EventRouter {
  // Bounded set of recently-seen message GUIDs. Socket + FCM (and a retried
  // delivery) can deliver the same message twice; dedup here so the sink runs
  // — and a notification posts — only once. DB upsert is already idempotent;
  // this prevents the duplicate notification.
  private readonly seen = new Set<string>();
  private static readonly SEEN_MAX = 500;

  constructor(private readonly sink: EventSink) {}

  async handle(
    eventName: string,
    rawData: unknown,
    source: EventSource,
    context?: EventDeliveryContext,
    _occurrence?: EventOccurrenceMetadata,
  ): Promise<NormalizedEvent | null> {
    if (context && !context.isCurrent()) return null;
    const normalized = normalizeRealtimeEvent(eventName, rawData);
    if (!normalized) {
      // Observability: a dropped event is either an unhandled type or failed schema
      // validation (e.g. an encrypted FCM payload). Don't fail silently. `debug` is
      // suppressed in production + Jest, so this is dev-only diagnostics.
      logger.debug('[eventRouter] dropped event (unrecognized or invalid)', {
        event: eventName,
        source,
      });
      return null;
    }
    if (this.hasSeen(normalized)) return null;
    // Claim the guid BEFORE awaiting the sink so a concurrent redelivery (socket + FCM racing)
    // is still deduped — but RELEASE it if the sink throws, so a delivery that failed on a
    // transient error (e.g. a DB write hiccup) stays retry-eligible instead of being swallowed
    // forever. Recording only AFTER success would let two concurrent copies both notify;
    // recording only BEFORE (the old behaviour) dropped the notification permanently on any sink
    // error, and every later redelivery of that guid was then silently deduped away.
    this.recordSeen(normalized);
    try {
      const result = await this.handleNormalized(normalized, source, context);
      if (result === 'stale') {
        this.unrecordSeen(normalized);
        return null;
      }
    } catch (e) {
      this.unrecordSeen(normalized);
      throw e;
    }
    return normalized;
  }

  /**
   * Deliver an already-validated event without the compatibility path's in-memory deduplication.
   * Durable intake owns deduplication through queue receipts, so claimed replay must use this path
   * or a successfully persisted message could be swallowed by a stale process-local `seen` entry.
   */
  async handleNormalized(
    event: NormalizedEvent,
    source: EventSource,
    context?: EventDeliveryContext,
  ): Promise<NormalizedEventDeliveryResult> {
    if (context && !context.isCurrent()) return 'stale';
    await this.sink.onEvent(event, source, context);
    return context && !context.isCurrent() ? 'stale' : 'processed';
  }

  /**
   * The dedup key for an event, or null for event types that are never deduped.
   *
   * Dedup is restricted to `new-message` only: a redelivered new-message (socket + FCM, or a
   * retried push) must post its notification exactly once. `updated-message` is NOT deduped —
   * a guid receives many updates (delivered → read → edited → retracted), each carrying a
   * DIFFERENT timestamp, and they must all reach the sink (the DB upsert's COALESCE is
   * idempotent, so re-applying one is harmless). Deduping by guid here would drop every
   * update after the first for a given message.
   */
  private seenKey(event: NormalizedEvent): string | null {
    if (event.type !== 'new-message') return null;
    const guid = event.message.guid;
    if (!guid) return null;
    // Gator's RCS bridge reuses one synthetic message guid for reaction add/remove/re-add deltas.
    // A guid-only key drops the removal. Include the delta state in this legacy direct-path key;
    // durable intake uses the stronger canonical digest identity instead.
    if (event.message.associatedMessageType != null) {
      // Unknown part identity is deliberately distinct from the real part zero. Treating both as
      // `0` would swallow one of two otherwise-identical reaction deltas aimed at different parts.
      const partKey =
        event.message.associatedMessagePart == null
          ? 'part:unknown'
          : `part:${event.message.associatedMessagePart}`;
      return [
        event.type,
        guid,
        event.message.dateCreated ?? '',
        partKey,
        event.message.associatedMessageType,
        event.message.associatedMessageEmoji ?? '',
      ].join(':');
    }
    return `${event.type}:${guid}`;
  }

  /** True if this message event was already processed. Read-only — does not record anything. */
  private hasSeen(event: NormalizedEvent): boolean {
    const key = this.seenKey(event);
    return key !== null && this.seen.has(key);
  }

  /** Record the event as seen, evicting the oldest key past the cap. No-op for un-deduped types. */
  private recordSeen(event: NormalizedEvent): void {
    const key = this.seenKey(event);
    if (key === null) return;
    this.seen.add(key);
    if (this.seen.size > EventRouter.SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Release a previously-recorded key so a delivery that failed can be retried. */
  private unrecordSeen(event: NormalizedEvent): void {
    const key = this.seenKey(event);
    if (key !== null) this.seen.delete(key);
  }
}

/**
 * The one side-effect-free raw transport -> validated event boundary.
 *
 * Durable intake calls this before canonicalization; EventRouter uses the same function for its
 * compatibility `handle` path, so socket, FCM, dev injection, and replay cannot drift into separate
 * payload interpretations.
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
