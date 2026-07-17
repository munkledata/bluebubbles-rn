import { createTestDb } from '../support/testDb';

describe('migration 0022 (message deletion tombstone)', () => {
  it('adds date_deleted to messages', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('date_deleted');
  });
});
