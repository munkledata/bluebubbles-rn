import { safePathSegment } from '@/services/download/pathSafety';

describe('safePathSegment (attachment path-traversal guard)', () => {
  it('neutralizes the reported exploit: a multi-level traversal guid', () => {
    // Hostile server: guid "../../databases" + transferName "gator.db" would otherwise
    // overwrite the SQLCipher DB. After sanitizing, the guid is a single harmless segment.
    const out = safePathSegment('../../databases');
    expect(out).not.toMatch(/[/\\]/); // no path separators survive
    expect(out).toBe('.._.._databases');
  });

  it('neutralizes a bare parent-directory reference', () => {
    expect(safePathSegment('..')).toBe('_..');
    expect(safePathSegment('.')).toBe('_.');
    expect(safePathSegment('...')).toBe('_...');
  });

  it('strips both forward and back slashes', () => {
    expect(safePathSegment('a/b')).toBe('a_b');
    expect(safePathSegment('a\\b')).toBe('a_b');
    expect(safePathSegment('/etc/passwd')).toBe('_etc_passwd');
  });

  it('leaves legitimate guids and filenames unchanged', () => {
    expect(safePathSegment('B1C2D3E4-1111-2222-3333-444455556666')).toBe(
      'B1C2D3E4-1111-2222-3333-444455556666',
    );
    expect(safePathSegment('at_0_ABC123')).toBe('at_0_ABC123');
    expect(safePathSegment('IMG_4021.HEIC')).toBe('IMG_4021.HEIC');
    expect(safePathSegment('my.photo.final.jpg')).toBe('my.photo.final.jpg');
  });

  it('never returns a value containing a path separator, for any input', () => {
    for (const s of ['../x', '..\\x', 'a/../../b', 'c:\\windows\\system32', '////']) {
      expect(safePathSegment(s)).not.toMatch(/[/\\]/);
    }
  });
});
