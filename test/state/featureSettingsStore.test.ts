import { getDatabase } from '@db/database';
import { insertErrorReport, kvGet, kvSet } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  AUTO_DOWNLOAD_DEST_KEY,
  ERROR_REPORTING_CONSENT_KEY,
  type ErrorReportingConsentWriteContext,
  LEGACY_ERROR_REPORTING_KEY,
  MAX_CONCURRENT_DOWNLOADS_KEY,
  useFeatureSettingsStore,
} from '@state/featureSettingsStore';
import {
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  setMaxConcurrentDownloads,
} from '@/services/download/downloadService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
// Keep the real cap constants; spy the semaphore push so we can assert it fires on hydrate + set.
jest.mock('@/services/download/downloadService', () => ({
  ...jest.requireActual('@/services/download/downloadService'),
  setMaxConcurrentDownloads: jest.fn(),
}));

const mockGetDatabase = getDatabase as jest.Mock;
const mockApplyDownloads = setMaxConcurrentDownloads as jest.Mock;

const DEFAULTS = {
  privateApiEnabled: true,
  sendTypingIndicators: true,
  sendReadReceipts: true,
  autoDownloadAttachments: true,
  autoDownloadOnWifiOnly: false,
  sendWithReturn: false,
  showDeliveryTimestamps: true,
  compactChatList: false,
  messageNotifications: true,
  errorReportingEnabled: false,
} as const;

async function openTestContext() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t;
}

async function openTestDb(): Promise<AppDatabase> {
  return (await openTestContext()).db;
}

function consentContext(
  db: AppDatabase,
  shouldCommit: () => boolean = () => true,
): ErrorReportingConsentWriteContext {
  return { db, shouldCommit };
}

function rejectConsentUpdates(raw: import('better-sqlite3').Database): void {
  raw.exec(`
    CREATE TRIGGER reject_error_reporting_consent
    BEFORE UPDATE OF value ON kv
    WHEN OLD.key = '${ERROR_REPORTING_CONSENT_KEY}'
    BEGIN
      SELECT RAISE(ABORT, 'CONSENT_WRITE_RAW_CANARY');
    END
  `);
}

function rejectErrorReportDeletes(raw: import('better-sqlite3').Database): void {
  raw.exec(`
    CREATE TRIGGER reject_error_report_delete
    BEFORE DELETE ON error_reports
    BEGIN
      SELECT RAISE(ABORT, 'ERROR_REPORT_PURGE_RAW_CANARY');
    END
  `);
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockApplyDownloads.mockClear();
  useFeatureSettingsStore.setState({
    ...DEFAULTS,
    maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    autoDownloadDestination: 'album',
    hydrated: false,
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('featureSettingsStore', () => {
  it('hydrates every flag to its default when nothing was persisted', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({ ...DEFAULTS, hydrated: true });
  });

  it('fails closed for error reporting before hydration while preserving ordinary defaults', () => {
    // Services read via getState() before launch hydration completes. Diagnostics are the one flag
    // that must not inherit the old always-on default.
    expect(useFeatureSettingsStore.getState()).toMatchObject(DEFAULTS);
  });

  it('survives the DB not being open yet (hydrated stays false, no throw)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({ ...DEFAULTS, hydrated: false });
  });

  it('reports an active hydration failure without publishing fallback state', async () => {
    const error = new Error('Database not initialized');
    mockGetDatabase.mockImplementation(() => {
      throw error;
    });
    const onError = jest.fn();

    await useFeatureSettingsStore.getState().hydrate({ onError });

    expect(onError).toHaveBeenCalledWith(error);
    expect(useFeatureSettingsStore.getState()).toMatchObject({ ...DEFAULTS, hydrated: false });
  });

  it('does not publish state, apply runtime values, or migrate consent after revocation', async () => {
    const db = await openTestDb();
    let current = true;
    const onError = jest.fn();
    mockApplyDownloads.mockClear();

    const pending = useFeatureSettingsStore.getState().hydrate({
      shouldCommit: () => current,
      onError,
    });
    current = false;
    await pending;

    expect(useFeatureSettingsStore.getState()).toMatchObject({
      ...DEFAULTS,
      maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      autoDownloadDestination: 'album',
      hydrated: false,
    });
    expect(mockApplyDownloads).not.toHaveBeenCalled();
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rechecks ownership inside the queued consent migration before writing', async () => {
    const db = await openTestDb();
    const shouldCommit = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
    mockApplyDownloads.mockClear();

    await useFeatureSettingsStore.getState().hydrate({ shouldCommit });

    expect(shouldCommit).toHaveBeenCalledTimes(3);
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBeNull();
    expect(mockApplyDownloads).not.toHaveBeenCalled();
    expect(useFeatureSettingsStore.getState().hydrated).toBe(false);
  });

  it('setFlag persists under the flag-specific kv key and hydrates back', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setFlag('sendReadReceipts', false);
    expect(useFeatureSettingsStore.getState().sendReadReceipts).toBe(false);
    expect(await kvGet(db, 'privateApi.sendReadReceipts')).toBe('0');

    useFeatureSettingsStore.setState({ ...DEFAULTS, hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      ...DEFAULTS,
      sendReadReceipts: false, // the persisted override
      hydrated: true,
    });
  });

  it('hydrate merges persisted overrides without disturbing untouched flags', async () => {
    const db = await openTestDb();
    await kvSet(db, 'attachments.autoDownload', '0');
    await kvSet(db, 'conversation.sendWithReturn', '1');
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      ...DEFAULTS,
      autoDownloadAttachments: false,
      sendWithReturn: true,
      hydrated: true,
    });
  });

  it('setFlag keeps the in-memory toggle when the persist fails', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().setFlag('compactChatList', true);
    expect(useFeatureSettingsStore.getState().compactChatList).toBe(true);
  });
});

