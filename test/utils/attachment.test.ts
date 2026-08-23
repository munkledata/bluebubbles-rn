import {
  attachmentFileName,
  attachmentKind,
  extensionForMime,
  fileTypeLabel,
  friendlySize,
  isLocalFileUri,
  shouldAutoDownload,
} from '@utils';

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
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 100, localPath: 'file://x' }),
    ).toBe(false);
  });
});
