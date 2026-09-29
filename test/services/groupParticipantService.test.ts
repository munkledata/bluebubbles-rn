import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient, RequestOptions } from '@core/api/http';
import { ServerInfo } from '@core/models';
import type { AppDatabase } from '@db/types';
import { fixedRcsCapabilitySource } from '@/services/send/rcsAttemptCapability';
import {
  addExactIMessageGroupParticipant,
  leaveExactIMessageGroup,
  removeExactIMessageGroupParticipant,
} from '@/services/groupParticipantService';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;+;chat123456789';
const NEW_ADDRESS = '+15559876543';

function seedGroup(
  raw: Database.Database,
  addresses = ['second@example.com', '+15551234567'],
): void {
  const chat = raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 43)').run(CHAT_GUID);
  for (const address of addresses) {
    const handle = raw
      .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
      .run(address, 'iMessage');
    raw
      .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
      .run(Number(chat.lastInsertRowid), Number(handle.lastInsertRowid));
  }
}

function capability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({
      version: 'test',
      supports_imessage_group_participant_add: enabled,
    }),
  );
}

function removalCapability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({
      version: 'test',
      supports_imessage_group_participant_remove: enabled,
    }),
  );
}

function membershipCapability() {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({
      version: 'test',
      supports_imessage_group_participant_add: true,
      supports_imessage_group_participant_remove: true,
      supports_imessage_group_leave: true,
    }),
  );
}

function leaveCapability(enabled = true) {
  return fixedRcsCapabilitySource(
    ServerInfo.parse({ version: 'test', supports_imessage_group_leave: enabled }),
  );
}

function seedThirdParticipant(raw: Database.Database): void {
  const chat = raw.prepare('SELECT id FROM chats WHERE guid = ?').get(CHAT_GUID) as { id: number };
  const handle = raw
    .prepare('INSERT INTO handles(address, service) VALUES (?, ?)')
    .run('+15557654321', 'iMessage');
  raw
    .prepare('INSERT INTO chat_handles(chat_id, handle_id) VALUES (?, ?)')
    .run(chat.id, Number(handle.lastInsertRowid));
}

function fakeHttp(impl: (options: RequestOptions) => Promise<unknown>): {
  http: HttpClient;
  post: jest.Mock;
} {
  const post = jest.fn((_path: string, _schema: unknown, options: RequestOptions) => impl(options));
  let http!: HttpClient;
  http = {
    post,
    pinTransport: () => http,
    isTransportCurrent: () => true,
    snapshotTransport: () => ({
      origin: 'https://participant.test',
      headers: {},
      password: 'test',
      transportRevision: 1,
      buildUrl: (path: string) => `https://participant.test/api/v1${path}`,
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

describe('addExactIMessageGroupParticipant', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(() => raw.close());

  it('proves the complete roster and sends one exact request without changing local membership', async () => {
    const transport = fakeHttp(async (options) => ({
      added: true,
      guid: CHAT_GUID,
      address: (options.json as { address: string }).address,
    }));

    const result = await addExactIMessageGroupParticipant(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
      undefined,
      capability(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      guid: CHAT_GUID,
      address: NEW_ADDRESS,
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]).toEqual([
      '/chat/iMessage%3B%2B%3Bchat123456789/participants/add',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: NEW_ADDRESS, tempGuid: result.tempGuid },
      },
    ]);
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM chat_handles').get() as { count: number },
    ).toEqual({ count: 2 });
  });

  it('fails closed for missing capability, a non-iMessage/duplicate roster, or an existing email', async () => {
    const transport = fakeHttp(async () => ({
      added: true,
      guid: CHAT_GUID,
      address: NEW_ADDRESS,
    }));

    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        capability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw.prepare("UPDATE handles SET service = 'SMS' WHERE address = '+15551234567'").run();
    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    raw.prepare("UPDATE handles SET service = 'iMessage' WHERE address = '+15551234567'").run();

    raw
      .prepare("UPDATE handles SET address = 'SECOND@EXAMPLE.COM' WHERE address = '+15551234567'")
      .run();
    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    raw
      .prepare("UPDATE handles SET address = '+15551234567' WHERE address = 'SECOND@EXAMPLE.COM'")
      .run();

    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: 'SECOND@EXAMPLE.COM' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['imessage_group_participant_add_invalid_target', 'rejected'],
    ['imessage_group_participant_add_unavailable', 'rejected'],
    ['imessage_group_participant_add_rejected', 'rejected'],
    ['idempotency_key_invalid', 'rejected'],
    ['idempotency_capacity_exhausted', 'rejected'],
    ['idempotency_persistence_unavailable', 'rejected'],
    ['imessage_group_participant_add_outcome_unknown', 'outcome-unknown'],
    ['idempotency_key_reused', 'outcome-unknown'],
  ] as const)('maps %s to %s after one attempt without replay', async (errorType, status) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'not added', undefined, errorType);
    });

    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        capability(),
      ),
    ).resolves.toMatchObject({ status, tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('rejects a second add while the first one-shot request is in flight', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve(undefined);
      return response.promise;
    });
    const first = addExactIMessageGroupParticipant(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
      undefined,
      capability(),
    );
    await started.promise;

    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15557654321' },
        undefined,
        capability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ added: true, guid: CHAT_GUID, address: NEW_ADDRESS });
    await expect(first).resolves.toMatchObject({ status: 'accepted' });
  });
});

