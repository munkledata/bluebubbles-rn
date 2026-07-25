/**
 * Upgrade-path test for `0017_dedupe_chat_participant_links`.
 *
 * 0016 made a handle's identity (address, service), which let BOTH service variants of one person
 * be linked to the same chat — rendering them twice in the tile collage. 0017 keeps one link per
 * (chat, address), the one with the LOWEST rowid.
 *
 * The db is migrated only up to 0016 (the first point at which two same-address handle rows are
 * even constructible — before 0016 a UNIQUE index on `address` alone forbids them), the duplicate
 * links are seeded there, and only then are the remaining migrations run through the real
 * `runMigrations`. The seed deliberately inserts the HIGHER handle_id's link FIRST so that
 * "lowest rowid" and "lowest handle_id" give different answers.
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
const OTHER = '+15559998888';

type Link = { chat_id: number; handle_id: number; rowid: number };

function links(raw: Database.Database): Link[] {
  return raw
    .prepare(`SELECT rowid, chat_id, handle_id FROM chat_handles ORDER BY rowid`)
    .all() as Link[];
}

/**
 * Seeds, at the pre-0017 schema:
 *   chat 1 — handle 2 (SMS variant of ADDR, link rowid 1), handle 1 (iMessage variant, rowid 2),
 *            handle 3 (a DIFFERENT address, rowid 3), and an ORPHAN link to a missing handle 999.
 *   chat 2 — handle 1 (rowid 5) and handle 2 (rowid 6): the same duplicate pair in another chat.
 */
function seedPre0017(): Database.Database {
  const raw = migrateUpTo('0016_handle_service_identity');
  raw.prepare(`INSERT INTO chats (guid) VALUES ('c1')`).run(); // id 1
  raw.prepare(`INSERT INTO chats (guid) VALUES ('c2')`).run(); // id 2

  const h = raw.prepare(`INSERT INTO handles (address, service) VALUES (?, ?)`);
  h.run(ADDR, 'iMessage'); // id 1
  h.run(ADDR, 'SMS'); // id 2 — same person, other service
  h.run(OTHER, 'iMessage'); // id 3 — a different participant

  const link = raw.prepare(`INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)`);
  link.run(1, 2); // rowid 1 — inserted FIRST on purpose: lowest rowid, HIGHER handle_id
  link.run(1, 1); // rowid 2
  link.run(1, 3); // rowid 3 — distinct address, must survive

  // An orphan link (handle row deleted/never written). FKs are ON, so drop them for this insert.
  raw.pragma('foreign_keys = OFF');
  link.run(1, 999); // rowid 4
  raw.pragma('foreign_keys = ON');

  link.run(2, 1); // rowid 5 — the same person again, in a second chat
  link.run(2, 2); // rowid 6

  expect(links(raw)).toHaveLength(6);
  return raw;
}

describe('migration 0017_dedupe_chat_participant_links (upgrade path)', () => {
  async function seedAndUpgrade(): Promise<Database.Database> {
    const raw = seedPre0017();
    const ran = await runMigrations(makeRunner(raw));
    expect(ran[0]).toBe('0017_dedupe_chat_participant_links');
    return raw;
  }

  it('keeps exactly one link per (chat, address) and it is the LOWEST-rowid one', async () => {
    const raw = await seedAndUpgrade();
    const chat1 = links(raw).filter((l) => l.chat_id === 1);
    // handle 2 (rowid 1) beats handle 1 (rowid 2) — proving MIN(rowid), not MIN(handle_id).
    expect(chat1).toEqual([
      { rowid: 1, chat_id: 1, handle_id: 2 },
      { rowid: 3, chat_id: 1, handle_id: 3 },
    ]);
  });

  it('dedupes per chat — a second chat keeps its own surviving link', async () => {
    const raw = await seedAndUpgrade();
    const chat2 = links(raw).filter((l) => l.chat_id === 2);
    expect(chat2).toEqual([{ rowid: 5, chat_id: 2, handle_id: 1 }]);
  });

  it('DELETES an orphan link whose handle row is missing (real behaviour, not an oversight)', async () => {
    // The keep-set is built from `chat_handles ch JOIN handles h ON h.id = ch.handle_id` — an INNER
    // join, so a link pointing at a nonexistent handle contributes NO row to the GROUP BY and is
    // therefore never in `MIN(ch.rowid)`. It is deleted. Harmless (an orphan link can render
    // nothing anyway) but it IS a side effect beyond "dedupe", so it is pinned here.
    const raw = await seedAndUpgrade();
    expect(links(raw).some((l) => l.handle_id === 999)).toBe(false);
  });

  it('is idempotent — re-applying the dedupe SQL removes nothing further', async () => {
    const raw = await seedAndUpgrade();
    const after = links(raw);
    const stmts = MIGRATIONS.find(
      (m) => m.name === '0017_dedupe_chat_participant_links',
    )!.statements;
    for (const s of stmts) raw.prepare(s).run();
    expect(links(raw)).toEqual(after);
  });
});
