import { accountCancellationSignal } from '@/services/realtime/accountCancellation';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

// Review item 1073: Disconnect waits only 5 s for tracked account work, yet nothing could cancel
// the requests that work was waiting on. Each account generation now has one shared signal that
// Disconnect aborts in the same step that retires the generation.
describe('account cancellation signal', () => {
  afterEach(() => {
    resumeRealtimeDeliveries();
  });

  it('shares one signal per account and aborts it the moment Disconnect starts', async () => {
    const first = accountCancellationSignal(captureRealtimeDeliveryLease());
    const second = accountCancellationSignal(captureRealtimeDeliveryLease());
    expect(second).toBe(first);
    expect(first.aborted).toBe(false);

    const pausing = pauseRealtimeDeliveries();
    // Already aborted before teardown starts waiting for admitted work.
    expect(first.aborted).toBe(true);
    await pausing;
  });

  it('gives the next account a fresh signal', async () => {
    const retired = accountCancellationSignal(captureRealtimeDeliveryLease());
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    const next = accountCancellationSignal(captureRealtimeDeliveryLease());
    expect(next).not.toBe(retired);
    expect(next.aborted).toBe(false);
    expect(retired.aborted).toBe(true);
  });

  it('is already cancelled for a retired lease or one captured during Disconnect', async () => {
    const retiredLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    const lateLease = captureRealtimeDeliveryLease();
    expect(accountCancellationSignal(lateLease).aborted).toBe(true);

    resumeRealtimeDeliveries();
    // The late lease carries the next account's generation number, but must never borrow its
    // live signal.
    expect(lateLease.generation).toBe(captureRealtimeDeliveryLease().generation);
    expect(accountCancellationSignal(lateLease).aborted).toBe(true);
    expect(accountCancellationSignal(retiredLease).aborted).toBe(true);
    expect(accountCancellationSignal(captureRealtimeDeliveryLease()).aborted).toBe(false);
  });
});
