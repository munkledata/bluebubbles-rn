import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import type { AppDatabase } from '@db/types';
import { sendEdit, sendUnsend } from '@/services/send/sendEditService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;-;+15551234567';
const MESSAGE_GUID = 'message-1';
const TOPOLOGY = JSON.stringify({
  complete: true,
  originalPartIndexes: [0],
  currentParts: [{ index: 0, kind: 'text' }],
  attachmentOwnership: [],
});

function seedExactTextTarget(raw: Database.Database): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 45)').run(CHAT_GUID);
  raw
    .prepare(
      `INSERT INTO messages(
         guid, chat_id, text, is_from_me, date_created, send_state, message_part_topology
       ) VALUES (?, ?, 'original', 1, 100, 'sent', ?)`,
    )
    .run(MESSAGE_GUID, Number(chat.lastInsertRowid), TOPOLOGY);
}

function row(raw: Database.Database): { text: string | null; dateEdited: number | null } {
  return raw
    .prepare(
      `SELECT text, date_edited AS dateEdited
         FROM messages
        WHERE guid = ?`,
    )
    .get(MESSAGE_GUID) as { text: string | null; dateEdited: number | null };
}

function retractionRow(raw: Database.Database): {
  dateRetracted: number | null;
  retractionState: string | null;
  pendingPartIndex: number | null;
} {
  return raw
    .prepare(
      `SELECT date_retracted AS dateRetracted,
              retraction_state AS retractionState,
              pending_retraction_part_index AS pendingPartIndex
         FROM messages
        WHERE guid = ?`,
    )
    .get(MESSAGE_GUID) as {
    dateRetracted: number | null;
    retractionState: string | null;
    pendingPartIndex: number | null;
  };
}

