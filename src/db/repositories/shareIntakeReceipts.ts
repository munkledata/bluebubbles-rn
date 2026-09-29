import { sql } from 'drizzle-orm';
import { utf8Encode } from '@utils/bytes';
import { kv } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  withDbWriteLock,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

/** Encrypted, account-scoped receipts for native Android share batches. */
export const SHARE_INTAKE_RECEIPT_KV_PREFIX = 'share.intake.v1.';
/** Stay well inside the server's 90-day RCS attempt-replay retention. */
export const SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

const SHARE_BATCH_ID = /^[0-9]{1,19}-[0-9]{1,19}-[a-f0-9]{16}$/;
const MAX_SHARED_FILES = 10;
const MAX_RECEIPT_ITEMS = MAX_SHARED_FILES + 1;
// A valid 64-KiB UTF-8 body can expand substantially when JSON escapes control characters.
const MAX_RECEIPT_JSON_CHARS = 512 * 1024;
const MAX_OWNER_ID_CHARS = 1_024;
const MAX_PLAN_BODY_BYTES = 64 * 1024;
const MAX_PLAN_ADDRESS_CHARS = 1_024;
const MAX_TEMP_GUID_CHARS = 256;

export type ShareIntakeRouteKind = 'existing' | 'new_chat';
export type ShareIntakeItemKey = 'text' | `file:${string}`;
export type ShareIntakeItemOwnerKind = 'draft' | 'outgoing' | 'new_chat' | 'discarded';

export interface ShareIntakeManifestIdentity {
  readonly batchId: string;
  readonly nativeCreatedAtMs: number;
  readonly hasText: boolean;
  readonly fileCount: number;
}

export function isShareIntakeNewChatRetryWindowOpen(
  identity: ShareIntakeManifestIdentity,
  nowMs = Date.now(),
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < identity.nativeCreatedAtMs) return false;
  return nowMs - identity.nativeCreatedAtMs < SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS;
}

export interface ShareIntakeDestination {
  readonly chatGuid: string;
  readonly routeKind: ShareIntakeRouteKind;
}

export interface ShareIntakeNewChatPlan {
  readonly address: string;
  readonly body: string;
  readonly service: 'RCS' | 'iMessage';
  readonly providerEpoch: string | null;
  readonly tempGuid: string;
  readonly clientAttemptGeneration: 1;
}

export interface ShareIntakeItemReceipt {
  readonly ownerKind: ShareIntakeItemOwnerKind;
  readonly ownerId: string;
  readonly appliedAtMs: number;
}

export interface ShareIntakeReceipt {
  readonly version: 1;
  readonly nativeCreatedAtMs: number;
  readonly hasText: boolean;
  readonly fileCount: number;
  readonly destination: ShareIntakeDestination | null;
  readonly newChatPlan: ShareIntakeNewChatPlan | null;
  readonly items: Readonly<Record<string, ShareIntakeItemReceipt>>;
}

export class ShareIntakeReceiptConflictError extends Error {
  override readonly name = 'ShareIntakeReceiptConflictError';

  constructor() {
    super('share intake receipt conflicts with its durable owner');
  }
}

