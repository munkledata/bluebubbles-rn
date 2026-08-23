const kvGet = jest.fn<Promise<string | null>, [unknown, string]>();

jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@db/repositories', () => ({
  kvGet,
  kvSet: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first -- import after the hoisted repository mock
import { useSyncSettingsStore } from '@state/syncSettingsStore';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  kvGet.mockReset();
  useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
});

it.each([
  [
    'sync settings',
    () => useSyncSettingsStore.getState().hydrate,
    () => useSyncSettingsStore.getState(),
    '250',
  ],
] as const)(
  'does not commit a late %s read after boot ownership is revoked',
  async (_label, hydrate, state, raw) => {
    const read = deferred<string | null>();
    kvGet.mockReturnValueOnce(read.promise);
    let current = true;
    const onError = jest.fn();

    const pending = hydrate()({ shouldCommit: () => current, onError });
    await Promise.resolve();
    current = false;
    read.resolve(raw);
    await pending;

    expect(state()).toMatchObject({ messagesPerChat: 0, hydrated: false });
    expect(onError).not.toHaveBeenCalled();
  },
);

it.each([['sync settings', () => useSyncSettingsStore.getState().hydrate]] as const)(
  'reports an active %s read failure without rejecting',
  async (_label, hydrate) => {
    const error = new Error('settings database unavailable');
    const onError = jest.fn();
    kvGet.mockRejectedValueOnce(error);

    await expect(hydrate()({ onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  },
);
