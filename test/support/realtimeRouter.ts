import {
  normalizeRealtimeEvent,
  type EventDeliveryContext,
  type EventRouter,
  type EventSource,
  type NormalizedEvent,
} from '@core/realtime';

/**
 * Deliver one raw transport event the way production does before durable intake existed:
 * normalize it with the shared boundary, then hand it to the router's sink. Tests use this in
 * place of the removed `EventRouter.handle` compatibility path (review M110). Production intake
 * deduplicates through durable queue receipts, so this helper deliberately keeps no in-memory
 * "seen" set: delivering the same event twice reaches the sink twice.
 *
 * Returns the normalized event, or null when the payload was invalid or the context went stale.
 */
export async function deliverRaw(
  router: EventRouter,
  eventName: string,
  rawData: unknown,
  source: EventSource,
  context?: EventDeliveryContext,
): Promise<NormalizedEvent | null> {
  if (context && !context.isCurrent()) return null;
  const normalized = normalizeRealtimeEvent(eventName, rawData);
  if (!normalized) return null;
  const result = await router.handleNormalized(normalized, source, context);
  return result === 'stale' ? null : normalized;
}
