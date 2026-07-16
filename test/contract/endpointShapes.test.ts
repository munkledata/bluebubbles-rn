import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod/v4';
import type { HttpClient } from '@core/api/http';
import {
  MessageList,
  SendAck,
  UnsendAck,
  queryMessages,
  sendText,
  unsendMessage,
} from '@core/api/endpoints/messages';
import { ChatList, createChat, getChat, queryChats } from '@core/api/endpoints/chats';
import { answerFaceTime, createFaceTimeLink, leaveFaceTime } from '@core/api/endpoints/facetime';
import { registerDevice } from '@core/api/endpoints/fcm';

/**
 * Endpoint-shape contract gate. The entity-level wire contract (wireContract.test.ts)
 * only proved the app models the server's ENTITIES; it missed the wrapper layer — Gator
 * wraps responses in named keys ({ chats }, { messages }) and returns status/ack objects
 * ({ guid, viaPrivateApi }, { unsent }, { answered }, { id }) rather than bare entities.
 * These goldens mirror the actual `bbd/src/api/operations/*` + MessageSender returns
 * (post {status,message,data} unwrap), so a wrapper/ack divergence the app doesn't model
 * fails CI here instead of shipping (as it did before this audit).
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'contract', 'v1', name), 'utf8'),
  );
}

/** A fake HttpClient that ignores path/schema and returns the given pre-parsed payload,
 *  but still runs it through the endpoint's schema (so a schema mismatch throws). */
function httpReturning(payload: unknown): HttpClient {
  const respond = (_path: string, schema: z.ZodType) => schema.parseAsync(payload);
  return {
    get: respond,
    post: respond,
    put: respond,
    delete: respond,
  } as unknown as HttpClient;
}

describe('endpoint shapes: list wrappers', () => {
  it('queryChats reads the { chats: [...] } wrapper (not a bare array)', async () => {
    const parsed = ChatList.safeParse(fixture('chatList.gator.json'));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chats).toHaveLength(1);
      expect(parsed.data.chats?.[0]?.guid).toBe('iMessage;-;+15551234567');
    }
    // ...and the endpoint unwraps it to a bare Chat[].
    const chats = await queryChats(httpReturning(fixture('chatList.gator.json')));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.guid).toBe('iMessage;-;+15551234567');
  });

  it('queryMessages reads the { messages: [...] } wrapper', async () => {
    const parsed = MessageList.safeParse(fixture('messageList.gator.json'));
    expect(parsed.success).toBe(true);
    const msgs = await queryMessages(httpReturning(fixture('messageList.gator.json')), {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.guid).toBe('p:0/AABBCCDD-1122-3344-5566-77889900AABB');
  });

  it('list wrappers tolerate an absent/null key (empty list)', () => {
    expect(ChatList.safeParse({}).success).toBe(true);
    expect(MessageList.safeParse({ messages: null }).success).toBe(true);
  });
});

describe('endpoint shapes: send / action acks (NOT bare Messages)', () => {
  it('sendText parses the Private-API ack { guid, viaPrivateApi } and surfaces the guid', async () => {
    const fx = fixture('sendAck.privateApi.gator.json');
    expect(SendAck.safeParse(fx).success).toBe(true);
    const ack = await sendText(httpReturning(fx), {
      chatGuid: 'c1',
      tempGuid: 't1',
      message: 'hi',
    });
    expect(ack.guid).toBe('p:0/REAL-GUID-1122-3344');
  });

  it('sendText parses the AppleScript ack { viaPrivateApi:false } with NO guid (the old bug: this threw)', async () => {
    const fx = fixture('sendAck.appleScript.gator.json');
    const parsed = SendAck.safeParse(fx);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.guid).toBeUndefined();
    const ack = await sendText(httpReturning(fx), {
      chatGuid: 'c1',
      tempGuid: 't1',
      message: 'hi',
    });
    expect(ack.guid).toBeUndefined();
  });

  it('unsendMessage parses the { unsent: true } status object (not a Message)', async () => {
    const fx = fixture('unsendAck.gator.json');
    expect(UnsendAck.safeParse(fx).success).toBe(true);
    const ack = await unsendMessage(httpReturning(fx), { chatGuid: 'c1', messageGuid: 'm1' });
    expect(ack.unsent).toBe(true);
  });
});

describe('endpoint shapes: single-chat read/create wrapper-or-bare', () => {
  it('getChat accepts a bare chat', async () => {
    const chat = await getChat(httpReturning(fixture('chat.gator.json')), 'g1');
    expect(chat.guid).toBe('iMessage;-;+15551234567');
  });

  it('createChat accepts a { chat } wrapper too', async () => {
    const wrapped = { chat: fixture('chat.gator.json') };
    const chat = await createChat(httpReturning(wrapped), { addresses: ['+1555'], message: 'hi' });
    expect(chat.guid).toBe('iMessage;-;+15551234567');
  });
});

describe('endpoint shapes: facetime status objects', () => {
  it('answerFaceTime reads { answered: true } (NOT a { data: { link } } envelope)', async () => {
    expect(await answerFaceTime(httpReturning({ answered: true }), 'u1')).toBe(true);
  });
  it('leaveFaceTime reads { left: true }', async () => {
    expect(await leaveFaceTime(httpReturning({ left: true }), 'u1')).toBe(true);
  });
  it('createFaceTimeLink reads { link } and tolerates a null link', async () => {
    expect(
      await createFaceTimeLink(httpReturning({ link: 'https://facetime.apple.com/join#x' })),
    ).toBe('https://facetime.apple.com/join#x');
    expect(await createFaceTimeLink(httpReturning({ link: null }))).toBeNull();
  });
});

describe('endpoint shapes: device registration', () => {
  it('registerDevice reads { id } from the /devices op', async () => {
    expect(await registerDevice(httpReturning({ id: 'dev-9' }), 'Phone', 'tok')).toEqual({
      id: 'dev-9',
    });
  });
});
