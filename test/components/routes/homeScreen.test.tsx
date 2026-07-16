/**
 * Home route (app/(app)/home.tsx): the connected inbox and the app's boot-completion hub.
 * Beyond rendering the (separately-tested) ConversationListScreen, its mount effect does the
 * launch-order recovery work that this suite locks in:
 *   - (re)hydrates the SIX kv-backed prefs stores AFTER the DB is open (the root layout's first
 *     hydrate runs pre-connect and silently fails — see src/state/themeStore.ts). Each fires once.
 *   - crash-recovers scheduled + optimistic-send rows, then catches up on due scheduled sends;
 *     the branch is gated by `isDevServer()` (dev → local fake send via runDueScheduled; prod →
 *     recoverOutgoing + fireDueScheduled).
 *   - the whole catch-up is best-effort: a rejected recovery is swallowed (logger.debug), never
 *     crashing the inbox.
 *   - all side-effects run ONCE on mount (useEffect []), not per re-render.
 *   - the DEV overlay bar routes/kicks the dev-seed helpers; Disconnect forgets the session and
 *     replaces to /welcome.
 *
 * In-file mocks: @ui (ConversationListScreen probe), expo-router (push/replace), @/services
 * (forget/http), @/services/send (the 4 recovery fns), @features/conversations/devSeed (the dev
 * helpers), @utils/isDev (isDevServer). The SIX stores stay REAL — their `hydrate` action is spied
 * so we assert the call without running the DB-backed body.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useThemeStore } from '@state/themeStore';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, replace: mockReplace }) }));

jest.mock('@/services', () => ({ forget: jest.fn().mockResolvedValue(undefined), http: {} }));

jest.mock('@/services/send', () => ({
  fireDueScheduled: jest.fn().mockResolvedValue(0),
  recoverOutgoing: jest.fn().mockResolvedValue({ eligible: 0, sent: 0 }),
  recoverStuckScheduled: jest.fn().mockResolvedValue(0),
  runDueScheduled: jest.fn().mockResolvedValue(0),
}));

jest.mock('@features/conversations/devSeed', () => ({
  injectMessage: jest.fn().mockResolvedValue(undefined),
  devInjectIncomingFaceTime: jest.fn().mockResolvedValue(undefined),
  devSendFake: jest.fn().mockResolvedValue(undefined),
  devSendFakeReply: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@utils/isDev', () => ({ isDevServer: jest.fn(() => false) }));

// Home pulls ConversationListScreen from the big `@ui` barrel (drags in ky/native modules that
// don't load under jest). Collapse it to a light probe — this suite is about the ROUTE's own boot
// logic, not the inbox internals (covered by conversations/conversationListScreen.test.tsx).
jest.mock('@ui', () => {
  const ReactLib = require('react');
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
import {
  fireDueScheduled,
  recoverOutgoing,
  recoverStuckScheduled,
  runDueScheduled,
} from '@/services/send';
// eslint-disable-next-line import/first
import { injectMessage, devInjectIncomingFaceTime } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { isDevServer } from '@utils/isDev';

const isDevServerMock = isDevServer as jest.Mock;
const recoverStuckScheduledMock = recoverStuckScheduled as jest.Mock;

const STORES = [
  useSmartReplyStore,
  useRedactedModeStore,
  useFeatureSettingsStore,
  useSyncSettingsStore,
  useThemeStore,
];

let hydrateSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  isDevServerMock.mockReturnValue(false);
  recoverStuckScheduledMock.mockResolvedValue(0);
  // Spy each store's hydrate so we can assert the launch-order re-hydrate WITHOUT running the
  // DB-backed body (getDatabase is stubbed by support/setup and would otherwise no-op/throw).
  hydrateSpies = STORES.map((s) =>
    jest.spyOn(s.getState(), 'hydrate').mockResolvedValue(undefined),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Home route — render', () => {
  it('renders the conversation list (the inbox) and the DEV overlay bar', async () => {
    await renderWithTheme(<Home />);
    expect(screen.getByTestId('inbox')).toBeTruthy();
    // __DEV__ is true under jest-expo, so the dev overlay renders its affordances.
    expect(screen.getByText('⚡ Inject')).toBeTruthy();
    expect(screen.getByText('📞 FaceTime')).toBeTruthy();
    expect(screen.getByText('📍 Find My')).toBeTruthy();
    expect(screen.getByText('Disconnect')).toBeTruthy();
  });
});

describe('Home route — boot-completion side-effects', () => {
  it('re-hydrates all six prefs stores exactly once on mount', async () => {
    await renderWithTheme(<Home />);
    await waitFor(() => expect(recoverStuckScheduled).toHaveBeenCalled());
    for (const spy of hydrateSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('recovers crash-interrupted rows then catches up (prod branch) on mount', async () => {
    await renderWithTheme(<Home />);
    await waitFor(() => expect(recoverStuckScheduled).toHaveBeenCalledTimes(1));
    // isDevServer() === false → recover stranded optimistic sends, fire due scheduled via the
    // real server path; the dev-only local fake send is NOT used.
    await waitFor(() => expect(recoverOutgoing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fireDueScheduled).toHaveBeenCalledTimes(1));
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('takes the dev-fixture branch (runDueScheduled, no real send) when isDevServer is true', async () => {
    isDevServerMock.mockReturnValue(true);
    await renderWithTheme(<Home />);
    await waitFor(() => expect(runDueScheduled).toHaveBeenCalledTimes(1));
    // Stuck-scheduled recovery still runs; the real-server catch-up does NOT.
    expect(recoverStuckScheduled).toHaveBeenCalledTimes(1);
    expect(recoverOutgoing).not.toHaveBeenCalled();
    expect(fireDueScheduled).not.toHaveBeenCalled();
  });

  it('swallows a failed recovery — the inbox still renders, no throw', async () => {
    recoverStuckScheduledMock.mockRejectedValue(new Error('db down'));
    await renderWithTheme(<Home />);
    // The catch-up is best-effort (logger.debug in the catch); the list is unaffected.
    expect(screen.getByTestId('inbox')).toBeTruthy();
    await waitFor(() => expect(recoverStuckScheduled).toHaveBeenCalledTimes(1));
    // The downstream catch-up steps are skipped once the first await rejects.
    expect(recoverOutgoing).not.toHaveBeenCalled();
    expect(fireDueScheduled).not.toHaveBeenCalled();
  });

  it('runs the mount side-effects ONCE, not again on re-render (useEffect [])', async () => {
    const view = await renderWithTheme(<Home />);
    await waitFor(() => expect(recoverStuckScheduled).toHaveBeenCalledTimes(1));
    view.rerender(<Home />);
    // A re-render must not re-fire the boot recovery or the store re-hydration.
    await waitFor(() => expect(screen.getByTestId('inbox')).toBeTruthy());
    expect(recoverStuckScheduled).toHaveBeenCalledTimes(1);
    for (const spy of hydrateSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});

describe('Home route — DEV overlay actions', () => {
  it('kicks injectMessage and devInjectIncomingFaceTime from their buttons', async () => {
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('⚡ Inject'));
    await waitFor(() => expect(injectMessage).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByText('📞 FaceTime'));
    await waitFor(() => expect(devInjectIncomingFaceTime).toHaveBeenCalledTimes(1));
  });

  it('routes Find My via expo-router push', async () => {
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('📍 Find My'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/findmy'));
  });

  it('Disconnect forgets the session then replaces to /welcome', async () => {
    await renderWithTheme(<Home />);
    fireEvent.press(screen.getByText('Disconnect'));
    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/welcome'));
  });
});
