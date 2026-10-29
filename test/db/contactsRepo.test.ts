import {
  linkHandlesToContacts,
  matchContactsToHandles,
  upsertContacts,
  upsertHandles,
  upsertHandlesWithinTransaction,
  type ContactDbTaskRunner,
  type DeviceContact,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
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

async function holdRollingBackNeighbour(
  db: AppDatabase,
  setup: () => void | Promise<void> = () => {},
): Promise<{ release: () => void; finished: Promise<never> }> {
  let neighbourStarted!: () => void;
  let releaseNeighbour!: () => void;
  const started = new Promise<void>((resolve) => {
    neighbourStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseNeighbour = resolve;
  });
  const finished = withDbTransaction(db, async () => {
    await setup();
    neighbourStarted();
    await held;
    throw new Error('neighbour rollback');
  });
  await started;
  return { release: releaseNeighbour, finished };
}

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

  it('leaves an endpoint unlinked when two stable contacts claim the same normalized address', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [
      { address: '+15551234567', displayName: 'Server Phone' },
      { address: 'shared@example.com', displayName: 'Server Email' },
    ]);
    await upsertContacts(db, [
      contact({
        sourceId: 'phone-us',
        displayName: 'US Contact',
        phones: ['+1 (555) 123-4567'],
      }),
      contact({
        sourceId: 'phone-gb',
        displayName: 'GB Contact',
        phones: ['+44 555 123 4567'],
      }),
      contact({
        sourceId: 'email-one',
        displayName: 'Email One',
        emails: ['Shared@Example.com'],
      }),
      contact({
        sourceId: 'email-two',
        displayName: 'Email Two',
        emails: ['shared@example.com'],
      }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(0);
    expect(
      raw
        .prepare(
          'SELECT address, display_name AS name, avatar, contact_id AS contactId FROM handles ORDER BY address',
        )
        .all(),
    ).toEqual([
      {
        address: '+15551234567',
        name: 'Server Phone',
        avatar: null,
        contactId: null,
      },
      {
        address: 'shared@example.com',
        name: 'Server Email',
        avatar: null,
        contactId: null,
      },
    ]);
  });

  // Two cards for one person (a duplicate import, "Mom" saved twice) used to block the shared
  // number: her chats lost her name and photo and became an unknown sender with no notifications.
  it('treats duplicate cards with the same name as one person', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'mom-1', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
      contact({
        sourceId: 'mom-2',
        displayName: ' mom ',
        phones: ['555-123-4567'],
        avatar: 'file:///mom.jpg',
      }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    const handle = raw
      .prepare(
        "SELECT display_name AS name, avatar, contact_id AS contactId FROM handles WHERE address = '+15551234567'",
      )
      .get() as { name: string; avatar: string | null; contactId: number | null };
    expect(handle.contactId).not.toBeNull();
    expect(handle.name.trim().toLowerCase()).toBe('mom');
    // The card with a photo wins, so the duplicate doesn't cost her picture.
    expect(handle.avatar).toBe('file:///mom.jpg');
  });

  // A number shared by differently named contacts (a family landline) links to no contact, but it
  // is in the address book; the handle records that so it still counts as a known sender.
  it('flags a number shared by differently named contacts, and clears it once one remains', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    const flags = () =>
      raw
        .prepare(
          "SELECT contact_id AS contactId, contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get() as { contactId: number | null; ambiguous: number };

    await upsertContacts(db, [
      contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
      contact({ sourceId: 'dad', displayName: 'Dad', phones: ['555-123-4567'] }),
    ]);
    await matchContactsToHandles(db);
    expect(flags()).toEqual({ contactId: null, ambiguous: 1 });

    await upsertContacts(db, [
      contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
    ]);
    await matchContactsToHandles(db);
    expect(flags().contactId).not.toBeNull();
    expect(flags().ambiguous).toBe(0);
  });

  it('flags a newly arriving number that differently named contacts share', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
      contact({ sourceId: 'dad', displayName: 'Dad', phones: ['555-123-4567'] }),
    ]);
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);

    await linkHandlesToContacts(db, ['+15551234567']);

    expect(
      raw
        .prepare(
          "SELECT contact_id AS contactId, contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get(),
    ).toEqual({ contactId: null, ambiguous: 1 });
  });

  it('never shows a shared number as unknown while it moves between linked and ambiguous', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    const state = () =>
      raw
        .prepare(
          "SELECT contact_id AS contactId, contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get() as { contactId: number | null; ambiguous: number };
    // Snapshot after every short write, the points where a notification check could read it.
    const seen: Array<{ contactId: number | null; ambiguous: number }> = [];
    const runner: ContactDbTaskRunner = async (task) => {
      const result = await task();
      seen.push(state());
      return result;
    };
    const mom = contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] });
    const dad = contact({ sourceId: 'dad', displayName: 'Dad', phones: ['555-123-4567'] });

    await upsertContacts(db, [mom]);
    await matchContactsToHandles(db);
    expect(state().contactId).not.toBeNull();

    await upsertContacts(db, [mom, dad]);
    await matchContactsToHandles(db, runner);
    expect(state()).toEqual({ contactId: null, ambiguous: 1 });

    await upsertContacts(db, [mom]);
    await matchContactsToHandles(db, runner);
    expect(state().contactId).not.toBeNull();
    expect(state().ambiguous).toBe(0);

    expect(seen.length).toBeGreaterThan(2);
    for (const snapshot of seen) {
      expect(snapshot.contactId !== null || snapshot.ambiguous === 1).toBe(true);
    }
  });

  it('keeps a shared number known while its new link waits out a race', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    const state = () =>
      raw
        .prepare(
          "SELECT contact_id AS contactId, contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get() as { contactId: number | null; ambiguous: number };
    const mom = contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] });
    const dad = contact({ sourceId: 'dad', displayName: 'Dad', phones: ['555-123-4567'] });
    await upsertContacts(db, [mom, dad]);
    await matchContactsToHandles(db);
    expect(state()).toEqual({ contactId: null, ambiguous: 1 });

    await upsertContacts(db, [mom]);
    let inserted = false;
    const runner: ContactDbTaskRunner = async (task) => {
      const result = await task();
      if (!inserted) {
        // Right after the index read an unrelated card arrives, so the link write's recheck refuses.
        inserted = true;
        raw
          .prepare(
            `INSERT INTO contacts (source_id, display_name, phones, emails)
             VALUES ('late', 'Late Card', '[]', '["late@example.com"]')`,
          )
          .run();
      }
      return result;
    };
    await matchContactsToHandles(db, runner);
    // Mom's card alone claims the number, so it stays known while its link waits for the next pass.
    expect(state()).toEqual({ contactId: null, ambiguous: 1 });

    await matchContactsToHandles(db);
    expect(state().contactId).not.toBeNull();
    expect(state().ambiguous).toBe(0);
  });

  // Found in review: the unmark step trusted the link read before the stale-link cleanup ran.
  it('keeps a shared number known when its stale link is cleared and the new link loses a race', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
    ]);
    // Linked to a card that has since been pruned, and still marked from an earlier ambiguity.
    raw
      .prepare(
        "UPDATE handles SET contact_id = 999, contact_ambiguous = 1 WHERE address = '+15551234567'",
      )
      .run();
    let inserted = false;
    const runner: ContactDbTaskRunner = async (task) => {
      const result = await task();
      if (!inserted) {
        // Right after the index read an unrelated card arrives, so the new link's recheck refuses.
        inserted = true;
        raw
          .prepare(
            `INSERT INTO contacts (source_id, display_name, phones, emails)
             VALUES ('late', 'Late Card', '[]', '["late@example.com"]')`,
          )
          .run();
      }
      return result;
    };

    await matchContactsToHandles(db, runner);

    // The stale link is gone and Mom's link must wait, but her card still claims the number.
    expect(
      raw
        .prepare(
          "SELECT contact_id AS contactId, contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get(),
    ).toEqual({ contactId: null, ambiguous: 1 });
  });

  it('does not mark a number ambiguous because of a rolling-back neighbour’s contact', async () => {
    const { db, raw } = await createTestDb();
    // The number arrives before Mom's card, so it is still unlinked when the linker runs.
    await upsertHandles(db, [{ address: '+15551234567', displayName: 'Server Phone' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'mom', displayName: 'Mom', phones: ['+1 (555) 123-4567'] }),
    ]);
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw
        .prepare(
          `INSERT INTO contacts (source_id, display_name, phones, emails)
           VALUES ('phantom-dad', 'Dad', '["555-123-4567"]', '[]')`,
        )
        .run();
    });

    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      // As above: calling `task` queues the real write behind the neighbour before its first await.
      const pending = task();
      writeReached();
      return pending;
    };
    const linking = linkHandlesToContacts(db, ['+15551234567'], runner);
    // Release the neighbour whatever happens: a held neighbour keeps the write lock forever.
    const outcome = await Promise.race([
      reached.then(() => 'parked'),
      linking.then(
        () => 'finished',
        () => 'failed',
      ),
    ]);
    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    expect(outcome).toBe('parked');
    await expect(linking).resolves.toBe(0);

    // The phantom card never committed, so it can't vouch for the number.
    expect(
      raw
        .prepare(
          "SELECT contact_ambiguous AS ambiguous FROM handles WHERE address = '+15551234567'",
        )
        .get(),
    ).toEqual({ ambiguous: 0 });
  });

  it('clears an old contact presentation when a later full sync proves the endpoint ambiguous', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'shared@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'first',
        displayName: 'First Contact',
        emails: ['shared@example.com'],
        avatar: 'file:///first.jpg',
      }),
    ]);
    expect(await matchContactsToHandles(db)).toBe(1);

    await upsertContacts(db, [
      contact({
        sourceId: 'first',
        displayName: 'First Contact',
        emails: ['shared@example.com'],
        avatar: 'file:///first.jpg',
      }),
      contact({
        sourceId: 'second',
        displayName: 'Second Contact',
        emails: ['SHARED@example.com'],
        avatar: 'file:///second.jpg',
      }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, avatar, contact_id AS contactId FROM handles WHERE address='shared@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', avatar: null, contactId: null });
  });

  it('treats overlapping rows for one stable contact source as one presentation owner', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'same@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'stable-contact',
        displayName: 'Old Generation',
        emails: ['same@example.com'],
      }),
      contact({
        sourceId: 'stable-contact',
        displayName: 'New Generation',
        emails: ['SAME@example.com'],
      }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='same@example.com'",
        )
        .get(),
    ).toEqual({ name: 'New Generation', contactId: expect.any(Number) });
  });

  it('fails closed when a second claimant is inserted after the unique index read', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'race@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'first', displayName: 'First', emails: ['race@example.com'] }),
    ]);
    let inserted = false;
    const runner: ContactDbTaskRunner = async (task) => {
      if (!inserted) {
        inserted = true;
        raw
          .prepare(
            `INSERT INTO contacts (source_id, display_name, phones, emails)
             VALUES ('second', 'Second', '[]', '["race@example.com"]')`,
          )
          .run();
      }
      return task();
    };

    await expect(linkHandlesToContacts(db, ['race@example.com'], runner)).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='race@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });
  });

  it('treats a contact row without a stable source id as unusable association evidence', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'legacy@example.com', displayName: 'Server Name' }]);
    raw
      .prepare(
        `INSERT INTO contacts (source_id, display_name, phones, emails)
         VALUES (NULL, 'Legacy Guess', '[]', '["legacy@example.com"]')`,
      )
      .run();
    const legacy = raw.prepare('SELECT id FROM contacts').get() as { id: number };
    raw
      .prepare(
        `UPDATE handles
            SET display_name = 'Legacy Guess', avatar = 'file:///legacy.jpg', contact_id = ?
          WHERE address = 'legacy@example.com'`,
      )
      .run(legacy.id);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, avatar, contact_id AS contactId FROM handles WHERE address='legacy@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', avatar: null, contactId: null });
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
// Outside North America people save numbers in local form with a trunk 0 ("0401 111 111"), while
// iMessage hands the app the international form ("+61401111111"). The last-10-digits key alone
// misses whenever the national number is shorter than ten digits.
describe('contacts saved in local national format', () => {
  const handleRow = (raw: Awaited<ReturnType<typeof createTestDb>>['raw'], address: string) =>
    raw
      .prepare(
        `SELECT display_name AS name, contact_id AS contactId, contact_ambiguous AS ambiguous
           FROM handles WHERE address = ?`,
      )
      .get(address) as { name: string | null; contactId: number | null; ambiguous: number };

  it.each([
    ['Australian mobile', '0401 111 111', '+61401111111'],
    ['UK mobile', '07700 900123', '+447700900123'],
    ['German landline', '030 1234567', '+49301234567'],
  ])('matches a %s saved locally to its international handle', async (_label, local, address) => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address, displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'local', displayName: 'Local', phones: [local] }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(handleRow(raw, address)).toMatchObject({ name: 'Local', ambiguous: 0 });
    expect(handleRow(raw, address).contactId).not.toBeNull();
  });

  it('still matches US numbers and never links a short code by suffix', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [
      { address: '+15551234567', displayName: 'Server US' },
      { address: '12345', displayName: 'Server Short' },
      { address: '+15559876543', displayName: 'Server Other US' },
    ]);
    await upsertContacts(db, [
      contact({ sourceId: 'us', displayName: 'Jenny', phones: ['(555) 123-4567'] }),
      contact({ sourceId: 'short', displayName: 'Short', phones: ['012345'] }),
      // A foreign local number equal to a US number without its "+15" must not claim it.
      contact({ sourceId: 'foreign', displayName: 'Foreign', phones: ['0559 876 543'] }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(handleRow(raw, '+15551234567').name).toBe('Jenny');
    expect(handleRow(raw, '12345')).toEqual({
      name: 'Server Short',
      contactId: null,
      ambiguous: 0,
    });
    expect(handleRow(raw, '+15559876543')).toEqual({
      name: 'Server Other US',
      contactId: null,
      ambiguous: 0,
    });
  });

  it('links nobody when differently named contacts save the same local number', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+61401111111', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'ana', displayName: 'Ana', phones: ['0401 111 111'] }),
      contact({ sourceId: 'ben', displayName: 'Ben', phones: ['0401-111-111'] }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(0);
    // Unlinked, but still a known number.
    expect(handleRow(raw, '+61401111111')).toEqual({
      name: 'Server Name',
      contactId: null,
      ambiguous: 1,
    });
  });

  it('links nobody when two country-code lengths lead to different contacts', async () => {
    const { db, raw } = await createTestDb();
    // +49 30 123456 strips to 30123456 (2-digit code) or 930123456 (1-digit code).
    await upsertHandles(db, [{ address: '+4930123456', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'berlin', displayName: 'Berlin', phones: ['030 123456'] }),
      contact({ sourceId: 'other', displayName: 'Other', phones: ['0930 123456'] }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(0);
    expect(handleRow(raw, '+4930123456')).toEqual({
      name: 'Server Name',
      contactId: null,
      ambiguous: 1,
    });
  });

  it('lets the exact key decide when a contact already claims it', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: '+61401111111', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'intl', displayName: 'Ana', phones: ['+61 401 111 111'] }),
    ]);

    expect(await matchContactsToHandles(db)).toBe(1);
    expect(handleRow(raw, '+61401111111').name).toBe('Ana');
  });
});

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

    // Observe each admitted transaction: the count reflects everything committed so far.
    const visibleCounts: number[] = [];
    const observeTask: ContactDbTaskRunner = async (task) => {
      visibleCounts.push(count(raw));
      return task();
    };

    const next = Array.from({ length: 250 }, (_, i) =>
      contact({ sourceId: `new-${i}`, displayName: `New ${i}`, emails: [`new${i}@x.com`] }),
    );
    expect(await upsertContacts(db, next, observeTask)).toBe(250);

    // Cutoff read, three insert batches, then the old-generation prune. The old generation is
    // still whole while the new one is going in…
    expect(visibleCounts).toEqual([2, 2, 102, 202, 252]);
    // …and no reader could ever have seen an empty table.
    expect(visibleCounts.every((rows) => rows > 0)).toBe(true);

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

