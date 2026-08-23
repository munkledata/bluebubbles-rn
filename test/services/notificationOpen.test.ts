/**
 * Unit tests for notification deep-link routing (`src/services/notifications/notificationOpen.ts`).
 *
 * This is the code that turns a TAPPED notification into open-the-chat navigation. On Android
 * `launchActivity: 'default'` only foregrounds the app; it does NOT deep-link, so tapping a message
 * notification used to land the user on whatever screen was already open. A MESSAGE tap opens the
 * chat PLAIN (live at the newest message, bottom-pinned); only a REMINDER tap (`reminder: '1'`)
 * anchors on its old message with the search-hit `?focus=…` route — anchored mode freezes the
 * bottom-follow behavior, which is wrong for normal conversation. These tests pin the extraction +
 * path-building (the navigate call itself is injected, so no expo-router).
 */
import {
  chatDeepLink,
  drainNotificationTap,
  notificationOpenTarget,
  openFromNotification,
} from '@/services/notifications/notificationOpen';
import { logger } from '@core/secure';
import { resolveNotificationData } from '@/services/notifications/notificationRouting';

jest.mock('@/services/notifications/notificationRouting', () => ({
  resolveNotificationData: jest.fn(
    async (data: Record<string, unknown> | undefined) => data ?? null,
  ),
}));

const mockResolveNotificationData = resolveNotificationData as jest.Mock;

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

  it('omits messageGuid/messageDate when absent (a notice with only a chat)', () => {
    expect(notificationOpenTarget({ chatGuid: 'c1' })).toEqual({ chatGuid: 'c1' });
  });

  it('extracts the reminder flag (only the exact "1" the reminder path posts)', () => {
    expect(notificationOpenTarget({ chatGuid: 'c1', messageGuid: 'm1', reminder: '1' })).toEqual({
      chatGuid: 'c1',
      messageGuid: 'm1',
      reminder: true,
    });
    expect(notificationOpenTarget({ chatGuid: 'c1', reminder: true })).toEqual({ chatGuid: 'c1' });
  });

  it('drops a non-numeric messageDate rather than passing NaN downstream', () => {
    expect(
      notificationOpenTarget({ chatGuid: 'c1', messageGuid: 'm1', messageDate: 'nope' }),
    ).toEqual({ chatGuid: 'c1', messageGuid: 'm1' });
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
  it('opens a MESSAGE tap plainly — live at the newest message, never anchored', () => {
    // Anchored (?focus) mode freezes bottom-follow (no keyboard follow / no re-pin on send),
    // which broke normal conversation when every notification tap used it.
    expect(chatDeepLink({ chatGuid: 'c1', messageGuid: 'm1', messageDate: 1700000000000 })).toBe(
      '/chat/c1',
    );
  });

  it('anchors a REMINDER tap on its (old) message with the search-hit focus route', () => {
    expect(
      chatDeepLink({
        chatGuid: 'c1',
        messageGuid: 'm1',
        messageDate: 1700000000000,
        reminder: true,
      }),
    ).toBe('/chat/c1?focus=m1&focusDate=1700000000000');
  });

  it('URL-encodes the guid + messageGuid (real guids contain ; and +)', () => {
    expect(
      chatDeepLink({
        chatGuid: 'iMessage;-;+1555',
        messageGuid: 'p:0/abc',
        messageDate: 10,
        reminder: true,
      }),
    ).toBe('/chat/iMessage%3B-%3B%2B1555?focus=p%3A0%2Fabc&focusDate=10');
  });

  it('omits ?focus entirely when there is no message to scroll to', () => {
    expect(chatDeepLink({ chatGuid: 'c1', reminder: true })).toBe('/chat/c1');
  });

  it('omits focusDate when the reminder message has no timestamp', () => {
    expect(chatDeepLink({ chatGuid: 'c1', messageGuid: 'm1', reminder: true })).toBe(
      '/chat/c1?focus=m1',
    );
  });
});

