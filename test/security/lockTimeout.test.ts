import { isLockExpired } from '@core/security/lockTimeout';

describe('isLockExpired', () => {
  it('never expires when never backgrounded this session', () => {
    expect(isLockExpired(null, 1000, 30_000)).toBe(false);
  });

  it('expires once the grace period has fully elapsed', () => {
    expect(isLockExpired(0, 31_000, 30_000)).toBe(true);
  });

  it('does not expire within the grace period', () => {
    expect(isLockExpired(0, 1_000, 30_000)).toBe(false);
  });

  it('treats the exact boundary as expired', () => {
    expect(isLockExpired(0, 30_000, 30_000)).toBe(true);
  });
});
