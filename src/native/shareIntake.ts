import { requireOptionalNativeModule } from 'expo';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const BATCH_ID = /^[0-9]{1,19}-[0-9]{1,19}-[a-f0-9]{16}$/;
const TARGET_TOKEN = /^gator-share-v2-[A-Za-z0-9_-]{43}$/;
const FILE_NAME = /^[0-9]{2}-[A-Za-z0-9._-]{1,100}$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/;

interface NativeShareFile {
  uri?: unknown;
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
}

interface NativeShareManifest {
  batchId?: unknown;
  createdAtMs?: unknown;
  text?: unknown;
  targetToken?: unknown;
  files?: unknown;
}

interface NativeSubscription {
  remove(): void;
}

interface GatorShareIntakeNative {
  takeNext(): Promise<NativeShareManifest | null>;
  acknowledge(batchId: string): Promise<boolean>;
  release(batchId: string): Promise<boolean>;
  discard(batchId: string): Promise<boolean>;
  discardForAccountReset(batchId: string): Promise<boolean>;
  takeLastError(): string | null;
  addListener(
    event: 'onPending' | 'onRejected',
    listener: (event: { reason?: unknown; newShare?: unknown }) => void,
  ): NativeSubscription;
}

export interface NativeSharedAttachment {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly origin: 'share';
  /** Stable native manifest order; durable replay receipts key files by this ordinal. */
  readonly shareItemIndex: number;
}

export interface NativeShareBatch {
  readonly batchId: string;
  readonly createdAtMs: number;
  readonly text: string | null;
  readonly targetToken: string | null;
  readonly files: NativeSharedAttachment[];
}

function getNative(): GatorShareIntakeNative | null {
  try {
    return requireOptionalNativeModule<GatorShareIntakeNative>('GatorShareIntake');
  } catch {
    return null;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseFile(value: unknown, batchId: string, index: number): NativeSharedAttachment {
  if (typeof value !== 'object' || value === null) throw new Error('invalid shared file');
  const file = value as NativeShareFile;
  if (
    typeof file.uri !== 'string' ||
    typeof file.name !== 'string' ||
    typeof file.mimeType !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_FILE_BYTES ||
    !FILE_NAME.test(`${String(index).padStart(2, '0')}-${file.name}`) ||
    !MIME_TYPE.test(file.mimeType) ||
    file.mimeType.length > 120
  ) {
    throw new Error('invalid shared file');
  }
  const encodedBatch = batchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const encodedName = `${String(index).padStart(2, '0')}-${file.name}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  if (!new RegExp(`/shared-in/files/${encodedBatch}/${encodedName}$`).test(file.uri)) {
    throw new Error('shared file escaped its native batch');
  }
  return {
    uri: file.uri,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    origin: 'share',
    shareItemIndex: index,
  };
}

export function parseNativeShareBatch(value: unknown): NativeShareBatch {
  if (typeof value !== 'object' || value === null) throw new Error('invalid share batch');
  const raw = value as NativeShareManifest;
  if (
    typeof raw.batchId !== 'string' ||
    !BATCH_ID.test(raw.batchId) ||
    typeof raw.createdAtMs !== 'number' ||
    !Number.isSafeInteger(raw.createdAtMs) ||
    raw.createdAtMs <= 0 ||
    (raw.text !== null && typeof raw.text !== 'string') ||
    (raw.targetToken !== null &&
      (typeof raw.targetToken !== 'string' || !TARGET_TOKEN.test(raw.targetToken))) ||
    !Array.isArray(raw.files) ||
    raw.files.length > MAX_FILES
  ) {
    throw new Error('invalid share batch');
  }
  if (typeof raw.text === 'string' && utf8Bytes(raw.text) > MAX_TEXT_BYTES) {
    throw new Error('shared text is too large');
  }
  const files = raw.files.map((file, index) => parseFile(file, raw.batchId as string, index));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_BATCH_BYTES || (raw.text === null && files.length === 0)) {
    throw new Error('invalid share batch');
  }
  return {
    batchId: raw.batchId,
    createdAtMs: raw.createdAtMs,
    text: raw.text,
    targetToken: raw.targetToken,
    files,
  };
}

/**
 * A claimed native batch this build cannot read (M169). `batchId` is the claim's id only when that
 * id is itself valid, so the drain can discard the claim instead of staying blocked behind it.
 */
export class UnreadableNativeShareBatchError extends Error {
  constructor(readonly batchId: string | null) {
    super('claimed share batch is unreadable');
    this.name = 'UnreadableNativeShareBatchError';
  }
}

export async function takeNextNativeShareBatch(): Promise<NativeShareBatch | null> {
  const native = getNative();
  if (!native) return null;
  const value = await native.takeNext();
  if (value === null) return null;
  try {
    return parseNativeShareBatch(value);
  } catch {
    const batchId: unknown = typeof value === 'object' ? value.batchId : undefined;
    throw new UnreadableNativeShareBatchError(
      typeof batchId === 'string' && BATCH_ID.test(batchId) ? batchId : null,
    );
  }
}

export async function acknowledgeNativeShareBatch(batchId: string): Promise<void> {
  if (!BATCH_ID.test(batchId)) throw new Error('invalid share batch id');
  const native = getNative();
  if (!native || (await native.acknowledge(batchId)) !== true) {
    throw new Error('share batch acknowledgement failed');
  }
}

export async function releaseNativeShareBatch(batchId: string): Promise<void> {
  if (!BATCH_ID.test(batchId)) throw new Error('invalid share batch id');
  const native = getNative();
  if (!native || (await native.release(batchId)) !== true) {
    throw new Error('share batch release failed');
  }
}

export async function discardNativeShareBatch(batchId: string): Promise<void> {
  if (!BATCH_ID.test(batchId)) throw new Error('invalid share batch id');
  const native = getNative();
  if (!native || (await native.discard(batchId)) !== true) {
    throw new Error('share batch discard failed');
  }
}

/** Idempotently remove a bound batch whether it is currently ready, claimed, or already gone. */
export async function discardNativeShareBatchForAccountReset(batchId: string): Promise<void> {
  if (!BATCH_ID.test(batchId)) throw new Error('invalid share batch id');
  const native = getNative();
  if (!native || (await native.discardForAccountReset(batchId)) !== true) {
    throw new Error('account-bound share batch cleanup failed');
  }
}

export function subscribeNativeShareIntake(
  onPending: (signal: { readonly newShare: boolean }) => void,
  onRejected: (reason: string) => void,
): () => void {
  const native = getNative();
  if (!native) return () => undefined;
  // True only for a share native just committed; a reminder that one is waiting is false.
  const pending = native.addListener('onPending', (event) =>
    onPending({ newShare: event.newShare === true }),
  );
  const rejected = native.addListener('onRejected', (event) => {
    // Native also persists every rejection for a cold start that misses the event. This one was
    // delivered live, so consume that receipt; otherwise the next launch reports it again.
    try {
      native.takeLastError();
    } catch {
      // The live report below still reaches the user.
    }
    onRejected(typeof event.reason === 'string' ? event.reason : 'unavailable');
  });
  const initialFailure = native.takeLastError();
  if (initialFailure) onRejected(initialFailure);
  return () => {
    pending.remove();
    rejected.remove();
  };
}
