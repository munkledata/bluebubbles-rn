import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import type { AppDatabase } from '@db/types';
import {
  fixedRcsCapabilitySource,
  type RcsCapabilityLease,
} from '@/services/send/rcsAttemptCapability';
import {
  clearExactIMessageGroupName,
  renameExactIMessageGroup,
} from '@/services/groupRenameService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;+;chat123456789';

function seedGroup(raw: Database.Database, guid = CHAT_GUID): void {
  const chat = raw
    .prepare("INSERT INTO chats(guid, style, display_name) VALUES (?, 43, 'Road Trip')")
    .run(guid);
  for (const address of guid === CHAT_GUID
    ? ['+15551234567', '+15557654321']
    : ['+15551110000', '+15552220000']) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(address, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
}

function capability(flags: Record<string, boolean> = { supports_imessage_group_name_clear: true }) {
  return fixedRcsCapabilitySource(ServerInfo.parse({ version: 'test', ...flags }));
}

function fakeHttp(impl: (path: string, options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((path: string, _schema: unknown, options: RequestOptions) =>
    impl(path, options),
  );
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://clear.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://clear.test/api/v1${path}`,
    }),
  } as unknown as HttpClient;
  return { http, post };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('clearExactIMessageGroupName', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(() => raw.close());

  it('sends one exact request with one generated identity and accepts the matching result', async () => {
    const transport = fakeHttp(async () => ({ cleared: true, guid: CHAT_GUID }));

    const result = await clearExactIMessageGroupName(
      db,
      transport.http,
      { chatGuid: CHAT_GUID },
      undefined,
      capability(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      guid: CHAT_GUID,
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]).toEqual([
      '/chat/iMessage%3B%2B%3Bchat123456789/rename/clear',
      expect.anything(),
      { captureErrorDetail: true, retry: false, json: { tempGuid: result.tempGuid } },
    ]);
  });

  it.each([
    ['imessage_group_name_clear_invalid_target', 400],
    ['imessage_group_name_clear_unavailable', 503],
    ['imessage_group_name_clear_rejected', 409],
  ])('returns a definite %s refusal after exactly one attempt', async (serverErrorType, status) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(status, 'not cleared', undefined, serverErrorType);
    });

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'rejected', tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    'imessage_group_name_clear_outcome_unknown',
    'idempotency_outcome_unknown',
    // A rename-family refusal is not proof for this command.
    'imessage_group_rename_rejected',
  ])('returns %s as outcome unknown without replaying it', async (serverErrorType) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(500, 'unknown', undefined, serverErrorType);
    });

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({
      status: 'outcome-unknown',
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('treats an acknowledgement for another group as outcome unknown', async () => {
    const transport = fakeHttp(async () => ({ cleared: true, guid: 'iMessage;+;other' }));

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('refuses before HTTP without its own switch, for a non-group guid, or an SMS member', async () => {
    const transport = fakeHttp(async () => ({ cleared: true, guid: CHAT_GUID }));

    // The rename switch alone does not admit a removal.
    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability({ supports_imessage_group_rename: true }),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: 'iMessage;-;+15551234567' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw
      .prepare("UPDATE handles SET service = 'SMS' WHERE id = (SELECT MIN(id) FROM handles)")
      .run();
    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it('never overlaps a rename of the same group', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async (path) => {
      if (path.endsWith('/rename')) {
        started.resolve();
        return response.promise;
      }
      return { cleared: true, guid: CHAT_GUID };
    });
    const rename = renameExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, displayName: 'New Name' },
      undefined,
      capability({ supports_imessage_group_rename: true }),
    );
    await started.promise;

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ renamed: true, guid: CHAT_GUID, displayName: 'New Name' });
    await expect(rename).resolves.toMatchObject({ status: 'accepted' });
  });

  it('retires a late success as outcome-unknown after its capability lease retires', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve();
      return response.promise;
    });
    let current = true;
    const source: RcsCapabilityLease = {
      kind: 'session',
      origin: 'https://clear.test',
      revision: 1,
      serverInfo: ServerInfo.parse({ version: 'test', supports_imessage_group_name_clear: true }),
      isCurrent: () => current,
      publish: () => false,
    };
    const result = clearExactIMessageGroupName(
      db,
      transport.http,
      { chatGuid: CHAT_GUID },
      undefined,
      source,
    );
    await started.promise;
    current = false;
    response.resolve({ cleared: true, guid: CHAT_GUID });

    await expect(result).resolves.toMatchObject({ status: 'outcome-unknown' });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('removes a native any;+; group name: its own switch is an FP-006 switch, so the gate is open', async () => {
    const ANY_GUID = 'any;+;chat987654321';
    seedGroup(raw, ANY_GUID);
    const transport = fakeHttp(async () => ({ cleared: true, guid: ANY_GUID }));

    // Without the switch nothing is sent, even when other restored switches are on.
    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: ANY_GUID },
        undefined,
        capability({ supports_imessage_group_reactions: true }),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();

    await expect(
      clearExactIMessageGroupName(
        db,
        transport.http,
        { chatGuid: ANY_GUID },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status: 'accepted', guid: ANY_GUID });
    expect(transport.post.mock.calls[0]?.[0]).toBe('/chat/any%3B%2B%3Bchat987654321/rename/clear');
  });
});
