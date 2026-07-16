/**
 * pickFutureDateTime (src/ui/conversations/pickDateTime.ts): the two-step native date→time picker
 * used to schedule a message. It's a plain function (no React tree), but lives under
 * test/components so the RN import (`@react-native-community/datetimepicker`) resolves via jest-expo.
 *
 * This suite locks in the behavior derived from the source:
 *   - the two-step flow: it opens a `date` picker first (minimumDate = now), then a `time` picker
 *     seeded with the chosen date;
 *   - cancelling EITHER step (a dismissed dialog yields no date) resolves to null, and cancelling
 *     the date step never opens the time step;
 *   - a clearly-past minute resolves to null;
 *   - a comfortably-future pick resolves to the chosen epoch floored to the minute (seconds = 0);
 *   - the FUTURE-CLAMP rule (the AGENTS.md Notifee-TimestampTrigger gotcha): a pick landing in the
 *     CURRENT (already partly-elapsed) minute is bumped to STRICTLY now+60s, not the past-floored
 *     minute — so a scheduler/Notifee trigger never gets a now/past timestamp.
 *
 * In-file mock: `@react-native-community/datetimepicker` — drive `DateTimePickerAndroid.open`
 * directly (capture each call's config, invoke its onChange) so the flow runs without a native
 * dialog. Time is frozen with fake timers so the clamp math is deterministic.
 */
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';

jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));

// eslint-disable-next-line import/first
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

const openMock = DateTimePickerAndroid.open as unknown as jest.Mock;

// A frozen "now" 30s into the minute so the current-minute clamp is observable (a floor-to-:00
// pick of this minute lands in the past-of-now yet not before the minute boundary).
const NOW = new Date(2026, 6, 15, 12, 30, 30, 0); // 15 Jul 2026, 12:30:30 local

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

/** Config object handed to the Nth `DateTimePickerAndroid.open` call. */
function cfgOf(callIndex: number): {
  value: Date;
  mode: string;
  onChange: Function;
  is24Hour?: boolean;
  minimumDate?: Date;
} {
  return openMock.mock.calls[callIndex]![0];
}

describe('pickFutureDateTime — two-step flow', () => {
  it('opens a date picker first (minimumDate = now), then a time picker seeded with the date', async () => {
    const p = pickFutureDateTime();
    const dateCfg = cfgOf(0);
    expect(dateCfg.mode).toBe('date');
    expect(dateCfg.minimumDate).toBeInstanceOf(Date);

    const chosenDate = new Date(2026, 6, 17); // two days out
    dateCfg.onChange({ type: 'set' }, chosenDate);

    const timeCfg = cfgOf(1);
    expect(timeCfg.mode).toBe('time');
    expect(timeCfg.is24Hour).toBe(false);
    expect(timeCfg.value).toBe(chosenDate);

    timeCfg.onChange({ type: 'set' }, new Date(2026, 6, 17, 9, 15));
    await p;
  });

  it('resolves to the chosen epoch floored to the minute for a comfortably-future pick', async () => {
    const p = pickFutureDateTime();
    cfgOf(0).onChange({ type: 'set' }, new Date(2026, 6, 17));
    cfgOf(1).onChange({ type: 'set' }, new Date(2026, 6, 17, 9, 15, 45, 500));
    const result = await p;

    const expected = new Date(2026, 6, 17, 9, 15, 0, 0).getTime();
    expect(result).toBe(expected);
    // Floored to the minute — seconds/millis stripped.
    expect(new Date(result as number).getSeconds()).toBe(0);
  });
});

describe('pickFutureDateTime — cancellation', () => {
  it('cancelling the date step resolves null and never opens the time step', async () => {
    const p = pickFutureDateTime();
    cfgOf(0).onChange({ type: 'dismissed' }, undefined);
    expect(await p).toBeNull();
    expect(openMock).toHaveBeenCalledTimes(1); // time picker never opened
  });

  it('cancelling the time step resolves null', async () => {
    const p = pickFutureDateTime();
    cfgOf(0).onChange({ type: 'set' }, new Date(2026, 6, 17));
    cfgOf(1).onChange({ type: 'dismissed' }, undefined);
    expect(await p).toBeNull();
  });
});

describe('pickFutureDateTime — future guarantee', () => {
  it('rejects a clearly-past minute (resolves null)', async () => {
    const p = pickFutureDateTime();
    cfgOf(0).onChange({ type: 'set' }, new Date(2026, 6, 15));
    // 11:00 today, well before the frozen 12:30:30 now.
    cfgOf(1).onChange({ type: 'set' }, new Date(2026, 6, 15, 11, 0));
    expect(await p).toBeNull();
  });

  it('clamps a current-minute pick to STRICTLY now+60s (not the past-floored :00)', async () => {
    const p = pickFutureDateTime();
    cfgOf(0).onChange({ type: 'set' }, new Date(2026, 6, 15));
    // 12:30 today floors to 12:30:00 — >= the minute boundary (so not rejected) but < now (12:30:30).
    cfgOf(1).onChange({ type: 'set' }, new Date(2026, 6, 15, 12, 30));
    const result = await p;

    const flooredMinute = new Date(2026, 6, 15, 12, 30, 0, 0).getTime();
    expect(result).toBe(Date.now() + 60_000); // clamped to now+60s
    expect(result as number).toBeGreaterThan(Date.now()); // strictly future
    expect(result).not.toBe(flooredMinute); // NOT the (past-of-now) floored minute
  });
});
