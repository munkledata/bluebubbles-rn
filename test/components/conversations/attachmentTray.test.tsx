/**
 * AttachmentTray (src/ui/conversations/AttachmentTray.tsx): the inline strip of recent device
 * photos/videos + Camera + Files buttons shown under the composer. This suite locks in the
 * USER-OBSERVABLE behavior derived from the source:
 *   - the Camera + Files buttons always render (they're outside the permission branch);
 *   - Files fires onPickFiles;
 *   - on granted (or limited) media access it loads recent assets and renders a thumbnail per
 *     asset, with a distinct a11y label for photos vs videos;
 *   - tapping a thumbnail stages it via onPick using the resolved localUri + a MIME derived from
 *     the filename extension (mimeFromName), with a raw-uri fallback when getAssetInfoAsync throws;
 *   - undetermined access shows an in-app rationale before the Android prompt;
 *   - denied access and media-load errors keep Camera/Files usable and offer recovery;
 *   - Camera: a successful capture stages via onPick; denied or failed camera permission and a
 *     cancelled capture stage nothing; a video capture with missing fields derives capture.mp4 / video/mp4.
 *
 * In-file mocks: expo-media-library/legacy + expo-image-picker (native modules) are stubbed so the
 * permission/asset/camera flows can be driven deterministically; expo-image (thumbnail renderer)
 * is stubbed to a plain host View.
 */
import React from 'react';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import { act, renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { logger } from '@core/secure';

let mockLeaseCurrent = true;
let mockGenerationInvalidation: (() => void) | undefined;
const mockUnsubscribeInvalidation = jest.fn();

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({
    generation: 1,
    isCurrent: () => mockLeaseCurrent,
  }),
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockGenerationInvalidation = listener;
    return mockUnsubscribeInvalidation;
  },
}));

jest.mock('expo-image', () => {
  // Jest requires these imports inside the hoisted mock factory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => React.createElement(View, props) };
});

jest.mock('expo-media-library/legacy', () => ({
  MediaType: { photo: 'photo', video: 'video' },
  SortBy: { creationTime: 'creationTime' },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getAssetsAsync: jest.fn(),
  getAssetInfoAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

// eslint-disable-next-line import/first
import { AttachmentTray } from '@ui/conversations/AttachmentTray';
// eslint-disable-next-line import/first
import * as MediaLibrary from 'expo-media-library/legacy';
// eslint-disable-next-line import/first
import * as ImagePicker from 'expo-image-picker';

const getPerm = MediaLibrary.getPermissionsAsync as unknown as jest.Mock;
const requestPerm = MediaLibrary.requestPermissionsAsync as unknown as jest.Mock;
const getAssets = MediaLibrary.getAssetsAsync as unknown as jest.Mock;
const getAssetInfo = MediaLibrary.getAssetInfoAsync as unknown as jest.Mock;
const requestCamera = ImagePicker.requestCameraPermissionsAsync as unknown as jest.Mock;
const launchCamera = ImagePicker.launchCameraAsync as unknown as jest.Mock;

afterEach(() => {
  mockLeaseCurrent = true;
  mockGenerationInvalidation = undefined;
  jest.restoreAllMocks();
});

/** A device photo asset as expo-media-library/legacy returns it. */
const PHOTO = {
  id: 'p1',
  uri: 'ph://p1',
  filename: 'IMG_1.jpg',
  mediaType: 'photo',
  width: 100,
  height: 80,
};
const VIDEO = {
  id: 'v1',
  uri: 'ph://v1',
  filename: 'clip.mov',
  mediaType: 'video',
  width: 640,
  height: 480,
};

function grantWith(assets: unknown[]): void {
  getPerm.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
    accessPrivileges: 'all',
  });
  getAssets.mockResolvedValue({ assets });
}

async function waitForMediaCheckToSettle(): Promise<void> {
  await waitFor(() => expect(screen.queryByLabelText('Review photo and video access')).toBeNull());
}

describe('AttachmentTray — always-visible controls', () => {
  it('renders the Camera and Files buttons regardless of permission', async () => {
    getPerm.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
      accessPrivileges: 'none',
    });
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(screen.getByLabelText('Take a photo')).toBeTruthy();
    expect(screen.getByLabelText('Attach a file')).toBeTruthy();
    expect(await screen.findByLabelText('Open Settings')).toBeTruthy();
  });

  it('fires onPickFiles when Files is tapped', async () => {
    const onPickFiles = jest.fn();
    grantWith([]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={onPickFiles} />);
    await waitForMediaCheckToSettle();
    fireEvent.press(screen.getByLabelText('Attach a file'));
    expect(onPickFiles).toHaveBeenCalledTimes(1);
  });
});

