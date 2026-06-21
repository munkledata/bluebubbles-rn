import {
  getChatParticipants,
  linkHandlesToContacts,
  upsertChats,
  upsertContacts,
  upsertHandles,
  type DeviceContact,
} from '@db/repositories';
import { Chat } from '@core/models';
import { createTestDb } from '../support/testDb';

const contact = (over: Partial<DeviceContact>): DeviceContact => ({
  sourceId: 's1',
  displayName: 'Craig Federighi',
  givenName: 'Craig',
  familyName: 'Federighi',
  phones: [],
  emails: [],
  avatar: null,
  ...over,
});

// 1.5(a) Contact-link-on-ingestion: when a handle is ingested during message/chat
// sync, upsertHandles opportunistically claims it for an already-synced contact —
// without waiting for the next contacts sync. 1.5(b) name priority: the linked
// contact name then wins over the raw address in participant/title resolution.
describe('contact-link on handle ingestion (1.5)', () => {
  it('links a freshly-ingested handle to an existing contact (name + avatar + contact_id)', async () => {
    const { db, raw } = await createTestDb();
    // Contacts are already synced on the device...
    await upsertContacts(db, [contact({ emails: ['craig@apple.com'], avatar: 'file:///c.jpg' })]);
    // ...then a sync ingests this handle for the first time.
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Server Craig' }]);

    const h = raw
      .prepare(
        "SELECT display_name d, server_display_name s, avatar a, contact_id c FROM handles WHERE address='craig@apple.com'",
      )
      .get() as { d: string; s: string; a: string; c: number | null };
    expect(h.d).toBe('Craig Federighi'); // contact name wins over the server name
    expect(h.s).toBe('Server Craig'); // server name still tracked for revert
    expect(h.a).toBe('file:///c.jpg');
    expect(h.c).not.toBeNull();
  });

  it('matches a phone by last-10-digits despite formatting at ingestion time', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      contact({ sourceId: 's2', displayName: 'Jenny', phones: ['(555) 123-4567'] }),
    ]);
    await upsertHandles(db, [{ address: '+15551234567' }]); // no server name
    const h = raw
      .prepare("SELECT display_name d, contact_id c FROM handles WHERE address='+15551234567'")
      .get() as { d: string; c: number | null };
    expect(h.d).toBe('Jenny');
    expect(h.c).not.toBeNull();
  });

  it('no-op when no contacts are synced yet (handle keeps the server name)', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Server Craig' }]);
    const h = raw
      .prepare("SELECT display_name d, contact_id c FROM handles WHERE address='craig@apple.com'")
      .get() as { d: string; c: number | null };
    expect(h.d).toBe('Server Craig'); // unchanged
    expect(h.c).toBeNull(); // unclaimed
  });

  it('does not re-claim an already-linked handle on a later ingestion', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [contact({ emails: ['craig@apple.com'], avatar: 'file:///c.jpg' })]);
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Server Craig' }]);
    // A later incremental sync re-ingests the same handle with a changed server name.
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Changed Server Name' }]);
    const h = raw
      .prepare("SELECT display_name d, avatar a FROM handles WHERE address='craig@apple.com'")
      .get() as { d: string; a: string };
    expect(h.d).toBe('Craig Federighi'); // contact name still wins (contact_id guard)
    expect(h.a).toBe('file:///c.jpg');
  });

  it('name priority: linked contact name beats the raw address in participants (1.5b)', async () => {
    const { db } = await createTestDb();
    await upsertContacts(db, [
      contact({ sourceId: 'm', displayName: 'Mom', phones: ['+15551112222'] }),
    ]);
    const handles = await upsertHandles(db, [
      { address: '+15551112222' }, // matches a contact → name should resolve to "Mom"
      { address: 'unknown@x.com' }, // no contact → falls back to the raw address
    ]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'g1',
          style: 43,
          participants: [{ address: '+15551112222' }, { address: 'unknown@x.com' }],
        }),
      ],
      handles,
    );

    const members = await getChatParticipants(db, 'g1');
    expect(members).toContainEqual({ address: '+15551112222', name: 'Mom' });
    expect(members).toContainEqual({ address: 'unknown@x.com', name: 'unknown@x.com' });
  });

  it('linkHandlesToContacts only touches the requested addresses', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      contact({ sourceId: 'a', displayName: 'Alice', emails: ['a@x.com'] }),
      contact({ sourceId: 'b', displayName: 'Bob', emails: ['b@x.com'] }),
    ]);
    // Insert both handles WITHOUT auto-link (upsertHandles would link them), by
    // clearing the link first, then link only one explicitly.
    await upsertHandles(db, [{ address: 'a@x.com' }, { address: 'b@x.com' }]);
    raw.prepare('UPDATE handles SET display_name = NULL, contact_id = NULL').run();

    const linked = await linkHandlesToContacts(db, ['a@x.com']);
    expect(linked).toBe(1);
    const rows = raw
      .prepare('SELECT address, display_name d, contact_id c FROM handles ORDER BY address')
      .all() as { address: string; d: string | null; c: number | null }[];
    expect(rows.find((r) => r.address === 'a@x.com')?.d).toBe('Alice');
    expect(rows.find((r) => r.address === 'b@x.com')?.d).toBeNull(); // untouched
    expect(rows.find((r) => r.address === 'b@x.com')?.c).toBeNull();
  });

  it('does not relink a large set of unrelated handles (scoped to the ingested addresses)', async () => {
    const { db, raw } = await createTestDb();
    // One contact per address: a big pool of matchable handles + the one we ingest.
    const N = 200;
    const others = Array.from({ length: N }, (_, i) => `other${i}@x.com`);
    await upsertContacts(db, [
      contact({ sourceId: 'craig', displayName: 'Craig', emails: ['craig@apple.com'] }),
      ...others.map((addr, i) =>
        contact({ sourceId: `o${i}`, displayName: `Person ${i}`, emails: [addr] }),
      ),
    ]);
    // Insert ALL handles, then strip every link so they LOOK unlinked + matchable.
    await upsertHandles(db, [
      { address: 'craig@apple.com' },
      ...others.map((address) => ({ address })),
    ]);
    raw.prepare('UPDATE handles SET display_name = NULL, contact_id = NULL').run();

    // Ingest only Craig — the 200 unrelated (but matchable) handles must be left alone.
    const linked = await linkHandlesToContacts(db, ['craig@apple.com']);

    expect(linked).toBe(1); // exactly the one requested address, not the whole table
    const craig = raw
      .prepare("SELECT display_name d, contact_id c FROM handles WHERE address='craig@apple.com'")
      .get() as { d: string | null; c: number | null };
    expect(craig.d).toBe('Craig');
    expect(craig.c).not.toBeNull();
    // None of the unrelated handles got relinked, even though a contact exists for each.
    const stillUnlinked = (
      raw
        .prepare(
          "SELECT COUNT(*) c FROM handles WHERE contact_id IS NULL AND address LIKE 'other%'",
        )
        .get() as { c: number }
    ).c;
    expect(stillUnlinked).toBe(N);
  });
});
