import { sql } from 'drizzle-orm';
import {
  createCustomTheme,
  deleteCustomTheme,
  getCustomThemeById,
  listCustomThemes,
  updateCustomTheme,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

const tokens = (tint: string) => JSON.stringify({ mode: 'dark', color: { tint } });

describe('custom themes repository', () => {
  it('creates a theme and reads it back by id', async () => {
    const t = await createTestDb();
    const id = await createCustomTheme(t.db, { name: 'Mine', mode: 'dark', tokens: tokens('#f00') });
    expect(await getCustomThemeById(t.db, id)).toEqual({
      id,
      name: 'Mine',
      mode: 'dark',
      tokens: tokens('#f00'),
    });
  });

  it('lists only custom themes, in id order, excluding presets', async () => {
    const t = await createTestDb();
    // A preset row (as a future code-seeded preset would be stored) must stay invisible.
    await t.db.run(
      sql`INSERT INTO themes (name, mode, tokens, is_preset) VALUES ('Preset', 'light', '{}', 1)`,
    );
    const a = await createCustomTheme(t.db, { name: 'A', mode: 'dark', tokens: '{}' });
    const b = await createCustomTheme(t.db, { name: 'B', mode: 'light', tokens: '{}' });
    expect((await listCustomThemes(t.db)).map((r) => r.id)).toEqual([a, b]);
  });

  it('getCustomThemeById returns null for a missing id and for a preset row', async () => {
    const t = await createTestDb();
    await t.db.run(
      sql`INSERT INTO themes (id, name, mode, tokens, is_preset) VALUES (99, 'Preset', 'light', '{}', 1)`,
    );
    expect(await getCustomThemeById(t.db, 1234)).toBeNull();
    expect(await getCustomThemeById(t.db, 99)).toBeNull();
  });

  it('updates a custom theme in place', async () => {
    const t = await createTestDb();
    const id = await createCustomTheme(t.db, { name: 'Old', mode: 'dark', tokens: tokens('#f00') });
    await updateCustomTheme(t.db, id, { name: 'New', mode: 'light', tokens: tokens('#0f0') });
    expect(await getCustomThemeById(t.db, id)).toEqual({
      id,
      name: 'New',
      mode: 'light',
      tokens: tokens('#0f0'),
    });
  });

  it('update/delete never touch a preset row (is_preset guard)', async () => {
    const t = await createTestDb();
    await t.db.run(
      sql`INSERT INTO themes (id, name, mode, tokens, is_preset) VALUES (7, 'Preset', 'light', '{}', 1)`,
    );
    await updateCustomTheme(t.db, 7, { name: 'Hacked', mode: 'dark', tokens: '{}' });
    await deleteCustomTheme(t.db, 7);
    const rows = await t.db.all<{ name: string }>(sql`SELECT name FROM themes WHERE id = 7`);
    expect(rows).toEqual([{ name: 'Preset' }]);
  });

  it('deletes a custom theme', async () => {
    const t = await createTestDb();
    const id = await createCustomTheme(t.db, { name: 'Gone', mode: 'dark', tokens: '{}' });
    await deleteCustomTheme(t.db, id);
    expect(await getCustomThemeById(t.db, id)).toBeNull();
    expect(await listCustomThemes(t.db)).toEqual([]);
  });
});
