import { effectivelyLocked } from '@/services/notifications/lockGate';

describe('effectivelyLocked (headless push lock gate)', () => {
  it('trusts the live (hydrated) lock store', () => {
    // backgrounded-unlocked session → deliver content even though app-lock is on
    expect(effectivelyLocked({ hydrated: true, locked: false }, true)).toBe(false);
    // foreground-locked session → no content
    expect(effectivelyLocked({ hydrated: true, locked: true }, false)).toBe(true);
  });

  it('falls back to the persisted setting on a fresh headless/killed wake', () => {
    // store at defaults (not hydrated): app-lock ON → treat as locked
    expect(effectivelyLocked({ hydrated: false, locked: false }, true)).toBe(true);
    // app-lock OFF → deliver normally
    expect(effectivelyLocked({ hydrated: false, locked: false }, false)).toBe(false);
  });
});
