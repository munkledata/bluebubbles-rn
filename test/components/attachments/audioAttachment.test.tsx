import React from 'react';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';

const mockDownload = jest.fn();
const mockAccountLease = { generation: 45, isCurrent: jest.fn(() => true) };
const mockNextAccountLease = { generation: 46, isCurrent: jest.fn(() => true) };
const mockCaptureAccountLease = jest.fn(() => mockAccountLease);
const mockPlayer = {
  pause: jest.fn(),
  play: jest.fn(),
  seekTo: jest.fn(),
};
let mockPlayerStatus = { currentTime: 0, duration: 0, playing: false };
const mockUseAudioPlayer = jest.fn((_source: unknown) => mockPlayer);
const mockUseAudioPlayerStatus = jest.fn((_player: unknown) => mockPlayerStatus);

jest.mock('expo-audio', () => ({
  useAudioPlayer: (source: unknown) => mockUseAudioPlayer(source),
  useAudioPlayerStatus: (player: unknown) => mockUseAudioPlayerStatus(player),
}));
jest.mock('@/services/download', () => ({
  download: (...args: unknown[]) => mockDownload(...args),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockCaptureAccountLease(),
}));

// eslint-disable-next-line import/first
import { AudioAttachment } from '@ui/attachments/AudioAttachment';

const attachment = (overrides: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 1,
  guid: 'audio-1',
  messageId: 1,
  mimeType: 'audio/m4a',
  transferName: 'voice.m4a',
  totalBytes: 1_024,
  height: null,
  width: null,
  blurhash: null,
  hasLivePhoto: 0,
  isSticker: 0,
  hideAttachment: 0,
  localPath: null,
  service: null,
  ...overrides,
});

beforeEach(() => {
  useDownloadStore.setState({ status: {}, progress: {} });
  mockPlayerStatus = { currentTime: 0, duration: 0, playing: false };
  mockPlayer.pause.mockClear();
  mockPlayer.play.mockClear();
  mockPlayer.seekTo.mockClear();
  mockUseAudioPlayer.mockClear();
  mockUseAudioPlayerStatus.mockClear();
  mockDownload.mockClear();
  mockCaptureAccountLease
    .mockReset()
    .mockReturnValueOnce(mockAccountLease)
    .mockReturnValue(mockNextAccountLease);
});

it('forwards the lease captured at mount when an undownloaded audio attachment is pressed', async () => {
  const att = attachment();
  const view = await renderWithTheme(<AudioAttachment att={att} isFromMe={false} />);
  expect(mockCaptureAccountLease).toHaveBeenCalledTimes(1);
  await view.rerender(<AudioAttachment att={{ ...att }} isFromMe={false} />);
  expect(mockCaptureAccountLease).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByRole('button'));

  expect(mockDownload).toHaveBeenCalledWith(att, 'manual', mockAccountLease);
  expect(mockCaptureAccountLease).toHaveBeenCalledTimes(1);
  expect(mockUseAudioPlayer).toHaveBeenCalledWith(null);
  expect(screen.getByText('Voice message · tap to load')).toBeTruthy();
});

it('shows download progress without trying to control an unavailable player', async () => {
  const att = attachment();
  useDownloadStore.setState({
    status: { [att.guid]: 'downloading' },
    progress: { [att.guid]: 0.5 },
  });

  await renderWithTheme(<AudioAttachment att={att} isFromMe={false} />);

  expect(screen.getByText('Downloading…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Play audio' })).toBeTruthy();
  expect(mockPlayer.play).not.toHaveBeenCalled();
  expect(mockPlayer.pause).not.toHaveBeenCalled();
});

it('plays a downloaded attachment and presents its current and total time', async () => {
  mockPlayerStatus = { currentTime: 65, duration: 125, playing: false };
  const att = attachment({ localPath: 'file:///cache/voice.m4a' });

  await renderWithTheme(<AudioAttachment att={att} isFromMe />);

  expect(mockUseAudioPlayer).toHaveBeenCalledWith({ uri: att.localPath });
  expect(screen.getByText('1:05 / 2:05')).toBeTruthy();

  fireEvent.press(screen.getByRole('button', { name: 'Play audio' }));

  expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  expect(mockPlayer.pause).not.toHaveBeenCalled();
  expect(mockPlayer.seekTo).not.toHaveBeenCalled();
});

it('pauses a downloaded attachment that is currently playing', async () => {
  mockPlayerStatus = { currentTime: 7, duration: 30, playing: true };
  const att = attachment({ localPath: 'file:///cache/voice.m4a' });

  await renderWithTheme(<AudioAttachment att={att} isFromMe={false} />);

  fireEvent.press(screen.getByRole('button', { name: 'Pause audio' }));

  expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
  expect(mockPlayer.play).not.toHaveBeenCalled();
  expect(mockPlayer.seekTo).not.toHaveBeenCalled();
});

it('rewinds a completed attachment before playing it again', async () => {
  mockPlayerStatus = { currentTime: 10, duration: 10, playing: false };
  const att = attachment({ localPath: 'file:///cache/voice.m4a' });

  await renderWithTheme(<AudioAttachment att={att} isFromMe={false} />);

  fireEvent.press(screen.getByRole('button', { name: 'Play audio' }));

  expect(mockPlayer.seekTo).toHaveBeenCalledWith(0);
  expect(mockPlayer.play).toHaveBeenCalledTimes(1);
});
