import type { ServerInfo } from '@core/models';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { runAccountOperation } from './realtime/accountOperation';
import type { RealtimeDeliveryLease } from './realtime/deliveryCoordinator';
// The "Rcs" names are historical: this is the general server-capability lease (review M201).
import {
  captureSessionRcsCapabilityLease,
  type RcsCapabilityLease,
} from './send/rcsAttemptCapability';

/** A server-advertised `supports_*` capability flag. */
export type ServerCapabilityFlag = {
  [K in keyof ServerInfo]-?: K extends `supports_${string}` ? K : never;
}[keyof ServerInfo];

/**
 * Run one Mac/server action for a screen, gated on the account and on a server capability flag.
 *
 * The result is null, a quiet no-op for the screen, when the account changed (before, during or
 * after the action), the server does not advertise `flag`, the captured session capability is no
 * longer current, or a database commit guard refused the write. Errors from the current account
 * still reach the caller. The action receives the account lease (for the Disconnect-cancellable
 * client and its commit guard) and the exact capability it was admitted under.
 */
export async function runCapabilityGatedAccountAction<T>(
  accountLease: RealtimeDeliveryLease,
  flag: ServerCapabilityFlag,
  action: (lease: RealtimeDeliveryLease, capability: RcsCapabilityLease) => Promise<T>,
): Promise<T | null> {
  try {
    const result = await runAccountOperation(accountLease, async (lease) => {
      const capability = captureSessionRcsCapabilityLease();
      if (!capability || capability.serverInfo?.[flag] !== true || !capability.isCurrent()) {
        return null;
      }
      return action(lease, capability);
    });
    return result.ok ? result.value : null;
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) return null;
    throw error;
  }
}
