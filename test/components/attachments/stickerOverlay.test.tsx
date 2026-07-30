/**
 * StickerOverlay (src/ui/attachments/StickerOverlay.tsx): the images other people slap ONTO one of
 * your messages, drawn over the target bubble.
 *
 * Why this component exists at all: a received sticker used to render NOWHERE. Every chat-thread
 * query filtered `associated_message_type IS NULL`, which correctly hid reactions and silently
 * swallowed stickers — so the sender saw a sticker on your photo and you saw nothing, with no
 * indication a message had arrived.
 *
 * Behaviours pinned here:
 *   - the image swap is driven by the DB-provided `localPath`, never by download-store state (the
 *     AGENTS.md rule — rendering from the store would bypass the reactive localPath write);
 *   - a sticker whose attachment row has not arrived yet (the LIVE socket/FCM path carries no
 *     attachments) renders a pending tile rather than crashing or rendering nothing;
 *   - tap fades / restores, long-press dismisses, and an undownloaded tile downloads on tap;
 *   - the auto-download effect honours the autoDownload + WiFi-only settings and never re-fires
 *     once a status exists (that guard is what prevents a re-download storm on every flush);
 *   - the overlay sits on the bubble's OWN side, opposite the reaction cluster;
 *   - every tile states its TAP OUTCOME in its accessibility label.
 *
 * In-file mocks mirror imageAttachment.test.tsx: `expo-image` (forwards `source` so the swap is
 * observable), `expo-network` (mutable type), `@/services/download` (pulls `ky`, ESM). The download
 * + feature-settings stores are the REAL zustand stores, seeded via setState.
 */
import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import type { AttachmentRow, StickerRow } from '@db/repositories';

const mockDownload = jest.fn();
const mockNet = { type: 'WIFI' as string };

jest.mock('@/services/download', () => ({
  download: (att: unknown) => mockDownload(att),
  setAttachmentFetcher: jest.fn(),
  ensureDownloaded: jest.fn(),
}));
jest.mock('expo-image', () => {
  const RN = require('react-native');
  const r = require('react');
  return {
    Image: (props: Record<string, unknown>) =>
      r.createElement(RN.View, { testID: 'expo-image', source: props.source }),
  };
});
jest.mock('expo-network', () => ({
  NetworkStateType: { WIFI: 'WIFI', CELLULAR: 'CELLULAR', NONE: 'NONE' },
  useNetworkState: () => ({ type: mockNet.type }),
}));

// eslint-disable-next-line import/first
import { StickerOverlay } from '@ui/attachments/StickerOverlay';

function makeAtt(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'st-att-1',
    messageId: 2,
    mimeType: 'image/png',
    transferName: 'sticker.png',
    totalBytes: 2048,
    height: 200,
    width: 200,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 1,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...over,
  };
}

function makeSticker(over: Partial<StickerRow> = {}): StickerRow {
  return {
    stickerMessageGuid: 'st-1',
    stickerMessageId: 2,
    targetGuid: 'mt',
    isFromMe: 0,
    dateCreated: 200,
    attachment: makeAtt(),
    ...over,
  };
}

beforeEach(() => {
  useDownloadStore.setState({ progress: {}, status: {} });
  useFeatureSettingsStore.setState({
    autoDownloadAttachments: false,
    autoDownloadOnWifiOnly: false,
  });
  mockNet.type = 'WIFI';
});

