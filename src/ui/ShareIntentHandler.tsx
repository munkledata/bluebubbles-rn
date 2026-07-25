import { useRouter } from 'expo-router';
import { ShareIntentModule } from 'expo-share-intent';
import React, { useEffect, useRef } from 'react';
import { logger } from '@core/secure';
import { captureShareIntent } from '@/services/share';
import { getLaunchShortcutId } from '@/services/shortcuts/shareShortcuts';
import { useShareIntentStore } from '@state/shareIntentStore';
import { LoadErrorBoundary } from './LoadErrorBoundary';
import { useChatNavigator } from './useChatNavigator';

/**
 * CAPTURE side — mounted ONCE at the app ROOT, inside `<ShareIntentProvider>`, ABOVE the app-lock /
 * auth gate. It stashes an incoming Android share into {@link useShareIntentStore} the instant it
 * arrives, no matter which screen is showing (locked, welcome, or the connected app). It
 * deliberately does NOT navigate: on a cold start the connected-app navigator isn't mounted yet, so
 * pushing a route here would race navigation and drop the share. {@link ShareIntentNavigator} opens
 * new-chat once the app is actually ready. Splitting capture (must always be mounted) from
 * navigation (needs the connected navigator) is what makes a share reliable when the app was killed
 * or locked at share time.
 *
 * WHY WE SUBSCRIBE TO THE RAW NATIVE MODULE instead of reading `useShareIntentContext()`:
 *
 *  1. The library's parser DROPS `contentUri`, which is the only source we can reliably read for a
 *     document (see `services/share/shareIntentPayload.ts`). The raw payload is a strict superset,
 *     so there is nothing to gain from the parsed view.
 *  2. It swallows its own failures. A native `onError` (e.g. "empty uri for file sharing") and a
 *     parser throw both land in a context `error` field that this component never read — so a
 *     failed share produced NO attachment, NO message, and NO log line. That silence is the single
 *     hardest part of diagnosing a broken share; both channels are now logged.
 *
 * `<ShareIntentProvider>` stays mounted in `app/_layout.tsx` — it drives the cold-start/AppState
 * pumping — we simply no longer read its parsed state. Emitters accept multiple listeners, and
 * `getShareIntent` nulls the native singleton once handled, so the two coexist without
 * double-capturing.
 */
function ShareIntentCaptureInner(): null {
  useEffect(() => {
    // Null pre-rebuild and under Jest (`requireOptionalNativeModule`).
    const mod = ShareIntentModule;
    if (!mod) {
      logger.debug('[share] native share module unavailable — capture disabled');
      return;
    }

    const onChange = mod.addListener('onChange', (event: unknown) => {
      void captureShareIntent((event as { value?: unknown } | null)?.value);
    });
    // The library reports "empty uri for file sharing", resolver failures, etc. here. Previously
    // unread — this is where a share that "did nothing" now becomes visible in App Logs.
    const onError = mod.addListener('onError', (event: unknown) => {
      logger.error(`[share] native error: ${String((event as { value?: unknown } | null)?.value)}`);
    });

    // Drain a cold-start intent AFTER subscribing, so we can't miss the event we just asked for.
    // Idempotent: the native side nulls the singleton once it has handled it.
    try {
      void (mod.getShareIntent('') as unknown as Promise<void> | void);
    } catch (err) {
      logger.warn(
        `[share] initial drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return () => {
      onChange.remove();
      onError.remove();
    };
  }, []);

  return null;
}

/**
 * Mount ONCE at the app root, INSIDE `<ShareIntentProvider>`. Renders nothing; captures shares into
 * the store. The boundary keeps a JS bundle on a build that hasn't linked the native module yet
 * (pre-rebuild) from crashing at launch — and now LOGS instead of failing silently.
 */
export function ShareIntentCapture(): React.JSX.Element {
  return (
    <LoadErrorBoundary
      fallback={null}
      onError={() => logger.warn('[share] capture failed (native module not linked?)')}
    >
      <ShareIntentCaptureInner />
    </LoadErrorBoundary>
  );
}

/**
 * NAVIGATION side — mounted inside the connected `(app)` layout. Watches the store; when a share is
 * pending (staged by {@link ShareIntentCapture}) it routes to the composer, which stages the content
 * and clears the store. Because this component only mounts once the user is inside the connected app,
 * the navigator is guaranteed ready — so a share that arrived while locked / on a cold start opens
 * the moment the app becomes usable. If the share came from a Direct Share target (the priority row),
 * `getLaunchShortcutId()` tells us WHICH chat was tapped, so we open that conversation with the photo
 * staged instead of the new-message picker. The ref guards against a double-route while the pending
 * flag is still set (before the target screen clears it).
 */
function ShareIntentNavigatorInner(): null {
  const router = useRouter();
  const openChat = useChatNavigator();
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
    const chatGuid = getLaunchShortcutId();
    if (chatGuid) {
      // Direct Share tap → open that exact chat; `share=1` tells it to consume the staged share.
      // Via useChatNavigator so it never stacks on an already-open thread.
      logger.debug('[share] direct-share → open chat');
      openChat(`/chat/${encodeURIComponent(chatGuid)}?share=1`);
    } else {
      logger.debug('[share] opening new-chat for pending share');
      router.push('/new-chat');
    }
  }, [pending, router, openChat]);

  return null;
}

/** Mount ONCE in the connected-app layout. Renders nothing; opens new-chat for a pending share. */
export function ShareIntentNavigator(): React.JSX.Element {
  return (
    <LoadErrorBoundary fallback={null} onError={() => logger.warn('[share] navigator failed')}>
      <ShareIntentNavigatorInner />
    </LoadErrorBoundary>
  );
}
