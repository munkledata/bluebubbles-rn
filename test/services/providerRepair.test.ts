import type Database from 'better-sqlite3';
import { Chat, Message, ServerInfo } from '@core/models';
import type { ProviderRepairLease } from '@core/api/endpoints/repairSnapshot';
import {
  upsertChats,
  upsertHandles,
  upsertMessages,
  markMessageDeleted,
  getSyncMarker,
  kvSet,
} from '@db/repositories';
import {
  getMessageStateAuthority,
  applyMessageStateWithinTransaction,
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
  it('rejects a mixed provider snapshot before absence changes or authority install', async () => {
    const f = fixture();
    f.bound.fetchChats = async (offset) =>
      offset === 0 ? [Chat.parse({ guid: 'RCS;-;old' })] : [];
    await expect(f.run()).rejects.toThrow();
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(f.cancel).toHaveBeenCalled();
  });
});
