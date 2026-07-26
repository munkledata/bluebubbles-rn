import {
  matchContactsToHandles,
  upsertContacts,
  upsertHandles,
  type DeviceContact,
} from '@db/repositories';
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

describe('contacts matching', () => {
  it('matches by email (case-insensitive) and writes name + avatar + contact_id, beating the server name', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Server Craig' }]);
    await upsertContacts(db, [contact({ emails: ['Craig@Apple.com'], avatar: 'file:///x.jpg' })]);

    expect(await matchContactsToHandles(db)).toBe(1);
    const h = raw
      .prepare(
        "SELECT display_name d, avatar a, contact_id c FROM handles WHERE address='craig@apple.com'",
      )
      .get() as { d: string; a: string; c: number };
    expect(h.d).toBe('Craig Federighi'); // contact wins over 'Server Craig'
    expect(h.a).toBe('file:///x.jpg');
    expect(h.c).not.toBeNull();
  });

  it('matches a phone by last-10-digits despite formatting', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: '+15551234567' }]);
    await upsertContacts(db, [
      contact({ sourceId: 's2', displayName: 'Jenny', phones: ['(555) 123-4567'] }),
    ]);
    expect(await matchContactsToHandles(db)).toBe(1);
    const h = raw
      .prepare("SELECT display_name d FROM handles WHERE address='+15551234567'")
      .get() as {
      d: string;
    };
    expect(h.d).toBe('Jenny');
  });

  it('writes a photo-only contact (no name) avatar onto the handle without blanking the server name', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 's3',
        displayName: null,
        givenName: null,
        familyName: null,
        phones: ['555-123-4567'],
        avatar: 'file:///photo.jpg',
      }),
    ]);
    expect(await matchContactsToHandles(db)).toBe(1);
    const h = raw
      .prepare(
        "SELECT display_name d, avatar a, contact_id c FROM handles WHERE address='+15551234567'",
      )
      .get() as { d: string | null; a: string | null; c: number | null };
    expect(h.a).toBe('file:///photo.jpg'); // avatar applied
    expect(h.c).not.toBeNull(); // claimed by the contact
    expect(h.d).toBe('Server Name'); // server name preserved, not blanked to null
  });

  it('reverts a handle to its server name when the device contact is removed', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'bob@x.com', displayName: 'Server Bob' }]);
    await upsertContacts(db, [
      contact({ emails: ['bob@x.com'], displayName: 'Bob Contact', avatar: 'file:///b.jpg' }),
    ]);
    await matchContactsToHandles(db);
    const matched = raw
      .prepare("SELECT display_name d, contact_id c FROM handles WHERE address='bob@x.com'")
      .get() as { d: string; c: number | null };
    expect(matched.d).toBe('Bob Contact');
    expect(matched.c).not.toBeNull();

    // Bob deleted from the address book, but the book still holds SOMEBODY → re-sync reverts the
    // handle. (A book that reads back EMPTY is deliberately a no-op — see the guard test below.)
    await upsertContacts(db, [
      contact({ sourceId: 's-other', displayName: 'Someone Else', emails: ['other@x.com'] }),
    ]);
    const reverted = await matchContactsToHandles(db);
    expect(reverted).toBe(1);
    const after = raw
      .prepare(
        "SELECT display_name d, avatar a, contact_id c FROM handles WHERE address='bob@x.com'",
      )
      .get() as { d: string; a: string | null; c: number | null };
    expect(after.d).toBe('Server Bob'); // reverted to the server name
    expect(after.a).toBeNull(); // avatar cleared
    expect(after.c).toBeNull(); // no longer claimed
  });

  it('reverts to the raw address when the server never supplied a name', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15550001111' }]); // no server displayName
    await upsertContacts(db, [contact({ phones: ['555-000-1111'], displayName: 'Temp Name' })]);
    await matchContactsToHandles(db);
    await upsertContacts(db, [
      contact({ sourceId: 's-other', displayName: 'Someone Else', emails: ['other@x.com'] }),
    ]);
    await matchContactsToHandles(db);
    const h = raw
      .prepare("SELECT display_name d FROM handles WHERE address='+15550001111'")
      .get() as {
      d: string | null;
    };
    expect(h.d).toBeNull(); // null → COALESCE(display_name, address) shows the address
  });

  it('an EMPTY contacts table is a no-op, not a mass un-link (never blanks every name)', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'craig@apple.com' }]); // no server name, as this server sends
    await upsertContacts(db, [contact({ emails: ['craig@apple.com'], avatar: 'file:///x.jpg' })]);
    expect(await matchContactsToHandles(db)).toBe(1);

    // A read that comes back empty (a permissions blip, a freshly-wiped DB) means "we don't know"
    // — reverting here would write display_name = NULL on every linked handle and turn the whole
    // inbox into phone numbers.
    await upsertContacts(db, []);
    expect(await matchContactsToHandles(db)).toBe(0);
    const h = raw
      .prepare(
        "SELECT display_name d, avatar a, contact_id c FROM handles WHERE address='craig@apple.com'",
      )
      .get() as { d: string | null; a: string | null; c: number | null };
    expect(h.d).toBe('Craig Federighi'); // name intact
    expect(h.a).toBe('file:///x.jpg');
    expect(h.c).not.toBeNull(); // still claimed
  });

  it('a server re-sync does not clobber a contact-set name/avatar', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Server Craig' }]);
    await upsertContacts(db, [contact({ emails: ['craig@apple.com'], avatar: 'file:///x.jpg' })]);
    await matchContactsToHandles(db);

    // Simulate an incremental sync re-upserting the same handle with a new server name.
    await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Changed Server Name' }]);
    const h = raw
      .prepare("SELECT display_name d, avatar a FROM handles WHERE address='craig@apple.com'")
      .get() as { d: string; a: string };
    expect(h.d).toBe('Craig Federighi'); // contact_id guard holds
    expect(h.a).toBe('file:///x.jpg');
  });
});

