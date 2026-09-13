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
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { UrlPreviewRow } from '@db/repositories';

jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: object) => React.createElement(View, props) };
});

// eslint-disable-next-line import/first
import { UrlPreviewCard } from '@ui/conversations/UrlPreviewCard';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  (safeOpenUrl as jest.Mock).mockReset().mockResolvedValue(true);
  useToastStore.setState({ current: null, queue: [] });
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
    expect(screen.getByText('example.com')).toBeTruthy();
    const link = screen.getByRole('link', {
      name: 'Link preview: A Title. Destination: example.com',
    });
    expect(link.props.accessible).toBe(true);
    expect(link.props.accessibilityHint).toBe('Opens in your browser');
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

  it('always exposes the real destination when page metadata impersonates another site', async () => {
    await renderWithTheme(
      <UrlPreviewCard
        url="https://attacker.example/login"
        preview={row({ title: 'Trusted Bank', siteName: 'bank.example' })}
        isFromMe={false}
      />,
    );

    expect(screen.getByText('bank.example')).toBeTruthy();
    expect(screen.getByText('attacker.example')).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'Link preview: Trusted Bank. Destination: attacker.example',
      }),
    ).toBeTruthy();
  });

  it('shows the complete right-hand suffix of a maximum-length deceptive hostname', async () => {
    const deceptiveHost = `bank.example.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(35)}.evil.example`;
    expect(deceptiveHost).toHaveLength(253);
    await renderWithTheme(
      <UrlPreviewCard
        url={`https://${deceptiveHost}/login`}
        preview={row({ title: 'Trusted Bank' })}
        isFromMe={false}
      />,
    );

    const destination = screen.getByTestId('url-preview-destination');
    expect(destination.props.children).toBe(deceptiveHost);
    expect(destination.props.numberOfLines).toBeUndefined();
  });

  it.each(['mailto:person@example.com', 'tel:+15555550100', 'javascript:alert(1)'])(
    'renders no preview card for hostname-less or non-web destination %s',
    async (url) => {
      const { toJSON } = await renderWithTheme(
        <UrlPreviewCard url={url} preview={row()} isFromMe={false} />,
      );

      expect(toJSON()).toBeNull();
      expect(safeOpenUrl).not.toHaveBeenCalled();
    },
  );

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
        preview={row({
          title: null,
          description: null,
          siteName: null,
          imageUrl: null,
        })}
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

  it('renders only server-proxied image bytes with an accessible label', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row({ imageUrl: imageDataUrl })}
        isFromMe={false}
      />,
    );

    const image = screen.getByTestId('url-preview-image');
    expect(image.props.source).toBe(imageDataUrl);
    expect(image.props.recyclingKey).toBe('https://www.example.com/article');
    expect(image.props.accessible).toBe(true);
    expect(image.props.accessibilityLabel).toBe('A Title preview image');
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

  it('keeps a determined width for stable text-card layout', async () => {
    // This explicit width originally fixed a remote-artwork layout cycle. NET-00 no longer mounts
    // artwork, but a stable text card still must not fall back to content-dependent maxWidth-only
    // sizing. Jest cannot reproduce Yoga layout, so assert the style contract directly.
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
    await fireEvent.press(screen.getByText('A Title'));
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
    await fireEvent.press(screen.getByText('A Title'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));
    expect(safeOpenUrl).toHaveBeenCalledWith('https://good.example.com/page');
  });

  it('shows one generic toast when the operating system refuses the handoff', async () => {
    (safeOpenUrl as jest.Mock).mockResolvedValue(false);
    await renderWithTheme(
      <UrlPreviewCard url="https://www.example.com/article" preview={row()} isFromMe={false} />,
    );

    await fireEvent.press(screen.getByTestId('url-preview-card'));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Couldn’t open this outside Gator.'),
    );
    expect(useToastStore.getState().queue).toHaveLength(0);
  });

  it('drops a delayed failure after the preview source is replaced', async () => {
    const open = deferred<boolean>();
    (safeOpenUrl as jest.Mock).mockReturnValue(open.promise);
    const view = await renderWithTheme(
      <UrlPreviewCard
        url="https://first.example.invalid/private"
        preview={row({ title: 'First link' })}
        isFromMe={false}
      />,
    );
    await fireEvent.press(screen.getByText('First link'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));

    await view.rerender(
      <UrlPreviewCard
        url="https://second.example.invalid/private"
        preview={row({ title: 'Second link' })}
        isFromMe={false}
      />,
    );
    await screen.findByText('Second link');
    await act(async () => {
      open.resolve(false);
      await open.promise;
    });

    expect(useToastStore.getState().current).toBeNull();
  });

  it('keeps a delayed failure with its original owner when the same URL changes owners', async () => {
    const open = deferred<boolean>();
    let originalOwnerCurrent = true;
    const originalOwner = (): boolean => originalOwnerCurrent;
    const replacementOwner = (): boolean => true;
    (safeOpenUrl as jest.Mock).mockReturnValueOnce(open.promise).mockResolvedValueOnce(false);
    const view = await renderWithTheme(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row()}
        isFromMe={false}
        externalOpenIsCurrent={originalOwner}
      />,
    );
    await fireEvent.press(screen.getByTestId('url-preview-card'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));

    originalOwnerCurrent = false;
    await view.rerender(
      <UrlPreviewCard
        url="https://www.example.com/article"
        preview={row()}
        isFromMe={false}
        externalOpenIsCurrent={replacementOwner}
      />,
    );

    await act(async () => {
      open.resolve(false);
      await open.promise;
    });

    expect(useToastStore.getState().current).toBeNull();

    await fireEvent.press(screen.getByTestId('url-preview-card'));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Couldn’t open this outside Gator.'),
    );
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
