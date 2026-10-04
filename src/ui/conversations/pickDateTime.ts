import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

/**
 * Two-step native date→time picker. Resolves to the chosen epoch-ms (floored to
 * the minute) or null if the user cancels either step or picks a past minute.
 */
export function pickFutureDateTime(): Promise<number | null> {
  return new Promise((resolve) => {
    const now = new Date();
    DateTimePickerAndroid.open({
      value: now,
      mode: 'date',
      minimumDate: now,
      onChange: (event, date) => {
        // Android supplies the original Date even on dismissal; only an explicit set commits.
        if (event.type !== 'set' || !date) {
          resolve(null);
          return;
        }
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: false,
          onChange: (event, time) => {
            if (event.type !== 'set' || !time) {
              resolve(null);
              return;
            }
            const when = new Date(
              date.getFullYear(),
              date.getMonth(),
              date.getDate(),
              time.getHours(),
              time.getMinutes(),
              0,
              0,
            ).getTime();
            // Reject a clearly-past minute; for the current minute (already partly
            // elapsed), bump to ~1 min out so the result is STRICTLY in the future
            // (Notifee triggers + schedulers reject a past/now timestamp).
            const now = Date.now();
            if (when < Math.floor(now / 60_000) * 60_000) {
              resolve(null);
              return;
            }
            resolve(Math.max(when, now + 60_000));
          },
        });
      },
    });
  });
}
