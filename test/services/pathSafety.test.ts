import {
  encodedMediaPathSegment,
  isPotentialAttachmentCacheFileUri,
  MAX_ENCODED_MEDIA_SEGMENT_CHARS,
  mediaGenerationPathSegment,
  parseAttachmentCacheFileUri,
  safePathSegment,
} from '@/services/download/pathSafety';

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

describe('encodedMediaPathSegment (collision-safe server media namespace)', () => {
  it('keeps values distinct even when replacement sanitizing would collapse them', () => {
    expect(encodedMediaPathSegment('a/b')).toBe('media-a%2Fb');
    expect(encodedMediaPathSegment('a/b')).not.toBe(encodedMediaPathSegment('a_b'));
    expect(encodedMediaPathSegment('a\\b')).not.toBe(encodedMediaPathSegment('a_b'));
  });

  it('never emits a separator or special dot segment', () => {
    for (const input of ['.', '..', '../x', 'c:\\windows']) {
      const segment = encodedMediaPathSegment(input);
      expect(segment).toMatch(/^media-/);
      expect(segment).not.toMatch(/[/\\]/);
      expect(segment).not.toBe('.');
      expect(segment).not.toBe('..');
    }
  });

  it('rejects the empty spelling that native cache ownership deliberately excludes', () => {
    expect(() => encodedMediaPathSegment('')).toThrow('must not be empty');
  });

  it('rejects values that cannot safely fit one filesystem segment', () => {
    expect(() => encodedMediaPathSegment('x'.repeat(MAX_ENCODED_MEDIA_SEGMENT_CHARS + 1))).toThrow(
      'too long',
    );
  });

  it('fails closed for malformed Unicode instead of silently collapsing it', () => {
    expect(() => encodedMediaPathSegment('\ud800')).toThrow('invalid Unicode');
  });
});

describe('parseAttachmentCacheFileUri (startup recovery namespace)', () => {
  it('round-trips a native scanner URI including twice-escaped server separators', () => {
    expect(
      parseAttachmentCacheFileUri(
        'file:///data/user/0/chat/files/attachments/media-a%252Fb/generation-17/media-My%2520Photo.jpg',
      ),
    ).toEqual({ attachmentGuid: 'a/b', generation: 17, transferName: 'My Photo.jpg' });
  });

  it('accepts the explicit unscoped namespace', () => {
    expect(
      parseAttachmentCacheFileUri(
        'file:///data/user/0/chat/files/attachments/media-guid/generation-unscoped/media-file.pdf',
      ),
    ).toEqual({ attachmentGuid: 'guid', generation: 'unscoped', transferName: 'file.pdf' });
  });

  it.each([
    ['public content URI', 'content://provider/attachments/media-guid/generation-1/media-file.jpg'],
    ['wrong root', 'file:///data/user/0/chat/files/secrets/media-guid/generation-1/media-file.jpg'],
    ['wrong depth', 'file:///data/user/0/chat/files/attachments/media-guid/media-file.jpg'],
    ['noncanonical generation', 'file:///x/attachments/media-guid/generation-01/media-file.jpg'],
    ['unsafe generation', 'file:///x/attachments/media-guid/generation--1/media-file.jpg'],
    ['unencoded physical slash', 'file:///x/attachments/media-a%2Fb/generation-1/media-file.jpg'],
    ['encoded alias', 'file:///x/attachments/media-%2541/generation-1/media-file.jpg'],
    ['query', 'file:///x/attachments/media-guid/generation-1/media-file.jpg?other=1'],
    ['fragment', 'file:///x/attachments/media-guid/generation-1/media-file.jpg#other'],
  ])('rejects %s', (_label, uri) => {
    expect(parseAttachmentCacheFileUri(uri)).toBeNull();
  });
});

describe('isPotentialAttachmentCacheFileUri (fail-closed namespace classifier)', () => {
  it.each([
    'file:///data/user/0/chat/files/attachments/media-guid/generation-1/media-file.jpg',
    'file:///data/user/0/chat/files/attachments/media-guid/generation-01/media-file.jpg',
    'file:///data/user/0/chat/files/attachments/corrupt-depth',
    'file:///data/user/0/chat/files/%61ttachments/media-guid/generation-1/media-file.jpg?bad=1',
  ])('recognizes canonical and malformed managed paths: %s', (uri) => {
    expect(isPotentialAttachmentCacheFileUri(uri)).toBe(true);
  });

  it.each([
    'file:///data/user/0/chat/files/other/media-guid/generation-1/media-file.jpg',
    'file:///storage/emulated/0/Download/photo.jpg',
    'content://provider/attachments/media-guid/generation-1/media-file.jpg',
  ])('does not classify an unrelated URI: %s', (uri) => {
    expect(isPotentialAttachmentCacheFileUri(uri)).toBe(false);
  });
});

describe('mediaGenerationPathSegment', () => {
  it('uses a stable safe namespace when no account lease was supplied', () => {
    expect(mediaGenerationPathSegment()).toBe('generation-unscoped');
    expect(mediaGenerationPathSegment(null)).toBe('generation-unscoped');
  });

  it('keeps canonical account generations distinct', () => {
    expect(mediaGenerationPathSegment(7)).toBe('generation-7');
    expect(mediaGenerationPathSegment(8)).toBe('generation-8');
  });

  it('rejects generations that the native cache boundary cannot own', () => {
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => mediaGenerationPathSegment(generation)).toThrow('non-negative safe integer');
    }
  });
});
