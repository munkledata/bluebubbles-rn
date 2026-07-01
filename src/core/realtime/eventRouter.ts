import { Message } from '@core/models';
import { logger } from '@core/secure';
import {
  FaceTimeStatusPayload,
  GroupChangePayload,
  ReadStatusPayload,
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
    if (this.isDuplicate(normalized)) return null;
    await this.sink.onEvent(normalized, source);
    return normalized;
  }

  /**
   * True (and records the guid) if this message event was already processed.
   *
   * Dedup is restricted to `new-message` only: a redelivered new-message (socket + FCM, or a
   * retried push) must post its notification exactly once. `updated-message` is NOT deduped —
   * a guid receives many updates (delivered → read → edited → retracted), each carrying a
   * DIFFERENT timestamp, and they must all reach the sink (the DB upsert's COALESCE is
   * idempotent, so re-applying one is harmless). Deduping by guid here would drop every
   * update after the first for a given message.
   */
  private isDuplicate(event: NormalizedEvent): boolean {
    if (event.type !== 'new-message') return false;
    const guid = event.message.guid;
    if (!guid) return false;
    const key = `${event.type}:${guid}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > EventRouter.SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
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
