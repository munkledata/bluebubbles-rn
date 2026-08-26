import { Chat } from '@core/models';
import {
  getChatTheme,
  getSyncedBackgroundState,
  setBackgroundIsLight,
  setChatAppearanceWithinTransaction,
  setChatTheme,
  setSyncedBackgroundLuminanceIfCurrent,
  setSyncedBackgroundLuminanceIfCurrentWithinTransaction,
  setSyncedBackgroundUri,
  setSyncedBackgroundUriIfCurrent,
  setSyncedBackgroundUriIfCurrentWithinTransaction,
  upsertChats,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
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

  it('queues theme and luminance behind a rolling-back neighbouring transaction', async () => {
    const t = await createTestDb();
    await seedChat(t.db);

    let releaseNeighbour!: () => void;
    let neighbourStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const theme = setChatTheme(t.db, 'g1', { backgroundUri: 'file:///queued.jpg' });
    const luminance = setBackgroundIsLight(t.db, 'g1', true);
    await Promise.resolve();
    expect(await getChatTheme(t.db, 'g1')).toMatchObject({
      backgroundUri: null,
      backgroundIsLight: null,
    });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await Promise.all([theme, luminance]);
    expect(await getChatTheme(t.db, 'g1')).toMatchObject({
      backgroundUri: 'file:///queued.jpg',
      backgroundIsLight: 1,
    });
  });

  it('rolls back tokens, background, and luminance together when the owner guard is revoked', async () => {
    const t = await createTestDb();
    await seedChat(t.db);
    await setChatTheme(t.db, 'g1', {
      themeTokens: '{"old":1}',
      backgroundUri: 'file:///old.jpg',
    });
    await setBackgroundIsLight(t.db, 'g1', true);
    let current = true;
    let triggerRan = false;
    t.raw.function('revoke_chat_appearance_guard', () => {
      triggerRan = true;
      current = false;
      return 1;
    });
    t.raw.exec(`
      CREATE TRIGGER revoke_chat_appearance_guard
      AFTER UPDATE OF theme_tokens, background_uri, background_is_light ON chats
      WHEN OLD.guid = 'g1' AND NEW.background_uri = 'file:///next.jpg'
      BEGIN
        SELECT revoke_chat_appearance_guard();
      END
    `);

    await expect(
      withDbTransaction(
        t.db,
        (context) =>
          setChatAppearanceWithinTransaction(context, 'g1', {
            themeTokens: '{"next":1}',
            backgroundUri: 'file:///next.jpg',
            backgroundIsLight: false,
          }),
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(triggerRan).toBe(true);
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: '{"old":1}',
      backgroundUri: 'file:///old.jpg',
      syncedBackgroundUri: null,
      backgroundIsLight: 1,
    });

    t.raw.exec('DROP TRIGGER revoke_chat_appearance_guard');
    current = true;
    await withDbTransaction(
      t.db,
      (context) =>
        setChatAppearanceWithinTransaction(context, 'g1', {
          themeTokens: '{"next":1}',
          backgroundUri: 'file:///next.jpg',
          backgroundIsLight: false,
        }),
      () => current,
    );
    expect(await getChatTheme(t.db, 'g1')).toEqual({
      themeTokens: '{"next":1}',
      backgroundUri: 'file:///next.jpg',
      syncedBackgroundUri: null,
      backgroundIsLight: 0,
    });
  });
});

