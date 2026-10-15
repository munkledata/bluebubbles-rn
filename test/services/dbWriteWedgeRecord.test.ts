/**
 * A wedged write queue cannot save its own error report, because saving needs that same queue. The
 * wedge is therefore kept as a marker file outside SQLite and replayed on a later launch, once that
 * account's error reporting is live (review M045). The record never outlives its account or the
 * user's consent, and is only deleted once the replayed report was actually taken.
 */
/* eslint-disable import/first -- Jest mocks must be registered before importing application modules. */
const mockMarker = {
  marked: false,
  isMarked: jest.fn<boolean, []>(),
  mark: jest.fn<void, []>(),
  clear: jest.fn<void, []>(),
};
let mockDb: unknown;

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.30' } },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, constants: { Model: 'Pixel 9' } },
}));
jest.mock('@db/database', () => ({ getDatabase: () => mockDb }));
// Disconnect's reset also clears the Find My store, whose API module loads the ESM-only HTTP client.
jest.mock('@core/api', () => ({ findMyApi: {} }));
jest.mock('@/services/clients', () => ({
  http: { post: jest.fn() },
  dbWriteWedgeMarker: {
    isMarked: () => mockMarker.isMarked(),
    mark: () => mockMarker.mark(),
    clear: () => mockMarker.clear(),
  },
}));
jest.mock('@/services/errors/globalErrorHandlers', () => ({
  installGlobalErrorHandlers: jest.fn(),
}));

import type Database from 'better-sqlite3';
import type { ServerInfo } from '@core/models';
import { ERROR_DIAGNOSTIC_SITES, logger } from '@core/secure';
import * as transaction from '@db/transaction';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSessionStore } from '@state/sessionStore';
import { http } from '@/services/clients';
import { flushErrorReports, initErrorReporting } from '@/services/errors';
import { errorReportSink } from '@/services/errors/errorReportSink';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { resetSessionScopedState } from '@/services/sessionScopedState';
import { holdRollingBackDbNeighbour } from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

/** The queue stores the projected event name, not the log line. */
const WEDGE = 'db.write_queue_wedged';
const setListener = jest.spyOn(transaction, 'setWriteQueueWedgeListener');

/** The listener boot installed, i.e. what the watchdog calls when the queue wedges. */
function installedWedgeListener(): () => void {
  const listener = setListener.mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('error reporting installed no wedge listener');
  return listener;
}

function storedMessages(raw: Database.Database): string[] {
  return raw
    .prepare('SELECT message FROM error_reports ORDER BY id')
    .all()
    .map((row) => (row as { message: string }).message);
}

async function freshDb(): Promise<Database.Database> {
  const { db, raw } = await createTestDb();
  mockDb = db;
  return raw;
}

beforeEach(() => {
  mockMarker.marked = false;
  mockMarker.isMarked.mockReset().mockImplementation(() => mockMarker.marked);
  mockMarker.mark.mockReset().mockImplementation(() => {
    mockMarker.marked = true;
  });
  mockMarker.clear.mockReset().mockImplementation(() => {
    mockMarker.marked = false;
  });
  resumeRealtimeDeliveries();
  useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
  // Not connected: the replay must not depend on an upload being possible right now.
  useSessionStore.setState({ origin: null, password: null, serverInfo: null });
});

it('replays a wedge an earlier run recorded, once reporting is live, then deletes the record', async () => {
  const raw = await freshDb();
  mockMarker.marked = true; // left behind by the run whose queue wedged

  initErrorReporting();
  await flushErrorReports();
  // Queued, not yet saved: the record stays until the sink saves the report.
  expect(mockMarker.marked).toBe(true);

  await errorReportSink.flushToDb();
  expect(storedMessages(raw)).toEqual([WEDGE]);
  await flushErrorReports();
  expect(mockMarker.marked).toBe(false);

  // Replayed once: a later flush in the same run does not report it again.
  await flushErrorReports();
  await errorReportSink.flushToDb();
  expect(storedMessages(raw)).toEqual([WEDGE]);
});

