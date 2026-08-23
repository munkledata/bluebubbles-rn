import { withDbTransaction } from '@db/transaction';
import {
  holdRollingBackDbNeighbour,
  observePromise,
  type ObservedPromise,
  type RollingBackDbNeighbour,
} from './dbOwnershipProof';
import { createTestDb } from './testDb';

describe('DB ownership proof harness', () => {
  it('holds a rolling-back neighbour ahead of a queued owner, then releases the queue cleanly', async () => {
    const { db, raw } = await createTestDb();
    let neighbour: RollingBackDbNeighbour | undefined;
    let successor: ObservedPromise<string> | undefined;
    try {
      neighbour = holdRollingBackDbNeighbour(
        db,
        () => {
          raw.prepare("INSERT INTO kv (key, value) VALUES ('proof-neighbour', 'dirty')").run();
        },
        'expected proof rollback',
      );
      await neighbour.entered;

      successor = observePromise(
        withDbTransaction(db, async () => {
          raw.prepare("INSERT INTO kv (key, value) VALUES ('proof-successor', 'safe')").run();
          return 'committed';
        }),
      );
      await Promise.resolve();
      expect(successor.settled()).toBe(false);
      expect(raw.prepare("SELECT value FROM kv WHERE key = 'proof-neighbour'").get()).toEqual({
        value: 'dirty',
      });

      neighbour.release();
      await expect(neighbour.outcome).resolves.toMatchObject({
        status: 'rolled-back',
        error: { message: 'expected proof rollback' },
      });
      await expect(successor.promise).resolves.toBe('committed');
      expect(
        raw.prepare("SELECT value FROM kv WHERE key = 'proof-neighbour'").get(),
      ).toBeUndefined();
      expect(raw.prepare("SELECT value FROM kv WHERE key = 'proof-successor'").get()).toEqual({
        value: 'safe',
      });
    } finally {
      await neighbour?.cleanup();
      if (successor) await Promise.allSettled([successor.promise]);
      raw.close();
    }
  });

  it('rejects the entered gate when setup fails and idempotent cleanup leaves a usable queue', async () => {
    const { db, raw } = await createTestDb();
    const setupError = new Error('proof setup failed');
    const neighbour = holdRollingBackDbNeighbour(db, () => {
      throw setupError;
    });
    try {
      await expect(neighbour.entered).rejects.toBe(setupError);
      await expect(neighbour.outcome).resolves.toEqual({
        status: 'rolled-back',
        error: setupError,
      });
      await Promise.all([neighbour.cleanup(), neighbour.cleanup()]);

      await expect(
        withDbTransaction(db, async () => {
          raw.prepare("INSERT INTO kv (key, value) VALUES ('proof-after-failure', 'safe')").run();
          return 'usable';
        }),
      ).resolves.toBe('usable');
    } finally {
      await neighbour.cleanup();
      raw.close();
    }
  });

  it('cleanup directly releases a still-held neighbour and remains idempotent', async () => {
    const { db, raw } = await createTestDb();
    let setupFinished = false;
    const neighbour = holdRollingBackDbNeighbour(db, async () => {
      await Promise.resolve();
      setupFinished = true;
    });
    try {
      await neighbour.entered;
      expect(setupFinished).toBe(true);

      await neighbour.cleanup();
      await expect(neighbour.outcome).resolves.toMatchObject({
        status: 'rolled-back',
        error: { message: 'proof neighbour rollback' },
      });
      await expect(neighbour.cleanup()).resolves.toBeUndefined();
    } finally {
      await neighbour.cleanup();
      raw.close();
    }
  });

  it('rejects entered when BEGIN fails before the callback and leaves the queue usable', async () => {
    const { db, raw } = await createTestDb();
    let ranSetup = false;
    let neighbour: RollingBackDbNeighbour | undefined;
    try {
      raw.exec('BEGIN');
      neighbour = holdRollingBackDbNeighbour(db, () => {
        ranSetup = true;
      });
      await expect(neighbour.entered).rejects.toBeDefined();
      await expect(neighbour.outcome).resolves.toMatchObject({ status: 'rolled-back' });
      expect(ranSetup).toBe(false);
      raw.exec('ROLLBACK');

      await expect(withDbTransaction(db, async () => 'usable')).resolves.toBe('usable');
    } finally {
      if (raw.inTransaction) raw.exec('ROLLBACK');
      await neighbour?.cleanup();
      raw.close();
    }
  });

  it('observes a rejection without changing its identity or exposing an unhandled gap', async () => {
    const error = new Error('observed rejection');
    const observed = observePromise(Promise.reject(error));

    await Promise.resolve();
    expect(observed.settled()).toBe(true);
    await expect(observed.promise).rejects.toBe(error);
  });
});
