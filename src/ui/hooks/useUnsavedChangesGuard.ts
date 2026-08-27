import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef } from 'react';
import { showConfirm, useDialogStore } from '../dialog/dialogStore';

export interface UnsavedChangesGuardOptions {
  /** Whether removing the current route would discard user-authored state. */
  enabled: boolean;
  title?: string;
  message?: string;
  /** Runs only after the user explicitly confirms the discard. */
  onDiscard?: () => void;
}

export interface UnsavedChangesGuard {
  /** Run a navigation operation after a successful save/submit without showing the discard UI. */
  navigateWithoutPrompt: (navigate: () => void) => void;
}

/**
 * Protect user-authored route state from every removal path (system gesture, header Back,
 * replace, or parent reset). Re-dispatching the exact prevented action is Expo Router's supported
 * continuation path; the action carries its visited-route marker so it is not prevented twice.
 */
export function useUnsavedChangesGuard({
  enabled,
  title = 'Discard changes?',
  message = 'Your unsaved changes will be lost.',
  onDiscard,
}: UnsavedChangesGuardOptions): UnsavedChangesGuard {
  const navigation = useNavigation();
  const bypassNextRemovalRef = useRef(false);
  const confirmationPendingRef = useRef(false);
  const confirmationIdRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

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

  usePreventRemove(enabled, ({ data }) => {
    if (bypassNextRemovalRef.current) {
      bypassNextRemovalRef.current = false;
      navigation.dispatch(data.action);
      return;
    }
    // A rapid second Back must not queue a second destructive confirmation behind the first.
    if (confirmationPendingRef.current) return;
    confirmationPendingRef.current = true;
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
        onDiscard?.();
        navigation.dispatch(data.action);
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
