/**
 * Pure mapping for the RCS-bridge (Google Messages) health surface. React-free + Node-testable so
 * it can live in `core/` and back the Server Health screen.
 *
 * The app cannot read the sidecar's rich `/status` block: the server's `rcs-status` operation is
 * `adminOnly` (loopback dashboard only — a remote password-authed client gets 403), so the only
 * app-reachable RCS signals are (1) the `ServerInfo.rcs` capability boolean and (2) the live
 * `rcs-alert` socket event, whose `alertType` this maps to a severity + user-facing copy. The
 * cookie re-auth that fixes an expired session happens on the Mac dashboard (a Firefox cookie
 * paste), so the actionable message points there — the phone app cannot perform the fix.
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
 * - auth expired / fatal listen error → `error`, pointing at the dashboard re-auth (the phone
 *   cannot fix it).
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
 * alert (which leaves the bridge looking healthy). Shared by the alert-only `deriveRcsHealth`
 * fallback and the richer `deriveRcsHealthFromStatus`.
 */
function mapAlert(alertType: string | null | undefined): RcsHealthDisplay | null {
  switch (alertType) {
    case RCS_ALERT_TYPES.gaiaLoggedOut:
    case RCS_ALERT_TYPES.listenFatal:
      return {
        severity: 'error',
        status: 'Disconnected',
        detail: 'RCS bridge disconnected — re-authenticate on the server dashboard.',
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

/**
 * The non-admin `get-rcs-status` block (from the server's `get-rcs-status` admin-command channel).
 * All fields optional/nullish so a version-skewed server degrades instead of throwing.
 */
export interface RcsStatusSnapshot {
  enabled?: boolean | null;
  running?: boolean | null;
  paired?: boolean | null;
  connected?: boolean | null;
  phoneResponding?: boolean | null;
  state?: string | null;
  phoneID?: string | null;
  browserActive?: boolean | null;
  lastAlert?: string | null;
  /**
   * Why the sidecar child last exited, when the server knows (`state:'failed'`). Server-authored
   * and safe to display — it never carries credentials.
   */
  error?: string | null;
}

/**
 * Derive the Server Health RCS row from the RICH `get-rcs-status` block — the accurate source of
 * truth for enabled / paired / connected / phoneResponding — with an optional FRESH `rcs-alert`
 * socket signal (`liveAlertType`) as an immediacy override so a just-arrived alert updates the card
 * between refetches.
 *
 * REAUTH-RECOVERY: the boolean flags win over any stale alert. When a refetch reports
 * `connected===true`, the row shows "Connected" even if a prior `GAIA_LOGGED_OUT` (from the socket
 * store OR the block's own `lastAlert`) is still around — so after a dashboard cookie re-auth the
 * card recovers on the next refetch WITHOUT needing a recovery alert (the old alert-only limitation).
 *
 * Order: disabled → fresh socket alert (override) → starting → disconnected/auth-expired →
 * phone offline → browser idle → connected → not-paired → healthy default.
 * The caller passes `liveAlertType` ONLY when the socket alert is newer than this fetch (otherwise a
 * stale alert would defeat the recovery above).
 */
export function deriveRcsHealthFromStatus(
  s: RcsStatusSnapshot,
  liveAlertType?: string | null,
): RcsHealthDisplay {
  if (!s.enabled) return { severity: 'off', status: 'Off' };

  // A fresh socket alert (immediacy override) — reflect it at once, even if the last fetched block
  // still looked healthy. Benign/recovery alerts return null and fall through to the block.
  if (liveAlertType) {
    const overridden = mapAlert(liveAlertType);
    if (overridden) return overridden;
  }

  // The sidecar process itself is failing to start. This MUST be checked before the
  // `running === false` branch below, or a crash-looping bridge renders as the reassuring
  // "Starting…" forever — which is exactly what this surface told the user for four days
  // during the 2026-07-23 outage while the supervisor had long since given up.
  if (s.state === 'failed' && s.running === false) {
    return {
      severity: 'error',
      status: 'Not running',
      detail: s.error
        ? `RCS bridge keeps failing to start (${s.error}) — check the server dashboard.`
        : 'RCS bridge keeps failing to start — check the server dashboard.',
    };
  }

  // Starting / not yet running.
  if (s.state === 'starting' || s.running === false) {
    return { severity: 'warn', status: 'Starting', detail: 'RCS bridge is starting…' };
  }

  // Disconnected / auth-expired: paired but the connection is down. Points at the dashboard
  // re-auth (the phone can't fix a Google cookie expiry).
  if (s.paired && s.connected === false) {
    return {
      severity: 'error',
      status: 'Disconnected',
      detail: 'RCS bridge disconnected — re-authenticate on the server dashboard.',
    };
  }

  // Phone offline — the paired Android phone must be online.
  if (s.phoneResponding === false) {
    return {
      severity: 'warn',
      status: 'Phone offline',
      detail: 'Phone not responding — your Android phone must be online.',
    };
  }

  // Paired + connected → healthy (booleans win over any stale block.lastAlert → recovery resolved).
  if (s.paired && s.connected) return { severity: 'ok', status: 'Connected' };

  // Enabled but not yet paired — pair Google Messages on the dashboard.
  if (s.paired === false) {
    return {
      severity: 'warn',
      status: 'Not paired',
      detail: 'RCS bridge is not paired — pair Google Messages on the server dashboard.',
    };
  }

  // Flags indeterminate (version skew): fall back to the block's own lastAlert. With no alert
  // either, say Unknown — a green "Connected" derived from missing fields is the same
  // false-green as the alert-only path above.
  const mapped = mapAlert(s.lastAlert);
  if (mapped) return mapped;
  if (s.lastAlert) return { severity: 'ok', status: 'Connected' };
  return {
    severity: 'warn',
    status: 'Unknown',
    detail: 'The server did not report a usable RCS bridge state.',
  };
}
