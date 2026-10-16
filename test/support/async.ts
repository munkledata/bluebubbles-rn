/**
 * Shared async helpers for tests (review M007), instead of a private copy in each file.
 *
 * Prefer `waitForCondition` when a test waits for something to happen: a fixed number of
 * microtask rounds silently breaks when the code under test gains or loses an `await` (M008).
 */

/** One macrotask turn: every queued microtask and any due setImmediate callback runs first. */
export function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Let `count` rounds of already-queued promise callbacks run. */
export async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** Wait one event-loop turn at a time until `condition` holds, failing after `maxTurns`. */
export async function waitForCondition(
  condition: () => boolean,
  label: string,
  maxTurns = 20,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await nextEventLoopTurn();
  }
  if (!condition()) throw new Error(`${label} did not happen within ${maxTurns} event-loop turns`);
}

/**
 * Like waitForCondition, but one microtask at a time, for a test that must act before any timer
 * or I/O callback can run. It fails loudly instead of falling through when the condition never
 * holds, so a changed number of awaits cannot make a test pass without reaching its setup.
 */
export async function waitForMicrotaskCondition(
  condition: () => boolean,
  label: string,
  maxRounds = 500,
): Promise<void> {
  for (let round = 0; round < maxRounds && !condition(); round += 1) await Promise.resolve();
  if (!condition()) throw new Error(`${label} did not happen within ${maxRounds} microtask rounds`);
}
