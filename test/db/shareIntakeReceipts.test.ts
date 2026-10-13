import {
  ShareIntakeReceiptConflictError,
  admitShareIntakeTextDraftWithinTransaction,
  claimShareIntakeFileWithinTransaction,
  discardShareIntakeItemWithinTransaction,
  getShareIntakeReceipt,
  isShareIntakeNewChatRetryWindowOpen,
  isShareIntakeReceiptComplete,
  listShareIntakeReceiptBatchIds,
  recordShareIntakeNewChatWithinTransaction,
  SHARE_INTAKE_RECEIPT_KV_PREFIX,
  SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS,
  type ShareIntakeManifestIdentity,
  type ShareIntakeNewChatPlan,
} from '@db/repositories/shareIntakeReceipts';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';
import { prepareShareIntakeNewChatPlan } from '../support/repositoryWrappers';

const identity = (
  suffix: string,
  overrides: Partial<ShareIntakeManifestIdentity> = {},
): ShareIntakeManifestIdentity => ({
  batchId: `1700000000000-1-${suffix.padStart(16, '0')}`,
  nativeCreatedAtMs: 1_700_000_000_000,
  hasText: true,
  fileCount: 1,
  ...overrides,
});

const newChatPlan = (overrides: Partial<ShareIntakeNewChatPlan> = {}): ShareIntakeNewChatPlan => ({
  address: '+15550000001',
  body: 'Shared text',
  service: 'iMessage',
  providerEpoch: null,
  tempGuid: 'share-new-1700000000000-1-0000000000000001',
  clientAttemptGeneration: 1,
  ...overrides,
});

describe('share intake new-chat retry window', () => {
  it('admits only non-future attempts strictly inside the 30-day replay window', () => {
    const item = identity('9', { nativeCreatedAtMs: 10_000 });

    expect(isShareIntakeNewChatRetryWindowOpen(item, 10_000)).toBe(true);
    expect(
      isShareIntakeNewChatRetryWindowOpen(
        item,
        item.nativeCreatedAtMs + SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS - 1,
      ),
    ).toBe(true);
    expect(
      isShareIntakeNewChatRetryWindowOpen(
        item,
        item.nativeCreatedAtMs + SHARE_INTAKE_NEW_CHAT_RETRY_WINDOW_MS,
      ),
    ).toBe(false);
    expect(isShareIntakeNewChatRetryWindowOpen(item, item.nativeCreatedAtMs - 1)).toBe(false);
  });
});