describe('openFromNotification', () => {
  it('navigates to the plain chat route for a message notification', async () => {
    const navigate = jest.fn();
    await openFromNotification({ chatGuid: 'c1', messageGuid: 'm1', messageDate: '5' }, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
  });

  it('navigates to the anchored deep-link for a reminder notification', async () => {
    const navigate = jest.fn();
    await openFromNotification(
      { chatGuid: 'c1', messageGuid: 'm1', messageDate: '5', reminder: '1' },
      navigate,
    );
    expect(navigate).toHaveBeenCalledWith('/chat/c1?focus=m1&focusDate=5');
  });

  it('does nothing for a notification that is not about a chat (no navigate call)', async () => {
    const navigate = jest.fn();
    await openFromNotification({ faceTimeUuid: 'u1' }, navigate);
    await openFromNotification(undefined, navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates after a safe local-key payload is resolved through the encrypted DB', async () => {
    mockResolveNotificationData.mockResolvedValueOnce({
      chatGuid: 'iMessage;-;+15551234567',
      messageGuid: 'm1',
    });
    const navigate = jest.fn();
    await openFromNotification(
      { gatorOwner: 'gator', gatorSchema: '2', gatorKind: 'message', chatId: '7' },
      navigate,
    );
    expect(navigate).toHaveBeenCalledWith('/chat/iMessage%3B-%3B%2B15551234567');
  });

  it('contains a safe-route DB failure instead of leaking an unhandled rejection', async () => {
    const failure = new Error('encrypted DB unavailable');
    mockResolveNotificationData.mockRejectedValueOnce(failure);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const navigate = jest.fn();

    await expect(
      openFromNotification(
        { gatorOwner: 'gator', gatorSchema: '2', gatorKind: 'message', chatId: '7' },
        navigate,
      ),
    ).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[notif] notification route could not be opened', failure);
  });
});

describe('drainNotificationTap', () => {
  // A genuine press event carries the pressAction bundle alongside the notification; Android's
  // launch-intent echo (below) carries only the notification.
  const messageInitial = {
    notification: { data: { chatGuid: 'c1', messageGuid: 'm1' } },
    pressAction: { id: 'open-chat' },
  };

  it('does nothing when neither source has a tap (a plain foreground/resume tick)', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    await drainNotificationTap(
      async () => null,
      () => null,
      press,
      navigate,
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it('navigates and runs press side-effects for a launch (getInitialNotification) tap', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    await drainNotificationTap(
      async () => messageInitial,
      () => null,
      press,
      navigate,
    );
    expect(press).toHaveBeenCalledWith(messageInitial);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
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
    expect(navigate).toHaveBeenCalledWith('/chat/c2');
  });

  it('drains BOTH sources but navigates only once (same press, no double-push)', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    const takePending = jest.fn(() => ({ chatGuid: 'c1', messageGuid: 'm1' }));
    await drainNotificationTap(async () => messageInitial, takePending, press, navigate);
    // Both the launch event and the stash describe the same tap — clear both, open once.
    expect(takePending).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
  });

  it('still navigates and clears the pending duplicate when press cleanup rejects', async () => {
    const failure = new Error('reminder DB unavailable');
    const navigate = jest.fn();
    const press = jest.fn(async () => {
      throw failure;
    });
    const takePending = jest.fn(() => ({ chatGuid: 'c1', messageGuid: 'm1' }));

    await expect(
      drainNotificationTap(async () => messageInitial, takePending, press, navigate),
    ).rejects.toBe(failure);

    expect(takePending).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
  });

  it('re-stashes one consumed copy after a route failure, then opens it once on retry', async () => {
    const failure = new Error('encrypted DB temporarily unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const navigate = jest.fn();
    const press = jest.fn();
    let pending: Record<string, unknown> | null = {
      chatGuid: 'c1',
      messageGuid: 'm1',
    };
    const takePending = jest.fn(() => {
      const value = pending;
      pending = null;
      return value;
    });
    const restorePending = jest.fn((data: Record<string, unknown>) => {
      pending = data;
    });
    const echo = { notification: messageInitial.notification };
    const getInitial = jest
      .fn<Promise<typeof messageInitial | typeof echo>, []>()
      .mockResolvedValueOnce(messageInitial)
      .mockResolvedValueOnce(echo);
    mockResolveNotificationData
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(messageInitial.notification.data);

    await drainNotificationTap(getInitial, takePending, press, navigate, restorePending);

    expect(navigate).not.toHaveBeenCalled();
    expect(restorePending).toHaveBeenCalledTimes(1);
    expect(restorePending).toHaveBeenCalledWith(messageInitial.notification.data);
    // The genuine launch press still owns its cleanup exactly once; the restored pending copy is
    // navigation-only on retry.
    expect(press).toHaveBeenCalledTimes(1);

    await drainNotificationTap(getInitial, takePending, press, navigate, restorePending);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
    expect(restorePending).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledTimes(1);
    expect(pending).toBeNull();
    expect(warn).toHaveBeenCalledWith('[notif] notification route could not be opened', failure);
  });

  it('runs press side-effects but does NOT navigate for a launch that is not about a chat', async () => {
    const navigate = jest.fn();
    const press = jest.fn();
    const reminderInitial = {
      notification: { data: { reminder: '1' } },
      pressAction: { id: 'reminder' },
    };
    await drainNotificationTap(
      async () => reminderInitial,
      () => null,
      press,
      navigate,
    );
    expect(press).toHaveBeenCalledWith(reminderInitial);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('IGNORES the Android launch-intent echo (a notification with no pressAction)', async () => {
    // getInitialNotification() is not read-once on Android: with the sticky press event consumed it
    // falls back to the Activity's launch intent, which keeps its "notification" extra for the
    // Activity's whole life — so it re-serves the launching notification on every later drain.
    // Acting on it trapped the user: cold-start into a chat, press Back, get thrown right back in.
    const navigate = jest.fn();
    const press = jest.fn();
    const echo = { notification: { data: { chatGuid: 'c1', messageGuid: 'm1' } } };
    await drainNotificationTap(
      async () => echo,
      () => null,
      press,
      navigate,
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it('drains the same press exactly once — a re-drain sees only the echo and stays put', async () => {
    // The real sequence on a cold start: the first read pops the sticky press event, every read
    // after it gets the launch-intent echo. Exactly one navigation must come out of that.
    const navigate = jest.fn();
    const press = jest.fn();
    const echo = { notification: { data: { chatGuid: 'c1', messageGuid: 'm1' } } };
    let sticky: typeof messageInitial | typeof echo | null = messageInitial;
    const getInitial = async (): Promise<typeof messageInitial | typeof echo | null> => {
      const next = sticky;
      sticky = echo; // notify-kit removes the sticky event on read; the intent extra remains
      return next;
    };
    await drainNotificationTap(getInitial, () => null, press, navigate);
    await drainNotificationTap(getInitial, () => null, press, navigate);
    await drainNotificationTap(getInitial, () => null, press, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c1');
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('still opens from the pending stash while the echo is being served', async () => {
    // A background-alive tap stashes its data via onBackgroundEvent. That drain must work even
    // though getInitialNotification() is simultaneously handing back the OLD launching intent.
    const navigate = jest.fn();
    const press = jest.fn();
    const echo = { notification: { data: { chatGuid: 'c1', messageGuid: 'm1' } } };
    await drainNotificationTap(
      async () => echo,
      () => ({ chatGuid: 'c2', messageGuid: 'm2' }),
      press,
      navigate,
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/chat/c2');
    expect(press).not.toHaveBeenCalled();
  });
});
