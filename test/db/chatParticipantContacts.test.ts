import { Chat } from '@core/models';
import {
  getChatParticipantContacts,
  getChatParticipants,
  linkHandlesToContacts,
  upsertChats,
  upsertContacts,
  upsertHandles,
  type DeviceContact,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

async function groupWithTwoMembers(): Promise<Awaited<ReturnType<typeof createTestDb>>> {
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
  return t;
}

function contact(sourceId: string, phones: string[], emails: string[] = []): DeviceContact {
  return {
    sourceId,
    displayName: `Contact ${sourceId}`,
    givenName: null,
    familyName: null,
    phones,
    emails,
    avatar: null,
  };
}

describe('getChatParticipantContacts', () => {
  it('returns one row per participant with its linked device contact id, or null', async () => {
    const t = await groupWithTwoMembers();
    await upsertContacts(t.db, [contact('101', ['+15551112222'])]);
    await linkHandlesToContacts(t.db, ['+15551112222', 'craig@apple.com']);

    expect(await getChatParticipantContacts(t.db, 'g1')).toEqual([
      { address: '+15551112222', service: null, contactSourceId: '101' },
      { address: 'craig@apple.com', service: null, contactSourceId: null },
    ]);
  });

  it('gives one action target when two contacts share one number', async () => {
    const t = await groupWithTwoMembers();
    await upsertContacts(t.db, [
      contact('101', ['+15551112222']),
      contact('202', ['+1 (555) 111-2222']),
    ]);
    await linkHandlesToContacts(t.db, ['+15551112222']);
    // Two different people claim the number, so the matcher links neither (it never guesses): the
    // member gets exactly one target, Android's "add to a contact" screen, not one of the two.
    expect(
      (await getChatParticipantContacts(t.db, 'g1')).filter(
        (row) => row.address === '+15551112222',
      ),
    ).toEqual([{ address: '+15551112222', service: null, contactSourceId: null }]);

    // Even when the handle is linked to the second of the two, the read returns that one row only.
    t.raw
      .prepare(
        "UPDATE handles SET contact_id = (SELECT id FROM contacts WHERE source_id = '202') WHERE address = '+15551112222'",
      )
      .run();
    const rows = await getChatParticipantContacts(t.db, 'g1');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.address === '+15551112222')).toEqual([
      { address: '+15551112222', service: null, contactSourceId: '202' },
    ]);
    // The roster read that guarded send paths count stays one row per participant too.
    expect(await getChatParticipants(t.db, 'g1')).toHaveLength(2);
  });

  it('returns empty for an unknown chat', async () => {
    const t = await createTestDb();
    expect(await getChatParticipantContacts(t.db, 'nope')).toEqual([]);
  });
});