it('keeps a wedge from this run for the next launch instead of replaying it now', async () => {
  const raw = await freshDb();
  initErrorReporting();

  installedWedgeListener()();
  expect(mockMarker.marked).toBe(true);

  await flushErrorReports();
  await errorReportSink.flushToDb();
  expect(mockMarker.marked).toBe(true);
  expect(storedMessages(raw)).toEqual([]);
});

it('keeps the record when the report could not be taken, and replays it on a later flush', async () => {
  const raw = await freshDb();
  mockMarker.marked = true;
  initErrorReporting();

  // Another report is mid-save behind a held lock, so the sink is busy and drops new reports.
  const neighbour = holdRollingBackDbNeighbour(mockDb as never, () => undefined);
  await neighbour.entered;
  logger.error('[sync] run failed', ERROR_DIAGNOSTIC_SITES.syncRun, {});
  const saving = errorReportSink.flushToDb();
  await flushErrorReports();
  expect(mockMarker.marked).toBe(true);

  await neighbour.cleanup();
  await saving;
  await flushErrorReports();
  await errorReportSink.flushToDb();
  expect(storedMessages(raw)).toEqual(['sync.run_failed', WEDGE]);
  await flushErrorReports();
  expect(mockMarker.marked).toBe(false);
});

it('deletes the record only after the replayed report is saved', async () => {
  // Review of M045: deleting the record when the report merely entered memory lost it if the app
  // was killed before the save.
  const raw = await freshDb();
  mockMarker.marked = true;
  initErrorReporting();

  // Connected to a server that takes reports, so the flush saves the queued replay itself before
  // its (here failing) upload; another transaction holds the lock meanwhile.
  useSessionStore.setState({
    origin: 'https://server.example',
    password: 'pw',
    serverInfo: { supports_error_log_upload: true } as unknown as ServerInfo,
  });
  (http.post as jest.Mock).mockRejectedValue(new Error('offline'));
  const neighbour = holdRollingBackDbNeighbour(mockDb as never, () => undefined);
  await neighbour.entered;
  const flushing = flushErrorReports();
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // The report is queued but cannot be saved while the lock is held.
  expect(mockMarker.marked).toBe(true);

  await neighbour.cleanup();
  await flushing;
  expect(storedMessages(raw)).toEqual([WEDGE]);
  expect(mockMarker.marked).toBe(false);
});

it("does not replay an earlier wedge while this run's own queue is wedged", async () => {
  // Review of M045: the replay could never be saved then, and deleting the record would also erase
  // the only trace of this run's wedge, which shares the same file.
  await freshDb();
  mockMarker.marked = true;
  initErrorReporting();

  installedWedgeListener()();
  await flushErrorReports();

  expect(mockMarker.clear).not.toHaveBeenCalled();
  expect(mockMarker.marked).toBe(true);
});

it('records nothing without consent or after Disconnect, and both delete an existing record', async () => {
  await freshDb();
  initErrorReporting();
  const listener = installedWedgeListener();

  // Turning error reporting off deletes the record and stops new ones.
  listener();
  expect(mockMarker.marked).toBe(true);
  useFeatureSettingsStore.setState({ errorReportingEnabled: false, hydrated: true });
  expect(mockMarker.marked).toBe(false);
  listener();
  expect(mockMarker.marked).toBe(false);

  // Disconnect deletes this account's record before anything else can run.
  useFeatureSettingsStore.setState({ errorReportingEnabled: true, hydrated: true });
  listener();
  expect(mockMarker.marked).toBe(true);
  resetSessionScopedState();
  expect(mockMarker.marked).toBe(false);

  // A wedge after the account was retired is not recorded for the next one.
  await pauseRealtimeDeliveries();
  listener();
  expect(mockMarker.marked).toBe(false);
});
