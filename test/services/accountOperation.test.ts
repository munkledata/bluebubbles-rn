import {
  assertAccountOperationCurrent,
  runAccountOperation,
} from '@/services/realtime/accountOperation';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('runAccountOperation', () => {
  it('returns the task value while the account stays current', async () => {
    const lease = captureRealtimeDeliveryLease();
    await expect(runAccountOperation(lease, async () => 42)).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('never starts work for an account that is already gone', async () => {
    const lease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    const task = jest.fn(async () => 1);

    await expect(runAccountOperation(lease, task)).resolves.toEqual({ ok: false });
    expect(task).not.toHaveBeenCalled();
  });

  it('drops a result that finishes after the account changed', async () => {
    const lease = captureRealtimeDeliveryLease();
    const gate = deferred();
    const running = runAccountOperation(lease, async () => {
      await gate.promise;
      return 'late';
    });
    const drained = pauseRealtimeDeliveries();
    gate.release();

    await expect(running).resolves.toEqual({ ok: false });
    await drained;
  });

  it('rethrows a current account error but hides one from an account that changed', async () => {
    const current = captureRealtimeDeliveryLease();
    await expect(
      runAccountOperation(current, async () => {
        throw new Error('current failure');
      }),
    ).rejects.toThrow('current failure');

    const lease = captureRealtimeDeliveryLease();
    const gate = deferred();
    const running = runAccountOperation(lease, async () => {
      await gate.promise;
      throw new Error('old account failure');
    });
    const drained = pauseRealtimeDeliveries();
    gate.release();

    await expect(running).resolves.toEqual({ ok: false });
    await drained;
  });

  it('turns an in-task stale check into a dropped result', async () => {
    const lease = captureRealtimeDeliveryLease();
    const gate = deferred();
    const afterCheck = jest.fn();
    const running = runAccountOperation(lease, async (activeLease) => {
      await gate.promise;
      assertAccountOperationCurrent(activeLease);
      afterCheck();
      return 1;
    });
    const drained = pauseRealtimeDeliveries();
    gate.release();

    await expect(running).resolves.toEqual({ ok: false });
    expect(afterCheck).not.toHaveBeenCalled();
    await drained;
  });

  it('makes Disconnect wait for the running work', async () => {
    const lease = captureRealtimeDeliveryLease();
    const gate = deferred();
    const running = runAccountOperation(lease, async () => {
      await gate.promise;
    });
    let drainedEarly = false;
    const drained = pauseRealtimeDeliveries().then(() => {
      drainedEarly = true;
    });
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(drainedEarly).toBe(false);

    gate.release();
    await running;
    await drained;
    expect(drainedEarly).toBe(true);
  });
});
