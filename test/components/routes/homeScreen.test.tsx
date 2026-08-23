/**
 * Home route (app/(app)/home.tsx): the connected inbox and the app's boot-completion hub.
 * Beyond rendering the (separately-tested) ConversationListScreen, its mount effect does the
 * launch-order recovery work that this suite locks in:
 *   - (re)hydrates the kv-backed prefs stores AFTER the DB is open (the root layout's first
 *     hydrate runs pre-connect and silently fails — see src/state/themeStore.ts). Each fires once.
 *   - recovers optimistic-send rows, then catches up on due scheduled sends; each scheduled runner
 *     owns its once-per-account crash recovery. The branch is gated by `isDevServer()` (dev →
 *     local fake send via runDueScheduled; prod → recoverOutgoing + fireDueScheduled).
 *   - the whole catch-up is best-effort: a rejected recovery is swallowed (logger.debug), never
 *     crashing the inbox.
 *   - all side-effects run ONCE on mount (useEffect []), not per re-render.
 *   - the DEV overlay bar routes/kicks the dev-seed helpers; Disconnect forgets the session and
 *     replaces to /welcome.
 *
 * In-file mocks: @ui (ConversationListScreen probe), expo-router (push/replace), @/services
 * (forget/http), @/services/send (the 4 recovery fns), @features/conversations/devSeed (the dev
 * helpers), @utils/isDev (isDevServer). The stores stay REAL — their `hydrate` action is spied
 * so we assert the call without running the DB-backed body.
 */
import React from 'react';
import { act, renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useThemeStore } from '@state/themeStore';
import { logger } from '@core/secure';
import { useDialogStore } from '@ui/dialog/dialogStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, replace: mockReplace }) }));

jest.mock('@/services', () => ({
  disconnectFailureMessage: jest.fn(
    () =>
      'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.',
  ),
  forget: jest.fn().mockResolvedValue(undefined),
  http: {},
}));

jest.mock('@/services/send', () => ({
  fireDueScheduled: jest.fn().mockResolvedValue(0),
  recoverOutgoing: jest.fn().mockResolvedValue({ eligible: 0, sent: 0 }),
  runDueScheduled: jest.fn().mockResolvedValue(0),
}));

jest.mock('@features/conversations/devSeed', () => ({
  injectMessage: jest.fn().mockResolvedValue(undefined),
  devInjectIncomingFaceTime: jest.fn().mockResolvedValue(undefined),
  devQueueIncomingMessageWithoutDrain: jest.fn().mockResolvedValue(undefined),
  devResumeQueuedIncomingMessages: jest.fn().mockResolvedValue(undefined),
  devSendFake: jest.fn().mockResolvedValue(undefined),
  devSendFakeReply: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@utils/isDev', () => ({ isDevServer: jest.fn(() => false) }));

// Home pulls ConversationListScreen from the big `@ui` barrel (drags in ky/native modules that
// don't load under jest). Collapse it to a light probe — this suite is about the ROUTE's own boot
// logic, not the inbox internals (covered by conversations/conversationListScreen.test.tsx).
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    ConversationListScreen: () => ReactLib.createElement(Text, { testID: 'inbox' }, 'inbox'),
  };
});

// eslint-disable-next-line import/first
import Home from '../../../app/(app)/home';
// eslint-disable-next-line import/first
import { forget } from '@/services';
// eslint-disable-next-line import/first
import { fireDueScheduled, recoverOutgoing, runDueScheduled } from '@/services/send';
// eslint-disable-next-line import/first
import {
  devInjectIncomingFaceTime,
  devQueueIncomingMessageWithoutDrain,
  devResumeQueuedIncomingMessages,
  devSendFake,
  devSendFakeReply,
  injectMessage,
} from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { isDevServer } from '@utils/isDev';

const isDevServerMock = isDevServer as jest.Mock;
const fireDueScheduledMock = fireDueScheduled as jest.Mock;
const recoverOutgoingMock = recoverOutgoing as jest.Mock;
const runDueScheduledMock = runDueScheduled as jest.Mock;
const forgetMock = forget as jest.Mock;
const injectMessageMock = injectMessage as jest.Mock;
const devQueueIncomingMessageMock = devQueueIncomingMessageWithoutDrain as jest.Mock;
const devResumeQueuedMessagesMock = devResumeQueuedIncomingMessages as jest.Mock;
const devSendFakeMock = devSendFake as jest.Mock;
const devSendFakeReplyMock = devSendFakeReply as jest.Mock;

const STORES = [useFeatureSettingsStore, useSyncSettingsStore, useThemeStore];

let hydrateSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  forgetMock.mockResolvedValue(undefined);
  isDevServerMock.mockReturnValue(false);
  fireDueScheduledMock.mockResolvedValue(0);
  recoverOutgoingMock.mockResolvedValue({ eligible: 0, sent: 0 });
  runDueScheduledMock.mockResolvedValue(0);
  injectMessageMock.mockResolvedValue(undefined);
  devQueueIncomingMessageMock.mockResolvedValue(undefined);
  devResumeQueuedMessagesMock.mockResolvedValue(undefined);
  useDialogStore.setState({ current: null, queue: [] });
  // Spy each store's hydrate so we can assert the launch-order re-hydrate WITHOUT running the
  // DB-backed body (getDatabase is stubbed by support/setup and would otherwise no-op/throw).
  hydrateSpies = STORES.map((s) =>
    jest.spyOn(s.getState(), 'hydrate').mockResolvedValue(undefined),
  );
});

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.restoreAllMocks();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Home route — render', () => {
  it('renders the conversation list (the inbox) and the DEV overlay bar', async () => {
    await renderWithTheme(<Home />);
    expect(screen.getByTestId('inbox')).toBeTruthy();
    // __DEV__ is true under jest-expo, so the dev overlay renders its affordances.
    expect(screen.getByText('⚡ Inject')).toBeTruthy();
    expect(screen.queryByText('⏸ Queue')).toBeNull();
    expect(screen.getByText('📞 FaceTime')).toBeTruthy();
    expect(screen.getByText('📍 Find My')).toBeTruthy();
    expect(screen.getByText('Disconnect')).toBeTruthy();
  });

  it('shows the persist-without-drain control only for the exact DEV fixture session', async () => {
    isDevServerMock.mockReturnValue(true);
    await renderWithTheme(<Home />);
    expect(screen.getByText('⏸ Queue')).toBeTruthy();
  });
});

