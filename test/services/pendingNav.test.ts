import {
  claimNotificationTap,
  reserveNotificationTap,
  resetPendingNotification,
  settleNotificationTap,
  stashPendingNotification,
  takePendingNotification,
} from '@/services/notifications/pendingNav';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

let sequence = 0;
function press(chatGuid = 'c1') {
  return {
    notification: { data: { chatGuid } },
    pressAction: { id: 'open-chat' },
    pressOccurrenceId: `11111111-1111-4111-8111-111111111111:${++sequence}`,
  };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  resetPendingNotification();
});

it('destructively takes a validated pending reservation', () => {
  expect(takePendingNotification()).toBeNull();
  const tap = reserveNotificationTap(press())!;
  stashPendingNotification(tap);
  expect(takePendingNotification()).toBe(tap);
  expect(takePendingNotification()).toBeNull();
});

it('coalesces one occurrence but a newer physical press supersedes old preparation', () => {
  const first = press('old');
  const old = reserveNotificationTap(first)!;
  expect(reserveNotificationTap(first)).toBe(old);
  const newer = reserveNotificationTap(press('new'))!;
  stashPendingNotification(newer);
  stashPendingNotification(old);
  expect(takePendingNotification()).toBe(newer);
  expect(reserveNotificationTap(first)).toBeNull();
});

it('claims navigation once, releases a failed lookup, and rejects a consumed copy', () => {
  const detail = press();
  const tap = reserveNotificationTap(detail)!;
  expect(claimNotificationTap(tap)).toBe(true);
  expect(claimNotificationTap(tap)).toBe(false);
  settleNotificationTap(tap, false);
  expect(claimNotificationTap(tap)).toBe(true);
  settleNotificationTap(tap, true);
  stashPendingNotification(tap);
  expect(takePendingNotification()).toBeNull();
  expect(reserveNotificationTap(detail)).toBeNull();
});

it('keeps the retired-token floor while clearing payload and navigation ownership', () => {
  const detail = press();
  const tap = reserveNotificationTap(detail)!;
  stashPendingNotification(tap);
  resetPendingNotification();
  expect(takePendingNotification()).toBeNull();
  expect(claimNotificationTap(tap)).toBe(false);
  expect(reserveNotificationTap(detail)).toBeNull();
  expect(reserveNotificationTap(press())).not.toBeNull();
});

it('does not pin identity or advance the floor using a retired lease', async () => {
  const lease = captureRealtimeDeliveryLease();
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  const detail = press();
  expect(reserveNotificationTap(detail, lease)).toBeNull();
  expect(reserveNotificationTap(detail)).not.toBeNull();
});

it('rejects malformed, tokenless, foreign-epoch, unsafe and contentless handoffs', () => {
  const detail = press();
  expect(reserveNotificationTap(detail)).not.toBeNull();
  for (const pressOccurrenceId of [
    undefined,
    '',
    'private-message-guid',
    '11111111-1111-4111-8111-111111111111:0',
    '11111111-1111-4111-8111-111111111111:01',
    '11111111-1111-4111-8111-111111111111:9007199254740992',
    '22222222-2222-4222-8222-222222222222:1',
  ]) {
    expect(reserveNotificationTap({ ...detail, pressOccurrenceId })).toBeNull();
  }
  expect(reserveNotificationTap({ ...press(), notification: {} })).toBeNull();
  expect(reserveNotificationTap({ ...press(), pressAction: undefined })).toBeNull();
});
