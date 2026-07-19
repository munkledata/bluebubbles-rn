import { createTestDb } from '../support/testDb';

describe('migration 0025_error_reports', () => {
  it('creates the error_reports table with the expected columns + retry index', async () => {
    const { raw } = await createTestDb();
    const table = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='error_reports'")
      .get();
    expect(table).toBeTruthy();

    const cols = (
      raw.prepare('PRAGMA table_info(error_reports)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'level',
        'message',
        'stack',
        'tag',
        'meta',
        'created_at',
        'attempts',
        'next_retry_at',
      ]),
    );

    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='error_reports_retry_idx'")
      .get();
    expect(idx).toBeTruthy();
  });
});