describe('featureSettingsStore — versioned error-reporting consent', () => {
  it('defaults a new install OFF and seals an explicit denied value', async () => {
    const db = await openTestDb();

    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: false,
      hydrated: true,
    });
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
  });

  it('rejects a legacy enabled toggle as informed consent and purges its old queue', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, LEGACY_ERROR_REPORTING_KEY, '1');
    await insertErrorReport(db, {
      level: 'error',
      message: '[consent] captured under the pre-consent toggle',
      createdAt: Date.now(),
    });

    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: false,
      hydrated: true,
    });
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM error_reports').get() as { count: number }).count,
    ).toBe(0);
  });

  it('seals a legacy disabled toggle as denied', async () => {
    const db = await openTestDb();
    await kvSet(db, LEGACY_ERROR_REPORTING_KEY, '0');

    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
  });

  it('replaces a corrupt versioned choice with denied', async () => {
    const db = await openTestDb();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, '1');

    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
  });

  it('treats the versioned choice as authoritative over conflicting legacy state', async () => {
    const db = await openTestDb();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    await kvSet(db, LEGACY_ERROR_REPORTING_KEY, '1');

    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
  });

  it('persists explicit informed consent and hydrates it back', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setErrorReportingConsent(true, consentContext(db));
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');

    useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();

    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: true,
      hydrated: true,
    });
  });

  it('captures the caller database before the serialized tail can observe a new global database', async () => {
    const accountA = await openTestContext();
    const accountB = await createTestDb();
    await kvSet(accountA.db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    await kvSet(accountB.db, ERROR_REPORTING_CONSENT_KEY, 'denied');

    mockGetDatabase.mockReturnValue(accountA.db);
    const write = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(true, consentContext(accountA.db));
    // The shared DB pointer can change before the tail's first Promise callback. The write still
    // belongs to the exact database supplied synchronously by account A.
    mockGetDatabase.mockReturnValue(accountB.db);
    await write;

    expect(await kvGet(accountA.db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(await kvGet(accountB.db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true);
  });

  it('drops a revoked write after a rolling-back neighbour, then lets fresh B persist exactly', async () => {
    const accountA = await openTestContext();
    const accountB = await createTestDb();
    await kvSet(accountA.db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    await kvSet(accountB.db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    const leaseA = captureRealtimeDeliveryLease();

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourError = new Error('consent neighbour rollback');
    const neighbour = withDbTransaction(accountA.db, async () => {
      accountA.raw
        .prepare('UPDATE kv SET value = ? WHERE key = ?')
        .run('phantom', ERROR_REPORTING_CONSENT_KEY);
      neighbourStarted();
      await held;
      throw neighbourError;
    }).catch((error: unknown) => error);
    await started;

    let staleSettled = false;
    const staleWrite = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(
        true,
        consentContext(accountA.db, () => leaseA.isCurrent()),
      )
      .finally(() => {
        staleSettled = true;
      });
    // Let the serialized tail reach the transaction queue. A guard checked only before claiming
    // that queue would see A as current here, then incorrectly commit after the handoff.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const settledBeforeRetirement = staleSettled;
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    releaseNeighbour();
    const [rolledBack] = await Promise.all([neighbour, staleWrite]);
    const stateAfterStale = useFeatureSettingsStore.getState().errorReportingEnabled;
    const accountAValue = await kvGet(accountA.db, ERROR_REPORTING_CONSENT_KEY);

    mockGetDatabase.mockReturnValue(accountB.db);
    const leaseB = captureRealtimeDeliveryLease();
    await useFeatureSettingsStore.getState().setErrorReportingConsent(
      true,
      consentContext(accountB.db, () => leaseB.isCurrent()),
    );

    expect(settledBeforeRetirement).toBe(false);
    expect(rolledBack).toBe(neighbourError);
    expect(accountAValue).toBe('denied');
    expect(stateAfterStale).toBe(false);
    expect(await kvGet(accountB.db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true);
  });

  it('lets a newer queued choice supersede an older current choice without touching its database', async () => {
    const older = await openTestContext();
    const newer = await createTestDb();
    await kvSet(older.db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    await kvSet(newer.db, ERROR_REPORTING_CONSENT_KEY, 'granted');

    let releaseNeighbour!: () => void;
    let neighbourStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const neighbour = withDbTransaction(older.db, async () => {
      neighbourStarted();
      await held;
    });
    await started;

    const olderGrant = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(true, consentContext(older.db));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const newerDenial = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(false, consentContext(newer.db));
    releaseNeighbour();
    await Promise.all([neighbour, olderGrant, newerDenial]);

    expect(await kvGet(older.db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
    expect(await kvGet(newer.db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
  });

  it('rolls back a current database failure, rejects, and releases the tail for retry', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'denied');
    rejectConsentUpdates(raw);

    await expect(
      useFeatureSettingsStore.getState().setErrorReportingConsent(true, consentContext(db)),
    ).rejects.toMatchObject({ message: 'CONSENT_WRITE_RAW_CANARY' });
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: false,
      hydrated: false,
    });
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');

    raw.exec('DROP TRIGGER reject_error_reporting_consent');
    await useFeatureSettingsStore.getState().setErrorReportingConsent(true, consentContext(db));
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: true,
      hydrated: true,
    });
  });

  it('contains an error that becomes stale between the inner and outer catches', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'granted');
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    rejectConsentUpdates(raw);
    const lease = captureRealtimeDeliveryLease();
    let guardCalls = 0;
    let retirement: Promise<void> | undefined;
    const shouldCommit = (): boolean => {
      guardCalls += 1;
      // Calls 1–4 cover setter admission, tail admission, and both pre-body transaction guards.
      // Call 5 is the inner catch: retire in the next microtask so the outer catch owns no error.
      if (guardCalls === 5) {
        queueMicrotask(() => {
          retirement = pauseRealtimeDeliveries();
        });
      }
      return lease.isCurrent();
    };

    await expect(
      useFeatureSettingsStore
        .getState()
        .setErrorReportingConsent(false, consentContext(db, shouldCommit)),
    ).resolves.toBeUndefined();
    await retirement;

    expect(guardCalls).toBeGreaterThanOrEqual(6);
    expect(lease.isCurrent()).toBe(false);
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
  });

  it('revokes immediately but restores the last confirmed choice when persistence fails', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'granted');
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    rejectConsentUpdates(raw);

    const disabling = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(false, consentContext(db));
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
    await expect(disabling).rejects.toMatchObject({ message: 'CONSENT_WRITE_RAW_CANARY' });
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: true,
      hydrated: true,
    });
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
  });

  it('commits denial and queue purge atomically, then releases the tail for retry', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'granted');
    await insertErrorReport(db, {
      level: 'error',
      message: '[consent] must be retired with denial',
      createdAt: Date.now(),
    });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
    rejectErrorReportDeletes(raw);

    await expect(
      useFeatureSettingsStore.getState().setErrorReportingConsent(false, consentContext(db)),
    ).rejects.toThrow("Failed to run the query 'DELETE FROM error_reports'");
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM error_reports').get() as { count: number }).count,
    ).toBe(1);
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      errorReportingEnabled: true,
      hydrated: true,
    });

    raw.exec('DROP TRIGGER reject_error_report_delete');
    await useFeatureSettingsStore.getState().setErrorReportingConsent(false, consentContext(db));
    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('denied');
    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM error_reports').get() as { count: number }).count,
    ).toBe(0);
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(false);
  });

  it('clears the queue when a newer Allow supersedes an Off before its transaction starts', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, ERROR_REPORTING_CONSENT_KEY, 'granted');
    await insertErrorReport(db, {
      level: 'error',
      message: '[consent] captured before rapid choice change',
      createdAt: Date.now(),
    });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });

    let releaseNeighbour!: () => void;
    let neighbourStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await held;
    });
    await started;

    const olderOff = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(false, consentContext(db));
    const newerAllow = useFeatureSettingsStore
      .getState()
      .setErrorReportingConsent(true, consentContext(db));
    releaseNeighbour();
    await Promise.all([neighbour, olderOff, newerAllow]);

    expect(await kvGet(db, ERROR_REPORTING_CONSENT_KEY)).toBe('granted');
    expect(
      (raw.prepare('SELECT COUNT(*) AS count FROM error_reports').get() as { count: number }).count,
    ).toBe(0);
    expect(useFeatureSettingsStore.getState().errorReportingEnabled).toBe(true);
  });
});

