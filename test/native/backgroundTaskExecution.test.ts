const eventId = '00000000-0000-0000-0000-000000000001';
const executionId = '00000000-0000-0000-0000-000000000002';
const taskLease = '00000000-0000-0000-0000-000000000003';
const backgroundLease = '00000000-0000-0000-0000-000000000004';
const otherExecution = '00000000-0000-0000-0000-000000000005';
const listeners = new Set<(event: { executionId?: unknown }) => void>();
const taskManager = {
  retainTaskExecution: jest.fn(),
  releaseTaskExecution: jest.fn(),
};
const background = {
  addListener: jest.fn(),
  retainExecution: jest.fn(),
  releaseExecution: jest.fn(),
};
const mockModules: Record<string, unknown> = {
  ExpoTaskManager: taskManager,
  ExpoBackgroundTask: background,
};
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => mockModules[name] ?? null,
}));

// eslint-disable-next-line import/first
import { retainBackgroundTaskExecution } from '../../src/native/backgroundTaskExecution';

function emit(id: unknown): void {
  for (const listener of listeners) listener({ executionId: id });
}

beforeEach(() => {
  jest.resetAllMocks();
  listeners.clear();
  mockModules.ExpoTaskManager = taskManager;
  mockModules.ExpoBackgroundTask = background;
  taskManager.retainTaskExecution.mockReturnValue(taskLease);
  taskManager.releaseTaskExecution.mockReturnValue(true);
  background.retainExecution.mockReturnValue({ leaseToken: backgroundLease, cancelled: false });
  background.releaseExecution.mockReturnValue(true);
  background.addListener.mockImplementation((_name, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
});

it('claims synchronously after subscribing and releases the exact two native leases once', () => {
  const order: string[] = [];
  taskManager.retainTaskExecution.mockImplementation(() => {
    order.push('task');
    return taskLease;
  });
  background.retainExecution.mockImplementation(() => {
    expect(listeners.size).toBe(1);
    order.push('background');
    return { leaseToken: backgroundLease, cancelled: false };
  });
  const execution = retainBackgroundTaskExecution(eventId, executionId)!;
  expect(order).toEqual(['task', 'background']);
  expect(execution.signal.aborted).toBe(false);
  expect(execution.release()).toBe(true);
  expect(execution.release()).toBe(true);
  expect(background.releaseExecution).toHaveBeenCalledTimes(1);
  expect(background.releaseExecution).toHaveBeenCalledWith(executionId, eventId, backgroundLease);
  expect(taskManager.releaseTaskExecution).toHaveBeenCalledTimes(1);
  expect(taskManager.releaseTaskExecution).toHaveBeenCalledWith(eventId, taskLease);
  expect(listeners.size).toBe(0);
});

it('observes cancellation latched before JavaScript registered its listener', () => {
  background.retainExecution.mockReturnValue({ leaseToken: backgroundLease, cancelled: true });
  const execution = retainBackgroundTaskExecution(eventId, executionId)!;
  expect(execution.signal.aborted).toBe(true);
  expect(execution.release()).toBe(true);
});

it('does not lose cancellation between listener registration and the state claim', () => {
  taskManager.retainTaskExecution.mockImplementation(() => {
    emit(executionId);
    return taskLease;
  });
  const execution = retainBackgroundTaskExecution(eventId, executionId)!;
  expect(execution.signal.aborted).toBe(true);
  execution.release();
});

it('ignores stale, malformed, duplicate and already-released cancellation signals', () => {
  const execution = retainBackgroundTaskExecution(eventId, executionId)!;
  emit(otherExecution);
  emit(undefined);
  expect(execution.signal.aborted).toBe(false);
  const onAbort = jest.fn();
  execution.signal.addEventListener('abort', onAbort);
  emit(executionId);
  emit(executionId);
  expect(onAbort).toHaveBeenCalledTimes(1);
  execution.release();
  const next = retainBackgroundTaskExecution(eventId, otherExecution)!;
  emit(executionId);
  expect(next.signal.aborted).toBe(false);
  next.release();
});

it.each(
  [undefined, null, '', 'private-value', 'x'.repeat(10000)].map((value, index) => [index, value]),
)('rejects malformed identity case %s without native work', (_index, id) => {
  expect(retainBackgroundTaskExecution(id, executionId)).toBeNull();
  expect(retainBackgroundTaskExecution(eventId, id)).toBeNull();
  expect(background.addListener).not.toHaveBeenCalled();
  expect(taskManager.retainTaskExecution).not.toHaveBeenCalled();
});

it('fails closed when a candidate lacks the native ownership API', () => {
  mockModules.ExpoBackgroundTask = null;
  expect(retainBackgroundTaskExecution(eventId, executionId)).toBeNull();
  expect(taskManager.retainTaskExecution).not.toHaveBeenCalled();
});

it('cleans the listener if the TaskManager claim fails', () => {
  taskManager.retainTaskExecution.mockReturnValue(null);
  expect(retainBackgroundTaskExecution(eventId, executionId)).toBeNull();
  expect(background.retainExecution).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});

it.each(['missing', 'throws'])(
  'retains an aborted cleanup owner when the second native claim %s',
  (failure) => {
    background.retainExecution.mockImplementation(() => {
      if (failure === 'throws') throw new Error('private native detail');
      return null;
    });
    const execution = retainBackgroundTaskExecution(eventId, executionId)!;
    expect(execution.signal.aborted).toBe(true);
    taskManager.releaseTaskExecution.mockReturnValueOnce(false).mockReturnValue(true);
    expect(execution.release()).toBe(false);
    expect(listeners.size).toBe(1);
    expect(execution.release()).toBe(true);
    expect(taskManager.releaseTaskExecution).toHaveBeenCalledWith(eventId, taskLease);
    expect(listeners.size).toBe(0);
  },
);

it('retains ownership after a failed release and retries only its still-owned lease', () => {
  const execution = retainBackgroundTaskExecution(eventId, executionId)!;
  taskManager.releaseTaskExecution.mockReturnValueOnce(false).mockReturnValue(true);
  expect(execution.release()).toBe(false);
  expect(listeners.size).toBe(1);
  expect(execution.release()).toBe(true);
  expect(background.releaseExecution).toHaveBeenCalledTimes(1);
  expect(taskManager.releaseTaskExecution).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});
