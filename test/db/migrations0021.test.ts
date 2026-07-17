import { createTestDb } from '../support/testDb';

describe('migration 0021 (message summary info)', () => {
  it('adds message_summary_info to messages', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('message_summary_info');
  });
});
