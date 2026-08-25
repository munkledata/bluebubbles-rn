import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import type { TransportServerState } from '@state/transportHealthStore';

export type ReachabilityProbe = (signal: AbortSignal) => Promise<unknown>;

export interface ReachabilityWatchCallbacks {
  /** Every observed change, including the first reachable/unreachable/error result. */
  readonly onStateChange: (state: Exclude<TransportServerState, 'unknown'>) => void;
  /** Only an observed unreachable/error → reachable edge; used for catch-up sync. */
  readonly onRecovered: () => void;
}

interface ActiveReachabilityWatch {
  readonly generation: number;
  readonly probe: ReachabilityProbe;
  readonly callbacks: ReachabilityWatchCallbacks;
  readonly intervalMs: number;
  state: TransportServerState;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerunRequested: boolean;
}

let watchGeneration = 0;
let activeWatch: ActiveReachabilityWatch | null = null;

/** A transport/timeout means unreachable; an HTTP/auth/schema response is a usable-path error. */
export function classifyReachabilityFailure(error: unknown): 'unreachable' | 'error' {
  if (!(error instanceof ApiError)) return 'unreachable';
  return error.kind === 'no_connection' || error.kind === 'timeout' ? 'unreachable' : 'error';
}

function ownsWatch(watch: ActiveReachabilityWatch): boolean {
  return activeWatch === watch && watch.generation === watchGeneration;
}

function callObserver(
  watch: ActiveReachabilityWatch,
  callback: () => void,
  surface: 'state' | 'recovery',
): void {
  if (!ownsWatch(watch)) return;
  try {
    callback();
  } catch (error) {
    logger.warn(`[reachability] ${surface} observer failed`, {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

function publish(
  watch: ActiveReachabilityWatch,
  next: Exclude<TransportServerState, 'unknown'>,
): void {
  if (!ownsWatch(watch) || watch.state === next) return;
  const previous = watch.state;
  watch.state = next;
  callObserver(watch, () => watch.callbacks.onStateChange(next), 'state');
  if (next === 'reachable' && (previous === 'unreachable' || previous === 'error')) {
    logger.info('[reachability] server reachable again — resuming sync');
    callObserver(watch, watch.callbacks.onRecovered, 'recovery');
  }
}

function scheduleNext(watch: ActiveReachabilityWatch): void {
  if (!ownsWatch(watch)) return;
  watch.timer = setTimeout(() => {
    watch.timer = null;
    runProbe(watch);
  }, watch.intervalMs);
}

function runProbe(watch: ActiveReachabilityWatch): void {
  if (!ownsWatch(watch)) return;
  if (watch.running) {
    watch.rerunRequested = true;
    return;
  }
  if (watch.timer != null) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  watch.running = true;
  watch.rerunRequested = false;
  const controller = new AbortController();
  watch.controller = controller;

  let probeResult: Promise<unknown>;
  try {
    probeResult = watch.probe(controller.signal);
  } catch (error) {
    probeResult = Promise.reject(error);
  }

  void probeResult
    .then(() => publish(watch, 'reachable'))
    .catch((error: unknown) => {
      if (ownsWatch(watch)) publish(watch, classifyReachabilityFailure(error));
    })
    .finally(() => {
      if (!ownsWatch(watch)) return;
      watch.running = false;
      watch.controller = null;
      if (watch.rerunRequested) {
        watch.rerunRequested = false;
        runProbe(watch);
      } else {
        scheduleNext(watch);
      }
    });
}

/**
 * Start one immediate, serialized server probe followed by a foreground-only interval. The
 * callback generation and AbortSignal keep a stopped/account-A watch from publishing into B.
 */
export function startReachabilityWatch(
  probe: ReachabilityProbe,
  callbacks: ReachabilityWatchCallbacks,
  intervalMs = 30_000,
): void {
  stopReachabilityWatch();
  const watch: ActiveReachabilityWatch = {
    generation: watchGeneration,
    probe,
    callbacks,
    intervalMs,
    state: 'unknown',
    controller: null,
    timer: null,
    running: false,
    rerunRequested: false,
  };
  activeWatch = watch;
  runProbe(watch);
}

/** Coalesce a native network-recovery signal into the current foreground server probe. */
export function probeReachabilityNow(): void {
  if (activeWatch) runProbe(activeWatch);
}

/** Stop timers, abort the active HTTP request, and reject every late continuation. */
export function stopReachabilityWatch(): void {
  watchGeneration += 1;
  const watch = activeWatch;
  activeWatch = null;
  if (!watch) return;
  if (watch.timer != null) clearTimeout(watch.timer);
  watch.timer = null;
  watch.controller?.abort();
  watch.controller = null;
  watch.running = false;
  watch.rerunRequested = false;
}
