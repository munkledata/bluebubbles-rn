/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockReadReceipt = jest.fn();
const mockReceiptComplete = jest.fn();
const mockConsumeIfComplete = jest.fn();
const mockFileSettled = jest.fn();
const mockDrain = jest.fn();
const mockShowDialog = jest.fn();

jest.mock('@/services/share/shareIntake', () => ({
  readShareIntakeReceipt: (...args: unknown[]) => mockReadReceipt(...args),
  isShareIntakeReceiptComplete: (...args: unknown[]) => mockReceiptComplete(...args),
  isShareIntakeFileSettled: (...args: unknown[]) => mockFileSettled(...args),
  consumeShareIntakeBatchIfComplete: (...args: unknown[]) => mockConsumeIfComplete(...args),
  drainShareIntake: (...args: unknown[]) => mockDrain(...args),
  discardShareIntakeItem: jest.fn(),
  admitShareIntakeTextDraft: jest.fn(),
}));
jest.mock('@ui', () => ({ showToast: jest.fn() }));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));
jest.mock('@core/secure', () => ({ logger: { warn: jest.fn() } }));

import {
  useChatShareIntake,
  type ChatShareIntakeOptions,
} from '@features/conversations/useChatShareIntake';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { useShareIntentStore } from '@state/shareIntentStore';
import { act, renderHook, waitFor } from '../support/renderWithTheme';

const CHAT = 'RCS;-;g1.chat';
const BATCH = 'share-batch-1';
const OPEN_RECEIPT = { destination: null, newChatPlan: null, items: {} };

function stageShare(): void {
  useShareIntentStore.setState({
    batchId: BATCH,
    createdAtMs: 1_700_000_000_000,
    text: null,
    files: [
      {
        uri: 'file:///share/photo.jpg',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 10,
        origin: 'share',
        shareItemIndex: 0,
      },
    ],
    targetToken: null,
    failureReason: null,
  });
}

async function openShare(overrides: Partial<ChatShareIntakeOptions> = {}) {
  const options: ChatShareIntakeOptions = {
    guid: CHAT,
    shareBatchId: BATCH,
    accountLease: captureRealtimeDeliveryLease(),
    router: { replace: jest.fn() },
    draft: '',
    setDraft: jest.fn(),
    attachmentFeaturesAvailable: true,
    serverInfoLoaded: true,
    headerGuid: CHAT,
    ...overrides,
  };
  const { result } = await renderHook(() => useChatShareIntake(options));
  await waitFor(() => expect(result.current.shareReceiptLoaded).toBe(true));
  return { result, options };
}

beforeEach(() => {
  stageShare();
  mockReadReceipt.mockResolvedValue(OPEN_RECEIPT);
  mockReceiptComplete.mockReturnValue(false);
  mockFileSettled.mockReturnValue(false);
  mockConsumeIfComplete.mockResolvedValue(true);
  mockDrain.mockResolvedValue(undefined);
});

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
});

describe('useChatShareIntake', () => {
  it('finishes the share once every item is settled and starts the next one', async () => {
    const { result } = await openShare();
    expect(result.current.ownedShareBatchId).toBe(BATCH);
    expect(result.current.shareBatchPending).toBe(true);
    expect(mockConsumeIfComplete).not.toHaveBeenCalled();

    await act(async () => {
      result.current.onShareAdmissionApplied({} as never);
    });

    await waitFor(() => expect(result.current.shareBatchPending).toBe(false));
    // The same service finisher as the share handler and New Message: it re-reads the receipt and
    // acknowledges only a complete one.
    expect(mockConsumeIfComplete).toHaveBeenCalledWith(
      result.current.ownedShareIdentity,
      expect.objectContaining({ drainNext: false }),
    );
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  it('keeps the share pending when its receipt is not complete yet', async () => {
    mockConsumeIfComplete.mockResolvedValue(false);
    const { result } = await openShare();

    await act(async () => {
      result.current.onShareAdmissionApplied({} as never);
    });

    await waitFor(() => expect(mockConsumeIfComplete).toHaveBeenCalledTimes(1));
    expect(result.current.shareBatchPending).toBe(true);
    expect(mockDrain).not.toHaveBeenCalled();
  });

  // M224: finishing (or Back-discarding) re-ran the receipt load; the deleted receipt then read as
  // "nothing settled" and every shared file came back into the tray.
  it('does not put already-sent files back once the share finishes', async () => {
    const completeReceipt = {
      destination: { chatGuid: CHAT },
      newChatPlan: null,
      items: { 'file:00': 'settled' },
    };
    mockReadReceipt.mockResolvedValueOnce(completeReceipt).mockResolvedValue(null);
    mockReceiptComplete.mockImplementation((receipt: unknown) => receipt === completeReceipt);
    mockFileSettled.mockImplementation((receipt: unknown) => receipt === completeReceipt);

    const { result } = await openShare();
    await waitFor(() => expect(result.current.shareBatchPending).toBe(false));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.remainingSharedAttachments).toEqual([]);
    expect(mockReadReceipt).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when this chat can take the shared files', async () => {
    await openShare({ attachmentFeaturesAvailable: true });

    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('offers another conversation, not only Discard, when this chat cannot take the files', async () => {
    const { options } = await openShare({ attachmentFeaturesAvailable: false });

    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledTimes(1));
    const [title, , buttons] = mockShowDialog.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect(title).toBe('This conversation can’t receive files');
    const another = buttons.find((button) => button.text === 'Choose Another Conversation');
    another?.onPress?.();
    expect(options.router.replace).toHaveBeenCalledWith(`/new-chat?shareBatch=${BATCH}`);
  });
});
