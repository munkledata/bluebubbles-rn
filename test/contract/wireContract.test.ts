import { readFileSync } from 'fs';
import { join } from 'path';
import { Message, ServerInfo } from '@core/models';

/**
 * Wire-contract gate (API_SYNC_PLAN.md, Phase C). The app's zod models must accept the
 * Gator server's ACTUAL `data` shapes (the inner payload, post {status,message,data}
 * unwrap). Commit a representative serializer output as a golden fixture here, and a server
 * shape change the app doesn't model fails CI — drift can't go silent. Long-term these
 * fixtures should be GENERATED from `bluebubbles-server/packages/bbd/src/serialize/*`.
 */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'fixtures', 'contract', 'v1', name), 'utf8'),
  );
}

describe('wire contract: app zod models accept the Gator server shapes', () => {
  it('ServerInfo accepts { version } and coalesces it into server_version', () => {
    const res = ServerInfo.safeParse(fixture('serverInfo.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.server_version).toBe('1.2.3');
  });

  it('Message accepts the Gator messageSerializer shape (unknown fields tolerated)', () => {
    const res = Message.safeParse(fixture('message.gator.json'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.guid).toBe('p:0/AABBCCDD-1122-3344-5566-77889900AABB');
      expect(res.data.isFromMe).toBe(false);
    }
  });
});
