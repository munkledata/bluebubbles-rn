/**
 * Upgrade-path test for `0011_backfill_has_attachments`.
 *
 * Every other migration test builds a FRESH db and runs ALL migrations, so nothing binds a
 * transform to the migration that performs it. Here the db is migrated only UP TO the migration
 * BEFORE 0011, rows are seeded at that older schema (has_attachments still 0, exactly as an
 * earlier sync left it), and only then are the remaining migrations run through the real
 * `runMigrations` — so the assertions can only pass if 0011 itself does the backfill.
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

describe('migration 0011_backfill_has_attachments (upgrade path)', () => {
  async function seedAndUpgrade() {
    // Old schema: everything through 0010, i.e. the state a device was in before 0011 shipped.
    const raw = migrateUpTo('0010_delivered_tiers');
    raw.prepare(`INSERT INTO chats (guid) VALUES ('c1')`).run();

    const insertMsg = raw.prepare(
      `INSERT INTO messages (guid, chat_id, text, has_attachments) VALUES (?, 1, ?, ?)`,
    );
    insertMsg.run('m-with-att', 'photo', 0); // id 1 — has an attachment row, flag wrongly 0
    insertMsg.run('m-plain', 'just text', 0); // id 2 — no attachment at all
    insertMsg.run('m-stale-flag', 'no file', 1); // id 3 — flag already 1 but no attachment row

    const insertAtt = raw.prepare(
      `INSERT INTO attachments (guid, message_id, mime_type) VALUES (?, ?, 'image/jpeg')`,
    );
    insertAtt.run('a1', 1);
    insertAtt.run('a2', 1); // two attachments on one message — DISTINCT collapses them
    insertAtt.run('a-orphan', null); // unlinked attachment (the `message_id IS NOT NULL` guard)

    // Sanity: the seed really is at the pre-0011 state.
    expect(flags(raw)).toEqual({ 'm-with-att': 0, 'm-plain': 0, 'm-stale-flag': 1 });

    const ran = await runMigrations(makeRunner(raw));
    expect(ran[0]).toBe('0011_backfill_has_attachments'); // 0011 is what just ran
    return raw;
  }

  function flags(raw: Database.Database): Record<string, number> {
    const rows = raw.prepare(`SELECT guid, has_attachments AS h FROM messages`).all() as {
      guid: string;
      h: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.guid, r.h]));
  }

  it('flips only the messages that actually have attachment rows', async () => {
    const raw = await seedAndUpgrade();
    expect(flags(raw)).toEqual({
      'm-with-att': 1,
      'm-plain': 0, // a message with no attachment stays 0 …
      // … and the orphan attachment (message_id NULL) must not flip anything either.
      'm-stale-flag': 1,
    });
  });

  it('is idempotent — re-applying the backfill SQL changes nothing', async () => {
    const raw = await seedAndUpgrade();
    const before = flags(raw);
    const stmts = MIGRATIONS.find((m) => m.name === '0011_backfill_has_attachments')!.statements;
    for (const s of stmts) raw.prepare(s).run();
    expect(flags(raw)).toEqual(before);
  });

  it('DOCUMENTED LIMITATION: it never clears a stale has_attachments=1', async () => {
    // The migration is `SET has_attachments = 1 WHERE id IN (…)` — one-directional. A row whose
    // attachments were deleted keeps its stale 1. Pinned so a future rewrite is a conscious change.
    const raw = await seedAndUpgrade();
    expect(flags(raw)['m-stale-flag']).toBe(1);
  });
});
