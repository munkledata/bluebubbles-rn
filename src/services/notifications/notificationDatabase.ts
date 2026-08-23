import { ensureDatabase } from '../databaseControl';

/** Lazy notification-to-database handoff, kept in its own module for pure-service imports. */
export function openNotificationDatabase() {
  return ensureDatabase();
}
