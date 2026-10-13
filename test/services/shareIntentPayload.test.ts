/**
 * Safe single-segment file names and mime <-> extension mapping
 * (src/services/share/shareIntentPayload.ts), shared by paste intake and attachment downloads.
 */
import {
  DEFAULT_MIME,
  extensionForMime,
  mimeForExtension,
  safeShareFileName,
} from '@/services/share/shareIntentPayload';

const NOW = 1_700_000_000_000;

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
