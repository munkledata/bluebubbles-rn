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

describe('the FP-006 restored route in the refusal check', () => {
  const HEIC = { uri: 'file:///a.heic', name: 'IMG_0001.HEIC', mimeType: 'image/heic', size: 42 };
  const both = { narrow: true, restored: true };
  const groupOnly = { narrow: false, restored: true };

  it('lets a HEIC, a video and a large picture through once the restored route is on', () => {
    expect(imessageAttachmentRefusal([HEIC], false, both)).toBeNull();
    expect(
      imessageAttachmentRefusal(
        [{ ...JPEG, name: 'clip.mov', mimeType: 'video/quicktime', size: 50 * 1024 * 1024 }],
        false,
        both,
      ),
    ).toBeNull();
    expect(
      imessageAttachmentRefusal(
        [{ ...JPEG, size: MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES + 1 }],
        false,
        both,
      ),
    ).toBeNull();
  });

  it('in a group with only the restored route, a JPEG still goes and the reasons name its caps', () => {
    expect(imessageAttachmentRefusal([JPEG], false, groupOnly)).toBeNull();
    // Several files go as separate messages, one after another.
    expect(imessageAttachmentRefusal([JPEG, HEIC], false, groupOnly)).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...HEIC, name: `IMG_${i}.heic` }));
    expect(imessageAttachmentRefusal(eleven, false, groupOnly)).toBe(
      'This iMessage chat sends up to 10 files at a time. Remove some, then send.',
    );
    // One bad file in a batch names that file's problem.
    expect(
      imessageAttachmentRefusal(
        [JPEG, { ...JPEG, name: 'setup.exe', mimeType: 'application/octet-stream' }],
        false,
        groupOnly,
      ),
    ).toBe('This iMessage chat can’t send this kind of file.');
    // The narrow route alone still takes one file per send.
    expect(
      imessageAttachmentRefusal([JPEG, { ...JPEG, uri: 'file:///b.jpg' }], false, {
        narrow: true,
        restored: false,
      }),
    ).toBe('This iMessage chat sends one file at a time. Remove the others, then send.');
    expect(
      imessageAttachmentRefusal(
        [{ ...JPEG, name: 'setup.exe', mimeType: 'application/octet-stream' }],
        false,
        groupOnly,
      ),
    ).toBe('This iMessage chat can’t send this kind of file.');
    expect(
      imessageAttachmentRefusal([{ ...HEIC, size: 100 * 1024 * 1024 + 1 }], false, groupOnly),
    ).toBe('This iMessage chat can send files up to 100 MiB. Choose a smaller file.');
    // A server that advertises larger caps lets the bigger file through, and names its own cap.
    const advertised = { maxFileBytes: 1000 * 1024 * 1024, maxTotalBytes: 1000 * 1024 * 1024 };
    expect(
      imessageAttachmentRefusal(
        [{ ...HEIC, size: 100 * 1024 * 1024 + 1 }],
        false,
        groupOnly,
        advertised,
      ),
    ).toBeNull();
    expect(
      imessageAttachmentRefusal(
        [{ ...HEIC, size: 1000 * 1024 * 1024 + 1 }],
        false,
        groupOnly,
        advertised,
      ),
    ).toBe('This iMessage chat can send files up to 1000 MiB. Choose a smaller file.');
    expect(
      imessageAttachmentRefusal(
        [{ ...JPEG, name: 'notes.txt', mimeType: 'text/plain', size: 2 * 1024 * 1024 }],
        false,
        groupOnly,
      ),
    ).toBe('This iMessage chat can send text files up to 1 MiB. Choose a smaller file.');
  });

  it('keeps the old HEIC message when only the narrow route exists', () => {
    expect(imessageAttachmentRefusal([HEIC], false, { narrow: true, restored: false })).toBe(
      'This iMessage chat can’t send HEIC photos yet. Send a JPEG or PNG instead.',
    );
  });
});
