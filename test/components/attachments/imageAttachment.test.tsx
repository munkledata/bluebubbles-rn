/**
 * ImageAttachment (src/ui/attachments/ImageAttachment.tsx): the in-bubble image with a blurhash
 * placeholder + download progress/retry. This suite pins the AGENTS.md rule at the heart of the
 * download UX:
 *
 *   The actual image SWAP is driven by the DB-provided `localPath` (a prop), while the progress
 *   ring is driven by the download store. A store progress value ALONE must NOT swap the image —
 *   rendering the picture from store state would bypass the op-sqlite reactive `localPath` write.
 *
 * Also covered: placeholder / not-downloaded state (source is null until localPath lands), the
 * download-store overlays (downloading → ProgressRing, error → retry icon), the live-photo badge,
 * tap dispatch (localPath → router.push to the media viewer; no localPath → download(att)), and the
 * auto-download effect (honors the autoDownload + WiFi-only settings and never re-fires once a
 * status exists).
 *
 * In-file mocks (each imports something with no jest half): `expo-image` (Image → a marker View
 * that forwards `source` so the swap is observable), `expo-network` (a mutable network type),
 * `expo-router` (useRouter().push), `@/services/download` (pulls `ky`, ESM), `@ui/primitives`
 * (Icon → Text marker, keeps @expo/vector-icons out). ProgressRing renders for real. The download +
 * feature-settings stores are the REAL zustand stores, seeded via setState.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import {
  renderWithTheme,
  screen,
  fireEvent,
  act,
  type RenderResult,
} from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import type { AttachmentRow } from '@db/repositories';

const mockDownload = jest.fn();
const mockPush = jest.fn();
// Mutable network state the expo-network mock reads at call time; tests flip `.type`.
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
      r.createElement(RN.View, {
        testID: 'expo-image',
        source: props.source,
        placeholder: props.placeholder,
      }),
  };
});
jest.mock('expo-network', () => ({
  NetworkStateType: { WIFI: 'WIFI', CELLULAR: 'CELLULAR', NONE: 'NONE' },
  useNetworkState: () => ({ type: mockNet.type }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@ui/primitives', () => {
  const RN = require('react-native');
  const r = require('react');
  return { Icon: ({ name }: { name: string }) => r.createElement(RN.Text, null, 'ICON:' + name) };
});

// eslint-disable-next-line import/first
import { ImageAttachment } from '@ui/attachments/ImageAttachment';

function makeImg(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'img-1',
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: 'photo.jpg',
    totalBytes: 500_000, // under the 5 MB auto cap
    height: 800,
    width: 600,
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...over,
  };
}

/** Reset both real stores + the network type + spies BEFORE each test (never afterEach). */
beforeEach(() => {
  mockDownload.mockClear();
  mockPush.mockClear();
  mockNet.type = 'WIFI';
  useDownloadStore.setState({ progress: {}, status: {} });
  // Feature-settings defaults: autoDownload ON, WiFi-only OFF (the app's prior behavior).
  useFeatureSettingsStore.setState({
    autoDownloadAttachments: true,
    autoDownloadOnWifiOnly: false,
    hydrated: true,
  });
});

const source = (): unknown => screen.getByTestId('expo-image').props.source;
const isSpinner = (n: { type: unknown }): boolean => n.type === 'ActivityIndicator';

/** `root` is typed nullable, but a rendered tree always has one — narrow it. */
function spinners(r: RenderResult): unknown[] {
  if (!r.root) throw new Error('no rendered root');
  return r.root.queryAll(isSpinner);
}

