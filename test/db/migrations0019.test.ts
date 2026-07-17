import { createTestDb } from '../support/testDb';

describe('migration 0019 (message is_scheduled)', () => {
  it('adds is_scheduled to messages', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('is_scheduled');
  });
});
