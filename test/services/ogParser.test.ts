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

describe('parseOgMetadata — HTML entity decoding', () => {
  const html = (title: string): string =>
    `<html><head><meta property="og:title" content="${title}" /></head></html>`;

  // Regression: found on-device 2026-07-29 — a real preview card rendered the literal
  // "Tyler&#x27;s Upfront Plumbing…" because decode() handled only the DECIMAL numeric form.
  it('decodes HEX numeric entities (&#x27; — the form most templating engines emit)', () => {
    expect(parseOgMetadata(html('Tyler&#x27;s Plumbing'), 'https://x.com').title).toBe(
      "Tyler's Plumbing",
    );
  });

  it('decodes hex entities case-insensitively', () => {
    expect(parseOgMetadata(html('a&#X27;b &#x2014; c'), 'https://x.com').title).toBe('a\'b — c');
  });

  it('decodes DECIMAL numeric entities', () => {
    expect(parseOgMetadata(html('Tyler&#39;s &#8212; Co'), 'https://x.com').title).toBe(
      "Tyler's — Co",
    );
  });

  it('decodes named entities', () => {
    expect(
      parseOgMetadata(html('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'https://x.com')
        .title,
    ).toBe('A & B <c> "d" \'e\'');
  });

  it('decodes multi-byte code points above the BMP', () => {
    expect(parseOgMetadata(html('go &#128512; now'), 'https://x.com').title).toBe('go 😀 now');
  });

  // `&amp;` must decode LAST, so an escaped entity stays literal instead of double-decoding.
  it('does not double-decode an escaped entity', () => {
    expect(parseOgMetadata(html('literal &amp;#x27; here'), 'https://x.com').title).toBe(
      'literal &#x27; here',
    );
  });

  it('drops out-of-range code points instead of throwing', () => {
    expect(parseOgMetadata(html('bad &#1114112; end'), 'https://x.com').title).toBe('bad  end');
  });

  it('leaves an unknown entity untouched', () => {
    expect(parseOgMetadata(html('x &notreal; y'), 'https://x.com').title).toBe('x &notreal; y');
  });
});
