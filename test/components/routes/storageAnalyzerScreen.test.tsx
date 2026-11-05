import React from 'react';
import { act, renderWithTheme, screen } from '../support/renderWithTheme';
import type { StorageBreakdownView } from '@features/storage/useStorageBreakdown';

const mockBack = jest.fn();
const mockLease = { generation: 7, isCurrent: () => true };
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
jest.mock('@features/storage/useStorageBreakdown', () => ({
  useStorageBreakdown: () => mockBreakdown,
}));

// eslint-disable-next-line import/first
import StorageAnalyzerScreen from '../../../app/(app)/storage-analyzer';

const MB = 1024 * 1024;

beforeEach(() => {
  mockRetire = null;
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
});
