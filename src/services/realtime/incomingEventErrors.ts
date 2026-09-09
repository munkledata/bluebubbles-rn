/**
 * Expected control flow for a durable event whose local prerequisite has not settled yet.
 *
 * The incoming-event drain returns this exact occurrence to a short retry without spending one of
 * its five poison attempts. Keep the message fixed: event/account identifiers must never enter
 * logs through an error string.
 */
export class IncomingEventDependencyPendingError extends Error {
  constructor() {
    super('incoming event dependency is still pending');
    this.name = 'IncomingEventDependencyPendingError';
  }
}