/**
 * `upsertContacts` runs on every boot, reconnect and pull-to-refresh. It used to empty the table
 * and then re-insert it one row at a time, which on a 1-2k-entry address book left the device with
 * NO contacts for seconds at a stretch — long enough for a notification to show a raw phone number
 * instead of a name, for "Filter Unknown Senders" to drop a first message from a new contact
 * outright (a one-shot decision with no retry), and for the recipient picker to come up blank.
 *
 * Every statement commits on its own and wakes the reactive readers, so that empty state was
 * genuinely observed. The replacement adds the new generation above a recorded id cutoff and
 * prunes the old one afterwards, in that order.
 */
describe('upsertContacts — add-then-prune', () => {
  /** Row count straight off the raw handle, i.e. what a reader would see at this instant. */
  const count = (raw: { prepare: (s: string) => { get: () => unknown } }): number =>
    (raw.prepare('SELECT COUNT(*) c FROM contacts').get() as { c: number }).c;

  it('never leaves the table empty, and prunes the old generation only after the new one lands', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      contact({ sourceId: 'old-1', displayName: 'Old One', emails: ['old1@x.com'] }),
      contact({ sourceId: 'old-2', displayName: 'Old Two', emails: ['old2@x.com'] }),
    ]);

    // Observe the table as each write is ISSUED: the count reflects everything committed so far.
    const ops: { op: string; rows: number }[] = [];
    const observed = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert' || prop === 'delete')
          ops.push({ op: String(prop), rows: count(raw) });
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as typeof db;

    const next = Array.from({ length: 250 }, (_, i) =>
      contact({ sourceId: `new-${i}`, displayName: `New ${i}`, emails: [`new${i}@x.com`] }),
    );
    expect(await upsertContacts(observed, next)).toBe(250);

    // Batched, not one statement per contact, and the delete comes last.
    expect(ops.map((o) => o.op)).toEqual(['insert', 'insert', 'insert', 'delete']);
    // The old generation is still whole while the new one is going in…
    expect(ops.map((o) => o.rows)).toEqual([2, 102, 202, 252]);
    // …and no reader could ever have seen an empty table.
    expect(ops.every((o) => o.rows > 0)).toBe(true);

    expect(count(raw)).toBe(250);
    const names = raw.prepare('SELECT display_name d FROM contacts ORDER BY id').all() as {
      d: string;
    }[];
    expect(names[0]!.d).toBe('New 0');
    expect(names.at(-1)!.d).toBe('New 249');
  });

  it('clears the table when the device genuinely has no contacts', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [contact({ sourceId: 'a', emails: ['a@x.com'] })]);
    expect(await upsertContacts(db, [])).toBe(0);
    expect(count(raw)).toBe(0);
  });

  it('writes the first generation into an empty table (no cutoff to prune)', async () => {
    const { db, raw } = await createTestDb();
    expect(await upsertContacts(db, [contact({ sourceId: 'a', emails: ['a@x.com'] })])).toBe(1);
    expect(count(raw)).toBe(1);
  });
});
