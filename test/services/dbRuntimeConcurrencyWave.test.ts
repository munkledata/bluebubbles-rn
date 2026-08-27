import { runDbRuntimeConcurrencyWave } from '@/services/boot/dbRuntimeConcurrencyWave';
import { clearFailedSendNotice, notifyFailedSend } from '@/services/send/sendFailureNotice';
import { createTestDb } from '../support/testDb';

jest.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));
jest.mock('@/services/send/sendFailureNotice', () => ({
  clearFailedSendNotice: jest.fn(async () => undefined),
  notifyFailedSend: jest.fn(async () => undefined),
}));

const mockClearFailedSendNotice = jest.mocked(clearFailedSendNotice);
const mockNotifyFailedSend = jest.mocked(notifyFailedSend);

const ALL_TRUE = {
  rollbackIsolation: true,
  syncChunks: true,
  liveMessages: true,
  attachmentConstruction: true,
  uploadOutsideDbOwner: true,
  rekeyExclusive: true,
  queuedWritersBlocked: true,
  rekeyApplied: true,
  queuedWritersResumed: true,
  uploadSettlement: true,
  queueDrained: true,
  sentinelCommit: true,
} as const;

describe('disposable DB runtime concurrency wave', () => {
  beforeEach(() => {
    mockClearFailedSendNotice.mockClear();
    mockNotifyFailedSend.mockClear();
  });

  it('returns the complete host protocol proof on one real SQLite connection', async () => {
    const { db, raw } = await createTestDb();
    const rawRekey = jest.fn(async () => undefined);
    try {
      await expect(runDbRuntimeConcurrencyWave(db, { rawRekey })).resolves.toEqual(ALL_TRUE);
      expect(rawRekey).toHaveBeenCalledTimes(1);
      expect(mockClearFailedSendNotice).not.toHaveBeenCalled();
      expect(mockNotifyFailedSend).not.toHaveBeenCalled();
      expect(raw.inTransaction).toBe(false);
    } finally {
      if (raw.open) raw.close();
    }
  });

  it('reports a rejected injected rekey as false without exposing its private error', async () => {
    const { db, raw } = await createTestDb();
    const privateError = 'private-native-database-path';
    try {
      const result = await runDbRuntimeConcurrencyWave(db, {
        rawRekey: async () => {
          throw new Error(privateError);
        },
      });

      expect(result).toEqual({ ...ALL_TRUE, rekeyApplied: false });
      expect(JSON.stringify(result)).not.toContain(privateError);
      expect(raw.inTransaction).toBe(false);
    } finally {
      if (raw.open) raw.close();
    }
  });

  it('keeps queued writers blocked until the raw native rekey settles', async () => {
    const { db, raw } = await createTestDb();
    let releaseRekey!: () => void;
    const rekeyRelease = new Promise<void>((resolve) => {
      releaseRekey = resolve;
    });
    let markRekeyEntered!: () => void;
    const rekeyEntry = new Promise<void>((resolve) => {
      markRekeyEntered = resolve;
    });
    let waveSettled = false;
    try {
      const wave = runDbRuntimeConcurrencyWave(db, {
        rawRekey: async () => {
          markRekeyEntered();
          await rekeyRelease;
        },
      }).finally(() => {
        waveSettled = true;
      });

      await rekeyEntry;
      await Promise.resolve();
      expect(waveSettled).toBe(false);
      expect(raw.inTransaction).toBe(false);

      releaseRekey();
      await expect(wave).resolves.toEqual(ALL_TRUE);
      expect(raw.inTransaction).toBe(false);
    } finally {
      releaseRekey();
      if (raw.open) raw.close();
    }
  });
});
