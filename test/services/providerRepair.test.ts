import type Database from 'better-sqlite3';
import { Chat, Message, ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import type { ProviderRepairLease } from '@core/api/endpoints/repairSnapshot';
import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import { ApiError } from '@core/api/errors';
import {
  upsertChats,
  upsertHandles,
  upsertMessages,
  markMessageDeleted,
  getSyncMarker,
  kvGet,
  kvSet,
  setSyncMarker,
  clearLocalCache,
  localCacheDirty,
} from '@db/repositories';
import {
  getMessageStateAuthority,
  applyMessageStateWithinTransaction,
  PROVIDER_REPAIR_BACKOFF_KEY,
  setMessageStateAuthorityWithinTransaction,
} from '@db/repositories/messageState';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { syncProviderMessages } from '@/services/sync/providerRepair';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

const providerEpoch = '11111111-1111-4111-8111-111111111111';
const ledgerEpoch = '22222222-2222-4222-8222-222222222222';
const chatGuid = 'iMessage;-;test@example.test';
const serverInfo = ServerInfo.parse({
  server_version: '2.0.0',
  supports_message_state_sync: true,
  message_state_sync_version: 1,
  imessage_provider_epoch: providerEpoch,
  supports_provider_repair_snapshot: true,
});
const lease: ProviderRepairLease = {
  version: 2,
  action: 'begin',
  provider: 'imessage',
  providerEpoch,
  ledgerEpoch,
  token: '33333333-3333-4333-8333-333333333333',
  expiresAt: 2_000_000_000_000,
  checkpoint: 'snapshot-cursor',
  sequence: '10',
};

describe('provider-scoped repair', () => {
  let db: AppDatabase;
  let raw: Database.Database;
  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
  });
  afterEach(() => raw.close());
  const message = (guid: string, owner = chatGuid) =>
    Message.parse({
      guid,
      dateCreated: 50,
      originalROWID: 3,
      text: 'fixture',
      chats: [{ guid: owner, participants: [{ address: 'test@example.test' }] }],
    });
  async function seed(guid: string, owner = chatGuid) {
    const row = message(guid, owner);
    const handles = await upsertHandles(
      db,
      row.chats!.flatMap((chat) => chat.participants ?? []),
    );
    const chats = await upsertChats(db, row.chats!, handles);
    await upsertMessages(db, [row], () => chats.get(owner), handles);
  }
  function fixture(present: string[] = []) {
    const finish = jest.fn(async () => ({
      version: 2 as const,
      action: 'finish' as const,
      stable: true as const,
      provider: 'imessage' as const,
      providerEpoch,
      ledgerEpoch,
      checkpoint: lease.checkpoint,
      sequence: lease.sequence,
    }));
    const cancel = jest.fn(async () => undefined);
    const base: SyncApi = {
      serverVersion: async () => '2.0.0',
      fetchChats: async () => [],
      fetchChatMessages: async () => [],
      fetchMessagesAfter: async () => [],
      fetchMessageState: async () => ({
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        cursor: 'terminal-cursor',
        events: [],
        hasMore: false,
        prunedThrough: '0',
        sequence: '10',
        boundary: '10',
      }),
    };
    const bound: SyncApi = {
      ...base,
      fetchChats: async (offset) => (offset === 0 ? [Chat.parse({ guid: chatGuid })] : []),
      fetchChatMessages: async (_chat, offset) =>
        offset === 0 ? present.map((guid) => message(guid)) : [],
    };
    const control: SyncApi = {
      ...base,
      beginProviderRepair: async () => lease,
      finishProviderRepair: finish,
      cancelProviderRepair: cancel,
    };
    return {
      base,
      bound,
      control,
      finish,
      cancel,
      run: () =>
        syncProviderMessages(db, {
          api: base,
          controlApi: control,
          bindSnapshot: () => bound,
          serverInfo,
          repair: true,
          shouldAbort: () => false,
        }),
      /** An automatic (not user-started) sync that needs a repair because no authority exists. */
      runAuto: () =>
        syncProviderMessages(db, {
          api: base,
          controlApi: control,
          bindSnapshot: () => bound,
          serverInfo,
          repair: false,
          messagesPerChat: 25,
          shouldAbort: () => false,
        }),
    };
  }
  it('hides only captured absent Apple rows and installs the snapshot boundary', async () => {
    await seed('absent');
    await seed('present');
    await seed('rcs-local', 'RCS;-;old');
    await fixture(['present']).run();
    const rows = raw.prepare('SELECT guid, date_deleted AS d FROM messages ORDER BY guid').all();
    expect(rows).toEqual([
      { guid: 'absent', d: 0 },
      { guid: 'present', d: null },
      { guid: 'rcs-local', d: null },
    ]);
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
    expect((await getMessageStateAuthority(db))?.snapshotSequence).toBe('10');
    expect((await getSyncMarker(db)).lastSyncedRowId).toBe(3);
  });
  it('drains more than ten state pages before a foreground repair reports completion', async () => {
    const f = fixture();
    let sequence = 10;
    const fetch = jest.fn(async () => {
      sequence++;
      return {
        version: 1 as const,
        provider: 'imessage' as const,
        providerEpoch,
        ledgerEpoch,
        cursor: `cursor-${sequence}`,
        events: [
          {
            sequence: String(sequence),
            kind: 'deleted' as const,
            guid: `message-${sequence}`,
            chatGuid: null,
            dateDeleted: 100,
          },
        ],
        hasMore: sequence < 22,
        prunedThrough: '0',
        sequence: String(sequence),
        boundary: '22',
      };
    });
    f.base.fetchMessageState = fetch;
    await f.run();
    expect(fetch).toHaveBeenCalledTimes(12);
    expect((await getMessageStateAuthority(db))?.sequence).toBe('22');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM message_server_states').get()).toEqual({
      count: 12,
    });
  });
  it('allows a later versioned restore of snapshot absence', async () => {
    await seed('absent');
    await fixture().run();
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        sequence: '11',
        kind: 'restored',
        guid: 'absent',
        chatGuid,
        dateDeleted: null,
      }),
    );
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: null });
  });
  it('allows a later scoped snapshot to restore a prior snapshot-only hide', async () => {
    await seed('absent');
    await fixture().run();
    await fixture(['absent']).run();
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: null });
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
  });
  it('rebases old epoch hidden rows and removes ownerless or evicted old receipts', async () => {
    await seed('absent');
    await seed('present');
    const oldLedger = lease.token;
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch: oldLedger,
        cursor: 'old-cursor',
        snapshotSequence: '0',
        sequence: '0',
      }),
    );
    for (const guid of ['absent', 'present', 'evicted'])
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch: oldLedger,
          sequence: '100',
          kind: 'deleted',
          guid,
          chatGuid: guid === 'evicted' ? null : chatGuid,
          dateDeleted: 100,
        }),
      );
    await fixture(['present']).run();
    expect(
      raw
        .prepare(
          'SELECT guid,ledger_epoch AS epoch,kind,sequence FROM message_server_states ORDER BY guid',
        )
        .all(),
    ).toEqual([
      { guid: 'absent', epoch: ledgerEpoch, kind: 'deleted', sequence: '10' },
      { guid: 'present', epoch: ledgerEpoch, kind: 'restored', sequence: '10' },
    ]);
    expect(raw.prepare('SELECT guid,date_deleted AS d FROM messages ORDER BY guid').all()).toEqual([
      { guid: 'absent', d: 100 },
      { guid: 'present', d: null },
    ]);
  });
  it('hydrates a snapshot message whose server deletion receipt had no owner', async () => {
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        cursor: 'old-cursor',
        snapshotSequence: '0',
        sequence: '0',
      }),
    );
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        sequence: '9',
        kind: 'deleted',
        guid: 'present',
        chatGuid: null,
        dateDeleted: 100,
      }),
    );
    await fixture(['present']).run();
    expect(
      raw.prepare('SELECT text,date_deleted AS d FROM messages WHERE guid = ?').get('present'),
    ).toEqual({ text: 'fixture', d: null });
  });
  it('does not hide protected local work when rebasing an old restored state', async () => {
    await seed('local-work');
    const oldLedger = lease.token;
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch: oldLedger,
        cursor: 'old-cursor',
        snapshotSequence: '0',
        sequence: '0',
      }),
    );
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch: oldLedger,
        sequence: '100',
        kind: 'restored',
        guid: 'local-work',
        chatGuid,
        dateDeleted: null,
      }),
    );
    raw.prepare("UPDATE messages SET send_state = 'error' WHERE guid = 'local-work'").run();
    await fixture().run();
    expect(raw.prepare('SELECT date_deleted,send_state FROM messages').get()).toEqual({
      date_deleted: null,
      send_state: 'error',
    });
    expect(raw.prepare('SELECT kind,ledger_epoch FROM message_server_states').get()).toEqual({
      kind: 'restored',
      ledger_epoch: ledgerEpoch,
    });
  });
  it('preserves ambiguous old tombstones even when the message is positively present', async () => {
    await seed('present');
    await markMessageDeleted(db, 'present', 200);
    await fixture(['present']).run();
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: 200 });
  });
  it('does not install authority when finish disagrees with begin', async () => {
    await seed('absent');
    const f = fixture();
    f.finish.mockImplementation(async () => ({
      version: 2,
      action: 'finish',
      stable: true,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch,
      checkpoint: 'wrong',
      sequence: '10',
    }));
    await expect(f.run()).rejects.toThrow('captured boundary');
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: null });
  });
  it('retains the write fence across all network pages', async () => {
    await seed('absent');
    const f = fixture();
    f.bound.fetchChatMessages = async () => {
      await kvSet(db, 'fixture.concurrent', 'writer');
      return [];
    };
    await expect(f.run()).rejects.toThrow();
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(f.cancel).toHaveBeenCalledWith(lease.token);
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: null });
  });
  it('keeps ordinary sync running when a local write interrupts an automatic repair', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await seed('existing');
    await setSyncMarker(db, { lastSyncedRowId: 3, lastSyncedTimestamp: 50 });
    const f = fixture();
    f.bound.fetchChatMessages = async () => {
      await kvSet(db, 'fixture.concurrent', 'writer');
      return [];
    };
    const fetchChats = jest.spyOn(f.base, 'fetchChats');
    const fetchMessagesAfter = jest.spyOn(f.base, 'fetchMessagesAfter');
    const fetchMessageState = jest.spyOn(f.base, 'fetchMessageState');

    await expect(f.runAuto()).resolves.toBeDefined();

    // The chat list refresh and the incremental catch-up still ran after the failed repair.
    expect(fetchChats).toHaveBeenCalled();
    expect(fetchMessagesAfter).toHaveBeenCalled();
    // Without an installed authority, message-state catch-up stays paused.
    expect(fetchMessageState).not.toHaveBeenCalled();
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(f.cancel).toHaveBeenCalledWith(lease.token);
    expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({ date_deleted: null });
    expect(warn).toHaveBeenCalledWith('[sync] provider repair failed; ordinary sync continues', {
      errorName: expect.any(String),
    });
    warn.mockRestore();
  });

  it('runs the first sync with the chosen per-chat limit when a fresh install cannot repair', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const f = fixture();
    f.control.beginProviderRepair = async () => {
      throw new Error('repair_snapshot_changed');
    };
    f.base.fetchChats = async (offset) => (offset === 0 ? [Chat.parse({ guid: chatGuid })] : []);
    const fetchChatMessages = jest.fn(async (_chat: string, offset: number) =>
      offset === 0 ? [message('first-sync-row')] : [],
    );
    f.base.fetchChatMessages = fetchChatMessages;
    const fetchMessagesAfter = jest.spyOn(f.base, 'fetchMessagesAfter');

    await expect(f.runAuto()).resolves.toBeDefined();

    expect(fetchChatMessages).toHaveBeenCalledWith(chatGuid, 0, 25, undefined);
    // A fresh install never pages all history through the incremental cursor.
    expect(fetchMessagesAfter).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT guid FROM messages').all()).toEqual([{ guid: 'first-sync-row' }]);
    expect((await getSyncMarker(db)).lastSyncedRowId).toBe(3);
    expect(await getMessageStateAuthority(db)).toBeNull();
    warn.mockRestore();
  });

  it('does not fail the sync when the ledger demands a repair mid-run that cannot finish', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await seed('existing');
    await setSyncMarker(db, { lastSyncedRowId: 3, lastSyncedTimestamp: 50 });
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, {
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        cursor: 'current-cursor',
        snapshotSequence: '10',
        sequence: '10',
      }),
    );
    const f = fixture();
    const readPage = f.base.fetchMessageState!;
    let stateReads = 0;
    f.base.fetchMessageState = async (cursor, signal) => {
      stateReads += 1;
      if (stateReads === 1) return readPage(cursor, signal);
      throw new MessageStateRepairRequiredError();
    };
    f.control.beginProviderRepair = async () => {
      throw new Error('repair_snapshot_changed');
    };

    await expect(f.runAuto()).resolves.toBeDefined();

    // The stale authority is not read again after its repair failed in this run.
    expect(stateReads).toBe(2);
    warn.mockRestore();
  });

  it('still reports a failed user-run repair after finishing ordinary sync', async () => {
    await seed('existing');
    await setSyncMarker(db, { lastSyncedRowId: 3, lastSyncedTimestamp: 50 });
    const f = fixture();
    f.finish.mockImplementation(async () => ({
      version: 2,
      action: 'finish',
      stable: true,
      provider: 'imessage',
      providerEpoch,
      ledgerEpoch,
      checkpoint: 'wrong',
      sequence: '10',
    }));
    const fetchMessagesAfter = jest.spyOn(f.base, 'fetchMessagesAfter');

    await expect(f.run()).rejects.toThrow('captured boundary');

    expect(fetchMessagesAfter).toHaveBeenCalled();
    expect(await getMessageStateAuthority(db)).toBeNull();
  });

  it('rejects a mixed provider snapshot before absence changes or authority install', async () => {
    const f = fixture();
    f.bound.fetchChats = async (offset) =>
      offset === 0 ? [Chat.parse({ guid: 'RCS;-;old' })] : [];
    await expect(f.run()).rejects.toThrow();
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(f.cancel).toHaveBeenCalled();
  });

  describe('waiting after a failed repair', () => {
    const MINUTE_MS = 60_000;
    const DAY_MS = 24 * 60 * MINUTE_MS;
    let now = 1_800_000_000_000;
    beforeEach(() => {
      now = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      // 0.5 is the midpoint of the ±20% jitter, so waits are exact.
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    function failingRepair() {
      const f = fixture();
      const begin = jest.fn(async (): Promise<ProviderRepairLease> => {
        throw new Error('repair_snapshot_changed');
      });
      f.control.beginProviderRepair = begin;
      return { f, begin };
    }
    const backoff = async () =>
      JSON.parse((await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY)) ?? 'null');

    it('waits 15 minutes after a failed automatic repair, then doubles the wait', async () => {
      await setSyncMarker(db, { lastSyncedRowId: 3, lastSyncedTimestamp: 50 });
      const { f, begin } = failingRepair();
      const fetchMessagesAfter = jest.spyOn(f.base, 'fetchMessagesAfter');

      await f.runAuto();
      expect(begin).toHaveBeenCalledTimes(1);
      expect(await backoff()).toEqual({
        version: 1,
        providerEpoch,
        failures: 1,
        nextAttemptAt: now + 15 * MINUTE_MS,
      });

      now += 14 * MINUTE_MS;
      await f.runAuto();
      expect(begin).toHaveBeenCalledTimes(1);
      // Ordinary sync still runs while the repair waits.
      expect(fetchMessagesAfter).toHaveBeenCalledTimes(2);

      now += 2 * MINUTE_MS;
      await f.runAuto();
      expect(begin).toHaveBeenCalledTimes(2);
      expect((await backoff()).nextAttemptAt).toBe(now + 30 * MINUTE_MS);

      now += 29 * MINUTE_MS;
      await f.runAuto();
      expect(begin).toHaveBeenCalledTimes(2);
    });

    it('never waits longer than a day', async () => {
      const { f } = failingRepair();
      await kvSet(
        db,
        PROVIDER_REPAIR_BACKOFF_KEY,
        JSON.stringify({ version: 1, providerEpoch, failures: 20, nextAttemptAt: now - 1 }),
      );

      await f.runAuto();

      expect(await backoff()).toMatchObject({ failures: 21, nextAttemptAt: now + DAY_MS });
    });

    it('tries again when the stored wait is impossibly far ahead, as after a clock change', async () => {
      const { f, begin } = failingRepair();
      await kvSet(
        db,
        PROVIDER_REPAIR_BACKOFF_KEY,
        JSON.stringify({
          version: 1,
          providerEpoch,
          failures: 3,
          nextAttemptAt: now + 10 * DAY_MS,
        }),
      );

      await f.runAuto();

      expect(begin).toHaveBeenCalledTimes(1);
    });

    it('ignores a wait recorded for a different provider pairing', async () => {
      const { f, begin } = failingRepair();
      await kvSet(
        db,
        PROVIDER_REPAIR_BACKOFF_KEY,
        JSON.stringify({
          version: 1,
          providerEpoch: '99999999-9999-4999-8999-999999999999',
          failures: 4,
          nextAttemptAt: now + 60 * MINUTE_MS,
        }),
      );

      await f.runAuto();

      expect(begin).toHaveBeenCalledTimes(1);
      expect(await backoff()).toMatchObject({ providerEpoch, failures: 1 });
    });

    it('lets a user-started repair skip the wait', async () => {
      const { f, begin } = failingRepair();
      await f.runAuto();

      await expect(f.run()).rejects.toThrow('repair_snapshot_changed');

      expect(begin).toHaveBeenCalledTimes(2);
    });

    it('clears the wait once a repair succeeds', async () => {
      const f = fixture();
      const succeed = f.control.beginProviderRepair!;
      f.control.beginProviderRepair = jest
        .fn<Promise<ProviderRepairLease>, [AbortSignal?]>()
        .mockRejectedValueOnce(new Error('repair_snapshot_changed'))
        .mockImplementation((signal) => succeed(signal));
      await f.runAuto();
      expect(await backoff()).not.toBeNull();

      now += 16 * MINUTE_MS;
      await f.runAuto();

      expect(await getMessageStateAuthority(db)).not.toBeNull();
      expect(await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY)).toBeNull();
    });

    it('forgets a pending wait when changing accounts', async () => {
      await kvSet(
        db,
        PROVIDER_REPAIR_BACKOFF_KEY,
        JSON.stringify({ version: 1, providerEpoch, failures: 1, nextAttemptAt: now + MINUTE_MS }),
      );
      expect(await localCacheDirty(db)).toBe(true);

      await clearLocalCache(db);

      expect(await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY)).toBeNull();
      expect(await localCacheDirty(db)).toBe(false);
    });
  });

  describe('installing deleted-message sync from the checkpoint', () => {
    beforeEach(() => {
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    const changedWhilePreparing = () =>
      new ApiError('bad_request', 'conflict', 409, undefined, undefined, 'repair_snapshot_changed');

    it('installs from the checkpoint on a fresh install without crawling history', async () => {
      const f = fixture();
      const begin = jest.spyOn(f.control, 'beginProviderRepair');
      const crawl = jest.spyOn(f.bound, 'fetchChats');
      const stateReads = jest.spyOn(f.base, 'fetchMessageState');

      await expect(f.runAuto()).resolves.toBeDefined();

      expect(begin).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledWith(lease.token);
      expect(f.finish).not.toHaveBeenCalled();
      expect(crawl).not.toHaveBeenCalled();
      // Deletions after the checkpoint replay right away, advancing the installed cursor.
      expect(stateReads).toHaveBeenCalledWith(lease.checkpoint, undefined);
      expect(await getMessageStateAuthority(db)).toEqual({
        version: 1,
        provider: 'imessage',
        providerEpoch,
        ledgerEpoch,
        cursor: 'terminal-cursor',
        snapshotSequence: lease.sequence,
        sequence: lease.sequence,
      });
    });

    it('treats a phone holding only RCS history as having nothing to check', async () => {
      const rcsChat = 'RCS;-;g1.fixture';
      await seed('rcs-g1.fixture.message', rcsChat);
      const f = fixture();
      const crawl = jest.spyOn(f.bound, 'fetchChats');
      const stateReads = jest.spyOn(f.base, 'fetchMessageState');

      await f.runAuto();

      expect(crawl).not.toHaveBeenCalled();
      expect(stateReads).toHaveBeenCalledWith(lease.checkpoint, undefined);
    });

    it('keeps the full repair when Apple history is already on the phone', async () => {
      await seed('existing');
      const f = fixture(['existing']);
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.runAuto();

      expect(crawl).toHaveBeenCalled();
      expect(f.finish).toHaveBeenCalled();
    });

    it('falls back to the full repair when a message lands before the checkpoint installs', async () => {
      const f = fixture(['late-arrival']);
      const original = f.control.beginProviderRepair!;
      const begin = jest
        .fn<Promise<ProviderRepairLease>, [AbortSignal?]>()
        .mockImplementationOnce(async (signal) => {
          await seed('late-arrival');
          return original(signal);
        })
        .mockImplementation((signal) => original(signal));
      f.control.beginProviderRepair = begin;
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.runAuto();

      expect(begin).toHaveBeenCalledTimes(2);
      expect(crawl).toHaveBeenCalled();
      expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({
        date_deleted: null,
      });
    });

    it('refuses a checkpoint from a different pairing and keeps ordinary sync running', async () => {
      const f = fixture();
      f.control.beginProviderRepair = async () => ({
        ...lease,
        providerEpoch: '99999999-9999-4999-8999-999999999999',
      });
      const firstSync = jest.spyOn(f.base, 'fetchChats');

      await expect(f.runAuto()).resolves.toBeDefined();

      expect(await getMessageStateAuthority(db)).toBeNull();
      expect(await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY)).not.toBeNull();
      expect(firstSync).toHaveBeenCalled();
    });

    it('retries while the server is still preparing, up to three times', async () => {
      const f = fixture();
      const original = f.control.beginProviderRepair!;
      const begin = jest
        .fn<Promise<ProviderRepairLease>, [AbortSignal?]>()
        .mockRejectedValueOnce(changedWhilePreparing())
        .mockRejectedValueOnce(changedWhilePreparing())
        .mockImplementation((signal) => original(signal));
      f.control.beginProviderRepair = begin;
      const stateReads = jest.spyOn(f.base, 'fetchMessageState');

      await f.runAuto();

      expect(begin).toHaveBeenCalledTimes(3);
      expect(stateReads).toHaveBeenCalledWith(lease.checkpoint, undefined);
    });

    it('gives up after three busy answers and waits for the next attempt', async () => {
      const f = fixture();
      const begin = jest.fn(async (): Promise<ProviderRepairLease> => {
        throw changedWhilePreparing();
      });
      f.control.beginProviderRepair = begin;

      await expect(f.runAuto()).resolves.toBeDefined();

      expect(begin).toHaveBeenCalledTimes(3);
      expect(await getMessageStateAuthority(db)).toBeNull();
      expect(await kvGet(db, PROVIDER_REPAIR_BACKOFF_KEY)).not.toBeNull();
    });

    it('still crawls when the user starts a full repair, even on an empty phone', async () => {
      const f = fixture();
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.run();

      expect(crawl).toHaveBeenCalled();
      expect(f.finish).toHaveBeenCalled();
    });
  });
});
