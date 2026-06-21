import { create } from 'zustand';

interface LockState {
  enabled: boolean; // user setting, persisted in the vault (default off)
  locked: boolean; // current gate state
  hydrated: boolean; // whether `enabled` has been read from the vault yet
  lastBackgrounded: number | null;
  timeoutMs: number; // grace period before a re-lock on resume
  /** Apply the persisted setting at boot. When enabled, start LOCKED (lock-on-launch). */
  hydrate: (enabled: boolean) => void;
  setEnabled: (v: boolean) => void;
  setTimeoutMs: (ms: number) => void;
  noteBackgrounded: (now: number) => void;
  lock: () => void;
  unlock: () => void;
}

/**
 * App-lock state. The gate is rendered at the ROOT layout (above the DB-opening
 * boot step) so a cold launch can withhold the SQLCipher key until the user
 * authenticates. Resume re-locking uses `isLockExpired`.
 */
export const useLockStore = create<LockState>((set) => ({
  enabled: false,
  locked: false,
  hydrated: false,
  lastBackgrounded: null,
  timeoutMs: 30_000,
  hydrate: (enabled) => set({ enabled, hydrated: true, locked: enabled }),
  // Enabling locks immediately; disabling clears the gate so the user isn't stuck.
  setEnabled: (v) => set(v ? { enabled: true } : { enabled: false, locked: false }),
  setTimeoutMs: (ms) => set({ timeoutMs: ms }),
  noteBackgrounded: (now) => set({ lastBackgrounded: now }),
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false, lastBackgrounded: null }),
}));
