/** Controls used by foreground boot to keep a retired async read from committing stale state. */
export interface HydrationOptions {
  /** Checked after async reads and immediately before any store/runtime side effect. */
  readonly shouldCommit?: () => boolean;
  /** Best-effort observation; ordinary callers may omit it to retain legacy fallback behavior. */
  readonly onError?: (error: unknown) => void;
}

/** A throwing ownership check is treated as stale (fail closed). */
export function canCommitHydration(options?: HydrationOptions): boolean {
  try {
    return options?.shouldCommit?.() ?? true;
  } catch {
    return false;
  }
}

/** Report only failures that still belong to the active hydration run. */
export function reportHydrationError(options: HydrationOptions | undefined, error: unknown): void {
  if (!canCommitHydration(options)) return;
  try {
    options?.onError?.(error);
  } catch {
    // Observability is best-effort and must not turn a guarded store fallback into a rejection.
  }
}