function receiptKey(batchId: string): string {
  if (!SHARE_BATCH_ID.test(batchId)) throw new ShareIntakeReceiptConflictError();
  return `${SHARE_INTAKE_RECEIPT_KV_PREFIX}${batchId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseDestination(value: unknown): ShareIntakeDestination | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['chatGuid', 'routeKind']) ||
    !validBoundedString(value.chatGuid, MAX_OWNER_ID_CHARS) ||
    (value.routeKind !== 'existing' && value.routeKind !== 'new_chat')
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
  return { chatGuid: value.chatGuid, routeKind: value.routeKind };
}

function parseNewChatPlan(value: unknown): ShareIntakeNewChatPlan | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'address',
      'body',
      'service',
      'providerEpoch',
      'tempGuid',
      'clientAttemptGeneration',
    ]) ||
    !validBoundedString(value.address, MAX_PLAN_ADDRESS_CHARS) ||
    typeof value.body !== 'string' ||
    value.body.length === 0 ||
    utf8Encode(value.body).byteLength > MAX_PLAN_BODY_BYTES ||
    (value.service !== 'RCS' && value.service !== 'iMessage') ||
    (value.providerEpoch !== null &&
      !validBoundedString(value.providerEpoch, MAX_OWNER_ID_CHARS)) ||
    (value.service === 'RCS' ? value.providerEpoch === null : value.providerEpoch !== null) ||
    !validBoundedString(value.tempGuid, MAX_TEMP_GUID_CHARS) ||
    value.clientAttemptGeneration !== 1
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
  return {
    address: value.address,
    body: value.body,
    service: value.service,
    providerEpoch: value.providerEpoch,
    tempGuid: value.tempGuid,
    clientAttemptGeneration: 1,
  };
}

function validItemKey(value: string, hasText: boolean, fileCount: number): boolean {
  if (value === 'text') return hasText;
  const match = /^file:([0-9]{2})$/.exec(value);
  if (!match) return false;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 && index < fileCount;
}

function parseItems(
  value: unknown,
  hasText: boolean,
  fileCount: number,
): Record<string, ShareIntakeItemReceipt> {
  if (!isRecord(value) || Object.keys(value).length > MAX_RECEIPT_ITEMS) {
    throw new ShareIntakeReceiptConflictError();
  }
  const parsed: Record<string, ShareIntakeItemReceipt> = {};
  for (const [itemKey, raw] of Object.entries(value)) {
    if (
      !validItemKey(itemKey, hasText, fileCount) ||
      !isRecord(raw) ||
      !hasExactKeys(raw, ['ownerKind', 'ownerId', 'appliedAtMs']) ||
      (raw.ownerKind !== 'draft' &&
        raw.ownerKind !== 'outgoing' &&
        raw.ownerKind !== 'new_chat' &&
        raw.ownerKind !== 'discarded') ||
      !validBoundedString(raw.ownerId, MAX_OWNER_ID_CHARS) ||
      !validTimestamp(raw.appliedAtMs)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    parsed[itemKey] = {
      ownerKind: raw.ownerKind,
      ownerId: raw.ownerId,
      appliedAtMs: raw.appliedAtMs,
    };
  }
  return parsed;
}

function parseReceipt(value: string): ShareIntakeReceipt {
  if (value.length === 0 || value.length > MAX_RECEIPT_JSON_CHARS) {
    throw new ShareIntakeReceiptConflictError();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ShareIntakeReceiptConflictError();
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      'version',
      'nativeCreatedAtMs',
      'hasText',
      'fileCount',
      'destination',
      'newChatPlan',
      'items',
    ]) ||
    raw.version !== 1 ||
    !validTimestamp(raw.nativeCreatedAtMs) ||
    typeof raw.hasText !== 'boolean' ||
    !Number.isInteger(raw.fileCount) ||
    (raw.fileCount as number) < 0 ||
    (raw.fileCount as number) > MAX_SHARED_FILES
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
  const destination = parseDestination(raw.destination);
  const newChatPlan = parseNewChatPlan(raw.newChatPlan);
  if (newChatPlan && destination?.routeKind === 'existing') {
    throw new ShareIntakeReceiptConflictError();
  }
  const fileCount = raw.fileCount as number;
  return {
    version: 1,
    nativeCreatedAtMs: raw.nativeCreatedAtMs,
    hasText: raw.hasText,
    fileCount,
    destination,
    newChatPlan,
    items: parseItems(raw.items, raw.hasText, fileCount),
  };
}

function freshReceipt(identity: ShareIntakeManifestIdentity): ShareIntakeReceipt {
  if (
    !SHARE_BATCH_ID.test(identity.batchId) ||
    !validTimestamp(identity.nativeCreatedAtMs) ||
    !Number.isInteger(identity.fileCount) ||
    identity.fileCount < 0 ||
    identity.fileCount > MAX_SHARED_FILES ||
    (!identity.hasText && identity.fileCount === 0)
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
  return {
    version: 1,
    nativeCreatedAtMs: identity.nativeCreatedAtMs,
    hasText: identity.hasText,
    fileCount: identity.fileCount,
    destination: null,
    newChatPlan: null,
    items: {},
  };
}

function assertManifest(receipt: ShareIntakeReceipt, identity: ShareIntakeManifestIdentity): void {
  if (
    receipt.nativeCreatedAtMs !== identity.nativeCreatedAtMs ||
    receipt.hasText !== identity.hasText ||
    receipt.fileCount !== identity.fileCount
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
}

function assertDestination(receipt: ShareIntakeReceipt, destination: ShareIntakeDestination): void {
  if (
    receipt.destination &&
    (receipt.destination.chatGuid !== destination.chatGuid ||
      receipt.destination.routeKind !== destination.routeKind)
  ) {
    throw new ShareIntakeReceiptConflictError();
  }
}

async function readReceiptValue(
  db: AppDatabase,
  batchId: string,
): Promise<ShareIntakeReceipt | null> {
  const rows = await db.all<{ value: string | null }>(
    sql`SELECT value FROM kv WHERE key = ${receiptKey(batchId)} LIMIT 1`,
  );
  const value = rows[0]?.value;
  return value == null ? null : parseReceipt(value);
}

function serializeReceipt(receipt: ShareIntakeReceipt): string {
  const serialized = JSON.stringify(receipt);
  if (serialized.length > MAX_RECEIPT_JSON_CHARS) throw new ShareIntakeReceiptConflictError();
  return serialized;
}

export function shareIntakeFileItemKey(index: number): ShareIntakeItemKey {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SHARED_FILES) {
    throw new ShareIntakeReceiptConflictError();
  }
  return `file:${String(index).padStart(2, '0')}`;
}

export function isShareIntakeReceiptComplete(receipt: ShareIntakeReceipt): boolean {
  if (receipt.destination == null) return false;
  if (receipt.hasText && receipt.items.text == null) return false;
  for (let index = 0; index < receipt.fileCount; index += 1) {
    if (receipt.items[shareIntakeFileItemKey(index)] == null) return false;
  }
  return true;
}

export async function getShareIntakeReceipt(
  db: AppDatabase,
  identity: ShareIntakeManifestIdentity,
): Promise<ShareIntakeReceipt | null> {
  return withDbWriteLock(async () => {
    const receipt = await readReceiptValue(db, identity.batchId);
    if (receipt) assertManifest(receipt, identity);
    return receipt;
  });
}

export async function prepareShareIntakeNewChatPlan(
  db: AppDatabase,
  identity: ShareIntakeManifestIdentity,
  plan: ShareIntakeNewChatPlan,
): Promise<ShareIntakeNewChatPlan> {
  return withDbTransaction(db, (context) =>
    prepareShareIntakeNewChatPlanWithinTransaction(context, identity, plan),
  );
}

export async function prepareShareIntakeNewChatPlanWithinTransaction(
  context: DbTransactionContext,
  identity: ShareIntakeManifestIdentity,
  plan: ShareIntakeNewChatPlan,
): Promise<ShareIntakeNewChatPlan> {
  return runInTransactionContext(context, async (db) => {
    const current = (await readReceiptValue(db, identity.batchId)) ?? freshReceipt(identity);
    assertManifest(current, identity);
    const validatedPlan = parseNewChatPlan(plan);
    if (!validatedPlan) throw new ShareIntakeReceiptConflictError();
    if (current.destination?.routeKind === 'existing') throw new ShareIntakeReceiptConflictError();
    if (
      current.newChatPlan &&
      JSON.stringify(current.newChatPlan) !== JSON.stringify(validatedPlan)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    const next: ShareIntakeReceipt = { ...current, newChatPlan: validatedPlan };
    await db
      .insert(kv)
      .values({ key: receiptKey(identity.batchId), value: serializeReceipt(next) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
    return validatedPlan;
  });
}

export async function admitShareIntakeTextDraftWithinTransaction(
  context: DbTransactionContext,
  args: {
    identity: ShareIntakeManifestIdentity;
    chatGuid: string;
    sharedText: string;
    draftKey: string;
    appliedAtMs: number;
  },
): Promise<{ readonly draft: string; readonly alreadyApplied: boolean }> {
  return runInTransactionContext(context, async (db) => {
    if (
      !args.identity.hasText ||
      args.sharedText.length === 0 ||
      !validTimestamp(args.appliedAtMs)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    const current =
      (await readReceiptValue(db, args.identity.batchId)) ?? freshReceipt(args.identity);
    assertManifest(current, args.identity);
    if (current.newChatPlan) throw new ShareIntakeReceiptConflictError();
    const destination: ShareIntakeDestination = {
      chatGuid: args.chatGuid,
      routeKind: 'existing',
    };
    assertDestination(current, destination);
    const draftRows = await db.all<{ value: string | null }>(
      sql`SELECT value FROM kv WHERE key = ${args.draftKey} LIMIT 1`,
    );
    const existingDraft = draftRows[0]?.value ?? '';
    const existingItem = current.items.text;
    if (existingItem) {
      return { draft: existingDraft, alreadyApplied: true };
    }
    const mergedDraft =
      existingDraft.length === 0 || existingDraft === args.sharedText
        ? args.sharedText
        : `${existingDraft}\n\n${args.sharedText}`;
    const next: ShareIntakeReceipt = {
      ...current,
      destination,
      items: {
        ...current.items,
        text: {
          ownerKind: 'draft',
          ownerId: args.draftKey,
          appliedAtMs: args.appliedAtMs,
        },
      },
    };
    await db
      .insert(kv)
      .values({ key: args.draftKey, value: mergedDraft })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
    await db
      .insert(kv)
      .values({ key: receiptKey(args.identity.batchId), value: serializeReceipt(next) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
    return { draft: mergedDraft, alreadyApplied: false };
  });
}

export async function recordShareIntakeNewChatWithinTransaction(
  context: DbTransactionContext,
  args: {
    identity: ShareIntakeManifestIdentity;
    chatGuid: string;
    plan: ShareIntakeNewChatPlan;
    nativeTextConsumed: boolean;
    appliedAtMs: number;
  },
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (!validTimestamp(args.appliedAtMs)) throw new ShareIntakeReceiptConflictError();
    const current = await readReceiptValue(db, args.identity.batchId);
    if (!current) throw new ShareIntakeReceiptConflictError();
    assertManifest(current, args.identity);
    const validatedPlan = parseNewChatPlan(args.plan);
    if (
      !validatedPlan ||
      !current.newChatPlan ||
      JSON.stringify(current.newChatPlan) !== JSON.stringify(validatedPlan)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    const destination: ShareIntakeDestination = {
      chatGuid: args.chatGuid,
      routeKind: 'new_chat',
    };
    assertDestination(current, destination);
    if (args.nativeTextConsumed !== args.identity.hasText) {
      throw new ShareIntakeReceiptConflictError();
    }
    const existingText = current.items.text;
    if (
      existingText &&
      (existingText.ownerKind !== 'new_chat' || existingText.ownerId !== validatedPlan.tempGuid)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    const next: ShareIntakeReceipt = {
      ...current,
      destination,
      items: args.nativeTextConsumed
        ? {
            ...current.items,
            text: {
              ownerKind: 'new_chat',
              ownerId: validatedPlan.tempGuid,
              appliedAtMs: existingText?.appliedAtMs ?? args.appliedAtMs,
            },
          }
        : current.items,
    };
    await db
      .insert(kv)
      .values({ key: receiptKey(args.identity.batchId), value: serializeReceipt(next) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
  });
}

export async function claimShareIntakeFileWithinTransaction(
  context: DbTransactionContext,
  args: {
    identity: ShareIntakeManifestIdentity;
    chatGuid: string;
    itemIndex: number;
    ownerGuid: string;
    appliedAtMs: number;
  },
): Promise<{ readonly claimed: boolean; readonly ownerGuid: string }> {
  return runInTransactionContext(context, async (db) => {
    if (
      !validBoundedString(args.chatGuid, MAX_OWNER_ID_CHARS) ||
      !validBoundedString(args.ownerGuid, MAX_OWNER_ID_CHARS) ||
      !validTimestamp(args.appliedAtMs)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    const current =
      (await readReceiptValue(db, args.identity.batchId)) ?? freshReceipt(args.identity);
    assertManifest(current, args.identity);
    if (args.itemIndex >= args.identity.fileCount) {
      throw new ShareIntakeReceiptConflictError();
    }
    const itemKey = shareIntakeFileItemKey(args.itemIndex);
    const existing = current.items[itemKey];
    if (current.newChatPlan && current.destination == null) {
      throw new ShareIntakeReceiptConflictError();
    }
    if (current.destination && current.destination.chatGuid !== args.chatGuid) {
      throw new ShareIntakeReceiptConflictError();
    }
    if (existing) {
      if (existing.ownerKind !== 'outgoing') throw new ShareIntakeReceiptConflictError();
      return { claimed: false, ownerGuid: existing.ownerId };
    }
    const destination: ShareIntakeDestination = current.destination ?? {
      chatGuid: args.chatGuid,
      routeKind: 'existing',
    };
    const next: ShareIntakeReceipt = {
      ...current,
      destination,
      items: {
        ...current.items,
        [itemKey]: {
          ownerKind: 'outgoing',
          ownerId: args.ownerGuid,
          appliedAtMs: args.appliedAtMs,
        },
      },
    };
    await db
      .insert(kv)
      .values({ key: receiptKey(args.identity.batchId), value: serializeReceipt(next) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
    return { claimed: true, ownerGuid: args.ownerGuid };
  });
}

export async function discardShareIntakeItemWithinTransaction(
  context: DbTransactionContext,
  args: {
    identity: ShareIntakeManifestIdentity;
    chatGuid?: string;
    itemKey: ShareIntakeItemKey;
    appliedAtMs: number;
  },
): Promise<void> {
  return runInTransactionContext(context, async (owner) => {
    if (!validTimestamp(args.appliedAtMs)) throw new ShareIntakeReceiptConflictError();
    const current =
      (await readReceiptValue(owner, args.identity.batchId)) ?? freshReceipt(args.identity);
    assertManifest(current, args.identity);
    if (!validItemKey(args.itemKey, current.hasText, current.fileCount)) {
      throw new ShareIntakeReceiptConflictError();
    }
    if (
      current.destination &&
      (args.chatGuid == null || current.destination.chatGuid !== args.chatGuid)
    ) {
      throw new ShareIntakeReceiptConflictError();
    }
    if (current.newChatPlan && current.destination == null && args.chatGuid != null) {
      throw new ShareIntakeReceiptConflictError();
    }
    const existing = current.items[args.itemKey];
    if (existing && existing.ownerKind !== 'discarded') return;
    const destination =
      current.destination ??
      (args.chatGuid == null
        ? null
        : ({ chatGuid: args.chatGuid, routeKind: 'existing' } satisfies ShareIntakeDestination));
    const next: ShareIntakeReceipt = {
      ...current,
      destination,
      items: {
        ...current.items,
        [args.itemKey]: {
          ownerKind: 'discarded',
          ownerId: args.itemKey,
          appliedAtMs: existing?.appliedAtMs ?? args.appliedAtMs,
        },
      },
    };
    await owner
      .insert(kv)
      .values({ key: receiptKey(args.identity.batchId), value: serializeReceipt(next) })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
  });
}

export async function deleteShareIntakeReceipt(db: AppDatabase, batchId: string): Promise<void> {
  await withDbTransaction(db, (context) =>
    runInTransactionContext(context, async (owner) => {
      await owner.delete(kv).where(sql`${kv.key} = ${receiptKey(batchId)}`);
    }),
  );
}

export async function listShareIntakeReceiptBatchIds(db: AppDatabase): Promise<string[]> {
  return withDbWriteLock(async () => {
    const batchIds: string[] = [];
    let cursor = SHARE_INTAKE_RECEIPT_KV_PREFIX;
    const pageSize = 128;
    const hardLimit = 4_096;
    while (true) {
      const rows = await db.all<{ key: string }>(sql`
        SELECT key FROM kv
         WHERE key LIKE ${`${SHARE_INTAKE_RECEIPT_KV_PREFIX}%`}
           AND key > ${cursor}
         ORDER BY key
         LIMIT ${pageSize}
      `);
      for (const row of rows) {
        const batchId = row.key.slice(SHARE_INTAKE_RECEIPT_KV_PREFIX.length);
        if (!SHARE_BATCH_ID.test(batchId) || batchIds.length >= hardLimit) {
          throw new ShareIntakeReceiptConflictError();
        }
        batchIds.push(batchId);
      }
      if (rows.length < pageSize) return batchIds;
      cursor = rows[rows.length - 1]!.key;
    }
  });
}
