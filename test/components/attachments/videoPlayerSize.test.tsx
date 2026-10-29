/**
 * VideoPlayer (src/ui/attachments/VideoPlayer.tsx) — BUBBLE SIZE ONLY.
 *
 * An RCS video has no width/height on record. The bubble used to fall back to a fixed portrait box
 * (aspect 0.78) and crop the poster to fill it, so a landscape video showed only its middle. The
 * poster's own shape now sizes an unsized video; a recorded size still wins, and the measurement is
 * keyed to the attachment so a recycled list row never lends one video's shape to the next.
 *
 * Playback and the native thumbnail generator are not under test: the generator is a mock that
 * resolves to a poster of a chosen size, and these tests read only the box the component computes.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, renderWithTheme, screen } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

// Each poster request waits until the test hands it a size (or no poster at all).
const mockPosterRequests: Array<(poster: { width: number; height: number } | null) => void> = [];
// One player object per source, like the real hook: a fresh object every render would re-run the
// poster effect forever.
const mockPlayers = new Map<string | null, object>();
jest.mock('expo-video', () => ({
  useVideoPlayer: (source: string | null) => {
    let player = mockPlayers.get(source);
    if (!player) {
      player = {
        loop: false,
        play: jest.fn(),
        pause: jest.fn(),
        generateThumbnailsAsync: jest.fn(
          () =>
            new Promise((resolve, reject) => {
              mockPosterRequests.push((poster) =>
                poster
                  ? resolve([{ ...poster, requestedTime: 0, actualTime: 0 }])
                  : reject(new Error('no poster')),
              );
            }),
        ),
      };
      mockPlayers.set(source, player);
    }
    return player;
  },
  VideoView: () => null,
}));

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: () => <View testID="expo-image" /> };
});

jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => cb() }));
jest.mock('@/services/download', () => ({ download: jest.fn() }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({ generation: 1, isCurrent: () => true }),
}));
jest.mock('@ui/attachments/UploadProgressOverlay', () => ({ UploadProgressOverlay: () => null }));
jest.mock('@state/uploadStore', () => ({ useUploadStore: () => undefined }));

import { VideoPlayer } from '@ui/attachments/VideoPlayer';

function vid(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'v-1',
    messageId: 10,
    mimeType: 'video/mp4',
    transferName: 'clip.mp4',
    totalBytes: 5000,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: '/data/clip.mp4',
    service: null,
    ...overrides,
  };
}

function box(): { width: number; height: number } {
  const style = StyleSheet.flatten(screen.getByLabelText('Video, tap to play').props.style) as {
    width: number;
    height: number;
  };
  return { width: style.width, height: style.height };
}

// Answer the latest poster request and let the resulting state update render.
async function givePoster(poster: { width: number; height: number } | null): Promise<void> {
  const answer = mockPosterRequests.pop();
  if (!answer) throw new Error('no poster was requested');
  await act(async () => {
    answer(poster);
    await Promise.resolve();
  });
}

beforeEach(() => {
  useDownloadStore.setState({ status: {}, progress: {}, failure: {} });
  mockPosterRequests.length = 0;
  mockPlayers.clear();
});

describe('VideoPlayer — size when the record has none', () => {
  it('takes a landscape video’s own shape from its poster instead of a tall crop (RCS has no size)', async () => {
    await renderWithTheme(<VideoPlayer att={vid()} isFromMe showTail />);
    // Before the poster arrives, the box keeps the portrait guess.
    expect(box().height).toBeGreaterThan(box().width);

    await givePoster({ width: 600, height: 338 });

    const { width, height } = box();
    expect(width / height).toBeCloseTo(600 / 338, 1);
  });

  it('keeps the recorded size even when the poster reports another shape', async () => {
    await renderWithTheme(<VideoPlayer att={vid({ width: 200, height: 200 })} isFromMe showTail />);
    const before = box();

    await givePoster({ width: 600, height: 338 });

    expect(box()).toEqual(before);
  });

  it('never lends one video’s measured shape to the next one shown in the same row', async () => {
    const view = await renderWithTheme(
      <VideoPlayer att={vid({ guid: 'first' })} isFromMe showTail />,
    );
    const portrait = box();
    await givePoster({ width: 600, height: 338 });
    expect(box().width / box().height).toBeCloseTo(600 / 338, 1);

    // A recycled list row now shows another unsized video whose poster has not arrived yet.
    await view.rerender(
      <VideoPlayer att={vid({ guid: 'second', localPath: '/data/other.mp4' })} isFromMe showTail />,
    );
    expect(box()).toEqual(portrait);
  });
});
