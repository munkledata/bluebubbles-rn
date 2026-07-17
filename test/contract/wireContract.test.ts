import { readFileSync } from 'fs';
import { join } from 'path';
import { Attachment, Chat, Handle, Message, ServerInfo } from '@core/models';
import { ScheduledItem } from '@core/api/endpoints/scheduled';

/**
 * Wire-contract gate (API_SYNC_PLAN.md, Phase C). The app's zod models must accept the
 * Gator server's ACTUAL `data` shapes (the inner payload, post {status,message,data}
 * unwrap). Each fixture mirrors a `bbd/src/serialize/*` serializer (or operation) output;
 * a server shape change the app doesn't model fails CI here — drift can't go silent.
 *
 * Sync: these fixtures are hand-kept in step with the server serializers. The durable
 * follow-up is to GENERATE them from `bluebubbles-server/packages/bbd/src/serialize/*`
 * (and assert the serializers reproduce them server-side) so both ends share one source.
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'contract', 'v1', name), 'utf8'),
  );
}

describe('wire contract: app zod models accept the Gator server shapes', () => {
  it('ServerInfo accepts the minimal { version } (older Gator) and coalesces server_version', () => {
    const res = ServerInfo.safeParse(fixture('serverInfo.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.server_version).toBe('1.2.3');
  });

  it('ServerInfo accepts the enriched server/info (version + feature/proxy flags)', () => {
    const res = ServerInfo.safeParse(fixture('serverInfo.enriched.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.server_version).toBe('1.2.3');
      expect(res.data.private_api).toBe(true);
      expect(res.data.proxy_service).toBe('zrok');
      expect(res.data.supports_header_auth).toBe(true);
    }
  });

  it('Message accepts the messageSerializer shape incl. the delivered-tier flags', () => {
    const res = Message.safeParse(fixture('message.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('p:0/AABBCCDD-1122-3344-5566-77889900AABB');
      expect(res.data.isFromMe).toBe(false);
      expect(res.data.didNotifyRecipient).toBe(true);
      expect(res.data.wasDeliveredQuietly).toBe(false);
      // isScheduled is presence-driven — an ordinary (non-scheduled) message omits it entirely.
      expect(res.data.isScheduled).toBeUndefined();
      // messageSummaryInfo is likewise presence-driven — an un-edited message omits it entirely.
      expect(res.data.messageSummaryInfo).toBeUndefined();
    }
  });

  it('Message accepts an edited message carrying messageSummaryInfo (edit history + retracted parts)', () => {
    const res = Message.safeParse(fixture('messageEditHistory.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('p:0/EDIT-1234-5678-9ABC');
      // editedParts is keyed by part index (JSON string keys); ordered original → current.
      const parts = res.data.messageSummaryInfo?.editedParts?.['0'];
      expect(parts).toHaveLength(2);
      expect(parts?.[0]?.text).toBe('first version'); // index 0 = the ORIGINAL text
      expect(parts?.[1]?.text).toBe('final version'); // last = the CURRENT text
      expect(parts?.[1]?.date).toBe(1718900500000);
      expect(res.data.messageSummaryInfo?.retractedParts).toEqual([1]);
    }
  });

  it('Message accepts a pending Apple "Send Later" row and preserves isScheduled', () => {
    const res = Message.safeParse(fixture('messageScheduled.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('p:0/SCHED-1234-5678-9ABC');
      // The whole point: the pending-scheduled flag survives parsing so the app can badge it.
      expect(res.data.isScheduled).toBe(true);
      expect(res.data.isFromMe).toBe(true);
    }
  });

  it('Message accepts a message with nested attachments (with=attachments)', () => {
    const res = Message.safeParse(fixture('messageWithAttachments.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.attachments).toHaveLength(1);
      expect(res.data.attachments?.[0]?.mimeType).toBe('image/jpeg');
      expect(res.data.attachments?.[0]?.guid).toBe('at-IMG-9988');
    }
  });

  it('Message accepts a fully-hydrated query-messages row: originalROWID + chats + handle + attachments', () => {
    const res = Message.safeParse(fixture('messageQueryHydrated.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      // originalROWID is the incremental-sync cursor — it MUST survive parsing.
      expect(res.data.originalROWID).toBe(4821);
      // chats[0].guid is how incremental sync routes the message to a chat.
      expect(res.data.chats?.[0]?.guid).toBe('iMessage;-;+15551234567');
      expect(res.data.attachments?.[0]?.guid).toBe('at-QRY-5566');
      // An UNKNOWN service ("RCS") must NOT fail the parse (it would fail a closed enum,
      // and one bad handle fails the whole sync page). It is preserved verbatim.
      expect(res.data.handle?.service).toBe('RCS');
    }
  });

  it('Handle accepts the handleSerializer shape', () => {
    const res = Handle.safeParse(fixture('handle.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.address).toBe('+15551234567');
      expect(res.data.service).toBe('iMessage');
    }
  });

  it('Attachment accepts the attachmentSerializer shape (server-only hideAttachment tolerated)', () => {
    const res = Attachment.safeParse(fixture('attachment.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('at-AABBCCDD-1122-3344');
      expect(res.data.mimeType).toBe('image/jpeg');
      // The Genmoji keys are presence-driven — an ordinary attachment omits them entirely
      // (mirrors the Wave-A isScheduled absence assertion above).
      expect(res.data.emojiImageContentIdentifier).toBeUndefined();
      expect(res.data.emojiImageShortDescription).toBeUndefined();
    }
  });

  it('Attachment accepts a Genmoji (macOS 15.1+) carrying both emoji-image keys', () => {
    const res = Attachment.safeParse(fixture('attachmentGenmoji.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('at-GENMOJI-9911');
      // The identifier marks it a Genmoji (→ inline emoji-size render); the description is the
      // natural-language alt text (→ accessibility label + notification/preview fallback).
      expect(res.data.emojiImageContentIdentifier).toBe('genmoji-ABCDEF-1234');
      expect(res.data.emojiImageShortDescription).toBe('a smiling cat wearing a top hat');
    }
  });

  it('Chat accepts a hydrated chat (with:[participants,lastMessage]) incl. nested handle + message', () => {
    const res = Chat.safeParse(fixture('chat.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('iMessage;-;+15551234567');
      expect(res.data.participants).toHaveLength(1);
      expect(res.data.participants?.[0]?.address).toBe('+15551234567');
      expect(res.data.lastMessage?.guid).toBe('p:0/LASTMSG-1122-3344');
    }
  });

  it('ScheduledItem accepts the Gator flat scheduled-message shape (string id)', () => {
    const res = ScheduledItem.safeParse(fixture('scheduled.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.id).toBe('3f2b1a90-7c4d-4e2a-9b11-aa22bb33cc44');
      expect(res.data.status).toBe('pending');
    }
  });
});
