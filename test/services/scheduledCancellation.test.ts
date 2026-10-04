/** Real HTTP error decoding and SQLite cancellation/claim ownership, without native transports. */
import ky from 'ky';
import { eq } from 'drizzle-orm';
import { Chat } from '@core/models';
import { ApiError } from '@core/api/errors';
import { getDatabase } from '@db/database';
import {
  claimDueScheduled,
  getScheduledById,
  handoverScheduledTextToOutgoing,
  insertScheduled,
  updateScheduled,
  upsertChats,
  type ScheduledCancellationTarget,
} from '@db/repositories';
import { scheduledMessages } from '@db/schema';
import * as scheduledRepository from '@db/repositories/scheduled';
import { withDbTransaction } from '@db/transaction';
import { cancelScheduled, ScheduledCancellationChangedError } from '@/services/send';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => {
  const { HttpClient } = jest.requireActual('@core/api/http');
  return {
    http: new HttpClient({
      getOrigin: () => 'https://fixture.invalid',
      getPassword: () => 'synthetic',
    }),
  };
});
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@/services/send/outgoingPasteOwnership', () => ({
  createOutgoingPasteOwnershipPreparer: jest.fn(),
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-test'),
  sendTextMessage: jest.fn(),
}));

const mockKy = ky as unknown as jest.Mock;
const missingEnvelope = {
  status: 404,
  message: 'Not Found',
  error: {
    message: 'no such scheduled message',
    type: 'scheduled_message_not_found',
    retryable: false,
  },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let chatId: number;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(
  serverId: string | null = 'server-a',
  recurrence?: string,
): Promise<ScheduledCancellationTarget> {
  const id = await insertScheduled(fixture.db, {
    chatGuid: 'c1',
    text: 'synthetic scheduled text',
    scheduledFor: 1_000,
    serverId,
    recurrence,
  });
  return { id, chatGuid: 'c1', serverId, scheduledFor: 1_000 };
}

async function handoff(target: ScheduledCancellationTarget, repeat = false) {
  expect(await claimDueScheduled(fixture.db, target.id, 2_000)).not.toBeNull();
  await handoverScheduledTextToOutgoing(fixture.db, {
    scheduledId: target.id,
    outgoing: {
      tempGuid: 'outgoing-a',
      chatId,
      chatGuid: 'c1',
      text: 'synthetic scheduled text',
      now: 2_000,
    },
    transition: repeat ? { kind: 'rearm', nextScheduledFor: 86_401_000 } : { kind: 'sent' },
  });
}

const queuedCount = () => fixture.raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get();

beforeEach(async () => {
  jest.clearAllMocks();
  resumeRealtimeDeliveries();
  fixture = await createTestDb();
  await upsertChats(
    fixture.db,
    [Chat.parse({ guid: 'c1', participants: [] }), Chat.parse({ guid: 'c2', participants: [] })],
    new Map(),
  );
  chatId = (fixture.raw.prepare('SELECT id FROM chats WHERE guid = ?').get('c1') as { id: number })
    .id;
  (getDatabase as jest.Mock).mockReturnValue(fixture.db);
  mockKy.mockImplementation(async () => response({ status: 200, data: { removed: true } }));
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  fixture.raw.close();
  jest.restoreAllMocks();
});

it('accepts the Mac exact typed missing response through the real bounded HTTP decoder', async () => {
  const target = await seed();
  mockKy.mockImplementation(async () => response(missingEnvelope, 404));
  await expect(cancelScheduled(target)).resolves.toBeUndefined();
  expect(await getScheduledById(fixture.db, target.id)).toBeNull();
  expect(mockKy).toHaveBeenCalledTimes(1);
  expect(mockKy.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', retry: 0 });
});

it.each([
  ['generic 404', 404, { message: 'Not Found' }],
  ['wrong type', 404, { error: { type: 'other_not_found' } }],
  ['message text only', 404, { error: { message: 'scheduled_message_not_found' } }],
  ['in flight', 409, { error: { type: 'scheduled_message_in_flight' } }],
  ['wrong status for missing', 409, missingEnvelope],
  ['unauthorized', 401, missingEnvelope],
  ['forbidden', 403, missingEnvelope],
  ['oversized JSON', 404, { ...missingEnvelope, padding: 'x'.repeat(4_096) }],
])('retains the pending occurrence for %s', async (_label, status, body) => {
  const target = await seed();
  mockKy.mockImplementation(async () => response(body, Number(status)));
  await expect(cancelScheduled(target)).rejects.toBeInstanceOf(ApiError);
  expect(await getScheduledById(fixture.db, target.id)).toMatchObject({
    ...target,
    status: 'pending',
  });
});

it.each([
  ['HTML', '<html>scheduled_message_not_found</html>', 'text/html'],
  ['malformed JSON', '{"error":', 'application/json'],
])('retains the row after %s', async (_label, body, contentType) => {
  const target = await seed();
  mockKy.mockImplementation(
    async () => new Response(body, { status: 404, headers: { 'content-type': contentType } }),
  );
  await expect(cancelScheduled(target)).rejects.toBeInstanceOf(ApiError);
  expect(await getScheduledById(fixture.db, target.id)).not.toBeNull();
});

it('retains account A data when its exact missing response arrives after retirement', async () => {
  const target = await seed();
  const entered = deferred<void>();
  const reply = deferred<Response>();
  mockKy.mockImplementation(() => {
    entered.resolve();
    return reply.promise;
  });
  const operation = cancelScheduled(target);
  const rejected = expect(operation).rejects.toThrow('account session changed');
  await entered.promise;
  const drain = pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  reply.resolve(response(missingEnvelope, 404));
  await rejected;
  await drain;
  expect(await getScheduledById(fixture.db, target.id)).not.toBeNull();
});

it('cancellation first prevents a later local claim and creates no outgoing message', async () => {
  const target = await seed(null);
  await cancelScheduled(target);
  expect(await claimDueScheduled(fixture.db, target.id, 2_000)).toBeNull();
  expect(queuedCount()).toEqual({ count: 0 });
  expect(mockKy).not.toHaveBeenCalled();
});

it('claim first rejects cancellation and preserves the sending occurrence', async () => {
  const target = await seed(null);
  expect(await claimDueScheduled(fixture.db, target.id, 2_000)).not.toBeNull();
  await expect(cancelScheduled(target)).rejects.toBeInstanceOf(ScheduledCancellationChangedError);
  expect(await getScheduledById(fixture.db, target.id)).toMatchObject({ status: 'sending' });
  expect(queuedCount()).toEqual({ count: 0 });
});

it('completed local handoff preserves sent history and its outgoing message', async () => {
  const target = await seed(null);
  await handoff(target);
  await expect(cancelScheduled(target)).rejects.toBeInstanceOf(ScheduledCancellationChangedError);
  expect(await getScheduledById(fixture.db, target.id)).toMatchObject({ status: 'sent' });
  expect(queuedCount()).toEqual({ count: 1 });
});

it('rejects an old repeat occurrence but allows cancelling the refreshed remaining repeat', async () => {
  const target = await seed(null, 'daily');
  await handoff(target, true);
  await expect(cancelScheduled(target)).rejects.toBeInstanceOf(ScheduledCancellationChangedError);
  const next = await getScheduledById(fixture.db, target.id);
  expect(next).toMatchObject({ status: 'pending', scheduledFor: 86_401_000 });
  if (!next) throw new Error('missing repeat');
  await cancelScheduled(next);
  expect(await getScheduledById(fixture.db, target.id)).toBeNull();
  expect(queuedCount()).toEqual({ count: 1 });
});

it('rechecks the exact repeat occurrence after a queued handoff wins the writer', async () => {
  const target = await seed(null, 'daily');
  const entered = deferred<void>();
  const release = deferred<void>();
  const read = deferred<void>();
  const originalRead = scheduledRepository.getScheduledById;
  jest.spyOn(scheduledRepository, 'getScheduledById').mockImplementation(async (...args) => {
    const row = await originalRead(...args);
    expect(row).toMatchObject({ status: 'pending', scheduledFor: 1_000 });
    read.resolve();
    return row;
  });
  const blocker = withDbTransaction(fixture.db, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const claim = claimDueScheduled(fixture.db, target.id, 2_000);
  const handover = handoverScheduledTextToOutgoing(fixture.db, {
    scheduledId: target.id,
    outgoing: {
      tempGuid: 'outgoing-a',
      chatId,
      chatGuid: 'c1',
      text: 'synthetic scheduled text',
      now: 2_000,
    },
    transition: { kind: 'rearm', nextScheduledFor: 86_401_000 },
  });
  const cancel = cancelScheduled(target);
  const rejected = expect(cancel).rejects.toBeInstanceOf(ScheduledCancellationChangedError);
  await read.promise;
  release.resolve();
  await blocker;
  expect(await claim).not.toBeNull();
  await handover;
  await rejected;
  jest.restoreAllMocks();
  const next = await getScheduledById(fixture.db, target.id);
  expect(next).toMatchObject({ status: 'pending', scheduledFor: 86_401_000 });
  expect(queuedCount()).toEqual({ count: 1 });
  if (!next) throw new Error('missing next occurrence');
  await cancelScheduled(next);
  expect(await getScheduledById(fixture.db, target.id)).toBeNull();
  expect(queuedCount()).toEqual({ count: 1 });
});

it.each(['serverId', 'scheduledFor', 'chatGuid'] as const)(
  'retains a replacement %s made while remote DELETE awaits',
  async (field) => {
    const target = await seed();
    const entered = deferred<void>();
    const reply = deferred<Response>();
    mockKy.mockImplementation(() => {
      entered.resolve();
      return reply.promise;
    });
    const operation = cancelScheduled(target);
    const rejected = expect(operation).rejects.toBeInstanceOf(ScheduledCancellationChangedError);
    await entered.promise;
    if (field === 'chatGuid') {
      await withDbTransaction(fixture.db, async () => {
        await fixture.db
          .update(scheduledMessages)
          .set({ chatGuid: 'c2' })
          .where(eq(scheduledMessages.id, target.id));
      });
    } else {
      await updateScheduled(
        fixture.db,
        target.id,
        field === 'serverId' ? { serverId: 'server-b' } : { scheduledFor: 3_000 },
      );
    }
    reply.resolve(response({ status: 200, data: { removed: true } }));
    await rejected;
    expect(await getScheduledById(fixture.db, target.id)).toMatchObject({
      [field]: field === 'serverId' ? 'server-b' : field === 'chatGuid' ? 'c2' : 3_000,
    });
  },
);

it('treats a repeated cancellation of an absent occurrence as complete without another DELETE', async () => {
  const target = await seed();
  await cancelScheduled(target);
  await cancelScheduled(target);
  expect(mockKy).toHaveBeenCalledTimes(1);
  expect(await getScheduledById(fixture.db, target.id)).toBeNull();
});
