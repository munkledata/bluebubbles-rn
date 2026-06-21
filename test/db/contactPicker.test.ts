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
});
