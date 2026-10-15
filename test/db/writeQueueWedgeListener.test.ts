/**
 * A wedged write queue cannot save its own error report, because saving needs that same queue. The
 * watchdog therefore also tells an installed listener, which error reporting uses to keep a record
 * outside SQLite for the next launch (review M045). The listener runs once, only when the queue has
 * stopped moving, and a failing listener cannot break the watchdog.
 */
import { logger } from '@core/secure';
import { setWriteQueueWedgeListener, withDbTransaction } from '@db/transaction';
import { holdRollingBackDbNeighbour } from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

afterEach(() => {
  setWriteQueueWedgeListener(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('tells the listener once the queue stops moving, never while it is merely slow', async () => {
  const { db, raw } = await createTestDb();
  const events: string[] = [];
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation((message: string) => {
    events.push(`report:${message}`);
  });
  setWriteQueueWedgeListener(() => {
    events.push('listener');
    throw new Error('recording failed');
  });
  jest.useFakeTimers();

  // Slow but moving: the lock changes hands while the last caller waits, so nothing is reported.
  const first = holdRollingBackDbNeighbour(db, () => undefined);
  await first.entered;
  const second = holdRollingBackDbNeighbour(db, () => undefined);
  const third = withDbTransaction(db, async () => 'third');
  await jest.advanceTimersByTimeAsync(10_000);
  await first.cleanup();
  await second.entered;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(events).toEqual([]);
  await second.cleanup();
  await expect(third).resolves.toBe('third');

  // Stopped: nothing releases across both intervals, so the wedge is reported, then the listener
  // runs. Its failure is contained; the parked write still lands once the lock frees.
  const holder = holdRollingBackDbNeighbour(db, () => undefined);
  await holder.entered;
  const parked = withDbTransaction(db, async () => 'parked');
  await jest.advanceTimersByTimeAsync(20_000);
  expect(events).toEqual(['report:[db] write queue appears wedged', 'listener']);

  // Reported once per process: a later stuck caller does not tell the listener again.
  const later = withDbTransaction(db, async () => 'later');
  await jest.advanceTimersByTimeAsync(20_000);
  expect(events).toHaveLength(2);

  await holder.cleanup();
  await expect(parked).resolves.toBe('parked');
  await expect(later).resolves.toBe('later');
  raw.close();
});