describe('share intake receipt repository', () => {
  it('rejects invalid manifests and immutable-manifest mismatches', async () => {
    const { db, raw } = await createTestDb();
    const original = identity('1');

    try {
      await withDbTransaction(db, (context) =>
        discardShareIntakeItemWithinTransaction(context, {
          identity: original,
          itemKey: 'text',
          appliedAtMs: 10,
        }),
      );

      await expect(getShareIntakeReceipt(db, { ...original, fileCount: 2 })).rejects.toBeInstanceOf(
        ShareIntakeReceiptConflictError,
      );

      await expect(
        withDbTransaction(db, (context) =>
          discardShareIntakeItemWithinTransaction(context, {
            identity: {
              ...original,
              batchId: 'not-a-native-batch-id',
            },
            itemKey: 'text',
            appliedAtMs: 11,
          }),
        ),
      ).rejects.toBeInstanceOf(ShareIntakeReceiptConflictError);
    } finally {
      raw.close();
    }
  });

  it('atomically merges shared text into a draft and replays idempotently', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('2', { fileCount: 0 });
    const draftKey = 'draft.chat-existing';

    try {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(draftKey, 'Typed first');

      await expect(
        withDbTransaction(db, (context) =>
          admitShareIntakeTextDraftWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000001',
            sharedText: 'Shared text',
            draftKey,
            appliedAtMs: 20,
          }),
        ),
      ).resolves.toEqual({
        draft: 'Typed first\n\nShared text',
        alreadyApplied: false,
      });

      await expect(
        withDbTransaction(db, (context) =>
          admitShareIntakeTextDraftWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000001',
            sharedText: 'Shared text',
            draftKey,
            appliedAtMs: 21,
          }),
        ),
      ).resolves.toEqual({
        draft: 'Typed first\n\nShared text',
        alreadyApplied: true,
      });

      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(draftKey)).toEqual({
        value: 'Typed first\n\nShared text',
      });
      expect(await getShareIntakeReceipt(db, manifest)).toMatchObject({
        destination: {
          chatGuid: 'iMessage;-;+15550000001',
          routeKind: 'existing',
        },
        items: {
          text: {
            ownerKind: 'draft',
            ownerId: draftKey,
            appliedAtMs: 20,
          },
        },
      });
    } finally {
      raw.close();
    }
  });

  it('rolls the draft and its receipt back together', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('3', { fileCount: 0 });
    const draftKey = 'draft.rollback';

    try {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(draftKey, 'Before');

      await expect(
        withDbTransaction(db, async (context) => {
          await admitShareIntakeTextDraftWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000002',
            sharedText: 'Never committed',
            draftKey,
            appliedAtMs: 30,
          });
          throw new Error('rollback proof');
        }),
      ).rejects.toThrow('rollback proof');

      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(draftKey)).toEqual({
        value: 'Before',
      });
      await expect(getShareIntakeReceipt(db, manifest)).resolves.toBeNull();
    } finally {
      raw.close();
    }
  });

  it('freezes a new-chat plan and records its destination and text receipt', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('4');
    const plan = newChatPlan();

    try {
      await expect(prepareShareIntakeNewChatPlan(db, manifest, plan)).resolves.toEqual(plan);
      await expect(prepareShareIntakeNewChatPlan(db, manifest, plan)).resolves.toEqual(plan);
      await expect(
        prepareShareIntakeNewChatPlan(db, manifest, newChatPlan({ address: '+15550000009' })),
      ).rejects.toBeInstanceOf(ShareIntakeReceiptConflictError);

      await withDbTransaction(db, (context) =>
        recordShareIntakeNewChatWithinTransaction(context, {
          identity: manifest,
          chatGuid: 'iMessage;-;+15550000001',
          plan,
          nativeTextConsumed: true,
          appliedAtMs: 40,
        }),
      );

      const receipt = await getShareIntakeReceipt(db, manifest);
      expect(receipt).toMatchObject({
        destination: {
          chatGuid: 'iMessage;-;+15550000001',
          routeKind: 'new_chat',
        },
        newChatPlan: plan,
        items: {
          text: {
            ownerKind: 'new_chat',
            ownerId: plan.tempGuid,
            appliedAtMs: 40,
          },
        },
      });
      expect(receipt && isShareIntakeReceiptComplete(receipt)).toBe(false);
    } finally {
      raw.close();
    }
  });

  it('claims a file once and rejects a conflicting destination', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('5', { hasText: false });

    try {
      await expect(
        withDbTransaction(db, (context) =>
          claimShareIntakeFileWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000001',
            itemIndex: 0,
            ownerGuid: 'outgoing-first',
            appliedAtMs: 50,
          }),
        ),
      ).resolves.toEqual({ claimed: true, ownerGuid: 'outgoing-first' });

      await expect(
        withDbTransaction(db, (context) =>
          claimShareIntakeFileWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000001',
            itemIndex: 0,
            ownerGuid: 'outgoing-retry',
            appliedAtMs: 51,
          }),
        ),
      ).resolves.toEqual({ claimed: false, ownerGuid: 'outgoing-first' });

      await expect(
        withDbTransaction(db, (context) =>
          claimShareIntakeFileWithinTransaction(context, {
            identity: manifest,
            chatGuid: 'iMessage;-;+15550000002',
            itemIndex: 0,
            ownerGuid: 'outgoing-other-chat',
            appliedAtMs: 52,
          }),
        ),
      ).rejects.toBeInstanceOf(ShareIntakeReceiptConflictError);
    } finally {
      raw.close();
    }
  });

  it('counts discarded items toward completion only after a destination is bound', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('6', { fileCount: 2 });

    try {
      await withDbTransaction(db, async (context) => {
        await discardShareIntakeItemWithinTransaction(context, {
          identity: manifest,
          itemKey: 'text',
          appliedAtMs: 60,
        });
        await discardShareIntakeItemWithinTransaction(context, {
          identity: manifest,
          itemKey: 'file:00',
          appliedAtMs: 61,
        });
      });

      const unbound = await getShareIntakeReceipt(db, manifest);
      expect(unbound && isShareIntakeReceiptComplete(unbound)).toBe(false);

      await withDbTransaction(db, (context) =>
        claimShareIntakeFileWithinTransaction(context, {
          identity: manifest,
          chatGuid: 'iMessage;-;+15550000001',
          itemIndex: 1,
          ownerGuid: 'outgoing-last',
          appliedAtMs: 62,
        }),
      );

      const complete = await getShareIntakeReceipt(db, manifest);
      expect(complete && isShareIntakeReceiptComplete(complete)).toBe(true);
      await expect(
        withDbTransaction(db, (context) =>
          discardShareIntakeItemWithinTransaction(context, {
            identity: manifest,
            itemKey: 'file:00',
            appliedAtMs: 63,
          }),
        ),
      ).rejects.toBeInstanceOf(ShareIntakeReceiptConflictError);
    } finally {
      raw.close();
    }
  });

  it('fails closed when a stored receipt is corrupt or has extra fields', async () => {
    const { db, raw } = await createTestDb();
    const manifest = identity('7');
    const key = `${SHARE_INTAKE_RECEIPT_KV_PREFIX}${manifest.batchId}`;

    try {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, '{not-json');
      await expect(getShareIntakeReceipt(db, manifest)).rejects.toBeInstanceOf(
        ShareIntakeReceiptConflictError,
      );

      raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(
        JSON.stringify({
          version: 1,
          nativeCreatedAtMs: manifest.nativeCreatedAtMs,
          hasText: manifest.hasText,
          fileCount: manifest.fileCount,
          destination: null,
          newChatPlan: null,
          items: {},
          unexpected: true,
        }),
        key,
      );
      await expect(getShareIntakeReceipt(db, manifest)).rejects.toBeInstanceOf(
        ShareIntakeReceiptConflictError,
      );
    } finally {
      raw.close();
    }
  });

  it('lists every receipt when more than 32 native batches are pending', async () => {
    const { db, raw } = await createTestDb();
    const insert = raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    const batchIds = Array.from(
      { length: 40 },
      (_, index) => `1700000000000-${index + 1}-${index.toString(16).padStart(16, '0')}`,
    );

    try {
      raw.transaction(() => {
        for (const batchId of batchIds) {
          insert.run(`${SHARE_INTAKE_RECEIPT_KV_PREFIX}${batchId}`, '{}');
        }
      })();
      insert.run('unrelated-key', 'ignored');

      await expect(listShareIntakeReceiptBatchIds(db)).resolves.toEqual([...batchIds].sort());
    } finally {
      raw.close();
    }
  });
});
