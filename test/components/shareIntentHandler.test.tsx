/**
 * Native-share capture and protected-tree navigation.
 *
 * Capture is mounted above App Lock and owns the native subscription. Navigation is mounted only
 * inside the connected tree and carries the exact staged batch id to either recipient review or a
 * resolved Direct Share conversation. Neither component consumes the durable batch on mount.
 */
import React from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { act, waitFor } from '@testing-library/react-native';
import { renderWithTheme } from './support/renderWithTheme';
import { logger } from '@core/secure';
import { useShareIntentStore } from '@state/shareIntentStore';

const BATCH_ONE = '1700000000000-1-0123456789abcdef';
const BATCH_TWO = '1700000000001-2-fedcba9876543210';
const TARGET_TOKEN = `gator-share-v2-${'A'.repeat(43)}`;
const DIRECT_GUID = 'iMessage;-;+15551234567';

const mockPush = jest.fn();
const mockOpenChat = jest.fn();
const mockRouter = { push: mockPush };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));
const mockNavigatorRender = { fail: false };
jest.mock('@ui/useChatNavigator', () => ({
  useChatNavigator: () => {
    if (mockNavigatorRender.fail) throw new Error('navigator render failed');
    return mockOpenChat;
  },
}));
jest.mock('@/services/share/shareIntake', () => ({
  consumeShareIntakeBatchIfComplete: jest.fn(),
  drainShareIntake: jest.fn(() => Promise.resolve()),
  isShareIntakeReceiptComplete: jest.fn(),
  noteShareIntakeForeground: jest.fn(),
  readShareIntakeReceipt: jest.fn(),
  startShareIntake: jest.fn(),
}));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({
  resolveShareShortcutTarget: jest.fn(),
}));

