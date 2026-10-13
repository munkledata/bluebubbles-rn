/**
 * Pure mapping for the RCS-bridge (Google Messages) health surface. React-free + Node-testable so
 * it can live in `core/` and back the Server Health screen.
 *
 * The app cannot read the sidecar's rich `/status` block: the server's `rcs-status` operation is
 * `adminOnly` (loopback dashboard only — a remote password-authed client gets 403), so the only
 * app-reachable RCS signals are (1) the `ServerInfo.rcs` capability boolean and (2) the live
 * `rcs-alert` socket event, whose `alertType` this maps to a severity + user-facing copy. The
 * phone never receives Google credentials. When the server advertises RCS support, the Health
 * screen can ask the server to re-authenticate with its own Firefox cookies; fatal startup and
 * pairing work still belongs on the Mac dashboard.
 */

/** Severity buckets, aligned with the Server Health status colours (ok / warn / error / off). */
export type RcsSeverity = 'ok' | 'warn' | 'error' | 'off';

export interface RcsHealthDisplay {
  severity: RcsSeverity;
  /** Short status word for the row value (e.g. "Connected", "Disconnected"). */
  status: string;
  /** Optional actionable one-liner shown under the row. */
  detail?: string;
}

/**
 * The `rcs-alert` socket payload the app receives (from the sidecar via bbd's RcsListener):
 * `{ kind: 'alert', alertType: '<NAME>' }`. Only `alertType` is load-bearing here.
 */
export const RCS_ALERT_TYPES = {
  gaiaLoggedOut: 'GAIA_LOGGED_OUT',
  listenFatal: 'LISTEN_FATAL_ERROR',
  phoneNotResponding: 'PHONE_NOT_RESPONDING',
  phoneRespondingAgain: 'PHONE_RESPONDING_AGAIN',
  browserInactive: 'BROWSER_INACTIVE',
  browserInactiveTimeout: 'BROWSER_INACTIVE_FROM_TIMEOUT',
  browserInactiveInactivity: 'BROWSER_INACTIVE_FROM_INACTIVITY',
  browserActive: 'BROWSER_ACTIVE',
} as const;

/**
 * Derive the Server Health RCS row from the capability flag + the most-recent `rcs-alert`.
 * This is the DEGRADED path — used only when the rich `get-rcs-status` block is unavailable
 * (older server, or the fetch failed).
 *
 * - `enabled=false` → `off` ("RCS bridge: off").
 * - auth expired → `error`, pointing at the in-app server-owned re-auth action.
 * - fatal listen error → `error`, pointing at the dashboard for diagnosis.
 * - phone not responding → `warn` (the Android phone must be online).
 * - browser inactive → `warn` (the bridge idled; it should reconnect on its own).
 * - a benign/recovery alert (phone-responding-again, browser-active, battery-low, an unknown
 *   future alert, …) → `ok`. An alert ARRIVING is itself evidence the bridge's event stream is
 *   alive, so this is information, not an assumption. Latest-alert-wins: a recovery alert
 *   naturally clears a prior warning.
 * - NO alert at all → `Unknown`, NOT "Connected".
 *
 * That last case is the fix for a real false-green: the row used to render a confident green
 * "Connected" in the exact situation where the app knows NOTHING — the status fetch failed and
 * no alert has ever arrived. During the 2026-07-23 outage the bridge was stone dead for four
 * days while this surface said Connected, because the alert that would have corrected it is
 * delivered over the very stream that was down. Absence of bad news is not good news.
 */
export function deriveRcsHealth(
  enabled: boolean,
  lastAlertType: string | null | undefined,
): RcsHealthDisplay {
  if (!enabled) return { severity: 'off', status: 'Off' };
  const mapped = mapAlert(lastAlertType);
  if (mapped) return mapped;
  // A benign/recovery alert still proves the stream is alive → genuinely healthy.
  if (lastAlertType) return { severity: 'ok', status: 'Connected' };
  return {
    severity: 'warn',
    status: 'Unknown',
    detail: 'Could not read RCS bridge status from the server.',
  };
}

/**
 * Map a single `rcs-alert` alertType to its health display, or `null` for a benign/recovery/unknown
 * alert (which leaves the bridge looking healthy). Used by `deriveRcsHealth`.
 */
function mapAlert(alertType: string | null | undefined): RcsHealthDisplay | null {
  switch (alertType) {
    case RCS_ALERT_TYPES.gaiaLoggedOut:
      return {
        severity: 'error',
        status: 'Disconnected',
        detail: 'RCS bridge disconnected — tap Re-authenticate below.',
      };
    case RCS_ALERT_TYPES.listenFatal:
      return {
        severity: 'error',
        status: 'Disconnected',
        detail: 'RCS bridge stopped unexpectedly — check the server dashboard.',
      };
    case RCS_ALERT_TYPES.phoneNotResponding:
      return {
        severity: 'warn',
        status: 'Phone offline',
        detail: 'Phone not responding — your Android phone must be online.',
      };
    case RCS_ALERT_TYPES.browserInactive:
    case RCS_ALERT_TYPES.browserInactiveTimeout:
    case RCS_ALERT_TYPES.browserInactiveInactivity:
      return {
        severity: 'warn',
        status: 'Reconnecting',
        detail: 'RCS bridge went idle — it should reconnect automatically.',
      };
    default:
      return null;
  }
}
