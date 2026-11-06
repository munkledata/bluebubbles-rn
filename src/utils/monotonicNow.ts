/**
 * The clock for durations the user must not be able to move, such as App Lock's grace period.
 * `performance.now()` counts from process start and does not jump when the wall clock is set back
 * (a time-zone change or a manual clock change must not extend the grace period). Date.now() is
 * only the fallback where `performance` is missing, such as some test environments.
 */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