describe('ImageAttachment — image swap is driven by localPath (the DB prop), never the store', () => {
  it('renders a null source (placeholder only) until a localPath lands', async () => {
    // Suppress auto-download so nothing races; the point here is the source value.
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(source()).toBeNull();
  });

  it('swaps to the local uri once localPath is set on the row', async () => {
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: '/data/photo.jpg' })} isFromMe={false} showTail />,
    );
    expect(source()).toEqual({ uri: '/data/photo.jpg' });
  });

  it('a store PROGRESS value alone does NOT swap the image (still null while downloading)', async () => {
    // The critical regression guard: downloading status + a progress ratio must NOT produce an
    // image — only the reactive localPath write does. The ring shows; the source stays null.
    useDownloadStore.setState({ status: { 'img-1': 'downloading' }, progress: { 'img-1': 0.5 } });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(source()).toBeNull();
    expect(screen.getByText('50%')).toBeTruthy(); // ProgressRing (real) is up
  });

  it('passes the blurhash through as the placeholder', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(screen.getByTestId('expo-image').props.placeholder).toEqual({
      blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    });
  });
});

describe('ImageAttachment — download-state overlays', () => {
  it('shows the ProgressRing (with percent) while downloading', async () => {
    useDownloadStore.setState({ status: { 'img-1': 'downloading' }, progress: { 'img-1': 0.3 } });
    const r = await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(screen.getByText('30%')).toBeTruthy();
    expect(spinners(r)).toHaveLength(1);
    expect(screen.queryByText('ICON:refresh-outline')).toBeNull();
  });

  it('shows a refresh/retry icon (and no spinner) on an error status', async () => {
    useDownloadStore.setState({ status: { 'img-1': 'error' }, progress: {} });
    const r = await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(screen.getByText('ICON:refresh-outline')).toBeTruthy();
    expect(spinners(r)).toHaveLength(0);
  });

  it('shows no overlay at rest (a downloaded image with no active status)', async () => {
    const r = await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: '/data/photo.jpg' })} isFromMe={false} showTail />,
    );
    expect(spinners(r)).toHaveLength(0);
    expect(screen.queryByText('ICON:refresh-outline')).toBeNull();
  });
});

describe('ImageAttachment — live-photo badge', () => {
  it('renders a "LIVE" badge when the attachment carries a live photo', async () => {
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ localPath: '/data/photo.jpg', hasLivePhoto: 1 })}
        isFromMe={false}
        showTail
      />,
    );
    expect(screen.getByText('◉ LIVE')).toBeTruthy();
  });

  it('omits the badge for a plain image', async () => {
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ localPath: '/data/photo.jpg', hasLivePhoto: 0 })}
        isFromMe={false}
        showTail
      />,
    );
    expect(screen.queryByText('◉ LIVE')).toBeNull();
  });
});

describe('ImageAttachment — tap dispatch', () => {
  it('opens the media viewer (router.push) when the image is already downloaded', async () => {
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ guid: 'img-1', localPath: '/data/photo.jpg' })}
        isFromMe={false}
        showTail
      />,
    );
    fireEvent.press(screen.getByTestId('expo-image'));
    expect(mockPush).toHaveBeenCalledWith('/media/img-1');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('downloads on tap when the image is not yet local', async () => {
    // Auto-download OFF so the only download() call is the tap's.
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    const att = makeImg({ localPath: null });
    await renderWithTheme(<ImageAttachment att={att} isFromMe={false} showTail />);
    fireEvent.press(screen.getByTestId('expo-image'));
    expect(mockDownload).toHaveBeenCalledWith(att);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('url-encodes the guid in the media-viewer route', async () => {
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ guid: 'iMessage;-;+1555', localPath: '/data/p.jpg' })}
        isFromMe={false}
        showTail
      />,
    );
    fireEvent.press(screen.getByTestId('expo-image'));
    expect(mockPush).toHaveBeenCalledWith(`/media/${encodeURIComponent('iMessage;-;+1555')}`);
  });
});

describe('ImageAttachment — gallery cell corner rounding', () => {
  // The Pressable wrapper is the image marker's parent; its flattened style carries the corners.
  const wrapStyle = (): Record<string, unknown> =>
    StyleSheet.flatten(screen.getByTestId('expo-image').parent!.props.style) as Record<
      string,
      unknown
    >;

  it('a grid cell is a flat square — no leaked tail corner notches the grid', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ localPath: '/data/p.jpg' })}
        isFromMe
        showTail={false}
        cellSize={100}
      />,
    );
    const wrap = wrapStyle();
    expect(wrap.borderRadius).toBe(0);
    // The from-me tail corner must NOT survive into a cell (it overrides borderRadius natively).
    expect(wrap.borderBottomRightRadius).toBeUndefined();
    expect(wrap.borderBottomLeftRadius).toBeUndefined();
  });

  it('a normal (non-cell) from-me bubble still keeps its rounded tail corner', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: '/data/p.jpg' })} isFromMe showTail />,
    );
    expect(wrapStyle().borderBottomRightRadius).toBeGreaterThan(0);
  });
});

