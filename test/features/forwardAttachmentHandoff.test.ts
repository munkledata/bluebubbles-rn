import {
  clearForwardAttachmentHandoffs,
  consumeForwardAttachmentHandoff,
  MAX_FORWARD_ATTACHMENT_BYTES,
  MAX_FORWARD_ATTACHMENTS,
  MAX_FORWARD_TOTAL_BYTES,
  stageForwardAttachmentHandoff,
  type ForwardAttachmentCandidate,
} from '@features/conversations/forwardAttachmentHandoff';

const DOCUMENT_ROOT = 'file:///data/user/0/chat.example/files/';
const CACHE_ROOT = 'file:///data/user/0/chat.example/cache/';
const NONCE = '11111111-1111-4111-8111-111111111111';

function file(
  index = 0,
  uri = `${DOCUMENT_ROOT}attachments/file-${index}.jpg`,
): ForwardAttachmentCandidate {
  return { uri, name: `file-${index}.jpg`, mimeType: 'image/jpeg' };
}

function stage(
  attachments: ForwardAttachmentCandidate[],
  options: {
    nonce?: string;
    now?: number;
    isCurrent?: () => boolean;
    protectPath?: (path: string) => { release(): void } | null;
  } = {},
): string | null {
  return stageForwardAttachmentHandoff({
    nonce: options.nonce ?? NONCE,
    attachments,
    isCurrent: options.isCurrent ?? (() => true),
    now: options.now,
    protectPath: options.protectPath,
  });
}

function consume(
  nonce: unknown,
  fileInfo: (uri: string) => { exists: boolean; size: number | null },
  now?: number,
  onProtectionLease?: (release: () => void) => void,
) {
  return consumeForwardAttachmentHandoff(nonce, {
    ownedRoots: [CACHE_ROOT, DOCUMENT_ROOT],
    fileInfo,
    now,
    onProtectionLease,
  });
}

beforeEach(clearForwardAttachmentHandoffs);
afterEach(clearForwardAttachmentHandoffs);

describe('forward attachment handoff', () => {
  it('returns a re-statted app-owned file exactly once', () => {
    expect(stage([file()])).toBe(NONCE);
    expect(consume(NONCE, () => ({ exists: true, size: 1234 }))).toEqual([
      { ...file(), size: 1234 },
    ]);
    expect(consume(NONCE, () => ({ exists: true, size: 1234 }))).toEqual([]);
  });

  it('rejects unknown public tokens and non-v4 token shapes without probing disk', () => {
    const fileInfo = jest.fn(() => ({ exists: true, size: 1 }));
    expect(consume('not-a-token', fileInfo)).toEqual([]);
    expect(consume('22222222-2222-4222-8222-222222222222', fileInfo)).toEqual([]);
    expect(fileInfo).not.toHaveBeenCalled();
  });

  it.each([
    ['outside app storage', 'file:///sdcard/DCIM/private.jpg'],
    ['a sibling of an owned root', 'file:///data/user/0/chat.example/files-evil/private.jpg'],
    ['an encoded parent traversal', `${DOCUMENT_ROOT}attachments/%2e%2e/%2e%2e/private.jpg`],
    ['an encoded path separator', `${DOCUMENT_ROOT}attachments%2fprivate.jpg`],
  ])('rejects %s', (_label, uri) => {
    expect(stage([file(0, uri)])).toBe(NONCE);
    const fileInfo = jest.fn(() => ({ exists: true, size: 1 }));
    expect(consume(NONCE, fileInfo)).toEqual([]);
    expect(fileInfo).not.toHaveBeenCalled();
  });

  it('enforces the attachment count before creating a handoff', () => {
    expect(
      stage(Array.from({ length: MAX_FORWARD_ATTACHMENTS + 1 }, (_unused, index) => file(index))),
    ).toBeNull();
    expect(consume(NONCE, () => ({ exists: true, size: 1 }))).toEqual([]);
  });

  it.each([
    ['missing', { exists: false, size: 1 }],
    ['unknown-sized', { exists: true, size: null }],
    ['empty', { exists: true, size: 0 }],
    ['fractional-sized', { exists: true, size: 1.5 }],
    ['oversized', { exists: true, size: MAX_FORWARD_ATTACHMENT_BYTES + 1 }],
  ])('rejects a %s file after re-stat', (_label, info) => {
    expect(stage([file()])).toBe(NONCE);
    expect(consume(NONCE, () => info)).toEqual([]);
  });

  it('rejects the whole batch when re-statted bytes exceed the aggregate limit', () => {
    const bytesEach = Math.floor(MAX_FORWARD_TOTAL_BYTES / 5) + 1;
    expect(bytesEach).toBeLessThan(MAX_FORWARD_ATTACHMENT_BYTES);
    expect(stage(Array.from({ length: 5 }, (_unused, index) => file(index)))).toBe(NONCE);
    expect(consume(NONCE, () => ({ exists: true, size: bytesEach }))).toEqual([]);
  });

  it('expires handoffs and disowns them across account changes', () => {
    expect(stage([file()], { now: 1000 })).toBe(NONCE);
    expect(consume(NONCE, () => ({ exists: true, size: 1 }), 5 * 60 * 1000 + 1001)).toEqual([]);

    let current = true;
    const otherNonce = '22222222-2222-4222-8222-222222222222';
    expect(stage([file()], { nonce: otherNonce, isCurrent: () => current })).toBe(otherNonce);
    current = false;
    expect(consume(otherNonce, () => ({ exists: true, size: 1 }))).toEqual([]);
  });

  it('holds source pins across navigation and transfers their release to the composer', () => {
    const release = jest.fn();
    const protectPath = jest.fn(() => ({ release }));
    expect(stage([file()], { protectPath })).toBe(NONCE);
    expect(protectPath).toHaveBeenCalledWith(file().uri);
    expect(release).not.toHaveBeenCalled();

    let releaseLease = (): void => undefined;
    expect(
      consume(
        NONCE,
        () => ({ exists: true, size: 1234 }),
        undefined,
        (transferred) => {
          releaseLease = transferred;
        },
      ),
    ).toEqual([{ ...file(), size: 1234 }]);
    expect(release).not.toHaveBeenCalled();

    releaseLease();
    releaseLease();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails the whole handoff and releases earlier pins when any source cannot be protected', () => {
    const firstRelease = jest.fn();
    const protectPath = jest
      .fn()
      .mockReturnValueOnce({ release: firstRelease })
      .mockReturnValueOnce(null);

    expect(stage([file(0), file(1)], { protectPath })).toBeNull();
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(consume(NONCE, () => ({ exists: true, size: 1 }))).toEqual([]);
  });
});
