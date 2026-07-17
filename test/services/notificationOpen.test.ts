/**
 * Unit tests for notification deep-link routing (`src/services/notifications/notificationOpen.ts`).
 *
 * This is the code that turns a TAPPED notification into an open-the-chat-and-scroll-to-the-message
 * navigation. On Android `launchActivity: 'default'` only foregrounds the app; it does NOT deep-link,
 * so tapping a message notification used to land the user on whatever screen was already open. These
 * tests pin the extraction + path-building (the navigate call itself is injected, so no expo-router).
 */
import {
  chatDeepLink,
  drainNotificationTap,
  notificationOpenTarget,
  openFromNotification,
} from '@/services/notifications/notificationOpen';

describe('notificationOpenTarget', () => {
  it('extracts chatGuid + messageGuid + numeric messageDate from a message notification', () => {
    const target = notificationOpenTarget({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'm-abc',
      messageDate: '1700000000000', // stringified over the native bridge
    });
    expect(target).toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'm-abc',
      messageDate: 1700000000000,
    });
  });

  it('accepts a numeric messageDate too (not only the stringified form)', () => {
    expect(notificationOpenTarget({ chatGuid: 'c1', messageGuid: 'm1', messageDate: 42 })).toEqual({
      chatGuid: 'c1',
      messageGuid: 'm1',
      messageDate: 42,
    });
  });

  it('omits messageGuid/messageDate when absent (a reminder-style notice with only a chat)', () => {
    expect(notificationOpenTarget({ chatGuid: 'c1' })).toEqual({ chatGuid: 'c1' });
  });

  it('drops a non-numeric messageDate rather than passing NaN downstream', () => {
    expect(notificationOpenTarget({ chatGuid: 'c1', messageGuid: 'm1', messageDate: 'nope' })).toEqual(
      { chatGuid: 'c1', messageGuid: 'm1' },
    );
  });

  it('returns null when there is no chat to open (FaceTime ring / content-less notice / undefined)', () => {
    expect(notificationOpenTarget({ faceTimeUuid: 'u1' })).toBeNull();
    expect(notificationOpenTarget({})).toBeNull();
    expect(notificationOpenTarget(undefined)).toBeNull();
    // A non-string chatGuid is not trusted.
    expect(notificationOpenTarget({ chatGuid: 123 })).toBeNull();
  });
});

describe('chatDeepLink', () => {
  it('builds the focus + focusDate query the chat screen reads (mirrors search)', () => {
    expect(chatDeepLink({ chatGuid: 'c1', messageGuid: 'm1', messageDate: 1700000000000 })).toBe(
      '/chat/c1?focus=m1&focusDate=1700000000000',
    );
  });

  it('URL-encodes the guid + messageGuid (real guids contain ; and +)', () => {
    expect(
      chatDeepLink({ chatGuid: 'iMessage;-;+1555', messageGuid: 'p:0/abc', messageDate: 10 }),
    ).toBe('/chat/iMessage%3B-%3B%2B1555?focus=p%3A0%2Fabc&focusDate=10');
  });

  it('omits ?focus entirely when there is no message to scroll to', () => {
    expect(chatDeepLink({ chatGuid: 'c1' })).toBe('/chat/c1');
  });

  it('omits focusDate when the message has no timestamp', () => {
    expect(chatDeepLink({ chatGuid: 'c1', messageGuid: 'm1' })).toBe('/chat/c1?focus=m1');
  });
});

describe('openFromNotification', () => {
  it('navigates to the focused chat deep-link for a message notification', () => {
    const navigate = jest.fn();
    openFromNotification({ chatGuid: 'c1', messageGuid: 'm1', messageDate: '5' }, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1?focus=m1&focusDate=5');
  });

  it('does nothing for a notification that is not about a chat (no navigate call)', () => {
    const navigate = jest.fn();
    openFromNotification({ faceTimeUuid: 'u1' }, navigate);
    openFromNotification(undefined, navigate);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('drainNotificationTap', () => {
  const messageInitial = { notification: { data: { chatGuid: 'c1', messageGuid: 'm1' } } };

  it('does nothing when neither source has a tap (a plain foreground/resume tick)', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    await drainNotificationTap(async () => null, () => null, press, navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it('navigates and runs press side-effects for a launch (getInitialNotification) tap', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    await drainNotificationTap(async () => messageInitial, () => null, press, navigate);
    expect(press).toHaveBeenCalledWith(messageInitial);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1?focus=m1');
  });

  it('navigates from the pending stash when there is no launch event (background-alive backstop)', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    await drainNotificationTap(
      async () => null,
      () => ({ chatGuid: 'c2', messageGuid: 'm2', messageDate: '9' }),
      press,
      navigate,
    );
    // No launch event → no press side-effects, but the stash still opens the chat.
    expect(press).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c2?focus=m2&focusDate=9');
  });

  it('drains BOTH sources but navigates only once (same press, no double-push)', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    const takePending = jest.fn(() => ({ chatGuid: 'c1', messageGuid: 'm1' }));
    await drainNotificationTap(async () => messageInitial, takePending, press, navigate);
    // Both the launch event and the stash describe the same tap — clear both, open once.
    expect(takePending).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1?focus=m1');
  });

  it('runs press side-effects but does NOT navigate for a launch that is not about a chat', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    const reminderInitial = { notification: { data: { reminder: '1' } } };
    await drainNotificationTap(async () => reminderInitial, () => null, press, navigate);
    expect(press).toHaveBeenCalledWith(reminderInitial);
    expect(navigate).not.toHaveBeenCalled();
  });
});
