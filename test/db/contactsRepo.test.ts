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
