import { attachmentChipLabel, classifyAttachmentKind, smsSnippetLabel } from '@core/sms';

describe('classifyAttachmentKind', () => {
  it('classifies by top-level MIME type', () => {
    expect(classifyAttachmentKind('image/jpeg')).toBe('image');
    expect(classifyAttachmentKind('image/gif')).toBe('image');
    expect(classifyAttachmentKind('video/mp4')).toBe('video');
    expect(classifyAttachmentKind('audio/amr')).toBe('audio');
  });

  it('is case-insensitive and trims', () => {
    expect(classifyAttachmentKind('  IMAGE/PNG ')).toBe('image');
    expect(classifyAttachmentKind('Video/3gpp')).toBe('video');
  });

  it('falls back to file for unknown/empty types', () => {
    expect(classifyAttachmentKind('application/pdf')).toBe('file');
    expect(classifyAttachmentKind('text/x-vcard')).toBe('file');
    expect(classifyAttachmentKind('')).toBe('file');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(classifyAttachmentKind(undefined as any)).toBe('file');
  });
});

describe('attachmentChipLabel', () => {
  it('uses a stable kind word for video/audio', () => {
    expect(attachmentChipLabel({ contentType: 'video/mp4', fileName: 'clip.mp4' })).toBe('Video');
    expect(attachmentChipLabel({ contentType: 'audio/amr', fileName: 'vm.amr' })).toBe('Audio');
  });

  it('uses the file name for generic files', () => {
    expect(attachmentChipLabel({ contentType: 'application/pdf', fileName: 'invoice.pdf' })).toBe(
      'invoice.pdf',
    );
  });

  it('falls back to Attachment when no name', () => {
    expect(attachmentChipLabel({ contentType: 'application/octet-stream', fileName: '' })).toBe(
      'Attachment',
    );
    expect(attachmentChipLabel({ contentType: '', fileName: '   ' })).toBe('Attachment');
  });
});

describe('smsSnippetLabel', () => {
  it('returns the snippet when present', () => {
    expect(smsSnippetLabel('Hey there')).toBe('Hey there');
    expect(smsSnippetLabel('  spaced  ')).toBe('spaced');
  });

  it('labels an empty snippet as Attachment', () => {
    expect(smsSnippetLabel('')).toBe('Attachment');
    expect(smsSnippetLabel('   ')).toBe('Attachment');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(smsSnippetLabel(undefined as any)).toBe('Attachment');
  });
});
