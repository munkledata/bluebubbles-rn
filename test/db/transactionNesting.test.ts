import { DbTransactionNestedError, withDbTransaction, withDbWriteLock } from '@db/transaction';
import { createTestDb } from '../support/testDb';

describe('nested transaction detection (node project setup)', () => {
  it('rejects a withDbTransaction opened inside another owner callback within 3 s', async () => {
    const { db } = await createTestDb();
    const start = Date.now();
    await expect(
      withDbTransaction(db, async () => withDbTransaction(db, async () => 1)),
    ).rejects.toBeInstanceOf(DbTransactionNestedError);
    expect(Date.now() - start).toBeLessThan(3_000);
    // The queue is not wedged: a later transaction still runs.
    await expect(withDbTransaction(db, async () => 'after')).resolves.toBe('after');
  });

  it('rejects a nested claim made through a helper several awaits deep', async () => {
    const { db } = await createTestDb();
    const deepHelper = async (): Promise<number> => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return withDbWriteLock(async () => 2);
    };
    await expect(withDbTransaction(db, async () => deepHelper())).rejects.toBeInstanceOf(
      DbTransactionNestedError,
    );
    await expect(withDbWriteLock(db, async () => deepHelper())).rejects.toBeInstanceOf(
      DbTransactionNestedError,
    );
  });

  it('lets two concurrent top-level transactions queue and both succeed', async () => {
    const { db } = await createTestDb();
    const order: string[] = [];
    const first = withDbTransaction(db, async () => {
      order.push('first-start');
      await new Promise((resolve) => setImmediate(resolve));
      order.push('first-end');
      return 1;
    });
    const second = withDbTransaction(db, async () => {
      order.push('second');
      return 2;
    });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
