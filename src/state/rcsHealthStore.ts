import { create } from 'zustand';

/**
 * Holds the most-recent Gator RCS-bridge (`rcs-alert`) alert so the Server Health screen can show
 * whether the bridge is healthy, phone-offline, or disconnected (cookies expired). This is the
 * app's ONLY live RCS-health signal: the sidecar's rich `/status` block is admin-only (loopback
 * dashboard), so a remote app can't poll it — it learns of bridge trouble from these socket alerts.
 *
 * Latest-alert-wins: a recovery alert (e.g. PHONE_RESPONDING_AGAIN, BROWSER_ACTIVE) overwrites a
 * prior warning, which `deriveRcsHealth` maps back to healthy. Best-effort + ephemeral (not
 * persisted): a fresh connection starts from "no alert seen" = healthy.
 */
interface RcsHealthState {
  /** The `alertType` from the last `rcs-alert` event, or null if none seen this session. */
  lastAlertType: string | null;
  /** When the last alert arrived (ms epoch), for potential future staleness display. */
  lastAlertAt: number | null;
  /** Apply an incoming `rcs-alert`. */
  setAlert: (alertType: string | null | undefined) => void;
}

export const useRcsHealthStore = create<RcsHealthState>((set) => ({
  lastAlertType: null,
  lastAlertAt: null,
  setAlert: (alertType) => set({ lastAlertType: alertType ?? null, lastAlertAt: Date.now() }),
}));
