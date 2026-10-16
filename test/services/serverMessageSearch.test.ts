import { Message } from '@core/models';
import { getChatIdByGuid, upsertContacts } from '@db/repositories';
import {
  adoptServerMessageSearchHits,
  searchAndAdoptServerMessagesWith,
} from '@/services/search/serverMessageSearchOperation';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

function lease(isCurrent: () => boolean): RealtimeDeliveryLease {
  return { generation: 0, isCurrent };
}

const remoteHit = Message.parse({
  guid: 'remote-message',
  chatGuid: 'iMessage;-;+15551234567',
  text: 'find this remote message',
  dateCreated: 2_000,
  handle: { address: '+15551234567', service: 'iMessage' },
  chats: [
    {
      guid: 'iMessage;-;+15551234567',
      chatIdentifier: '+15551234567',
      displayName: 'Remote chat',
      style: 45,
    },
  ],
});

describe('server message search adoption', () => {
  it('commits a routable hit before exposing its local enriched row', async () => {
    const { db } = await createTestDb();
    const results = await adoptServerMessageSearchHits(
      db,
      [remoteHit],
      lease(() => true),
    );

    expect(results.map((result) => result.guid)).toEqual(['remote-message']);
    expect(results[0]?.chatGuid).toBe('iMessage;-;+15551234567');
    expect(results[0]?.senderName).toBe('+15551234567');
    expect(await getChatIdByGuid(db, 'iMessage;-;+15551234567')).not.toBeNull();
  });

  it('names a sender this search introduces when the number is a saved contact', async () => {
    const { db } = await createTestDb();
    await upsertContacts(db, [
      {
        sourceId: 'saved-sender',
        displayName: 'Saved Sender',
        givenName: 'Saved',
        familyName: 'Sender',
        phones: ['+1 (555) 123-4567'],
        emails: [],
        avatar: null,
      },
    ]);

    const results = await adoptServerMessageSearchHits(
      db,
      [remoteHit],
      lease(() => true),
    );

    // The search created this sender's handle; it is linked once its transaction commits (M057).
    expect(results[0]?.senderName).toBe('Saved Sender');
  });

  it('does not write a hit owned by a retired account lease', async () => {
    const { db } = await createTestDb();
    const results = await adoptServerMessageSearchHits(
      db,
      [remoteHit],
      lease(() => false),
    );

    expect(results).toEqual([]);
    expect(await getChatIdByGuid(db, 'iMessage;-;+15551234567')).toBeNull();
  });

  it('rejects a response whose embedded owners do not exactly match the selected chat', async () => {
    const { db } = await createTestDb();
    const malformedExtraChat = Message.parse({
      ...remoteHit,
      chats: [
        ...(remoteHit.chats ?? []),
        { guid: 'RCS;-;unexpected', chatIdentifier: 'unexpected', style: 45 },
      ],
    });

    const results = await adoptServerMessageSearchHits(
      db,
      [malformedExtraChat],
      lease(() => true),
    );

    expect(results).toEqual([]);
    expect(await getChatIdByGuid(db, 'iMessage;-;+15551234567')).toBeNull();
    expect(await getChatIdByGuid(db, 'RCS;-;unexpected')).toBeNull();
  });

  it.each([
    ['a retraction date', { dateRetracted: 3_000 }],
    ['retracted parts', { messageSummaryInfo: { retractedParts: [0] } }],
    ['an invalid summary', { messageSummaryInfoInvalid: true }],
  ])(
    'refuses a hit with %s so it cannot blank an existing row (review M217)',
    async (_label, retraction) => {
      const { db, raw } = await createTestDb();
      await adoptServerMessageSearchHits(
        db,
        [remoteHit],
        lease(() => true),
      );

      await expect(
        adoptServerMessageSearchHits(
          db,
          [Message.parse({ ...remoteHit, ...retraction })],
          lease(() => true),
        ),
      ).resolves.toEqual([]);
      expect(
        raw
          .prepare('SELECT text, retraction_state AS retractionState FROM messages WHERE guid = ?')
          .get('remote-message'),
      ).toEqual({ text: 'find this remote message', retractionState: null });
    },
  );

  it('rejects case-varied RCS identities before any search-result DB write', async () => {
    const { db } = await createTestDb();
    const malformedRcs = Message.parse({
      ...remoteHit,
      guid: 'RcS-malformed-message',
    });

    await expect(
      adoptServerMessageSearchHits(
        db,
        [malformedRcs],
        lease(() => true),
      ),
    ).resolves.toEqual([]);
    expect(await getChatIdByGuid(db, 'iMessage;-;+15551234567')).toBeNull();
  });

  it('strips endpoint-impossible nested collections before the bounded transaction', async () => {
    const { db, raw } = await createTestDb();
    const oversizedNestedHit = {
      ...remoteHit,
      attributedBody: Array.from({ length: 10_000 }, () => ({ malformed: true })),
      attachments: Array.from({ length: 10_000 }, (_, index) => ({
        guid: `unexpected-attachment-${index}`,
      })),
      // No retractedParts: a retracted hit is refused outright rather than stripped (M217 above).
      messageSummaryInfo: {
        editedParts: { '0': Array.from({ length: 10_000 }, () => ({ malformed: true })) },
      },
      payloadData: {
        urlData: Array.from({ length: 10_000 }, () => ({ malformed: true })),
      },
      chats: [
        {
          ...remoteHit.chats![0]!,
          participants: Array.from({ length: 10_000 }, (_, index) => ({
            address: `unexpected-${index}@example.com`,
          })),
        },
      ],
    } as unknown as Message;

    const results = await adoptServerMessageSearchHits(
      db,
      [oversizedNestedHit],
      lease(() => true),
      'remote',
    );

    expect(results.map((result) => result.guid)).toEqual(['remote-message']);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM handles').get()).toEqual({ count: 1 });
    expect(
      raw
        .prepare(
          `SELECT attributed_body, message_summary_info, payload_data
             FROM messages WHERE guid = 'remote-message'`,
        )
        .get(),
    ).toEqual({ attributed_body: null, message_summary_info: null, payload_data: null });
  });

  it('does not dispatch a server request when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMessages = jest.fn(async () => [remoteHit]);
    const getDatabase = jest.fn();

    await expect(
      searchAndAdoptServerMessagesWith(
        { fetchMessages, getDatabase },
        'find this',
        lease(() => true),
        controller.signal,
      ),
    ).resolves.toEqual([]);
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
