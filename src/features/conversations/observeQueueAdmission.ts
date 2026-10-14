import { logger } from '@core/secure';

/**
 * Resolve at the DB queue handoff rather than at the much later network response. A rejection
 * before that callback means the caller still owns the only authored copy and must retain it.
 */
export function observeQueueAdmission(
  start: (onQueued: () => void) => Promise<unknown>,
  onQueued: () => void,
  onRejectedBeforeQueue: (error: unknown) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let queued = false;
    const markQueued = (): void => {
      if (queued) return;
      queued = true;
      try {
        onQueued();
      } catch (error) {
        logger.warn('[chat] queue handoff observer failed', error);
      }
      resolve(true);
    };

    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(start(markQueued));
    } catch (error) {
      onRejectedBeforeQueue(error);
      resolve(false);
      return;
    }
    void operation.then(
      () => {
        if (!queued) resolve(false);
      },
      (error: unknown) => {
        if (!queued) {
          onRejectedBeforeQueue(error);
          resolve(false);
        }
        // After markQueued, the bubble + retry queue are the user-visible owner. The service logs
        // and reconciles normal transport failures; account retirement is intentionally silent.
      },
    );
  });
}
