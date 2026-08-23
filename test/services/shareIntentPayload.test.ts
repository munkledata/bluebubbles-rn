/**
 * The RAW Android share-intent payload parser (src/services/share/shareIntentPayload.ts).
 *
 * This is the decision table that decides whether a shared PDF is usable at all, so it is tested
 * against the payload shapes the real `ExpoShareIntentModule.getFileInfo` emits — including the
 * two shapes that used to lose the file silently:
 *   - an ExternalStorageProvider share, whose `filePath` is a RAW /storage/emulated/0/... path the
 *     app cannot read (no READ_EXTERNAL_STORAGE above API 32 + scoped storage), and
 *   - a Drive/carrier-app share, whose `filePath` is the bogus `/document/acc=1;doc=…` that the
 *     library falls back to for any DocumentProvider it doesn't special-case.
 * In both cases the `content://` uri is the ONLY readable source, and must win.
 */
import {
  DEFAULT_MIME,
  extensionForMime,
  extractWebUrl,
  mimeForExtension,
  parseRawShareEvent,
  safeShareFileName,
} from '@/services/share/shareIntentPayload';

const NOW = 1_700_000_000_000;
const PRIVATE = ['/data/user/0/com.bluegreengatorapps.messages/cache/'];

const parse = (value: unknown, privateRoots: string[] = PRIVATE) =>
  parseRawShareEvent(value, { privateRoots, now: NOW });

