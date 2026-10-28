import { MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES } from '@core/models/serverInfo';
import { imessageAttachmentRefusal } from '@features/conversations/imessageAttachmentRefusal';
import { isSupportedImessageAttachmentFile } from '@/services/send/sendAttachmentService';

const JPEG = { uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 42 };

describe('why a one-to-one iMessage chat cannot send staged files', () => {
  it('accepts one supported file', () => {
    expect(imessageAttachmentRefusal([JPEG], false)).toBeNull();
    expect(
      imessageAttachmentRefusal([{ ...JPEG, name: 'a.pdf', mimeType: 'application/pdf' }], true),
    ).toBeNull();
  });

  it('names the reason for each kind of file it refuses', () => {
    expect(imessageAttachmentRefusal([JPEG, { ...JPEG, uri: 'file:///b.jpg' }], true)).toBe(
      'This iMessage chat sends one file at a time. Remove the others, then send.',
    );
    for (const heic of [
      { ...JPEG, name: 'IMG_0001.HEIC', mimeType: 'image/heic' },
      { ...JPEG, name: 'photo', mimeType: 'image/heif' },
      { ...JPEG, name: 'photo.heif', mimeType: 'application/octet-stream' },
    ]) {
      expect(imessageAttachmentRefusal([heic], true)).toBe(
        'This iMessage chat can’t send HEIC photos yet. Send a JPEG or PNG instead.',
      );
    }
    const video = { ...JPEG, name: 'clip.mp4', mimeType: 'video/mp4' };
    expect(imessageAttachmentRefusal([video], true)).toBe(
      'This iMessage chat can send only a JPEG, PNG, or PDF file.',
    );
    expect(imessageAttachmentRefusal([video], false)).toBe(
      'This iMessage chat can send only a JPEG or PNG image.',
    );
    expect(
      imessageAttachmentRefusal([{ ...JPEG, name: 'a.pdf', mimeType: 'application/pdf' }], false),
    ).toBe('This iMessage chat can send only a JPEG or PNG image.');
    expect(
      imessageAttachmentRefusal(
        [{ ...JPEG, size: MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES + 1 }],
        true,
      ),
    ).toBe('This iMessage chat can send files up to 10 MiB. Choose a smaller file.');
  });

  it('refuses exactly what the send service refuses', () => {
    const names = ['a.jpg', 'a.JPEG', 'a.png', 'a.pdf', 'a.heic', 'a.mp4', 'a', ''];
    const types = ['image/jpeg', 'image/png', 'application/pdf', 'image/heic', 'video/mp4', ''];
    const sizes = [
      -1,
      0,
      1,
      1.5,
      MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES,
      MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES + 1,
      Number.NaN,
    ];
    let checked = 0;
    for (const name of names) {
      for (const mimeType of types) {
        for (const size of sizes) {
          for (const pdfAvailable of [false, true]) {
            const file = { uri: 'file:///x', name, mimeType, size };
            const serviceSends =
              isSupportedImessageAttachmentFile(file) &&
              (mimeType !== 'application/pdf' || pdfAvailable);
            expect(imessageAttachmentRefusal([file], pdfAvailable) === null).toBe(serviceSends);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(names.length * types.length * sizes.length * 2);
  });
});
