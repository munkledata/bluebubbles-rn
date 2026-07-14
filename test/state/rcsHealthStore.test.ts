import { useRcsHealthStore } from '@state/rcsHealthStore';

describe('rcsHealthStore', () => {
  beforeEach(() => useRcsHealthStore.setState({ lastAlertType: null, lastAlertAt: null }));

  it('starts with no alert seen (= healthy)', () => {
    expect(useRcsHealthStore.getState()).toMatchObject({ lastAlertType: null, lastAlertAt: null });
  });

  it('records an alert with its arrival time', () => {
    useRcsHealthStore.getState().setAlert('PHONE_NOT_RESPONDING');
    const s = useRcsHealthStore.getState();
    expect(s.lastAlertType).toBe('PHONE_NOT_RESPONDING');
    expect(typeof s.lastAlertAt).toBe('number');
  });

  it('latest alert wins — a recovery overwrites a prior warning', () => {
    useRcsHealthStore.getState().setAlert('PHONE_NOT_RESPONDING');
    useRcsHealthStore.getState().setAlert('PHONE_RESPONDING_AGAIN');
    expect(useRcsHealthStore.getState().lastAlertType).toBe('PHONE_RESPONDING_AGAIN');
  });

  it('coerces a missing alertType to null (not undefined)', () => {
    useRcsHealthStore.getState().setAlert(undefined);
    expect(useRcsHealthStore.getState().lastAlertType).toBeNull();
  });
});
