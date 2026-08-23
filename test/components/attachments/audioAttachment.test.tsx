import React from 'react';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';

const mockDownload = jest.fn();
const mockAccountLease = { generation: 45, isCurrent: jest.fn(() => true) };
const mockNextAccountLease = { generation: 46, isCurrent: jest.fn(() => true) };
const mockCaptureAccountLease = jest.fn(() => mockAccountLease);

jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({
    pause: jest.fn(),
    play: jest.fn(),
    seekTo: jest.fn(),
  }),
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 0, playing: false }),
}));
jest.mock('@/services/download', () => ({
  download: (...args: unknown[]) => mockDownload(...args),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockCaptureAccountLease(),
}));

// eslint-disable-next-line import/first
import { AudioAttachment } from '@ui/attachments/AudioAttachment';

const attachment = (): AttachmentRow => ({
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
});

beforeEach(() => {
  useDownloadStore.setState({ status: {}, progress: {} });
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
});
