import { useRouter } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import React, { useEffect } from 'react';
import { useShareIntentStore } from '@state/shareIntentStore';
import { LoadErrorBoundary } from './LoadErrorBoundary';

/** A bare local file path → a usable file:// uri (expo-share-intent may return either form). */
function toUri(path: string): string {
  return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}

/**
 * Reads the Android share intent. When the app is opened via the system share sheet (e.g. sharing a
 * PDF from Downloads or a photo from the gallery), it stages the shared text/files in
 * {@link useShareIntentStore} and routes to the new-chat creator to pick a recipient and send.
 * Wrapped by {@link ShareIntentHandler} in a LoadErrorBoundary so a JS bundle on a build that hasn't
 * linked the native module yet (pre-rebuild) degrades to a no-op instead of crashing at launch.
 */
function ShareIntentHandlerInner(): null {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

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
      useShareIntentStore.getState().set({ text, files });
      router.push('/new-chat');
    }
    resetShareIntent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent]);

  return null;
}

/** Mount once in the connected-app layout. Renders nothing; drives share-intent capture. */
export function ShareIntentHandler(): React.JSX.Element {
  return (
    <LoadErrorBoundary fallback={null}>
      <ShareIntentHandlerInner />
    </LoadErrorBoundary>
  );
}
