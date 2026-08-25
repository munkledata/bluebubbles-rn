import { kvSet, kvSetWithinTransaction } from '@db/repositories/kv';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';

/**
 * Compile-only contract for the DB-02B1 capability boundary.
 *
 * This file is included by the repository typecheck but is not a Jest suite or an app entry point.
 * The expected errors are the safety assertions: removing the opaque context brand or exposing a
 * raw database from the owner callback makes an assertion fail the build.
 */
export async function verifyDbTransactionApiContract(db: AppDatabase): Promise<void> {
  await withDbTransaction(db, async (context) => {
    const brandedContext: DbTransactionContext = context;

    await kvSetWithinTransaction(brandedContext, 'inside-owner', 'allowed');
    await runInTransactionContext(brandedContext, async () => undefined);

    // @ts-expect-error A transaction token is not a raw DB and cannot call a self-transacting helper.
    await kvSet(brandedContext, 'nested-owner', 'rejected');

    // @ts-expect-error A transaction token cannot be used to open a nested transaction.
    await withDbTransaction(brandedContext, async () => undefined);
  });

  // @ts-expect-error A raw DB is not proof that its caller owns the active transaction.
  await kvSetWithinTransaction(db, 'raw-db', 'rejected');

  // @ts-expect-error An arbitrary object cannot forge the opaque transaction token.
  await kvSetWithinTransaction({}, 'forged-context', 'rejected');
}