describe('AttachmentTray — media library', () => {
  it('checks photo/video status without requesting the audio library or opening a prompt', async () => {
    grantWith([]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    await waitFor(() => expect(getPerm).toHaveBeenCalledWith(false, ['photo', 'video']));
    await waitForMediaCheckToSettle();
    expect(requestPerm).not.toHaveBeenCalled();
  });

  it('explains optional access before Continue launches Android photo/video permission', async () => {
    getPerm.mockResolvedValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      accessPrivileges: 'none',
    });
    requestPerm.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
    });
    getAssets.mockResolvedValue({ assets: [] });

    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(
      await screen.findByText(
        'Gator can show recent photos and videos here for you to attach. Access is optional; Camera and Files still work without it.',
      ),
    ).toBeTruthy();
    expect(requestPerm).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestPerm).toHaveBeenCalledWith(false, ['photo', 'video']));
    await waitFor(() => expect(getAssets).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Photos and videos')).toBeNull());
  });

  it('renders a thumbnail per asset with photo/video-specific labels', async () => {
    grantWith([PHOTO, VIDEO]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByLabelText('Attach photo')).toBeTruthy();
    expect(screen.getByLabelText('Attach video')).toBeTruthy();
  });

  it('loads assets under SDK 57 LIMITED access', async () => {
    getPerm.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'limited',
    });
    getAssets.mockResolvedValue({ assets: [PHOTO] });
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByLabelText('Attach photo')).toBeTruthy();
  });

  it('stages a tapped photo via onPick with the resolved localUri and jpeg MIME', async () => {
    grantWith([PHOTO]);
    getAssetInfo.mockResolvedValue({ localUri: 'file://real/IMG_1.jpg' });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByLabelText('Attach photo'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        uri: 'file://real/IMG_1.jpg',
        name: 'IMG_1.jpg',
        mimeType: 'image/jpeg',
        size: 0,
        width: 100,
        height: 80,
      }),
    );
  });

  it('derives a quicktime MIME for a .mov video and stages it', async () => {
    grantWith([VIDEO]);
    getAssetInfo.mockResolvedValue({ localUri: 'file://real/clip.mov' });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByLabelText('Attach video'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'file://real/clip.mov', mimeType: 'video/quicktime' }),
      ),
    );
  });

  it('falls back to the raw asset uri when getAssetInfoAsync throws', async () => {
    grantWith([PHOTO]);
    const error = new Error('scoped storage');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    getAssetInfo.mockRejectedValue(error);
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByLabelText('Attach photo'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ uri: 'ph://p1' })),
    );
    expect(warn).toHaveBeenCalledWith(
      '[attachment-tray] getAssetInfoAsync failed; staging raw asset uri',
      error,
    );
  });

  it('keeps Camera and Files usable and opens Settings after permanent denial', async () => {
    getPerm.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
      accessPrivileges: 'none',
    });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByText(/Android won't ask again/)).toBeTruthy();
    expect(screen.getByText(/Gator can show recent photos and videos/)).toBeTruthy();
    expect(screen.getByLabelText('Take a photo')).toBeTruthy();
    expect(screen.getByLabelText('Attach a file')).toBeTruthy();
    expect(screen.queryByLabelText('Attach photo')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
  });

  it('repeats the purpose and offers retry plus Settings after an ordinary denial', async () => {
    getPerm.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: true,
      accessPrivileges: 'none',
    });
    requestPerm.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: true,
      accessPrivileges: 'none',
    });

    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByText(/Gator can show recent photos and videos/)).toBeTruthy();
    expect(screen.getByText(/Android previously denied access/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => expect(requestPerm).toHaveBeenCalledWith(false, ['photo', 'video']));
    expect(screen.getByText(/Gator can show recent photos and videos/)).toBeTruthy();
  });

  it('rechecks status without another prompt after returning from Settings', async () => {
    let onAppStateChange: ((state: AppStateStatus) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      onAppStateChange = listener;
      return { remove: jest.fn() };
    });
    getPerm
      .mockResolvedValueOnce({
        status: 'denied',
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      })
      .mockResolvedValueOnce({
        status: 'granted',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
    getAssets.mockResolvedValue({ assets: [] });
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);

    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByRole('button', { name: 'Open Settings' }));
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    await act(async () => {
      onAppStateChange?.('active');
    });

    await waitFor(() => expect(getPerm).toHaveBeenCalledTimes(2));
    await waitForMediaCheckToSettle();
    expect(requestPerm).not.toHaveBeenCalled();
  });

  it('dismisses a visible rationale as soon as its account generation retires', async () => {
    getPerm.mockResolvedValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      accessPrivileges: 'none',
    });

    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByText('Photos and videos')).toBeTruthy();
    mockLeaseCurrent = false;
    await act(async () => {
      mockGenerationInvalidation?.();
    });

    expect(screen.queryByText('Photos and videos')).toBeNull();
  });

  it('does not publish a granted result after the captured account retires', async () => {
    let resolveRequest!: (permission: unknown) => void;
    const pendingRequest = new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    });
    getPerm.mockResolvedValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      accessPrivileges: 'none',
    });
    requestPerm.mockReturnValue(pendingRequest);

    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestPerm).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Photos and videos')).toBeNull();
    mockLeaseCurrent = false;
    await act(async () => {
      resolveRequest({
        status: 'granted',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
      await pendingRequest;
    });

    expect(getAssets).not.toHaveBeenCalled();
  });

  it('shows non-blocking recovery when the media load throws', async () => {
    const error = new Error('boom');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    getPerm.mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
    });
    getAssets.mockRejectedValue(error);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByText(/Gator couldn't check photo and video access/)).toBeTruthy();
    expect(warn).toHaveBeenCalledWith('[attachment-tray] could not load media library', error);
  });
});

