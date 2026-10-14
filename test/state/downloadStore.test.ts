import { progressRatio, useDownloadStore } from '@state/downloadStore';

describe('progressRatio (pure)', () => {
  it('maps bytes to a clamped [0,1] ratio', () => {
    expect(progressRatio(50, 100)).toBe(0.5);
    expect(progressRatio(0, 100)).toBe(0);
    expect(progressRatio(150, 100)).toBe(1); // clamp over 100%
  });

  it('returns null (indeterminate) when the total is unknown', () => {
    expect(progressRatio(10, -1)).toBeNull(); // no Content-Length
    expect(progressRatio(10, 0)).toBeNull();
    expect(progressRatio(Number.NaN, 100)).toBeNull();
  });
});

describe('useDownloadStore', () => {
  beforeEach(() => useDownloadStore.getState().reset());

  it('transitions start → setProgress → finish', () => {
    const s = useDownloadStore.getState();
    s.start('g1');
    expect(useDownloadStore.getState().status['g1']).toBe('downloading');
    expect(useDownloadStore.getState().progress['g1']).toBe(0);

    s.setProgress('g1', 1, 4);
    expect(useDownloadStore.getState().progress['g1']).toBe(0.25);

    s.finish('g1');
    expect(useDownloadStore.getState().status['g1']).toBe('idle');
    expect(useDownloadStore.getState().progress['g1']).toBe(1);
  });

  it('fail flips status to error without touching others', () => {
    const s = useDownloadStore.getState();
    s.start('g2');
    s.fail('g2');
    expect(useDownloadStore.getState().status['g2']).toBe('error');
    expect(useDownloadStore.getState().status['g1']).not.toBe('error');
  });

  it('forgets one attachment so it reads as never tried, leaving the others', () => {
    const state = useDownloadStore.getState();
    state.start('quiet');
    state.setProgress('quiet', 1, 4);
    state.start('other');

    state.clear('quiet');

    expect(useDownloadStore.getState().status['quiet']).toBeUndefined();
    expect(useDownloadStore.getState().progress['quiet']).toBeUndefined();
    expect(useDownloadStore.getState().status['other']).toBe('downloading');
  });

  it('clears all account-scoped presentation state', () => {
    const state = useDownloadStore.getState();
    state.start('old-account-attachment');
    state.setProgress('old-account-attachment', 4, 10);

    state.reset();

    expect(useDownloadStore.getState().status).toEqual({});
    expect(useDownloadStore.getState().progress).toEqual({});
  });
});
