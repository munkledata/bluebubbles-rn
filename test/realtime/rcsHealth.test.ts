import {
  deriveRcsHealth,
  deriveRcsHealthFromStatus,
  RCS_ALERT_TYPES,
  type RcsStatusSnapshot,
} from '@core/realtime';

describe('deriveRcsHealth', () => {
  it('reports off when the bridge is disabled (ignores any stale alert)', () => {
    expect(deriveRcsHealth(false, null)).toEqual({ severity: 'off', status: 'Off' });
    expect(deriveRcsHealth(false, RCS_ALERT_TYPES.gaiaLoggedOut)).toEqual({
      severity: 'off',
      status: 'Off',
    });
  });

  it('is healthy when enabled with no alert seen', () => {
    const h = deriveRcsHealth(true, null);
    expect(h.severity).toBe('ok');
    expect(h.status).toBe('Connected');
    expect(h.detail).toBeUndefined();
  });

  it('surfaces expired cookies as an error pointing at the dashboard re-auth', () => {
    const h = deriveRcsHealth(true, RCS_ALERT_TYPES.gaiaLoggedOut);
    expect(h.severity).toBe('error');
    expect(h.detail).toMatch(/re-authenticate on the server dashboard/i);
  });

  it('treats a fatal listen error as an error too', () => {
    expect(deriveRcsHealth(true, RCS_ALERT_TYPES.listenFatal).severity).toBe('error');
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

describe('deriveRcsHealthFromStatus', () => {
  const connected: RcsStatusSnapshot = {
    enabled: true,
    running: true,
    paired: true,
    connected: true,
    phoneResponding: true,
    state: 'running',
  };

  it('reports off when the bridge is disabled', () => {
    expect(deriveRcsHealthFromStatus({ enabled: false, state: 'disabled' })).toEqual({
      severity: 'off',
      status: 'Off',
    });
  });

  it('is healthy (Connected) when paired + connected', () => {
    const h = deriveRcsHealthFromStatus(connected);
    expect(h.severity).toBe('ok');
    expect(h.status).toBe('Connected');
  });

  it('surfaces paired-but-not-connected as an auth-expired error pointing at the dashboard', () => {
    const h = deriveRcsHealthFromStatus({ ...connected, connected: false });
    expect(h.severity).toBe('error');
    expect(h.status).toBe('Disconnected');
    expect(h.detail).toMatch(/re-authenticate on the server dashboard/i);
  });

  it('surfaces phone offline when phoneResponding is false', () => {
    const h = deriveRcsHealthFromStatus({ ...connected, phoneResponding: false });
    expect(h.severity).toBe('warn');
    expect(h.status).toBe('Phone offline');
  });

  it('reports Starting when state is starting (even if not yet connected)', () => {
    const h = deriveRcsHealthFromStatus({ ...connected, state: 'starting', connected: false });
    expect(h.severity).toBe('warn');
    expect(h.status).toBe('Starting');
  });

  it('reports Not paired when enabled but unpaired', () => {
    const h = deriveRcsHealthFromStatus({
      enabled: true,
      running: true,
      paired: false,
      connected: false,
      phoneResponding: true,
      state: 'running',
    });
    expect(h.severity).toBe('warn');
    expect(h.status).toBe('Not paired');
  });

  it('REAUTH-RECOVERY: a stale block.lastAlert does NOT override connected=true', () => {
    // After a dashboard re-auth the refetched block reports connected=true; a lingering
    // GAIA_LOGGED_OUT in the block must NOT force Disconnected.
    const h = deriveRcsHealthFromStatus({
      ...connected,
      lastAlert: RCS_ALERT_TYPES.gaiaLoggedOut,
    });
    expect(h.severity).toBe('ok');
    expect(h.status).toBe('Connected');
  });

  it('immediacy override: a FRESH socket alert reflects at once over a healthy block', () => {
    const h = deriveRcsHealthFromStatus(connected, RCS_ALERT_TYPES.gaiaLoggedOut);
    expect(h.severity).toBe('error');
    expect(h.status).toBe('Disconnected');
  });

  it('a benign/recovery override falls through to the block (stays Connected)', () => {
    const h = deriveRcsHealthFromStatus(connected, RCS_ALERT_TYPES.browserActive);
    expect(h.severity).toBe('ok');
    expect(h.status).toBe('Connected');
  });
});
