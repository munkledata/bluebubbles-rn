import { assertSafeUploadFilename } from '@utils/uploadFilename';

describe('multipart upload filename', () => {
  it.each([
    'original report.pdf',
    'résumé 📄.pdf',
    'a'.repeat(251) + '.pdf',
    'é'.repeat(125) + '.pdf',
  ])('keeps a safe basename: %s', (name) => {
    expect(() => assertSafeUploadFilename(name)).not.toThrow();
  });

  it.each([
    '',
    '.',
    '..',
    '../photo.jpg',
    'folder/photo.jpg',
    'folder\\photo.jpg',
    'bad\r\nname.pdf',
    'nul\u0000.pdf',
    'bad\u007f.pdf',
    'bad\u0085.pdf',
    'quote".pdf',
    '\ud800.pdf',
    '\udc00.pdf',
    'a'.repeat(252) + '.pdf',
    'é'.repeat(126) + '.pdf',
  ])('rejects unsafe or overlong metadata', (name) => {
    expect(() => assertSafeUploadFilename(name)).toThrow('Choose a file with a valid name');
  });
});
