import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { AccessibilityInfo, type EmitterSubscription } from 'react-native';

export type ReduceMotionPreference = boolean | null;
export type ReduceMotionChangeHandler = (enabled: boolean) => void;

type PreferenceListener = () => void;

const listeners = new Set<PreferenceListener>();

let snapshot: ReduceMotionPreference = null;
let ownerGeneration = 0;
let nativeSubscription: EmitterSubscription | null = null;

function getSnapshot(): ReduceMotionPreference {
  return snapshot;
}

function publish(next: boolean, generation: number): void {
  if (generation !== ownerGeneration || listeners.size === 0 || snapshot === next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function startNativeOwner(): void {
  const generation = ++ownerGeneration;
  let receivedPreferenceEvent = false;
  const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
    receivedPreferenceEvent = true;
    publish(enabled, generation);
  });

  // A synchronous native event may cause every subscriber to leave before addEventListener
  // returns. Do not retain that abandoned subscription or start its query.
  if (generation !== ownerGeneration || listeners.size === 0) {
    subscription.remove();
    return;
  }
  nativeSubscription = subscription;

  void AccessibilityInfo.isReduceMotionEnabled().then(
    (enabled) => {
      if (!receivedPreferenceEvent) publish(enabled, generation);
    },
    () => {
      // If the native query is unavailable, retain the app's existing animated behavior.
      if (!receivedPreferenceEvent) publish(false, generation);
    },
  );
}

function stopNativeOwner(): void {
  ownerGeneration += 1;
  nativeSubscription?.remove();
  nativeSubscription = null;
  snapshot = null;
}

function subscribe(listener: PreferenceListener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startNativeOwner();

  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) stopNativeOwner();
  };
}

/**
 * Shared render-time Reduce Motion preference.
 *
 * `null` means the current native-owner generation has not resolved yet. The first mounted
 * consumer installs one native listener before querying; later consumers share that owner. The
 * last unmount removes it and resets the next generation to the conservative unknown state.
 */
export function useReduceMotionPreference(): ReduceMotionPreference {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Non-rendering projection for gesture responders and delayed callbacks.
 *
 * Every consumer gets a stable local ref, while all refs share the same native owner. Updates write
 * the ref synchronously before invoking the latest optional change handler, without rerendering a
 * high-cardinality list row. Cleanup resets retained callbacks to the conservative unknown value
 * without reporting teardown as a preference change.
 */
export function useReduceMotionPreferenceRef(
  onPreferenceChange?: ReduceMotionChangeHandler,
): RefObject<ReduceMotionPreference> {
  const preferenceRef = useRef<ReduceMotionPreference>(snapshot);
  const changeHandlerRef = useRef(onPreferenceChange);
  changeHandlerRef.current = onPreferenceChange;

  useEffect(() => {
    const syncPreference = (): void => {
      const next = snapshot;
      if (preferenceRef.current === next) return;
      preferenceRef.current = next;
      if (next !== null) changeHandlerRef.current?.(next);
    };
    const unsubscribe = subscribe(syncPreference);
    syncPreference();

    return () => {
      unsubscribe();
      preferenceRef.current = null;
    };
  }, []);

  return preferenceRef;
}
