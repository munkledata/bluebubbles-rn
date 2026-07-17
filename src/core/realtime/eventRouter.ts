import { Message } from '@core/models';
import { logger } from '@core/secure';
import {
  FaceTimeStatusPayload,
  GroupChangePayload,
  MessageDeletedPayload,
  ReadStatusPayload,
  RcsAlertPayload,
  RcsBridgeDownPayload,
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
  onEvent(event: NormalizedEvent, source: EventSource): void | Promise<void>;
}

export type EventSource = 'socket' | 'fcm' | 'dev';

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
  ): Promise<NormalizedEvent | null> {
    const data = coerceData(rawData);
    const normalized = this.normalize(eventName as ServerEventName, data);
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
      await this.sink.onEvent(normalized, source);
    } catch (e) {
      this.unrecordSeen(normalized);
      throw e;
    }
    return normalized;
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
    return guid ? `${event.type}:${guid}` : null;
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

  private normalize(eventName: ServerEventName, data: unknown): NormalizedEvent | null {
    switch (eventName) {
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
        return p.success ? { type: eventName, payload: p.data } : null;
      }
      case 'ft-call-status-changed':
      case 'incoming-facetime': {
        const p = FaceTimeStatusPayload.safeParse(data);
        return p.success ? { type: eventName, payload: p.data } : null;
      }
      case 'imessage-aliases-removed':
        return {
          type: 'imessage-aliases-removed',
          payload: (data as Record<string, unknown>) ?? {},
        };
      case 'message-send-error':
        return {
          type: 'message-send-error',
          payload: (data as Record<string, unknown>) ?? {},
        };
      case 'rcs-alert': {
        const p = RcsAlertPayload.safeParse(data);
        return p.success ? { type: 'rcs-alert', payload: p.data } : null;
      }
      case 'rcs-bridge-down': {
        const p = RcsBridgeDownPayload.safeParse(data);
        return p.success ? { type: 'rcs-bridge-down', payload: p.data } : null;
      }
      case 'new-server': {
        // Payload is the new server URL (a bare string, or wrapped as { url } / { server }).
        const url =
          typeof data === 'string'
            ? data
            : ((data as { url?: unknown; server?: unknown })?.url ??
              (data as { server?: unknown })?.server);
        return typeof url === 'string' && url.length > 0 ? { type: 'new-server', url } : null;
      }
      default:
        return null;
    }
  }
}

/** FCM data messages often deliver the payload as a JSON string; unwrap it. */
function coerceData(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
