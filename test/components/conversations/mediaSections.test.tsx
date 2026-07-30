/**
 * MediaSections (src/ui/conversations/MediaSections.tsx): the conversation-details shared
 * media browser (moved out of app/(app)/chat-settings/[guid].tsx). Locked in:
 *   - renders NOTHING (null) when media is absent or every bucket is empty;
 *   - Photos/Videos strips with counted labels; tapping a thumb fires onOpenMedia(guid);
 *   - Documents/Links count rows; tapping a link row opens it via safeOpenUrl;
 *   - redacted mode masks link URLs to "[link]" (privacy);
 *   - MediaThumb's showImage / videoPoster guards: a DOWNLOADED photo (non-null localPath) renders
 *     the real <Image source={{uri}}>, a video renders a blurhash POSTER with no source (expo-image
 *     can't decode a video file), and redacted mode renders NEITHER — just the neutral glyph tile.
 *
 * `expo-image` is mocked to a marker View that forwards `source`/`placeholder`, so which branch
 * rendered — and whether the on-disk path leaked — is observable (same pattern as
 * attachments/imageAttachment.test.tsx).
 */
import React from 'react';
import { StyleSheet } from 'react-native';

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

// safeOpenUrl's real impl dynamic-imports react-native (throws under the jest-expo VM); mock ONLY it,
// keeping every other @utils export real.
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// eslint-disable-next-line import/first
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import { MediaSections } from '@ui/conversations/MediaSections';

import { PRESET_ORDER, PRESETS } from '@ui/theme';
// eslint-disable-next-line import/first
import { useRedactedModeStore } from '@state/redactedModeStore';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import type { AttachmentRow, ChatMediaByKind } from '@db/repositories';

function att(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-1',
    messageId: 10,
    mimeType: 'image/jpeg',
    transferName: 'photo.jpg',
    totalBytes: 1000,
    height: 100,
    width: 100,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...overrides,
  };
}

function media(overrides: Partial<ChatMediaByKind> = {}): ChatMediaByKind {
  return { photos: [], videos: [], documents: [], links: [], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
});

describe('MediaSections', () => {
  it('renders nothing when media is absent', async () => {
    const view = await renderWithTheme(<MediaSections media={null} onOpenMedia={() => {}} />);
    expect(view.toJSON()).toBeNull();
  });

  it('renders nothing when every bucket is empty', async () => {
    const view = await renderWithTheme(<MediaSections media={media()} onOpenMedia={() => {}} />);
    expect(view.toJSON()).toBeNull();
  });

  it('shows counted photo/video strips and opens the tapped thumbnail', async () => {
    const onOpenMedia = jest.fn();
    await renderWithTheme(
      <MediaSections
        media={media({
          photos: [att({ guid: 'p-1' }), att({ id: 2, guid: 'p-2' })],
          videos: [att({ id: 3, guid: 'v-1', mimeType: 'video/mp4' })],
        })}
        onOpenMedia={onOpenMedia}
      />,
    );
    expect(screen.getByText('SHARED MEDIA')).toBeTruthy();
    expect(screen.getByText('Photos · 2')).toBeTruthy();
    expect(screen.getByText('Videos · 1')).toBeTruthy();
    const thumbs = screen.getAllByRole('image');
    expect(thumbs).toHaveLength(3);
    fireEvent.press(thumbs[0]!);
    await waitFor(() => expect(onOpenMedia).toHaveBeenCalledWith('p-1'));
    fireEvent.press(thumbs[2]!);
    await waitFor(() => expect(onOpenMedia).toHaveBeenCalledWith('v-1'));
  });

  it('shows document/link counts and opens a tapped link via safeOpenUrl', async () => {
    await renderWithTheme(
      <MediaSections
        media={media({
          documents: [att({ guid: 'd-1', mimeType: 'application/pdf' })],
          links: [{ url: 'https://example.com/a', messageGuid: 'm-1', dateCreated: 123 }],
        })}
        onOpenMedia={() => {}}
      />,
    );
    expect(screen.getByText('Documents')).toBeTruthy();
    expect(screen.getByText('Links')).toBeTruthy();
    fireEvent.press(screen.getByText('https://example.com/a'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledWith('https://example.com/a'));
  });

  // The strips above use the shared fixture (localPath/blurhash null), which only ever exercises
  // the GLYPH fallback. These two cover the downloaded-media branches.
  const downloaded = () =>
    media({
      photos: [att({ guid: 'p-1', localPath: 'file:///cache/p-1.jpg', blurhash: 'LKO2?U' })],
      videos: [
        att({
          id: 3,
          guid: 'v-1',
          mimeType: 'video/mp4',
          localPath: 'file:///cache/v-1.mp4',
          blurhash: 'LEHV6n',
        }),
      ],
    });

  it('renders the real image for a downloaded photo and a source-less blurhash poster for a video', async () => {
    await renderWithTheme(<MediaSections media={downloaded()} onOpenMedia={() => {}} />);
    const images = screen.getAllByTestId('expo-image');
    expect(images).toHaveLength(2);
    // Photo: the actual file is the source, blurhash is only the placeholder.
    expect(images[0]!.props.source).toEqual({ uri: 'file:///cache/p-1.jpg' });
    expect(images[0]!.props.placeholder).toEqual({ blurhash: 'LKO2?U' });
    // Video: poster ONLY — feeding the .mp4 uri to <Image source> would render a blank tile.
    expect(images[1]!.props.source).toBeUndefined();
    expect(images[1]!.props.placeholder).toEqual({ blurhash: 'LEHV6n' });
    // The glyph fallback tile is NOT used when the real thumbnail renders.
    expect(screen.queryByText('🖼')).toBeNull();
  });

  it('redacted mode renders NO media for a downloaded photo/video — only the glyph tiles', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<MediaSections media={downloaded()} onOpenMedia={() => {}} />);
    // Neither the photo's file uri nor the video's blurhash poster may reach the screen.
    expect(screen.queryAllByTestId('expo-image')).toHaveLength(0);
    expect(screen.getByText('🖼')).toBeTruthy();
    // Both tiles still render (tap targets are unchanged) — they're just neutral.
    expect(screen.getAllByRole('image')).toHaveLength(2);
  });

  it('masks link URLs to "[link]" in redacted mode', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(
      <MediaSections
        media={media({
          links: [{ url: 'https://example.com/secret', messageGuid: 'm-1', dateCreated: 123 }],
        })}
        onOpenMedia={() => {}}
      />,
    );
    expect(screen.getByText('[link]')).toBeTruthy();
    expect(screen.queryByText('https://example.com/secret')).toBeNull();
  });
});