describe('featureSettingsStore — maxConcurrentDownloads value setting', () => {
  it('hydrates the default when nothing was persisted', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      hydrated: true,
    });
  });

  it('round-trips a persisted cap', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(4);
    expect(await kvGet(db, MAX_CONCURRENT_DOWNLOADS_KEY)).toBe('4');
    useFeatureSettingsStore.setState({ maxConcurrentDownloads: 2, hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState()).toMatchObject({
      maxConcurrentDownloads: 4,
      hydrated: true,
    });
  });

  it.each([
    [0, 1], // below the floor
    [99, 6], // above MAX_CONCURRENT_DOWNLOADS_LIMIT
    [3.9, 3], // fractional → floored
    [NaN, DEFAULT_MAX_CONCURRENT_DOWNLOADS],
  ])('clamps setMaxConcurrentDownloads(%p) to %p', async (input, expected) => {
    await openTestDb();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(input);
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(expected);
  });

  it('sanitizes a corrupt persisted value on hydrate', async () => {
    const db = await openTestDb();
    await kvSet(db, MAX_CONCURRENT_DOWNLOADS_KEY, 'lots');
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().maxConcurrentDownloads).toBe(
      DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    );
  });

  it('pushes the cap into the download semaphore on hydrate and on set', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(mockApplyDownloads).toHaveBeenCalledWith(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    mockApplyDownloads.mockClear();
    await useFeatureSettingsStore.getState().setMaxConcurrentDownloads(4);
    expect(mockApplyDownloads).toHaveBeenCalledWith(4);
  });

  it('survives the DB not being open yet (hydrated stays false, no throw)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().hydrated).toBe(false);
  });
});

describe('featureSettingsStore — autoDownloadDestination', () => {
  it('hydrates the default (album) when nothing was persisted', async () => {
    await openTestDb();
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().autoDownloadDestination).toBe('album');
  });

  it('round-trips a persisted destination', async () => {
    const db = await openTestDb();
    await useFeatureSettingsStore.getState().setAutoDownloadDestination('gallery');
    expect(await kvGet(db, AUTO_DOWNLOAD_DEST_KEY)).toBe('gallery');
    useFeatureSettingsStore.setState({ autoDownloadDestination: 'album', hydrated: false });
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().autoDownloadDestination).toBe('gallery');
  });

  it('falls back to the default for a corrupt persisted value', async () => {
    const db = await openTestDb();
    await kvSet(db, AUTO_DOWNLOAD_DEST_KEY, 'nonsense');
    await useFeatureSettingsStore.getState().hydrate();
    expect(useFeatureSettingsStore.getState().autoDownloadDestination).toBe('album');
  });
});
