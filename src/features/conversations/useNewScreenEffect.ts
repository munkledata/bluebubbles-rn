import { useEffect, useRef, useState } from 'react';
import { screenEffectOf, type ScreenEffect } from '@core/effects';
import type { EnrichedMessage } from './useMessages';

/** Flip to false to disable the JS-particle full-screen effects (e.g. on low-end devices). */
export const SCREEN_EFFECTS_ENABLED = true;

/**
 * Returns a full-screen effect to play when a NEW message carrying one arrives
 * while the chat is open (history is baselined on open so it never replays).
 * Takes the chat's messages (chat screen owns the single subscription).
 */
export function useNewScreenEffect(
  chatGuid: string,
  messages: EnrichedMessage[],
): { effect: ScreenEffect | null; clear: () => void } {
  const newest = messages[0];
  const newestId = newest?.id ?? null;
  const newestStyleId = newest?.expressiveSendStyleId ?? null;
  const lastIdRef = useRef<number | null>(null);
  const [effect, setEffect] = useState<ScreenEffect | null>(null);

  // Re-baseline when the chat changes (defensive: each chat is normally a fresh
  // pushed route, but reset the ref so a reused screen can't suppress effects).
  useEffect(() => {
    lastIdRef.current = null;
  }, [chatGuid]);

  useEffect(() => {
    if (!SCREEN_EFFECTS_ENABLED || newestId == null) return;
    // Baseline on first run so existing history doesn't replay on open.
    if (lastIdRef.current === null) {
      lastIdRef.current = newestId;
      return;
    }
    if (newestId > lastIdRef.current) {
      lastIdRef.current = newestId;
      const e = screenEffectOf(newestStyleId);
      if (e) setEffect(e);
    }
  }, [newestId, newestStyleId]);

  return { effect, clear: () => setEffect(null) };
}
