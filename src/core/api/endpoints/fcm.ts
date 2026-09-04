import { z } from 'zod/v4';
import {
  decodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_TYPE,
} from '../../realtime/fcmEncryption';
import type { HttpClient } from '../http';

// Gator's register-device op returns `{ id }` (the new device row's id) post-unwrap.
const RegisterAck = z
  .object({
    id: z.string().max(256).nullish(),
    pushEncryptionType: z.string().max(64).nullish(),
  })
  .loose();

export interface FcmDeviceEncryptionRegistration {
  readonly type: typeof FCM_DEVICE_ENCRYPTION_TYPE;
  readonly key: string;
}

/**
 * POST /api/v1/devices — register this device for push so the server can notify us.
 *
 * Matches the Gator `register-device` op: a discriminated-union body keyed on `provider`
 * (here always "fcm"), with `name` (human label) + `token` (the FCM token). Returns the
 * new device's `{ id }`. (The legacy upstream used `POST /fcm/device` with
 * `{ name, identifier }` and no meaningful return — Gator unified all push providers
 * under `/devices`.)
 */
export async function registerDevice(
  http: HttpClient,
  name: string,
  token: string,
  pushEncryption?: FcmDeviceEncryptionRegistration,
): Promise<{ id: string | null; pushEncryptionType: string | null }> {
  if (pushEncryption) {
    if (pushEncryption.type !== FCM_DEVICE_ENCRYPTION_TYPE) {
      throw new Error('unsupported FCM device encryption registration');
    }
    decodeFcmDeviceEncryptionKey(pushEncryption.key);
  }
  const res = await http.post('/devices', RegisterAck, {
    json: {
      name,
      provider: 'fcm',
      token,
      ...(pushEncryption ? { pushEncryption } : {}),
    },
  });
  return {
    id: res.id ?? null,
    pushEncryptionType: res.pushEncryptionType ?? null,
  };
}
