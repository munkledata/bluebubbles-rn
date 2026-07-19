import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import React, { useEffect, useRef } from 'react';
import { logger } from '@core/secure';
import { getLaunchShortcutId } from '@/services/shortcuts/shareShortcuts';
import { useShareIntentStore } from '@state/shareIntentStore';
import { LoadErrorBoundary } from './LoadErrorBoundary';

/** A bare local file path → a usable file:// uri (expo-share-intent may return either form). */
function toUri(path: string): string {
  return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}

/**
 * CAPTURE side — mounted ONCE at the app ROOT, inside `<ShareIntentProvider>`, ABOVE the app-lock /
 * auth gate. It reads the incoming Android share intent from the provider context and stashes it
 * into {@link useShareIntentStore} the instant it arrives, no matter which screen is showing
 * (locked, welcome, or the connected app). It deliberately does NOT navigate: on a cold start the
 * connected-app navigator isn't mounted yet, so pushing a route here would race navigation and drop
 * the share. {@link ShareIntentNavigator} opens new-chat once the app is actually ready. Splitting
 * capture (must always be mounted) from navigation (needs the connected navigator) is what makes a
 * share reliable when the app was killed or locked at share time.
 */
function ShareIntentCaptureInner(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  useEffect(() => {
    if (!hasShareIntent) return;
    const files = (shareIntent.files ?? []).map((f) => ({
      uri: toUri(f.path),
      name: f.fileName,
      mimeType: f.mimeType,
      size: f.size ?? 0,
    }));
    // A shared web URL comes through as `webUrl`; plain text as `text`.
    const text = shareIntent.webUrl ?? shareIntent.text ?? null;
    if (text || files.length > 0) {
      logger.debug(`[share] captured ${files.length} file(s)${text ? ' + text' : ''}`);
      useShareIntentStore.getState().set({ text, files });
    }
    // Clear the NATIVE intent (not our store) so the same share can't re-fire on the next
    // foreground. Our store keeps the payload until new-chat consumes it.
    resetShareIntent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent]);

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
      logger.debug('[share] direct-share → open chat');
      router.push(`/chat/${encodeURIComponent(chatGuid)}?share=1`);
    } else {
      logger.debug('[share] opening new-chat for pending share');
      router.push('/new-chat');
    }
  }, [pending, router]);

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
