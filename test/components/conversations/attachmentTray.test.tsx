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
 *   - denied access (and a media-load error) shows the "Allow photo access…" prompt and no
 *     thumbnails;
 *   - Camera: a successful capture stages via onPick; denied camera permission or a cancelled
 *     capture stages nothing; a video capture with missing fields derives capture.mp4 / video/mp4.
 *
 * In-file mocks: expo-media-library/legacy + expo-image-picker (native modules) are stubbed so the
 * permission/asset/camera flows can be driven deterministically; expo-image (thumbnail renderer)
 * is stubbed to a plain host View.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => React.createElement(View, props) };
});

jest.mock('expo-media-library/legacy', () => ({
  MediaType: { photo: 'photo', video: 'video' },
  SortBy: { creationTime: 'creationTime' },
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

const requestPerm = MediaLibrary.requestPermissionsAsync as unknown as jest.Mock;
const getAssets = MediaLibrary.getAssetsAsync as unknown as jest.Mock;
const getAssetInfo = MediaLibrary.getAssetInfoAsync as unknown as jest.Mock;
const requestCamera = ImagePicker.requestCameraPermissionsAsync as unknown as jest.Mock;
const launchCamera = ImagePicker.launchCameraAsync as unknown as jest.Mock;

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
  requestPerm.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
  getAssets.mockResolvedValue({ assets });
}

describe('AttachmentTray — always-visible controls', () => {
  it('renders the Camera and Files buttons regardless of permission', async () => {
    requestPerm.mockResolvedValue({ granted: false, accessPrivileges: 'none' });
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(screen.getByLabelText('Take a photo')).toBeTruthy();
    expect(screen.getByLabelText('Attach a file')).toBeTruthy();
  });

  it('fires onPickFiles when Files is tapped', async () => {
    const onPickFiles = jest.fn();
    grantWith([]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={onPickFiles} />);
    fireEvent.press(screen.getByLabelText('Attach a file'));
    expect(onPickFiles).toHaveBeenCalledTimes(1);
  });
});

describe('AttachmentTray — media library', () => {
  it('renders a thumbnail per asset with photo/video-specific labels', async () => {
    grantWith([PHOTO, VIDEO]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(await screen.findByLabelText('Attach photo')).toBeTruthy();
    expect(screen.getByLabelText('Attach video')).toBeTruthy();
  });

  it('loads assets under LIMITED access even though granted is false', async () => {
    requestPerm.mockResolvedValue({ granted: false, accessPrivileges: 'limited' });
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
    getAssetInfo.mockRejectedValue(new Error('scoped storage'));
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(await screen.findByLabelText('Attach photo'));
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ uri: 'ph://p1' })),
    );
  });

  it('shows the allow-access prompt (and no thumbnails) when permission is denied', async () => {
    requestPerm.mockResolvedValue({ granted: false, accessPrivileges: 'none' });
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(
      await screen.findByText('Allow photo access in Settings to attach from your library.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Attach photo')).toBeNull();
  });

  it('shows the allow-access prompt when the media load throws', async () => {
    requestPerm.mockResolvedValue({ granted: true, accessPrivileges: 'all' });
    getAssets.mockRejectedValue(new Error('boom'));
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    expect(
      await screen.findByText('Allow photo access in Settings to attach from your library.'),
    ).toBeTruthy();
  });
});

describe('AttachmentTray — contact button (capability-gated)', () => {
  it('does NOT render the Contact button when no onPickContact is provided', async () => {
    grantWith([]);
    await renderWithTheme(<AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} />);
    // Wait for the tray to settle, then assert the button is absent.
    expect(await screen.findByLabelText('Attach a file')).toBeTruthy();
    expect(screen.queryByLabelText('Send a contact')).toBeNull();
  });

  it('renders the Contact button and fires onPickContact when the handler is supplied', async () => {
    grantWith([]);
    const onPickContact = jest.fn();
    await renderWithTheme(
      <AttachmentTray onPick={jest.fn()} onPickFiles={jest.fn()} onPickContact={onPickContact} />,
    );
    fireEvent.press(await screen.findByLabelText('Send a contact'));
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

  it('stages nothing when camera permission is denied', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: false });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Take a photo'));
    await waitFor(() => expect(requestCamera).toHaveBeenCalled());
    expect(launchCamera).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('stages nothing when the capture is cancelled', async () => {
    grantWith([]);
    requestCamera.mockResolvedValue({ granted: true });
    launchCamera.mockResolvedValue({ canceled: true, assets: [] });
    const onPick = jest.fn();
    await renderWithTheme(<AttachmentTray onPick={onPick} onPickFiles={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Take a photo'));
    await waitFor(() => expect(launchCamera).toHaveBeenCalled());
    expect(onPick).not.toHaveBeenCalled();
  });
});
