import { and, eq, sql } from 'drizzle-orm';
import { themes } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

// ---- Custom-theme editor (F-12): CRUD over user themes, keyed by id ----

export interface CustomThemeRow {
  id: number;
  name: string;
  mode: string;
  /** JSON `ThemeTokens` blob. */
  tokens: string;
}

/** Custom themes with ids, for the theme manager/editor (presets are code, excluded). */
export async function listCustomThemes(db: AppDatabase): Promise<CustomThemeRow[]> {
  return db.all<CustomThemeRow>(
    sql`SELECT id, name, mode, tokens FROM themes WHERE is_preset = 0 ORDER BY id`,
  );
}

export async function getCustomThemeById(
  db: AppDatabase,
  id: number,
): Promise<CustomThemeRow | null> {
  const rows = await db.all<CustomThemeRow>(
    sql`SELECT id, name, mode, tokens FROM themes WHERE id = ${id} AND is_preset = 0 LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Re-read one custom theme while the caller's existing transaction owns the database. */
export async function getCustomThemeByIdWithinTransaction(
  context: DbTransactionContext,
  id: number,
): Promise<CustomThemeRow | null> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<CustomThemeRow>(
      sql`SELECT id, name, mode, tokens FROM themes WHERE id = ${id} AND is_preset = 0 LIMIT 1`,
    );
    return rows[0] ?? null;
  });
}

/** Transaction-only half used when the theme row must commit with another domain write. */
export async function createCustomThemeWithinTransaction(
  context: DbTransactionContext,
  theme: { name: string; mode: string; tokens: string },
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .insert(themes)
      .values({ name: theme.name, mode: theme.mode, tokens: theme.tokens, isPreset: false })
      .returning({ id: themes.id });
    return rows[0]!.id;
  });
}

/** Public standalone create. Never wrap this helper in another transaction. */
export async function createCustomTheme(
  db: AppDatabase,
  theme: { name: string; mode: string; tokens: string },
): Promise<number> {
  return withDbTransaction(db, (context) => createCustomThemeWithinTransaction(context, theme));
}

/** Transaction-only half used by the guarded theme editor. */
export async function updateCustomThemeWithinTransaction(
  context: DbTransactionContext,
  id: number,
  patch: { name: string; mode: string; tokens: string },
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    await db
      .update(themes)
      .set({ name: patch.name, mode: patch.mode, tokens: patch.tokens })
      .where(and(eq(themes.id, id), eq(themes.isPreset, false)));
  });
}

/** Public standalone update. Never wrap this helper in another transaction. */
export async function updateCustomTheme(
  db: AppDatabase,
  id: number,
  patch: { name: string; mode: string; tokens: string },
): Promise<void> {
  await withDbTransaction(db, (context) => updateCustomThemeWithinTransaction(context, id, patch));
}

/** Transaction-only half used when deleting a row and its active-theme pointer together. */
export async function deleteCustomThemeWithinTransaction(
  context: DbTransactionContext,
  id: number,
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    await db.delete(themes).where(and(eq(themes.id, id), eq(themes.isPreset, false)));
  });
}

/** Public standalone delete. Never wrap this helper in another transaction. */
export async function deleteCustomTheme(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, (context) => deleteCustomThemeWithinTransaction(context, id));
}