describe('synced background (macOS 26)', () => {
  it('upsert tracks the server channel; it is server-owned (refreshed on re-sync)', async () => {
    const t = await createTestDb();
    // Server says this chat has a background.
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );
    expect(await getSyncedBackgroundState(t.db, 'g1')).toEqual({ channel: 'CH-1', uri: null });

    // The participant changed the background → new channel wins on re-sync.
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-2' })],
      new Map(),
    );
    expect((await getSyncedBackgroundState(t.db, 'g1'))?.channel).toBe('CH-2');

    // Background removed on the server (field omitted) → channel clears.
    await upsertChats(t.db, [Chat.parse({ guid: 'g1', style: 43 })], new Map());
    expect((await getSyncedBackgroundState(t.db, 'g1'))?.channel).toBeNull();
  });

  it('setSyncedBackgroundUri points the chat at the downloaded file; it surfaces via getChatTheme', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );
    await setSyncedBackgroundUri(t.db, 'g1', 'file:///synced/g1-CH-1.jpg');
    expect(await getSyncedBackgroundState(t.db, 'g1')).toEqual({
      channel: 'CH-1',
      uri: 'file:///synced/g1-CH-1.jpg',
    });
    expect((await getChatTheme(t.db, 'g1'))?.syncedBackgroundUri).toBe(
      'file:///synced/g1-CH-1.jpg',
    );
  });

  it('moves the synced URI only when channel and previous URI still match', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );

    expect(
      await setSyncedBackgroundUriIfCurrent(t.db, 'g1', 'CH-1', null, 'file:///synced/one.jpg'),
    ).toBe(true);
    expect(
      await setSyncedBackgroundUriIfCurrent(
        t.db,
        'g1',
        'CH-1',
        null,
        'file:///synced/stale-uri.jpg',
      ),
    ).toBe(false);

    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-2' })],
      new Map(),
    );
    expect(
      await setSyncedBackgroundUriIfCurrent(
        t.db,
        'g1',
        'CH-1',
        'file:///synced/one.jpg',
        'file:///synced/stale-channel.jpg',
      ),
    ).toBe(false);
    expect((await getSyncedBackgroundState(t.db, 'g1'))?.uri).toBe('file:///synced/one.jpg');
  });

  it('writes synced luminance only for the measured channel/URI and no local override', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );
    await setSyncedBackgroundUri(t.db, 'g1', 'file:///synced/one.jpg');

    expect(
      await setSyncedBackgroundLuminanceIfCurrent(
        t.db,
        'g1',
        'CH-1',
        'file:///synced/one.jpg',
        true,
      ),
    ).toBe(true);
    expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBe(1);
    expect(
      await setSyncedBackgroundLuminanceIfCurrent(
        t.db,
        'g1',
        'CH-1',
        'file:///synced/stale.jpg',
        false,
      ),
    ).toBe(false);

    await setChatTheme(t.db, 'g1', { backgroundUri: 'file:///local.jpg' });
    expect(
      await setSyncedBackgroundLuminanceIfCurrent(
        t.db,
        'g1',
        'CH-1',
        'file:///synced/one.jpg',
        false,
      ),
    ).toBe(false);
    expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBe(1);
  });

  it('rolls back the context-only URI settlement when its commit guard is revoked', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );
    await setSyncedBackgroundUri(t.db, 'g1', 'file:///synced/old.jpg');

    let current = true;
    let triggerRan = false;
    t.raw.function('revoke_synced_background_uri_guard', () => {
      triggerRan = true;
      current = false;
      return 0;
    });
    t.raw.exec(`
      CREATE TRIGGER revoke_synced_background_uri_guard
      AFTER UPDATE OF synced_background_uri ON chats
      WHEN OLD.guid = 'g1' AND NEW.synced_background_uri = 'file:///synced/next.jpg'
      BEGIN
        SELECT revoke_synced_background_uri_guard();
      END
    `);

    try {
      await expect(
        withDbTransaction(
          t.db,
          (context) =>
            setSyncedBackgroundUriIfCurrentWithinTransaction(
              context,
              'g1',
              'CH-1',
              'file:///synced/old.jpg',
              'file:///synced/next.jpg',
            ),
          () => current,
        ),
      ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

      expect(triggerRan).toBe(true);
      expect((await getSyncedBackgroundState(t.db, 'g1'))?.uri).toBe('file:///synced/old.jpg');

      t.raw.exec('DROP TRIGGER revoke_synced_background_uri_guard');
      current = true;
      await expect(
        withDbTransaction(t.db, (context) =>
          setSyncedBackgroundUriIfCurrentWithinTransaction(
            context,
            'g1',
            'CH-1',
            'file:///synced/old.jpg',
            'file:///synced/next.jpg',
          ),
        ),
      ).resolves.toBe(true);
      expect((await getSyncedBackgroundState(t.db, 'g1'))?.uri).toBe('file:///synced/next.jpg');
    } finally {
      t.raw.exec('DROP TRIGGER IF EXISTS revoke_synced_background_uri_guard');
    }
  });

  it('rolls back the context-only luminance settlement when its commit guard is revoked', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' })],
      new Map(),
    );
    await setSyncedBackgroundUri(t.db, 'g1', 'file:///synced/current.jpg');

    let current = true;
    let triggerRan = false;
    t.raw.function('revoke_synced_background_luminance_guard', () => {
      triggerRan = true;
      current = false;
      return 0;
    });
    t.raw.exec(`
      CREATE TRIGGER revoke_synced_background_luminance_guard
      AFTER UPDATE OF background_is_light ON chats
      WHEN OLD.guid = 'g1' AND NEW.background_is_light = 1
      BEGIN
        SELECT revoke_synced_background_luminance_guard();
      END
    `);

    try {
      await expect(
        withDbTransaction(
          t.db,
          (context) =>
            setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
              context,
              'g1',
              'CH-1',
              'file:///synced/current.jpg',
              true,
            ),
          () => current,
        ),
      ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

      expect(triggerRan).toBe(true);
      expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBeNull();

      t.raw.exec('DROP TRIGGER revoke_synced_background_luminance_guard');
      current = true;
      await expect(
        withDbTransaction(t.db, (context) =>
          setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
            context,
            'g1',
            'CH-1',
            'file:///synced/current.jpg',
            true,
          ),
        ),
      ).resolves.toBe(true);
      expect((await getChatTheme(t.db, 'g1'))?.backgroundIsLight).toBe(1);
    } finally {
      t.raw.exec('DROP TRIGGER IF EXISTS revoke_synced_background_luminance_guard');
    }
  });

  it('queues direct URI, URI compare-and-swap, and luminance behind a rolling-back neighbour', async () => {
    const t = await createTestDb();
    await upsertChats(
      t.db,
      [
        Chat.parse({ guid: 'g1', style: 43, backgroundChannelGuid: 'CH-1' }),
        Chat.parse({ guid: 'g2', style: 43, backgroundChannelGuid: 'CH-2' }),
        Chat.parse({ guid: 'g3', style: 43, backgroundChannelGuid: 'CH-3' }),
      ],
      new Map(),
    );
    await setSyncedBackgroundUri(t.db, 'g2', 'file:///synced/two.jpg');

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(t.db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const directUri = setSyncedBackgroundUri(t.db, 'g3', 'file:///synced/three.jpg');
    const currentUri = setSyncedBackgroundUriIfCurrent(
      t.db,
      'g1',
      'CH-1',
      null,
      'file:///synced/one.jpg',
    );
    const luminance = setSyncedBackgroundLuminanceIfCurrent(
      t.db,
      'g2',
      'CH-2',
      'file:///synced/two.jpg',
      true,
    );
    await Promise.resolve();

    expect((await getSyncedBackgroundState(t.db, 'g1'))?.uri).toBeNull();
    expect((await getChatTheme(t.db, 'g2'))?.backgroundIsLight).toBeNull();
    expect((await getSyncedBackgroundState(t.db, 'g3'))?.uri).toBeNull();

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(currentUri).resolves.toBe(true);
    await expect(luminance).resolves.toBe(true);
    await directUri;

    expect((await getSyncedBackgroundState(t.db, 'g1'))?.uri).toBe('file:///synced/one.jpg');
    expect((await getChatTheme(t.db, 'g2'))?.backgroundIsLight).toBe(1);
    expect((await getSyncedBackgroundState(t.db, 'g3'))?.uri).toBe('file:///synced/three.jpg');
  });
});
