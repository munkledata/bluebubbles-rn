import { getDatabase } from '@db/database';
import { kvGet, kvSetWithinTransaction } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { runTrackedRealtimeWork, type RealtimeDeliveryLease } from './realtime/deliveryCoordinator';

/**
 * kv key naming the one chat whose composer has the system camera open. Android can kill Gator
 * while the camera app is in front; the restarted app reads this to put the recovered photo back
 * into that chat's composer instead of losing it. '' means no camera is open. It lives in the
 * account's database, so Disconnect's wipe drops it with the account.
 */
export const CAMERA_CAPTURE_CHAT_KV_KEY = 'camera.captureChat';

/** Record (or with '' clear) which chat launched the system camera. A stale lease writes nothing. */
export async function saveCameraCaptureChat(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  await runTrackedRealtimeWork(accountLease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    await withDbTransaction(
      getDatabase(),
      (db, context) => kvSetWithinTransaction(context, CAMERA_CAPTURE_CHAT_KV_KEY, chatGuid),
      () => activeLease.isCurrent(),
    );
  });
}

/** The chat that launched the system camera, or null when none is recorded (or the lease ended). */
export async function loadCameraCaptureChat(
  accountLease: RealtimeDeliveryLease,
): Promise<string | null> {
  let chatGuid: string | null = null;
  await runTrackedRealtimeWork(accountLease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    chatGuid = (await kvGet(getDatabase(), CAMERA_CAPTURE_CHAT_KV_KEY)) || null;
  });
  return accountLease.isCurrent() ? chatGuid : null;
}
