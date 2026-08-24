import { logger } from '@core/secure';

let timer: ReturnType<typeof setInterval> | null = null;
let reachable = true;
/** Invalidates promise continuations created by every stopped or replaced watch. */
let watchGeneration = 0;

/**
 * Poll a lightweight `probe` on an interval; on a down→up transition (the server becomes reachable
 * again after a connectivity drop) invoke `onReachable`. This is the app's auto-resume hook — the
 * socket reconnect handles the happy path, but for users who lose connectivity often (and whose
 * websocket frequently can't re-establish) this HTTP-level watch is what actually brings sync back
 * without a manual pull-to-refresh. Deps are injected so the module stays React-free + testable.
 */
export function startReachabilityWatch(
  probe: () => Promise<unknown>,
  onReachable: () => void,
  intervalMs = 30_000,
): void {
  stopReachabilityWatch();
  const generation = watchGeneration;
  reachable = true; // assume up at start; only resume on an observed down→up edge
  timer = setInterval(() => {
    void probe()
      .then(() => {
        if (generation !== watchGeneration) return;
        if (!reachable) {
          reachable = true;
          logger.info('[reachability] server reachable again — resuming sync');
          onReachable();
        }
      })
      .catch(() => {
        if (generation !== watchGeneration) return;
        reachable = false;
      });
  }, intervalMs);
}

export function stopReachabilityWatch(): void {
  watchGeneration += 1;
  if (timer) clearInterval(timer);
  timer = null;
}