describe('contacts account commit boundary', () => {
  it('keeps the within-transaction handle primitive inside its caller-owned rollback', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      contact({
        sourceId: 'owned',
        displayName: 'Owned Contact',
        emails: ['owned@example.com'],
      }),
    ]);

    await expect(
      withDbTransaction(db, async (context) => {
        const ids = await upsertHandlesWithinTransaction(context, [
          { address: 'owned@example.com', displayName: 'Server Name' },
        ]);
        expect(ids.size).toBe(1);
        // The primitive writes only the dependency row. Contact indexing/linking is deliberately
        // deferred until after the outer owner commits, so no unbounded contact read hides here.
        expect(
          raw
            .prepare(
              "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='owned@example.com'",
            )
            .get(),
        ).toEqual({ name: 'Server Name', contactId: null });
        throw new Error('owner rollback');
      }),
    ).rejects.toThrow('owner rollback');

    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM handles WHERE address='owned@example.com'").get(),
    ).toEqual({ count: 0 });
  });

  it('does not link a contact read from a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'phantom-link@example.com', displayName: 'Server Name' }]);
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw
        .prepare(
          `INSERT INTO contacts (source_id, display_name, phones, emails)
           VALUES ('phantom-link', 'Phantom Contact', '[]', '["phantom-link@example.com"]')`,
        )
        .run();
    });

    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      // Calling `task` claims the process-wide queue synchronously, before its first await. The
      // signal therefore proves the linker consumed the phantom read and parked its real write.
      const pending = task();
      writeReached();
      return pending;
    };
    const linking = linkHandlesToContacts(db, ['phantom-link@example.com'], runner);
    await reached;
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='phantom-link@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    // The queued update re-checks the contact after rollback. RETURNING is empty, so the public
    // count is truthful instead of claiming it linked a row whose source never committed.
    await expect(linking).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='phantom-link@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });
  });

  it('does not overwrite a handle claimed after the opportunistic read', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'claim-race@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'target',
        displayName: 'Target Contact',
        emails: ['claim-race@example.com'],
      }),
      contact({ sourceId: 'winner', displayName: 'Winner', emails: ['winner@example.com'] }),
    ]);
    const winner = raw.prepare("SELECT id FROM contacts WHERE source_id='winner'").get() as {
      id: number;
    };

    const runner: ContactDbTaskRunner = async (task) => {
      // Runs after linkHandlesToContacts selected this NULL-linked candidate, but before its
      // queued compare-and-set. This is the exact stale-read window the NULL guard closes.
      raw
        .prepare(
          `UPDATE handles
              SET display_name = 'Winner', contact_id = ?
            WHERE address = 'claim-race@example.com'`,
        )
        .run(winner.id);
      return task();
    };

    await expect(linkHandlesToContacts(db, ['claim-race@example.com'], runner)).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='claim-race@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Winner', contactId: winner.id });
  });

  it('rejects a queued contact link after its account commit guard is revoked', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'revoked-link@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'revoked-link',
        displayName: 'Retired Contact',
        emails: ['revoked-link@example.com'],
      }),
    ]);
    const neighbour = await holdRollingBackNeighbour(db);
    let current = true;
    let announceQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      announceQueued = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      const pending = task();
      announceQueued();
      return pending;
    };

    const linking = linkHandlesToContacts(db, ['revoked-link@example.com'], runner, () => current);
    await queued;
    current = false;
    neighbour.release();

    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(linking).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='revoked-link@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });
  });

  it('routes every upsert and match statement through the supplied short-task runner', async () => {
    const { db } = await createTestDb();
    await upsertHandles(db, [{ address: 'runner@x.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'old', displayName: 'Old Name', emails: ['old@x.com'] }),
    ]);

    let upsertStatements = 0;
    const runUpsertTask: ContactDbTaskRunner = async (task) => {
      upsertStatements += 1;
      return task();
    };
    const next = Array.from({ length: 150 }, (_, i) =>
      contact({
        sourceId: `new-${i}`,
        displayName: i === 0 ? 'Runner Contact' : `Contact ${i}`,
        emails: [i === 0 ? 'runner@x.com' : `person${i}@x.com`],
      }),
    );

    await upsertContacts(db, next, runUpsertTask);
    // cutoff read + two 100-row insert batches + old-generation prune
    expect(upsertStatements).toBe(4);

    let matchStatements = 0;
    const runMatchTask: ContactDbTaskRunner = async (task) => {
      matchStatements += 1;
      return task();
    };
    expect(await matchContactsToHandles(db, runMatchTask)).toBe(1);
    // contact-index read + handles read + one matched-handle update
    expect(matchStatements).toBe(3);
  });

  it('queues the contact generation behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw
        .prepare(
          `INSERT INTO contacts (source_id, display_name, phones, emails)
           VALUES ('phantom', 'Phantom', '[]', '[]')`,
        )
        .run();
    });

    const upsert = upsertContacts(db, [
      contact({ sourceId: 'safe', displayName: 'Safe', emails: ['safe@example.com'] }),
    ]);
    await Promise.resolve();
    expect(raw.prepare('SELECT source_id AS sourceId FROM contacts').all()).toEqual([
      { sourceId: 'phantom' },
    ]);

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await upsert;
    expect(raw.prepare('SELECT source_id AS sourceId FROM contacts').all()).toEqual([
      { sourceId: 'safe' },
    ]);
  });

  it('prunes old contacts in visible batches of at most 500 rows', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare(
      `INSERT INTO contacts (source_id, display_name, phones, emails)
       VALUES (?, ?, '[]', '[]')`,
    );
    raw.transaction(() => {
      for (let i = 0; i < 1205; i += 1) insert.run(`old-${i}`, `Old ${i}`);
    })();

    const visibleCounts: number[] = [];
    const runner: ContactDbTaskRunner = async (task) => {
      visibleCounts.push(
        (raw.prepare('SELECT COUNT(*) AS count FROM contacts').get() as { count: number }).count,
      );
      return task();
    };
    await upsertContacts(
      db,
      [contact({ sourceId: 'new', displayName: 'New', emails: ['new@example.com'] })],
      runner,
    );

    // cutoff read, insert, then three prune batches: 500 + 500 + 205 old rows.
    expect(visibleCounts).toEqual([1205, 1205, 1206, 706, 206]);
    expect(raw.prepare('SELECT source_id AS sourceId FROM contacts').all()).toEqual([
      { sourceId: 'new' },
    ]);
  });

  it('queues a matched-handle update behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'match@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'match',
        displayName: 'Contact Name',
        emails: ['match@example.com'],
      }),
    ]);
    const neighbour = await holdRollingBackNeighbour(db);

    let runnerCalls = 0;
    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      runnerCalls += 1;
      const result = task();
      if (runnerCalls === 3) writeReached();
      return result;
    };
    const matching = matchContactsToHandles(db, runner);
    await reached;
    expect(
      raw
        .prepare("SELECT display_name AS name FROM handles WHERE address='match@example.com'")
        .get(),
    ).toEqual({ name: 'Server Name' });

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(matching).resolves.toBe(1);
    expect(
      raw
        .prepare("SELECT display_name AS name FROM handles WHERE address='match@example.com'")
        .get(),
    ).toEqual({ name: 'Contact Name' });
  });

  it('does not commit a match derived from a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'phantom@example.com', displayName: 'Server Name' }]);
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw
        .prepare(
          `INSERT INTO contacts (source_id, display_name, phones, emails)
           VALUES ('phantom', 'Phantom Contact', '[]', '["phantom@example.com"]')`,
        )
        .run();
    });

    let runnerCalls = 0;
    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      runnerCalls += 1;
      const result = task();
      if (runnerCalls === 3) writeReached();
      return result;
    };
    const matching = matchContactsToHandles(db, runner);
    await reached;

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(matching).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='phantom@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });
  });

  it('does not clear a valid link for an ambiguous claimant that rolls back', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'shared@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'kept', displayName: 'Kept Contact', emails: ['shared@example.com'] }),
    ]);
    await matchContactsToHandles(db);
    const linked = raw
      .prepare(
        "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='shared@example.com'",
      )
      .get() as { name: string; contactId: number };
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw
        .prepare(
          `INSERT INTO contacts (source_id, display_name, phones, emails)
           VALUES ('rolling-back-rival', 'Rival', '[]', '["shared@example.com"]')`,
        )
        .run();
    });

    let runnerCalls = 0;
    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      runnerCalls += 1;
      const result = task();
      if (runnerCalls === 3) writeReached();
      return result;
    };
    const matching = matchContactsToHandles(db, runner);
    await reached;

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(matching).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='shared@example.com'",
        )
        .get(),
    ).toEqual(linked);
  });

  it('does not clear a contact link hidden by a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'kept@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({ sourceId: 'kept', displayName: 'Kept Contact', emails: ['kept@example.com'] }),
      contact({ sourceId: 'other', displayName: 'Other Contact', emails: ['other@example.com'] }),
    ]);
    await matchContactsToHandles(db);
    const linked = raw
      .prepare("SELECT contact_id AS contactId FROM handles WHERE address='kept@example.com'")
      .get() as { contactId: number };
    const neighbour = await holdRollingBackNeighbour(db, () => {
      raw.prepare('DELETE FROM contacts WHERE id = ?').run(linked.contactId);
    });

    let runnerCalls = 0;
    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      runnerCalls += 1;
      const result = task();
      if (runnerCalls === 3) writeReached();
      return result;
    };
    const matching = matchContactsToHandles(db, runner);
    await reached;

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(matching).resolves.toBe(0);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='kept@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Kept Contact', contactId: linked.contactId });
  });

  it('queues a removed-contact revert behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    await upsertHandles(db, [{ address: 'revert@example.com', displayName: 'Server Name' }]);
    await upsertContacts(db, [
      contact({
        sourceId: 'revert',
        displayName: 'Contact Name',
        emails: ['revert@example.com'],
      }),
    ]);
    await matchContactsToHandles(db);
    await upsertContacts(db, [
      contact({ sourceId: 'other', displayName: 'Other', emails: ['other@example.com'] }),
    ]);
    const neighbour = await holdRollingBackNeighbour(db);

    let runnerCalls = 0;
    let writeReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const runner: ContactDbTaskRunner = async (task) => {
      runnerCalls += 1;
      const result = task();
      if (runnerCalls === 3) writeReached();
      return result;
    };
    const reverting = matchContactsToHandles(db, runner);
    await reached;
    expect(
      raw
        .prepare("SELECT display_name AS name FROM handles WHERE address='revert@example.com'")
        .get(),
    ).toEqual({ name: 'Contact Name' });

    neighbour.release();
    await expect(neighbour.finished).rejects.toThrow('neighbour rollback');
    await expect(reverting).resolves.toBe(1);
    expect(
      raw
        .prepare(
          "SELECT display_name AS name, contact_id AS contactId FROM handles WHERE address='revert@example.com'",
        )
        .get(),
    ).toEqual({ name: 'Server Name', contactId: null });
  });
});
