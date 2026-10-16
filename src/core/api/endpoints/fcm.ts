import { z } from 'zod/v4';
import {
  decodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_TYPE,
} from '../../realtime/fcmEncryption';
import { FCM_PUSH_ENCRYPTION_TYPE_V3 } from '../../realtime/fcmPushEnvelopeIdentity';
import type { HttpClient } from '../http';

const CanonicalUuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const PushEncryptionIdentityV3 = z
  .object({
    serverInstallationId: CanonicalUuidV4,
    principalId: CanonicalUuidV4,
    deviceId: CanonicalUuidV4,
  })
  .strict();
const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const RemoveDeviceAck = z.object({ removed: z.string().max(256).nullish() }).loose();

// Gator's register-device op returns `{ id }` (the new device row's id) post-unwrap.
const RegisterAck = z
  .object({
    id: z.string().max(256).nullish(),
    pushEncryptionType: z.string().max(64).nullish(),
    pushEncryptionIdentity: PushEncryptionIdentityV3.nullish(),
    pushEncryptionKeyVersion: PositiveSafeInteger.nullish(),
    pushEncryptionRotationId: CanonicalUuidV4.nullish(),
    pushEncryptionPreviousKeyExpiresAt: PositiveSafeInteger.nullish(),
  })
  .loose();

interface FcmDeviceEncryptionRegistrationV2 {
  readonly type: typeof FCM_DEVICE_ENCRYPTION_TYPE;
  readonly key: string;
}

interface FcmDeviceEncryptionRegistrationV3 {
  readonly type: typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
  readonly key: string;
  readonly rotation?: {
    readonly id: string;
    readonly previousKeyVersion: number;
  };
}

export type FcmDeviceEncryptionRegistration =
  FcmDeviceEncryptionRegistrationV2 | FcmDeviceEncryptionRegistrationV3;

export type FcmPushEncryptionIdentityV3 = z.infer<typeof PushEncryptionIdentityV3>;

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
): Promise<{
  id: string | null;
  pushEncryptionType: string | null;
  pushEncryptionIdentity: FcmPushEncryptionIdentityV3 | null;
  pushEncryptionKeyVersion?: number;
  pushEncryptionRotationId?: string;
  pushEncryptionPreviousKeyExpiresAt?: number;
}> {
  if (pushEncryption) {
    if (
      pushEncryption.type !== FCM_DEVICE_ENCRYPTION_TYPE &&
      pushEncryption.type !== FCM_PUSH_ENCRYPTION_TYPE_V3
    ) {
      throw new Error('unsupported FCM device encryption registration');
    }
    decodeFcmDeviceEncryptionKey(pushEncryption.key);
    if ('rotation' in pushEncryption && pushEncryption.rotation !== undefined) {
      if (
        pushEncryption.type !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
        !CanonicalUuidV4.safeParse(pushEncryption.rotation.id).success ||
        !PositiveSafeInteger.safeParse(pushEncryption.rotation.previousKeyVersion).success
      ) {
        throw new Error('invalid FCM push-key rotation registration');
      }
    }
  }
  const res = await http.post('/devices', RegisterAck, {
    // The scoped replacement flow needs the server's bounded machine-readable 409 type to
    // distinguish an existing push owner from a temporary network failure.
    captureErrorDetail: true,
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
    pushEncryptionIdentity: res.pushEncryptionIdentity ?? null,
    ...(res.pushEncryptionKeyVersion == null
      ? {}
      : { pushEncryptionKeyVersion: res.pushEncryptionKeyVersion }),
    ...(res.pushEncryptionRotationId == null
      ? {}
      : { pushEncryptionRotationId: res.pushEncryptionRotationId }),
    ...(res.pushEncryptionPreviousKeyExpiresAt == null
      ? {}
      : { pushEncryptionPreviousKeyExpiresAt: res.pushEncryptionPreviousKeyExpiresAt }),
  };
}

/**
 * Remove one push device row. The server lets a scoped bearer remove only its own row, so a
 * replaced credential can free this phone's push target without being revoked (review M130).
 */
export async function removeDevice(
  http: HttpClient,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await http.delete(`/devices/${encodeURIComponent(id)}`, RemoveDeviceAck, { signal });
}
