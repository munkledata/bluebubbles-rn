import { showDialog, type DialogButton } from '@ui/dialog/dialogStore';
import { pickFutureDateTime } from './pickDateTime';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PRESETS: { label: string; ms: number }[] = [
  { label: '1 Hour', ms: HOUR },
  { label: '3 Hours', ms: 3 * HOUR },
  { label: '6 Hours', ms: 6 * HOUR },
  { label: '1 Day', ms: DAY },
  { label: '1 Week', ms: 7 * DAY },
  { label: '1 Month', ms: 30 * DAY },
];

/** The resolved absolute time for a preset — time-of-day for < a day, a short date beyond that. */
function whenLabel(target: number, offset: number): string {
  const d = new Date(target);
  return offset < DAY
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Quick reminder-time picker (parity with the old app's `showTimeframePicker`): relative presets
 * — 1 Hour / 3 Hours / 6 Hours / 1 Day / 1 Week / 1 Month, each showing the resolved time — plus a
 * "Custom Date…" option that falls through to the native date→time picker. Resolves to a future
 * epoch-ms, or null if cancelled. Used by both the create ("Remind Me Later") and reschedule paths.
 */
export function pickReminderTime(now: number = Date.now()): Promise<number | null> {
  return new Promise((resolve) => {
    const buttons: DialogButton[] = PRESETS.map((p) => ({
      text: `${p.label} · ${whenLabel(now + p.ms, p.ms)}`,
      onPress: () => resolve(now + p.ms),
    }));
    buttons.push({ text: 'Custom Date…', onPress: () => void pickFutureDateTime().then(resolve) });
    buttons.push({ text: 'Cancel', style: 'cancel', onPress: () => resolve(null) });
    showDialog('Remind me in…', undefined, buttons);
  });
}
