import type { EventDetail } from 'react-native-notify-kit';
import {
  handleNotificationAction,
  handleNotificationPress,
} from '@/services/notifications/actions';
import {
  reserveNotificationTap,
  stashPendingNotification,
} from '@/services/notifications/pendingNav';
import { reconcileMessageNotificationGroupAfterRemoval } from '@/services/notifications/notifeeService';

const mockOnBackgroundEvent = jest.fn();
const mockFlushPersistentLogs = jest.fn(async (): Promise<boolean> => true);

jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: { onBackgroundEvent: mockOnBackgroundEvent },
  EventType: { DISMISSED: 0, PRESS: 1, ACTION_PRESS: 2 },
}));
jest.mock('@/services/notifications/actions', () => ({
  handleNotificationAction: jest.fn(async () => undefined),
  handleNotificationPress: jest.fn(async () => undefined),
}));
jest.mock('@/services/notifications/pendingNav', () => ({
  reserveNotificationTap: jest.fn(),
  stashPendingNotification: jest.fn(),
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  reconcileMessageNotificationGroupAfterRemoval: jest.fn(async () => undefined),
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushPersistentLogs,
}));

// Register only after the capture mock above exists; this test is specifically about import-time
// side-effect wiring, so a deferred CommonJS load is intentional here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@/services/notifications/backgroundEvents');

const backgroundHandler = mockOnBackgroundEvent.mock.calls[0]?.[0] as (event: {
  type: number;
  detail: EventDetail;
}) => Promise<void>;

describe('notification background event registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlushPersistentLogs.mockResolvedValue(true);
  });

  it('lets the tracked press handler validate the account before stashing navigation', async () => {
    const detail = {
      pressAction: { id: 'open' },
      notification: { data: { gatorOwner: 'gator', gatorSchema: '2' } },
    } as unknown as EventDetail;
    const tap = {
      occurrenceId: 'native-test-receipt',
      data: { gatorOwner: 'gator', gatorSchema: '2' },
      accountLease: { generation: 0, isCurrent: () => true },
    };
    jest.mocked(reserveNotificationTap).mockReturnValueOnce(tap);

    await backgroundHandler({ type: 1, detail });

    expect(reserveNotificationTap).toHaveBeenCalledWith(detail, expect.any(Object));
    expect(handleNotificationPress).toHaveBeenCalledWith(detail, expect.any(Function));
    expect(jest.mocked(reserveNotificationTap).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(handleNotificationPress).mock.invocationCallOrder[0]!,
    );
    expect(reconcileMessageNotificationGroupAfterRemoval).toHaveBeenCalledWith(detail.notification);
    // The background bridge no longer writes the session-scoped slot before route validation.
    expect(stashPendingNotification).not.toHaveBeenCalled();
    const validated = jest.mocked(handleNotificationPress).mock.calls[0]?.[1];
    validated?.({ gatorOwner: 'gator', gatorSchema: '2' });
    expect(stashPendingNotification).toHaveBeenCalledWith(tap);
    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
  });

  it('reconciles a swiped message child without running press side-effects', async () => {
    const detail = { notification: { id: 'gator-message-7' } } as unknown as EventDetail;

    await backgroundHandler({ type: 0, detail });

    expect(reconcileMessageNotificationGroupAfterRemoval).toHaveBeenCalledWith(detail.notification);
    expect(handleNotificationAction).not.toHaveBeenCalled();
    expect(handleNotificationPress).not.toHaveBeenCalled();
    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
  });

  it('routes an action press through the account-tracked action handler', async () => {
    const detail = { pressAction: { id: 'reply' } } as unknown as EventDetail;

    await backgroundHandler({ type: 2, detail });

    expect(handleNotificationAction).toHaveBeenCalledWith(detail);
    expect(handleNotificationPress).not.toHaveBeenCalled();
    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
  });

  it('waits for the persistent-log barrier even when action handling fails', async () => {
    const flushGate = Promise.withResolvers<boolean>();
    mockFlushPersistentLogs.mockReturnValueOnce(flushGate.promise);
    jest.mocked(handleNotificationAction).mockRejectedValueOnce(new Error('action failed'));
    const detail = { pressAction: { id: 'reply' } } as unknown as EventDetail;

    const handling = backgroundHandler({ type: 2, detail });
    let settled = false;
    void handling.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    flushGate.resolve(true);
    await expect(handling).resolves.toBeUndefined();
  });
});
