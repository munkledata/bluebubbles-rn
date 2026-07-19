import { usePathname, useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * Open a chat thread WITHOUT stacking one thread on top of another.
 *
 * The app keeps a single navigation stack with the Messages list at its base; opening a
 * thread pushes ONE screen on top, so Back pops it and returns to the inbox. The bug: a few
 * paths (notification taps, and opening a chat while already reading one) PUSHED a second
 * thread onto the first, so the stack became [Messages, A, B, …] and Back returned to the
 * PREVIOUS thread instead of the inbox.
 *
 * Every "open a chat" now routes through this one rule: if a thread is already the current
 * screen, REPLACE it; otherwise PUSH. The stack is then always [Messages, thread], so Back
 * from any thread lands on the Messages list.
 *
 * Takes a full `/chat/…` path (callers append their own `?focus=`/`?share=` query as needed).
 */
export function useChatNavigator(): (path: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (path: string): void => {
      // Already inside a thread → swap it so Back still returns to Messages, not this thread.
      if (pathname.startsWith('/chat/')) router.replace(path);
      else router.push(path);
    },
    [router, pathname],
  );
}
