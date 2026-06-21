/**
 * Incoming-event de-duplication (ported from incoming_queue.dart).
 *
 * The same message can arrive twice — once via FCM and once via a socket catch-up
 * sync. We dedup by GUID with a bounded recency window so memory stays flat.
 */
export class GuidDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 5_000) {}

  /** Returns true if this guid is new (and records it); false if already seen. */
  markIfNew(guid: string): boolean {
    if (this.seen.has(guid)) return false;
    this.seen.add(guid);
    this.order.push(guid);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  has(guid: string): boolean {
    return this.seen.has(guid);
  }
}