describe('AttachmentTray — contact button (capability-gated)', () => {
  it('does NOT render the Contact button when no onPickContact is provided', async () => {
    grantWith([]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    expect(screen.queryByLabelText('Send a contact')).toBeNull();
  });

  it('renders the Contact button and fires onPickContact when the handler is supplied', async () => {
    grantWith([]);
    const onPickContact = jest.fn();
    await renderWithTheme(
      <AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} onPickContact={onPickContact} />,
    );
    await waitForMediaCheckToSettle();
    fireEvent.press(screen.getByLabelText('Send a contact'));
    expect(onPickContact).toHaveBeenCalledTimes(1);
  });
});

describe('AttachmentTray — camera capture', () => {
  it('stages a captured photo via onPick', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: true });
    launchCamera.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file://cap.jpg',
          fileName: 'cap.jpg',
          mimeType: 'image/jpeg',
          type: 'image',
          fileSize: 123,
          width: 10,
          height: 20,
        },
      ],
    });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    fireEvent.press(screen.getByLabelText('Take a photo'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        uri: 'file://cap.jpg',
        name: 'cap.jpg',
        mimeType: 'image/jpeg',
        size: 123,
        width: 10,
        height: 20,
      }),
    );
  });

  it('derives capture.mp4 / video/mp4 for a video capture with missing fields', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: true });
    launchCamera.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://v', type: 'video', width: 5, height: 6 }],
    });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    fireEvent.press(screen.getByLabelText('Take a photo'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({
        uri: 'file://v',
        name: 'capture.mp4',
        mimeType: 'video/mp4',
        size: 0,
        width: 5,
        height: 6,
      }),
    );
  });

  it('stages nothing and explains recovery when camera permission is denied', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: false });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take a photo'));
      await Promise.resolve();
    });
    expect(requestCamera).toHaveBeenCalled();
    expect(launchCamera).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        'Camera access was denied. Enable it in system settings to take a photo.',
      ),
    ).toBeTruthy();
  });

  it('stages nothing and explains recovery when the camera permission request fails', async () => {
    grantWith([]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    requestCamera.mockRejectedValue(new Error('Native camera permission request failed'));
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take a photo'));
      await Promise.resolve();
    });
    expect(requestCamera).toHaveBeenCalled();
    expect(launchCamera).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[attachment-tray] camera permission request failed',
      expect.any(Error),
    );
    expect(
      await screen.findByText(
        "Gator couldn't request camera access. Try Camera again or check Gator's permission in system settings.",
      ),
    ).toBeTruthy();
  });

  it('stages nothing when the capture is cancelled', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: true });
    launchCamera.mockResolvedValue({ canceled: true, assets: [] });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    await waitForMediaCheckToSettle();
    fireEvent.press(screen.getByLabelText('Take a photo'));
    await waitFor(() => expect(launchCamera).toHaveBeenCalled());
    expect(onPick).not.toHaveBeenCalled();
  });
});
