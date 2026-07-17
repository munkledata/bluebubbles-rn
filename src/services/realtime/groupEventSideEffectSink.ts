import { resolveMessageChatGuid } from '@core/models';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';
import { isChatBackgroundChangeEvent } from '@utils';

/**
 * Decorates an inner EventSink: after the DB write, detects an incoming chat-background
 * change/removal group event (itemType 3, groupActionType 4 = changed, 6 = removed) and triggers a
 * wallpaper refetch via the injected `refetchBackground` (bound to `ensureSyncedBackground(http,
 * db, guid)` in the composition root).
 *
 * Why a thin injected sink, not DbEventSink: refetching is a NETWORK + DB side effect, and per the
 * EventRouter rule (AGENTS.md) DB-write logic lives in `DbEventSink` while connection/UI/network
 * side-effects live in an injected sink like `TypingEventSink`/`ServerUrlEventSink`. Injecting the
 * refetch keeps this pure/React-free and unit-testable.
 *
 * The group-event message itself does NOT carry the new background channel, but
 * `ensureSyncedBackground` re-fetches the chat metadata + hits the background endpoint directly, so
 * it picks up the new wallpaper regardless and change-detects internally → calling it here (or on a
 * redelivered/updated event) is safe and idempotent.
 *
 * Delegates EVERY event to the inner sink FIRST (the DB is the source of truth and must always be
 * written), then fires the refetch only for the rare bg-change event. Best-effort: a refetch
 * failure is logged and swallowed so it never throws into the router (the wallpaper simply
 * re-syncs on the next chat open).
 */
export class GroupEventSideEffectSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly refetchBackground: (chatGuid: string) => void | Promise<void>,
  ) {}

  async onEvent(event: NormalizedEvent, source: EventSource): Promise<void> {
    // DB first (source of truth) so the group-event system line is persisted before the network hit.
    await this.inner.onEvent(event, source);

    if (event.type !== 'new-message' && event.type !== 'updated-message') return;
    if (!isChatBackgroundChangeEvent(event.message)) return;
    const chatGuid = resolveMessageChatGuid(event.message);
    if (!chatGuid) return;

    try {
      await this.refetchBackground(chatGuid);
    } catch (e) {
      logger.warn('[groupEvent] chat-background refetch failed', e);
    }
  }
}
