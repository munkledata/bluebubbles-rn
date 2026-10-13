import {
  createCustomThemeWithinTransaction,
  deleteCustomThemeWithinTransaction,
  getCustomThemeByIdWithinTransaction,
  kvGetWithinTransaction,
  kvSetWithinTransaction,
  THEME_CUSTOM_KEY,
  updateCustomThemeWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { ensureDatabase } from './databaseControl';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { assertAccountOperationCurrent, runAccountOperation } from './realtime/accountOperation';

export type ThemeCommandResult<T> =
  { readonly status: 'committed'; readonly value: T } | { readonly status: 'stale' };

export interface SaveCustomThemeInput {
  readonly id: number | null;
  readonly name: string;
  readonly mode: string;
  /** JSON serialized and validated by the theme editor before it crosses this boundary. */
  readonly tokens: string;
}

export interface SavedCustomTheme {
  readonly id: number;
  readonly created: boolean;
}

export interface SelectCustomThemeInput {
  readonly id: number;
  /** Exact JSON blob already parsed and validated by the mounted screen. */
  readonly expectedTokens: string;
}

/** Admit one short local command under the account teardown barrier. */
async function runThemeCommand<T>(
  lease: RealtimeDeliveryLease,
  command: (activeLease: RealtimeDeliveryLease) => Promise<T>,
): Promise<ThemeCommandResult<T>> {
  const result = await runAccountOperation(lease, command);
  return result.ok ? { status: 'committed', value: result.value } : { status: 'stale' };
}

/** Create or edit a custom theme. A newly created theme is activated in the same commit. */
export function saveCustomTheme(
  input: SaveCustomThemeInput,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ThemeCommandResult<SavedCustomTheme>> {
  return runThemeCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    const existingId = input.id;

    if (existingId == null) {
      const id = await withDbTransaction(
        db,
        async (context) => {
          assertAccountOperationCurrent(activeLease);
          const createdId = await createCustomThemeWithinTransaction(context, {
            name: input.name,
            mode: input.mode,
            tokens: input.tokens,
          });
          assertAccountOperationCurrent(activeLease);
          await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, String(createdId));
          assertAccountOperationCurrent(activeLease);
          return createdId;
        },
        () => activeLease.isCurrent(),
      );
      return { id, created: true };
    }

    await withDbTransaction(
      db,
      async (context) => {
        assertAccountOperationCurrent(activeLease);
        await updateCustomThemeWithinTransaction(context, existingId, {
          name: input.name,
          mode: input.mode,
          tokens: input.tokens,
        });
        assertAccountOperationCurrent(activeLease);
      },
      () => activeLease.isCurrent(),
    );
    return { id: existingId, created: false };
  });
}

/** Delete a custom theme and clear its persisted active pointer in the same commit when needed. */
export function deleteCustomTheme(
  id: number,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ThemeCommandResult<void>> {
  return runThemeCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertAccountOperationCurrent(activeLease);
        const persistedActiveId = await kvGetWithinTransaction(context, THEME_CUSTOM_KEY);
        assertAccountOperationCurrent(activeLease);
        await deleteCustomThemeWithinTransaction(context, id);
        assertAccountOperationCurrent(activeLease);
        if (persistedActiveId === String(id)) {
          await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, '');
          assertAccountOperationCurrent(activeLease);
        }
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Activate the exact custom-theme snapshot that the mounted screen parsed and validated. */
export function selectCustomTheme(
  input: SelectCustomThemeInput,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ThemeCommandResult<void>> {
  return runThemeCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertAccountOperationCurrent(activeLease);
        const currentRow = await getCustomThemeByIdWithinTransaction(context, input.id);
        assertAccountOperationCurrent(activeLease);
        if (currentRow?.tokens !== input.expectedTokens) {
          throw new Error('Theme is missing or changed.');
        }
        await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, String(input.id));
        assertAccountOperationCurrent(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Stop using a custom theme and return to the selected built-in preset. */
export function revertCustomTheme(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ThemeCommandResult<void>> {
  return runThemeCommand(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertAccountOperationCurrent(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertAccountOperationCurrent(activeLease);
        await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, '');
        assertAccountOperationCurrent(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}
