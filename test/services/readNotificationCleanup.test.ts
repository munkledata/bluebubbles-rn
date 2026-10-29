/**
 * clearAllMessageNotifications (src/services/notifications/readNotificationCleanup.ts): after
 * "Mark All Read" commits, every chat's message notification leaves the tray. Locks in:
 *   - only exact per-chat message ids (`gator-message-<chatId>`) are cancelled, each once, through
 *     the shared notifeeService queue (cancelNotificationById), with the caller's lease;
 *   - reminders, send-failure notices, FaceTime calls, the group summary and the generic locked
 *     notice are left alone;
 *   - a retired account lease cancels nothing, including one retired mid-way;
 *   - an enumeration failure is contained (logged, never thrown).
 *
 * The adapter and the queue are mocked: their native/lease behavior is covered by
 * notifeeService.test.ts. This suite proves which ids this cleanup hands to that boundary.
 */
import type { EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import { nativeNotificationAdapter } from '@/services/notifications/nativeNotificationAdapter';
import { cancelNotificationById } from '@/services/notifications/notifeeService';
import { clearAllMessageNotifications } from '@/services/notifications/readNotificationCleanup';

jest.mock('@/services/notifications/nativeNotificationAdapter', () => ({
  nativeNotificationAdapter: { getDisplayedNotifications: jest.fn() },
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  cancelNotificationById: jest.fn(() => Promise.resolve()),
}));
jest.mock('@core/secure', () => ({ logger: { warn: jest.fn() } }));

const mockGetDisplayed = nativeNotificationAdapter.getDisplayedNotifications as jest.Mock;
const mockCancelById = cancelNotificationById as jest.Mock;
const mockWarn = logger.warn as jest.Mock;

function lease(current = true): EventDeliveryContext & { current: boolean } {
  const value = {
    generation: 1,
    current,
    isCurrent: () => value.current,
  };
  return value as EventDeliveryContext & { current: boolean };
}

function shown(id: string, nested = true): { id: string; notification: { id?: string } } {
  return { id, notification: nested ? { id } : {} };
}

beforeEach(() => {
  mockGetDisplayed.mockReset();
  mockCancelById.mockReset().mockResolvedValue(undefined);
  mockWarn.mockReset();
});

describe('clearAllMessageNotifications', () => {
  it('cancels each chat message notification once and leaves reminders and other notices', async () => {
    mockGetDisplayed.mockResolvedValue([
      shown('gator-message-12'),
      shown('gator-message-7', false),
      shown('gator-message-12'),
      shown('gator-reminder-message-55-1730000000000'),
      shown('gator-reminder-row-3-1730000000000'),
      shown('gator-send-failure-9'),
      shown('gator-message-summary'),
      shown('gator-message-012'),
      shown('gator-message-0'),
      shown('gator-locked'),
      shown('iMessage;-;+15551230000'),
    ]);
    const context = lease();

    await clearAllMessageNotifications(context);

    expect(mockCancelById.mock.calls).toEqual([
      ['gator-message-12', context],
      ['gator-message-7', context],
    ]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does nothing for a retired account', async () => {
    mockGetDisplayed.mockResolvedValue([shown('gator-message-1')]);

    await clearAllMessageNotifications(lease(false));

    expect(mockGetDisplayed).not.toHaveBeenCalled();
    expect(mockCancelById).not.toHaveBeenCalled();
  });

  it('stops cancelling once the account is retired mid-way', async () => {
    const context = lease();
    mockGetDisplayed.mockResolvedValue([shown('gator-message-1'), shown('gator-message-2')]);
    mockCancelById.mockImplementationOnce(async () => {
      context.current = false;
    });

    await clearAllMessageNotifications(context);

    expect(mockCancelById).toHaveBeenCalledTimes(1);
    expect(mockCancelById).toHaveBeenCalledWith('gator-message-1', context);
  });

  it('contains an enumeration failure instead of throwing', async () => {
    mockGetDisplayed.mockRejectedValue(new Error('native unavailable'));

    await expect(clearAllMessageNotifications(lease())).resolves.toBeUndefined();

    expect(mockCancelById).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '[notif] clearing read message notifications failed',
      expect.any(Error),
    );
  });
});
