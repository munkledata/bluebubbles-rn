import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether a screen reader (TalkBack) is on, kept current while mounted. Until the first answer
 * arrives this reports `false`. A change event always wins over the slower first query, so a stale
 * query result can never undo a newer event.
 */
export function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', (next) => {
      receivedEvent = true;
      if (active) setEnabled(next);
    });
    void AccessibilityInfo.isScreenReaderEnabled().then(
      (next) => {
        if (active && !receivedEvent) setEnabled(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}
