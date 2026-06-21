import { useEffect, useState } from 'react';
import { ruleSmartReplyProvider } from '@core/smartReply';
import { useSmartReplyStore } from '@state/smartReplyStore';
import type { EnrichedMessage } from './useMessages';

/**
 * Suggested replies for the chat: empty unless the feature is enabled AND the
 * newest message is an inbound, non-retracted text. Recomputes when that last
 * inbound message changes. Takes the (already-subscribed) messages so the chat
 * screen owns a single useMessages subscription.
 */
export function useSmartReplies(messages: EnrichedMessage[]): string[] {
  const enabled = useSmartReplyStore((s) => s.enabled);
  const last = messages[0]; // newest-first
  const lastInboundText =
    last && last.isFromMe === 0 && !last.dateRetracted ? (last.text ?? '') : null;

  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || !lastInboundText) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const history = messages
      .slice(0, 6)
      .reverse()
      .map((m) => ({ text: m.text ?? '', isFromMe: m.isFromMe === 1 }));
    void ruleSmartReplyProvider.suggest(history).then((s) => {
      if (alive) setSuggestions(s);
    });
    return () => {
      alive = false;
    };
    // Recompute only when enablement or the last inbound message text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, lastInboundText]);

  return suggestions;
}
