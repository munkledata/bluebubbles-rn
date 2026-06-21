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

    // Device contacts cleared (contact deleted) → re-sync should revert the handle.
    await upsertContacts(db, []);
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
    await upsertContacts(db, []);
    await matchContactsToHandles(db);
    const h = raw
      .prepare("SELECT display_name d FROM handles WHERE address='+15550001111'")
      .get() as {
      d: string | null;
    };
    expect(h.d).toBeNull(); // null → COALESCE(display_name, address) shows the address
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
