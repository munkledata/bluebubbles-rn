/**
 * Account ownership at the production UI send barrel.
 *
 * Low-level send orchestrators have their own detailed DB/network tests. These tests pin the
 * composition boundary that screens actually call: complete work holds Disconnect's drain, a
 * retired screen lease is a quiet no-op, and a native picker result cannot adopt the next account.
 */
jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => ({ account: 'A' })) }));
jest.mock('@db/repositories', () => {
  const actual = jest.requireActual('@db/repositories') as Record<string, unknown>;
  return {
    ...actual,
    discardOutgoingMessage: jest.fn(actual.discardOutgoingMessage as () => unknown),
    deleteMessageLocal: jest.fn(actual.deleteMessageLocal as () => unknown),
  };
});
jest.mock('@/services/clients', () => ({ http: { account: 'A' } }));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-test'),
  sendTextMessage: jest.fn(),
}));
jest.mock('@/services/send/sendAttachmentService', () => ({ sendImageMessage: jest.fn() }));
jest.mock('@/services/send/sendReactionService', () => ({ sendReactionMessage: jest.fn() }));
jest.mock('@/services/send/sendEditService', () => ({
  sendEdit: jest.fn(),
  sendUnsend: jest.fn(),
}));
jest.mock('@/services/send/sendContactService', () => ({
  contactDisplayName: jest.fn(() => 'Contact'),
  hasContactContent: jest.fn((contact: { firstName?: string }) =>
    Boolean(contact.firstName?.trim()),
  ),
  sendContactMessage: jest.fn(),
}));
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
}));
jest.mock('@/services/send/uploadControl', () => ({
  uploadRegistry: { cancel: jest.fn() },
}));
jest.mock('@ui/toast/toastStore', () => ({ showToast: jest.fn() }));

// eslint-disable-next-line import/first
import {
  discardMessage,
  editText,
  pickAndSendContact,
  react,
  reply,
  retry,
  send,
  sendContactCard,
  sendImage,
  sendImages,
  unsend,
} from '@/services/send';
// eslint-disable-next-line import/first
import { pickContact } from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import { sendContactMessage } from '@/services/send/sendContactService';
// eslint-disable-next-line import/first
import { sendTextMessage } from '@/services/send/sendService';
// eslint-disable-next-line import/first
import { sendImageMessage } from '@/services/send/sendAttachmentService';
// eslint-disable-next-line import/first
import { sendReactionMessage } from '@/services/send/sendReactionService';
// eslint-disable-next-line import/first
import { sendEdit, sendUnsend } from '@/services/send/sendEditService';
// eslint-disable-next-line import/first
import { uploadRegistry } from '@/services/send/uploadControl';
// eslint-disable-next-line import/first
import { deleteMessageLocal, discardOutgoingMessage } from '@db/repositories';
// eslint-disable-next-line import/first
import { showToast } from '@ui/toast/toastStore';
// eslint-disable-next-line import/first
import { createAttachmentCacheAccountScope } from '@/services/download/attachmentCacheAccountScope';
// eslint-disable-next-line import/first
import { attachmentCacheCoordinator } from '@/services/download/attachmentCacheCoordinator';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('deferred operation did not reach its test seam');
}