function fakeHttp(impl: (path: string, options?: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((path: string, _schema: unknown, options?: RequestOptions) =>
    impl(path, options),
  );
  return { http: { post } as unknown as HttpClient, post };
}

describe('narrow one-to-one iMessage edit', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedExactTextTarget(raw);
  });

  afterEach(() => raw.close());

  it('accepts only an exact matching ack and sends the narrow body once', async () => {
    const transport = fakeHttp(async () => ({ guid: MESSAGE_GUID, viaPrivateApi: true }));

    await expect(
      sendEdit(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          messageGuid: MESSAGE_GUID,
          newText: 'edited',
          partIndex: 0,
        },
        5_000,
      ),
    ).resolves.toEqual({ status: 'accepted' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[0]).toBe('/message/message-1/edit');
    expect(transport.post.mock.calls[0]?.[2]).toMatchObject({
      captureErrorDetail: true,
      retry: false,
      json: { chatGuid: CHAT_GUID, editedText: 'edited', partIndex: 0 },
    });
    expect(transport.post.mock.calls[0]?.[2]?.json).not.toHaveProperty('backwardsCompatText');
    expect(row(raw)).toEqual({ text: 'edited', dateEdited: 5_000 });
  });

  // A sync or push can refresh server capabilities while the request is out; that says nothing
  // about whether the server applied the change, so the user is told it is unconfirmed.
  const capabilityChangesDuring = (respond: () => Promise<unknown>) => {
    let current = true;
    const transport = fakeHttp(async () => {
      current = false;
      return respond();
    });
    return { transport, authorization: { allowsLegacyPartZero: false, isCurrent: () => current } };
  };
  // Even a refusal: the request may have reached a server the app no longer has a current view of.
  const replies = (refusal: string): Array<[string, () => Promise<unknown>]> => [
    ['an acknowledgement', async () => ({ guid: MESSAGE_GUID, viaPrivateApi: true, unsent: true })],
    [
      'a timeout',
      async () => {
        throw new ApiError('timeout', 'Request timed out');
      },
    ],
    [
      'a refusal',
      async () => {
        throw ApiError.fromStatus(409, 'rejected', undefined, refusal);
      },
    ],
  ];

  it.each(replies('imessage_edit_rejected'))(
    'reports an edit as unconfirmed, keeping it, when capabilities change after %s',
    async (_label, respond) => {
      const { transport, authorization } = capabilityChangesDuring(respond);

      await expect(
        sendEdit(
          db,
          transport.http,
          { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, newText: 'edited', partIndex: 0 },
          5_000,
          undefined,
          authorization,
        ),
      ).resolves.toEqual({ status: 'outcome-unknown' });
      expect(row(raw)).toEqual({ text: 'edited', dateEdited: 5_000 });
    },
  );

  it.each(replies('imessage_unsend_rejected'))(
    'reports an unsend as unconfirmed, keeping it, when capabilities change after %s',
    async (_label, respond) => {
      const { transport, authorization } = capabilityChangesDuring(respond);

      await expect(
        sendUnsend(
          db,
          transport.http,
          { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
          6_000,
          undefined,
          authorization,
        ),
      ).resolves.toEqual({ status: 'outcome-unknown' });
      expect(retractionRow(raw)).toMatchObject({ retractionState: 'unknown', pendingPartIndex: 0 });
    },
  );

  it('restores the prior row on a definite typed failure without retrying', async () => {
    const transport = fakeHttp(async () => {
      throw new ApiError(
        'server_error',
        'edit unavailable',
        503,
        undefined,
        undefined,
        'imessage_edit_unavailable',
      );
    });

    await expect(
      sendEdit(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          messageGuid: MESSAGE_GUID,
          newText: 'edited',
          partIndex: 0,
        },
        5_000,
      ),
    ).resolves.toEqual({ status: 'rejected' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(row(raw)).toEqual({ text: 'original', dateEdited: null });
  });

  it('keeps optimistic state for typed outcome-unknown and never retries', async () => {
    const transport = fakeHttp(async () => {
      throw new ApiError(
        'bad_request',
        'edit outcome unknown',
        409,
        undefined,
        undefined,
        'imessage_edit_outcome_unknown',
      );
    });

    await expect(
      sendEdit(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          messageGuid: MESSAGE_GUID,
          newText: 'possibly applied',
          partIndex: 0,
        },
        5_000,
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(row(raw)).toEqual({ text: 'possibly applied', dateEdited: 5_000 });
  });

  it('treats a non-matching success ack as outcome-unknown', async () => {
    const transport = fakeHttp(async () => ({ guid: 'different-message', viaPrivateApi: true }));

    await expect(
      sendEdit(
        db,
        transport.http,
        {
          chatGuid: CHAT_GUID,
          messageGuid: MESSAGE_GUID,
          newText: 'possibly applied',
          partIndex: 0,
        },
        5_000,
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(row(raw)).toEqual({ text: 'possibly applied', dateEdited: 5_000 });
  });

  it('rolls back when the exact target disappears after optimistic admission', async () => {
    type All = (query: unknown) => unknown;
    const realAll = db.all.bind(db) as All;
    let targetReads = 0;
    const targetRead = jest.spyOn(db, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (shape.includes('message_part_topology') && shape.includes('message_guid_aliases')) {
        targetReads += 1;
        if (targetReads === 2) return [];
      }
      return realAll(query);
    }) as unknown as AppDatabase['all']);
    const transport = fakeHttp(async () => ({ guid: MESSAGE_GUID, viaPrivateApi: true }));

    try {
      await expect(
        sendEdit(
          db,
          transport.http,
          {
            chatGuid: CHAT_GUID,
            messageGuid: MESSAGE_GUID,
            newText: 'must roll back',
            partIndex: 0,
          },
          5_000,
        ),
      ).resolves.toEqual({ status: 'rejected' });

      expect(targetReads).toBe(2);
      expect(transport.post).not.toHaveBeenCalled();
      expect(row(raw)).toEqual({ text: 'original', dateEdited: null });
    } finally {
      targetRead.mockRestore();
    }
  });

  it('accepts only an exact unsend ack and sends the narrow body once', async () => {
    const transport = fakeHttp(async () => ({ unsent: true, guid: MESSAGE_GUID }));

    await expect(
      sendUnsend(db, transport.http, {
        chatGuid: CHAT_GUID,
        messageGuid: MESSAGE_GUID,
        partIndex: 0,
      }),
    ).resolves.toEqual({ status: 'accepted' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[0]).toBe('/message/message-1/unsend');
    expect(transport.post.mock.calls[0]?.[2]).toMatchObject({
      captureErrorDetail: true,
      retry: false,
      json: { chatGuid: CHAT_GUID, partIndex: 0 },
    });
    expect(retractionRow(raw)).toEqual({
      dateRetracted: expect.any(Number),
      retractionState: 'unknown',
      pendingPartIndex: 0,
    });
  });

  it('rejects a legacy row without exact topology before HTTP', async () => {
    raw
      .prepare('UPDATE messages SET message_part_topology = NULL WHERE guid = ?')
      .run(MESSAGE_GUID);
    const transport = fakeHttp(async () => ({ unsent: true, guid: MESSAGE_GUID }));

    await expect(
      sendUnsend(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
        6_000,
        undefined,
        { allowsLegacyPartZero: true, isCurrent: () => true },
      ),
    ).resolves.toEqual({ status: 'rejected' });

    expect(transport.post).not.toHaveBeenCalled();
    expect(retractionRow(raw)).toEqual({
      dateRetracted: null,
      retractionState: null,
      pendingPartIndex: null,
    });
  });

  it('restores the prior retraction state on a definite typed unsend failure', async () => {
    const transport = fakeHttp(async () => {
      throw new ApiError(
        'server_error',
        'unsend unavailable',
        503,
        undefined,
        undefined,
        'imessage_unsend_unavailable',
      );
    });

    await expect(
      sendUnsend(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
        6_000,
      ),
    ).resolves.toEqual({ status: 'rejected' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(retractionRow(raw)).toEqual({
      dateRetracted: null,
      retractionState: null,
      pendingPartIndex: null,
    });
  });

  it('keeps the conservative retraction for outcome-unknown without retrying', async () => {
    const transport = fakeHttp(async () => {
      throw new ApiError(
        'bad_request',
        'unsend outcome unknown',
        409,
        undefined,
        undefined,
        'imessage_unsend_outcome_unknown',
      );
    });

    await expect(
      sendUnsend(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
        6_000,
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(retractionRow(raw)).toEqual({
      dateRetracted: 6_000,
      retractionState: 'unknown',
      pendingPartIndex: 0,
    });
  });

  it('treats a non-matching unsend ack as outcome-unknown', async () => {
    const transport = fakeHttp(async () => ({ unsent: true, guid: 'different-message' }));

    await expect(
      sendUnsend(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
        6_000,
      ),
    ).resolves.toEqual({ status: 'outcome-unknown' });

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(retractionRow(raw)).toEqual({
      dateRetracted: 6_000,
      retractionState: 'unknown',
      pendingPartIndex: 0,
    });
  });

  it('rolls back when the pending unsend target disappears before dispatch', async () => {
    type All = (query: unknown) => unknown;
    const realAll = db.all.bind(db) as All;
    const targetRead = jest.spyOn(db, 'all').mockImplementation(((query: unknown) => {
      const shape = JSON.stringify(query).replace(/\s+/g, ' ').toLowerCase();
      if (
        shape.includes('pending_retraction_part_index') &&
        shape.includes('message_guid_aliases')
      ) {
        return [];
      }
      return realAll(query);
    }) as unknown as AppDatabase['all']);
    const transport = fakeHttp(async () => ({ unsent: true, guid: MESSAGE_GUID }));

    try {
      await expect(
        sendUnsend(
          db,
          transport.http,
          { chatGuid: CHAT_GUID, messageGuid: MESSAGE_GUID, partIndex: 0 },
          6_000,
        ),
      ).resolves.toEqual({ status: 'rejected' });

      expect(transport.post).not.toHaveBeenCalled();
      expect(retractionRow(raw)).toEqual({
        dateRetracted: null,
        retractionState: null,
        pendingPartIndex: null,
      });
    } finally {
      targetRead.mockRestore();
    }
  });
});
