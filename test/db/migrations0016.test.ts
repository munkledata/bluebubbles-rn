/**
 * Upgrade-path test for `0016_handle_service_identity`.
 *
 * The db is migrated only up to 0015, a handle is seeded at that OLD schema (service NULL — the
 * shape written before the composite key existed), and only then are the remaining migrations run
 * through the real `runMigrations`. So the assertions bind the NULL→'' normalization and the
 * index swap to migration 0016 itself, not to "the final schema happens to look like this".
 *
 * NOTE ON WHAT IS *NOT* TESTED: the pre-0016 schema already carries a UNIQUE index on `address`
 * ALONE (`handles_address_idx`, 0001_init), so two rows sharing an address cannot exist before the
 * migration — a "duplicate collides when the new index is built" test is not constructible. The
 * first test below proves that precondition instead of asserting an impossible collision.
 */
import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

function makeRunner(raw: Database.Database): SqlRunner {
  return {
    async exec(sql, params) {
      raw.prepare(sql).run(...((params as unknown[]) ?? []));
    },
    async query(sql, params) {
      return raw.prepare(sql).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

// Track every handle so it can be closed — an unclosed better-sqlite3 db keeps the worker alive.
const opened: Database.Database[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});

/** Applies migrations up to AND INCLUDING `name`, recording them so `runMigrations` skips them. */
function migrateUpTo(name: string): Database.Database {
  const idx = MIGRATIONS.findIndex((m) => m.name === name);
  if (idx < 0) throw new Error(`migration ${name} not found`);
  const raw = new Database(':memory:');
  opened.push(raw);
  raw.pragma('foreign_keys = ON');
  raw
    .prepare(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)`)
    .run();
  for (const m of MIGRATIONS.slice(0, idx + 1)) {
    for (const stmt of m.statements) raw.prepare(stmt).run();
    raw.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(m.name, Date.now());
  }
  return raw;
}

const ADDR = '+15550001111';

function indexNames(raw: Database.Database): string[] {
  return (
    raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='handles'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('migration 0016_handle_service_identity (upgrade path)', () => {
  it('the OLD schema keys handles by address alone, so a duplicate address is impossible', () => {
    const raw = migrateUpTo('0015_message_assoc_emoji');
    expect(indexNames(raw)).toContain('handles_address_idx');
    raw.prepare(`INSERT INTO handles (address, service) VALUES (?, 'iMessage')`).run(ADDR);
    expect(() =>
      raw.prepare(`INSERT INTO handles (address, service) VALUES (?, 'SMS')`).run(ADDR),
    ).toThrow(/UNIQUE constraint failed: handles.address/);
  });

  it("normalizes a NULL service to '' and leaves a real service untouched", async () => {
    const raw = migrateUpTo('0015_message_assoc_emoji');
    raw.prepare(`INSERT INTO handles (address, service) VALUES ('nulled', NULL)`).run();
    raw.prepare(`INSERT INTO handles (address, service) VALUES ('imsg', 'iMessage')`).run();

    const ran = await runMigrations(makeRunner(raw));
    expect(ran[0]).toBe('0016_handle_service_identity');

    const rows = raw.prepare(`SELECT address, service FROM handles ORDER BY address`).all() as {
      address: string;
      service: string | null;
    }[];
    expect(rows).toEqual([
      { address: 'imsg', service: 'iMessage' },
      { address: 'nulled', service: '' }, // '' not NULL — SQLite unique indexes treat NULLs as distinct
    ]);
  });

  it('swaps the address-only unique index for a UNIQUE (address, service) one', async () => {
    const raw = migrateUpTo('0015_message_assoc_emoji');
    await runMigrations(makeRunner(raw));

    expect(indexNames(raw)).toContain('handles_address_service_idx');
    expect(indexNames(raw)).not.toContain('handles_address_idx');

    // The new index really is UNIQUE and really is over (address, service).
    const info = raw.prepare(`PRAGMA index_list(handles)`).all() as {
      name: string;
      unique: number;
    }[];
    expect(info.find((i) => i.name === 'handles_address_service_idx')?.unique).toBe(1);
    const cols = (
      raw.prepare(`PRAGMA index_info(handles_address_service_idx)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(['address', 'service']);
  });

  it('after the migration the same address may exist twice — once per service — but not per (address, service)', async () => {
    const raw = migrateUpTo('0015_message_assoc_emoji');
    await runMigrations(makeRunner(raw));

    raw.prepare(`INSERT INTO handles (address, service) VALUES (?, 'iMessage')`).run(ADDR);
    raw.prepare(`INSERT INTO handles (address, service) VALUES (?, 'SMS')`).run(ADDR); // now legal
    expect(
      (raw.prepare(`SELECT COUNT(*) c FROM handles WHERE address = ?`).get(ADDR) as { c: number })
        .c,
    ).toBe(2);

    expect(() =>
      raw.prepare(`INSERT INTO handles (address, service) VALUES (?, 'SMS')`).run(ADDR),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