const mockSendText = sendTextMessage as jest.Mock;
const mockPickContact = pickContact as jest.Mock;
const mockSendContact = sendContactMessage as jest.Mock;
const mockSendImage = sendImageMessage as jest.Mock;
const mockSendReaction = sendReactionMessage as jest.Mock;
const mockSendEdit = sendEdit as jest.Mock;
const mockSendUnsend = sendUnsend as jest.Mock;
const mockDiscardOutgoing = discardOutgoingMessage as jest.Mock;
const mockDeleteMessageLocal = deleteMessageLocal as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  resumeRealtimeDeliveries();
  mockSendText.mockResolvedValue({ tempGuid: 'temp-text' });
  mockSendContact.mockResolvedValue({ tempGuid: 'temp-contact' });
  mockSendImage.mockResolvedValue({ tempGuid: 'temp-image' });
  mockSendReaction.mockResolvedValue({ tempGuid: 'temp-reaction' });
  mockSendEdit.mockResolvedValue({ ok: true });
  mockSendUnsend.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('UI send account lease', () => {
  it('runs current cache work and rejects a retired lease before invoking work', async () => {
    const lease = captureRealtimeDeliveryLease();
    const scope = createAttachmentCacheAccountScope(lease);
    const currentTask = jest.fn(async () => ({ source: 'tracked-account' }) as const);

    await expect(scope.runTracked(currentTask)).resolves.toEqual({ source: 'tracked-account' });
    expect(currentTask).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    expect(scope.isCurrent()).toBe(false);
    const staleTask = jest.fn(async () => 'wrong-account');
    await expect(scope.runTracked(staleTask)).resolves.toBeNull();
    expect(staleTask).not.toHaveBeenCalled();
  });

  it('drains admitted tracked cache work before completing account revocation', async () => {
    const taskStarted = deferred<void>();
    const releaseTask = deferred<void>();
    let operation: Promise<unknown> | undefined;
    let pause: Promise<void> | undefined;
    try {
      const lease = captureRealtimeDeliveryLease();
      const scope = createAttachmentCacheAccountScope(lease);
      const admittedTask = jest.fn(async () => {
        taskStarted.resolve(undefined);
        await releaseTask.promise;
        return 'finished';
      });
      operation = scope.runTracked(admittedTask);
      await taskStarted.promise;

      let pauseSettled = false;
      pause = pauseRealtimeDeliveries().then(() => {
        pauseSettled = true;
      });
      await Promise.resolve();
      expect(pauseSettled).toBe(false);

      releaseTask.resolve(undefined);
      await expect(operation).resolves.toBe('finished');
      await pause;
      expect(scope.isCurrent()).toBe(false);
      expect(admittedTask).toHaveBeenCalledTimes(1);

      resumeRealtimeDeliveries();
      const successor = createAttachmentCacheAccountScope(captureRealtimeDeliveryLease());
      await expect(successor.runTracked(async () => 'successor')).resolves.toBe('successor');
    } finally {
      releaseTask.resolve(undefined);
      await Promise.allSettled([operation, pause].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it('passes one cache scope from message discard through retirement and retry drain', async () => {
    mockDiscardOutgoing.mockResolvedValueOnce(true);
    const retire = jest
      .spyOn(attachmentCacheCoordinator, 'retireInactiveEntries')
      .mockResolvedValue({
        status: 'complete',
        attempted: 0,
        confirmed: 0,
        failed: 0,
        skipped: 0,
      });
    const drain = jest.spyOn(attachmentCacheCoordinator, 'drainDueRetirements').mockResolvedValue({
      status: 'complete',
      attempted: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
    });
    const lease = captureRealtimeDeliveryLease();
    try {
      await discardMessage('temp-cache-scope', 1_000, lease);

      expect(retire).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledTimes(1);
      const scope = retire.mock.calls[0]?.[1]?.scope;
      expect(scope).toBeDefined();
      expect(scope?.generation).toBe(lease.generation);
      expect(scope?.isCurrent()).toBe(true);
      expect(drain.mock.calls[0]?.[1]?.scope).toBe(scope);
    } finally {
      retire.mockRestore();
      drain.mockRestore();
    }
  });

  it('quietly rejects every ordinary action carrying a retired screen lease', async () => {
    const screenLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await expect(send({ chatGuid: 'chat-a', text: 'A secret' }, screenLease)).resolves.toBeNull();
    await expect(
      sendImage(
        {
          chatGuid: 'chat-a',
          image: {
            uri: 'file:///a.jpg',
            name: 'a.jpg',
            mimeType: 'image/jpeg',
            size: 10,
          },
        },
        screenLease,
      ),
    ).resolves.toBeNull();
    await expect(
      sendImages(
        {
          chatGuid: 'chat-a',
          images: [
            {
              uri: 'file:///a.jpg',
              name: 'a.jpg',
              mimeType: 'image/jpeg',
              size: 10,
            },
          ],
        },
        screenLease,
      ),
    ).resolves.toBeNull();
    await expect(
      sendContactCard({ chatGuid: 'chat-a', contact: { firstName: 'Alice' } }, screenLease),
    ).resolves.toBeNull();
    await expect(pickAndSendContact('chat-a', screenLease)).resolves.toBeNull();
    await expect(
      react({ chatGuid: 'chat-a', targetGuid: 'message-a', reaction: 'love' }, screenLease),
    ).resolves.toBeNull();
    await expect(
      reply({ chatGuid: 'chat-a', text: 'reply', replyToGuid: 'message-a' }, screenLease),
    ).resolves.toBeNull();
    await expect(
      editText({ messageGuid: 'message-a', newText: 'edited', chatGuid: 'chat-a' }, screenLease),
    ).resolves.toBeNull();
    await expect(
      unsend({ messageGuid: 'message-a', chatGuid: 'chat-a' }, screenLease),
    ).resolves.toBeNull();
    await expect(retry('temp-a', screenLease)).resolves.toBeUndefined();
    await expect(discardMessage('message-a', 1_000, screenLease)).resolves.toBeUndefined();

    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockSendImage).not.toHaveBeenCalled();
    expect(mockSendContact).not.toHaveBeenCalled();
    expect(mockPickContact).not.toHaveBeenCalled();
    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockSendEdit).not.toHaveBeenCalled();
    expect(mockSendUnsend).not.toHaveBeenCalled();
    expect(uploadRegistry.cancel).not.toHaveBeenCalled();
  });

  it('keeps an admitted send visible to Disconnect until the complete operation settles', async () => {
    const response = deferred<{ tempGuid: string }>();
    mockSendText.mockReturnValueOnce(response.promise);

    const pending = send({ chatGuid: 'chat-a', text: 'A secret' });
    await waitUntil(() => mockSendText.mock.calls.length === 1);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    // Model a future regression that reopens admission too early. The immutable A lease still
    // cannot become current again, and the old completion is returned quietly.
    resumeRealtimeDeliveries();
    response.resolve({ tempGuid: 'temp-a' });

    await expect(pending).resolves.toBeNull();
    await drain;
    expect(drained).toBe(true);
  });

  it('suppresses unresolved-message copy when Disconnect invalidates the lease during the DB await', async () => {
    const deletion = deferred<'unresolved-temp'>();
    mockDiscardOutgoing.mockResolvedValueOnce(false);
    mockDeleteMessageLocal.mockReturnValueOnce(deletion.promise);
    const screenLease = captureRealtimeDeliveryLease();

    const pending = discardMessage('temp-stale-account', 1_000, screenLease);
    await waitUntil(() => mockDeleteMessageLocal.mock.calls.length === 1);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    deletion.resolve('unresolved-temp');
    await expect(pending).resolves.toBeUndefined();
    await drain;
    resumeRealtimeDeliveries();

    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps tracking sibling image sends after one item rejects early', async () => {
    const slowImage = deferred<{ tempGuid: string }>();
    mockSendImage
      .mockRejectedValueOnce(new Error('first image failed'))
      .mockReturnValueOnce(slowImage.promise);

    const pending = sendImages({
      chatGuid: 'chat-a',
      images: [
        { uri: 'file:///one.jpg', name: 'one.jpg', mimeType: 'image/jpeg', size: 1 },
        { uri: 'file:///two.jpg', name: 'two.jpg', mimeType: 'image/jpeg', size: 2 },
      ],
    });
    await waitUntil(() => mockSendImage.mock.calls.length === 2);

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    slowImage.resolve({ tempGuid: 'temp-two' });
    // Disconnect retired this operation, so its old failure is quiet after every sibling settles.
    await expect(pending).resolves.toBeNull();
    await drain;
    expect(drained).toBe(true);
  });

  it('does not hold the drain on an OS contact picker or send its late A result through B', async () => {
    const picked = deferred<{ firstName: string } | null>();
    mockPickContact.mockReturnValueOnce(picked.promise);
    const screenLease = captureRealtimeDeliveryLease();

    const pending = pickAndSendContact('chat-a', screenLease);
    await waitUntil(() => mockPickContact.mock.calls.length === 1);

    // No account mutation has begun, so Disconnect need not wait for a user-controlled OS sheet.
    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    picked.resolve({ firstName: 'Alice A' });

    await expect(pending).resolves.toBeNull();
    expect(mockSendContact).not.toHaveBeenCalled();
  });
});
