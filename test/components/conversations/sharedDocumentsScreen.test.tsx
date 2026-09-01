import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { ChatDocumentRow } from '@db/repositories';

const mockBack = jest.fn();
const mockDownload = jest.fn();
const mockOpenAttachmentFile = jest.fn();
const mockShowToast = jest.fn();
const mockLoadMore = jest.fn();
const mockRetry = jest.fn();
const mockReleaseProtection = jest.fn();
const mockProtectPath = jest.fn<{ path: string; release: () => void } | null, [string]>((path) => ({
  path,
  release: mockReleaseProtection,
}));
const mockLease = {
  generation: 87,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
const mockInvalidationListeners = new Set<() => void>();

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const documentRow: ChatDocumentRow = {
  id: 1,
  guid: 'private-document-guid',
  messageId: 10,
  mimeType: 'application/pdf',
  transferName: 'private-report.pdf',
  totalBytes: 2_621_440,
  height: null,
  width: null,
  blurhash: null,
  hasLivePhoto: 0,
  isSticker: 0,
  hideAttachment: 0,
  localPath: null,
  service: null,
  dateCreated: 123,
};

let mockDocumentsState = {
  data: { items: [documentRow], hasMore: false },
  isLoading: false,
  error: null as Error | null,
  hasMore: false,
  loadingMore: false,
  loadMoreError: null as Error | null,
  loadMore: mockLoadMore,
  retry: mockRetry,
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
}));

jest.mock('@features/conversations/useSharedDocuments', () => ({
  useSharedDocuments: () => mockDocumentsState,
}));

jest.mock('@/services/download', () => ({
  download: (...args: unknown[]) => mockDownload(...args),
}));

jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => mockProtectPath(path) },
}));

jest.mock('@/services/openFile', () => ({
  openAttachmentFile: (...args: unknown[]) => mockOpenAttachmentFile(...args),
}));

jest.mock('@ui/toast/toastStore', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockInvalidationListeners.add(listener);
    return () => mockInvalidationListeners.delete(listener);
  },
}));

// eslint-disable-next-line import/first
import { SharedDocumentsScreen } from '@ui/conversations/SharedDocumentsScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockLease.current = true;
  mockInvalidationListeners.clear();
  useDownloadStore.setState({ progress: {}, status: {} });
  mockOpenAttachmentFile.mockResolvedValue({ status: 'opened' });
  mockDownload.mockResolvedValue(null);
  mockProtectPath.mockReset().mockImplementation((path) => ({
    path,
    release: mockReleaseProtection,
  }));
  mockDocumentsState = {
    data: { items: [documentRow], hasMore: false },
    isLoading: false,
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMoreError: null,
    loadMore: mockLoadMore,
    retry: mockRetry,
  };
});

describe('SharedDocumentsScreen', () => {
  it('shows privacy-safe metadata and explicitly downloads or retries an undownloaded file', async () => {
    const view = await renderWithTheme(<SharedDocumentsScreen chatGuid="private-chat" />);

    expect(screen.getByText('private-report.pdf')).toBeTruthy();
    expect(screen.getByText('PDF • 2.5 MB')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Download private-report.pdf' }));
    expect(mockDownload).toHaveBeenCalledWith(documentRow, 'manual', mockLease);

    await act(async () => {
      useDownloadStore.setState({ status: { [documentRow.guid]: 'error' }, progress: {} });
    });
    await view.rerender(<SharedDocumentsScreen chatGuid="private-chat" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry private-report.pdf' }));
    expect(mockDownload).toHaveBeenCalledTimes(2);
  });

  it('opens a downloaded file and consumes a no-handler result with fixed user feedback', async () => {
    const downloaded = { ...documentRow, localPath: 'file:///documents/private-report.pdf' };
    mockDocumentsState = {
      ...mockDocumentsState,
      data: { items: [downloaded], hasMore: false },
    };
    mockOpenAttachmentFile.mockResolvedValue({ status: 'no_handler' });
    const view = await renderWithTheme(<SharedDocumentsScreen chatGuid="private-chat" />);

    await fireEvent.press(screen.getByRole('button', { name: 'Open private-report.pdf' }));
    await waitFor(() =>
      expect(mockOpenAttachmentFile).toHaveBeenCalledWith(
        'file:///documents/private-report.pdf',
        'application/pdf',
        { isCurrent: expect.any(Function) },
      ),
    );
    expect(mockShowToast).toHaveBeenCalledWith('No app on this device can open PDF files');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockProtectPath).toHaveBeenCalledWith('file:///documents/private-report.pdf');
    await view.unmount();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });

  it('refuses to open a local document while cache retirement owns its path', async () => {
    const downloaded = { ...documentRow, localPath: 'file:///documents/private-report.pdf' };
    mockDocumentsState = {
      ...mockDocumentsState,
      data: { items: [downloaded], hasMore: false },
    };
    mockProtectPath.mockReturnValueOnce(null);
    await renderWithTheme(<SharedDocumentsScreen chatGuid="private-chat" />);

    const action = screen.getByRole('button', { name: 'Unavailable private-report.pdf' });
    expect(action).toBeDisabled();
    await fireEvent.press(action);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('loads the next bounded prefix and removes private rows when the account retires', async () => {
    mockDocumentsState = {
      ...mockDocumentsState,
      data: { items: [documentRow], hasMore: true },
      hasMore: true,
    };
    const view = await renderWithTheme(<SharedDocumentsScreen chatGuid="private-chat" />);

    await fireEvent(screen.getByTestId('shared-documents-list'), 'endReached', {
      distanceFromEnd: 0,
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);

    mockLease.current = false;
    await act(async () => {
      for (const listener of mockInvalidationListeners) listener();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Conversation account changed. Go back and reopen Shared Documents.',
    );
    expect(JSON.stringify(view.toJSON())).not.toContain('private-report.pdf');
  });
});