describe('StickerOverlay — rendering', () => {
  it('renders nothing when there are no stickers', async () => {
    await renderWithTheme(<StickerOverlay stickers={[]} isFromMe={false} />);
    expect(screen.queryByTestId('sticker-overlay')).toBeNull();
  });

  it('shows the image once localPath exists (the DB drives the swap)', async () => {
    const st = makeSticker({ attachment: makeAtt({ localPath: 'file:///s/a.png' }) });
    await renderWithTheme(<StickerOverlay stickers={[st]} isFromMe={false} />);
    expect(screen.getByTestId('expo-image').props.source).toEqual({ uri: 'file:///s/a.png' });
  });

  // Store progress alone must NOT swap the image — that would bypass the reactive localPath write.
  it('does NOT render the image from download-store state alone', async () => {
    useDownloadStore.setState({
      status: { 'st-att-1': 'downloading' },
      progress: { 'st-att-1': 1 },
    });
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(screen.queryByTestId('expo-image')).toBeNull();
  });

  // A sticker on the LIVE path has no attachment row until the next chat-open sync.
  it('renders a pending tile when the attachment row has not arrived at all', async () => {
    await renderWithTheme(
      <StickerOverlay stickers={[makeSticker({ attachment: null })]} isFromMe={false} />,
    );
    expect(screen.getByTestId('sticker-overlay')).toBeTruthy();
    expect(screen.queryByTestId('expo-image')).toBeNull();
  });

  it('renders one tile per sticker', async () => {
    const two = [
      makeSticker({ stickerMessageGuid: 's1' }),
      makeSticker({ stickerMessageGuid: 's2', attachment: makeAtt({ guid: 'st-att-2' }) }),
    ];
    await renderWithTheme(<StickerOverlay stickers={two} isFromMe={false} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

describe('StickerOverlay — side', () => {
  const sideOf = (): ViewStyle =>
    StyleSheet.flatten(screen.getByTestId('sticker-overlay').props.style) as ViewStyle;

  // Opposite the reaction cluster, so a bubble with both doesn't stack them on top of each other.
  // NOTE these are two separate tests on purpose: rendering twice in one test needs an `unmount()`,
  // which is ASYNC in RNTL 14 — un-awaited it corrupts every LATER test in the file (React 19
  // overlapping act), and the symptom is misleading because absence-assertions then pass vacuously.
  it('pins right for my messages', async () => {
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe />);
    expect(sideOf().right).toBe(0);
    expect(sideOf().left).toBeUndefined();
  });

  it('pins left for their messages', async () => {
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(sideOf().left).toBe(0);
    expect(sideOf().right).toBeUndefined();
  });
});

describe('StickerOverlay — interaction', () => {
  it('tap fades the sticker and tapping again restores it', async () => {
    const st = makeSticker({ attachment: makeAtt({ localPath: 'file:///s/a.png' }) });
    await renderWithTheme(<StickerOverlay stickers={[st]} isFromMe={false} />);

    const tile = () => screen.getByRole('button');
    expect((StyleSheet.flatten(tile().props.style) as ViewStyle).opacity).toBe(1);

    fireEvent.press(tile());
    await waitFor(() =>
      expect((StyleSheet.flatten(tile().props.style) as ViewStyle).opacity).toBe(0.25),
    );

    fireEvent.press(tile());
    await waitFor(() =>
      expect((StyleSheet.flatten(tile().props.style) as ViewStyle).opacity).toBe(1),
    );
  });

  it('long-press dismisses the sticker for this session', async () => {
    const st = makeSticker({ attachment: makeAtt({ localPath: 'file:///s/a.png' }) });
    await renderWithTheme(<StickerOverlay stickers={[st]} isFromMe={false} />);
    fireEvent(screen.getByRole('button'), 'longPress');
    await waitFor(() => expect(screen.queryByTestId('sticker-overlay')).toBeNull());
  });

  it('tapping an undownloaded sticker downloads it instead of fading', async () => {
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    fireEvent.press(screen.getByRole('button'));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ guid: 'st-att-1' })),
    );
  });
});

describe('StickerOverlay — auto-download', () => {
  it('fetches automatically when the setting is on', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: true });
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith(expect.objectContaining({ guid: 'st-att-1' })),
    );
  });

  it('does nothing automatically when the setting is off', async () => {
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('respects the WiFi-only restriction', async () => {
    useFeatureSettingsStore.setState({
      autoDownloadAttachments: true,
      autoDownloadOnWifiOnly: true,
    });
    mockNet.type = 'CELLULAR';
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  // The status guard is what stops a permanently-failing sticker re-downloading on every reactive
  // flush and hogging the download concurrency slots.
  it('never re-fires once a status exists (a prior error is left for a manual retry)', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: true });
    useDownloadStore.setState({ status: { 'st-att-1': 'error' } });
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does not try to download a sticker with no attachment row yet', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: true });
    await renderWithTheme(
      <StickerOverlay stickers={[makeSticker({ attachment: null })]} isFromMe={false} />,
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('StickerOverlay — accessibility', () => {
  // A Pressable whose label only names the kind is an anonymous button; one tap does three
  // different things here, so the label has to say which.
  it('states the tap outcome for each state', async () => {
    await renderWithTheme(<StickerOverlay stickers={[makeSticker()]} isFromMe={false} />);
    expect(screen.getByLabelText(/not downloaded — tap to download/)).toBeTruthy();
  });

  it('says "tap to fade" when downloaded, and "tap to restore" once faded', async () => {
    const st = makeSticker({ attachment: makeAtt({ localPath: 'file:///s/a.png' }) });
    await renderWithTheme(<StickerOverlay stickers={[st]} isFromMe={false} />);
    expect(screen.getByLabelText(/tap to fade/)).toBeTruthy();
    fireEvent.press(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByLabelText(/tap to restore/)).toBeTruthy());
  });
});
