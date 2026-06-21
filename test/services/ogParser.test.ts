import { parseOgMetadata } from '@/services/urlPreview';

describe('parseOgMetadata (pure)', () => {
  it('parses og tags + derives the domain, absolutizing a relative image', () => {
    const html = `<html><head>
      <meta property="og:title" content="Hello &amp; World" />
      <meta property="og:description" content="A test page" />
      <meta property="og:image" content="/img/cover.png" />
      <meta property="og:site_name" content="Example" />
    </head></html>`;
    const og = parseOgMetadata(html, 'https://www.example.com/some/path');
    expect(og.title).toBe('Hello & World'); // entity decoded
    expect(og.description).toBe('A test page');
    expect(og.image).toBe('https://www.example.com/img/cover.png'); // absolutized
    expect(og.siteName).toBe('Example');
    expect(og.domain).toBe('example.com'); // www stripped
  });

  it('falls back to <title> when no og:title', () => {
    const og = parseOgMetadata('<title>Plain Title</title>', 'https://x.test/');
    expect(og.title).toBe('Plain Title');
  });

  it('uses twitter:* as a fallback', () => {
    const html = `<meta name="twitter:title" content="Tw Title">`;
    expect(parseOgMetadata(html, 'https://x.test/').title).toBe('Tw Title');
  });

  it('returns just the domain for HTML with no metadata', () => {
    const og = parseOgMetadata('<html></html>', 'https://nada.test/page');
    expect(og).toEqual({ domain: 'nada.test' });
  });
});
