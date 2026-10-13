/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockCaptureCapability = jest.fn();

jest.mock('@/services/send/rcsAttemptCapability', () => ({
  captureSessionRcsCapabilityLease: () => mockCaptureCapability(),
}));

import { DbCommitGuardRejectedError } from '@db/transaction';
import { runCapabilityGatedAccountAction } from '@/services/capabilityGatedAction';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const FLAG = 'supports_imessage_group_rename' as const;

function capability(advertised: boolean, current = true) {
  return { serverInfo: { [FLAG]: advertised }, isCurrent: () => current };
}

afterEach(() => {
  resumeRealtimeDeliveries();
  mockCaptureCapability.mockReset();
});

describe('runCapabilityGatedAccountAction', () => {
  it('runs the action with the account lease and the admitted capability', async () => {
    const admitted = capability(true);
    mockCaptureCapability.mockReturnValue(admitted);
    const lease = captureRealtimeDeliveryLease();
    const action = jest.fn(async () => 'done');

    await expect(runCapabilityGatedAccountAction(lease, FLAG, action)).resolves.toBe('done');
    expect(action).toHaveBeenCalledWith(lease, admitted);
  });

  it.each([
    ['there is no connected session', undefined],
    ['the server does not advertise the flag', capability(false)],
    ['the session capability changed', capability(true, false)],
  ])('is a quiet null without running the action when %s', async (_label, captured) => {
    mockCaptureCapability.mockReturnValue(captured);
    const action = jest.fn(async () => 'done');

    await expect(
      runCapabilityGatedAccountAction(captureRealtimeDeliveryLease(), FLAG, action),
    ).resolves.toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('turns a refused database commit into null but rethrows other current-account errors', async () => {
    mockCaptureCapability.mockReturnValue(capability(true));

    await expect(
      runCapabilityGatedAccountAction(captureRealtimeDeliveryLease(), FLAG, async () => {
        throw new DbCommitGuardRejectedError();
      }),
    ).resolves.toBeNull();
    await expect(
      runCapabilityGatedAccountAction(captureRealtimeDeliveryLease(), FLAG, async () => {
        throw new Error('server refused');
      }),
    ).rejects.toThrow('server refused');
  });

  it('drops a result that arrives after the account changed', async () => {
    mockCaptureCapability.mockReturnValue(capability(true));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runCapabilityGatedAccountAction(
      captureRealtimeDeliveryLease(),
      FLAG,
      async () => {
        await gate;
        return 'late';
      },
    );
    const drained = pauseRealtimeDeliveries();
    release();

    await expect(running).resolves.toBeNull();
    await drained;
  });
});