// eslint-disable-next-line import/first
import { ShareIntentCapture, ShareIntentNavigator } from '@ui/ShareIntentHandler';
// eslint-disable-next-line import/first
import {
  consumeShareIntakeBatchIfComplete,
  drainShareIntake,
  isShareIntakeReceiptComplete,
  noteShareIntakeForeground,
  readShareIntakeReceipt,
  startShareIntake,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { resolveShareShortcutTarget } from '@/services/shortcuts/shareShortcuts';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockStartShareIntake = startShareIntake as jest.Mock;
const mockConsumeIfComplete = consumeShareIntakeBatchIfComplete as jest.Mock;
const mockDrainShareIntake = drainShareIntake as jest.Mock;
const mockGetReceipt = readShareIntakeReceipt as jest.Mock;
const mockIsReceiptComplete = isShareIntakeReceiptComplete as jest.Mock;
const mockResolveShareShortcutTarget = resolveShareShortcutTarget as jest.Mock;
const mockNoteForeground = noteShareIntakeForeground as jest.Mock;
let recorded: jest.SpyInstance;

function routeEvent(outcome: string, target?: string): [string, object] {
  return ['share.intake', { stage: 'route', outcome, ...(target === undefined ? {} : { target }) }];
}

function stageShare(
  batchId: string,
  options: { text?: string | null; targetToken?: string | null } = {},
): void {
  useShareIntentStore.setState({
    batchId,
    createdAtMs: 1_700_000_000_000,
    text: options.text ?? null,
    files: [
      {
        uri: `file:///data/no_backup/shared-in/files/${batchId}/00-photo.jpg`,
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 42,
        origin: 'share',
        shareItemIndex: 0,
      },
    ],
    targetToken: options.targetToken ?? null,
    failureReason: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStartShareIntake.mockReturnValue(jest.fn());
  mockResolveShareShortcutTarget.mockResolvedValue(null);
  mockGetReceipt.mockResolvedValue(null);
  mockIsReceiptComplete.mockReturnValue(false);
  mockConsumeIfComplete.mockResolvedValue(true);
  mockDrainShareIntake.mockResolvedValue(undefined);
  useShareIntentStore.getState().clear();
  useShareIntentStore.setState({ failureReason: null });
  recorded = jest.spyOn(logger, 'event').mockImplementation(() => undefined);
  mockNavigatorRender.fail = false;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ShareIntentCapture', () => {
  it('owns the native intake subscription for exactly its mount lifetime', async () => {
    const unsubscribe = jest.fn();
    mockStartShareIntake.mockReturnValue(unsubscribe);

    const view = await renderWithTheme(<ShareIntentCapture />);
    expect(mockStartShareIntake).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('notes a held share each time the app comes to the foreground, while mounted', async () => {
    const subscriptions: { listener: (state: AppStateStatus) => void; remove: jest.Mock }[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      const remove = jest.fn();
      subscriptions.push({ listener: listener as (state: AppStateStatus) => void, remove });
      return { remove } as unknown as NativeEventSubscription;
    });

    const view = await renderWithTheme(<ShareIntentCapture />);
    subscriptions.forEach(({ listener }) => listener('background'));
    expect(mockNoteForeground).not.toHaveBeenCalled();
    subscriptions.forEach(({ listener }) => listener('active'));
    expect(mockNoteForeground).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(subscriptions.length).toBeGreaterThan(0);
    subscriptions.forEach(({ remove }) => expect(remove).toHaveBeenCalledTimes(1));
  });
});

describe('ShareIntentNavigator', () => {
  it('does not navigate when the store has no exact staged batch', async () => {
    await renderWithTheme(<ShareIntentNavigator />);

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockOpenChat).not.toHaveBeenCalled();
  });

  it('routes an exact generic batch to recipient review without clearing it on mount', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    stageShare(BATCH_ONE, { text: 'Shared note' });

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(mockOpenChat).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('[share] opening generic recipient review');
    expect(recorded).toHaveBeenCalledWith(...routeEvent('new-chat', 'none'));
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: BATCH_ONE,
      text: 'Shared note',
      targetToken: null,
    });
  });

  it('routes a resolved Direct Share target through chat navigation with the same batch id', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    mockResolveShareShortcutTarget.mockResolvedValue(DIRECT_GUID);
    stageShare(BATCH_ONE, { targetToken: TARGET_TOKEN });

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockOpenChat).toHaveBeenCalledWith(
        `/chat/${encodeURIComponent(DIRECT_GUID)}?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(mockResolveShareShortcutTarget).toHaveBeenCalledWith(
      TARGET_TOKEN,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('[share] opening resolved Direct Share target');
    expect(recorded).toHaveBeenCalledWith(...routeEvent('chat', 'resolved'));
    expect(useShareIntentStore.getState().batchId).toBe(BATCH_ONE);
  });

  it('falls back to recipient review after one Direct Share no-match', async () => {
    stageShare(BATCH_ONE, { targetToken: TARGET_TOKEN });

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(mockResolveShareShortcutTarget).toHaveBeenCalledTimes(1);
    expect(mockOpenChat).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith(...routeEvent('new-chat', 'unresolved'));
  });

  it('does not route an in-flight Direct Share result after the protected tree unmounts', async () => {
    let finishResolution!: (value: string | null) => void;
    mockResolveShareShortcutTarget.mockReturnValue(
      new Promise<string | null>((resolve) => {
        finishResolution = resolve;
      }),
    );
    stageShare(BATCH_ONE, { targetToken: TARGET_TOKEN });

    const view = await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockResolveShareShortcutTarget).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => finishResolution(DIRECT_GUID));

    expect(mockOpenChat).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith(...routeEvent('inactive'));
  });

  it('resumes a durable new-chat plan before consulting a stale Direct Share target', async () => {
    mockGetReceipt.mockResolvedValue({
      destination: null,
      newChatPlan: { address: '+15551234567' },
      items: {},
    });
    mockResolveShareShortcutTarget.mockResolvedValue(DIRECT_GUID);
    stageShare(BATCH_ONE, { targetToken: TARGET_TOKEN });

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(mockResolveShareShortcutTarget).not.toHaveBeenCalled();
    expect(mockOpenChat).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith(...routeEvent('resume-new-chat'));
  });

  it('routes a completed durable receipt without replaying its batch', async () => {
    mockGetReceipt.mockResolvedValue({
      destination: { chatGuid: DIRECT_GUID, routeKind: 'new_chat' },
      newChatPlan: { address: '+15551234567' },
      items: {},
    });
    mockIsReceiptComplete.mockReturnValue(true);
    stageShare(BATCH_ONE, { targetToken: TARGET_TOKEN });

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockOpenChat).toHaveBeenCalledWith(`/chat/${encodeURIComponent(DIRECT_GUID)}`),
    );
    expect(mockConsumeIfComplete).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ONE, fileCount: 1 }),
      expect.objectContaining({
        drainNext: false,
        lease: expect.objectContaining({ isCurrent: expect.any(Function) }),
      }),
    );
    expect(mockOpenChat.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDrainShareIntake.mock.invocationCallOrder[0]!,
    );
    expect(mockResolveShareShortcutTarget).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledWith(...routeEvent('completed'));
  });

  it('resumes a partial durable destination in its chat', async () => {
    mockGetReceipt.mockResolvedValue({
      destination: { chatGuid: DIRECT_GUID, routeKind: 'existing_chat' },
      newChatPlan: null,
      items: {},
    });
    stageShare(BATCH_ONE);

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockOpenChat).toHaveBeenCalledWith(
        `/chat/${encodeURIComponent(DIRECT_GUID)}?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(recorded).toHaveBeenCalledWith(...routeEvent('resume-chat'));
  });

  it('sends the share to review after two retries, recording each attempt', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockGetReceipt.mockRejectedValue(new Error('receipt read keeps failing'));
    stageShare(BATCH_ONE);

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    const routeOutcomes = recorded.mock.calls
      .filter(([code]) => code === 'share.intake')
      .map(([, meta]) => (meta as { outcome: string }).outcome);
    expect(routeOutcomes).toEqual(['retry', 'retry', 'review']);
  });

  it('records a completed share whose navigator unmounted before it could open the chat', async () => {
    let finishConsume!: (value: boolean) => void;
    mockGetReceipt.mockResolvedValue({
      destination: { chatGuid: DIRECT_GUID, routeKind: 'new_chat' },
      newChatPlan: null,
      items: {},
    });
    mockIsReceiptComplete.mockReturnValue(true);
    mockConsumeIfComplete.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishConsume = resolve;
      }),
    );
    stageShare(BATCH_ONE);

    const view = await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockConsumeIfComplete).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => finishConsume(true));

    await waitFor(() => expect(recorded).toHaveBeenCalledWith(...routeEvent('inactive')));
    expect(mockOpenChat).not.toHaveBeenCalled();
  });

  it('records a share abandoned before its route was chosen', async () => {
    let finishRead!: (value: null) => void;
    mockGetReceipt.mockReturnValue(
      new Promise<null>((resolve) => {
        finishRead = resolve;
      }),
    );
    stageShare(BATCH_ONE);

    const view = await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockGetReceipt).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => finishRead(null));

    await waitFor(() => expect(recorded).toHaveBeenCalledWith(...routeEvent('inactive')));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('records a failure that lands after the navigator unmounted, without retrying', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let failRead!: (error: Error) => void;
    mockGetReceipt.mockReturnValue(
      new Promise<null>((_resolve, reject) => {
        failRead = reject;
      }),
    );
    stageShare(BATCH_ONE);

    const view = await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockGetReceipt).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => failRead(new Error('receipt read failed late')));

    await waitFor(() => expect(recorded).toHaveBeenCalledWith(...routeEvent('inactive')));
    expect(recorded).not.toHaveBeenCalledWith(...routeEvent('retry'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('records a route that stops because account work was paused during the receipt read', async () => {
    let finishRead!: (value: null) => void;
    mockGetReceipt.mockReturnValue(
      new Promise<null>((resolve) => {
        finishRead = resolve;
      }),
    );
    stageShare(BATCH_ONE);

    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockGetReceipt).toHaveBeenCalledTimes(1));
    const paused = pauseRealtimeDeliveries();
    try {
      await act(async () => finishRead(null));
      await paused;
      await waitFor(() => expect(recorded).toHaveBeenCalledWith(...routeEvent('not-delivered')));
      expect(mockPush).not.toHaveBeenCalled();
    } finally {
      resumeRealtimeDeliveries();
    }
  });

  it('retries a transient reconciliation failure instead of stranding the staged batch', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockGetReceipt.mockRejectedValueOnce(new Error('temporary receipt read failure'));
    stageShare(BATCH_ONE);

    await renderWithTheme(<ShareIntentNavigator />);

    await waitFor(() => expect(mockGetReceipt).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
      ),
    );
    expect(recorded).toHaveBeenCalledWith(...routeEvent('retry'));
    expect(recorded).toHaveBeenCalledWith(...routeEvent('new-chat', 'none'));
  });

  it('re-arms only after the exact staged batch is cleared', async () => {
    jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    await act(async () => {
      useShareIntentStore.getState().clearIf(BATCH_ONE);
    });
    await act(async () => {
      stageShare(BATCH_TWO);
    });

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
    expect(mockPush).toHaveBeenLastCalledWith(
      `/new-chat?shareBatch=${encodeURIComponent(BATCH_TWO)}`,
    );
  });
});

