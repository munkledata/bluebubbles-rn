import { createTestDb } from '../support/testDb';

describe('migration 0004 (scheduled_messages.attempts)', () => {
  it('adds an attempts column defaulting to 0', async () => {
    const { raw } = await createTestDb();
    const cols = raw.prepare('PRAGMA table_info(scheduled_messages)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const attempts = cols.find((c) => c.name === 'attempts');
    expect(attempts).toBeDefined();
    expect(attempts?.dflt_value).toBe('0');
  });
});
