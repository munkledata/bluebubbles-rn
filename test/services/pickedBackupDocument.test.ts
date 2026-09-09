const native = {
  prepare: jest.fn(),
  cancel: jest.fn(),
  releasePrepared: jest.fn(),
  read: jest.fn(),
};
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// eslint-disable-next-line import/first
import { BACKUP_LIMITS } from '@/services/backup/backupSchema';
// eslint-disable-next-line import/first
import {
  PickedBackupDocumentError,
  readPickedBackupDocument,
} from '@/services/backup/pickedBackupDocument';

beforeEach(() => {
  moduleRef.current = native;
  native.prepare.mockReset();
  native.cancel.mockReset();
  native.releasePrepared.mockReset();
  native.read.mockReset().mockResolvedValue({ ok: true, text: '  café  ', bytes: 9 });
});

it('uses the prepared native stream boundary and accepts absent picker size metadata', async () => {
  await expect(readPickedBackupDocument('content://documents/backup', null)).resolves.toBe('café');

  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    native.read.mock.invocationCallOrder[0]!,
  );
  expect(native.read).toHaveBeenCalledWith(
    requestId,
    'content://documents/backup',
    BACKUP_LIMITS.fileBytes,
    15_000,
  );
  expect(native.cancel).toHaveBeenCalledWith(requestId);
  expect(native.releasePrepared).not.toHaveBeenCalled();
});

it('rejects oversized picker metadata before preparing native work', async () => {
  await expect(
    readPickedBackupDocument('content://documents/oversized', BACKUP_LIMITS.fileBytes + 1),
  ).rejects.toThrow('backup-input-limit:file-too-large');

  expect(native.prepare).not.toHaveBeenCalled();
  expect(native.read).not.toHaveBeenCalled();
});

it('cancels the live native stream when the AbortSignal fires', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  native.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ok: false, reason: 'cancelled' });
      }),
  );

  const pending = readPickedBackupDocument(
    'content://documents/slow-provider',
    undefined,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();

  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.cancel).toHaveBeenCalledWith(requestId);
  finish();
  await expect(pending).rejects.toEqual(
    expect.objectContaining<Partial<PickedBackupDocumentError>>({ reason: 'cancelled' }),
  );
});

it('fails closed when the owned native module is unavailable', async () => {
  moduleRef.current = null;

  await expect(readPickedBackupDocument('content://documents/backup')).rejects.toEqual(
    expect.objectContaining<Partial<PickedBackupDocumentError>>({ reason: 'unavailable' }),
  );
});

it('releases a prepared slot when the read bridge throws synchronously', async () => {
  native.read.mockImplementationOnce(() => {
    throw new Error('bridge failed for content://private/identifier');
  });

  await expect(readPickedBackupDocument('content://documents/backup')).rejects.toThrow(
    'picked-backup-document:unavailable',
  );
  const requestId = native.prepare.mock.calls[0]![0] as string;
  expect(native.releasePrepared).toHaveBeenCalledWith(requestId);
  expect(native.cancel).not.toHaveBeenCalled();
});

it('rejects malformed native success results', async () => {
  native.read.mockResolvedValueOnce({ ok: true, text: 'backup', bytes: NaN });

  await expect(readPickedBackupDocument('content://documents/backup')).rejects.toEqual(
    expect.objectContaining<Partial<PickedBackupDocumentError>>({ reason: 'invalid' }),
  );
});
