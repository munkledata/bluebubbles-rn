import type Database from 'better-sqlite3';
import { Chat, Message, ServerInfo } from '@core/models';
import { logger } from '@core/secure';
import type { ProviderRepairLease } from '@core/api/endpoints/repairSnapshot';
import {
  MessageStateRepairRequiredError,
  type MessagePresencePage,
} from '@core/api/endpoints/messageState';
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
  MESSAGE_STATE_AUDIT_KEY,
  PROVIDER_REPAIR_BACKOFF_KEY,
  setMessageStateAuthorityWithinTransaction,
} from '@db/repositories/messageState';
import * as messageStateRepository from '@db/repositories/messageState';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { syncProviderMessages, type ProviderSyncOptions } from '@/services/sync/providerRepair';
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
/** A server that also answers batch presence; its ledger head has moved past the checkpoint. */
const presenceInfo = ServerInfo.parse({
  server_version: '2.0.0',
  supports_message_state_sync: true,
  message_state_sync_version: 1,
  imessage_provider_epoch: providerEpoch,
  supports_provider_repair_snapshot: true,
  supports_message_state_presence: true,
});
const presenceHead = '12';
const presencePage = (results: MessagePresencePage['results']): MessagePresencePage => ({
  version: 1,
  provider: 'imessage',
  providerEpoch,
  ledgerEpoch,
  sequence: presenceHead,
  results,
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
  /** Deletions recorded under an older ledger, as left by a previous pairing's history. */
  async function installOldLedgerDeletions(guids: readonly string[]) {
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
    for (const guid of guids)
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch: oldLedger,
          sequence: '100',
          kind: 'deleted',
          guid,
          chatGuid,
          dateDeleted: 100,
        }),
      );
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
      // The server's typed presence answer agrees with the crawl's present list.
      fetchMessagePresence: async (_epoch, guids) =>
        presencePage(
          guids.map((guid) =>
            present.includes(guid)
              ? { guid, state: 'active' as const, chatGuid }
              : { guid, state: 'absent' as const },
          ),
        ),
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
      /** A user-started Full Repair on a server that answers batch presence. */
      runRepair: (extra: Partial<ProviderSyncOptions> = {}) =>
        syncProviderMessages(db, {
          api: base,
          controlApi: control,
          bindSnapshot: () => bound,
          serverInfo: presenceInfo,
          repair: true,
          messagesPerChat: 25,
          shouldAbort: () => false,
          ...extra,
        }),
      /** An automatic (not user-started) sync that needs a repair because no authority exists. */
      runAuto: (extra: Partial<ProviderSyncOptions> = {}) =>
        syncProviderMessages(db, {
          api: base,
          controlApi: control,
          bindSnapshot: () => bound,
          serverInfo,
          repair: false,
          messagesPerChat: 25,
          shouldAbort: () => false,
          ...extra,
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
  it('keeps ordinary sync running when an automatic repair cannot reach the server', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await seed('existing');
    await setSyncMarker(db, { lastSyncedRowId: 3, lastSyncedTimestamp: 50 });
    const f = fixture();
    f.control.beginProviderRepair = async () => {
      throw new ApiError('no_connection', 'offline');
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

  describe('restarting the sync bookmark from the server', () => {
    const otherProvider = '99999999-9999-4999-8999-999999999999';
    const newest = (guid: string, rowId: number, owner = chatGuid) =>
      Message.parse({
        guid,
        dateCreated: rowId * 10,
        originalROWID: rowId,
        text: 'fixture',
        chats: [{ guid: owner, participants: [{ address: 'test@example.test' }] }],
      });
    /** The chat list names `listed` as newest; the history pass also returns a later arrival. */
    function serverWith(f: ReturnType<typeof fixture>, listed: Message, arrived: Message) {
      f.base.fetchChats = async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: chatGuid,
                participants: [{ address: 'test@example.test' }],
                lastMessage: listed,
              }),
            ]
          : [];
      f.base.fetchChatMessages = async (chat, offset) =>
        chat === chatGuid && offset === 0 ? [arrived, listed] : [];
      return f;
    }
    async function previousProvider(epoch: string) {
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch: epoch,
          ledgerEpoch,
          cursor: 'old-cursor',
          snapshotSequence: '0',
          sequence: '0',
        }),
      );
    }

    it('rebuilds the bookmark from the server after the Messages database changes', async () => {
      await previousProvider(otherProvider);
      await setSyncMarker(db, { lastSyncedRowId: 9_000_000, lastSyncedTimestamp: 90_000_000 });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      const pages = jest.spyOn(f.base, 'fetchChatMessages');

      await f.runAuto();

      // Recent history is refreshed with the user's per-chat limit...
      expect(pages).toHaveBeenCalledWith(chatGuid, 0, 25, undefined);
      // ...and the old database's row numbers no longer decide where sync resumes.
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 120, lastSyncedTimestamp: 1200 });
    });

    it('starts a first sync where the server listed its newest message', async () => {
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));

      await f.runAuto();

      // A message that arrived during the pass stays after the bookmark, so it cannot be skipped.
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 120, lastSyncedTimestamp: 1200 });
    });

    it('keeps the bookmark when only the ledger restarts on the same Messages database', async () => {
      await installOldLedgerDeletions([]);
      await setSyncMarker(db, { lastSyncedRowId: 500, lastSyncedTimestamp: 5000 });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      const pages = jest.spyOn(f.base, 'fetchChatMessages');

      await f.runAuto();

      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 500, lastSyncedTimestamp: 5000 });
      expect(pages).not.toHaveBeenCalled();
    });

    it('rebuilds the bookmark on a later sync when the first refresh after a change fails', async () => {
      await previousProvider(otherProvider);
      await setSyncMarker(db, { lastSyncedRowId: 9_000_000, lastSyncedTimestamp: 90_000_000 });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      const listChats = f.base.fetchChats;
      f.base.fetchChats = async () => {
        throw new Error('connection dropped');
      };

      await expect(f.runAuto()).rejects.toThrow('connection dropped');
      // The old database's bookmark is already gone, so sync can never resume past new rows.
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: null, lastSyncedTimestamp: null });

      f.base.fetchChats = listChats;
      await f.runAuto();
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 120, lastSyncedTimestamp: 1200 });
    });

    it("does not sync from the old database's bookmark while the new one cannot be set up", async () => {
      await previousProvider(otherProvider);
      await setSyncMarker(db, { lastSyncedRowId: 9_000_000, lastSyncedTimestamp: 90_000_000 });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      f.control.beginProviderRepair = async () => {
        throw new ApiError('server_error', 'busy', 503);
      };
      const incremental = jest.spyOn(f.base, 'fetchMessagesAfter');

      await f.runAuto();

      expect(incremental).not.toHaveBeenCalled();
      // The chat list still refreshes each conversation's newest message.
      expect(raw.prepare('SELECT guid FROM messages').all()).toEqual([{ guid: 'listed' }]);

      // Once setup succeeds after its wait, the bookmark restarts from the server.
      f.control.beginProviderRepair = async () => lease;
      const later = Date.now() + 25 * 60 * 60 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      await f.runAuto();
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 120, lastSyncedTimestamp: 1200 });
    });

    it('keeps a bookmark saved before deleted-message sync existed', async () => {
      await setSyncMarker(db, { lastSyncedRowId: 500, lastSyncedTimestamp: 5000 });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      const pages = jest.spyOn(f.base, 'fetchChatMessages');

      await f.runAuto();

      // Without an earlier provider identity there is no sign the Messages database changed.
      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 500, lastSyncedTimestamp: 5000 });
      expect(pages).not.toHaveBeenCalled();
    });

    it('never restarts the bookmark from an RCS conversation', async () => {
      const rcsEpoch = `gpe1_${'A'.repeat(43)}`;
      const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
      const rcsChat = `RCS;-;g1.${rcsEpoch}.${encoded('conversation-a')}`;
      const rcsInfo = ServerInfo.parse({
        server_version: '2.0.0',
        supports_message_state_sync: true,
        message_state_sync_version: 1,
        imessage_provider_epoch: providerEpoch,
        supports_provider_repair_snapshot: true,
        rcs: true,
        supports_rcs_epoch_qualified_ids: true,
        rcs_provider_epoch: rcsEpoch,
      });
      const f = serverWith(fixture(), newest('listed', 120), newest('arrived', 130));
      const appleChats = f.base.fetchChats;
      f.base.fetchChats = async (offset, limit, signal) =>
        offset === 0
          ? [
              ...(await appleChats(offset, limit, signal)),
              Chat.parse({
                guid: rcsChat,
                participants: [{ address: '+15550000001', service: 'RCS' }],
                lastMessage: Message.parse({
                  guid: `rcs-g1.${rcsEpoch}.${encoded('message-a')}`,
                  dateCreated: 999_990,
                  originalROWID: 99_999,
                  text: 'fixture',
                  chats: [{ guid: rcsChat }],
                }),
              }),
            ]
          : [];

      await f.runAuto({ serverInfo: rcsInfo });

      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 120, lastSyncedTimestamp: 1200 });
    });
  });

  describe('routine RCS history refresh', () => {
    const rcsEpoch = `gpe1_${'A'.repeat(43)}`;
    const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
    const rcsChat = (name: string) => `RCS;-;g1.${rcsEpoch}.${encoded(name)}`;
    const rcsInfo = ServerInfo.parse({
      server_version: '2.0.0',
      supports_message_state_sync: true,
      message_state_sync_version: 1,
      imessage_provider_epoch: providerEpoch,
      supports_provider_repair_snapshot: true,
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: rcsEpoch,
    });
    const rcsMessage = (chat: string, id: string, dateCreated: number) =>
      Message.parse({
        guid: `rcs-g1.${rcsEpoch}.${encoded(id)}`,
        dateCreated,
        text: 'fixture',
        chats: [{ guid: chat }],
      });
    /** An ordinary run: current authority and an iMessage bookmark, so incremental sync runs. */
    async function ordinaryRun() {
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          cursor: 'terminal-cursor',
          snapshotSequence: '10',
          sequence: '10',
        }),
      );
      await setSyncMarker(db, { lastSyncedRowId: 100, lastSyncedTimestamp: 1_000 });
    }
    async function storeRcs(chat: string, id: string, dateCreated: number) {
      const row = rcsMessage(chat, id, dateCreated);
      const chats = await upsertChats(db, row.chats!, new Map());
      await upsertMessages(db, [row], () => chats.get(chat), new Map());
    }
    function listing(f: ReturnType<typeof fixture>, rows: { chat: string; newest: Message }[]) {
      f.base.fetchChats = async (offset) =>
        offset === 0
          ? rows.map(({ chat, newest }) =>
              Chat.parse({
                guid: chat,
                participants: [{ address: '+15550000001', service: 'RCS' }],
                lastMessage: newest,
              }),
            )
          : [];
    }

    it('keeps the iMessage catch-up when an RCS conversation cannot be read', async () => {
      await ordinaryRun();
      const busy = rcsChat('busy');
      await storeRcs(busy, 'old', 100);
      const f = fixture();
      listing(f, [{ chat: busy, newest: rcsMessage(busy, 'new', 200) }]);
      f.base.fetchChatMessages = async () => {
        throw new ApiError('no_connection', 'RCS bridge unreachable');
      };
      const catchUp = jest.spyOn(f.base, 'fetchMessagesAfter');

      await expect(f.runAuto({ serverInfo: rcsInfo })).resolves.toBeDefined();
      expect(catchUp).toHaveBeenCalled();
    });

    it('reads only conversations with something new, after the iMessage catch-up', async () => {
      await ordinaryRun();
      const quiet = rcsChat('quiet');
      const active = rcsChat('active');
      const fresh = rcsChat('never-seen');
      const skewed = rcsChat('phone-clock-ahead');
      await storeRcs(quiet, 'quiet-last', 100);
      await storeRcs(active, 'active-old', 100);
      // Sent from a phone whose clock runs ahead: the Mac's newer reply has an earlier date.
      await storeRcs(skewed, 'skewed-sent', 500);
      const f = fixture();
      listing(f, [
        { chat: quiet, newest: rcsMessage(quiet, 'quiet-last', 100) },
        { chat: active, newest: rcsMessage(active, 'active-new', 200) },
        { chat: fresh, newest: rcsMessage(fresh, 'fresh-first', 300) },
        { chat: skewed, newest: rcsMessage(skewed, 'skewed-reply', 400) },
      ]);
      const history = jest.spyOn(f.base, 'fetchChatMessages');
      const catchUp = jest.spyOn(f.base, 'fetchMessagesAfter');

      await f.runAuto({ serverInfo: rcsInfo });

      expect(history.mock.calls.map(([chat]) => chat).sort()).toEqual(
        [active, fresh, skewed].sort(),
      );
      expect(catchUp.mock.invocationCallOrder[0]!).toBeLessThan(
        history.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe('Full Repair on a server with presence answers', () => {
    const history = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        Message.parse({
          guid: `history-${String(index).padStart(3, '0')}`,
          dateCreated: 1_000 + index,
          originalROWID: 1_000 + index,
          text: 'fixture',
          chats: [{ guid: chatGuid, participants: [{ address: 'test@example.test' }] }],
        }),
      );
    /** A busy server: ordinary reads work, but any frozen snapshot changes before it finishes. */
    function busyServer(f: ReturnType<typeof fixture>, messages: Message[]) {
      f.base.fetchChats = async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: chatGuid,
                participants: [{ address: 'test@example.test' }],
                lastMessage: messages.at(-1),
              }),
            ]
          : [];
      f.base.fetchChatMessages = async (chat, offset, limit) =>
        chat === chatGuid ? messages.slice(offset, offset + limit) : [];
      f.finish.mockRejectedValue(new Error('the Mac changed during the snapshot'));
      return f;
    }
    const count = (pattern: string, where = '') =>
      (
        raw
          .prepare(`SELECT COUNT(*) AS n FROM messages WHERE guid LIKE ? ${where}`)
          .get(pattern) as { n: number }
      ).n;

    it('re-downloads every chat and checks deleted messages without a frozen snapshot', async () => {
      await seed('gone');
      await setSyncMarker(db, { lastSyncedRowId: 9_000_000, lastSyncedTimestamp: 90_000_000 });
      const messages = history(150);
      const f = busyServer(fixture(messages.map((message) => message.guid)), messages);
      const snapshot = jest.fn(() => f.bound);

      const result = await f.runRepair({ bindSnapshot: snapshot });

      expect(snapshot).not.toHaveBeenCalled();
      expect(f.finish).not.toHaveBeenCalled();
      expect(count('history-%')).toBe(150);
      expect(
        raw.prepare("SELECT date_deleted AS d FROM messages WHERE guid = 'gone'").get(),
      ).toEqual({
        d: 0,
      });
      // A bookmark that went stale restarts where the server listed its newest message.
      expect(await getSyncMarker(db)).toEqual({
        lastSyncedRowId: 1_149,
        lastSyncedTimestamp: 1_149,
      });
      expect(await kvGet(db, MESSAGE_STATE_AUDIT_KEY)).toBeNull();
      expect(result.repairResult).toBe('checked');
    });

    it('checks every message to the end, beyond the per-sync budget and time limit', async () => {
      for (let index = 0; index < 30; index += 1)
        await seed(`gone-${String(index).padStart(2, '0')}`);
      const f = busyServer(fixture(), history(1));
      const startedAt = Date.now();
      let asked = false;
      jest.spyOn(Date, 'now').mockImplementation(() => startedAt + (asked ? 60_000 : 0));
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        asked = true;
        return original(epoch, guids, signal);
      };

      const result = await f.runRepair({ auditBudget: 10 });

      expect(count('gone-%', 'AND date_deleted IS NOT NULL')).toBe(30);
      expect(result.repairResult).toBe('checked');
    });

    it('reports a deleted-message check the server could not finish', async () => {
      await seed('gone');
      const f = busyServer(fixture(), history(3));
      f.base.fetchMessagePresence = async () => {
        throw new ApiError('server_error', 'busy', 503);
      };

      const result = await f.runRepair();

      expect(result.repairResult).toBe('check-paused');
      expect(count('history-%')).toBe(3);
      expect(await kvGet(db, MESSAGE_STATE_AUDIT_KEY)).not.toBeNull();
    });

    it('keeps RCS history to its bounded refresh', async () => {
      const rcsEpoch = `gpe1_${'A'.repeat(43)}`;
      const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
      const rcsChat = `RCS;-;g1.${rcsEpoch}.${encoded('conversation-a')}`;
      const rcsInfo = ServerInfo.parse({
        server_version: '2.0.0',
        supports_message_state_sync: true,
        message_state_sync_version: 1,
        imessage_provider_epoch: providerEpoch,
        supports_provider_repair_snapshot: true,
        supports_message_state_presence: true,
        rcs: true,
        supports_rcs_epoch_qualified_ids: true,
        rcs_provider_epoch: rcsEpoch,
      });
      const f = busyServer(fixture(), history(2));
      const appleChats = f.base.fetchChats;
      f.base.fetchChats = async (offset, limit, signal) =>
        offset === 0
          ? [
              ...(await appleChats(offset, limit, signal)),
              Chat.parse({
                guid: rcsChat,
                participants: [{ address: '+15550000001', service: 'RCS' }],
              }),
            ]
          : [];
      const pages = jest.spyOn(f.base, 'fetchChatMessages');

      await f.runRepair({ serverInfo: rcsInfo });

      // Only the bounded RCS refresh reads it; the full re-download covers Apple history only.
      expect(pages.mock.calls.filter(([chat]) => chat === rcsChat)).toHaveLength(1);
    });

    it('fails, keeping the bookmark, when a chat cannot be downloaded', async () => {
      await setSyncMarker(db, { lastSyncedRowId: 500, lastSyncedTimestamp: 5_000 });
      const f = busyServer(fixture(), history(3));
      f.base.fetchChatMessages = async () => {
        throw new Error('chat download failed');
      };

      await expect(f.runRepair()).rejects.toThrow();

      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 500, lastSyncedTimestamp: 5_000 });
    });

    it('stores a message whose earlier deletion was recorded without a chat', async () => {
      // This ledger's ownerless deletion from before the repair would keep the message out.
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          cursor: 'old-cursor',
          snapshotSequence: '0',
          sequence: '5',
        }),
      );
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          sequence: '5',
          kind: 'deleted',
          guid: 'history-001',
          chatGuid: null,
          dateDeleted: 5,
        }),
      );
      const messages = history(3);
      const f = busyServer(fixture(messages.map((message) => message.guid)), messages);

      await f.runRepair();

      expect(
        raw.prepare("SELECT date_deleted AS d FROM messages WHERE guid = 'history-001'").get(),
      ).toEqual({ d: null });
      expect(
        raw.prepare('SELECT chat_guid AS chat, kind FROM message_server_states').get(),
      ).toEqual({ chat: chatGuid, kind: 'restored' });
    });

    it('tells the repair screen when it starts checking deleted messages', async () => {
      await seed('gone');
      const phases: string[] = [];
      const f = busyServer(fixture(), history(1));

      await f.runRepair({ onRepairNote: (phase) => phases.push(phase) });

      expect(phases).toEqual(['Checking deleted messages']);
    });

    it('keeps a good bookmark when the server lists no newest message', async () => {
      await setSyncMarker(db, { lastSyncedRowId: 500, lastSyncedTimestamp: 5_000 });
      const messages = history(2);
      const f = busyServer(fixture(messages.map((message) => message.guid)), messages);
      f.base.fetchChats = async (offset) =>
        offset === 0
          ? [Chat.parse({ guid: chatGuid, participants: [{ address: 'test@example.test' }] })]
          : [];

      await f.runRepair();

      expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 500, lastSyncedTimestamp: 5_000 });
    });

    it('keeps the crawl when the adapter cannot ask for presence', async () => {
      const f = fixture();
      delete f.base.fetchMessagePresence;
      const snapshot = jest.fn(() => f.bound);

      const result = await f.runRepair({ bindSnapshot: snapshot });

      expect(snapshot).toHaveBeenCalled();
      expect(result.repairResult).toBe('snapshot');
    });

    it('stops a cancelled Full Repair during its check', async () => {
      for (let index = 0; index < 3; index += 1) await seed(`gone-${index}`);
      let cancelled = false;
      const f = busyServer(fixture(), history(1));
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        cancelled = true;
        return original(epoch, guids, signal);
      };

      await f.runRepair({ shouldAbort: () => cancelled });

      expect(count('gone-%', 'AND date_deleted IS NOT NULL')).toBe(0);
    });

    it('keeps the snapshot crawl on servers without presence answers', async () => {
      const f = fixture();
      const snapshot = jest.fn(() => f.bound);

      const result = await f.runRepair({ serverInfo, bindSnapshot: snapshot });

      expect(snapshot).toHaveBeenCalled();
      expect(result.repairResult).toBe('snapshot');
    });
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

    it('sets up from the checkpoint even with Apple history on the phone', async () => {
      await seed('existing');
      const f = fixture(['existing']);
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.runAuto();

      expect(crawl).not.toHaveBeenCalled();
      expect(f.finish).not.toHaveBeenCalled();
      expect((await getMessageStateAuthority(db))?.snapshotSequence).toBe(lease.sequence);
      expect(raw.prepare('SELECT date_deleted FROM messages').get()).toEqual({
        date_deleted: null,
      });
    });

    it('includes a message that lands before the checkpoint in the recorded check', async () => {
      const f = fixture(['late-arrival']);
      const original = f.control.beginProviderRepair!;
      f.control.beginProviderRepair = jest
        .fn<Promise<ProviderRepairLease>, [AbortSignal?]>()
        .mockImplementationOnce(async (signal) => {
          await seed('late-arrival');
          return original(signal);
        })
        .mockImplementation((signal) => original(signal));
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.runAuto();

      expect(crawl).not.toHaveBeenCalled();
      const lateId = (
        raw.prepare('SELECT id FROM messages WHERE guid = ?').get('late-arrival') as { id: number }
      ).id;
      expect(JSON.parse((await kvGet(db, MESSAGE_STATE_AUDIT_KEY))!)).toMatchObject({
        phase: 'hide',
        throughMessageId: lateId,
      });
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

  describe('recording messages that still need a server check', () => {
    beforeEach(() => {
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    const dates = () =>
      raw.prepare('SELECT guid, date_deleted AS d FROM messages ORDER BY guid').all();
    const record = async () =>
      JSON.parse((await kvGet(db, MESSAGE_STATE_AUDIT_KEY)) ?? 'null') as Record<
        string,
        unknown
      > | null;

    it('sets up an existing install from the checkpoint and hides nothing yet', async () => {
      await seed('absent');
      await seed('present');
      await seed('rcs-local', 'RCS;-;old');
      const f = fixture(['present']);
      const crawl = jest.spyOn(f.bound, 'fetchChats');

      await f.runAuto();

      expect(crawl).not.toHaveBeenCalled();
      // Today's server cannot prove a deletion, so every row keeps its visibility.
      expect(dates()).toEqual([
        { guid: 'absent', d: null },
        { guid: 'present', d: null },
        { guid: 'rcs-local', d: null },
      ]);
      const maxId = (raw.prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number }).id;
      expect(await record()).toEqual({
        version: 1,
        providerEpoch,
        ledgerEpoch,
        snapshotSequence: lease.sequence,
        phase: 'hide',
        afterGuid: null,
        afterMessageId: 0,
        throughMessageId: maxId,
      });
    });

    it('records deletions kept from an older ledger for the restore phase', async () => {
      await seed('kept-hidden');
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
          kind: 'deleted',
          guid: 'kept-hidden',
          chatGuid,
          dateDeleted: 100,
        }),
      );

      await fixture().runAuto();

      expect(await record()).toMatchObject({ ledgerEpoch, phase: 'restore' });
      // The older deletion stays in force until a server check can restore it.
      expect(dates()).toEqual([{ guid: 'kept-hidden', d: 100 }]);
    });

    it('records same-ledger deletions from before a re-setup for the restore phase', async () => {
      await seed('deleted-before');
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          cursor: 'stale-cursor',
          snapshotSequence: '0',
          sequence: '5',
        }),
      );
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          sequence: '5',
          kind: 'deleted',
          guid: 'deleted-before',
          chatGuid,
          dateDeleted: 5,
        }),
      );
      const f = fixture();
      // The server no longer accepts the stored cursor (for example after a credential change),
      // but it does accept the fresh checkpoint it just issued.
      const readPage = f.base.fetchMessageState!;
      f.base.fetchMessageState = async (cursor, signal) => {
        if (cursor === 'stale-cursor') throw new MessageStateRepairRequiredError();
        return readPage(cursor, signal);
      };

      await f.runAuto();

      // The re-setup jumps to checkpoint 10; a restoration between 5 and 10 must be rechecked.
      expect(await record()).toMatchObject({ phase: 'restore', snapshotSequence: lease.sequence });
    });

    it('records nothing to check when the phone holds no Apple history', async () => {
      await seed('rcs-only', 'RCS;-;only');

      await fixture().runAuto();

      expect(await kvGet(db, MESSAGE_STATE_AUDIT_KEY)).toBeNull();
    });

    it('forgets an unfinished check when changing accounts', async () => {
      await kvSet(db, MESSAGE_STATE_AUDIT_KEY, JSON.stringify({ version: 1 }));
      expect(await localCacheDirty(db)).toBe(true);

      await clearLocalCache(db);

      expect(await kvGet(db, MESSAGE_STATE_AUDIT_KEY)).toBeNull();
      expect(await localCacheDirty(db)).toBe(false);
    });
  });

  describe("checking messages with the server's presence answers", () => {
    beforeEach(() => {
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    const dates = () =>
      raw.prepare('SELECT guid, date_deleted AS d FROM messages ORDER BY guid').all();
    const record = async () =>
      JSON.parse((await kvGet(db, MESSAGE_STATE_AUDIT_KEY)) ?? 'null') as {
        phase: string;
        afterMessageId: number;
      } | null;
    const states = () =>
      raw
        .prepare(
          'SELECT guid, ledger_epoch AS epoch, kind, sequence FROM message_server_states ORDER BY guid',
        )
        .all();
    const withPresence = { serverInfo: presenceInfo };

    it('hides only messages the server reports absent, stamped at its reported position', async () => {
      await seed('absent');
      await seed('present');
      await seed('rcs-local', 'RCS;-;old');
      const f = fixture(['present']);
      const lookups = jest.spyOn(f.base, 'fetchMessagePresence');

      await f.runAuto(withPresence);

      expect(dates()).toEqual([
        { guid: 'absent', d: 0 },
        { guid: 'present', d: null },
        { guid: 'rcs-local', d: null },
      ]);
      expect(lookups.mock.calls.map(([, guids]) => [...guids].sort())).toEqual([
        ['absent', 'present'],
      ]);
      expect(states()).toEqual([
        { guid: 'absent', epoch: ledgerEpoch, kind: 'deleted', sequence: presenceHead },
      ]);
      expect(await record()).toBeNull();
    });

    it('leaves ambiguous messages and messages filed in another chat visible', async () => {
      await seed('twin');
      await seed('moved');
      const f = fixture();
      f.base.fetchMessagePresence = async (_epoch, guids) =>
        presencePage(
          guids.map((guid) =>
            guid === 'twin'
              ? { guid, state: 'ambiguous' as const }
              : { guid, state: 'active' as const, chatGuid: 'iMessage;-;elsewhere@example.test' },
          ),
        );

      await f.runAuto(withPresence);

      expect(dates()).toEqual([
        { guid: 'moved', d: null },
        { guid: 'twin', d: null },
      ]);
      expect(await record()).toBeNull();
    });

    it('pauses without advancing while the server is unavailable, then finishes', async () => {
      await seed('gone');
      const f = fixture();
      f.base.fetchMessagePresence = jest
        .fn<Promise<MessagePresencePage>, [string, readonly string[], AbortSignal?]>()
        .mockRejectedValueOnce(
          new ApiError(
            'server_error',
            'busy',
            503,
            undefined,
            undefined,
            'message_state_unavailable',
          ),
        )
        .mockImplementation(async (_epoch, guids) =>
          presencePage(guids.map((guid) => ({ guid, state: 'absent' as const }))),
        );

      await expect(f.runAuto(withPresence)).resolves.toBeDefined();
      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
      expect(await record()).toMatchObject({ phase: 'hide', afterMessageId: 0 });

      await f.runAuto(withPresence);
      expect(dates()).toEqual([{ guid: 'gone', d: 0 }]);
    });

    it('never treats an untyped not-found or a mismatched answer as a deletion', async () => {
      await seed('kept');
      const f = fixture();
      f.base.fetchMessagePresence = async () => {
        throw new ApiError('bad_request', 'not found', 404);
      };
      await f.runAuto(withPresence);
      expect(dates()).toEqual([{ guid: 'kept', d: null }]);

      f.base.fetchMessagePresence = async () =>
        presencePage([{ guid: 'some-other-guid', state: 'absent' as const }]);
      await f.runAuto(withPresence);
      expect(dates()).toEqual([{ guid: 'kept', d: null }]);
      expect(await record()).toMatchObject({ afterMessageId: 0 });
    });

    it('does nothing until the server advertises presence answers', async () => {
      await seed('gone');
      const f = fixture();
      const lookups = jest.spyOn(f.base, 'fetchMessagePresence');

      await f.runAuto();

      expect(lookups).not.toHaveBeenCalled();
      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
      expect(await record()).not.toBeNull();
    });

    it('resumes across runs within the per-run budget', async () => {
      for (let index = 0; index < 12; index += 1)
        await seed(`gone-${String(index).padStart(2, '0')}`);
      const f = fixture();
      const hidden = () =>
        (
          raw
            .prepare('SELECT COUNT(*) AS n FROM messages WHERE date_deleted IS NOT NULL')
            .get() as {
            n: number;
          }
        ).n;

      await f.runAuto({ ...withPresence, auditBudget: 5 });
      expect(hidden()).toBe(5);
      await f.runAuto({ ...withPresence, auditBudget: 5 });
      expect(hidden()).toBe(10);
      await f.runAuto({ ...withPresence, auditBudget: 5 });
      expect(hidden()).toBe(12);
      expect(await record()).toBeNull();
    });

    it('never hides a message kept for a reminder', async () => {
      await seed('kept-for-reminder');
      raw
        .prepare(
          `INSERT INTO reminders (message_guid, chat_guid, scheduled_for, notification_id)
           VALUES ('kept-for-reminder', ?, 1, 'fixture-reminder')`,
        )
        .run(chatGuid);

      await fixture().runAuto(withPresence);

      expect(dates()).toEqual([{ guid: 'kept-for-reminder', d: null }]);
    });

    it('lets a later ledger transition outrank its mark, but not an older one', async () => {
      await seed('gone');
      await fixture().runAuto(withPresence);
      expect(dates()).toEqual([{ guid: 'gone', d: 0 }]);

      const transition = (sequence: string) =>
        withDbTransaction(db, (context) =>
          applyMessageStateWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch,
            ledgerEpoch,
            sequence,
            kind: 'restored',
            guid: 'gone',
            chatGuid,
            dateDeleted: null,
          }),
        );
      await transition('11');
      expect(dates()).toEqual([{ guid: 'gone', d: 0 }]);
      await transition('13');
      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
    });

    it('restores older-ledger deletions the server still has and keeps absent ones hidden', async () => {
      await seed('absent');
      await seed('present');
      await installOldLedgerDeletions(['absent', 'present']);

      await fixture(['present']).runAuto(withPresence);

      expect(dates()).toEqual([
        { guid: 'absent', d: 100 },
        { guid: 'present', d: null },
      ]);
      expect(states()).toEqual([
        { guid: 'absent', epoch: ledgerEpoch, kind: 'deleted', sequence: presenceHead },
        { guid: 'present', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
      ]);
      expect(await record()).toBeNull();
    });

    it('restores same-ledger deletions from before a re-setup that the server still has', async () => {
      await seed('restored-in-gap');
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          cursor: 'stale-cursor',
          snapshotSequence: '0',
          sequence: '5',
        }),
      );
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          sequence: '5',
          kind: 'deleted',
          guid: 'restored-in-gap',
          chatGuid,
          dateDeleted: 5,
        }),
      );
      const f = fixture(['restored-in-gap']);
      const readPage = f.base.fetchMessageState!;
      f.base.fetchMessageState = async (cursor, signal) => {
        if (cursor === 'stale-cursor') throw new MessageStateRepairRequiredError();
        return readPage(cursor, signal);
      };

      await f.runAuto(withPresence);

      expect(dates()).toEqual([{ guid: 'restored-in-gap', d: null }]);
      expect(states()).toEqual([
        { guid: 'restored-in-gap', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
      ]);
    });

    it('never rebases an older-ledger receipt it did not check', async () => {
      const guids = Array.from({ length: 26 }, (_, index) => `g-${String(index).padStart(2, '0')}`);
      for (const guid of guids) await seed(guid);
      await installOldLedgerDeletions(guids);
      const f = fixture(guids);
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, requested, signal) => {
        // A realtime transition moves a planned receipt into the new ledger mid-check.
        await withDbTransaction(db, (context) =>
          applyMessageStateWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch,
            ledgerEpoch,
            sequence: '11',
            kind: 'deleted',
            guid: 'g-00',
            chatGuid,
            dateDeleted: 11,
          }),
        );
        return original(epoch, requested, signal);
      };

      await f.runAuto({ ...withPresence, auditBudget: 25 });

      const unplanned = raw
        .prepare('SELECT ledger_epoch AS epoch FROM message_server_states WHERE guid = ?')
        .get('g-25') as { epoch: string };
      expect(unplanned.epoch).not.toBe(ledgerEpoch);
    });

    it('discards a batch whose authority was replaced while it was being checked', async () => {
      await seed('gone');
      const f = fixture();
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        await withDbTransaction(db, (context) =>
          setMessageStateAuthorityWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch,
            ledgerEpoch: '44444444-4444-4444-8444-444444444444',
            cursor: 'replaced-cursor',
            snapshotSequence: '20',
            sequence: '20',
          }),
        );
        return original(epoch, guids, signal);
      };

      await f.runAuto(withPresence);

      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
    });

    it('never moves an earlier deletion to the chat the server names instead', async () => {
      await staleDeletion('filed-here', chatGuid);
      const f = afterStaleCursor(fixture());
      f.base.fetchMessagePresence = async (_epoch, guids) =>
        presencePage(
          guids.map((guid) => ({ guid, state: 'active' as const, chatGuid: elsewhere })),
        );

      await f.runAuto(withPresence);

      expect(
        raw.prepare('SELECT chat_guid AS chat, kind, sequence FROM message_server_states').get(),
      ).toEqual({ chat: chatGuid, kind: 'deleted', sequence: '5' });
    });

    it('never gives an ownerless deletion a chat other than its local message', async () => {
      await seed('local-here');
      await staleDeletion('local-here', null);
      // An ownerless record beside a local row, as left by an older version.
      raw.prepare('UPDATE message_server_states SET chat_guid = NULL').run();
      const f = afterStaleCursor(fixture());
      f.base.fetchMessagePresence = async (_epoch, guids) =>
        presencePage(
          guids.map((guid) => ({ guid, state: 'active' as const, chatGuid: elsewhere })),
        );

      await f.runAuto(withPresence);

      expect(
        raw.prepare('SELECT chat_guid AS chat, kind FROM message_server_states').get(),
      ).toEqual({ chat: null, kind: 'deleted' });
    });

    it('keeps an older-ledger deletion hidden when the server files the message elsewhere', async () => {
      await seed('moved-away');
      await installOldLedgerDeletions(['moved-away']);
      const f = fixture();
      f.base.fetchMessagePresence = async (_epoch, guids) =>
        presencePage(
          guids.map((guid) => ({ guid, state: 'active' as const, chatGuid: elsewhere })),
        );

      await f.runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'moved-away', epoch: lease.token, kind: 'deleted', sequence: '100' },
      ]);
      expect(dates()).toEqual([{ guid: 'moved-away', d: 100 }]);
    });

    it('discards a restore batch whose authority was replaced while it was being checked', async () => {
      await seed('kept');
      await installOldLedgerDeletions(['kept']);
      const f = fixture(['kept']);
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        await withDbTransaction(db, (context) =>
          setMessageStateAuthorityWithinTransaction(context, {
            version: 1,
            provider: 'imessage',
            providerEpoch,
            ledgerEpoch: '44444444-4444-4444-8444-444444444444',
            cursor: 'replaced-cursor',
            snapshotSequence: '20',
            sequence: '20',
          }),
        );
        return original(epoch, guids, signal);
      };

      await f.runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'kept', epoch: lease.token, kind: 'deleted', sequence: '100' },
      ]);
      expect(dates()).toEqual([{ guid: 'kept', d: 100 }]);
    });

    it('a user-started Full Repair clears a pending check', async () => {
      await seed('existing');
      await kvSet(
        db,
        MESSAGE_STATE_AUDIT_KEY,
        JSON.stringify({
          version: 1,
          providerEpoch,
          ledgerEpoch,
          snapshotSequence: '10',
          phase: 'hide',
          afterGuid: null,
          afterMessageId: 0,
          throughMessageId: 1,
        }),
      );

      await fixture(['existing']).run();

      expect(await kvGet(db, MESSAGE_STATE_AUDIT_KEY)).toBeNull();
    });

    /** This ledger's deletion recorded before a re-setup, as an earlier sync left it. */
    async function staleDeletion(guid: string, owner: string | null) {
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          cursor: 'stale-cursor',
          snapshotSequence: '0',
          sequence: '5',
        }),
      );
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch,
          sequence: '5',
          kind: 'deleted',
          guid,
          chatGuid: owner,
          dateDeleted: 5,
        }),
      );
    }
    /** A server that pruned the phone's cursor, so the next sync sets up from its checkpoint. */
    function afterStaleCursor(f: ReturnType<typeof fixture>) {
      const readPage = f.base.fetchMessageState!;
      f.base.fetchMessageState = async (cursor, signal) => {
        if (cursor === 'stale-cursor') throw new MessageStateRepairRequiredError();
        return readPage(cursor, signal);
      };
      return f;
    }
    const otherLedger = '55555555-5555-4555-8555-555555555555';
    const elsewhere = 'iMessage;-;elsewhere@example.test';

    it('restores an earlier deletion of a message the phone never downloaded', async () => {
      await staleDeletion('never-downloaded', chatGuid);

      await afterStaleCursor(fixture(['never-downloaded'])).runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'never-downloaded', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
      ]);
      // Opening the chat later downloads it visible instead of born hidden.
      await seed('never-downloaded');
      expect(dates()).toEqual([{ guid: 'never-downloaded', d: null }]);
    });

    it('gives an ownerless earlier deletion the chat the server reports, then restores it', async () => {
      await staleDeletion('ownerless', null);

      await afterStaleCursor(fixture(['ownerless'])).runAuto(withPresence);

      expect(
        raw.prepare('SELECT chat_guid AS chat, kind FROM message_server_states').get(),
      ).toEqual({ chat: chatGuid, kind: 'restored' });
      await seed('ownerless');
      expect(dates()).toEqual([{ guid: 'ownerless', d: null }]);
    });

    it('leaves an ownerless deletion alone when retained history names another chat', async () => {
      await staleDeletion('claimed', null);
      raw
        .prepare(
          'INSERT INTO message_deletion_ledger (guid, chat_guid, date_deleted) VALUES (?, ?, 1)',
        )
        .run('claimed', 'iMessage;-;other@example.test');

      await afterStaleCursor(fixture(['claimed'])).runAuto(withPresence);

      expect(
        raw.prepare('SELECT chat_guid AS chat, kind FROM message_server_states').get(),
      ).toEqual({ chat: null, kind: 'deleted' });
    });

    it('settles nothing in a batch whose message arrived while the server was asked', async () => {
      await seed('held');
      await installOldLedgerDeletions(['arrives-late', 'held']);
      const f = fixture(['arrives-late', 'held']);
      const original = f.base.fetchMessagePresence!;
      let downloaded = false;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        if (!downloaded) {
          downloaded = true;
          await seed('arrives-late');
        }
        return original(epoch, guids, signal);
      };

      await f.runAuto(withPresence);
      // It was never asked about, so its batch is dropped instead of hiding the new arrival.
      expect(dates()).toEqual([
        { guid: 'arrives-late', d: null },
        { guid: 'held', d: 100 },
      ]);
      expect(
        raw
          .prepare('SELECT guid, ledger_epoch AS epoch FROM message_server_states ORDER BY guid')
          .all(),
      ).toEqual([
        { guid: 'arrives-late', epoch: lease.token },
        { guid: 'held', epoch: lease.token },
      ]);

      await f.runAuto(withPresence);
      expect(dates()).toEqual([
        { guid: 'arrives-late', d: null },
        { guid: 'held', d: null },
      ]);
      expect(states()).toEqual([
        { guid: 'arrives-late', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
        { guid: 'held', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
      ]);
    });

    it('leaves an older-ledger deletion it cannot settle in its old ledger', async () => {
      await seed('unsure');
      await installOldLedgerDeletions(['unsure']);
      const f = fixture();
      f.base.fetchMessagePresence = async (_epoch, guids) =>
        presencePage(guids.map((guid) => ({ guid, state: 'ambiguous' as const })));

      await f.runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'unsure', epoch: lease.token, kind: 'deleted', sequence: '100' },
      ]);
      expect(dates()).toEqual([{ guid: 'unsure', d: 100 }]);
      expect(await record()).toBeNull();
    });

    it("moves an older-ledger restoration to the checkpoint, not the answer's newer position", async () => {
      await seed('asked');
      await seed('was-restored');
      await installOldLedgerDeletions(['asked', 'was-restored']);
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          version: 1,
          provider: 'imessage',
          providerEpoch,
          ledgerEpoch: lease.token,
          sequence: '101',
          kind: 'restored',
          guid: 'was-restored',
          chatGuid,
          dateDeleted: null,
        }),
      );

      // The server still has both; only 'asked' carries a deletion that needs its answer.
      await fixture(['asked', 'was-restored']).runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'asked', epoch: ledgerEpoch, kind: 'restored', sequence: presenceHead },
        { guid: 'was-restored', epoch: ledgerEpoch, kind: 'restored', sequence: lease.sequence },
      ]);
    });

    it('ignores an answer from another ledger while settling retained deletions', async () => {
      await seed('kept');
      await installOldLedgerDeletions(['kept']);
      const f = fixture();
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => ({
        ...(await original(epoch, guids, signal)),
        ledgerEpoch: otherLedger,
      });

      await f.runAuto(withPresence);

      expect(states()).toEqual([
        { guid: 'kept', epoch: lease.token, kind: 'deleted', sequence: '100' },
      ]);
      expect(await record()).toMatchObject({ phase: 'restore', afterGuid: null });
    });

    it('ignores an answer from another ledger while checking visible messages', async () => {
      await seed('visible');
      const f = fixture();
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => ({
        ...(await original(epoch, guids, signal)),
        ledgerEpoch: otherLedger,
      });

      await f.runAuto(withPresence);

      expect(dates()).toEqual([{ guid: 'visible', d: null }]);
      expect(await record()).toMatchObject({ phase: 'hide', afterMessageId: 0 });
    });

    it('rolls back a hide batch when the sync is stopped while it is written', async () => {
      await seed('gone');
      let stopped = false;
      const hide = messageStateRepository.hideSnapshotMessagesWithinTransaction;
      jest
        .spyOn(messageStateRepository, 'hideSnapshotMessagesWithinTransaction')
        .mockImplementation(async (...args) => {
          stopped = true;
          return hide(...args);
        });

      await fixture().runAuto({ ...withPresence, shouldAbort: () => stopped });

      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
      expect(await record()).toMatchObject({ phase: 'hide', afterMessageId: 0 });
    });

    it('never asks about local sends, RCS conversations or very recent unconfirmed sends', async () => {
      await seed('temp-local-send');
      await seed('plain-guid-in-rcs', 'RCS;-;someone@example.test');
      const sent = Message.parse({
        guid: 'just-sent',
        isFromMe: true,
        dateCreated: Date.now(),
        text: 'fixture',
        chats: [{ guid: chatGuid, participants: [{ address: 'test@example.test' }] }],
      });
      const handles = await upsertHandles(db, [{ address: 'test@example.test' }]);
      const chats = await upsertChats(db, sent.chats!, handles);
      await upsertMessages(db, [sent], () => chats.get(chatGuid), handles);
      await seed('checked');
      const f = fixture();
      const lookups = jest.spyOn(f.base, 'fetchMessagePresence');

      await f.runAuto(withPresence);

      expect(lookups.mock.calls.flatMap(([, guids]) => [...guids])).toEqual(['checked']);
      expect(dates()).toEqual([
        { guid: 'checked', d: 0 },
        { guid: 'just-sent', d: null },
        { guid: 'plain-guid-in-rcs', d: null },
        { guid: 'temp-local-send', d: null },
      ]);
    });

    it('pauses when the server says the pairing needs a repair', async () => {
      await seed('gone');
      const f = fixture();
      f.base.fetchMessagePresence = async () => {
        throw new MessageStateRepairRequiredError();
      };

      await f.runAuto(withPresence);

      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
      expect(await record()).toMatchObject({ phase: 'hide', afterMessageId: 0 });
    });

    it('writes nothing once the sync is cancelled during a check', async () => {
      await seed('gone');
      let stopped = false;
      const f = fixture();
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        stopped = true;
        return original(epoch, guids, signal);
      };

      await f.runAuto({ ...withPresence, shouldAbort: () => stopped });

      expect(dates()).toEqual([{ guid: 'gone', d: null }]);
      expect(await record()).toMatchObject({ phase: 'hide', afterMessageId: 0 });
    });

    it("counts every retained receipt it visits against the run's budget", async () => {
      const guids = Array.from(
        { length: 30 },
        (_, index) => `evicted-${String(index).padStart(2, '0')}`,
      );
      // None is on the phone, so each retires without a question to the server.
      await installOldLedgerDeletions(guids);
      const remaining = () =>
        (raw.prepare('SELECT COUNT(*) AS n FROM message_server_states').get() as { n: number }).n;

      await fixture().runAuto({ ...withPresence, auditBudget: 10 });

      expect(remaining()).toBe(20);
    });

    it('never sends a message id the server would reject', async () => {
      const long = `long-${'x'.repeat(300)}`;
      await seed(long);
      await seed('normal');
      const f = fixture();
      const lookups = jest.spyOn(f.base, 'fetchMessagePresence');

      await f.runAuto(withPresence);

      expect(lookups.mock.calls.flatMap(([, guids]) => [...guids])).toEqual(['normal']);
      expect(dates()).toEqual([
        { guid: long, d: null },
        { guid: 'normal', d: 0 },
      ]);
      expect(await record()).toBeNull();
    });

    it('stops checking at its time limit and resumes on a later sync', async () => {
      await seed('old');
      await installOldLedgerDeletions(['old']);
      await seed('visible');
      const startedAt = Date.now();
      let asked = false;
      jest.spyOn(Date, 'now').mockImplementation(() => startedAt + (asked ? 60_000 : 0));
      const f = fixture(['old']);
      const original = f.base.fetchMessagePresence!;
      f.base.fetchMessagePresence = async (epoch, guids, signal) => {
        asked = true;
        return original(epoch, guids, signal);
      };

      await f.runAuto(withPresence);

      expect(await record()).toMatchObject({ phase: 'restore', afterGuid: 'old' });
      expect(dates()).toEqual([
        { guid: 'old', d: null },
        { guid: 'visible', d: null },
      ]);
    });
  });
});
