import * as ImagePicker from 'expo-image-picker';
import { logger } from '@core/secure';
import { loadCameraCaptureChat, saveCameraCaptureChat } from '@/services/cameraCapture';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

/**
 * Recover a photo taken while Android killed Gator behind the system camera.
 *
 * expo-image-picker keeps such a result for `getPendingResultAsync()`, which hands it out once.
 * The result itself does not say which chat asked for it, so the tray records the chat before it
 * opens the camera. Only that chat's composer takes the photo. Another chat leaves both alone so
 * the right chat can still claim it. With no record (none was made, or a Disconnect wiped it with
 * the old account's database), nobody can tell where the photo belongs, so it is dropped.
 */
export async function takePendingCameraCapture(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<ImagePicker.ImagePickerAsset | null> {
  if (!accountLease.isCurrent()) return null;
  let owner: string | null;
  try {
    owner = await loadCameraCaptureChat(accountLease);
  } catch (error) {
    logger.warn('[camera] could not read the camera owner record', error);
    return null;
  }
  if (!accountLease.isCurrent()) return null;
  // Another chat's photo: leave it waiting until that chat opens.
  if (owner !== null && owner !== chatGuid) return null;

  let pending: Awaited<ReturnType<typeof ImagePicker.getPendingResultAsync>> = null;
  try {
    pending = await ImagePicker.getPendingResultAsync();
  } catch (error) {
    logger.warn('[camera] could not read a pending camera result', error);
  }
  if (owner !== null) {
    void saveCameraCaptureChat('', accountLease).catch(() => {
      // Best-effort: a leftover record only makes a later chat open look for a result again.
    });
  }
  if (owner === null || !accountLease.isCurrent() || !pending) return null;
  if (!('canceled' in pending) || pending.canceled) return null;
  return pending.assets[0] ?? null;
}
