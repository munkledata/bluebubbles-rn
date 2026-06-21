import { Chat } from '@core/models';
import { getChatParticipants, upsertChats, upsertHandles } from '@db/repositories';
import { createTestDb } from '../support/testDb';

describe('getChatParticipants', () => {
  it('returns each participant address + resolved name (for group add/remove)', async () => {
    const t = await createTestDb();
    const handles = await upsertHandles(t.db, [
      { address: '+15551112222', displayName: 'Mom' },
      { address: 'craig@apple.com' },
    ]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g1',
          style: 43,
          participants: [{ address: '+15551112222' }, { address: 'craig@apple.com' }],
        }),
      ],
      handles,
    );

    const members = await getChatParticipants(t.db, 'g1');
    expect(members).toContainEqual({ address: '+15551112222', name: 'Mom' });
    expect(members).toContainEqual({ address: 'craig@apple.com', name: 'craig@apple.com' });
  });

  it('returns empty for an unknown chat', async () => {
    const t = await createTestDb();
    expect(await getChatParticipants(t.db, 'nope')).toEqual([]);
  });

  it('upsertChats prunes a removed participant on re-sync but preserves links when omitted', async () => {
    const t = await createTestDb();
    const both = await upsertHandles(t.db, [{ address: 'a@x.com' }, { address: 'b@x.com' }]);
    await upsertChats(
      t.db,
      [
        Chat.parse({
          guid: 'g',
          style: 43,
          participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        }),
      ],
      both,
    );
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address).sort()).toEqual([
      'a@x.com',
      'b@x.com',
    ]);

    // Re-sync with b removed → the stale link is pruned (was the bug: additive-only).
    const justA = await upsertHandles(t.db, [{ address: 'a@x.com' }]);
    await upsertChats(
      t.db,
      [Chat.parse({ guid: 'g', style: 43, participants: [{ address: 'a@x.com' }] })],
      justA,
    );
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address)).toEqual(['a@x.com']);

    // A payload WITHOUT participants must NOT wipe the existing links.
    await upsertChats(t.db, [Chat.parse({ guid: 'g', style: 43 })], new Map());
    expect((await getChatParticipants(t.db, 'g')).map((m) => m.address)).toEqual(['a@x.com']);
  });
});
