/**
 * UrlPreviewCard (src/ui/conversations/UrlPreviewCard.tsx): a compact Open Graph link card
 * rendered under a message bubble from an already-cached/server-supplied `UrlPreviewRow` (the
 * card takes the row as a prop; it does no fetching itself).
 *
 * The load-bearing security property (AGENTS.md: "URL-preview fetch hits an attacker-controlled
 * URL … render as plain `<Text>`, no HTML interpretation") is asserted directly: a title/site
 * name containing markup renders as literal text, never interpreted markup. Also covers the
 * loading / negative-cache / no-metadata "render nothing" branches and the domain fallback.
 *
 * NET-00 adds two containment properties: even a row containing a remote image URL never mounts
 * a React Native Image (which would fetch automatically), and taps leave the app through
 * `safeOpenUrl` rather than invoking the old metadata pipeline.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { UrlPreviewRow } from '@db/repositories';

jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// eslint-disable-next-line import/first
import { UrlPreviewCard } from '@ui/conversations/UrlPreviewCard';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';

beforeEach(() => {
  (safeOpenUrl as jest.Mock).mockClear();
});

/** Build a fully-populated preview row; override just the fields a test cares about. */
function row(over: Partial<UrlPreviewRow> = {}): UrlPreviewRow {
  return {
    url: 'https://www.example.com/article',
    title: 'A Title',
    description: 'A description',
    imageUrl: null,
    siteName: 'Example Site',
    fetchedAt: 123,
    error: 0,
    ...over,
  };
}

describe('UrlPreviewCard', () => {
  it('renders the title and site name text', async () => {
    await renderWithTheme(
      <UrlPreviewCard url="https://www.example.com/article" preview={row()} isFromMe={false} />,
    );

    expect(screen.getByText('A Title')).toBeTruthy();
    expect(screen.getByText('Example Site')).toBeTruthy();
  });

  it('renders the description when present', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ description: 'Read all about it' })}
        isFromMe={false}
      />,
    );

    expect(screen.getByText('Read all about it')).toBeTruthy();
  });

  it('omits the description line when the row has none', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ description: null })}
        isFromMe={false}
      />,
    );

    expect(screen.queryByText('A description')).toBeNull();
  });

  it('renders a markup-bearing title as LITERAL text (no HTML interpretation)', async () => {
    // AGENTS.md hardening: previews are attacker-controlled and must render as plain text.
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: '<b>bold</b> & <script>alert(1)</script>' })}
        isFromMe={false}
      />,
    );

    // The exact string survives verbatim — proof it was never parsed as markup.
    expect(screen.getByText('<b>bold</b> & <script>alert(1)</script>')).toBeTruthy();
  });

  it('renders a markup-bearing site name as literal text', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ siteName: '<i>evil.com</i>' })}
        isFromMe={false}
      />,
    );

    expect(screen.getByText('<i>evil.com</i>')).toBeTruthy();
  });

  it('falls back to the bare hostname (www-stripped) when title is absent', async () => {
    // No title, but imageUrl present so the card still renders.
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: null, siteName: null, imageUrl: 'https://img/x.png' })}
        isFromMe={false}
      />,
    );

    // Both the title fallback and the site-name fallback resolve to the same host.
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0);
  });

  it('renders nothing while the preview is still loading (null row)', async () => {
    const { toJSON } = await renderWithTheme(
      <UrlPreviewCard url="https://www.example.com/article" preview={null} isFromMe={false} />,
    );

    expect(toJSON()).toBeNull();
  });

  it('renders nothing for a negative-cache row (error === 1)', async () => {
    const { toJSON } = await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ error: 1 })}
        isFromMe={false}
      />,
    );

    expect(toJSON()).toBeNull();
  });

  it('renders nothing when the row has neither a title nor an image', async () => {
    const { toJSON } = await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: null, imageUrl: null })}
        isFromMe={false}
      />,
    );

    expect(toJSON()).toBeNull();
  });

  it('never mounts a remote preview image, while preserving cached text', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ imageUrl: 'https://img/x.png' })}
        isFromMe={false}
      />,
    );
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(screen.getByText('A Title')).toBeTruthy();
  });

  it('does not expose an image loading/error path for remote artwork', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: 'A Title', imageUrl: 'https://img/broken.png' })}
        isFromMe={false}
      />,
    );
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(screen.getByText('A Title')).toBeTruthy();
  });

  it('sizes the card with a DETERMINED width — never maxWidth-only (the width-0 image bug)', async () => {
    // Regression lock for the invisible-image bug (fixed 2026-07-21, see AGENTS.md): the card
    // was alignSelf + maxWidth-only, so its width came from its children — and the image's
    // width:'100%' referenced that same parent. Yoga resolves the cycle to width 0: the image
    // "loads" (onLoad fires) but renders zero pixels, with no error, on every image library.
    // Jest's mock layout can't reproduce Yoga's resolution, so this asserts the style contract
    // instead: the card must carry an explicit width, not only a maxWidth.
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: 'A Title', imageUrl: 'https://img/x.png' })}
        isFromMe={false}
      />,
    );
    const card = screen.getByTestId('url-preview-card');
    const style = StyleSheet.flatten(card.props.style);
    expect(style.width).toBeDefined();
    expect(style.width).not.toBe('auto');
  });

  it('tapping the card opens the message URL through safeOpenUrl (the scheme allowlist)', async () => {
    // The url + every metadata field is server-controlled, so the open MUST route through
    // safeOpenUrl — never a raw Linking.openURL, which would follow an intent:/tel: scheme.
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: 'A Title' })}
        isFromMe={false}
      />,
    );
    fireEvent.press(screen.getByText('A Title'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));
    // The MESSAGE's url is opened — not the preview row's own (possibly redirected) fields.
    expect(safeOpenUrl).toHaveBeenCalledWith('https://www.example.com/article');
  });

  it('opens the url prop, not the preview row url, when the two disagree', async () => {
    // Defensive: a malicious server could return a preview row whose `url` differs from the URL the
    // user actually saw in the message text. The tap must follow what was rendered/typed.
    await renderWithTheme(
      <UrlPreviewCard
        url="https://good.example.com/page"
        preview={row({ url: 'https://evil.example.com/page', title: 'A Title' })}
        isFromMe={false}
      />,
    );
    fireEvent.press(screen.getByText('A Title'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));
    expect(safeOpenUrl).toHaveBeenCalledWith('https://good.example.com/page');
  });

  it('degrades image-only metadata to a text-only external-link card', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ title: null, siteName: null, imageUrl: 'https://img/broken.png' })}
        isFromMe={false}
      />,
    );
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0);
  });
});
