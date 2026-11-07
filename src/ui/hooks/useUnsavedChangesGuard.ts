import { useNavigation, usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { showConfirm, showDialog, useDialogStore } from '../dialog/dialogStore';

export interface UnsavedChangesGuardOptions {
  /** Whether removing the current route would discard user-authored state. */
  enabled: boolean;
  title?: string;
  message?: string;
  /**
   * While set, leaving is not possible yet (for example, a send is still running). Back shows this
   * explanation with a single OK instead of offering Discard, and the route stays mounted.
   */
  blocked?: { readonly title: string; readonly message: string } | null;
  /** Runs only after the user explicitly confirms the discard. */
  /** Return false or reject to keep the route mounted when external cleanup did not finish. */
  onDiscard?: () => void | boolean | Promise<void | boolean>;
  /** Runs after the confirmed route removal is dispatched. */
  onAfterDiscardNavigation?: () => void;
}

export interface UnsavedChangesGuard {
  /** Run a navigation operation after a successful save/submit without showing the discard UI. */
  navigateWithoutPrompt: (navigate: () => void) => void;
}

/**
 * Protect user-authored route state from every removal path (system gesture, header Back,
 * replace, or parent reset).
 *
 * After an explicit Discard the guard turns itself OFF and only then re-dispatches the exact
 * prevented action. Re-dispatching while still enabled was prevented a second time on Expo SDK 58:
 * Android's native Back reaches the guard through the stack's own pop, whose action carries no
 * "already confirmed" marker, so Discard just opened the same prompt again (0.1.78, Galaxy S25,
 * 2026-11-07: RNScreens logged one prevented dismiss, then a second dialog appeared).
 */
export function useUnsavedChangesGuard({
  enabled,
  title = 'Discard changes?',
  message = 'Your unsaved changes will be lost.',
  blocked = null,
  onDiscard,
  onAfterDiscardNavigation,
}: UnsavedChangesGuardOptions): UnsavedChangesGuard {
  const navigation = useNavigation();
  const bypassNextRemovalRef = useRef(false);
  const confirmationPendingRef = useRef(false);
  const confirmationIdRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // The confirmed action waits here while the guard turns off for the render that releases it.
  const [releasing, setReleasing] = useState(false);
  const releaseActionRef = useRef<Parameters<typeof navigation.dispatch>[0] | null>(null);

  const dismissOwnedConfirmation = useCallback((): void => {
    const id = confirmationIdRef.current;
    confirmationIdRef.current = null;
    confirmationPendingRef.current = false;
    if (id != null) useDialogStore.getState().dismissById(id);
  }, []);

  useEffect(() => {
    // React development Strict Mode runs an immediate setup/cleanup/setup cycle.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bypassNextRemovalRef.current = false;
      dismissOwnedConfirmation();
    };
  }, [dismissOwnedConfirmation]);

  useEffect(() => {
    if (!releasing) return;
    const action = releaseActionRef.current;
    releaseActionRef.current = null;
    if (action && mountedRef.current) {
      navigation.dispatch(action);
      onAfterDiscardNavigation?.();
    }
    // A removal that did not happen (the route was already gone) must not leave the guard off.
    queueMicrotask(() => {
      if (mountedRef.current) setReleasing(false);
    });
  }, [releasing, navigation, onAfterDiscardNavigation]);

  usePreventRemove(enabled && !releasing, ({ data }) => {
    if (bypassNextRemovalRef.current) {
      bypassNextRemovalRef.current = false;
      navigation.dispatch(data.action);
      return;
    }
    // A rapid second Back must not queue a second destructive confirmation behind the first.
    if (confirmationPendingRef.current) return;
    confirmationPendingRef.current = true;
    if (blocked) {
      confirmationIdRef.current = showDialog(blocked.title, blocked.message, [
        {
          text: 'OK',
          onPress: () => {
            confirmationIdRef.current = null;
            confirmationPendingRef.current = false;
          },
        },
      ]);
      return;
    }
    confirmationIdRef.current = showConfirm({
      title,
      message,
      confirmText: 'Discard',
      destructive: true,
      onCancel: () => {
        confirmationIdRef.current = null;
        confirmationPendingRef.current = false;
      },
      onConfirm: () => {
        confirmationIdRef.current = null;
        confirmationPendingRef.current = false;
        if (!mountedRef.current) return;
        void Promise.resolve()
          .then(() => onDiscard?.())
          .then(
            (discarded) => {
              if (discarded !== false && mountedRef.current) {
                // Turn the guard off first; the effect above dispatches once that render lands.
                releaseActionRef.current = data.action;
                setReleasing(true);
              }
            },
            () => {
              // The owner keeps the route and its authored state when cleanup fails.
            },
          );
      },
    });
  });

  const navigateWithoutPrompt = useCallback(
    (navigate: () => void): void => {
      // A save can finish while its discard prompt is open. Remove only this guard's dialog so it
      // cannot remain over the destination; unrelated dialogs keep their place in the queue.
      dismissOwnedConfirmation();
      bypassNextRemovalRef.current = true;
      try {
        navigate();
      } finally {
        // Expo Router dispatches synchronously. Do not leave a stale bypass armed if the requested
        // operation was a no-op (for example, Back on an already-root route).
        queueMicrotask(() => {
          bypassNextRemovalRef.current = false;
        });
      }
    },
    [dismissOwnedConfirmation],
  );

  return { navigateWithoutPrompt };
}
