import {
  attachmentFileName,
  attachmentKind,
  extensionForMime,
  fileTypeLabel,
  friendlySize,
  isLocalFileUri,
  isUserFileAttachment,
  shouldAutoDownload,
} from '@utils';

describe('isUserFileAttachment', () => {
  const photosApp =
    'com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp';

  it('keeps every attachment of an ordinary message', () => {
    expect(isUserFileAttachment({ mimeType: null, transferName: null }, null)).toBe(true);
  });

  it("shows an iMessage app's typed file but never Apple's payload file", () => {
    expect(
      isUserFileAttachment({ mimeType: 'image/heic', transferName: 'IMG_0001.HEIC' }, photosApp),
    ).toBe(true);
    expect(
      isUserFileAttachment(
        { mimeType: 'image/jpeg', transferName: 'A1B2.PluginPayloadAttachment' },
        photosApp,
      ),
    ).toBe(false);
    // An old server's push copy can omit the hidden flag and these fields; fail closed.
    expect(isUserFileAttachment({ mimeType: null, transferName: 'IMG_1.HEIC' }, photosApp)).toBe(
      false,
    );
    expect(isUserFileAttachment({ mimeType: 'image/jpeg', transferName: null }, photosApp)).toBe(
      false,
    );
  });
});

describe('attachmentKind', () => {
  it('dispatches by MIME', () => {
    expect(attachmentKind('image/png')).toBe('image');
    expect(attachmentKind('video/mp4')).toBe('video');
    expect(attachmentKind('video/quicktime')).toBe('video');
    expect(attachmentKind('audio/m4a')).toBe('audio');
    expect(attachmentKind('text/vcard')).toBe('contact');
    expect(attachmentKind('text/x-vcard')).toBe('contact');
    // x-vlocation is also a vcard; the more specific type must win.
    expect(attachmentKind('text/x-vlocation')).toBe('location');
    expect(attachmentKind('application/pdf')).toBe('file');
    expect(attachmentKind(null)).toBe('file');
  });

  it('treats image formats the phone cannot decode as ordinary files', () => {
    // Android has no decoder for these, so the inline image path could never show them and the
    // download's decode check failed every time.
    for (const mime of ['image/tiff', 'image/svg+xml', 'image/jxl', 'image/x-icon']) {
      expect(attachmentKind(mime)).toBe('file');
    }
    for (const mime of [
      'image/jpeg',
      'image/png',
      'image/PNG',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/heic',
      'image/heif',
      'image/avif',
    ]) {
      expect(attachmentKind(mime)).toBe('image');
    }
  });
});

describe('friendlySize', () => {
  it('formats bytes', () => {
    expect(friendlySize(null)).toBe('');
    expect(friendlySize(512)).toBe('512 B');
    expect(friendlySize(2048)).toBe('2 KB');
    expect(friendlySize(2_500_000)).toBe('2.4 MB');
  });
});

describe('fileTypeLabel', () => {
  it('prefers the extension, then the MIME subtype', () => {
    expect(fileTypeLabel('application/pdf', 'Q3-Report.pdf')).toBe('PDF');
    expect(fileTypeLabel('application/zip', null)).toBe('ZIP');
    expect(fileTypeLabel(null, 'noext')).toBe('FILE');
  });
});

describe('isLocalFileUri', () => {
  it('accepts only file:// URIs (the only scheme production writers emit)', () => {
    expect(isLocalFileUri('file:///data/att/a.jpg')).toBe(true);
    expect(isLocalFileUri('/data/att/a.jpg')).toBe(false); // bare paths never occur
    expect(isLocalFileUri('https://dev.local/a.jpg')).toBe(false);
    expect(isLocalFileUri('')).toBe(false);
    expect(isLocalFileUri(null)).toBe(false);
    expect(isLocalFileUri(undefined)).toBe(false);
  });
});

