/**
 * The share-capture orchestration (src/services/share/captureShare.ts) — parse → copy → stage →
 * clear the native intent.
 *
 * Two contracts matter beyond the happy path:
 *   - ORDER: files are staged BEFORE the native intent is cleared, so the payload is durable
 *     before the only other copy of it is dropped.
 *   - SILENCE IS A BUG: a share that can't be read must toast and must NOT stage, so the navigator
 *     doesn't route the user to an empty composer (the exact "nothing happened" symptom).
 */
import { createShareCapture } from '@/services/share/captureShare';
import type { ShareFileIO } from '@/services/share/materializeShare';
import type { SharedAttachment } from '@state/shareIntentStore';
import { logger } from '@core/secure';

const NOW = 1_700_000_000_000;
const ROOT = 'file:///cache/shared-in/';

afterEach(() => {
  jest.restoreAllMocks();
});

function harness(over: { io?: Partial<ShareFileIO>; cacheRoot?: string } = {}) {
  const calls: string[] = [];
  const disk = new Map<string, number>();
  const io: ShareFileIO = {
    makeDir: jest.fn(async () => {}),
    copy: jest.fn(async (_from: string, to: string) => {
      calls.push('copy');
      disk.set(to, 4096);
    }),
    stat: jest.fn(async (uri: string) => ({ exists: disk.has(uri), size: disk.get(uri) ?? 0 })),
    listDir: jest.fn(async () => []),
    remove: jest.fn(async () => {}),
    ...over.io,
  };
  const stage = jest.fn((_payload: { text: string | null; files: SharedAttachment[] }) => {
    calls.push('stage');
  });
  const clearNativeIntent = jest.fn(() => calls.push('clear'));
  const toast = jest.fn(() => calls.push('toast'));
  const capture = createShareCapture({
    io,
    cacheRoot: over.cacheRoot ?? ROOT,
    privateRoots: ['/data/app/cache/'],
    clearNativeIntent,
    stage,
    toast,
    now: () => NOW,
  });
  return { capture, io, stage, clearNativeIntent, toast, calls, disk };
}

const pdfEvent = {
  files: [
    {
      contentUri: 'content://com.tmobile.provider/files/9',
      filePath: '/document/acc=1;doc=9',
      fileName: 'bill.pdf',
      fileSize: '20480',
      mimeType: 'application/pdf',
    },
  ],
};

describe('createShareCapture', () => {
  it('materializes a shared PDF and stages it before clearing the native intent', async () => {
    const h = harness();
    await h.capture(pdfEvent);

    expect(h.stage).toHaveBeenCalledWith({
      text: null,
      files: [
        {
          uri: `${ROOT}${NOW}/bill.pdf`,
          name: 'bill.pdf',
          mimeType: 'application/pdf',
          size: 4096,
        },
      ],
    });
    expect(h.calls).toEqual(['copy', 'stage', 'clear']);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('stages shared text without touching the filesystem', async () => {
    const h = harness();
    await h.capture({ text: 'look at https://example.com now' });

    expect(h.stage).toHaveBeenCalledWith({ text: 'https://example.com', files: [] });
    expect(h.io.copy).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['stage', 'clear']);
  });

  it('toasts and stages NOTHING when every file is unreadable', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const h = harness({ io: { copy: jest.fn(async () => {}) } }); // resolves, writes nothing
    await h.capture(pdfEvent);

    expect(h.stage).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.clearNativeIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[share] copy produced no file (application/pdf) — dropping');
    expect(errorLog).toHaveBeenCalledWith(
      '[share] all shared files were unreadable',
      expect.any(String),
      { affectedCount: 1 },
    );
  });

  it('stages the survivors and warns when only some files fail', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const h = harness();
    h.io.copy = jest.fn(async (from: string, to: string) => {
      if (from === 'content://bad') throw new Error("Location isn't readable.");
      h.disk.set(to, 4096);
    });
    await h.capture({
      files: [
        { contentUri: 'content://bad', fileName: 'bad.pdf', mimeType: 'application/pdf' },
        { contentUri: 'content://good', fileName: 'good.pdf', mimeType: 'application/pdf' },
      ],
    });

    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.stage.mock.calls[0]?.[0]).toMatchObject({
      files: [expect.objectContaining({ name: 'good.pdf' })],
    });
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[share] could not materialize a shared file (application/pdf): Location isn't readable.",
    );
    expect(warn).toHaveBeenNthCalledWith(2, '[share] 1 shared file(s) could not be read');
  });

  it('clears the native intent without staging for an empty payload', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const h = harness();
    await h.capture({});
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.clearNativeIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[share] received a share with no usable text or files');
  });

  it('handles a payload with no usable file (the bogus /document path, no contentUri)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const h = harness();
    await h.capture({
      files: [{ filePath: '/document/acc=1;doc=9', mimeType: 'application/pdf' }],
    });
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.clearNativeIntent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[share] received a share with no usable text or files');
  });

  it('bails with a toast when there is no cache directory', async () => {
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const h = harness({ cacheRoot: '' });
    await h.capture(pdfEvent);
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      '[share] no cache directory available — cannot accept shared files',
      expect.any(String),
    );
  });

  it('never rejects, even when staging itself throws', async () => {
    const error = new Error('store exploded');
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const h = harness();
    h.stage.mockImplementation(() => {
      throw error;
    });
    await expect(h.capture(pdfEvent)).resolves.toBeUndefined();
    // The native intent is still dropped so the app can't get stuck re-firing it.
    expect(h.clearNativeIntent).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith('[share] capture failed', expect.any(String), error);
  });

  it('prunes old cache batches after a successful capture', async () => {
    const h = harness({ io: { listDir: jest.fn(async () => ['1']) } });
    await h.capture(pdfEvent);
    // Fire-and-forget — let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.io.remove).toHaveBeenCalledWith(`${ROOT}1`);
  });
});
