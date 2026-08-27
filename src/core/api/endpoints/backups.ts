import { z } from 'zod/v4';
import { ApiError, UnimplementedEndpointError } from '../errors';
import type { HttpClient } from '../http';

const ENDPOINT = '/backup/settings';

// The server deliberately supports legacy clients whose settings payload was JSON. Keep the wire
// union exact, then let the backup service expose only bounded encrypted strings to Gator's UI.
const BackupSlotData = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const BackupSlotWire = z
  .object({
    name: z.string().min(1).max(4_096),
    data: BackupSlotData,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .loose();
export type BackupSlotWire = z.infer<typeof BackupSlotWire>;

const BackupSlotList = z.object({ backups: z.array(BackupSlotWire).max(100) }).loose();
// A historical server returned the array itself. Parse that shape explicitly so it can be
// distinguished from a malformed/oversized response from a CURRENT route.
const BackupSlotListResponse = z.union([BackupSlotList, z.array(z.unknown()).max(100)]);
const DeleteBackupSlotResult = z.object({ removed: z.boolean() }).loose();

function remapUnsupported(error: unknown): never {
  // There is no capability bit. A missing route means the feature is unavailable. Do not remap a
  // generic status-200 parse error: that can also mean a current server exceeded the bounded list.
  if (error instanceof ApiError && error.status === 404) {
    throw new UnimplementedEndpointError(ENDPOINT);
  }
  throw error;
}

/** Read-only capability probe plus the complete named settings-backup list. */
export async function listSettingsBackups(
  http: HttpClient,
  signal?: AbortSignal,
): Promise<BackupSlotWire[]> {
  try {
    const response = await http.get(ENDPOINT, BackupSlotListResponse, { signal });
    if (Array.isArray(response)) throw new UnimplementedEndpointError(ENDPOINT);
    return response.backups;
  } catch (error) {
    return remapUnsupported(error);
  }
}

/** Create or overwrite one slot. `data` is already-encrypted client ciphertext. */
export async function saveSettingsBackup(
  http: HttpClient,
  input: { name: string; data: string },
  signal?: AbortSignal,
): Promise<BackupSlotWire> {
  try {
    return await http.post(ENDPOINT, BackupSlotWire, { json: input, signal });
  } catch (error) {
    return remapUnsupported(error);
  }
}

/** Delete by exact, URL-encoded slot name. Missing names return `removed:false`. */
export async function deleteSettingsBackup(
  http: HttpClient,
  name: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const result = await http.delete(
      `${ENDPOINT}/${encodeURIComponent(name)}`,
      DeleteBackupSlotResult,
      { signal },
    );
    return result.removed;
  } catch (error) {
    return remapUnsupported(error);
  }
}
