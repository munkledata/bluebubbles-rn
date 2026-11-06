import { AsyncLocalStorage } from 'node:async_hooks';
import { DbTransactionNestedError, setTransactionNestingDetector } from '@db/transaction';

interface OwnerFrame {
  active: boolean;
  parent: OwnerFrame | undefined;
  timers: Array<ReturnType<typeof setTimeout>>;
}

const store = new AsyncLocalStorage<OwnerFrame>();

/** A claim made inside an owner that is still waiting after this long is the owner waiting on itself. */
export const NESTED_CLAIM_GRACE_MS = 1_500;

/**
 * Make a nested `withDbTransaction`/`withDbWriteLock` call reject within {@link NESTED_CLAIM_GRACE_MS}
 * in Node tests instead of hanging on the lock its own caller holds. The marker travels with the
 * async context, so a nested claim is caught however many helpers deep it is made. Each owner run is
 * a frame that goes inactive when its callback settles: a claim started from inside an owner but not
 * awaited by it (a queued follow-up) sees the frame settle and is never rejected. A legitimate
 * concurrent caller never ran inside the owner's callback and is unaffected either way.
 */
export function installTransactionNestingDetector(): void {
  setTransactionNestingDetector({
    runInside: async (fn) => {
      const frame: OwnerFrame = { active: true, parent: store.getStore(), timers: [] };
      try {
        return await store.run(frame, fn);
      } finally {
        frame.active = false;
        for (const timer of frame.timers) clearTimeout(timer);
      }
    },
    nestedClaimDeadline: () => {
      let frame = store.getStore();
      while (frame && !frame.active) frame = frame.parent;
      if (!frame) return null;
      const owner = frame;
      const deadline = new Promise<never>((_, reject) => {
        owner.timers.push(
          setTimeout(() => {
            if (owner.active) reject(new DbTransactionNestedError());
          }, NESTED_CLAIM_GRACE_MS),
        );
      });
      // The race in claimWriteLock usually settles through the lock; never let the losing deadline
      // surface as an unhandled rejection.
      void deadline.catch(() => undefined);
      return deadline;
    },
  });
}