describe('share recovery in the capture and navigator', () => {
  const WAITING = 'Finish or discard your earlier shared item; your new share is waiting.';
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    useToastStore.setState({ current: null, queue: [] });
  });

  function toastMessages(): string[] {
    const { current, queue } = useToastStore.getState();
    return [current, ...queue].flatMap((toast) => (toast ? [toast.message] : []));
  }

  function captureAppState(): ((state: AppStateStatus) => void)[] {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: jest.fn() } as unknown as NativeEventSubscription;
    });
    return listeners;
  }

  async function requestReroute(): Promise<void> {
    await act(async () => {
      useShareIntentStore.getState().requestReroute();
    });
  }

  it('opens a held share again when no screen shows it after its route', async () => {
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    now += 3_000;
    await requestReroute();

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
    expect(mockPush).toHaveBeenLastCalledWith(
      `/new-chat?shareBatch=${encodeURIComponent(BATCH_ONE)}`,
    );
    expect(recorded).toHaveBeenCalledWith(...routeEvent('reopened'));
  });

  it('leaves a held share alone while a screen shows it', async () => {
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    const release = useShareIntentStore.getState().adopt(BATCH_ONE);

    now += 60_000;
    await requestReroute();

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(recorded).not.toHaveBeenCalledWith(...routeEvent('reopened'));
    release();
  });

  it('gives a route it just sent a few seconds to show its screen', async () => {
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    now += 2_999;
    await requestReroute();

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(recorded).not.toHaveBeenCalledWith(...routeEvent('reopened'));
  });

  it('does not reopen a share whose route is still being worked out', async () => {
    let finishRead!: (value: null) => void;
    mockGetReceipt.mockReturnValue(
      new Promise<null>((resolve) => {
        finishRead = resolve;
      }),
    );
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockGetReceipt).toHaveBeenCalledTimes(1));

    now += 60_000;
    await requestReroute();
    await act(async () => finishRead(null));

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(mockGetReceipt).toHaveBeenCalledTimes(1);
    expect(recorded).not.toHaveBeenCalledWith(...routeEvent('reopened'));
  });

  it('says a newer share is waiting for each notice raised after it mounts', async () => {
    useShareIntentStore.getState().noteWaitingShare();
    await renderWithTheme(<ShareIntentNavigator />);
    expect(toastMessages()).toEqual([]);

    await act(async () => {
      useShareIntentStore.getState().noteWaitingShare();
    });
    expect(toastMessages()).toEqual([WAITING]);
  });

  it('explains a failed pickup', async () => {
    await renderWithTheme(<ShareIntentNavigator />);
    await act(async () => {
      useShareIntentStore.getState().setFailureReason('pickup');
    });
    expect(toastMessages()).toEqual([
      'Gator could not open a shared item. It will try again the next time you open Gator.',
    ]);
  });

  it('remounts a failed navigator the next time the app comes to the foreground', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const listeners = captureAppState();
    mockNavigatorRender.fail = true;
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).not.toHaveBeenCalled();

    mockNavigatorRender.fail = false;
    await act(async () => listeners.forEach((listener) => listener('active')));

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(recorded).toHaveBeenCalledWith('share.intake', {
      stage: 'route',
      outcome: 'boundary-reset',
    });
  });

  it('does not open a second screen for a share a screen shows when a failed navigator remounts', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const listeners = captureAppState();
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    const release = useShareIntentStore.getState().adopt(BATCH_ONE);
    mockNavigatorRender.fail = true;
    await act(async () => {
      useShareIntentStore.getState().noteWaitingShare();
    });

    mockNavigatorRender.fail = false;
    await act(async () => listeners.forEach((listener) => listener('active')));
    expect(recorded).toHaveBeenCalledWith('share.intake', {
      stage: 'route',
      outcome: 'boundary-reset',
    });
    await act(async () => undefined);
    expect(mockPush).toHaveBeenCalledTimes(1);

    // When that screen closes without settling the share, a reopen request still routes it.
    release();
    await requestReroute();
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
    expect(recorded).toHaveBeenCalledWith(...routeEvent('reopened'));
  });

  it('does not remount a healthy navigator on return to the foreground', async () => {
    const listeners = captureAppState();
    stageShare(BATCH_ONE);
    await renderWithTheme(<ShareIntentNavigator />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    await act(async () => listeners.forEach((listener) => listener('active')));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(recorded).not.toHaveBeenCalledWith('share.intake', {
      stage: 'route',
      outcome: 'boundary-reset',
    });
  });

  it('remounts a failed capture the next time the app comes to the foreground', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const listeners = captureAppState();
    mockStartShareIntake.mockImplementation(() => {
      throw new Error('subscribe failed');
    });
    await renderWithTheme(<ShareIntentCapture />);
    const failedStarts = mockStartShareIntake.mock.calls.length;
    expect(failedStarts).toBeGreaterThan(0);

    mockStartShareIntake.mockReturnValue(jest.fn());
    await act(async () => listeners.forEach((listener) => listener('active')));

    await waitFor(() => expect(mockStartShareIntake.mock.calls.length).toBe(failedStarts + 1));
    expect(recorded).toHaveBeenCalledWith('share.intake', {
      stage: 'signal',
      outcome: 'boundary-reset',
    });
  });
});
