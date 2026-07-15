import { createTestDb } from '../support/testDb';

describe('migration 0015 (message associated emoji)', () => {
  it('adds associated_message_emoji to messages', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('associated_message_emoji');
  });
});
