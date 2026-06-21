/**
 * Socket robustness pure helpers (Phase 1.1 + 1.2).
 *
 * These cover the two node-testable pieces extracted from SocketService:
 *  - nextSocketBackoffMs: the capped-exponential reconnect-escalation schedule
 *    (monotonic up to the cap, then pinned at the cap; jitter stays bounded).
 *  - shouldLogSocketError: the (host, code, message) error-log throttle decision
 *    (first occurrence logs, repeat within the 60s window suppressed, repeat after
 *    the window logs again).
 */
import {
  nextSocketBackoffMs,
  shouldLogSocketError,
  socketErrorKey,
  type SocketErrorSignature,
} from '@/services/realtime/socketService';

describe('nextSocketBackoffMs (reconnect escalation schedule)', () => {
  // Pin jitter to 0 so the base schedule is deterministic and easy to assert.
  const noJitter = (): number => 0;

  it('grows exponentially from a 1s base (base * 2^attempt)', () => {
    expect(nextSocketBackoffMs(0, noJitter)).toBe(1_000);
    expect(nextSocketBackoffMs(1, noJitter)).toBe(2_000);
    expect(nextSocketBackoffMs(2, noJitter)).toBe(4_000);
    expect(nextSocketBackoffMs(3, noJitter)).toBe(8_000);
  });

  it('is monotonically non-decreasing across attempts (with jitter at zero)', () => {
    let prev = -1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = nextSocketBackoffMs(attempt, noJitter);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  it('caps at ~60s no matter how high the attempt count climbs', () => {
    expect(nextSocketBackoffMs(6, noJitter)).toBe(60_000); // 64s would exceed → capped
    expect(nextSocketBackoffMs(20, noJitter)).toBe(60_000);
    expect(nextSocketBackoffMs(1_000, noJitter)).toBe(60_000);
  });

  it('adds bounded positive jitter (never below base, at most +10%)', () => {
    // Max jitter (rand → 1) adds 10%; min jitter (rand → 0) adds nothing.
    expect(nextSocketBackoffMs(2, () => 1)).toBe(4_400); // 4000 + 10%
    expect(nextSocketBackoffMs(2, () => 0)).toBe(4_000);
    // Real Math.random output is always within [base, base*1.1].
    for (let i = 0; i < 50; i += 1) {
      const d = nextSocketBackoffMs(2);
      expect(d).toBeGreaterThanOrEqual(4_000);
      expect(d).toBeLessThanOrEqual(4_400);
    }
  });

  it('treats negative / fractional attempts safely (clamped, floored)', () => {
    expect(nextSocketBackoffMs(-5, noJitter)).toBe(1_000);
    expect(nextSocketBackoffMs(1.9, noJitter)).toBe(2_000); // floored to attempt 1
  });
});

describe('shouldLogSocketError (60s log throttle)', () => {
  const sig: SocketErrorSignature = {
    host: 'srv.example.com',
    code: 'ECONNREFUSED',
    message: 'connection refused',
  };

  it('logs the first occurrence of a signature', () => {
    const seen = new Map<string, number>();
    expect(shouldLogSocketError(sig, 1_000, seen)).toBe(true);
  });

  it('suppresses a repeat within the 60s window', () => {
    const seen = new Map<string, number>([[socketErrorKey(sig), 1_000]]);
    expect(shouldLogSocketError(sig, 1_000 + 59_999, seen)).toBe(false);
    expect(shouldLogSocketError(sig, 1_000 + 30_000, seen)).toBe(false);
  });

  it('logs again once the 60s window has elapsed', () => {
    const seen = new Map<string, number>([[socketErrorKey(sig), 1_000]]);
    expect(shouldLogSocketError(sig, 1_000 + 60_000, seen)).toBe(true);
    expect(shouldLogSocketError(sig, 1_000 + 120_000, seen)).toBe(true);
  });

  it('treats a different (host, code, message) as a distinct signature', () => {
    const seen = new Map<string, number>([[socketErrorKey(sig), 1_000]]);
    const otherHost: SocketErrorSignature = { ...sig, host: 'other.example.com' };
    const otherCode: SocketErrorSignature = { ...sig, code: 'ETIMEDOUT' };
    const otherMsg: SocketErrorSignature = { ...sig, message: 'timed out' };
    expect(shouldLogSocketError(otherHost, 1_500, seen)).toBe(true);
    expect(shouldLogSocketError(otherCode, 1_500, seen)).toBe(true);
    expect(shouldLogSocketError(otherMsg, 1_500, seen)).toBe(true);
  });

  it('records-then-suppresses when the caller writes the timestamp back', () => {
    // Mirrors SocketService.logSocketError: log → record now → next call suppressed.
    const seen = new Map<string, number>();
    const now = 5_000;
    expect(shouldLogSocketError(sig, now, seen)).toBe(true);
    seen.set(socketErrorKey(sig), now); // caller records on log
    expect(shouldLogSocketError(sig, now + 10_000, seen)).toBe(false); // within window
    expect(shouldLogSocketError(sig, now + 60_000, seen)).toBe(true); // window elapsed
  });
});