describe('Home route — boot-completion side-effects', () => {
  it('re-hydrates every registered prefs store exactly once on mount', async () => {
    await renderWithTheme(<Home />);
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalled());
    for (const spy of hydrateSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ shouldCommit: expect.any(Function) }),
      );
    }
    const options = hydrateSpies[0]?.mock.calls[0]?.[0] as
      { shouldCommit?: () => boolean } | undefined;
    expect(options?.shouldCommit?.()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(options?.shouldCommit?.()).toBe(false);
    resumeRealtimeDeliveries();
    expect(options?.shouldCommit?.()).toBe(false);
  });

  it('recovers optimistic sends then runs the self-recovering scheduled ticker on mount', async () => {
    await renderWithTheme(<Home />);
    // isDevServer() === false → recover stranded optimistic sends, fire due scheduled via the
    // real server path; fireDueScheduled owns crash-row recovery before it claims anything.
    await waitFor(() => expect(recoverOutgoing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalledTimes(1));
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('takes the dev-fixture branch (runDueScheduled, no real send) when isDevServer is true', async () => {
    isDevServerMock.mockReturnValue(true);
    await renderWithTheme(<Home />);
    await waitFor(() => expect(runDueScheduled).toHaveBeenCalledTimes(1));
    // The injected runner owns its own recovery; the real-server catch-up does NOT run.
    expect(devResumeQueuedIncomingMessages).toHaveBeenCalledWith(
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(recoverOutgoing).not.toHaveBeenCalled();
    expect(fireDueScheduled).not.toHaveBeenCalled();
  });

  it('threads the Home mount lease into DEV scheduled send and reply fixtures', async () => {
    isDevServerMock.mockReturnValue(true);
    runDueScheduledMock.mockImplementationOnce(
      async (
        _db: unknown,
        _http: unknown,
        _now: number,
        sender: (
          chatGuid: string,
          text: string,
          selectedMessageGuid: string | undefined,
          onQueued: () => Promise<void>,
        ) => Promise<void>,
        scope: { isCurrent(): boolean },
      ) => {
        expect(scope.isCurrent()).toBe(true);
        await sender('plain-chat', 'plain', undefined, async () => undefined);
        await sender('reply-chat', 'reply', 'reply-target', async () => undefined);
        return 2;
      },
    );

    await renderWithTheme(<Home />);
    await waitFor(() => expect(runDueScheduled).toHaveBeenCalledTimes(1));
    const accountLease = runDueScheduledMock.mock.calls[0]![4];

    expect(devSendFakeMock).toHaveBeenCalledWith('plain-chat', 'plain', undefined, accountLease);
    expect(devSendFakeReplyMock).toHaveBeenCalledWith(
      'reply-chat',
      'reply',
      'reply-target',
      undefined,
      accountLease,
    );
  });

  it('swallows a failed scheduled catch-up — the inbox still renders, no throw', async () => {
    const error = new Error('db down');
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    fireDueScheduledMock.mockRejectedValue(error);
    await renderWithTheme(<Home />);
    // The catch-up is best-effort (logger.debug in the catch); the list is unaffected.
    expect(screen.getByTestId('inbox')).toBeTruthy();
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalledTimes(1));
    expect(recoverOutgoing).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('[home] scheduled catch-up failed', error);
  });

  it('runs the mount side-effects ONCE, not again on re-render (useEffect [])', async () => {
    const view = await renderWithTheme(<Home />);
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalledTimes(1));
    view.rerender(<Home />);
    // A re-render must not re-fire the boot catch-up or the store re-hydration.
    await waitFor(() => expect(screen.getByTestId('inbox')).toBeTruthy());
    expect(fireDueScheduled).toHaveBeenCalledTimes(1);
    for (const spy of hydrateSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('does not continue an account-A catch-up chain with account-B services', async () => {
    const stuckA = deferred<{ eligible: number; sent: number }>();
    recoverOutgoingMock.mockReturnValueOnce(stuckA.promise);
    await renderWithTheme(<Home />);
    await waitFor(() => expect(recoverOutgoing).toHaveBeenCalledTimes(1));

    // Invalidate A's mount lease, then model a successful B connection before A's delayed service
    // continuation returns. Every service captures its own lease, so Home must stop BEFORE calling
    // the next one or that next call would otherwise be accepted as B work.
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      stuckA.resolve({ eligible: 0, sent: 0 });
      await stuckA.promise;
      await Promise.resolve();
    });

    expect(fireDueScheduled).not.toHaveBeenCalled();
  });

  it('keeps a delayed preference hydrate inside the account-A teardown barrier', async () => {
    const hydrateA = deferred<void>();
    hydrateSpies[0]!.mockReturnValueOnce(hydrateA.promise);
    await renderWithTheme(<Home />);
    await waitFor(() => expect(hydrateSpies[0]).toHaveBeenCalledTimes(1));

    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    await act(async () => {
      hydrateA.resolve(undefined);
      await hydrateA.promise;
      await teardown;
    });
    expect(teardownFinished).toBe(true);
    resumeRealtimeDeliveries();
  });
});

describe('Home route — DEV overlay actions', () => {
  it('kicks inject, queue-without-drain, and FaceTime helpers from their buttons', async () => {
    isDevServerMock.mockReturnValue(true);
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('⚡ Inject'));
    await waitFor(() =>
      expect(injectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
    fireEvent.press(screen.getByText('⏸ Queue'));
    await waitFor(() =>
      expect(devQueueIncomingMessageWithoutDrain).toHaveBeenCalledWith(
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
    fireEvent.press(screen.getByText('📞 FaceTime'));
    await waitFor(() =>
      expect(devInjectIncomingFaceTime).toHaveBeenCalledWith(
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });

  it('logs only safe metadata when a DEV action fails', async () => {
    isDevServerMock.mockReturnValue(true);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    devQueueIncomingMessageMock.mockRejectedValueOnce(
      new Error('SQL parameters included private fixture payload'),
    );
    await renderWithTheme(<Home />);

    fireEvent.press(screen.getByText('⏸ Queue'));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[home] DEV persist-without-drain proof failed', {
        errorName: 'Error',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private fixture payload');
  });

  it('routes Find My via expo-router push', async () => {
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('📍 Find My'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/findmy'));
  });

  it('quietly drops retained account-A DEV callbacks after account B is admitted', async () => {
    isDevServerMock.mockReturnValue(true);
    await renderWithTheme(<Home />);
    await waitFor(() => expect(runDueScheduled).toHaveBeenCalledTimes(1));
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    // RNTL 14's press helper opens an async React 19 act scope. Await each retained callback in
    // sequence so the test itself does not leave overlapping act scopes behind for the next case.
    await fireEvent.press(screen.getByText('⚡ Inject'));
    await fireEvent.press(screen.getByText('⏸ Queue'));
    await fireEvent.press(screen.getByText('📞 FaceTime'));
    await fireEvent.press(screen.getByText('📍 Find My'));
    await fireEvent.press(screen.getByText('Disconnect'));

    expect(injectMessage).not.toHaveBeenCalled();
    expect(devQueueIncomingMessageWithoutDrain).not.toHaveBeenCalled();
    expect(devInjectIncomingFaceTime).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('drains an admitted DEV write before account-A teardown completes', async () => {
    const injectionA = deferred<void>();
    injectMessageMock.mockReturnValueOnce(injectionA.promise);
    await renderWithTheme(<Home />);

    fireEvent.press(screen.getByText('⚡ Inject'));
    await waitFor(() => expect(injectMessage).toHaveBeenCalledTimes(1));
    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    await act(async () => {
      injectionA.resolve(undefined);
      await injectionA.promise;
      await teardown;
    });
    expect(teardownFinished).toBe(true);
    resumeRealtimeDeliveries();
  });

  it('Disconnect forgets the session then replaces to /welcome', async () => {
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('Disconnect'));
    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/welcome'));
  });

  it('lets forget own the teardown barrier without waiting on its own callback', async () => {
    forgetMock.mockImplementationOnce(async () => {
      await pauseRealtimeDeliveries();
    });
    await renderWithTheme(<Home />);
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByText('Disconnect'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/welcome'));
    resumeRealtimeDeliveries();
  });

  it('reports incomplete account cleanup and still leaves the account UI', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    forgetMock.mockRejectedValueOnce(new Error('credential removal unconfirmed'));
    await renderWithTheme(<Home />);

    fireEvent.press(screen.getByText('Disconnect'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/welcome'));
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Disconnect incomplete',
      message:
        'Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.',
    });
    expect(warn).toHaveBeenCalledWith(
      '[home] Disconnect cleanup remains incomplete',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
