import { MAX_SERVER_ORIGIN_INPUT_LENGTH, strictServerOrigin } from '../config';
import { isScopedDeviceCredential } from './deviceCredential';
import type { SecureVault } from './vault';
import { utf8Encode } from '@utils/bytes';

/**
 * Custody of the scoped bearer a credential replacement left behind, kept until the server
 * confirms its revocation (review M130).
 *
 * This is deliberately not a credential-upgrade journal phase: a present journal pauses push
 * registration, and a slow or failing revocation must never do that. An approved server-address
 * change does wait for it, because the bearer may be revoked only at the address that issued it.
 */
const REPLACED_CREDENTIAL_RECORD_VERSION = 1 as const;
const MAX_REPLACED_CREDENTIAL_RECORD_UTF8_BYTES = 8 * 1024;

export interface ReplacedCredentialRecord {
  readonly version: typeof REPLACED_CREDENTIAL_RECORD_VERSION;
  /** Exact canonical origin that issued the credential; its revocation is sent nowhere else. */
  readonly origin: string;
  /** The replaced scoped bearer. */
  readonly credential: string;
}

export type ReplacedCredentialRecordInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly record: ReplacedCredentialRecord };

function invalidRecord(): Error {
  return new Error('invalid replaced-credential record');
}

function normalizeRecord(value: unknown): ReplacedCredentialRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRecord();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !['version', 'origin', 'credential'].every((key) => keys.includes(key)) ||
    record.version !== REPLACED_CREDENTIAL_RECORD_VERSION ||
    typeof record.origin !== 'string' ||
    record.origin.length > MAX_SERVER_ORIGIN_INPUT_LENGTH ||
    strictServerOrigin(record.origin) !== record.origin ||
    typeof record.credential !== 'string' ||
    !isScopedDeviceCredential(record.credential)
  ) {
    throw invalidRecord();
  }
  return Object.freeze({
    version: REPLACED_CREDENTIAL_RECORD_VERSION,
    origin: record.origin,
    credential: record.credential,
  });
}

export function createReplacedCredentialRecord(
  origin: string,
  credential: string,
): ReplacedCredentialRecord {
  return normalizeRecord({ version: REPLACED_CREDENTIAL_RECORD_VERSION, origin, credential });
}

/** Serialize only the canonical key order. */
export function serializeReplacedCredentialRecord(record: ReplacedCredentialRecord): string {
  return JSON.stringify(normalizeRecord(record));
}

/** Present but malformed or non-canonical data is reported as invalid, never as absent. */
export function inspectReplacedCredentialRecord(
  stored: string | null,
): ReplacedCredentialRecordInspection {
  if (stored === null) return { kind: 'absent' };
  if (
    stored.length === 0 ||
    stored.length > MAX_REPLACED_CREDENTIAL_RECORD_UTF8_BYTES ||
    utf8Encode(stored).length > MAX_REPLACED_CREDENTIAL_RECORD_UTF8_BYTES
  ) {
    return { kind: 'invalid' };
  }
  try {
    const record = normalizeRecord(JSON.parse(stored));
    // The app is the only writer, so anything but the exact canonical bytes is not ours.
    if (JSON.stringify(record) !== stored) return { kind: 'invalid' };
    return { kind: 'valid', record };
  } catch {
    return { kind: 'invalid' };
  }
}

const REPLACED_CREDENTIAL_KEY = 'replacedServerCredential';

/**
 * Remove the record once its bearer is revoked or deliberately forgotten. A keystore that keeps the
 * key still lets it be overwritten with an empty value, and an invalid record names no bearer, so
 * nothing is ever sent for it again (review M130). True once no valid record remains.
 */
export async function retireReplacedCredentialRecord(
  vault: Pick<SecureVault, 'get' | 'set' | 'delete'>,
): Promise<boolean> {
  if ((await vault.get(REPLACED_CREDENTIAL_KEY)) === null) return true;
  try {
    await vault.delete(REPLACED_CREDENTIAL_KEY);
  } catch {
    // The overwrite below is the fallback.
  }
  if (inspectReplacedCredentialRecord(await vault.get(REPLACED_CREDENTIAL_KEY)).kind !== 'valid') {
    return true;
  }
  try {
    await vault.set(REPLACED_CREDENTIAL_KEY, '');
  } catch {
    return false;
  }
  return inspectReplacedCredentialRecord(await vault.get(REPLACED_CREDENTIAL_KEY)).kind !== 'valid';
}
