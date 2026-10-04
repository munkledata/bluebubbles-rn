import { requireOptionalNativeModule } from 'expo';

interface Subscription {
  remove(): void;
}

interface NativeTaskManagerExecution {
  retainTaskExecution(eventId: string): string | null;
  releaseTaskExecution(eventId: string, leaseToken: string): boolean;
}

interface NativeBackgroundExecution {
  addListener(
    name: 'onExecutionCancelled',
    listener: (event: { executionId?: unknown }) => void,
  ): Subscription;
  retainExecution(
    executionId: string,
    eventId: string,
  ): { leaseToken: string; cancelled: boolean } | null;
  releaseExecution(executionId: string, eventId: string, leaseToken: string): boolean;
}

export interface BackgroundTaskExecution {
  readonly signal: AbortSignal;
  /** Releases native ownership only after the callback and its actual continuation settle. */
  release(): boolean;
}

const isExecutionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length === 36 &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);

/** Synchronous admission: subscribe before the native cancellation-state claim, before any await. */
export function retainBackgroundTaskExecution(
  eventId: unknown,
  executionId: unknown,
): BackgroundTaskExecution | null {
  if (!isExecutionId(eventId) || !isExecutionId(executionId)) return null;
  const taskManager = requireOptionalNativeModule<NativeTaskManagerExecution>('ExpoTaskManager');
  const background = requireOptionalNativeModule<NativeBackgroundExecution>('ExpoBackgroundTask');
  if (
    !taskManager?.retainTaskExecution ||
    !taskManager.releaseTaskExecution ||
    !background?.retainExecution ||
    !background.releaseExecution ||
    !background.addListener
  )
    return null;

  const controller = new AbortController();
  let subscription: Subscription | undefined;
  let taskLease: string | null = null;
  let backgroundLease: string | null = null;
  let ownershipTransferred = false;
  let released = false;
  const cancel = (): void => {
    if (!released && !controller.signal.aborted) {
      controller.abort(new Error('Background execution cancelled'));
    }
  };
  const release = (): boolean => {
    // A partial bridge failure keeps the unreleased exact lease available for a later retry.
    try {
      if (backgroundLease !== null) {
        if (!background.releaseExecution(executionId, eventId, backgroundLease)) return false;
        backgroundLease = null;
      }
      if (taskLease !== null) {
        if (!taskManager.releaseTaskExecution(eventId, taskLease)) return false;
        taskLease = null;
      }
      released = true;
      subscription?.remove();
      subscription = undefined;
      return true;
    } catch {
      return false;
    }
  };

  try {
    subscription = background.addListener('onExecutionCancelled', (event) => {
      if (event?.executionId === executionId) cancel();
    });
    taskLease = taskManager.retainTaskExecution(eventId);
    if (!isExecutionId(taskLease)) return null;
    const claim = background.retainExecution(executionId, eventId);
    if (claim && isExecutionId(claim.leaseToken)) backgroundLease = claim.leaseToken;
    if (
      !claim ||
      backgroundLease === null ||
      typeof claim.cancelled !== 'boolean' ||
      claim.cancelled
    )
      cancel();
    // Failed admission still hands its first lease to the caller's cleanup owner.
    ownershipTransferred = true;
    return { signal: controller.signal, release };
  } catch {
    if (isExecutionId(taskLease)) {
      cancel();
      ownershipTransferred = true;
      return { signal: controller.signal, release };
    }
    return null;
  } finally {
    if (!ownershipTransferred) release();
  }
}