/**
 * F15 + F17 (both device-found, and both PRESET-DEPENDENT — which is why they need a loop over
 * PRESET_ORDER rather than a single default-theme assertion):
 *
 *  F15  The tile used `groupedBackground`, which is byte-identical to `background` in BOTH shipped
 *       presets (OLED Dark #000000, Gator #0B1A2B). So a poster-less video rendered as a bare ▶
 *       floating on nothing — on device "Videos · 12" showed five naked play arrows next to a
 *       healthy "Photos · 60". `secondaryBackground` is distinct from `background` in every preset.
 *
 *  F17  The fallback glyph carried NO `color`, so it inherited Android's near-black default Text
 *       colour — a black ▶ on a dark tile, which is how F15's fix exposed it. Its sibling
 *       `thumbGlyphOverlay` hardcodes white, but that branch only runs over a blurhash poster.
 *
 * Both are invisible to a snapshot and to tsc; only the resolved style catches them.
 */
describe('MediaSections — fallback tile stays visible in every shipped preset', () => {
  for (const preset of PRESET_ORDER) {
    const tokens = PRESETS[preset].tokens.color;

    it(`[${preset}] tile background differs from the page background`, async () => {
      await renderWithTheme(
        <MediaSections
          media={media({ videos: [att({ guid: 'v-1', mimeType: 'video/mp4' })] })}
          onOpenMedia={() => {}}
        />,
        { preset },
      );

      const tile = screen.getAllByRole('image')[0];
      const style = StyleSheet.flatten(tile!.props.style) as { backgroundColor?: string };
      expect(style.backgroundColor).toBe(tokens.secondaryBackground);
      // The actual regression: a tile the same colour as the page is an invisible tile.
      expect(style.backgroundColor).not.toBe(tokens.background);
      // Guard the specific token that caused it, for however the presets evolve.
      expect(style.backgroundColor).not.toBe(tokens.groupedBackground);
    });

    it(`[${preset}] fallback glyph is themed, not the default near-black`, async () => {
      await renderWithTheme(
        <MediaSections
          media={media({ videos: [att({ guid: 'v-1', mimeType: 'video/mp4' })] })}
          onOpenMedia={() => {}}
        />,
        { preset },
      );

      const glyph = screen.getByText('▶');
      const style = StyleSheet.flatten(glyph.props.style) as { color?: string };
      expect(style.color).toBe(tokens.secondaryLabel);
      expect(style.color).toBeDefined();
    });
  }
});
