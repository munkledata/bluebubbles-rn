/**
 * Native-share capture and protected-tree navigation.
 *
 * Capture is mounted above App Lock and owns the native subscription. Navigation is mounted only
 * inside the connected tree and carries the exact staged batch id to either recipient review or a
 * resolved Direct Share conversation. Neither component consumes the durable batch on mount.
 */
import React from 'react';
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
jest.mock('@ui/useChatNavigator', () => ({ useChatNavigator: () => mockOpenChat }));
jest.mock('@/services/share/shareIntake', () => ({
  consumeShareIntakeBatchIfComplete: jest.fn(),
  drainShareIntake: jest.fn(() => Promise.resolve()),
  isShareIntakeReceiptComplete: jest.fn(),
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
  readShareIntakeReceipt,
  startShareIntake,
} from '@/services/share/shareIntake';
// eslint-disable-next-line import/first
import { resolveShareShortcutTarget } from '@/services/shortcuts/shareShortcuts';

const mockStartShareIntake = startShareIntake as jest.Mock;
const mockConsumeIfComplete = consumeShareIntakeBatchIfComplete as jest.Mock;
const mockDrainShareIntake = drainShareIntake as jest.Mock;
const mockGetReceipt = readShareIntakeReceipt as jest.Mock;
const mockIsReceiptComplete = isShareIntakeReceiptComplete as jest.Mock;
const mockResolveShareShortcutTarget = resolveShareShortcutTarget as jest.Mock;

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
