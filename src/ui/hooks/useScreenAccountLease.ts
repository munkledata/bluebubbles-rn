import { useState } from 'react';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

/**
 * The account lease of this mounted screen, captured once at mount.
 *
 * Dialog, Modal and swipe callbacks can run long after the tap that created them. Passing this
 * lease (not a fresh capture) to account work makes a callback from a screen whose account was
 * disconnected a quiet no-op instead of acting on the next account. Run the work through
 * `runAccountOperation` (or a service that takes the lease) so Disconnect waits for it.
 */
export function useScreenAccountLease(): RealtimeDeliveryLease {
  const [lease] = useState(captureRealtimeDeliveryLease);
  return lease;
}
