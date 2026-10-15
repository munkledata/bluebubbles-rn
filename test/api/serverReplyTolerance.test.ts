import type { z } from 'zod/v4';
import {
  DeletedMessageList,
  IMessagePlainTextAck,
  RemoteDeleteAck,
  sendFormatted,
  sendMention,
  ServerMessageSearchList,
} from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';

const GUID = '11111111-2222-4333-8444-555555555555';
const NEW_FIELD = { addedByNewerServer: 'ignored' };

/** A client that validates the reply with the endpoint's own schema, like the real one. */
function parsingHttp(reply: unknown): HttpClient {
  return {
    post: async (_path: string, schema: z.ZodType) => schema.parse(reply),
  } as unknown as HttpClient;
}

describe('server success replies', () => {
  it('accept a field a newer server adds, while required fields stay exact', async () => {
    expect(
      IMessagePlainTextAck.parse({
        guid: GUID,
        tempGuid: 'temp-1',
        viaPrivateApi: true,
        ...NEW_FIELD,
      }),
    ).toMatchObject({ guid: GUID, tempGuid: 'temp-1', viaPrivateApi: true });
    expect(
      IMessagePlainTextAck.safeParse({
        guid: 'not-a-uuid',
        tempGuid: 'temp-1',
        viaPrivateApi: true,
      }).success,
    ).toBe(false);
    expect(RemoteDeleteAck.parse({ deleted: true, guid: 'g1', ...NEW_FIELD })).toMatchObject({
      deleted: true,
      guid: 'g1',
    });
    expect(ServerMessageSearchList.parse({ messages: [], ...NEW_FIELD })).toMatchObject({
      messages: [],
    });

    await expect(
      sendMention(parsingHttp({ guid: 'mention-guid', viaPrivateApi: true, ...NEW_FIELD }), {
        chatGuid: 'iMessage;+;chat-mention-1',
        tempGuid: 'temp-mention-1',
        message: 'Hello Alice and Bob',
        mentions: [
          { start: 6, length: 5, address: 'alice@example.test' },
          { start: 16, length: 3, address: '+15551234567' },
        ],
      }),
    ).resolves.toMatchObject({ guid: 'mention-guid', viaPrivateApi: true });
    await expect(
      sendFormatted(parsingHttp({ guid: 'formatted-guid', viaPrivateApi: true, ...NEW_FIELD }), {
        chatGuid: 'iMessage;-;+15551234567',
        tempGuid: 'temp-format-1',
        message: 'Hello world',
        textFormatting: [{ start: 0, length: 5, styles: ['bold'] }],
      }),
    ).resolves.toMatchObject({ guid: 'formatted-guid', viaPrivateApi: true });
  });

  it('keep the older and continued deleted-message pages distinct', () => {
    expect(DeletedMessageList.parse({ deleted: [], ...NEW_FIELD })).toMatchObject({ deleted: [] });
    expect(
      DeletedMessageList.parse({ deleted: [], cursor: 'c1', hasMore: false, ...NEW_FIELD }),
    ).toMatchObject({ deleted: [], cursor: 'c1', hasMore: false });
    // Only one of the continuation fields must still fail rather than read as an older server.
    expect(DeletedMessageList.safeParse({ deleted: [], cursor: 'c1' }).success).toBe(false);
    expect(DeletedMessageList.safeParse({ deleted: [], hasMore: true }).success).toBe(false);
  });
});
