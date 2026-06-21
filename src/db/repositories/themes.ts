import { and, eq, sql } from 'drizzle-orm';
import { themes } from '../schema';
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

export async function createCustomTheme(
  db: AppDatabase,
  theme: { name: string; mode: string; tokens: string },
): Promise<number> {
  const rows = await db
    .insert(themes)
    .values({ name: theme.name, mode: theme.mode, tokens: theme.tokens, isPreset: false })
    .returning({ id: themes.id });
  return rows[0]!.id;
}

export async function updateCustomTheme(
  db: AppDatabase,
  id: number,
  patch: { name: string; mode: string; tokens: string },
): Promise<void> {
  await db
    .update(themes)
    .set({ name: patch.name, mode: patch.mode, tokens: patch.tokens })
    .where(and(eq(themes.id, id), eq(themes.isPreset, false)));
}

export async function deleteCustomTheme(db: AppDatabase, id: number): Promise<void> {
  await db.delete(themes).where(and(eq(themes.id, id), eq(themes.isPreset, false)));
}
