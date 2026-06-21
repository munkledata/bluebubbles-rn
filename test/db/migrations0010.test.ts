import { createTestDb } from '../support/testDb';

describe('migration 0010 (messages delivered tiers)', () => {
  it('adds was_delivered_quietly + did_notify_recipient to messages', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('was_delivered_quietly');
    expect(cols).toContain('did_notify_recipient');
  });
});
