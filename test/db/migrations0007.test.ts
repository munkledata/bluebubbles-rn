import { createTestDb } from '../support/testDb';

describe('migration 0007 (handles.server_display_name)', () => {
  it('adds server_display_name to handles', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(handles)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('server_display_name');
  });
});
