import { Chat } from '@core/models';
import {
  getChatTheme,
  getSyncedBackgroundState,
  setBackgroundIsLight,
  setChatTheme,
  setSyncedBackgroundUri,
  upsertChats,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

/** Seed one chat row so the theme update has a target. */
async function seedChat(db: Awaited<ReturnType<typeof createTestDb>>['db']): Promise<void> {
  await upsertChats(db, [Chat.parse({ guid: 'g1', style: 43 })], new Map());
}

describe('setChatTheme / getChatTheme', () => {
  it('returns null fields by default (migration columns exist, no override set)', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: null,
      backgroundUri: null,
      syncedBackgroundUri: null,
      backgroundIsLight: null,
    });
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
      syncedBackgroundUri: null,
      backgroundIsLight: null,
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
      syncedBackgroundUri: null,
      backgroundIsLight: null,
    });
  });

  it('a no-op patch (no fields) does not throw and changes nothing', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', { themeTokens: '{"a":1}' });
    await setChatTheme(t.db, 'g1', {});
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: '{"a":1}',
      backgroundUri: null,
      syncedBackgroundUri: null,
      backgroundIsLight: null,
    });
  });

  it('clears both fields with explicit nulls', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', { themeTokens: '{"a":1}', backgroundUri: 'file:///x.jpg' });
    await setChatTheme(t.db, 'g1', { themeTokens: null, backgroundUri: null });
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: null,
      backgroundUri: null,
      syncedBackgroundUri: null,
      backgroundIsLight: null,
    });
  });

  it('setBackgroundIsLight round-trips (light=1, dark=0, null clears) via getChatTheme', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setBackgroundIsLight(t.db, 'g1', true);
    expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBe(1);
    await setBackgroundIsLight(t.db, 'g1', false);
    expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBe(0);
    await setBackgroundIsLight(t.db, 'g1', null);
    expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBeNull();
  });
});

describe('synced background (macOS 26)', () => {
  it('upsert tracks the server channel; it is server-owned (refreshed on re-sync)', async () => {
    const t = await createTestDb();
    // Server says this chat has a background.
    await upsertChats(t.db, [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })], new Map());
    expect(await getSyncedBackgroundState(t.db, 'g1')).toEqual({ channel: 'CH-1', uri: null });

    // The participant changed the background → new channel wins on re-sync.
    await upsertChats(t.db, [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-2' })], new Map());
    expect((await getSyncedBackgroundState(t.db, 'g1'))?.channel).toBe('CH-2');

    // Background removed on the server (field omitted) → channel clears.
    await upsertChats(t.db, [Chat.parse({ guid: 'g1', style: 43 })], new Map());
    expect((await getSyncedBackgroundState(t.db, 'g1'))?.channel).toBeNull();
  });

  it('setSyncedBackgroundUri points the chat at the downloaded file; it surfaces via getChatTheme', async () => {
    const t = await createTestDb();
    await upsertChats(t.db, [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })], new Map());
    await setSyncedBackgroundUri(t.db, 'g1', 'file:///synced/g1-CH-1.jpg');
    expect(await getSyncedBackgroundState(t.db, 'g1')).toEqual({
      channel: 'CH-1',
      uri: 'file:///synced/g1-CH-1.jpg',
    });
    expect((await getChatTheme(t.db, 'g1'))?.syncedBackgroundUri).toBe('file:///synced/g1-CH-1.jpg');
  });
});
