/**
 * Regression: a handle's identity is (address, service), mirroring Apple's chat.db.
 *
 * Before this, handles were keyed by address alone and every upsert overwrote the row's
 * `service` (last-writer-wins) — so an SMS from a person flipped their iMessage chat's
 * badge to SMS until the next iMessage flipped it back (the tile + chat-header flicker).
 * These tests ingest the same address on both services and assert each chat keeps its
 * own service-correct participant links and badge.
 */
import { Chat, Message } from '@core/models';
import {
  getChatHeader,
  handleMapKey,
  listMessagesWithSenders,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { resolveChatService } from '@utils';
import { createTestDb } from '../support/testDb';

const ADDR = '+15550001111';

function chatWith(guid: string, service: string) {
  return Chat.parse({ guid, participants: [{ address: ADDR, service }] });
}

describe('handle (address, service) identity', () => {
  it('keeps separate rows per service and maps each key to its own id', async () => {
    const { db, raw } = await createTestDb();
    const map = await upsertHandles(db, [
      { address: ADDR, service: 'iMessage' },
      { address: ADDR, service: 'SMS' },
    ]);
    expect(map.size).toBe(2);
    const iMsgId = map.get(handleMapKey({ address: ADDR, service: 'iMessage' }));
    const smsId = map.get(handleMapKey({ address: ADDR, service: 'SMS' }));
    expect(iMsgId).toBeGreaterThan(0);
    expect(smsId).toBeGreaterThan(0);
    expect(iMsgId).not.toBe(smsId);
    const count = raw.prepare('SELECT COUNT(*) c FROM handles WHERE address = ?').get(ADDR) as {
      c: number;
    };
    expect(count.c).toBe(2);
  });

  it('an SMS message from the same person no longer flips an iMessage chat to SMS', async () => {
    const { db } = await createTestDb();
    const imGuid = `iMessage;-;${ADDR}`;

    // Sync the iMessage thread.
    const handles1 = await upsertHandles(db, [{ address: ADDR, service: 'iMessage' }]);
    await upsertChats(db, [chatWith(imGuid, 'iMessage')], handles1);

    // A plain SMS arrives from the same number (its own thread, SMS handle) — this used
    // to overwrite the shared handle row's service and flip the iMessage chat's badge.
    const handles2 = await upsertHandles(db, [{ address: ADDR, service: 'SMS' }]);
    await upsertChats(db, [chatWith(`SMS;-;${ADDR}`, 'SMS')], handles2);

    const header = await getChatHeader(db, imGuid);
    expect(header?.handleServices).toBe('iMessage');
    expect(resolveChatService(imGuid, header?.handleServices)).toBe('iMessage');
  });

  it('the shortcode override still works: iMessage-guid chat with SMS-only handles reads SMS', async () => {
    const { db } = await createTestDb();
    const guid = 'iMessage;-;433768';
    const handles = await upsertHandles(db, [{ address: '433768', service: 'SMS' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid, participants: [{ address: '433768', service: 'SMS' }] })],
      handles,
    );
    const header = await getChatHeader(db, guid);
    expect(resolveChatService(guid, header?.handleServices)).toBe('SMS');
  });

  it('a sender on a second service does NOT relink the same person into the chat twice', async () => {
    const { db, raw } = await createTestDb();
    const imGuid = `iMessage;-;${ADDR}`;

    // Chat synced with the iMessage participant …
    const handles1 = await upsertHandles(db, [{ address: ADDR, service: 'iMessage' }]);
    const chatMap = await upsertChats(db, [chatWith(imGuid, 'iMessage')], handles1);
    const chatId = chatMap.get(imGuid)!;

    // … then an SMS-fallback message from the SAME person arrives in that chat.
    const handles2 = await upsertHandles(db, [{ address: ADDR, service: 'SMS' }]);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'sms-1',
          text: 'sent as text',
          dateCreated: 2000,
          handle: { address: ADDR, service: 'SMS' },
        }),
      ],
      () => chatId,
      handles2,
    );

    // Still ONE participant link — the tile collage/name list shows the person once.
    const links = raw
      .prepare('SELECT COUNT(*) c FROM chat_handles WHERE chat_id = ?')
      .get(chatId) as { c: number };
    expect(links.c).toBe(1);
    const header = await getChatHeader(db, imGuid);
    expect(header?.participantCount).toBe(1);
  });

  it('sender-linking still populates a chat whose participants never synced', async () => {
    const { db, raw } = await createTestDb();
    // Realtime-created chat: no participants payload, so no links yet.
    const handles = await upsertHandles(db, [{ address: ADDR, service: 'iMessage' }]);
    const chatMap = await upsertChats(db, [Chat.parse({ guid: 'live-1' })], handles);
    const chatId = chatMap.get('live-1')!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'lm-1',
          text: 'hey',
          dateCreated: 1000,
          handle: { address: ADDR, service: 'iMessage' },
        }),
      ],
      () => chatId,
      handles,
    );
    const links = raw
      .prepare('SELECT COUNT(*) c FROM chat_handles WHERE chat_id = ?')
      .get(chatId) as { c: number };
    expect(links.c).toBe(1);
  });

  it("a service-less handle stores '' but reads back as a null senderService", async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: ADDR }]); // no service on the payload
    const chatMap = await upsertChats(
      db,
      [Chat.parse({ guid: 'c1', participants: [{ address: ADDR }] })],
      handles,
    );
    const chatId = chatMap.get('c1')!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm1', text: 'hi', dateCreated: 1000, handle: { address: ADDR } })],
      () => chatId,
      handles,
    );
    const rows = await listMessagesWithSenders(db, chatId);
    expect(rows).toHaveLength(1);
    // NULLIF('') → null, so the bubble's chat-service fallback still applies.
    expect(rows[0]!.senderService).toBeNull();
    expect(rows[0]!.handleId).not.toBeNull(); // the sender resolved through the composite key
  });
});
