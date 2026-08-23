import { usePathname, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { resolveChatNavigation } from '@utils';

/**
 * Open a chat thread WITHOUT stacking one thread on another — and without RELOADING the thread
 * you're already reading.
 *
 * The app keeps a single navigation stack with the Messages list at its base; opening a thread
 * pushes ONE screen on top, so Back pops it and returns to the inbox. Two bugs this guards:
 *
 *  1. STACKING — a few paths (notification taps, opening a chat while already reading one) PUSHED
 *     a second thread onto the first, so the stack became [Messages, A, B, …] and Back returned to
 *     the PREVIOUS thread instead of the inbox. Fix: REPLACE when a thread is already open.
 *  2. RELOADING — but a plain `router.replace('/chat/<same-guid>')` mounts a FRESH screen instance,
 *     so tapping a notification for the thread ALREADY on screen tore it down and rebuilt it
 *     (spinner, re-scroll, lost draft). Fix: when the target IS the thread already open, do NOTHING.
 *
 * The decision (push / replace / none) is the pure, node-tested `resolveChatNavigation`. Takes a
 * full `/chat/…` path (callers append their own `?focus=`/`?share=` query as needed).
 *
 * The returned callback is STABLE (it depends only on the router singleton). That matters far more
 * than it looks: `usePathname()` is a `useSyncExternalStore` subscription, so depending on it
 * directly changed this callback's identity on EVERY navigation — and callers hang "run once"
 * effects off it. The connected layout's notification-tap drain is one of them, so every route
 * change re-read `getInitialNotification()`, which on Android echoes the launch intent forever
 * (see `drainNotificationTap`) and threw the user straight back into the chat they had just pressed
 * Back out of. The same instability tore down and re-added the foreground-notification subscription
 * and the AppState listener on every navigation, and defeated `React.memo` on every conversation
 * tile. Reading the path from a ref written during render keeps the decision current without
 * putting the path in the dependency list.
 */
export function useChatNavigator(): (path: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  return useCallback(
    (path: string): void => {
      // Read at CALL time — the ref holds the path from the latest render, so the push/replace/none
      // rules see exactly what they saw before, without re-creating this callback per navigation.
      const action = resolveChatNavigation(pathnameRef.current, path);
      if (action === 'push') router.push(path);
      else if (action === 'replace') router.replace(path);
      // 'none' → already on this exact thread; do nothing (no reload).
    },
    [router],
  );
}
