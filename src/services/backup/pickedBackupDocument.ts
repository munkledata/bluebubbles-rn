import { requireOptionalNativeModule } from 'expo';
import { assertBackupFileSize, assertBackupSourceTextWithinLimit } from './backup';
import { BACKUP_LIMITS } from './backupSchema';

export type PickedBackupDocumentFailure =
  'cancelled' | 'invalid' | 'size' | 'timeout' | 'unavailable';

interface NativePickedBackupResult {
  ok?: boolean;
  text?: string;
  bytes?: number;
  reason?: PickedBackupDocumentFailure;
}

interface GatorBoundedDocumentNative {
  prepare(requestId: string): void;
  cancel(requestId: string): void;
  releasePrepared(requestId: string): void;
  read(
    requestId: string,
    uri: string,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<NativePickedBackupResult>;
}

const PICKED_BACKUP_READ_TIMEOUT_MS = 15_000;
let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  return `backup-document-${Date.now()}-${requestSequence}`;
}

function getNative(): GatorBoundedDocumentNative | null {
  try {
    return requireOptionalNativeModule<GatorBoundedDocumentNative>('GatorBoundedDocument');
  } catch {
    return null;
  }
}

export class PickedBackupDocumentError extends Error {
  constructor(readonly reason: PickedBackupDocumentFailure) {
    super(`picked-backup-document:${reason}`);
    this.name = 'PickedBackupDocumentError';
  }
}

/**
 * Read a provider-owned Android document through Gator's native streaming boundary.
 *
 * Picker metadata is only a cheap early rejection because Android providers may omit or misreport
 * it. Native code owns the actual max-plus-one byte cap, strict UTF-8 decoder, elapsed deadline,
 * and cancellation; no unbounded private-cache copy or synchronous JavaScript file read occurs.
 */
export async function readPickedBackupDocument(
  uri: string,
  claimedSize?: number | null,
  signal?: AbortSignal,
): Promise<string> {
  if (claimedSize != null) assertBackupFileSize(claimedSize);

  const native = getNative();
  if (!native) throw new PickedBackupDocumentError('unavailable');
  if (signal?.aborted) throw new PickedBackupDocumentError('cancelled');

  const requestId = nextRequestId();
  let readInvoked = false;
  const abort = (): void => native.cancel(requestId);

  try {
    native.prepare(requestId);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) native.cancel(requestId);

    const pending = native.read(
      requestId,
      uri,
      BACKUP_LIMITS.fileBytes,
      PICKED_BACKUP_READ_TIMEOUT_MS,
    );
    readInvoked = true;
    const result = await pending;

    if (!result.ok) {
      throw new PickedBackupDocumentError(result.reason ?? 'unavailable');
    }
    if (
      typeof result.text !== 'string' ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes! < 0 ||
      result.bytes! > BACKUP_LIMITS.fileBytes
    ) {
      throw new PickedBackupDocumentError('invalid');
    }

    assertBackupSourceTextWithinLimit(result.text);
    return result.text.trim();
  } catch (error) {
    if (error instanceof PickedBackupDocumentError) throw error;
    // Native/provider exceptions can contain a private content URI. Replace them with a stable,
    // non-sensitive category before they cross the service boundary.
    throw new PickedBackupDocumentError(signal?.aborted ? 'cancelled' : 'unavailable');
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      if (readInvoked) native.cancel(requestId);
      else native.releasePrepared(requestId);
    } catch {
      // Native `read` owns cleanup once invoked. Never mask the primary result during teardown.
    }
  }
}
