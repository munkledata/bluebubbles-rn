/**
 * VideoPlayer (src/ui/attachments/VideoPlayer.tsx) — ACCESSIBILITY LABEL ONLY.
 *
 * F20 (device-found): the video bubble's Pressable had no `accessibilityLabel` and no role, so it
 * was a focusable, clickable node with NO name. An on-device audit of a chat found the media
 * bubbles were the ONLY unlabeled focusable nodes present — TalkBack announced them as anonymous
 * buttons, indistinguishable from each other or from a photo. `AudioAttachment`, `ContactCard` and
 * `LocationCard` all labelled themselves already; the two media bubbles did not.
 *
 * The label has FOUR branches because one tap does three different things (download / retry /
 * play), and a wrong branch is silent — nothing throws, nothing looks different on screen. That is
 * exactly the shape worth a test.
 *
 * SCOPE NOTE: AGENTS.md flags VideoPlayer as native-mock territory ("don't chase it with
 * mock-testing-a-mock tests") and that still holds for playback, the poster generator and the
 * focus-pause guard — none of which are asserted here. This file only reads props the component
 * itself computes. The upload overlay + store are mocked out deliberately so this stays decoupled
 * from that feature's own tests.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: jest.fn(),
    generateThumbnailsAsync: jest.fn().mockRejectedValue(new Error('no thumbs in jest')),
  }),
  VideoView: () => null,
}));

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (p: object) => <View testID="expo-image" {...p} /> };
});

// useFocusEffect just needs to run the effect factory once, like a real focus would.
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => cb() }));

// The download service pulls `ky` (ESM) — never exercised here.
jest.mock('@/services/download', () => ({ download: jest.fn() }));

// Not under test, and owned by an in-flight feature: keep it out of these assertions.
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
    height: 200,
    width: 200,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...overrides,
  };
}

beforeEach(() => {
  useDownloadStore.setState({ status: {}, progress: {} });
});

describe('VideoPlayer — accessibility label tracks what the tap will do (F20)', () => {
  it('announces a playable video once the file is local', async () => {
    await renderWithTheme(
      <VideoPlayer att={vid({ localPath: '/data/clip.mp4' })} isFromMe={false} showTail />,
    );
    expect(await screen.findByLabelText('Video, tap to play')).toBeTruthy();
  });

  it('announces that an undownloaded video is not downloaded', async () => {
    await renderWithTheme(<VideoPlayer att={vid({ localPath: null })} isFromMe={false} showTail />);
    expect(await screen.findByLabelText('Video, not downloaded')).toBeTruthy();
  });

  it('announces in-flight download progress', async () => {
    useDownloadStore.setState({ status: { 'v-1': 'downloading' }, progress: { 'v-1': 0.4 } });
    await renderWithTheme(<VideoPlayer att={vid({ localPath: null })} isFromMe={false} showTail />);
    expect(await screen.findByLabelText('Video, downloading')).toBeTruthy();
  });

  it('announces a failure AND that tapping retries', async () => {
    useDownloadStore.setState({ status: { 'v-1': 'error' }, progress: {} });
    await renderWithTheme(<VideoPlayer att={vid({ localPath: null })} isFromMe={false} showTail />);
    expect(await screen.findByLabelText('Video, download failed, tap to retry')).toBeTruthy();
  });

  it('an error wins over a present localPath — the tap really does retry', async () => {
    useDownloadStore.setState({ status: { 'v-1': 'error' }, progress: {} });
    await renderWithTheme(
      <VideoPlayer att={vid({ localPath: '/data/clip.mp4' })} isFromMe={false} showTail />,
    );
    expect(await screen.findByLabelText('Video, download failed, tap to retry')).toBeTruthy();
  });

  it('exposes a button role so it is reachable as a control, not read as decoration', async () => {
    await renderWithTheme(
      <VideoPlayer att={vid({ localPath: '/data/clip.mp4' })} isFromMe={false} showTail />,
    );
    const pressable = await screen.findByLabelText('Video, tap to play');
    expect(pressable.props.accessibilityRole).toBe('button');
  });
});
