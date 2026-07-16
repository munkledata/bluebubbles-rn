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

  it('resolves null when cancelled', async () => {
    const p = pickReminderTime(1_700_000_000_000);
    const cancel = useDialogStore.getState().current!.buttons.find((b) => b.style === 'cancel')!;
    cancel.onPress!();
    await expect(p).resolves.toBeNull();
  });
});
