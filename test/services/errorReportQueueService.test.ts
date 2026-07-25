// `flushErrorReports` (below) lives in services/errors/index, which pulls expo-constants,
// react-native and the native DB handle. Stub ONLY those leaves — the queue service, the session
// store and the feature-settings store under test stay real.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.30' } },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, constants: { Model: 'Pixel 9' } },
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { post: jest.fn() } }));
jest.mock('@/services/errors/errorReportSink', () => ({
  errorReportSink: { flushToDb: jest.fn(async () => {}) },
  captureError: jest.fn(),
}));
jest.mock('@/services/errors/globalErrorHandlers', () => ({
  installGlobalErrorHandlers: jest.fn(),
}));

import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import type { ServerInfo } from '@core/models';
import { insertErrorReport, listRetryableErrorReports } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSessionStore } from '@state/sessionStore';
import { flushErrorReports } from '@/services/errors';
import { runErrorReportQueue } from '@/services/errors/errorReportQueueService';
import { createTestDb } from '../support/testDb';

const { getDatabase: mockGetDatabase } = jest.requireMock('@db/database') as {
  getDatabase: jest.Mock;
};
const { http: mockHttp } = jest.requireMock('@/services/clients') as { http: { post: jest.Mock } };
const { errorReportSink: mockSink } = jest.requireMock('@/services/errors/errorReportSink') as {
  errorReportSink: { flushToDb: jest.Mock };
};

function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}
const count = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM error_reports').get() as { c: number }).c;

async function seed(db: AppDatabase, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertErrorReport(db, {
      level: 'error',
      message: `[t] e${i}`,
      stack: `at f${i}`,
      tag: 't',
      createdAt: 1000 + i,
    });
  }
}

describe('runErrorReportQueue', () => {
  it('uploads a batch (with device context) and deletes the rows on success', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 3);
    let sent: Record<string, unknown> | undefined;
    const http = fakeHttp(async (json) => {
      sent = json as Record<string, unknown>;
      return { ingested: 3 };
    });
    const res = await runErrorReportQueue(db, http, 5000, { appVersion: '1.2.3', platform: 'android' });
    expect(res).toEqual({ eligible: 3, uploaded: 3 });
    expect(count(raw)).toBe(0);
    expect((sent!.reports as unknown[]).length).toBe(3);
    expect(sent!.appVersion).toBe('1.2.3');
    expect((sent!.reports as Record<string, unknown>[])[0]!.tag).toBe('t');
  });

  it('marks failed + keeps rows on a network error, then succeeds after the backoff', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 1);
    const fail = fakeHttp(async () => {
      throw new ApiError('no_connection', 'down', 0);
    });
    expect(await runErrorReportQueue(db, fail, 5000)).toEqual({ eligible: 1, uploaded: 0 });
    expect(count(raw)).toBe(1);
    expect((await listRetryableErrorReports(db, 5000)).length).toBe(0); // leased + backed off
    const ok = fakeHttp(async () => ({ ingested: 1 }));
    expect((await runErrorReportQueue(db, ok, 5000 + 40_000)).uploaded).toBe(1);
    expect(count(raw)).toBe(0);
  });

  it('leaves rows buffered when the server reports ingestion disabled', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    const disabled = fakeHttp(async () => ({ ingested: 0, disabled: true }));
    expect((await runErrorReportQueue(db, disabled, 5000)).uploaded).toBe(0);
    expect(count(raw)).toBe(2); // not deleted — wait for the capability to return
  });

  it('does not double-upload when two runners race (atomic claim)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db, 2);
    let uploadedTotal = 0;
    const http = fakeHttp(async (json) => {
      const n = (json as { reports: unknown[] }).reports.length;
      uploadedTotal += n;
      return { ingested: n };
    });
    const [a, b] = await Promise.all([
      runErrorReportQueue(db, http, 5000),
      runErrorReportQueue(db, http, 5000),
    ]);
    expect(a.uploaded + b.uploaded).toBe(2);
    expect(uploadedTotal).toBe(2); // each row uploaded exactly once
    expect(count(raw)).toBe(0);
  });
});

/**
 * `flushErrorReports` is the only thing deciding whether captured crash data ever LEAVES the
 * device. Each of its three gates is a separate promise to the user — "we have nowhere to send it",
 * "your server doesn't accept uploads", "you turned this off" — and a deleted gate is invisible:
 * the queue keeps working, the suite keeps passing, and reports quietly start shipping.
 *
 * The real queue runs here (not a mock), so "no upload" is proved by the strongest available
 * evidence: no HTTP POST at all, and the buffered rows still sitting in the DB afterwards.
 */
describe('flushErrorReports gates', () => {
  const CONNECTED = { origin: 'https://srv.example.com', password: 'pw' };
  const capable = { supports_error_log_upload: true } as unknown as ServerInfo;
  const notCapable = { supports_error_log_upload: false } as unknown as ServerInfo;

  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    await seed(db, 2);
    mockGetDatabase.mockReturnValue(db);
    mockHttp.post.mockResolvedValue({ ingested: 2 });
    // Fully-open state; each test then closes exactly one gate.
    useSessionStore.setState({ ...CONNECTED, serverInfo: capable });
    useFeatureSettingsStore.setState({ errorReportingEnabled: true });
  });

  it('uploads when every gate is open (control — proves the gate tests can fail)', async () => {
    await flushErrorReports();
    expect(mockSink.flushToDb).toHaveBeenCalled();
    expect(mockHttp.post).toHaveBeenCalledTimes(1);
    expect(count(raw)).toBe(0); // rows shipped and deleted
  });

  it('uploads nothing when there are no credentials (not connected)', async () => {
    useSessionStore.setState({ origin: null, password: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(mockSink.flushToDb).not.toHaveBeenCalled(); // gated before the buffer is even persisted
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the origin is present but the password is missing', async () => {
    useSessionStore.setState({ ...CONNECTED, password: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the server does not advertise supports_error_log_upload', async () => {
    useSessionStore.setState({ ...CONNECTED, serverInfo: notCapable });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the server capability is absent entirely (older server)', async () => {
    useSessionStore.setState({ ...CONNECTED, serverInfo: null });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });

  it('uploads nothing when the user turned errorReportingEnabled off', async () => {
    useFeatureSettingsStore.setState({ errorReportingEnabled: false });
    await flushErrorReports();
    expect(mockHttp.post).not.toHaveBeenCalled();
    expect(mockSink.flushToDb).not.toHaveBeenCalled();
    expect(count(raw)).toBe(2);
  });
});
