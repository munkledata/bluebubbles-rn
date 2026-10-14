import { useEffect, useState } from 'react';

/**
 * True once `key` has stayed the same non-null value for `delayMs`; false while `key` is null or
 * has just changed. Use it to show a progress indicator only when work is slow, so quick work does
 * not flash a spinner. Give each piece of work its own key so a new one starts hidden again.
 */
export function useShownAfterDelay(key: string | null, delayMs: number): boolean {
  const [slowKey, setSlowKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => setSlowKey(key), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, key]);
  return key !== null && slowKey === key;
}
