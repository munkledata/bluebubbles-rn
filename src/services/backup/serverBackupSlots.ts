import { backupsApi } from '@core/api';
import type { BackupSlotWire } from '@core/api/endpoints/backups';
import { isChunkedSecretBoxEnvelope } from '@core/crypto';
import { http } from '../clients';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  BackupAccountChangedError,
  createEncryptedBackupCiphertext,
  importEncryptedBackup,
} from './backupService';
import { BACKUP_LIMITS } from './backupSchema';
import type { RestoreResult } from './backup';

/**
 * The current server accepts at most 1 MiB of raw JSON and has no aggregate quota. Keep enough
 * headroom for JSON/name/envelope bytes, and keep one fully observed client-created list below
 * HttpClient's 16 MiB response cap. Cross-device races can exceed that bound because the server has
 * no aggregate quota; these are fail-closed client admission limits, not a server guarantee.
 */
export const SERVER_BACKUP_SLOT_LIMITS = {
  nameCharacters: 80,
  ciphertextCharacters: 900 * 1024,
  slots: 10,
} as const;

export type ServerBackupSlotErrorKind =
  | 'invalid-name'
  | 'ciphertext-too-large'
  | 'slot-limit'
  | 'incompatible-slot'
  | 'response-mismatch';

export class ServerBackupSlotError extends Error {
  constructor(readonly kind: ServerBackupSlotErrorKind) {
    super(`server-backup-slot:${kind}`);
    this.name = 'ServerBackupSlotError';
  }
}

export interface ServerBackupSlot {
  name: string;
  /** Null for a legacy/plaintext/malformed server record. Such records may be replaced/deleted. */
  ciphertext: string | null;
  createdAt: number;
  updatedAt: number;
}

function assertCurrent(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new BackupAccountChangedError();
}

async function awaitCurrent<T>(lease: RealtimeDeliveryLease, promise: Promise<T>): Promise<T> {
  try {
    const value = await promise;
    assertCurrent(lease);
    return value;
  } catch (error) {
    if (!lease.isCurrent()) throw new BackupAccountChangedError();
    throw error;
  }
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** Normalize only NEW app-created names. Server-returned names remain exact for delete/overwrite. */
export function normalizeServerBackupSlotName(value: string): string {
  const normalized = value.normalize('NFC').trim();
  if (
    normalized.length === 0 ||
    normalized.length > SERVER_BACKUP_SLOT_LIMITS.nameCharacters ||
    hasControlCharacter(normalized)
  ) {
    throw new ServerBackupSlotError('invalid-name');
  }
  return normalized;
}

function toSlot(row: BackupSlotWire): ServerBackupSlot {
  const ciphertext =
    typeof row.data === 'string' &&
    row.data.length <= BACKUP_LIMITS.encodedCharacters &&
    isChunkedSecretBoxEnvelope(row.data)
      ? row.data
      : null;
  return {
    name: row.name,
    ciphertext,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function compareSlots(a: ServerBackupSlot, b: ServerBackupSlot): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Authenticated read-only capability probe. Non-string legacy data is never exposed as plaintext. */
export async function listServerBackupSlots(
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  signal?: AbortSignal,
): Promise<ServerBackupSlot[]> {
  assertCurrent(lease);
  const rows = await awaitCurrent(lease, backupsApi.listSettingsBackups(http, signal));
  return rows.map(toSlot).sort(compareSlots);
}

/** Build/seal locally, then POST only the exact ciphertext string and normalized name. */
export async function saveServerBackupSlot(
  input: {
    name: string;
    passphrase: string;
    now: number;
    existingSlotNames: readonly string[];
  },
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  signal?: AbortSignal,
): Promise<ServerBackupSlot> {
  assertCurrent(lease);
  const name = normalizeServerBackupSlotName(input.name);
  const existingNames = new Set(input.existingSlotNames);
  if (!existingNames.has(name) && existingNames.size >= SERVER_BACKUP_SLOT_LIMITS.slots) {
    throw new ServerBackupSlotError('slot-limit');
  }

  const ciphertext = await createEncryptedBackupCiphertext(input.passphrase, input.now, lease);
  if (
    ciphertext.length > SERVER_BACKUP_SLOT_LIMITS.ciphertextCharacters ||
    !isChunkedSecretBoxEnvelope(ciphertext)
  ) {
    throw new ServerBackupSlotError('ciphertext-too-large');
  }

  let result: ServerBackupSlot | undefined;
  const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
    const saved = await awaitCurrent(
      activeLease,
      backupsApi.saveSettingsBackup(http, { name, data: ciphertext }, signal),
    );
    if (saved.name !== name || saved.data !== ciphertext) {
      throw new ServerBackupSlotError('response-mismatch');
    }
    result = toSlot(saved);
  });
  if (outcome === 'paused' || result === undefined) throw new BackupAccountChangedError();
  return result;
}

/** Delete one exact server-returned name. No plaintext or passphrase participates. */
export async function deleteServerBackupSlot(
  name: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  signal?: AbortSignal,
): Promise<boolean> {
  assertCurrent(lease);
  if (name.length === 0 || name.length > 100 || hasControlCharacter(name)) {
    throw new ServerBackupSlotError('invalid-name');
  }
  let removed: boolean | undefined;
  const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
    removed = await awaitCurrent(activeLease, backupsApi.deleteSettingsBackup(http, name, signal));
  });
  if (outcome === 'paused' || removed === undefined) throw new BackupAccountChangedError();
  return removed;
}

/** Decrypt/validate completely before the existing guarded all-or-nothing DB restore. */
export function restoreServerBackupSlot(
  slot: ServerBackupSlot,
  passphrase: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RestoreResult> {
  assertCurrent(lease);
  if (slot.ciphertext === null) throw new ServerBackupSlotError('incompatible-slot');
  return importEncryptedBackup(slot.ciphertext, passphrase, lease);
}
