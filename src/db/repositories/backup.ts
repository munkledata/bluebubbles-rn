import { eq, sql } from 'drizzle-orm';
import { chats, themes } from '../schema';
import type { AppDatabase } from '../types';
import { kvSet, THEME_CUSTOM_KEY } from './kv';

// ---- Backup / restore reads + writes (settings, themes, chat customizations) ----

export interface KvPair {
  key: string;
  value: string | null;
}
export interface ThemeRow {
  name: string;
  mode: string;
  tokens: string;
  isPreset: number;
}
export interface ChatCustomizationRow {
  guid: string;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  isPinned: number;
  isArchived: number;
}

export async function getAllKv(db: AppDatabase): Promise<KvPair[]> {
  return db.all<KvPair>(sql`SELECT key, value FROM kv ORDER BY key`);
}

/** User-created themes only (built-in presets are code, not rows). */
export async function getAllThemes(db: AppDatabase): Promise<ThemeRow[]> {
  return db.all<ThemeRow>(
    sql`SELECT name, mode, tokens, is_preset AS isPreset FROM themes WHERE is_preset = 0`,
  );
}

/** Chats that carry any local customization worth backing up. */
export async function getChatCustomizations(db: AppDatabase): Promise<ChatCustomizationRow[]> {
  return db.all<ChatCustomizationRow>(sql`
    SELECT guid, custom_name AS customName, custom_color AS customColor,
           mute_type AS muteType, is_pinned AS isPinned, is_archived AS isArchived
      FROM chats
     WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
        OR is_pinned = 1 OR is_archived = 1
  `);
}

export async function restoreKv(db: AppDatabase, items: KvPair[]): Promise<void> {
  for (const it of items) {
    // The active custom-theme id is device-specific — restored themes get fresh ids, so a
    // backed-up pointer would dangle. Skip it; restoreThemes still brings the themes over.
    if (it.key === THEME_CUSTOM_KEY) continue;
    if (it.value != null) await kvSet(db, it.key, it.value);
  }
}

export async function restoreThemes(db: AppDatabase, items: ThemeRow[]): Promise<void> {
  for (const t of items) {
    await db
      .insert(themes)
      .values({ name: t.name, mode: t.mode, tokens: t.tokens, isPreset: false })
      .onConflictDoNothing();
  }
}

/** Apply backed-up customizations to chats that exist locally (UPDATE only). */
export async function restoreChatCustomizations(
  db: AppDatabase,
  items: ChatCustomizationRow[],
): Promise<number> {
  let applied = 0;
  for (const c of items) {
    const rows = await db
      .update(chats)
      .set({
        customName: c.customName,
        customColor: c.customColor,
        muteType: c.muteType,
        isPinned: c.isPinned === 1,
        isArchived: c.isArchived === 1,
      })
      .where(eq(chats.guid, c.guid))
      .returning({ id: chats.id });
    applied += rows.length;
  }
  return applied;
}
