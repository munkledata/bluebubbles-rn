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

/**
 * A durable event whose payload can never be applied: a deterministic defect, not a transient
 * failure. The drain poisons it on the first attempt instead of retrying it four more times over
 * minutes while it blocks its ordering key (review M112). The message is fixed for the same reason
 * as above.
 */
export class IncomingEventPermanentPayloadError extends Error {
  constructor() {
    super('incoming event payload can never be applied');
    this.name = 'IncomingEventPermanentPayloadError';
  }
}
