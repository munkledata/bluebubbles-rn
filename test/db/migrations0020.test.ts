import { createTestDb } from '../support/testDb';

describe('migration 0020 (attachment genmoji)', () => {
  it('adds emoji_image_content_identifier + emoji_image_short_description to attachments', async () => {
    const { raw } = await createTestDb();
    const cols = (
      raw.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain('emoji_image_content_identifier');
    expect(cols).toContain('emoji_image_short_description');
  });
});
