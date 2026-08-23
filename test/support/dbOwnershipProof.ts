import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** A small, observable promise gate for transaction-ordering tests. */
function deferred<T>(): Deferred<T> {
  let isSettled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (isSettled) return;
      isSettled = true;
      resolvePromise(value);
    },
    reject: (reason) => {
      if (isSettled) return;
      isSettled = true;
      rejectPromise(reason);
    },
  };
}

export interface ObservedPromise<T> {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
}

/** Keeps the promise's original result while exposing whether it has settled yet. */
export function observePromise<T>(promise: Promise<T>): ObservedPromise<T> {
  let isSettled = false;
  const observed = promise.then(
    (value) => {
      isSettled = true;
      return value;
    },
    (error: unknown) => {
      isSettled = true;
      throw error;
    },
  );
  // Tests often need to check the pending state before awaiting the result. Keep that short window
  // from becoming an unhandled rejection while preserving the same rejected promise for assertions.
  void observed.catch(() => undefined);
  return {
    promise: observed,
    settled: () => isSettled,
  };
}

export type RollingBackDbNeighbourOutcome =
  | { readonly status: 'rolled-back'; readonly error: unknown }
  | { readonly status: 'unexpected-commit' };

export interface RollingBackDbNeighbour {
  /** Resolves after the neighbour's setup has run inside its transaction. */
  readonly entered: Promise<void>;
  /** Always resolves, so cleanup cannot create an unhandled rejection. */
  readonly outcome: Promise<RollingBackDbNeighbourOutcome>;
  /** Allows the held transaction to throw and roll back. Safe to call repeatedly. */
  readonly release: () => void;
  /** Releases and drains the neighbour. Safe to call repeatedly and from `finally`. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Claims the process-wide DB queue immediately, runs `insideTransaction`, then waits until released
 * and deliberately rolls back. Ownership tests can invoke the writer under test while this
 * neighbour is held to prove it queues instead of silently joining the open transaction.
 */
export function holdRollingBackDbNeighbour(
  db: AppDatabase,
  insideTransaction: () => void | Promise<void>,
  rollbackMessage = 'proof neighbour rollback',
): RollingBackDbNeighbour {
  const entered = deferred<void>();
  const release = deferred<void>();
  const rollbackError = new Error(rollbackMessage);
  // A caller may only need `cleanup()` after an early setup/BEGIN failure. Observe the gate here so
  // that rejecting it before the caller awaits `entered` is still safe.
  void entered.promise.catch(() => undefined);

  const transaction = withDbTransaction(db, async () => {
    try {
      await insideTransaction();
      entered.resolve(undefined);
    } catch (error) {
      entered.reject(error);
      throw error;
    }
    await release.promise;
    throw rollbackError;
  });
  const outcome = transaction.then<RollingBackDbNeighbourOutcome, RollingBackDbNeighbourOutcome>(
    () => {
      entered.reject(new Error('proof neighbour committed before entering'));
      return { status: 'unexpected-commit' };
    },
    (error: unknown) => {
      // BEGIN can reject before the transaction callback gets a chance to settle this gate.
      entered.reject(error);
      return { status: 'rolled-back', error };
    },
  );

  return {
    entered: entered.promise,
    outcome,
    release: () => release.resolve(undefined),
    cleanup: async () => {
      release.resolve(undefined);
      await outcome;
    },
  };
}
