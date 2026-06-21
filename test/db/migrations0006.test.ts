import { createTestDb } from '../support/testDb';

describe('migration 0006 (reminders table)', () => {
  it('creates the reminders table with the expected columns', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'message_guid',
        'chat_guid',
        'message_preview',
        'sender_name',
        'scheduled_for',
        'notification_id',
        'created_at',
      ]),
    );
  });
});
