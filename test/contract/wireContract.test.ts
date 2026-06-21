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