describe('attachmentFileName', () => {
  it('keeps missing-name fallbacks within the encoded limit, including the MIME extension', () => {
    expect(attachmentFileName(null, 'x'.repeat(176), 'image/png')).toBe(`${'x'.repeat(176)}.png`);
    expect(attachmentFileName(null, 'x'.repeat(177), 'image/png')).toBe('attachment.png');
    expect(attachmentFileName(null, '€'.repeat(20), 'image/png')).toBe('attachment.png');
    expect(attachmentFileName(null, 'x'.repeat(2795), 'video/mp4')).toBe('attachment.mp4');
    expect(attachmentFileName(null, 'x'.repeat(2795), null)).toBe('attachment');
    expect(attachmentFileName('original.png', 'x'.repeat(2795), 'image/png')).toBe('original.png');
  });

  it('leaves malformed Unicode rejection to the guarded destination boundary', () => {
    expect(attachmentFileName(null, '\ud800', 'image/png')).toBe('\ud800.png');
  });
  it('shortens a long server name to fit, keeping its extension, instead of failing the download', () => {
    // About 20 CJK characters used to exceed the encoded limit and make the file undownloadable.
    const longName = `${'季度报告'.repeat(15)}.pdf`;
    const local = attachmentFileName(longName, 'guid-1', 'application/pdf');

    expect(local.endsWith('.pdf')).toBe(true);
    expect(encodeURIComponent(local).length).toBeLessThanOrEqual(180);
    expect(longName.startsWith(local.slice(0, -'.pdf'.length))).toBe(true);
    expect(attachmentFileName(longName, 'guid-1', 'application/pdf')).toBe(local);
  });

  it('never splits an emoji, and falls back to the MIME extension when a long name has none', () => {
    const emoji = attachmentFileName(`${'😀'.repeat(60)}.jpg`, 'guid-2', 'image/jpeg');
    expect(() => encodeURIComponent(emoji)).not.toThrow();
    expect(emoji.endsWith('.jpg')).toBe(true);
    expect(encodeURIComponent(emoji).length).toBeLessThanOrEqual(180);

    const bare = attachmentFileName('x'.repeat(300), 'guid-3', 'image/png');
    expect(bare).toBe(`${'x'.repeat(176)}.png`);
  });

  it('prefers the server-supplied transfer name', () => {
    expect(attachmentFileName('holiday.jpg', 'guid-1', 'image/jpeg')).toBe('holiday.jpg');
  });

  // A nameless attachment used to be saved as the bare guid, which has no dot in it.
  // expo-media-library derives the MediaStore type from the file name and rejects a dotless one
  // outright ("Could not get the file's extension"), so Save-to-Photos could never work for it —
  // and the failure surfaced as a generic error with nothing pointing at the file name.
  it('gives a nameless attachment an extension from its MIME type', () => {
    expect(attachmentFileName(null, 'guid-1', 'image/jpeg')).toBe('guid-1.jpg');
    expect(attachmentFileName(null, 'guid-2', 'video/mp4')).toBe('guid-2.mp4');
    expect(attachmentFileName('', 'guid-3', 'image/png')).toBe('guid-3.png');
  });

  it('falls back to the bare guid when the MIME type is unknown or absent', () => {
    expect(attachmentFileName(null, 'guid-4', 'application/x-made-up')).toBe('guid-4');
    expect(attachmentFileName(null, 'guid-5', null)).toBe('guid-5');
    expect(attachmentFileName(null, 'guid-6')).toBe('guid-6');
  });
});

describe('extensionForMime', () => {
  it('ignores parameters and case', () => {
    expect(extensionForMime('IMAGE/JPEG')).toBe('.jpg');
    expect(extensionForMime('image/jpeg; charset=binary')).toBe('.jpg');
  });

  it('returns an empty string for anything it does not know', () => {
    expect(extensionForMime('application/octet-stream')).toBe('');
    expect(extensionForMime(null)).toBe('');
    expect(extensionForMime(undefined)).toBe('');
  });
});

describe('shouldAutoDownload', () => {
  it('auto-downloads small images only', () => {
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 100_000, localPath: null }),
    ).toBe(true);
    expect(shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: null, localPath: null })).toBe(
      false,
    );
    expect(
      shouldAutoDownload({
        mimeType: 'image/jpeg',
        totalBytes: 6 * 1024 * 1024,
        localPath: null,
      }),
    ).toBe(false);
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: Number.NaN, localPath: null }),
    ).toBe(false);
    expect(shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 0, localPath: null })).toBe(
      false,
    );
    expect(shouldAutoDownload({ mimeType: 'video/mp4', totalBytes: 1000, localPath: null })).toBe(
      false,
    );
    expect(shouldAutoDownload({ mimeType: 'image/tiff', totalBytes: 1000, localPath: null })).toBe(
      false,
    );
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 100, localPath: 'file://x' }),
    ).toBe(false);
  });
});
