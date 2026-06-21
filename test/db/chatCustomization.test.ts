import { Chat } from '@core/models';
import {
  getChatHeader,
  listChatsForInbox,
  setChatCustomization,
  setChatMute,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { isHexColor, resolveBubbleColor } from '@utils';
import { createTestDb } from '../support/testDb';

type Db = Awaited<ReturnType<typeof createTestDb>>;

async function seed(t: Db, guid: string, displayName: string): Promise<void> {
  const handles = await upsertHandles(t.db, [{ address: 'a@b.com' }]);
  await upsertChats(
    t.db,
    [Chat.parse({ guid, displayName, style: 43, participants: [{ address: 'a@b.com' }] })],
    handles,
  );
}

describe('isHexColor / resolveBubbleColor', () => {
  it('accepts only 6-digit hex', () => {
    expect(isHexColor('#1982FC')).toBe(true);
    expect(isHexColor('#abc')).toBe(false);
    expect(isHexColor('1982FC')).toBe(false);
    expect(isHexColor(null)).toBe(false);
    expect(isHexColor('red')).toBe(false);
  });

  it('uses the custom color when valid, else the fallback', () => {
    expect(resolveBubbleColor('#34C759', '#1982FC')).toBe('#34C759');
    expect(resolveBubbleColor(null, '#1982FC')).toBe('#1982FC');
    expect(resolveBubbleColor('nope', '#1982FC')).toBe('#1982FC');
  });
});

describe('chat customization repo', () => {
  it('persists a trimmed custom name + valid color and surfaces them in header/inbox', async () => {
    const t = await createTestDb();
    await seed(t, 'c1', 'Server Name');
    await setChatCustomization(t.db, 'c1', { customName: '  My Chat  ', customColor: '#AF52DE' });

    const header = await getChatHeader(t.db, 'c1');
    expect(header?.customName).toBe('My Chat');
    expect(header?.customColor).toBe('#AF52DE');

    const [row] = await listChatsForInbox(t.db);
    expect(row?.customName).toBe('My Chat');
    expect(row?.customColor).toBe('#AF52DE');
  });

  it('rejects an invalid color', async () => {
    const t = await createTestDb();
    await seed(t, 'c1', 'Server');
    await expect(setChatCustomization(t.db, 'c1', { customColor: 'magenta' })).rejects.toThrow(
      /invalid custom color/,
    );
  });

  it('clears a custom name/color with null', async () => {
    const t = await createTestDb();
    await seed(t, 'c1', 'Server');
    await setChatCustomization(t.db, 'c1', { customName: 'X', customColor: '#1982FC' });
    await setChatCustomization(t.db, 'c1', { customName: null, customColor: null });
    const header = await getChatHeader(t.db, 'c1');
    expect(header?.customName).toBeNull();
    expect(header?.customColor).toBeNull();
  });

  it('setChatMute toggles the local mute flag', async () => {
    const t = await createTestDb();
    await seed(t, 'c1', 'Server');
    await setChatMute(t.db, 'c1', 'mute');
    expect((await getChatHeader(t.db, 'c1'))?.muteType).toBe('mute');
    await setChatMute(t.db, 'c1', null);
    expect((await getChatHeader(t.db, 'c1'))?.muteType).toBeNull();
  });

  it('a server re-sync does NOT clobber local custom name/color/mute', async () => {
    const t = await createTestDb();
    await seed(t, 'c1', 'Server Name');
    await setChatCustomization(t.db, 'c1', { customName: 'Mine', customColor: '#34C759' });
    await setChatMute(t.db, 'c1', 'mute');

    // Incremental sync re-upserts the same chat with a new server display name.
    const handles = await upsertHandles(t.db, [{ address: 'a@b.com' }]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'c1',
          displayName: 'Changed Server Name',
          style: 43,
          participants: [{ address: 'a@b.com' }],
        }),
      ],
      handles,
    );

    const header = await getChatHeader(t.db, 'c1');
    expect(header?.displayName).toBe('Changed Server Name'); // server field still updates
    expect(header?.customName).toBe('Mine'); // local override preserved
    expect(header?.customColor).toBe('#34C759');
    expect(header?.muteType).toBe('mute');
  });
});
