/**
 * One process-wide FIFO for every operation that can create or adopt an FCM registration.
 *
 * The tail is replaced synchronously, before `work` can reach its first await. Reconnect, Firebase
 * token refresh, and credential adoption therefore cannot race two registration bodies or keys.
 * A rejected operation releases the next slot instead of poisoning the queue.
 */
let registrationTail: Promise<void> = Promise.resolve();

export function runSerializedFcmRegistration<T>(work: () => Promise<T>): Promise<T> {
  const previous = registrationTail;
  const current = (async () => {
    await previous;
    return work();
  })();
  registrationTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
