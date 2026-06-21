import { useLockStore } from '@state/lockStore';

describe('lockStore', () => {
  beforeEach(() =>
    useLockStore.setState({
      enabled: false,
      locked: false,
      hydrated: false,
      lastBackgrounded: null,
      timeoutMs: 30_000,
    }),
  );

  it('hydrate(true) starts LOCKED (lock-on-launch) so the DB key stays withheld', () => {
    useLockStore.getState().hydrate(true);
    expect(useLockStore.getState()).toMatchObject({ enabled: true, hydrated: true, locked: true });
  });

  it('hydrate(false) leaves the app unlocked', () => {
    useLockStore.getState().hydrate(false);
    expect(useLockStore.getState()).toMatchObject({
      enabled: false,
      hydrated: true,
      locked: false,
    });
  });

  it('disabling clears the gate so the user is never stuck behind it', () => {
    useLockStore.getState().hydrate(true);
    expect(useLockStore.getState().locked).toBe(true);
    useLockStore.getState().setEnabled(false);
    expect(useLockStore.getState()).toMatchObject({ enabled: false, locked: false });
  });

  it('unlock clears the backgrounded marker', () => {
    useLockStore.getState().noteBackgrounded(123);
    useLockStore.getState().lock();
    expect(useLockStore.getState().locked).toBe(true);
    useLockStore.getState().unlock();
    expect(useLockStore.getState()).toMatchObject({ locked: false, lastBackgrounded: null });
  });
});
