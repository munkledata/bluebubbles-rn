import { formatUpdatedAgo } from '@utils/relativeTime';

describe('formatUpdatedAgo', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();

  it.each([
    [now - 10_000, 'Updated just now'],
    [now + 30_000, 'Updated just now'], // Mac clock a little ahead
    [now - 5 * 60_000, 'Updated 5 min ago'],
    [now - 59 * 60_000, 'Updated 59 min ago'],
    [now - 3 * 3_600_000, 'Updated 3 h ago'],
    [now - 30 * 3_600_000, 'Updated yesterday'],
    [new Date(2026, 2, 3, 9, 0).getTime(), 'Updated Mar 3'],
    [new Date(2025, 11, 24, 9, 0).getTime(), 'Updated Dec 24, 2025'],
  ])('%p reads as %p', (time, text) => {
    expect(formatUpdatedAgo(time, now)).toBe(text);
  });

  it.each([[null], [undefined], [0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'shows nothing for %p',
    (time) => {
      expect(formatUpdatedAgo(time, now)).toBeNull();
    },
  );
});
