import { eq, sql } from 'drizzle-orm';
import { handles } from '@db/schema';

const open = jest.fn();
const runMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open }));
jest.mock('@db/migrate', () => ({ runMigrations }));

function rawHandle() {
  return {
    close: jest.fn(),
    execute: jest.fn(async () => ({
      rows: [] as Array<Record<string, unknown>>,
      rowsAffected: 1,
      insertId: 12,
    })),
    executeRaw: jest.fn(async () => ({
      rawRows: [[9]] as unknown[][],
      columnNames: ['id'],
      rowsAffected: 1,
    })),
    executeSync: jest.fn(() => ({
      rows: [{ id: 7 }] as Array<Record<string, unknown>>,
      rowsAffected: 1,
      columnNames: ['id'],
    })),
    flushPendingReactiveQueries: jest.fn(async () => undefined),
  };
}

describe('Drizzle/op-sqlite adapter contract', () => {
  it('routes all three installed Drizzle write shapes and requests a reactive flush', async () => {
    const raw = rawHandle();
    open.mockReturnValueOnce(raw);
    runMigrations.mockResolvedValueOnce([]);

    const { initDatabase } = await import('@db/database');
    const db = await initDatabase('contract-key');
    raw.execute.mockClear();

    await expect(
      db.all(sql`UPDATE handles SET display_name = ${'sync'} RETURNING id`),
    ).resolves.toEqual([{ id: 7 }]);
    expect(raw.executeSync).toHaveBeenCalledTimes(1);
    expect(raw.executeSync.mock.invocationCallOrder[0]).toBeLessThan(
      raw.flushPendingReactiveQueries.mock.invocationCallOrder[0]!,
    );

    await expect(
      db.run(sql`UPDATE handles SET display_name = ${'async'} WHERE id = ${7}`),
    ).resolves.toEqual(
      expect.objectContaining({ rowsAffected: 1, insertId: 12, rows: { _array: [] } }),
    );
    expect(raw.execute).toHaveBeenCalledTimes(1);

    await expect(
      db
        .update(handles)
        .set({ displayName: 'builder' })
        .where(eq(handles.id, 9))
        .returning({ id: handles.id }),
    ).resolves.toEqual([{ id: 9 }]);
    expect(raw.executeRaw).toHaveBeenCalledTimes(1);
    expect(raw.flushPendingReactiveQueries).toHaveBeenCalledTimes(3);

    raw.flushPendingReactiveQueries.mockClear();
    await db.run(sql`BEGIN IMMEDIATE`);
    await db.run(sql`UPDATE handles SET display_name = ${'committed'} WHERE id = ${7}`);
    expect(raw.flushPendingReactiveQueries).not.toHaveBeenCalled();
    await db.run(sql`COMMIT`);
    expect(raw.flushPendingReactiveQueries).toHaveBeenCalledTimes(1);

    raw.flushPendingReactiveQueries.mockClear();
    await db.run(sql`BEGIN IMMEDIATE`);
    await db.run(sql`UPDATE handles SET display_name = ${'rolled-back'} WHERE id = ${7}`);
    expect(raw.flushPendingReactiveQueries).not.toHaveBeenCalled();
    await db.run(sql`ROLLBACK`);
    expect(raw.flushPendingReactiveQueries).toHaveBeenCalledTimes(1);

    raw.flushPendingReactiveQueries.mockClear();
    await db.run(sql`BEGIN IMMEDIATE`);
    raw.execute.mockRejectedValueOnce(new Error('simulated native rollback failure'));
    await expect(db.run(sql`ROLLBACK`)).rejects.toThrow('Failed query: ROLLBACK');
    expect(raw.flushPendingReactiveQueries).not.toHaveBeenCalled();
    await db.run(sql`UPDATE handles SET display_name = ${'after-failed-rollback'} WHERE id = ${7}`);
    expect(raw.flushPendingReactiveQueries).toHaveBeenCalledTimes(1);
  });
});
