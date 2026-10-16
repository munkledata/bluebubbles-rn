import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schemaModule from '@db/schema';
import { createTestDb } from '../support/testDb';

/**
 * schema.ts is a hand-written mirror of what the migrations build; the migrations stay the source
 * of truth. This keeps the mirror honest: every app table the migrations create has a schema.ts
 * table with exactly the same columns (review M049).
 */
describe('schema.ts mirrors the migrated database', () => {
  it('declares every app table with exactly its migrated columns', async () => {
    const { raw } = await createTestDb();
    const declared = new Map(
      (Object.values(schemaModule) as unknown[])
        .filter((value): value is SQLiteTable => is(value, SQLiteTable))
        .map((table) => {
          const config = getTableConfig(table);
          return [config.name, config.columns.map((column) => column.name).sort()] as const;
        }),
    );
    const tables = raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string; sql: string | null }[];
    // Migration bookkeeping, SQLite internals and full-text-search virtual tables (with their
    // shadow tables) are not part of the typed mirror.
    const virtualTables = tables
      .filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql ?? ''))
      .map((table) => table.name);
    const appTables = tables
      .map((table) => table.name)
      .filter(
        (name) =>
          name !== '_migrations' &&
          !name.startsWith('sqlite_') &&
          !virtualTables.some((virtual) => name === virtual || name.startsWith(`${virtual}_`)),
      )
      .sort();

    expect([...declared.keys()].sort()).toEqual(appTables);
    for (const name of appTables) {
      const migrated = (raw.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[])
        .map((column) => column.name)
        .sort();
      expect({ table: name, columns: declared.get(name) }).toEqual({
        table: name,
        columns: migrated,
      });
    }
  });
});