describe('removeExactIMessageGroupParticipant', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
    seedThirdParticipant(raw);
  });

  afterEach(() => raw.close());

  it('removes one case-insensitive email identity once without rewriting it or changing local data', async () => {
    const submittedAddress = 'SECOND@EXAMPLE.COM';
    const transport = fakeHttp(async (options) => ({
      removed: true,
      guid: CHAT_GUID,
      address: (options.json as { address: string }).address,
    }));

    const result = await removeExactIMessageGroupParticipant(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, address: submittedAddress },
      undefined,
      removalCapability(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      guid: CHAT_GUID,
      address: submittedAddress,
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post.mock.calls[0]).toEqual([
      '/chat/iMessage%3B%2B%3Bchat123456789/participants/remove',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { address: submittedAddress, tempGuid: result.tempGuid },
      },
    ]);
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM chat_handles').get() as { count: number },
    ).toEqual({ count: 3 });
  });

  it('fails closed before HTTP without capability, target membership, or three members', async () => {
    const transport = fakeHttp(async () => ({
      removed: true,
      guid: CHAT_GUID,
      address: '+15551234567',
    }));

    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15551234567' },
        undefined,
        removalCapability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        removalCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw
      .prepare(
        "DELETE FROM chat_handles WHERE handle_id = (SELECT id FROM handles WHERE address = '+15557654321')",
      )
      .run();
    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15551234567' },
        undefined,
        removalCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['imessage_group_participant_remove_invalid_target', 'rejected'],
    ['imessage_group_participant_remove_unavailable', 'rejected'],
    ['imessage_group_participant_remove_rejected', 'rejected'],
    ['idempotency_key_invalid', 'rejected'],
    ['idempotency_capacity_exhausted', 'rejected'],
    ['idempotency_persistence_unavailable', 'rejected'],
    ['imessage_group_participant_remove_outcome_unknown', 'outcome-unknown'],
    ['idempotency_key_reused', 'outcome-unknown'],
  ] as const)('maps %s to %s after one attempt without replay', async (errorType, status) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'not removed', undefined, errorType);
    });

    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15551234567' },
        undefined,
        removalCapability(),
      ),
    ).resolves.toMatchObject({ status, tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('shares one active membership lane with participant addition', async () => {
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve(undefined);
      return response.promise;
    });
    const add = addExactIMessageGroupParticipant(
      db,
      transport.http,
      { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
      undefined,
      membershipCapability(),
    );
    await started.promise;

    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15551234567' },
        undefined,
        membershipCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ added: true, guid: CHAT_GUID, address: NEW_ADDRESS });
    await expect(add).resolves.toMatchObject({ status: 'accepted' });
  });
});

describe('leaveExactIMessageGroup', () => {
  let db: AppDatabase;
  let raw: Database.Database;

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
    seedGroup(raw);
  });

  afterEach(() => raw.close());

  it('sends one exact leave request and never deletes the local chat or roster', async () => {
    const transport = fakeHttp(async () => ({ left: true, guid: CHAT_GUID }));

    const result = await leaveExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID },
      undefined,
      leaveCapability(),
    );

    expect(result).toMatchObject({
      status: 'accepted',
      guid: CHAT_GUID,
      tempGuid: expect.stringMatching(/^temp-/),
    });
    expect(transport.post.mock.calls[0]).toEqual([
      '/chat/iMessage%3B%2B%3Bchat123456789/leave',
      expect.anything(),
      {
        captureErrorDetail: true,
        retry: false,
        json: { tempGuid: result.tempGuid },
      },
    ]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM chats').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM chat_handles').get()).toEqual({ count: 2 });
  });

  it('fails closed before HTTP without capability or a complete canonical iMessage roster', async () => {
    const transport = fakeHttp(async () => ({ left: true, guid: CHAT_GUID }));

    await expect(
      leaveExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        leaveCapability(false),
      ),
    ).resolves.toEqual({ status: 'rejected' });

    raw.prepare("UPDATE handles SET service = 'SMS' WHERE address = '+15551234567'").run();
    await expect(
      leaveExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        leaveCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).not.toHaveBeenCalled();
  });

  it.each([
    ['imessage_group_leave_invalid_target', 'rejected'],
    ['imessage_group_leave_unavailable', 'rejected'],
    ['imessage_group_leave_rejected', 'rejected'],
    ['idempotency_key_invalid', 'rejected'],
    ['idempotency_capacity_exhausted', 'rejected'],
    ['idempotency_persistence_unavailable', 'rejected'],
    ['imessage_group_leave_outcome_unknown', 'outcome-unknown'],
    ['idempotency_key_reused', 'outcome-unknown'],
  ] as const)('maps %s to %s after exactly one request', async (errorType, status) => {
    const transport = fakeHttp(async () => {
      throw ApiError.fromStatus(409, 'leave not confirmed', undefined, errorType);
    });

    await expect(
      leaveExactIMessageGroup(
        db,
        transport.http,
        { chatGuid: CHAT_GUID },
        undefined,
        leaveCapability(),
      ),
    ).resolves.toMatchObject({ status, tempGuid: expect.stringMatching(/^temp-/) });
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it('owns the same service lane against both add and remove', async () => {
    seedThirdParticipant(raw);
    const response = deferred<unknown>();
    const started = deferred<void>();
    const transport = fakeHttp(async () => {
      started.resolve(undefined);
      return response.promise;
    });
    const leave = leaveExactIMessageGroup(
      db,
      transport.http,
      { chatGuid: CHAT_GUID },
      undefined,
      membershipCapability(),
    );
    await started.promise;

    await expect(
      addExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: NEW_ADDRESS },
        undefined,
        membershipCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    await expect(
      removeExactIMessageGroupParticipant(
        db,
        transport.http,
        { chatGuid: CHAT_GUID, address: '+15551234567' },
        undefined,
        membershipCapability(),
      ),
    ).resolves.toEqual({ status: 'rejected' });
    expect(transport.post).toHaveBeenCalledTimes(1);

    response.resolve({ left: true, guid: CHAT_GUID });
    await expect(leave).resolves.toMatchObject({ status: 'accepted' });
  });
});
