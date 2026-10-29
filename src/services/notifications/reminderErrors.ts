/**
 * A reminder can't be set on this message. Unlike other reminder failures, its message is written
 * for the person using the app, so the chat screen shows it as the reason.
 *
 * Kept apart from `remindersService` (which needs the database and the native scheduler) so the
 * chat screen and its tests can recognise it without loading either.
 */
export class ReminderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderUnavailableError';
  }
}