describe('parseRawShareEvent — source selection', () => {
  it('prefers contentUri over a raw external-storage filePath (the Files-app PDF case)', () => {
    const { files } = parse({
      files: [
        {
          contentUri:
            'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbill.pdf',
          filePath: '/storage/emulated/0/Download/bill.pdf',
          fileName: 'bill.pdf',
          fileSize: '20480',
          mimeType: 'application/pdf',
        },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      sourceUri:
        'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbill.pdf',
      fileName: 'bill.pdf',
      mimeType: 'application/pdf',
      reportedSize: 20480,
      alreadyLocal: false,
    });
  });

  it('prefers contentUri over the bogus /document/... path (Drive / carrier apps)', () => {
    const { files } = parse({
      files: [
        {
          contentUri: 'content://com.tmobile.provider/files/9',
          filePath: '/document/acc=1;doc=encoded%3D9',
          fileName: 'statement.pdf',
          mimeType: 'application/pdf',
        },
      ],
    });
    expect(files[0]?.sourceUri).toBe('content://com.tmobile.provider/files/9');
    expect(files[0]?.alreadyLocal).toBe(false);
  });

  it('DROPS an entry whose only source is a bogus /document/... path', () => {
    // The old code turned this into `file:///document/...`, which can never be opened — a file
    // that stages fine and then fails at send time with a misleading network error.
    const { files } = parse({
      files: [{ filePath: '/document/acc=1;doc=encoded%3D9', mimeType: 'application/pdf' }],
    });
    expect(files).toEqual([]);
  });

  it('reuses the library cache copy without re-copying (the working photo/video path)', () => {
    const cached = '/data/user/0/com.bluegreengatorapps.messages/cache/IMG_1.jpg';
    const { files } = parse({
      files: [
        {
          contentUri: 'content://media/external/images/media/42',
          filePath: cached,
          fileName: 'IMG_1.jpg',
          mimeType: 'image/jpeg',
        },
      ],
    });
    expect(files[0]?.sourceUri).toBe(`file://${cached}`);
    expect(files[0]?.alreadyLocal).toBe(true);
  });

  it('falls back to a plausible non-private filePath when there is no contentUri', () => {
    const { files } = parse({
      files: [{ filePath: '/storage/emulated/0/Download/x.pdf', mimeType: 'application/pdf' }],
    });
    expect(files[0]?.sourceUri).toBe('file:///storage/emulated/0/Download/x.pdf');
    expect(files[0]?.alreadyLocal).toBe(false);
  });

  it('drops an entry with neither a contentUri nor a filePath', () => {
    expect(
      parse({ files: [{ fileName: 'ghost.pdf', mimeType: 'application/pdf' }] }).files,
    ).toEqual([]);
  });
});

describe('parseRawShareEvent — malformed payloads', () => {
  it('skips the junk array element the library injects into every single-file SEND', () => {
    // Upstream bug (ExpoShareIntentModule.kt): `arrayOf(getFileInfo(uri), "type" to "file")`
    // puts a serialized Kotlin Pair INSIDE the files array.
    const { files } = parse({
      files: [
        { contentUri: 'content://x/1', fileName: 'a.pdf', mimeType: 'application/pdf' },
        ['type', 'file'],
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toBe('a.pdf');
  });

  it.each([[null], [undefined], ['nonsense'], [42], [{ files: 'not-an-array' }], [{}]])(
    'returns an empty share without throwing for %p',
    (value) => {
      expect(() => parse(value)).not.toThrow();
      expect(parse(value)).toEqual({ text: null, files: [] });
    },
  );

  it('tolerates null entries inside the files array', () => {
    const { files } = parse({ files: [null, { contentUri: 'content://x/1', fileName: 'a.pdf' }] });
    expect(files).toHaveLength(1);
  });
});

describe('parseRawShareEvent — size and mime', () => {
  it('parses a decimal-string fileSize and rejects garbage', () => {
    const sizes = ['1048576', 1024, 'abc', null, undefined, -5].map(
      (fileSize) =>
        parse({ files: [{ contentUri: 'content://x/1', fileName: 'a.pdf', fileSize }] }).files[0]
          ?.reportedSize,
    );
    expect(sizes).toEqual([1048576, 1024, null, null, null, null]);
  });

  it('derives the mime from the filename extension when the provider reports none', () => {
    const { files } = parse({ files: [{ contentUri: 'content://x/1', fileName: 'report.pdf' }] });
    expect(files[0]?.mimeType).toBe('application/pdf');
  });

  it('falls back to application/octet-stream when mime and extension are both unknown', () => {
    const { files } = parse({ files: [{ contentUri: 'content://x/1', fileName: 'mystery' }] });
    expect(files[0]?.mimeType).toBe(DEFAULT_MIME);
  });
});

describe('safeShareFileName', () => {
  it('neutralizes path traversal into a single safe segment', () => {
    const name = safeShareFileName(
      '../../databases/gator.db',
      'content://x/1',
      DEFAULT_MIME,
      0,
      NOW,
    );
    expect(name).not.toMatch(/[/\\]/);
    expect(name).toBe('gator.db');
  });

  it('appends an extension derived from the mime when the name has none', () => {
    expect(safeShareFileName('report', 'content://x/1', 'application/pdf', 0, NOW)).toBe(
      'report.pdf',
    );
  });

  it('generates a deterministic name when the provider supplies none', () => {
    expect(safeShareFileName(null, 'content://x/1', 'application/pdf', 2, NOW)).toBe(
      `shared-${NOW}-2.pdf`,
    );
  });

  it('does NOT use a percent-encoded SAF uri segment as the display name', () => {
    const name = safeShareFileName(
      null,
      'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbill.pdf',
      'application/pdf',
      0,
      NOW,
    );
    expect(name).toBe(`shared-${NOW}-0.pdf`);
  });

  it('caps a very long name while keeping the extension', () => {
    const name = safeShareFileName(`${'a'.repeat(400)}.pdf`, 'content://x/1', 'x', 0, NOW);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('strips control characters but keeps ordinary spaces', () => {
    expect(safeShareFileName('ok\u0007name.pdf', 'content://x/1', 'x', 0, NOW)).toBe('okname.pdf');
    expect(safeShareFileName('my report.pdf', 'content://x/1', 'x', 0, NOW)).toBe('my report.pdf');
  });
});

describe('mime <-> extension', () => {
  it('maps known types both ways', () => {
    expect(extensionForMime('application/pdf')).toBe('pdf');
    expect(mimeForExtension('pdf')).toBe('application/pdf');
    expect(mimeForExtension('PDF')).toBe('application/pdf');
  });

  it('derives an extension from an unknown but well-formed subtype', () => {
    expect(extensionForMime('image/svg+xml')).toBe('svg');
  });

  it('falls back to .bin for octet-stream and nonsense', () => {
    expect(extensionForMime(DEFAULT_MIME)).toBe('bin');
    expect(extensionForMime('???')).toBe('bin');
  });

  it('returns null for an unknown extension', () => {
    expect(mimeForExtension('xyz')).toBeNull();
  });
});

describe('text sharing', () => {
  it('prefers an embedded URL over the surrounding text', () => {
    expect(parse({ text: 'look at https://example.com/x now' }).text).toBe('https://example.com/x');
  });

  it('keeps plain text when there is no URL', () => {
    expect(parse({ text: 'hello there' }).text).toBe('hello there');
  });

  it('extractWebUrl returns null when nothing matches', () => {
    expect(extractWebUrl('no links here')).toBeNull();
  });
});
