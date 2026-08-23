import { sql } from 'drizzle-orm';
import {
  createCustomTheme,
  deleteCustomTheme,
  getCustomThemeById,
  listCustomThemes,
  updateCustomTheme,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const tokens = (tint: string) => JSON.stringify({ mode: 'dark', color: { tint } });

async function holdRollingBackTransaction(db: AppDatabase): Promise<{
  release: () => void;
  failure: Promise<unknown>;
}> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const neighbour = withDbTransaction(db, async () => {
    markStarted();
    await held;
    throw new Error('neighbour rollback');
  });
  const failure = neighbour.then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

async function finishAfterQueuedObservation<T>(
  neighbour: { release: () => void; failure: Promise<unknown> },
  pending: Promise<T>[],
  observe: () => void | Promise<void>,
): Promise<T[]> {
  let observationError: unknown;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await observe();
  } catch (error) {
    observationError = error;
  } finally {
    neighbour.release();
  }
  const neighbourError = await neighbour.failure;
  const results = await Promise.all(pending);
  if (observationError) throw observationError;
  expect(String(neighbourError)).toContain('neighbour rollback');
  return results;
}

describe('custom themes repository', () => {
  it('creates a theme and reads it back by id', async () => {
    const t = await createTestDb();
    const id = await createCustomTheme(t.db, {
      name: 'Mine',
      mode: 'dark',
      tokens: tokens('#f00'),
    });
    expect(await getCustomThemeById(t.db, id)).toEqual({
      id,
      name: 'Mine',
      mode: 'dark',
      tokens: tokens('#f00'),
    });
  });

  it('queues a public create behind a rolling-back neighbour', async () => {
    const t = await createTestDb();
    const neighbour = await holdRollingBackTransaction(t.db);
    const create = createCustomTheme(t.db, {
      name: 'Queued',
      mode: 'dark',
      tokens: tokens('#123'),
    });

    const [id] = await finishAfterQueuedObservation(neighbour, [create], async () => {
      expect(await listCustomThemes(t.db)).toEqual([]);
    });

    if (id == null) throw new Error('queued create returned no theme id');
    expect(await getCustomThemeById(t.db, id)).toMatchObject({ name: 'Queued' });
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

  it('queues public update and delete behind a rolling-back neighbour', async () => {
    const t = await createTestDb();
    const updateId = await createCustomTheme(t.db, {
      name: 'Before',
      mode: 'dark',
      tokens: tokens('#111'),
    });
    const deleteId = await createCustomTheme(t.db, {
      name: 'Delete me',
      mode: 'dark',
      tokens: tokens('#222'),
    });
    const neighbour = await holdRollingBackTransaction(t.db);
    const update = updateCustomTheme(t.db, updateId, {
      name: 'After',
      mode: 'dark',
      tokens: tokens('#333'),
    });
    const deletion = deleteCustomTheme(t.db, deleteId);

    await finishAfterQueuedObservation(neighbour, [update, deletion], async () => {
      expect(await getCustomThemeById(t.db, updateId)).toMatchObject({ name: 'Before' });
      expect(await getCustomThemeById(t.db, deleteId)).toMatchObject({ name: 'Delete me' });
    });

    expect(await getCustomThemeById(t.db, updateId)).toMatchObject({ name: 'After' });
    expect(await getCustomThemeById(t.db, deleteId)).toBeNull();
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
