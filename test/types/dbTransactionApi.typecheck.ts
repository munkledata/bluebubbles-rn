import { requireChatIdByGuidWithinTransaction } from '@db/repositories/chats';
import { kvSetWithinTransaction } from '@db/repositories/kv';
import {
  runInTransactionContext,
  withDbTransaction,
  withDbWriteLock,
  type DbTransactionContext,
} from '@db/transaction';
import type { Queryable, ReadDb, WriteDb } from '@db/types';
import { kvSet } from '../support/repositoryWrappers';

/**
 * Compile-only contract for the database ownership boundary.
 *
 * This file is included by the repository typecheck but is not a Jest suite or an app entry point.
 * The expected errors are the safety assertions: removing the opaque context brand, the ReadDb
 * brand, or exposing a raw write handle outside the owner callback makes an assertion fail the
 * build.
 */
export async function verifyDbTransactionApiContract(db: ReadDb): Promise<void> {
  // Reads work on every view.
  const reader: Queryable = db;
  void reader.select;

  // @ts-expect-error A ReadDb cannot write: every write lives inside an owner callback.
  void db.insert;
  // @ts-expect-error A ReadDb cannot run raw statements either.
  void db.run;

  await withDbTransaction(db, async (db, context) => {
    const tx: WriteDb = db;
    void tx.insert;
    const brandedContext: DbTransactionContext = context;

    await kvSetWithinTransaction(brandedContext, 'inside-owner', 'allowed');
    await runInTransactionContext(brandedContext, async () => undefined);
    await requireChatIdByGuidWithinTransaction(brandedContext, 'inside-owner');

    // @ts-expect-error The write handle has no "outside a transaction" brand, so it cannot call a
    // helper that opens its own transaction: that nested call would wait on this transaction's lock.
    await kvSet(db, 'nested-owner', 'rejected');

    // @ts-expect-error Nor can it open a nested transaction directly.
    await withDbTransaction(db, async () => undefined);

    // @ts-expect-error Nor take the write lock again.
    await withDbWriteLock(db, async () => undefined);

    // @ts-expect-error A transaction token is not a raw DB and cannot call a self-transacting helper.
    await kvSet(brandedContext, 'nested-owner', 'rejected');

    // @ts-expect-error A transaction token cannot be used to open a nested transaction.
    await withDbTransaction(brandedContext, async (brandedContext) => undefined);
  });

  await withDbWriteLock(db, async (tx) => {
    void tx.run;
    // @ts-expect-error The lock's write view cannot open a transaction either.
    await withDbTransaction(tx, async () => undefined);
  });

  // @ts-expect-error A raw DB is not proof that its caller owns the active transaction.
  await kvSetWithinTransaction(db, 'raw-db', 'rejected');

  // @ts-expect-error A raw DB cannot invoke the transaction-only chat identity resolver.
  await requireChatIdByGuidWithinTransaction(db, 'raw-db');

  // @ts-expect-error An arbitrary object cannot forge the opaque transaction token.
  await kvSetWithinTransaction({}, 'forged-context', 'rejected');
}
