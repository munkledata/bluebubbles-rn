import { getDatabase } from '@db/database';
import {
  createCustomTheme,
  kvGet,
  kvSet,
  THEME_CUSTOM_KEY,
  THEME_PREF_KEY,
} from '@db/repositories';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET, type ThemeTokens } from '@ui/theme/tokens';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

const TOKENS = { mode: 'dark', color: { tint: '#FF0000' } } as unknown as ThemeTokens;

async function openTestDb() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t.db;
}

beforeEach(() =>
  useThemeStore.setState({
    preset: DEFAULT_PRESET,
    customThemeId: null,
    customTokens: null,
    hydrated: false,
  }),
);

describe('themeStore.hydrate', () => {
  it('falls back to the default preset when nothing was persisted', async () => {
    await openTestDb();
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({
      preset: DEFAULT_PRESET,
      customThemeId: null,
      hydrated: true,
    });
  });

  it('loads a persisted preset key', async () => {
    const db = await openTestDb();
    await kvSet(db, THEME_PREF_KEY, 'ios-light');
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ preset: 'ios-light', hydrated: true });
  });

  it('loads an active custom theme (id + parsed tokens override the preset)', async () => {
    const db = await openTestDb();
    const id = await createCustomTheme(db, {
      name: 'Mine',
      mode: 'dark',
      tokens: JSON.stringify(TOKENS),
    });
    await kvSet(db, THEME_CUSTOM_KEY, String(id));
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: id,
      customTokens: TOKENS,
      hydrated: true,
    });
  });

  it('falls back to the preset when the persisted custom theme no longer exists', async () => {
    const db = await openTestDb();
    await kvSet(db, THEME_CUSTOM_KEY, '9999');
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: null,
      customTokens: null,
      hydrated: true,
    });
  });

  it('falls back to the preset when the stored tokens are corrupt JSON', async () => {
    const db = await openTestDb();
    const id = await createCustomTheme(db, { name: 'Bad', mode: 'dark', tokens: '{not json' });
    await kvSet(db, THEME_CUSTOM_KEY, String(id));
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: null, customTokens: null });
  });

  it('marks hydrated even when the DB is not open (ThemeProvider must not wait forever)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ preset: DEFAULT_PRESET, hydrated: true });
  });
});

describe('themeStore setters', () => {
  it('setPreset clears any active custom theme and persists both keys', async () => {
    const db = await openTestDb();
    useThemeStore.setState({ customThemeId: 3, customTokens: TOKENS });
    await useThemeStore.getState().setPreset('ios-light');
    expect(useThemeStore.getState()).toMatchObject({
      preset: 'ios-light',
      customThemeId: null,
      customTokens: null,
    });
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('ios-light');
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe('');
  });

  it('setCustomTheme applies optimistically and persists the id', async () => {
    const db = await openTestDb();
    await useThemeStore.getState().setCustomTheme(7, TOKENS);
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: 7, customTokens: TOKENS });
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe('7');
  });

  it('reloadCustomTokens picks up an edited theme (live recolor)', async () => {
    const db = await openTestDb();
    const id = await createCustomTheme(db, {
      name: 'Mine',
      mode: 'dark',
      tokens: JSON.stringify(TOKENS),
    });
    useThemeStore.setState({ customThemeId: id, customTokens: TOKENS });
    const edited = { ...TOKENS, color: { tint: '#00FF00' } } as unknown as ThemeTokens;
    const { updateCustomTheme } = await import('@db/repositories');
    await updateCustomTheme(db, id, { name: 'Mine', mode: 'dark', tokens: JSON.stringify(edited) });
    await useThemeStore.getState().reloadCustomTokens();
    expect(useThemeStore.getState().customTokens).toEqual(edited);
  });

  it('reloadCustomTokens reverts to the preset when the theme was deleted', async () => {
    await openTestDb();
    useThemeStore.setState({ customThemeId: 42, customTokens: TOKENS });
    await useThemeStore.getState().reloadCustomTokens();
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: null, customTokens: null });
  });
});
