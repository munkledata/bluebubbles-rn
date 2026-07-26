import { searchContactAddresses, upsertContacts, type DeviceContact } from '@db/repositories';
import { createTestDb } from '../support/testDb';

const contact = (over: Partial<DeviceContact>): DeviceContact => ({
  sourceId: '1',
  displayName: 'Name',
  givenName: null,
  familyName: null,
  phones: [],
  emails: [],
  avatar: null,
  ...over,
});

describe('searchContactAddresses', () => {
  it('flattens phones + emails into (name, address) pairs', async () => {
    const t = await createTestDb();
    await upsertContacts(t.db, [
      contact({
        sourceId: '1',
        displayName: 'Mom',
        phones: ['+15551112222'],
        emails: ['mom@x.com'],
      }),
      contact({ sourceId: '2', displayName: 'Craig', phones: ['+15553334444'] }),
    ]);
    const all = await searchContactAddresses(t.db, '');
    expect(all).toContainEqual({ name: 'Mom', address: '+15551112222' });
    expect(all).toContainEqual({ name: 'Mom', address: 'mom@x.com' });
    expect(all).toContainEqual({ name: 'Craig', address: '+15553334444' });
  });

  it('filters by name or address substring', async () => {
    const t = await createTestDb();
    await upsertContacts(t.db, [
      contact({ sourceId: '1', displayName: 'Mom', phones: ['+15551112222'] }),
      contact({ sourceId: '2', displayName: 'Craig', emails: ['craig@apple.com'] }),
    ]);
    expect(await searchContactAddresses(t.db, 'craig')).toEqual([
      { name: 'Craig', address: 'craig@apple.com' },
    ]);
    expect((await searchContactAddresses(t.db, '5551')).map((c) => c.address)).toEqual([
      '+15551112222',
    ]);
  });

  it('returns nothing when there are no contacts', async () => {
    const t = await createTestDb();
    expect(await searchContactAddresses(t.db, 'anything')).toEqual([]);
  });

  it('offers each (name, address) once, however many rows carry it', async () => {
    const t = await createTestDb();
    // Two rows for the same person — what the contacts sync briefly looks like while the new
    // generation is in and the old one is not yet pruned — plus a number listed under two labels.
    await upsertContacts(t.db, [
      contact({ sourceId: 'gen-old', displayName: 'Mom', phones: ['+15551112222'] }),
      contact({
        sourceId: 'gen-new',
        displayName: 'Mom',
        phones: ['+15551112222', '+15551112222'],
      }),
    ]);
    expect(await searchContactAddresses(t.db, '')).toEqual([
      { name: 'Mom', address: '+15551112222' },
    ]);
  });

  it('collapses the duplicate generation BEFORE the row cap, so a late-alphabet name is findable', async () => {
    const t = await createTestDb();
    // 600 people, each present TWICE — what the table looks like between a contacts sync's inserts
    // and its prune. That is 1200 rows against a 1000-row query cap, so de-duping only in JS (i.e.
    // AFTER the LIMIT) leaves the picker holding just the alphabetically-first ~500 people and a
    // search for anyone past them comes back empty.
    const people: DeviceContact[] = [];
    for (let i = 1; i <= 600; i++) {
      const name = `p${String(i).padStart(4, '0')}`;
      const row = contact({
        sourceId: name,
        displayName: name,
        phones: [`+1555${String(i).padStart(7, '0')}`],
      });
      // The two generations differ ONLY in source_id, which the picker's query never selects.
      people.push(row, { ...row, sourceId: `${name}-previous` });
    }
    await upsertContacts(t.db, people);

    expect(await searchContactAddresses(t.db, 'p0600')).toEqual([
      { name: 'p0600', address: '+15550000600' },
    ]);
  });
});
