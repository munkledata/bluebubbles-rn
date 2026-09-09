/** Exact wire format of the random, per-device bearer issued by a Gator server. */
const SCOPED_DEVICE_CREDENTIAL = /^bbd_device_v1_[A-Za-z0-9_-]{43}$/;

/**
 * Distinguish a scoped device bearer from a legacy shared password without decoding or logging it.
 *
 * The check is deliberately exact: a password that merely starts with the reserved prefix must
 * continue to use the shared-password transport unless it matches the complete server contract.
 */
export function isScopedDeviceCredential(value: string | null | undefined): value is string {
  return typeof value === 'string' && SCOPED_DEVICE_CREDENTIAL.test(value);
}
