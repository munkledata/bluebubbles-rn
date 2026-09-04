/* eslint-disable import/first -- Jest mocks must be registered before importing application modules. */

interface KyRequestOptions {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly searchParams: URLSearchParams;
  readonly signal: AbortSignal;
}

interface ObservedRequest {
  readonly url: string;
  readonly options: KyRequestOptions;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface HeldRequest {
  readonly started: Promise<ObservedRequest>;
  releaseForCleanup(): void;
}

const mockKy = jest.fn<Promise<Response>, [string, KyRequestOptions]>();
const mockEnsureDatabase = jest.fn();
const heldRequests: HeldRequest[] = [];

jest.mock('ky', () => ({ __esModule: true, default: mockKy }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: mockEnsureDatabase }));
jest.mock('@/services/contacts/contactsService', () => ({ syncContacts: jest.fn() }));
jest.mock('@/services/download/attachmentCacheAccountScope', () => ({
  createAttachmentCacheAccountScope: jest.fn(() => ({ testId: 'attachment-scope' })),
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {
    retireInactiveEntries: jest.fn(async () => undefined),
    drainDueRetirements: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/clients', () => {
  const { HttpClient } = jest.requireActual('@core/api/http') as typeof import('@core/api/http');
  const { sessionAccessors } = jest.requireActual(
    '@state/sessionStore',
  ) as typeof import('@state/sessionStore');
  return {
    http: new HttpClient({
      getOrigin: sessionAccessors.getOrigin,
      getPassword: sessionAccessors.getPassword,
    }),
  };
});

import { ApiError } from '@core/api/errors';
import { useSessionStore } from '@state/sessionStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { awaitSyncIdle, startChatRepair, type ChatRepairResult } from '@/services/syncControl';
import { createTestDb } from '../support/testDb';

const ORIGIN = 'https://targeted-repair.example.test';
const PASSWORD = 'synthetic-password';
const CHAT_GUID = 'iMessage;-;+15551234567';

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>;
type RepairOutcome =
  | { readonly status: 'resolved'; readonly value: ChatRepairResult }
  | { readonly status: 'rejected'; readonly reason: unknown };

let testDatabase: TestDatabase | null = null;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: 200, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function holdNextRequest(cleanupResponse: () => Response): HeldRequest {
  const started = deferred<ObservedRequest>();
  let release: (() => void) | undefined;
  mockKy.mockImplementationOnce(
    (url, options) =>
      new Promise<Response>((resolve, reject) => {
        let settled = false;
        const settle = (work: () => void): void => {
          if (settled) return;
          settled = true;
          work();
        };
        const abort = (): void =>
          settle(() => reject(new DOMException('targeted repair cancelled', 'AbortError')));
        release = () => settle(() => resolve(cleanupResponse()));
        started.resolve({ url, options });
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      }),
  );
  const held = {
    started: started.promise,
    releaseForCleanup: () => release?.(),
  };
  heldRequests.push(held);
  return held;
}

function observeRepair(promise: Promise<ChatRepairResult>): Promise<RepairOutcome> {
  return promise.then(
    (value) => ({ status: 'resolved' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

function expectCancelled(outcome: RepairOutcome): void {
  expect(outcome.status).toBe('rejected');
  if (outcome.status !== 'rejected') return;
  expect(outcome.reason).toBeInstanceOf(ApiError);
  expect(outcome.reason).toMatchObject({ kind: 'cancelled' });
}

beforeEach(async () => {
  mockKy.mockReset();
  mockEnsureDatabase.mockReset();
  heldRequests.length = 0;
  resumeRealtimeDeliveries();
  useSessionStore.getState().reset();
  useSessionStore.getState().connected(ORIGIN, PASSWORD, { server_version: '1.9.0' });
  testDatabase = await createTestDb();
  mockEnsureDatabase.mockResolvedValue(testDatabase.db);
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  heldRequests.forEach((request) => request.releaseForCleanup());
  await awaitSyncIdle();
  testDatabase?.raw.close();
  testDatabase = null;
  useSessionStore.getState().reset();
  resumeRealtimeDeliveries();
});

describe('targeted repair HTTP cancellation', () => {
  it('propagates account invalidation into the exact-chat transport request without retrying', async () => {
    const held = holdNextRequest(() =>
      jsonResponse({ chat: { guid: CHAT_GUID, participants: [] } }),
    );
    const repair = observeRepair(startChatRepair(CHAT_GUID));
    const request = await held.started;

    expect(request.url).toBe(`${ORIGIN}/api/v1/chat/${encodeURIComponent(CHAT_GUID)}`);
    expect(request.options.method).toBe('GET');
    expect(request.options.headers.Authorization).toBe(`Bearer ${PASSWORD}`);
    expect(request.options.searchParams.get('with')).toBe('participants,lastmessage');
    expect(request.options.signal.aborted).toBe(false);

    const paused = pauseRealtimeDeliveries();
    expect(request.options.signal.aborted).toBe(true);
    await paused;

    expectCancelled(await repair);
    expect(mockKy).toHaveBeenCalledTimes(1);
    expect(testDatabase?.raw.prepare('SELECT COUNT(*) AS count FROM chats').get()).toEqual({
      count: 0,
    });
    await awaitSyncIdle();
  });

  it('propagates account invalidation into message-history transport after metadata commits', async () => {
    mockKy.mockResolvedValueOnce(jsonResponse({ chat: { guid: CHAT_GUID, participants: [] } }));
    const held = holdNextRequest(() => jsonResponse({ messages: [] }));
    const repair = observeRepair(startChatRepair(CHAT_GUID));
    const request = await held.started;

    expect(request.url).toBe(`${ORIGIN}/api/v1/chat/${encodeURIComponent(CHAT_GUID)}/message`);
    expect(request.options.method).toBe('GET');
    expect(request.options.headers.Authorization).toBe(`Bearer ${PASSWORD}`);
    expect(Object.fromEntries(request.options.searchParams)).toMatchObject({
      limit: '100',
      offset: '0',
      sort: 'DESC',
    });
    expect(request.options.searchParams.get('with')).toBe(
      'chats,chats.participants,handle,attachments,attributedBody,messageSummaryInfo,payloadData',
    );
    expect(request.options.signal.aborted).toBe(false);
    expect(testDatabase?.raw.prepare('SELECT guid FROM chats ORDER BY guid').all()).toEqual([
      { guid: CHAT_GUID },
    ]);

    const paused = pauseRealtimeDeliveries();
    expect(request.options.signal.aborted).toBe(true);
    await paused;

    expectCancelled(await repair);
    expect(mockKy).toHaveBeenCalledTimes(2);
    expect(testDatabase?.raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
      count: 0,
    });
    await awaitSyncIdle();
  });
});
