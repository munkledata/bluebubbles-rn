import { kvGet, kvSet, THEME_PREF_KEY } from '@db/repositories';
import { createTestDb } from '../support/testDb';

describe('kv prefs', () => {
  it('roundtrips set/get and overwrites', async () => {
    const { db } = await createTestDb();
    expect(await kvGet(db, THEME_PREF_KEY)).toBeNull();
    await kvSet(db, THEME_PREF_KEY, 'nord');
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('nord');
    await kvSet(db, THEME_PREF_KEY, 'oled-dark');
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('oled-dark');
  });
});
