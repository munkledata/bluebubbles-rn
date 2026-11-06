/**
 * VideoPlayer and several files sent as one iMessage: the draft publishes one upload entry under
 * its first file's guid, and every video of that draft reads it (uploadProgressKey). Uses the real
 * upload store; playback, posters and the overlay itself stay mocked, as in videoPlayerLabel.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import type { AttachmentRow } from '@db/repositories';

jest.mock('expo-video', () => ({
  useVideoPlayer: (_source: string | null, setup?: (p: object) => void) => {
    const player = { loop: false, play: jest.fn(), pause: jest.fn() };
    setup?.(player);
    return player;
  },
  createVideoPlayer: () => ({
    release: jest.fn(),
    generateThumbnailsAsync: jest.fn().mockRejectedValue(new Error('no thumbs in jest')),
  }),
  VideoView: () => null,
}));
jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (p: object) => <View testID="expo-image" {...p} /> };
});
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => cb() }));
jest.mock('@/services/download', () => ({ download: jest.fn() }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({ generation: 1, isCurrent: () => true }),
}));
jest.mock('@ui/attachments/UploadProgressOverlay', () => ({ UploadProgressOverlay: () => null }));

// eslint-disable-next-line import/first
import { VideoPlayer } from '@ui/attachments/VideoPlayer';

const DRAFT = 'temp-0123456789abcdef';

function vid(guid: string): AttachmentRow {
  return {
    id: 2,
    guid,
    messageId: 10,
    mimeType: 'video/quicktime',
    transferName: 'clip.mov',
    totalBytes: 5000,
    height: 200,
    width: 200,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: 'file:///cache/clip.mov',
    service: null,
  };
}

beforeEach(() => {
  useDownloadStore.setState({ status: {}, progress: {}, failure: {} });
  useUploadStore.setState({ byGuid: {} });
  useUploadStore
    .getState()
    .start(`${DRAFT}-att`, { chatGuid: 'c1', name: 'IMG_0001.heic', total: 9000, files: 2 });
});

it('labels a later video of a several-file draft as uploading while the shared upload runs', async () => {
  await renderWithTheme(<VideoPlayer att={vid(`${DRAFT}-1-att`)} isFromMe showTail />);
  expect(screen.getByRole('button', { name: 'Video, uploading' })).toBeTruthy();
});

it('does not label a video of another draft as uploading', async () => {
  await renderWithTheme(<VideoPlayer att={vid('temp-fedcba9876543210-1-att')} isFromMe showTail />);
  expect(screen.queryByRole('button', { name: 'Video, uploading' })).toBeNull();
});
