import { attachmentKind, fileTypeLabel, friendlySize, shouldAutoDownload } from '@utils';

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

describe('shouldAutoDownload', () => {
  it('auto-downloads small images only', () => {
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 100_000, localPath: null }),
    ).toBe(true);
    expect(shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: null, localPath: null })).toBe(
      true,
    );
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 9_000_000, localPath: null }),
    ).toBe(false);
    expect(shouldAutoDownload({ mimeType: 'video/mp4', totalBytes: 1000, localPath: null })).toBe(
      false,
    );
    expect(
      shouldAutoDownload({ mimeType: 'image/jpeg', totalBytes: 100, localPath: 'file://x' }),
    ).toBe(false);
  });
});