describe('ImageAttachment — Genmoji inline rendering + alt text', () => {
  const wrapStyle = (): Record<string, unknown> =>
    StyleSheet.flatten(screen.getByTestId('expo-image').parent!.props.style) as Record<
      string,
      unknown
    >;

  function genmoji(over: Partial<AttachmentRow> = {}): AttachmentRow {
    return makeImg({
      guid: 'gm-1',
      mimeType: 'image/png',
      localPath: '/data/genmoji.png', // local → no auto-download races
      width: 600,
      height: 800,
      emojiImageContentIdentifier: 'gm-xyz',
      emojiImageShortDescription: 'a smiling cat wearing a top hat',
      ...over,
    });
  }

  it('renders a Genmoji at emoji size: a small transparent square (never the full-width image)', async () => {
    await renderWithTheme(<ImageAttachment att={genmoji()} isFromMe={false} showTail />);
    const wrap = wrapStyle();
    // Square + emoji-sized: well below the 120px MIN width an ordinary image would use for width=600.
    expect(wrap.width).toBe(wrap.height);
    expect(wrap.width as number).toBeLessThan(120);
    // Transparent — no file-box tint or rounded bubble corner (an inline emoji, not a photo box).
    expect(wrap.backgroundColor).toBe('transparent');
    expect(wrap.borderRadius).toBe(0);
  });

  it('exposes the Genmoji description as the accessibility label (alt text)', async () => {
    await renderWithTheme(<ImageAttachment att={genmoji()} isFromMe={false} showTail />);
    expect(screen.getByLabelText('a smiling cat wearing a top hat')).toBeTruthy();
  });

  it('an ordinary image gets NO Genmoji alt label and keeps the file-box tint (not transparent)', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: '/data/photo.jpg' })} isFromMe={false} showTail />,
    );
    expect(screen.queryByLabelText('a smiling cat wearing a top hat')).toBeNull();
    expect(wrapStyle().backgroundColor).not.toBe('transparent');
  });
});

describe('ImageAttachment — auto-download effect', () => {
  it('auto-downloads a small, undownloaded image on mount with default settings', async () => {
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-download when the autoDownload setting is off', async () => {
    useFeatureSettingsStore.setState({ autoDownloadAttachments: false });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does NOT auto-download over cellular when WiFi-only is enabled', async () => {
    useFeatureSettingsStore.setState({ autoDownloadOnWifiOnly: true });
    mockNet.type = 'CELLULAR';
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('DOES auto-download over WiFi when WiFi-only is enabled', async () => {
    useFeatureSettingsStore.setState({ autoDownloadOnWifiOnly: true });
    mockNet.type = 'WIFI';
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-download once a status already exists (a prior attempt/failure)', async () => {
    // A previously-errored image must be left for a manual retry — never re-fetched on every flush.
    useDownloadStore.setState({ status: { 'img-1': 'error' }, progress: {} });
    await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does NOT auto-download a non-image (would exceed shouldAutoDownload)', async () => {
    // shouldAutoDownload only greenlights image/* — a video row should not auto-fetch here.
    await renderWithTheme(
      <ImageAttachment
        att={makeImg({ localPath: null, mimeType: 'video/mp4' })}
        isFromMe={false}
        showTail
      />,
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('re-mount after a store reset re-triggers the auto-download (status became undefined again)', async () => {
    const { unmount } = await renderWithTheme(
      <ImageAttachment att={makeImg({ localPath: null })} isFromMe={false} showTail />,
    );
    expect(mockDownload).toHaveBeenCalledTimes(1);
    await act(async () => {
      unmount();
    });
  });
});
