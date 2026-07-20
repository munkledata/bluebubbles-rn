import { MIGRATIONS } from '@db/migrations';
import { createTestDb } from '../support/testDb';

/**
 * The backfill for reaction linkage guids stored raw (with the `p:0/` / `bp:0/` part prefix) BEFORE
 * the ingestion-side strip landed. Seeds rows the old way (bypassing the Message-schema strip) and
 * applies the migration's own SQL, proving the historical backlog is repaired.
 */
describe('migration 0026_strip_associated_guid_prefix', () => {
  function stripStatements(): string[] {
    const m = MIGRATIONS.find((x) => x.name === '0026_strip_associated_guid_prefix');
    if (!m) throw new Error('migration 0026 not found');
    return m.statements;
  }

  async function seedAndBackfill(rawGuid: string): Promise<string | null> {
    const { raw } = await createTestDb();
    raw.prepare(`INSERT INTO chats (guid) VALUES ('c1')`).run();
    // Insert directly (NOT through the schema) so the prefix survives — simulating a row written
    // before the fix.
    raw
      .prepare(
        `INSERT INTO messages (guid, chat_id, associated_message_guid, associated_message_type)
         VALUES ('r1', 1, ?, 'love')`,
      )
      .run(rawGuid);
    for (const stmt of stripStatements()) raw.prepare(stmt).run();
    const row = raw
      .prepare(`SELECT associated_message_guid AS g FROM messages WHERE guid = 'r1'`)
      .get() as { g: string | null };
    return row.g;
  }

  it('strips the p:0/ prefix from an already-stored reaction row', async () => {
    expect(await seedAndBackfill('p:0/mt')).toBe('mt');
  });

  it('strips the bp:0/ (attachment-part) prefix', async () => {
    expect(await seedAndBackfill('bp:0/mt')).toBe('mt');
  });

  it('leaves an already-bare linkage guid untouched', async () => {
    expect(await seedAndBackfill('mt')).toBe('mt');
  });
});
