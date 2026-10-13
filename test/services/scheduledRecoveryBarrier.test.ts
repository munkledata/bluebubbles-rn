import type { HttpClient } from '@core/api/http';
import { getScheduledById } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  ensureScheduledRecovery,
  runDueScheduled,
  ScheduledRecoveryIncompleteError,
} from '@/services/send/scheduleService';
import { createTestDb } from '../support/testDb';
import { claimScheduled, insertScheduled } from '../support/repositoryWrappers';

const noHttp = {} as HttpClient;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('scheduled crash-recovery barrier', () => {
  it('never lets a later same-generation ticker reset a live claim', async () => {
    const { db } = await createTestDb();
    const firstId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'only once',
      scheduledFor: 1,
    });
    const scope = { generation: 7, isCurrent: () => true };
    const senderEntered = deferred<void>();
    const releaseSender = deferred<void>();
    let sends = 0;
    const sender = async (): Promise<void> => {
      sends += 1;
      if (sends === 1) {
        senderEntered.resolve(undefined);
        await releaseSender.promise;
      }
    };

    const firstRun = runDueScheduled(db, noHttp, 1_000, sender, scope);
    await senderEntered.promise;
    expect((await getScheduledById(db, firstId))?.status).toBe('sending');

    // Recovery already succeeded for generation 7. A second ticker must reuse that completed
    // barrier, queue behind the live owner, and leave its `sending` claim alone.
    const sameGenerationScope = { generation: 7, isCurrent: () => true };
    let secondSettled = false;
    const secondRun = runDueScheduled(db, noHttp, 1_000, sender, sameGenerationScope).finally(
      () => {
        secondSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sends).toBe(1);
    expect(secondSettled).toBe(false);
    expect((await getScheduledById(db, firstId))?.status).toBe('sending');

    releaseSender.resolve(undefined);
    await expect(firstRun).resolves.toBe(1);
    await expect(secondRun).resolves.toBe(0);

    // A row claimed later in this same runtime is not a crash remnant either.
    const liveId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'live claim',
      scheduledFor: 2,
    });
    await claimScheduled(db, liveId);
    await expect(runDueScheduled(db, noHttp, 1_000, sender, scope)).resolves.toBe(0);
    expect((await getScheduledById(db, liveId))?.status).toBe('sending');

    // A genuinely new account/process generation gets a fresh recovery and may reset crash-left
    // claims before making its first claim.
    const nextScope = { generation: 8, isCurrent: () => true };
    await expect(runDueScheduled(db, noHttp, 1_000, sender, nextScope)).resolves.toBe(1);
    expect((await getScheduledById(db, liveId))?.status).toBe('sent');
  });

  it('publishes one same-generation recovery promise before its first await', async () => {
    const { db } = await createTestDb();
    const firstScope = { generation: 30, isCurrent: () => true };
    const secondScope = { generation: 30, isCurrent: () => true };

    const first = ensureScheduledRecovery(db, firstScope);
    const second = ensureScheduledRecovery(db, secondScope);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(0);
  });

  it.each([
    ['a long-lived foreground owner established the cache', true],
    ['the expiring callback established the cache', false],
  ] as const)(
    'waits for an expired runner to settle, then recovers when %s',
    async (_description, primeWithForeground) => {
      const { db } = await createTestDb();
      const foregroundScope = { generation: 31, isCurrent: () => true };
      if (primeWithForeground) {
        await expect(ensureScheduledRecovery(db, foregroundScope)).resolves.toBe(0);
      }

      const interruptedId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'recover after callback timeout',
        scheduledFor: 1,
      });
      let callbackCurrent = true;
      const callbackScope = { generation: 31, isCurrent: () => callbackCurrent };
      const callbackSenderEntered = deferred<void>();
      const releaseCallbackSender = deferred<void>();
      const expiredRun = runDueScheduled(
        db,
        noHttp,
        1_000,
        async () => {
          callbackSenderEntered.resolve(undefined);
          await releaseCallbackSender.promise;
        },
        callbackScope,
      );
      await callbackSenderEntered.promise;
      expect((await getScheduledById(db, interruptedId))?.status).toBe('sending');

      callbackCurrent = false;
      let replacementSends = 0;
      let replacementSettled = false;
      const replacement = runDueScheduled(
        db,
        noHttp,
        1_000,
        async () => {
          replacementSends += 1;
        },
        foregroundScope,
      ).finally(() => {
        replacementSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(replacementSends).toBe(0);
      expect(replacementSettled).toBe(false);
      expect((await getScheduledById(db, interruptedId))?.status).toBe('sending');

      releaseCallbackSender.resolve(undefined);
      await expect(expiredRun).rejects.toThrow('account session changed');
      await expect(replacement).resolves.toBe(1);
      expect(replacementSends).toBe(1);
      expect((await getScheduledById(db, interruptedId))?.status).toBe('sent');
    },
  );

  it('fails closed after a full fourth bounded batch, then finishes recovery before sending', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare(
      `INSERT INTO scheduled_messages
        (chat_guid, payload, scheduled_for, status, attempts)
       VALUES (?, ?, ?, 'sending', 0)`,
    );
    raw.transaction(() => {
      for (let i = 1; i <= 41; i += 1) {
        insert.run('c1', JSON.stringify({ text: `crash-${i}` }), i);
      }
    })();
    const finalCrashId = (
      raw.prepare('SELECT MAX(id) AS id FROM scheduled_messages').get() as { id: number }
    ).id;
    const scope = { generation: 11, isCurrent: () => true };
    let sends = 0;

    const incomplete = await runDueScheduled(
      db,
      noHttp,
      1_000,
      async () => {
        sends += 1;
      },
      scope,
      10,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(incomplete).toBeInstanceOf(ScheduledRecoveryIncompleteError);
    expect(incomplete).toMatchObject({
      name: 'ScheduledRecoveryIncompleteError',
      recoveredRows: 40,
    });
    expect(sends).toBe(0);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE status = 'sending'").get(),
    ).toEqual({ n: 1 });

    // The rejected barrier was removed. This retry resets the final row, confirms a partial/empty
    // batch, and only then permits the bounded due-list to reach the sender.
    await expect(
      runDueScheduled(
        db,
        noHttp,
        1_000,
        async () => {
          const finalCrash = raw
            .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
            .get(finalCrashId) as { status: string };
          expect(finalCrash.status).toBe('pending');
          sends += 1;
        },
        scope,
        10,
      ),
    ).resolves.toBe(10);
    expect(sends).toBe(10);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE status = 'sending'").get(),
    ).toEqual({ n: 0 });
  });

  it('removes a failed recovery promise so the same generation can retry', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'retry recovery',
      scheduledFor: 1,
    });
    await claimScheduled(db, id);
    const flaky: AppDatabase = Object.create(db);
    let failReset = true;
    flaky.all = ((...args: Parameters<AppDatabase['all']>) => {
      if (failReset) {
        failReset = false;
        throw new Error('reset unavailable once');
      }
      return db.all(...args);
    }) as AppDatabase['all'];
    const scope = { generation: 20, isCurrent: () => true };
    let sends = 0;

    await expect(
      runDueScheduled(
        flaky,
        noHttp,
        1_000,
        async () => {
          sends += 1;
        },
        scope,
      ),
    ).rejects.toThrow('reset unavailable once');
    expect(sends).toBe(0);
    expect((await getScheduledById(db, id))?.status).toBe('sending');

    await expect(
      runDueScheduled(
        flaky,
        noHttp,
        1_000,
        async () => {
          sends += 1;
        },
        scope,
      ),
    ).resolves.toBe(1);
    expect(sends).toBe(1);
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });
});
