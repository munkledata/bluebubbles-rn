import { getDatabase } from '@db/database';
import {
  createCustomTheme,
  kvGet,
  kvSet,
  THEME_CUSTOM_KEY,
  THEME_PREF_KEY,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET, lightTheme, type ThemeTokens } from '@ui/theme/tokens';
import { createTestDb } from '../support/testDb';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

const TOKENS = { mode: 'dark', color: { tint: '#FF0000' } } as unknown as ThemeTokens;

async function openTestContext() {
  const t = await createTestDb();
  mockGetDatabase.mockReturnValue(t.db);
  return t;
}

async function openTestDb() {
  return (await openTestContext()).db;
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

  it('loads an enabled persisted preset key', async () => {
    const db = await openTestDb();
    await kvSet(db, THEME_PREF_KEY, 'gator');
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ preset: 'gator', hydrated: true });
  });

  it('contains a persisted disabled/light preset by selecting the dark default in memory', async () => {
    const db = await openTestDb();
    await kvSet(db, THEME_PREF_KEY, 'ios-light');
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ preset: DEFAULT_PRESET, hydrated: true });
    // Containment is reversible: hydration does not rewrite the stored THEME-01B groundwork.
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('ios-light');
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

  it('keeps a legacy light custom theme stored but does not activate it', async () => {
    const db = await openTestDb();
    const id = await createCustomTheme(db, {
      name: 'Saved light',
      mode: 'light',
      tokens: JSON.stringify(lightTheme),
    });
    await kvSet(db, THEME_CUSTOM_KEY, String(id));
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({
      preset: DEFAULT_PRESET,
      customThemeId: null,
      customTokens: null,
      hydrated: true,
    });
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe(String(id));
  });

  it('marks hydrated even when the DB is not open (ThemeProvider must not wait forever)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    await useThemeStore.getState().hydrate();
    expect(useThemeStore.getState()).toMatchObject({ preset: DEFAULT_PRESET, hydrated: true });
  });

  it('does not commit a late theme read after hydration ownership is revoked', async () => {
    const db = await openTestDb();
    await kvSet(db, THEME_PREF_KEY, 'gator');
    let current = true;
    const onError = jest.fn();

    const pending = useThemeStore.getState().hydrate({
      shouldCommit: () => current,
      onError,
    });
    current = false;
    await pending;

    expect(useThemeStore.getState()).toMatchObject({
      preset: DEFAULT_PRESET,
      customThemeId: null,
      customTokens: null,
      hydrated: false,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not open the theme gate or report an error for a retired failed read', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    const onError = jest.fn();

    await useThemeStore.getState().hydrate({ shouldCommit: () => false, onError });

    expect(useThemeStore.getState().hydrated).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an active failed read while preserving the safe first-paint fallback', async () => {
    const error = new Error('Database not initialized');
    mockGetDatabase.mockImplementation(() => {
      throw error;
    });
    const onError = jest.fn();

    await useThemeStore.getState().hydrate({ onError });

    expect(onError).toHaveBeenCalledWith(error);
    expect(useThemeStore.getState().hydrated).toBe(true);
  });
});

describe('themeStore setters', () => {
  it('queues a standalone KV write behind a rolling-back neighbour', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, THEME_PREF_KEY, 'nord');

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run('phantom', THEME_PREF_KEY);
      neighbourStarted();
      await held;
      throw new Error('neighbour rollback');
    });
    await started;

    let writeSettled = false;
    const write = kvSet(db, THEME_PREF_KEY, 'gator').finally(() => {
      writeSettled = true;
    });
    await Promise.resolve();

    expect(writeSettled).toBe(false);
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(THEME_PREF_KEY)).toEqual({
      value: 'phantom',
    });

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await write;
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('gator');
  });

  it('rolls back both persisted keys when a preset switch cannot clear the custom pointer', async () => {
    const { db, raw } = await openTestContext();
    await kvSet(db, THEME_PREF_KEY, 'nord');
    await kvSet(db, THEME_CUSTOM_KEY, '7');
    raw.exec(`
      CREATE TRIGGER reject_theme_custom_clear
      BEFORE UPDATE OF value ON kv
      WHEN OLD.key = '${THEME_CUSTOM_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'forced custom-theme clear failure');
      END
    `);

    await useThemeStore.getState().setPreset('gator');

    // The optimistic in-memory choice still applies for this session, but persistence is all-or-none.
    expect(useThemeStore.getState()).toMatchObject({
      preset: 'gator',
      customThemeId: null,
      customTokens: null,
    });
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('nord');
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe('7');
  });

  it('setPreset clears any active custom theme and persists both keys', async () => {
    const db = await openTestDb();
    useThemeStore.setState({ customThemeId: 3, customTokens: TOKENS });
    await useThemeStore.getState().setPreset('gator');
    expect(useThemeStore.getState()).toMatchObject({
      preset: 'gator',
      customThemeId: null,
      customTokens: null,
    });
    expect(await kvGet(db, THEME_PREF_KEY)).toBe('gator');
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe('');
  });

  it('normalizes a disabled/light preset request to the dark default', async () => {
    const db = await openTestDb();
    await useThemeStore.getState().setPreset('ios-light');
    expect(useThemeStore.getState().preset).toBe(DEFAULT_PRESET);
    expect(await kvGet(db, THEME_PREF_KEY)).toBe(DEFAULT_PRESET);
  });

  it('setCustomTheme applies optimistically and persists the id', async () => {
    const db = await openTestDb();
    await useThemeStore.getState().setCustomTheme(7, TOKENS);
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: 7, customTokens: TOKENS });
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBe('7');
  });

  it('rejects a light custom theme without changing or persisting the active selection', async () => {
    const db = await openTestDb();
    await expect(useThemeStore.getState().setCustomTheme(8, lightTheme)).rejects.toThrow(
      'dark-only',
    );
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: null, customTokens: null });
    expect(await kvGet(db, THEME_CUSTOM_KEY)).toBeNull();
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

  it('reloadCustomTokens stops applying an edited theme if it becomes light', async () => {
    const db = await openTestDb();
    const id = await createCustomTheme(db, {
      name: 'Mine',
      mode: 'dark',
      tokens: JSON.stringify(TOKENS),
    });
    useThemeStore.setState({ customThemeId: id, customTokens: TOKENS });
    const { updateCustomTheme } = await import('@db/repositories');
    await updateCustomTheme(db, id, {
      name: 'Mine',
      mode: 'light',
      tokens: JSON.stringify(lightTheme),
    });
    await useThemeStore.getState().reloadCustomTokens();
    expect(useThemeStore.getState()).toMatchObject({ customThemeId: null, customTokens: null });
  });
});
