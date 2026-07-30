import { openAttachmentFile, resolveViewType } from '@/services/openFile';

// --- native mocks -----------------------------------------------------------------------------
// Test-controlled backing values for the File instance openFile.ts constructs.
let fileExists = true;
let fileContentUri: unknown = 'content://com.gator.FileSystemFileProvider/attachments/g/report.pdf';

jest.mock('expo-file-system', () => ({
  File: class {
    constructor(public uri: string) {}
    get exists(): boolean {
      return fileExists;
    }
    get contentUri(): unknown {
      return fileContentUri;
    }
  },
}));

const getContentUriAsync = jest.fn<Promise<string>, [string]>();
jest.mock('expo-file-system/legacy', () => ({
  getContentUriAsync: (p: string) => getContentUriAsync(p),
}));

const startActivityAsync = jest.fn();
jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: (...args: unknown[]) => startActivityAsync(...args),
}));

const shareAttachment = jest.fn();
jest.mock('@/services/media', () => ({
  shareAttachment: (...args: unknown[]) => shareAttachment(...args),
}));

const FILE = 'file:///data/user/0/com.gator/files/attachments/g/report.pdf';
const CONTENT = 'content://com.gator.FileSystemFileProvider/attachments/g/report.pdf';
const OPTS = { settleMs: 5 };

describe('resolveViewType', () => {
  it('passes a real mime through, lowercased', () => {
    expect(resolveViewType('application/pdf')).toBe('application/pdf');
    expect(resolveViewType('  Application/PDF ')).toBe('application/pdf');
  });

  it('returns undefined for nothing useful, so Android infers from the provider', () => {
    // A generic octet-stream intent matches almost no viewer; omitting `type` makes Android
    // resolve via ContentResolver.getType() (FileProvider's extension lookup), which is better.
    expect(resolveViewType('application/octet-stream')).toBeUndefined();
    expect(resolveViewType('*/*')).toBeUndefined();
    expect(resolveViewType(null)).toBeUndefined();
    expect(resolveViewType(undefined)).toBeUndefined();
    expect(resolveViewType('')).toBeUndefined();
  });
});

describe('openAttachmentFile', () => {
  beforeEach(() => {
    fileExists = true;
    fileContentUri = CONTENT;
    getContentUriAsync.mockResolvedValue(CONTENT);
    // jest config sets clearMocks:true (calls cleared, implementations kept), so set behaviour here.
    startActivityAsync.mockReturnValue(new Promise(() => {})); // resolves only on user return
    shareAttachment.mockResolvedValue({ ok: true });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // THE ANTI-REGRESSION TEST. The old code handed the raw file:// path to a generic opener,
  // which Android forbids. This asserts we pass a content:// uri and never a file:// one.
  it('launches ACTION_VIEW with a content:// uri, never the file:// path', async () => {
    const res = await openAttachmentFile(FILE, 'application/pdf', OPTS);

    expect(res.status).toBe('opened');
    expect(startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', {
      data: CONTENT,
      type: 'application/pdf',
      flags: 1,
    });
    const params = startActivityAsync.mock.calls[0]?.[1] as { data: string };
    expect(params.data).not.toMatch(/^file:/);
  });

  it('treats a launch that never settles as opened (it resolves only on user return)', async () => {
    startActivityAsync.mockReturnValue(new Promise(() => {}));
    await expect(openAttachmentFile(FILE, 'application/pdf', OPTS)).resolves.toEqual({
      status: 'opened',
    });
  });

  it('falls back to the share sheet with the FILE path when no viewer exists', async () => {
    startActivityAsync.mockRejectedValue(new Error('ActivityNotFoundException'));

    const res = await openAttachmentFile(FILE, 'application/pdf', OPTS);

    expect(res.status).toBe('shared');
    // expo-sharing rejects any scheme that is not `file` — the OPPOSITE of ACTION_VIEW.
    expect(shareAttachment).toHaveBeenCalledWith(FILE, 'application/pdf');
    expect(shareAttachment.mock.calls[0]?.[0]).not.toMatch(/^content:/);
  });

  it('reports no_handler when neither a viewer nor the share sheet works', async () => {
    startActivityAsync.mockRejectedValue(new Error('ActivityNotFoundException'));
    shareAttachment.mockResolvedValue({ ok: false, reason: 'unavailable' });

    await expect(openAttachmentFile(FILE, 'application/pdf', OPTS)).resolves.toEqual({
      status: 'no_handler',
    });
  });

  it('reports missing when the local file is gone, touching nothing native', async () => {
    fileExists = false;

    await expect(openAttachmentFile(FILE, 'application/pdf', OPTS)).resolves.toEqual({
      status: 'missing',
    });
    expect(startActivityAsync).not.toHaveBeenCalled();
    expect(shareAttachment).not.toHaveBeenCalled();
  });

  it('reports missing for a null path or a non-local uri, with zero native calls', async () => {
    for (const p of [null, undefined, 'https://example.com/a.pdf', 'content://x/y']) {
      await expect(openAttachmentFile(p, 'application/pdf', OPTS)).resolves.toEqual({
        status: 'missing',
      });
    }
    expect(startActivityAsync).not.toHaveBeenCalled();
  });

  it('falls back to the legacy resolver when File.contentUri is unusable', async () => {
    // `contentUri` is a native Property, so on an older expo-file-system build it is silently
    // undefined — a dataless VIEW intent would look like "no app can open this".
    fileContentUri = undefined;

    const res = await openAttachmentFile(FILE, 'application/pdf', OPTS);

    expect(getContentUriAsync).toHaveBeenCalledWith(FILE);
    expect(res.status).toBe('opened');
    expect((startActivityAsync.mock.calls[0]?.[1] as { data: string }).data).toBe(CONTENT);
  });

  it('shares instead of launching when no content uri can be resolved at all', async () => {
    fileContentUri = 'file:///not-a-content-uri';
    getContentUriAsync.mockRejectedValue(new Error('no provider'));

    const res = await openAttachmentFile(FILE, 'application/pdf', OPTS);

    expect(startActivityAsync).not.toHaveBeenCalled();
    expect(res.status).toBe('shared');
  });

  it('omits the intent type for a generic mime so Android infers it', async () => {
    await openAttachmentFile(FILE, 'application/octet-stream', OPTS);
    expect((startActivityAsync.mock.calls[0]?.[1] as { type?: string }).type).toBeUndefined();
  });

  it('never throws — an unexpected failure reports error', async () => {
    startActivityAsync.mockImplementation(() => {
      throw new Error('bridge exploded');
    });
    shareAttachment.mockRejectedValue(new Error('also broken'));

    await expect(openAttachmentFile(FILE, 'application/pdf', OPTS)).resolves.toEqual({
      status: 'error',
    });
  });
});
