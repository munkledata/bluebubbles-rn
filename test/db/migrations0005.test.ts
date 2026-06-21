import { createTestDb } from '../support/testDb';

describe('migration 0005 (chats custom_name + custom_color)', () => {
  it('adds custom_name and custom_color to chats', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('custom_name');
    expect(cols).toContain('custom_color');
  });
});
