import { showDialog, type DialogButton } from '@ui/dialog/dialogStore';
import { pickFutureDateTime } from './pickDateTime';

const HOUR = 60 * 60 * 1000;

// Day-or-longer presets step the calendar, not 24-hour blocks, so "1 Week" lands at the same
// clock time even when daylight saving starts or ends in between.
const PRESETS: { label: string; hours?: number; days?: number }[] = [
  { label: '1 Hour', hours: 1 },
  { label: '3 Hours', hours: 3 },
  { label: '6 Hours', hours: 6 },
  { label: '1 Day', days: 1 },
  { label: '1 Week', days: 7 },
  { label: '1 Month', days: 30 },
];

function presetTime(now: number, preset: { hours?: number; days?: number }): number {
  if (preset.hours !== undefined) return now + preset.hours * HOUR;
  const d = new Date(now);
  d.setDate(d.getDate() + (preset.days ?? 0));
  return d.getTime();
}

/** The resolved absolute time for a preset — time-of-day for < a day, a short date beyond that. */
function whenLabel(target: number, isHours: boolean): string {
  const d = new Date(target);
  return isHours
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "on Thu, Nov 5 at 1:29 PM": the exact day and time a reminder will fire. */
export function reminderTimeLabel(at: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `on ${day} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Quick reminder-time picker (parity with the old app's `showTimeframePicker`): relative presets
 * — 1 Hour / 3 Hours / 6 Hours / 1 Day / 1 Week / 1 Month, each showing the resolved time — plus a
 * "Custom Date…" option that falls through to the native date→time picker. Resolves to a future
 * epoch-ms, or null if cancelled. Used by both the create ("Remind Me Later") and reschedule paths.
 */
export function pickReminderTime(now: number = Date.now()): Promise<number | null> {
  return new Promise((resolve) => {
    const buttons: DialogButton[] = PRESETS.map((p) => {
      const target = presetTime(now, p);
      return {
        text: `${p.label} · ${whenLabel(target, p.hours !== undefined)}`,
        onPress: () => resolve(target),
      };
    });
    buttons.push({ text: 'Custom Date…', onPress: () => void pickFutureDateTime().then(resolve) });
    buttons.push({ text: 'Cancel', style: 'cancel', onPress: () => resolve(null) });
    showDialog('Remind me in…', undefined, buttons);
  });
}
