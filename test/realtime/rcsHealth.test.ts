import { deriveRcsHealth, RCS_ALERT_TYPES } from '@core/realtime';

describe('deriveRcsHealth', () => {
  it('reports off when the bridge is disabled (ignores any stale alert)', () => {
    expect(deriveRcsHealth(false, null)).toEqual({ severity: 'off', status: 'Off' });
    expect(deriveRcsHealth(false, RCS_ALERT_TYPES.gaiaLoggedOut)).toEqual({
      severity: 'off',
      status: 'Off',
    });
  });

  // NO-FALSE-GREEN. This path runs only when the rich status block is unavailable, so with no
  // alert either the app knows literally nothing about the bridge. It used to render a
  // confident green "Connected" there — and did so for the four days of the 2026-07-23 outage,
  // because the alert that would have corrected it travels over the stream that was down.
  it('reports Unknown — NOT Connected — when enabled with no information at all', () => {
    const h = deriveRcsHealth(true, null);
    expect(h.severity).toBe('warn');
    expect(h.status).toBe('Unknown');
    expect(h.detail).toMatch(/could not read/i);
  });

  it('still reports Connected when a benign alert proves the stream is alive', () => {
    // An alert ARRIVING is positive evidence, unlike silence.
    const h = deriveRcsHealth(true, RCS_ALERT_TYPES.browserActive);
    expect(h.severity).toBe('ok');
    expect(h.status).toBe('Connected');
  });

  it('surfaces expired cookies as an error pointing at the in-app re-auth action', () => {
    const h = deriveRcsHealth(true, RCS_ALERT_TYPES.gaiaLoggedOut);
    expect(h.severity).toBe('error');
    expect(h.detail).toMatch(/tap re-authenticate below/i);
  });

  it('keeps fatal listen errors directed to the server dashboard', () => {
    const h = deriveRcsHealth(true, RCS_ALERT_TYPES.listenFatal);
    expect(h.severity).toBe('error');
    expect(h.detail).toMatch(/check the server dashboard/i);
  });

  it('warns (phone offline) on PHONE_NOT_RESPONDING', () => {
    const h = deriveRcsHealth(true, RCS_ALERT_TYPES.phoneNotResponding);
    expect(h.severity).toBe('warn');
    expect(h.status).toBe('Phone offline');
    expect(h.detail).toMatch(/phone must be online/i);
  });

  it('warns (reconnecting) on any browser-inactive variant', () => {
    for (const t of [
      RCS_ALERT_TYPES.browserInactive,
      RCS_ALERT_TYPES.browserInactiveTimeout,
      RCS_ALERT_TYPES.browserInactiveInactivity,
    ]) {
      expect(deriveRcsHealth(true, t).severity).toBe('warn');
    }
  });

  it('clears back to healthy on a recovery / benign alert (latest-wins)', () => {
    expect(deriveRcsHealth(true, RCS_ALERT_TYPES.phoneRespondingAgain).severity).toBe('ok');
    expect(deriveRcsHealth(true, RCS_ALERT_TYPES.browserActive).severity).toBe('ok');
    expect(deriveRcsHealth(true, 'MOBILE_BATTERY_LOW').severity).toBe('ok');
    expect(deriveRcsHealth(true, 'SOME_UNKNOWN_FUTURE_ALERT').severity).toBe('ok');
  });
});

// ---- 2026-07-23 outage guards: a dead sidecar must never read as "Starting…" ----
