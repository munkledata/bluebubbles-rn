import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { DownloadIntegrityReport } from '@/services/download/downloadIntegrityDiagnostics';

const mockBack = jest.fn();
const mockCollect = jest.fn();
const mockLease = { generation: 7, isCurrent: () => true };

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
  subscribeRealtimeGenerationInvalidation: () => () => undefined,
}));
jest.mock('@/services/download/downloadIntegrityDiagnostics', () => ({
  collectDownloadIntegrityDiagnostics: (...args: unknown[]) => mockCollect(...args),
}));

// eslint-disable-next-line import/first
import DownloadIntegrityScreen from '../../../app/(app)/download-integrity';

function report(appBuild = '74'): DownloadIntegrityReport {
  return {
    candidate: {
      appVersion: '0.1.54',
      appBuild,
      androidApi: '37',
      migrationCount: 49,
      migrationHead: '0049_inbox_search_postings',
    },
    databaseAndOwnershipMatched: true,
    downloads: {
      activeTransfers: 1,
      activeDestinations: 1,
      partialInspection: 'verified',
      partialFiles: 1,
      partialBytes: 0,
    },
    receipts: {
      pending: 1,
      completed: 0,
      terminal: 0,
      gallery: 1,
      album: 0,
      attempts0: 1,
      attempts1: 0,
      attempts2: 0,
      attempts3: 0,
      leased: 0,
      latestPresent: true,
      latestPending: true,
      latestCompleted: false,
      latestTerminal: false,
      latestGallery: true,
      latestAlbum: false,
      latestLeased: false,
      latestAttempts: 0,
      latestHasLocalPath: false,
    },
    coordinator: {
      reservations: 1,
      reservedBytes: 10 * 1024 * 1024,
      retirementOwners: 0,
      pendingRetirements: 0,
      protectedPaths: 1,
      protectionOwners: 1,
    },
    cache: {
      ledgerFiles: 2,
      ledgerBytes: 2 * 1024 * 1024 * 1024,
      activeFiles: 1,
      activeBytes: 100,
      reservedFiles: 1,
      reservedBytes: 10 * 1024 * 1024,
      retiringFiles: 0,
      retiringBytes: 0,
      withinByteLimit: true,
      withinFileLimit: true,
      nativeInspection: 'verified',
      nativeFiles: 1,
      nativeBytes: 100,
      activeMissing: 0,
      activeByteMismatches: 0,
      reservedPresent: 0,
      reservedMissing: 1,
      retiringPresent: 0,
      retiringMissing: 0,
      untrackedNative: 0,
      settledExact: false,
      currentGenerationFiles: 1,
      foreignGenerationFiles: 0,
      unscopedGenerationFiles: 0,
      legacyLayoutFiles: 0,
      freeSpaceInspection: 'verified',
      availableBytes: 600 * 1024 * 1024,
      freeSpaceFloorMet: true,
    },
    attachments: { rows: 2, localPathRows: 1, distinctLocalPaths: 1 },
    wallpapers: {
      channelRows: 1,
      localPathRows: 1,
      distinctLocalPaths: 1,
      channelWithoutLocalPath: 0,
      localPathWithoutChannel: 0,
      nativeInspection: 'verified',
      nativeFiles: 1,
      nativeBytes: 100,
      withinAdmissionLimit: true,
      withinFinalLimit: true,
      referenceInspection: 'verified',
      validReferences: 1,
      invalidOrMissingReferences: 0,
    },
  };
}

beforeEach(() => {
  mockBack.mockReset();
  mockCollect.mockReset().mockResolvedValue(report());
});

it('renders explicit candidate, receipt, cache, and wallpaper aggregates', async () => {
  await renderWithTheme(<DownloadIntegrityScreen />);

  await waitFor(() => expect(screen.getByText('0.1.54')).toBeTruthy());
  expect(screen.getByText('74')).toBeTruthy();
  expect(screen.getByText('37')).toBeTruthy();
  expect(screen.getByText('2.00 GiB')).toBeTruthy();
  expect(screen.getByText('GALLERY / ALBUM RECEIPTS')).toBeTruthy();
  expect(screen.getByText('SYNCED WALLPAPERS')).toBeTruthy();
  expect(screen.getAllByText('Verified').length).toBeGreaterThan(0);
});

it('refreshes the sanitized report from the header action', async () => {
  mockCollect.mockResolvedValueOnce(report('74')).mockResolvedValueOnce(report('75'));
  await renderWithTheme(<DownloadIntegrityScreen />);
  await waitFor(() => expect(screen.getByText('74')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Refresh download integrity'));
  });

  await waitFor(() => expect(screen.getByText('75')).toBeTruthy());
  expect(mockCollect).toHaveBeenCalledTimes(2);
});

it('shows fixed failure copy without exposing exception text', async () => {
  mockCollect.mockRejectedValueOnce(new Error('PRIVATE-PATH-CANARY'));
  await renderWithTheme(<DownloadIntegrityScreen />);

  await waitFor(() => expect(screen.getByText(/Download integrity is unavailable/)).toBeTruthy());
  expect(screen.queryByText(/PRIVATE-PATH-CANARY/)).toBeNull();
});
