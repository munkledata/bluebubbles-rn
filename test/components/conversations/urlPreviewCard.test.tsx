/**
 * UrlPreviewCard (src/ui/conversations/UrlPreviewCard.tsx): a compact Open Graph link card
 * rendered under a message bubble from an already-fetched `UrlPreviewRow` (the card takes the
 * row as a prop; it does no fetching itself).
 *
 * The load-bearing security property (AGENTS.md: "URL-preview fetch hits an attacker-controlled
 * URL … render as plain `<Text>`, no HTML interpretation") is asserted directly: a title/site
 * name containing markup renders as literal text, never interpreted markup. Also covers the
 * loading / negative-cache / no-metadata "render nothing" branches and the domain fallback.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { UrlPreviewCard } from '@ui/conversations/UrlPreviewCard';
import type { UrlPreviewRow } from '@db/repositories';

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
});
