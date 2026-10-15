import type Database from 'better-sqlite3';
import { Message } from '@core/models';
import {
  MessageStatePage,
  MessageStateChanged,
  type MessageStateAuthority,
  type MessageStateEvent,
} from '@core/models/messageState';
import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import {
  upsertChats,
  upsertContacts,
  upsertHandles,
  upsertMessages,
  markMessageDeleted,
  clearLocalCache,
  localCacheDirty,
  insertOutgoingText,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import {
  applyMessageStateWithinTransaction,
  bindSnapshotMessageOwnersWithinTransaction,
  getMessageStateAuthority,
  setMessageStateAuthorityWithinTransaction,
  restoreSnapshotMessagesWithinTransaction,
  MESSAGE_STATE_AUTHORITY_KEY,
} from '@db/repositories/messageState';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  syncMessageState,
  MessageStateSyncIncompleteError,
} from '@/services/sync/messageStateSync';
import type { SyncApi } from '@/services/sync/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { normalizeRealtimeEvent } from '@core/realtime/eventRouter';
import { createTestDb } from '../support/testDb';
import { kvSet } from '../support/repositoryWrappers';

const providerEpoch = '11111111-1111-4111-8111-111111111111';
const ledgerEpoch = '22222222-2222-4222-8222-222222222222';
const chatGuid = 'iMessage;-;alice@example.test';
const authority: MessageStateAuthority = {
  version: 1,
  provider: 'imessage',
  providerEpoch,
  ledgerEpoch,
  cursor: 'checkpoint-10',
  snapshotSequence: '10',
  sequence: '10',
};
const event = (
  sequence: string,
  kind: MessageStateEvent['kind'],
  guid = 'message-1',
): MessageStateEvent => ({
  sequence,
  kind,
  guid,
  chatGuid,
  dateDeleted: kind === 'deleted' ? 100 : null,
});
const changed = (sequence: string, kind: MessageStateEvent['kind'], guid = 'message-1') => ({
  version: 1 as const,
  provider: 'imessage' as const,
  providerEpoch,
  ledgerEpoch,
  ...event(sequence, kind, guid),
});
const page = (
  events: MessageStateEvent[],
  extra: Partial<MessageStatePage> = {},
): MessageStatePage => ({
  version: 1,
  provider: 'imessage',
  providerEpoch,
  ledgerEpoch,
  events,
  cursor: 'checkpoint-12',
  hasMore: false,
  prunedThrough: '0',
  sequence: events.at(-1)?.sequence ?? '10',
  boundary: events.at(-1)?.sequence ?? '10',
  ...extra,
});
const api = (fetchMessageState: NonNullable<SyncApi['fetchMessageState']>): SyncApi => ({
  serverVersion: async () => '2.0.0',
  fetchChats: async () => [],
  fetchChatMessages: async () => [],
  fetchMessagesAfter: async () => [],
  fetchMessageState,
});

/**
 * A page defect that would repeat at this cursor now asks for a repair (which re-establishes
 * authority from the server's checkpoint) instead of failing every sync; its reason is the cause.
 */
const repairFor = (reason: RegExp) =>
  expect.objectContaining({
    name: 'MessageStateRepairRequiredError',
    cause: expect.objectContaining({ message: expect.stringMatching(reason) }),
  });
