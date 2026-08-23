import { MAX_PASTED_FILES, parsePasteEvent } from '@/services/paste/pastePayload';

const NOW = 1_700_000_000_000;
const parse = (value: unknown) => parsePasteEvent(value, { now: NOW });

describe('parsePasteEvent', () => {
  it('returns an empty paste for junk payloads', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      expect(parse(junk)).toEqual({ tag: null, files: [], dropped: 0 });
    }
  });

  it('treats a missing/!array files field as an empty paste', () => {
    expect(parse({ tag: 7 })).toEqual({ tag: 7, files: [], dropped: 0 });
    expect(parse({ tag: 7, files: 'x' })).toEqual({ tag: 7, files: [], dropped: 0 });
  });

  it('preserves a native all-or-nothing batch rejection count', () => {
    expect(parse({ tag: 7, files: [], dropped: 4 })).toEqual({
      tag: 7,
      files: [],
      dropped: 4,
    });
    expect(parse({ tag: 7, files: [], dropped: 'many' })).toEqual({
      tag: 7,
      files: [],
      dropped: 0,
    });
  });

  it('maps a pasted image to a staged attachment', () => {
    const result = parse({
      tag: 21,
      files: [
        {
          uri: 'file:///data/cache/pasted-in/1/shot.png',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 4096,
        },
      ],
    });
    expect(result.tag).toBe(21);
    expect(result.dropped).toBe(0);
    expect(result.files).toEqual([
      {
        uri: 'file:///data/cache/pasted-in/1/shot.png',
        name: 'shot.png',
        mimeType: 'image/png',
        size: 4096,
      },
    ]);
  });

  it('passes a PDF through intact — paste is not images-only', () => {
    const result = parse({
      tag: 3,
      files: [
        {
          uri: 'file:///data/cache/pasted-in/1/invoice.pdf',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          size: 91_234,
        },
      ],
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.mimeType).toBe('application/pdf');
    expect(result.files[0]?.name).toBe('invoice.pdf');
  });

  it('rejects any uri that is not an app-private file:// path', () => {
    // A content:// uri would upload once and then fail forever on the retry queue, which
    // re-reads localPath after a restart.
    const result = parse({
      files: [
        {
          uri: 'content://media/external/images/media/1234',
          name: 'a.png',
          mimeType: 'image/png',
          size: 10,
        },
        { uri: '/data/cache/pasted-in/1/b.png', name: 'b.png', mimeType: 'image/png', size: 10 },
        { uri: '', name: 'c.png', mimeType: 'image/png', size: 10 },
      ],
    });
    expect(result.files).toEqual([]);
    expect(result.dropped).toBe(3);
  });

  it('drops zero-byte and unparseable-size entries', () => {
    const result = parse({
      files: [
        { uri: 'file:///c/empty.png', name: 'empty.png', mimeType: 'image/png', size: 0 },
        { uri: 'file:///c/nosize.png', name: 'nosize.png', mimeType: 'image/png' },
        { uri: 'file:///c/bad.png', name: 'bad.png', mimeType: 'image/png', size: 'huge' },
      ],
    });
    expect(result.files).toEqual([]);
    expect(result.dropped).toBe(3);
  });

  it('accepts a size reported as a decimal string', () => {
    const result = parse({
      files: [{ uri: 'file:///c/a.png', name: 'a.png', mimeType: 'image/png', size: '2048' }],
    });
    expect(result.files[0]?.size).toBe(2048);
  });

  it('skips non-object entries instead of trusting the native payload', () => {
    const result = parse({
      files: [
        ['junk', 'array'],
        null,
        'string',
        { uri: 'file:///c/ok.png', name: 'ok.png', mimeType: 'image/png', size: 12 },
      ],
    });
    expect(result.files).toHaveLength(1);
    expect(result.dropped).toBe(3);
  });

  it('falls back to the extension for a missing mime type', () => {
    const result = parse({
      files: [{ uri: 'file:///c/doc.pdf', name: 'doc.pdf', size: 5 }],
    });
    expect(result.files[0]?.mimeType).toBe('application/pdf');
  });

  it('falls back to octet-stream when neither mime nor extension is known', () => {
    const result = parse({
      files: [{ uri: 'file:///c/blob', name: 'blob', size: 5 }],
    });
    expect(result.files[0]?.mimeType).toBe('application/octet-stream');
  });

  it('synthesizes a safe name when the native side reported none', () => {
    const result = parse({
      files: [{ uri: 'file:///c/pasted-in/1/x.png', mimeType: 'image/png', size: 5 }],
    });
    const name = result.files[0]?.name ?? '';
    expect(name).toMatch(/\.png$/);
    expect(name).not.toContain('/');
  });

  it('neutralizes a traversal-shaped name', () => {
    const result = parse({
      files: [
        { uri: 'file:///c/a.png', name: '../../etc/passwd.png', mimeType: 'image/png', size: 5 },
      ],
    });
    const name = result.files[0]?.name ?? '';
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('caps how many files one paste can stage', () => {
    const files = Array.from({ length: MAX_PASTED_FILES + 5 }, (_, i) => ({
      uri: `file:///c/${i}.png`,
      name: `${i}.png`,
      mimeType: 'image/png',
      size: 10,
    }));
    expect(parse({ files }).files).toHaveLength(MAX_PASTED_FILES);
  });

  it('ignores a non-numeric tag', () => {
    expect(parse({ tag: 'nope', files: [] }).tag).toBeNull();
  });
});
