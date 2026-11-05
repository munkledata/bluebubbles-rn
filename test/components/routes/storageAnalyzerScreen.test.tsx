import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { DialogButton } from '@ui/dialog/dialogStore';
import type { StorageBreakdownView } from '@features/storage/useStorageBreakdown';

const mockBack = jest.fn();
const mockLease = {
  generation: 7,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
const mockShowDialog = jest.fn();
const mockShowToast = jest.fn();
const mockSummary = jest.fn();
const mockRemove = jest.fn();
let mockBreakdown: StorageBreakdownView | null = null;
let mockRetire: (() => void) | null = null;

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockRetire = listener;
    return () => undefined;
  },
}));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (title: string, message?: string, buttons?: DialogButton[]) =>
    mockShowDialog(title, message, buttons),
}));
jest.mock('@ui/toast/toastStore', () => ({
  showToast: (message: string) => mockShowToast(message),
}));
jest.mock('@features/storage/chatDownloads', () => ({
  loadChatDownloadedFilesSummary: (guid: string) => mockSummary(guid),
}));
jest.mock('@/services/download/removeChatDownloads', () => ({
  removeChatDownloadedFiles: (guid: string, lease: unknown) => mockRemove(guid, lease),
}));
jest.mock('@features/storage/useStorageBreakdown', () => ({
  useStorageBreakdown: () => mockBreakdown,
}));

// eslint-disable-next-line import/first
import StorageAnalyzerScreen from '../../../app/(app)/storage-analyzer';

const MB = 1024 * 1024;

beforeEach(() => {
  jest.clearAllMocks();
  mockLease.current = true;
  mockRetire = null;
  mockSummary.mockResolvedValue({ files: 28, bytes: 100 * MB, keptFiles: 2 });
  mockRemove.mockResolvedValue({ status: 'complete', removed: 27, failed: 0, kept: 1 });
  mockBreakdown = {
    totalFiles: 40,
    totalBytes: 150 * MB,
    topChats: [
      { chatGuid: 'chat-a', files: 30, bytes: 120 * MB },
      { chatGuid: 'chat-b', files: 1, bytes: 10 * MB },
    ],
    otherFiles: 9,
    otherBytes: 20 * MB,
    titles: { 'chat-a': 'Family', 'chat-b': 'Jordan' },
  };
});

describe('StorageAnalyzerScreen', () => {
  it('shows the total, the largest chats and other files', async () => {
    await renderWithTheme(<StorageAnalyzerScreen />);
    expect(screen.getByText('150 MB · 40 files')).toBeTruthy();
    expect(screen.getByText('Family')).toBeTruthy();
    expect(screen.getByText('120 MB · 30 files')).toBeTruthy();
    expect(screen.getByText('10 MB · 1 file')).toBeTruthy();
    expect(screen.getByText('Other files')).toBeTruthy();
  });

  it('says so when nothing is downloaded', async () => {
    mockBreakdown = {
      totalFiles: 0,
      totalBytes: 0,
      topChats: [],
      otherFiles: 0,
      otherBytes: 0,
      titles: {},
    };
    await renderWithTheme(<StorageAnalyzerScreen />);
    expect(screen.getByText('No downloaded files yet.')).toBeTruthy();
    expect(screen.queryByText('Other files')).toBeNull();
  });

  it("stops showing the old account's numbers the moment it is retired", async () => {
    await renderWithTheme(<StorageAnalyzerScreen />);
    expect(screen.getByText('Family')).toBeTruthy();
    await act(async () => {
      mockRetire?.();
    });
    expect(screen.queryByText('Family')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('confirms, then removes only the tapped chat’s files and reports what stayed', async () => {
    await renderWithTheme(<StorageAnalyzerScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Family, 120 MB · 30 files' }));
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledTimes(1));
    expect(mockSummary).toHaveBeenCalledWith('chat-a');
    const [title, message, buttons] = mockShowDialog.mock.calls[0] as [
      string,
      string,
      DialogButton[],
    ];
    expect(title).toBe('Remove downloaded files for Family?');
    expect(message).toBe(
      '100 MB · 28 files will be removed from this phone. Messages stay, and each file downloads again when you open it. 2 files stay, because another chat or Gator still uses them.',
    );
    expect(mockRemove).not.toHaveBeenCalled();

    await act(async () => {
      buttons.find((b) => b.text === 'Remove')?.onPress?.();
    });
    expect(mockRemove).toHaveBeenCalledWith('chat-a', mockLease);
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        'Removed 27 files. 1 file was kept because Gator is still using it.',
      ),
    );
  });

  it('says there is nothing to remove when every file is shared', async () => {
    mockSummary.mockResolvedValue({ files: 0, bytes: 0, keptFiles: 1 });
    await renderWithTheme(<StorageAnalyzerScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Jordan, 10 MB · 1 file' }));
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Nothing to remove',
        'Jordan has no downloaded files that can be removed. 1 file stays, because another chat or Gator still uses it.',
        [expect.objectContaining({ text: 'OK' })],
      ),
    );
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('does not remove anything for a retired account', async () => {
    await renderWithTheme(<StorageAnalyzerScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Family, 120 MB · 30 files' }));
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledTimes(1));
    const buttons = mockShowDialog.mock.calls[0]?.[2] as DialogButton[];
    mockLease.current = false;
    await act(async () => {
      mockRetire?.();
    });
    await act(async () => {
      buttons.find((b) => b.text === 'Remove')?.onPress?.();
    });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('opens only one confirmation at a time', async () => {
    await renderWithTheme(<StorageAnalyzerScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Family, 120 MB · 30 files' }));
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Jordan, 10 MB · 1 file' }));
    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenCalledTimes(1);

    const buttons = mockShowDialog.mock.calls[0]?.[2] as DialogButton[];
    await act(async () => {
      buttons.find((b) => b.text === 'Cancel')?.onPress?.();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Jordan, 10 MB · 1 file' }));
    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledTimes(2));
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
