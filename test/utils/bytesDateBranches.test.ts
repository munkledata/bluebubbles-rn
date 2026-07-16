/**
 * Branch top-ups for utils: the date helpers `formatTime` / `formatSeparatorDate` (uncovered by
 * formatters.test.ts, which only exercises `formatChatDate`) and a couple of base64 edge cases.
 */
import { formatTime, formatSeparatorDate } from '@utils/date';
import { fromBase64, toBase64 } from '@utils/bytes';

// Fixed "now": Wed 2024-01-17 12:00 local.
const NOW = new Date(2024, 0, 17, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).getTime();

describe('formatTime', () => {
  it('returns empty for null/0', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(0)).toBe('');
  });

  it('formats a real timestamp as a time-only label', () => {
    expect(formatTime(at(2024, 0, 17, 14, 5))).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('formatSeparatorDate', () => {
  it('returns empty for null/0', () => {
    expect(formatSeparatorDate(null, NOW)).toBe('');
    expect(formatSeparatorDate(0, NOW)).toBe('');
  });

  it('prefixes same-day timestamps with "Today"', () => {
    const out = formatSeparatorDate(at(2024, 0, 17, 9, 5), NOW);
    expect(out).toMatch(/^Today /);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows a weekday + date + time for an earlier day', () => {
    const out = formatSeparatorDate(at(2024, 0, 10, 9, 5), NOW);
    expect(out).not.toMatch(/Today/);
    expect(out).toMatch(/Jan/); // month present
    expect(out).toMatch(/,/); // "<Weekday, Mon D>, <time>"
  });
});

describe('base64 edge cases', () => {
  it('toBase64 of an empty array is the empty string', () => {
    expect(toBase64(new Uint8Array())).toBe('');
  });

  it('fromBase64 ignores whitespace/newlines in the input', () => {
    const clean = Buffer.from('hi gator', 'utf8').toString('base64');
    const noisy = clean.slice(0, 4) + '\n  ' + clean.slice(4);
    expect(Buffer.from(fromBase64(noisy)).toString('utf8')).toBe('hi gator');
  });
});
