// pickReminderTime pulls in pickFutureDateTime → the native date picker; stub it so only the
// preset path (which never touches native) is exercised here.
jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));

// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { pickReminderTime } from '@ui/conversations/pickReminderTime';

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  useDialogStore.setState({ current: null, queue: [] });
});

describe('pickReminderTime', () => {
  it('offers the preset timeframes + Custom Date + Cancel', () => {
    void pickReminderTime(1_700_000_000_000);
    const dialog = useDialogStore.getState().current!;
    const labels = dialog.buttons.map((b) => b.text);
    expect(labels.some((t) => t.startsWith('1 Hour'))).toBe(true);
    expect(labels.some((t) => t.startsWith('1 Week'))).toBe(true);
    expect(labels.some((t) => t.startsWith('1 Month'))).toBe(true);
    expect(labels).toContain('Custom Date…');
    expect(labels[labels.length - 1]).toBe('Cancel');
  });

  it('resolves the chosen preset as an offset from `now`', async () => {
    const now = 1_700_000_000_000;
    const p = pickReminderTime(now);
    const oneHour = useDialogStore
      .getState()
      .current!.buttons.find((b) => b.text.startsWith('1 Hour'))!;
    oneHour.onPress!();
    await expect(p).resolves.toBe(now + HOUR);
  });

  it('keeps the clock time for day-or-longer presets across a daylight-saving change', async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = 'America/Denver';
    try {
      // 1:29 PM on Thu 29 Oct 2026; clocks go back on Sun 1 Nov.
      const now = new Date(2026, 9, 29, 13, 29).getTime();
      for (const [label, expected] of [
        ['1 Day', new Date(2026, 9, 30, 13, 29)],
        ['1 Week', new Date(2026, 10, 5, 13, 29)],
        ['1 Month', new Date(2026, 10, 28, 13, 29)],
      ] as const) {
        const p = pickReminderTime(now);
        useDialogStore.getState().current!.buttons.find((b) => b.text.startsWith(label))!
          .onPress!();
        const at = new Date((await p)!);
        expect([label, at.getHours(), at.getMinutes()]).toEqual([label, 13, 29]);
        expect(at.getTime()).toBe(expected.getTime());
        useDialogStore.setState({ current: null, queue: [] });
      }
      // The 1 Week span really is 7 days plus the hour the clocks went back.
      const p = pickReminderTime(now);
      useDialogStore.getState().current!.buttons.find((b) => b.text.startsWith('1 Week'))!
        .onPress!();
      await expect(p).resolves.toBe(now + 7 * 24 * HOUR + HOUR);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it('resolves null when cancelled', async () => {
    const p = pickReminderTime(1_700_000_000_000);
    const cancel = useDialogStore.getState().current!.buttons.find((b) => b.style === 'cancel')!;
    cancel.onPress!();
    await expect(p).resolves.toBeNull();
  });
});
