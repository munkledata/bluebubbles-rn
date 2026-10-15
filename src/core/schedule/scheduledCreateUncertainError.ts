/**
 * A scheduled-message create whose reply was lost, when the Mac's list could not be checked
 * either. The Mac may already hold the message, so the phone keeps no copy of its own: only the
 * owner can safely check Scheduled and try again (review M095).
 */
export class ScheduledCreateUncertainError extends Error {
  constructor() {
    super('The Mac may already have saved this scheduled message.');
    this.name = 'ScheduledCreateUncertainError';
  }
}
