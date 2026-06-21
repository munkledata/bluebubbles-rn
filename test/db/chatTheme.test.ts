import { Chat } from '@core/models';
import { getChatTheme, setChatTheme, upsertChats } from '@db/repositories';
import { createTestDb } from '../support/testDb';

/** Seed one chat row so the theme update has a target. */
async function seedChat(db: Awaited<ReturnType<typeof createTestDb>>['db']): Promise<void> {
  await upsertChats(db, [Chat.parse({ guid: 'g1', style: 43 })], new Map());
}

describe('setChatTheme / getChatTheme', () => {
  it('returns null fields by default (migration columns exist, no override set)', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    expect(await getChatTheme(t.db, 'g1')).toEqual({ themeTokens: null, backgroundUri: null });
  });

  it('returns null for an unknown chat', async () => {
    const t = await createTestDb();
    expect(await getChatTheme(t.db, 'nope')).toBeNull();
  });

  it('sets tokens + background and reads them back', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    const tokens = JSON.stringify({ mode: 'dark', color: { tint: '#FF0000' } });
    await setChatTheme(t.db, 'g1', { themeTokens: tokens, backgroundUri: 'file:///bg.jpg' });
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: tokens,
      backgroundUri: 'file:///bg.jpg',
    });
  });

  it('partial update leaves the omitted field unchanged', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', { themeTokens: '{"a":1}', backgroundUri: 'file:///x.jpg' });
    // Only touch the background → tokens survive.
    await setChatTheme(t.db, 'g1', { backgroundUri: 'file:///y.jpg' });
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: '{"a":1}',
      backgroundUri: 'file:///y.jpg',
    });
  });

  it('a no-op patch (no fields) does not throw and changes nothing', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', { themeTokens: '{"a":1}' });
    await setChatTheme(t.db, 'g1', {});
    expect(await getChatTheme(t.db, 'g1')).toEqual({ themeTokens: '{"a":1}', backgroundUri: null });
  });

  it('clears both fields with explicit nulls', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', { themeTokens: '{"a":1}', backgroundUri: 'file:///x.jpg' });
    await setChatTheme(t.db, 'g1', { themeTokens: null, backgroundUri: null });
    expect(await getChatTheme(t.db, 'g1')).toEqual({ themeTokens: null, backgroundUri: null });
  });
});
