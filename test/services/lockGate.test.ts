import { effectivelyLocked } from '@/services/notifications/lockGate';

describe('effectivelyLocked (headless push lock gate)', () => {
  const live = {
    enabled: true,
    hydrated: true,
    locked: false,
    lastBackgrounded: 1_000,
    timeoutMs: 30_000,
  };

  it('trusts a live lock within its background grace period', () => {
    expect(effectivelyLocked(live, true, 30_999)).toBe(false);
    // foreground-locked session → no content
    expect(effectivelyLocked({ ...live, locked: true }, false, 2_000)).toBe(true);
  });

  it('enforces timeout expiry while the app is still backgrounded', () => {
    expect(effectivelyLocked(live, true, 31_000)).toBe(true);
    expect(effectivelyLocked({ ...live, lastBackgrounded: null }, true, 999_000)).toBe(false);
  });

  it('does not apply a stale background timestamp when App Lock is disabled', () => {
    expect(effectivelyLocked({ ...live, enabled: false }, false, Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
  });

  it('falls back to the persisted setting on a fresh headless/killed wake', () => {
    const fresh = {
      enabled: false,
      hydrated: false,
      locked: false,
      lastBackgrounded: null,
      timeoutMs: 30_000,
    };
    // store at defaults (not hydrated): app-lock ON → treat as locked
    expect(effectivelyLocked(fresh, true, 10_000)).toBe(true);
    // app-lock OFF → deliver normally
    expect(effectivelyLocked(fresh, false, 10_000)).toBe(false);
  });
});
