import { useRouter } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { logger } from '@core/secure';
import { useShareIntentStore } from '@state/shareIntentStore';
import { LoadErrorBoundary } from './LoadErrorBoundary';

/**
 * Dormant navigation half of the former inbound-share flow. IPC-01 deliberately leaves this
 * UNMOUNTED: `expo-share-intent@8.0.1` can perform unbounded native provider I/O before JavaScript
 * sees an event, so the release manifest contains no inbound SEND declarations and no native share
 * package is linked. Keeping this platform-free consumer makes a future owned, bounded intake
 * easier to reconnect without preserving the unsafe native dependency.
 *
 * When safely re-enabled, an owned bounded source can stage the store; this consumer then routes to
 * the composer, which stages the content and clears the store. It belongs inside the connected app,
 * where the navigator is ready. A future owned intake can extend this consumer only after its
 * bounded native delivery and target identity are proven. The ref guards against a double-route
 * while the pending flag is still set (before the target screen clears it).
 */
function ShareIntentNavigatorInner(): null {
  const router = useRouter();
  const pending = useShareIntentStore((s) => s.files.length > 0 || s.text !== null);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (!pending) {
      // The target screen consumed + cleared the store — re-arm for the next share.
      navigatedRef.current = false;
      return;
    }
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    logger.debug('[share] opening new-chat for pending share');
    router.push('/new-chat');
  }, [pending, router]);

  return null;
}

/** Future connected-layout consumer; intentionally unmounted while IPC-01 is contained. */
export function ShareIntentNavigator(): React.JSX.Element {
  return (
    <LoadErrorBoundary fallback={null} onError={() => logger.warn('[share] navigator failed')}>
      <ShareIntentNavigatorInner />
    </LoadErrorBoundary>
  );
}