describe('versioned message state', () => {
  let db: AppDatabase;
  let raw: Database.Database;
  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, authority),
    );
  });
  afterEach(() => raw.close());
  async function seed(guid = 'message-1'): Promise<void> {
    const message = Message.parse({
      guid,
      dateCreated: 50,
      text: 'fixture',
      chats: [{ guid: chatGuid, participants: [{ address: 'alice@example.test' }] }],
    });
    const handles = await upsertHandles(
      db,
      message.chats!.flatMap((chat) => chat.participants ?? []),
    );
    const chats = await upsertChats(db, message.chats!, handles);
    await upsertMessages(db, [message], () => chats.get(chatGuid), handles);
  }
  const hidden = () =>
    (
      raw.prepare('SELECT date_deleted AS value FROM messages WHERE guid = ?').get('message-1') as {
        value: number | null;
      }
    ).value;
  const apply = (sequence: string, kind: MessageStateEvent['kind']) =>
    withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, changed(sequence, kind)),
    );
  async function evictRetainingOwner(kind: 'ledger' | 'alias') {
    await seed();
    if (kind === 'ledger') await markMessageDeleted(db, 'message-1', 200, undefined, chatGuid);
    else
      raw
        .prepare(
          'INSERT INTO message_guid_aliases(alias_guid,canonical_guid,chat_guid) VALUES (?,?,?)',
        )
        .run('temp-retained-owner', 'message-1', chatGuid);
    raw.prepare('DELETE FROM messages WHERE guid = ?').run('message-1');
  }
  const retainedOwners = () => ({
    ledger: raw.prepare('SELECT * FROM message_deletion_ledger').all(),
    aliases: raw.prepare('SELECT * FROM message_guid_aliases ORDER BY id').all(),
  });

  it.each(['ledger', 'alias'] as const)(
    'rejects a foreign state owner after message eviction with retained %s ownership',
    async (kind) => {
      await evictRetainingOwner(kind);
      const retained = retainedOwners();
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('11', 'deleted'),
          chatGuid: 'iMessage;-;foreign@example.test',
        }),
      );
      expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
      expect(retainedOwners()).toEqual(retained);
      await apply('12', 'restored');
      await seed();
      expect(hidden()).toBe(kind === 'ledger' ? 200 : null);
      expect(raw.prepare('SELECT chat_guid,sequence FROM message_server_states').get()).toEqual({
        chat_guid: chatGuid,
        sequence: '12',
      });
    },
  );
  it.each(['ledger', 'alias'] as const)(
    'rejects foreign hydration without poisoning evicted %s ownership or advancing its cursor',
    async (kind) => {
      await evictRetainingOwner(kind);
      const retained = retainedOwners();
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('12', 'restored'),
          chatGuid: null,
        }),
      );
      const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
      adapter.fetchActiveMessage = async () =>
        Message.parse({
          guid: 'message-1',
          text: 'wrong owner',
          chats: [{ guid: 'iMessage;-;foreign@example.test' }],
        });
      await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toEqual(
        repairFor(/owner conflicts/),
      );
      expect(raw.prepare('SELECT * FROM messages').all()).toEqual([]);
      expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
        chat_guid: null,
      });
      expect(await getMessageStateAuthority(db)).toEqual(authority);
      expect(retainedOwners()).toEqual(retained);
      adapter.fetchActiveMessage = async () =>
        Message.parse({
          guid: 'message-1',
          text: 'correct owner',
          chats: [{ guid: chatGuid }],
        });
      await syncMessageState(db, adapter, { providerEpoch });
      expect(raw.prepare('SELECT text,date_deleted FROM messages').get()).toEqual({
        text: 'correct owner',
        date_deleted: kind === 'ledger' ? 200 : null,
      });
      expect(retainedOwners()).toEqual(retained);
      expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
    },
  );
  it('links a sender that hydration introduces to a saved contact once it commits', async () => {
    await evictRetainingOwner('alias');
    await upsertContacts(db, [
      {
        sourceId: 'bob',
        displayName: 'Bob Saved',
        givenName: 'Bob',
        familyName: 'Saved',
        phones: [],
        emails: ['bob@example.test'],
        avatar: null,
      },
    ]);
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, {
        ...changed('12', 'restored'),
        chatGuid: null,
      }),
    );
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () =>
      Message.parse({
        guid: 'message-1',
        text: 'restored from a new sender',
        handle: { address: 'bob@example.test' },
        chats: [{ guid: chatGuid, participants: [{ address: 'alice@example.test' }] }],
      });

    await syncMessageState(db, adapter, { providerEpoch });

    // The hydration transaction created Bob's handle; linking runs after it commits (M057).
    expect(
      raw
        .prepare('SELECT display_name AS name FROM handles WHERE address = ?')
        .get('bob@example.test'),
    ).toEqual({ name: 'Bob Saved' });
  });

  it.each(['ledger', 'alias'] as const)(
    'rejects foreign snapshot binding without poisoning evicted %s ownership',
    async (kind) => {
      await evictRetainingOwner(kind);
      const retained = retainedOwners();
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('12', 'restored'),
          chatGuid: null,
        }),
      );
      await expect(
        withDbTransaction(db, (context) =>
          bindSnapshotMessageOwnersWithinTransaction(context, [
            { guid: 'message-1', chatGuid: 'iMessage;-;foreign@example.test' },
          ]),
        ),
      ).rejects.toThrow(/owner conflicts/);
      expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
        chat_guid: null,
      });
      expect(retainedOwners()).toEqual(retained);
      await withDbTransaction(db, (context) =>
        bindSnapshotMessageOwnersWithinTransaction(context, [{ guid: 'message-1', chatGuid }]),
      );
      await seed();
      expect(hidden()).toBe(kind === 'ledger' ? 200 : null);
      expect(retainedOwners()).toEqual(retained);
    },
  );
  it('checks every retained canonical alias rather than accepting the first matching owner', async () => {
    for (const [alias, owner] of [
      ['temp-matching-owner', chatGuid],
      ['temp-conflicting-owner', 'iMessage;-;foreign@example.test'],
    ])
      raw
        .prepare(
          'INSERT INTO message_guid_aliases(alias_guid,canonical_guid,chat_guid) VALUES (?,?,?)',
        )
        .run(alias, 'message-1', owner);
    const retained = retainedOwners();
    await apply('11', 'deleted');
    expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
    expect(retainedOwners()).toEqual(retained);
  });

  it('reports a capped boundary as incomplete and resumes from its committed page', async () => {
    const fetch = jest.fn(async (cursor: string | undefined) => {
      const sequence = Number(cursor?.split('-').at(-1)) + 1;
      return page([event(String(sequence), 'deleted', `message-${sequence}`)], {
        cursor: `checkpoint-${sequence}`,
        boundary: '16',
        hasMore: sequence < 16,
      });
    });
    await expect(syncMessageState(db, api(fetch), { providerEpoch })).rejects.toBeInstanceOf(
      MessageStateSyncIncompleteError,
    );
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await getMessageStateAuthority(db))?.sequence).toBe('15');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM message_server_states').get()).toEqual({
      count: 5,
    });
    await expect(syncMessageState(db, api(fetch), { providerEpoch })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith('checkpoint-15', undefined);
    expect((await getMessageStateAuthority(db))?.sequence).toBe('16');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM message_server_states').get()).toEqual({
      count: 6,
    });
  });
  it('rejects invalid page budgets before any request or state write', async () => {
    const fetch = jest.fn(async () => page([]));
    for (const maxPages of [0, -1, 1.5, NaN, Infinity, 1001])
      await expect(syncMessageState(db, api(fetch), { providerEpoch, maxPages })).rejects.toThrow(
        RangeError,
      );
    expect(fetch).not.toHaveBeenCalled();
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });

  it('restores a server deletion without leaving a permanent local receipt', async () => {
    await seed();
    await apply('11', 'deleted');
    expect(hidden()).toBe(100);
    await apply('12', 'restored');
    expect(hidden()).toBeNull();
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
  });
  it('preserves a local or historical message deletion when the server restores it', async () => {
    await seed();
    await markMessageDeleted(db, 'message-1', 200, undefined, chatGuid);
    await apply('11', 'deleted');
    await apply('12', 'restored');
    expect(hidden()).toBe(200);
  });
  it('preserves the local chat history deletion boundary', async () => {
    await seed();
    raw.prepare('UPDATE chats SET history_deleted_at = 250').run();
    await apply('11', 'deleted');
    await apply('12', 'restored');
    expect(hidden()).toBe(250);
  });
  it('does not regress on duplicate or delayed realtime transitions', async () => {
    await seed();
    await apply('12', 'restored');
    await apply('11', 'deleted');
    await apply('12', 'deleted');
    expect(hidden()).toBeNull();
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('retains the restore sequence after message eviction', async () => {
    await seed();
    await apply('12', 'restored');
    raw.prepare('DELETE FROM messages').run();
    await apply('11', 'deleted');
    await seed();
    expect(hidden()).toBeNull();
  });
  it('keeps server deletion separate during outgoing identity promotion', async () => {
    await seed('other');
    await apply('11', 'deleted');
    await insertOutgoingText(db, { tempGuid: 'temp-fixture', chatGuid, text: 'outgoing', now: 50 });
    await reconcileOutgoingSuccess(db, 'temp-fixture', {
      guid: 'message-1',
      dateCreated: 50,
      dateDelivered: null,
    });
    expect(hidden()).toBe(100);
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
    await apply('12', 'restored');
    expect(hidden()).toBeNull();
  });
  it('rejects delayed transitions at or below the snapshot floor', async () => {
    await seed();
    await apply('10', 'deleted');
    expect(hidden()).toBeNull();
  });
  it('stores delete-before-message without a visible resurrection during upsert', async () => {
    await apply('11', 'deleted');
    await seed();
    expect(hidden()).toBe(100);
    await seed();
    expect(hidden()).toBe(100);
  });
  it('refuses foreign epochs and exact chat owner mismatches', async () => {
    await seed();
    for (const payload of [
      { ...changed('11', 'deleted'), ledgerEpoch: providerEpoch },
      { ...changed('11', 'deleted'), chatGuid: 'SMS;-;other' },
    ]) {
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, payload),
      );
    }
    expect(hidden()).toBeNull();
  });
  it('does not use a realtime high sequence as a REST checkpoint', async () => {
    await seed();
    await apply('100', 'restored');
    await syncMessageState(
      db,
      api(async (cursor) => {
        expect(cursor).toBe(authority.cursor);
        return page([event('11', 'deleted'), event('12', 'restored')]);
      }),
      { providerEpoch },
    );
    expect(hidden()).toBeNull();
    expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
    expect(
      (raw.prepare('SELECT sequence FROM message_server_states').get() as { sequence: string })
        .sequence,
    ).toBe('100');
  });
  it('never projects an intermediate restore when the same page ends with deletion', async () => {
    await seed();
    await apply('11', 'deleted');
    raw.exec(`CREATE TABLE observed_visibility (guid TEXT NOT NULL);
      CREATE TRIGGER observe_visible_message AFTER UPDATE OF date_deleted ON messages
      WHEN NEW.date_deleted IS NULL
      BEGIN INSERT INTO observed_visibility(guid) VALUES (NEW.guid); END;`);
    const adapter = api(async () =>
      page([event('11', 'deleted'), event('12', 'restored'), event('13', 'deleted')], {
        cursor: 'checkpoint-13',
      }),
    );
    adapter.fetchActiveMessage = jest.fn(async () => null);
    await syncMessageState(db, adapter, { providerEpoch });
    expect(raw.prepare('SELECT * FROM observed_visibility').all()).toEqual([]);
    expect(adapter.fetchActiveMessage).not.toHaveBeenCalled();
    expect(hidden()).toBe(100);
    expect(raw.prepare('SELECT sequence,kind FROM message_server_states').get()).toEqual({
      sequence: '13',
      kind: 'deleted',
    });
    expect(await getMessageStateAuthority(db)).toEqual({
      ...authority,
      sequence: '13',
      cursor: 'checkpoint-13',
    });
  });
  it('preserves an earlier exact owner when the final page event has no owner', async () => {
    await syncMessageState(
      db,
      api(async () =>
        page([event('11', 'deleted'), { ...event('12', 'deleted'), chatGuid: null }]),
      ),
      { providerEpoch },
    );
    expect(raw.prepare('SELECT chat_guid,sequence,kind FROM message_server_states').get()).toEqual({
      chat_guid: chatGuid,
      sequence: '12',
      kind: 'deleted',
    });
    await seed();
    expect(hidden()).toBe(100);
  });
  it('does not let final ownerless hydration replace an earlier exact page owner', async () => {
    const adapter = api(async () =>
      page([event('11', 'deleted'), { ...event('12', 'restored'), chatGuid: null }]),
    );
    adapter.fetchActiveMessage = async () =>
      Message.parse({
        guid: 'message-1',
        text: 'foreign payload',
        chats: [{ guid: 'iMessage;-;foreign@example.test' }],
      });
    await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toEqual(
      repairFor(/exact provider owner/),
    );
    expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM messages').all()).toEqual([]);
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('rejects conflicting exact owners within a page before hydration or writes', async () => {
    const adapter = api(async () =>
      page(
        [
          event('11', 'deleted'),
          { ...event('12', 'restored'), chatGuid: 'iMessage;-;foreign@example.test' },
          { ...event('13', 'deleted'), chatGuid: null },
        ],
        { cursor: 'checkpoint-13' },
      ),
    );
    adapter.fetchActiveMessage = jest.fn(async () => null);
    await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toEqual(
      repairFor(/conflicting.*owners/),
    );
    expect(adapter.fetchActiveMessage).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('rolls back both the page and checkpoint when a later event fails', async () => {
    await seed();
    raw.exec(
      "CREATE TRIGGER fail_second_state BEFORE INSERT ON message_server_states WHEN NEW.guid = 'message-2' BEGIN SELECT RAISE(ABORT, 'injected page failure'); END",
    );
    const outcome = await syncMessageState(
      db,
      api(async () => page([event('11', 'deleted'), event('12', 'deleted', 'message-2')])),
      { providerEpoch },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      message: 'injected page failure',
    });
    expect({
      states: raw.prepare('SELECT guid,kind,sequence FROM message_server_states').all(),
      cursor: (await getMessageStateAuthority(db))?.cursor,
    }).toEqual({ states: [], cursor: authority.cursor });
    expect(hidden()).toBeNull();
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('rejects reordered or repeated pages before any write', async () => {
    await seed();
    await expect(
      syncMessageState(
        db,
        api(async () => page([event('12', 'deleted'), event('11', 'restored')])),
        { providerEpoch },
      ),
    ).rejects.toEqual(repairFor(/strictly ordered/));
    expect(hidden()).toBeNull();
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('hydrates an old restored message through exact lookup before committing its cursor', async () => {
    const adapter = api(async () => page([event('11', 'restored')]));
    adapter.fetchActiveMessage = jest.fn(async () =>
      Message.parse({ guid: 'message-1', dateCreated: 50, chats: [{ guid: chatGuid }] }),
    );
    await syncMessageState(db, adapter, { providerEpoch });
    expect(hidden()).toBeNull();
    expect(adapter.fetchActiveMessage).toHaveBeenCalledWith('message-1', providerEpoch, undefined);
    expect((await getMessageStateAuthority(db))?.sequence).toBe('11');
  });
  it('skips a restore the Mac no longer has instead of repairing everything', async () => {
    // A recovered conversation deleted again on the Mac answers 404 for its restore events. A
    // later transition hides it again or it is gone; a full repair would skip far more.
    await seed();
    await apply('11', 'deleted');
    const adapter = api(async () => page([event('12', 'restored')]));
    adapter.fetchActiveMessage = async () => null;
    await syncMessageState(db, adapter, { providerEpoch });
    expect(hidden()).toBe(100);
    expect(raw.prepare('SELECT sequence,kind FROM message_server_states').get()).toEqual({
      sequence: '11',
      kind: 'deleted',
    });
    expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
  });
  it('does not hydrate a restoration that a newer stored transition already decides', async () => {
    await seed();
    await apply('13', 'deleted');
    const adapter = api(async () => page([event('12', 'restored')]));
    adapter.fetchActiveMessage = jest.fn(async () => null);
    await syncMessageState(db, adapter, { providerEpoch });
    expect(adapter.fetchActiveMessage).not.toHaveBeenCalled();
    expect(hidden()).toBe(100);
    expect(raw.prepare('SELECT sequence, kind FROM message_server_states').get()).toEqual({
      sequence: '13',
      kind: 'deleted',
    });
    expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
  });
  it('learns an absent restore owner only from exact active hydration', async () => {
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, { ...changed('11', 'deleted'), chatGuid: null }),
    );
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () =>
      Message.parse({ guid: 'message-1', text: 'restored fixture', chats: [{ guid: chatGuid }] });
    await syncMessageState(db, adapter, { providerEpoch });
    expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
      chat_guid: chatGuid,
    });
    expect(hidden()).toBeNull();
    expect(raw.prepare('SELECT text FROM messages WHERE guid = ?').get('message-1')).toEqual({
      text: 'restored fixture',
    });
  });
  it('hydrates an ownerless realtime restore when REST replays the same sequence', async () => {
    await new DbEventSink(db).onEvent(
      { type: 'message-state-changed', payload: { ...changed('12', 'restored'), chatGuid: null } },
      'socket',
    );
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () =>
      Message.parse({ guid: 'message-1', text: 'replayed restore', chats: [{ guid: chatGuid }] });
    await syncMessageState(db, adapter, { providerEpoch });
    expect(raw.prepare('SELECT text, date_deleted FROM messages').get()).toEqual({
      text: 'replayed restore',
      date_deleted: null,
    });
    expect(
      raw.prepare('SELECT chat_guid, sequence, kind FROM message_server_states').get(),
    ).toEqual({
      chat_guid: chatGuid,
      sequence: '12',
      kind: 'restored',
    });
    expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
  });
  it('preserves a newer ownerless deletion arriving during exact restore hydration', async () => {
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, { ...changed('12', 'restored'), chatGuid: null }),
    );
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () => {
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('13', 'deleted'),
          chatGuid: null,
        }),
      );
      return Message.parse({
        guid: 'message-1',
        text: 'hidden restore',
        chats: [{ guid: chatGuid }],
      });
    };
    await syncMessageState(db, adapter, { providerEpoch });
    expect(raw.prepare('SELECT text, date_deleted FROM messages').get()).toEqual({
      text: 'hidden restore',
      date_deleted: 100,
    });
    expect(
      raw.prepare('SELECT chat_guid, sequence, kind FROM message_server_states').get(),
    ).toEqual({
      chat_guid: chatGuid,
      sequence: '13',
      kind: 'deleted',
    });
    expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
  });
  it('does not let a generic equal-sequence event bind an ownerless receipt', async () => {
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, { ...changed('12', 'restored'), chatGuid: null }),
    );
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, changed('12', 'deleted')),
    );
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, changed('12', 'restored')),
    );
    expect(
      raw.prepare('SELECT chat_guid, sequence, kind FROM message_server_states').get(),
    ).toEqual({
      chat_guid: null,
      sequence: '12',
      kind: 'restored',
    });
  });
  it('requests a repair for a restoration that conflicts with an equal-sequence deletion', async () => {
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, { ...changed('12', 'deleted'), chatGuid: null }),
    );
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () =>
      Message.parse({
        guid: 'message-1',
        text: 'conflicting restore',
        chats: [{ guid: chatGuid }],
      });
    // Fail closed without failing every later sync: a repair re-establishes the authority.
    await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toBeInstanceOf(
      MessageStateRepairRequiredError,
    );
    expect(raw.prepare('SELECT * FROM messages').all()).toEqual([]);
    expect(
      raw.prepare('SELECT chat_guid, kind, sequence FROM message_server_states').get(),
    ).toEqual({
      chat_guid: null,
      kind: 'deleted',
      sequence: '12',
    });
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it.each(['providerEpoch', 'ledgerEpoch'] as const)(
    'rejects exact hydration after its %s authority changes',
    async (field) => {
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('12', 'restored'),
          chatGuid: null,
        }),
      );
      const replacement = {
        ...authority,
        [field]: '33333333-3333-4333-8333-333333333333',
        cursor: 'replacement-cursor',
      };
      const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
      adapter.fetchActiveMessage = async () => {
        await withDbTransaction(db, (context) =>
          setMessageStateAuthorityWithinTransaction(context, replacement),
        );
        return Message.parse({
          guid: 'message-1',
          text: 'stale restore',
          chats: [{ guid: chatGuid }],
        });
      };
      await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toThrow();
      expect(raw.prepare('SELECT * FROM messages').all()).toEqual([]);
      expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
        chat_guid: null,
      });
      expect(await getMessageStateAuthority(db)).toEqual(replacement);
    },
  );
  it('rejects exact hydration overtaken by a newer snapshot floor', async () => {
    await withDbTransaction(db, (context) =>
      applyMessageStateWithinTransaction(context, { ...changed('12', 'restored'), chatGuid: null }),
    );
    const replacement = {
      ...authority,
      cursor: 'snapshot-12',
      sequence: '12',
      snapshotSequence: '12',
    };
    const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
    adapter.fetchActiveMessage = async () => {
      await withDbTransaction(db, (context) =>
        setMessageStateAuthorityWithinTransaction(context, replacement),
      );
      return Message.parse({
        guid: 'message-1',
        text: 'pre-snapshot restore',
        chats: [{ guid: chatGuid }],
      });
    };
    await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toThrow();
    expect(raw.prepare('SELECT * FROM messages').all()).toEqual([]);
    expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
      chat_guid: null,
    });
    expect(await getMessageStateAuthority(db)).toEqual(replacement);
  });
  it.each([null, chatGuid])(
    'preserves a local deletion receipt during owner hydration (%s)',
    async (localOwner) => {
      await markMessageDeleted(db, 'message-1', 200, undefined, localOwner ?? undefined);
      const receipt = raw.prepare('SELECT * FROM message_deletion_ledger').all();
      expect(receipt).toHaveLength(1);
      await withDbTransaction(db, (context) =>
        applyMessageStateWithinTransaction(context, {
          ...changed('12', 'restored'),
          chatGuid: null,
        }),
      );
      const adapter = api(async () => page([{ ...event('12', 'restored'), chatGuid: null }]));
      adapter.fetchActiveMessage = async () =>
        Message.parse({
          guid: 'message-1',
          text: 'locally hidden restore',
          chats: [{ guid: chatGuid }],
        });
      await syncMessageState(db, adapter, { providerEpoch });
      expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual(receipt);
      expect(raw.prepare('SELECT date_deleted FROM messages').all()).toEqual(
        localOwner == null ? [] : [{ date_deleted: 200 }],
      );
      expect(raw.prepare('SELECT chat_guid FROM message_server_states').get()).toEqual({
        chat_guid: chatGuid,
      });
      expect((await getMessageStateAuthority(db))?.sequence).toBe('12');
    },
  );
  it('accepts fractional Apple deletion milliseconds but rejects incoherent kind/date pairs', () => {
    expect(
      MessageStateChanged.safeParse({ ...changed('11', 'deleted'), dateDeleted: 978307205000.0001 })
        .success,
    ).toBe(true);
    expect(
      MessageStateChanged.safeParse({ ...changed('11', 'deleted'), dateDeleted: null }).success,
    ).toBe(false);
    expect(
      MessageStateChanged.safeParse({ ...changed('11', 'restored'), dateDeleted: 123 }).success,
    ).toBe(false);
  });
  it('does not advance a cursor on a failed exact restore lookup', async () => {
    const adapter = api(async () => page([event('11', 'restored')]));
    adapter.fetchActiveMessage = async () => {
      throw new Error('lookup unavailable');
    };
    await expect(syncMessageState(db, adapter, { providerEpoch })).rejects.toThrow(
      'lookup unavailable',
    );
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('requires scoped repair for uninitialized or changed provider identity', async () => {
    await expect(
      syncMessageState(
        db,
        api(async () => page([])),
        { providerEpoch: ledgerEpoch },
      ),
    ).rejects.toBeInstanceOf(MessageStateRepairRequiredError);
    await kvSet(db, MESSAGE_STATE_AUTHORITY_KEY, 'bad');
    await expect(
      syncMessageState(
        db,
        api(async () => page([])),
        { providerEpoch },
      ),
    ).rejects.toBeInstanceOf(MessageStateRepairRequiredError);
  });
  it('leaves authority unchanged after account revocation while a response is in flight', async () => {
    await seed();
    let stopped = false;
    await syncMessageState(
      db,
      api(async () => {
        stopped = true;
        return page([event('11', 'deleted')]);
      }),
      { providerEpoch, shouldAbort: () => stopped },
    );
    expect(hidden()).toBeNull();
    expect(await getMessageStateAuthority(db)).toEqual(authority);
  });
  it('restores only server-owned hides for exact positive snapshot rows', async () => {
    await seed();
    await apply('11', 'deleted');
    await withDbTransaction(db, (context) =>
      restoreSnapshotMessagesWithinTransaction(context, [{ guid: 'message-1', chatGuid }], {
        ...authority,
        snapshotSequence: '20',
        sequence: '20',
      }),
    );
    expect(hidden()).toBeNull();
  });
  it('does not overwrite a newer same-ledger transition during snapshot projection', async () => {
    await seed();
    await apply('30', 'deleted');
    await withDbTransaction(db, (context) =>
      restoreSnapshotMessagesWithinTransaction(context, [{ guid: 'message-1', chatGuid }], {
        ...authority,
        snapshotSequence: '20',
        sequence: '20',
      }),
    );
    expect(hidden()).toBe(100);
  });
  it('accepts positive snapshot evidence from a new ledger after server rollback', async () => {
    await seed();
    await apply('30', 'deleted');
    await withDbTransaction(db, (context) =>
      restoreSnapshotMessagesWithinTransaction(context, [{ guid: 'message-1', chatGuid }], {
        ...authority,
        ledgerEpoch: providerEpoch,
        snapshotSequence: '2',
        sequence: '2',
      }),
    );
    expect(hidden()).toBeNull();
  });
  it('ignores legacy deletion delivery once a versioned authority is installed', async () => {
    await seed();
    await new DbEventSink(db).onEvent(
      { type: 'message-deleted', payload: { guid: 'message-1', chatGuid, dateDeleted: 99 } },
      'socket',
    );
    expect(hidden()).toBeNull();
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([]);
  });
  it('clears both state rows and authority when changing accounts', async () => {
    await seed();
    await apply('11', 'deleted');
    expect(await localCacheDirty(db)).toBe(true);
    await clearLocalCache(db);
    expect(await getMessageStateAuthority(db)).toBeNull();
    expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
    expect(await localCacheDirty(db)).toBe(false);
  });
  it('normalizes the new event and preserves full-width decimal sequences', () => {
    const payload = changed('9223372036854775807', 'deleted');
    expect(normalizeRealtimeEvent('message-state-changed', payload)).toEqual({
      type: 'message-state-changed',
      payload,
    });
    expect(
      MessageStateChanged.safeParse({ ...payload, sequence: '9223372036854775808' }).success,
    ).toBe(false);
    expect(MessageStateChanged.safeParse({ ...payload, sequence: '011' }).success).toBe(false);
  });
  it('does not reuse a prior ledger hide when upserting into the current authority', async () => {
    await seed();
    await apply('11', 'deleted');
    await withDbTransaction(db, (context) =>
      setMessageStateAuthorityWithinTransaction(context, {
        ...authority,
        ledgerEpoch: providerEpoch,
      }),
    );
    await seed();
    expect(hidden()).toBeNull();
  });
});
