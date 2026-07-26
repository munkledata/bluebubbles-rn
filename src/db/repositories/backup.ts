import { eq, sql } from 'drizzle-orm';
import { chats } from '../schema';
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

/**
 * Every kv pair, unfiltered. `kv` also holds per-chat composer drafts and device-local sync
 * bookkeeping, so the CALLER decides what may leave the device — `buildBackup` gates this through
 * the `isBackupKey` allow-list (`src/services/backup/backupSchema.ts`). Nothing here may import
 * that policy: `src/db` must not reach into `src/services`.
 */
export async function getAllKv(db: AppDatabase): Promise<KvPair[]> {
  return db.all<KvPair>(sql`SELECT key, value FROM kv ORDER BY key`);
}

/**
 * User-created themes only (built-in presets are code, not rows).
 *
 * `ORDER BY id` matters beyond tidiness: a backup carries no ids, so `restoreThemes` pairs entries
 * with rows positionally within each (name, mode) group. Exporting in id order — the same order
 * the restore snapshot uses — is what keeps two same-named themes from swapping palettes on a
 * restore back onto the device they came from.
 */
export async function getAllThemes(db: AppDatabase): Promise<ThemeRow[]> {
  return db.all<ThemeRow>(
    sql`SELECT name, mode, tokens, is_preset AS isPreset FROM themes WHERE is_preset = 0 ORDER BY id`,
  );
}

/**
 * Chats that carry any local customization worth backing up.
 *
 * `marked_unread_at` and `deleted_at` are deliberately NOT among the columns, in either direction.
 * They are per-device STATE, not settings: a stale `deleted_at` carried in from a backup would
 * hide a conversation this device is actively using (the tombstone also floors the unread count),
 * and a backup taken before a deletion would, if it wrote the column back as NULL, RESURRECT every
 * conversation the user had deleted since. Same reasoning that keeps both columns out of
 * `upsertChats`' conflict set — a foreign source of truth must not get a vote on them.
 */
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

/** Pairing key for a backed-up theme. JSON, so no name/mode text can ever forge a separator. */
function themeIdentity(name: string, mode: string): string {
  return JSON.stringify([name, mode]);
}

/**
 * Restore custom themes, PAIRING each backed-up theme with an existing row of the same
 * (name, mode) — one row per backup entry — and inserting the ones left unpaired.
 *
 * `onConflictDoUpdate` is not usable here: `themes` has NO unique index (`id INTEGER PRIMARY KEY
 * AUTOINCREMENT` is its only key) and no id travels in a backup, so a conflict clause has nothing
 * to arbitrate on — naming a non-indexed target throws "ON CONFLICT clause does not match any
 * PRIMARY KEY or UNIQUE constraint". A plain insert is no good either: restoring the same backup
 * twice — an utterly normal recovery action — then left two indistinguishable copies of every
 * custom theme that no later restore could dedupe.
 *
 * (name, mode) is NOT a key either, and that is why the pairing is done in JS against a snapshot
 * instead of in the WHERE clause. The theme editor seeds every new theme's name to 'My Theme', so
 * a user who builds two palettes without renaming them has two rows with identical (name, mode) —
 * the normal case, not an exotic one. A `WHERE name = ? AND mode = ?` UPDATE matches BOTH of them:
 * entry 1 wrote its tokens over both twins and entry 2 overwrote them again, so the palette the
 * user hand-built was destroyed by the very restore meant to recover it. On a fresh device (the
 * primary use of a backup) it was worse: entry 1 inserted, entry 2's UPDATE matched that
 * brand-new row and rewrote it, and only ONE of the two themes survived at all.
 *
 * The id queue fixes both. The snapshot is read ONCE, before the loop, and each entry consumes at
 * most one id from its bucket, so the k-th twin in the backup lands on the k-th twin in the table
 * and rows inserted BY THIS RESTORE are invisible to later entries — which is precisely what stops
 * entry 2 from swallowing entry 1's insert.
 *
 * The insert deliberately carries NO `WHERE NOT EXISTS (name, mode)` guard: it would re-introduce
 * the fresh-device loss (entry 2 would find entry 1's just-inserted twin and skip). What that
 * gives up is only the case of a theme created by the editor DURING a restore, which needs the
 * Themes screen open mid-import and costs a duplicate row, not a lost palette.
 *
 * Update-then-insert, never delete-then-insert — every write commits on its own and wakes the
 * reactive readers, so a theme the user is currently rendering never blinks out of existence on
 * its way to being rewritten.
 */
export async function restoreThemes(db: AppDatabase, items: ThemeRow[]): Promise<void> {
  const existing = await db.all<{ id: number; name: string; mode: string }>(
    sql`SELECT id, name, mode FROM themes WHERE is_preset = 0 ORDER BY id`,
  );
  // (name, mode) → the ids of the rows carrying it, oldest first, each claimable once.
  const unpaired = new Map<string, number[]>();
  for (const row of existing) {
    const key = themeIdentity(row.name, row.mode);
    const ids = unpaired.get(key);
    if (ids) ids.push(row.id);
    else unpaired.set(key, [row.id]);
  }

  for (const t of items) {
    const id = unpaired.get(themeIdentity(t.name, t.mode))?.shift();
    if (id != null) {
      // By id, so exactly one row is touched however many twins share the name. `is_preset = 0`
      // is redundant against the snapshot but kept: a built-in preset must never be rewritten.
      await db.run(sql`UPDATE themes SET tokens = ${t.tokens} WHERE id = ${id} AND is_preset = 0`);
    } else {
      await db.run(sql`
        INSERT INTO themes (name, mode, tokens, is_preset)
        VALUES (${t.name}, ${t.mode}, ${t.tokens}, 0)
      `);
    }
  }
}

/**
 * Apply backed-up customizations to chats that exist locally (UPDATE only).
 *
 * The `set` list is exactly the columns `getChatCustomizations` reads — no `deleted_at`, no
 * `marked_unread_at`, so a restore can neither resurrect a locally-deleted conversation nor hide a
 * live one behind a tombstone copied from another device.
 */
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
