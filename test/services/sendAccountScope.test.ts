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
    discardOutgoingMessageWithinTransaction: jest.fn(
      actual.discardOutgoingMessageWithinTransaction as () => unknown,
    ),
    deleteMessageLocalWithinTransaction: jest.fn(
      actual.deleteMessageLocalWithinTransaction as () => unknown,
    ),
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
import {
  deleteMessageLocalWithinTransaction,
  discardOutgoingMessageWithinTransaction,
} from '@db/repositories';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
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
// eslint-disable-next-line import/first
import { createTestDb } from '../support/testDb';

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
const mockDiscardOutgoingWithinTransaction = discardOutgoingMessageWithinTransaction as jest.Mock;
const mockDeleteMessageLocalWithinTransaction = deleteMessageLocalWithinTransaction as jest.Mock;

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
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValueOnce(db);
    mockDiscardOutgoingWithinTransaction.mockResolvedValueOnce(true);
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

  it('passes React persistence a commit guard tied to the captured screen lease', async () => {
    const screenLease = captureRealtimeDeliveryLease();
    await expect(
      react({ chatGuid: 'chat-a', targetGuid: 'message-a', reaction: 'love' }, screenLease),
    ).resolves.toEqual({ tempGuid: 'temp-reaction' });

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { chatGuid: 'chat-a', targetGuid: 'message-a', reaction: 'love' },
      expect.any(Number),
      expect.any(Function),
    );
    const commitGuard = mockSendReaction.mock.calls[0]?.[4] as (() => boolean) | undefined;
    expect(commitGuard?.()).toBe(true);
    await pauseRealtimeDeliveries();
    expect(commitGuard?.()).toBe(false);
    resumeRealtimeDeliveries();
  });

  it('publishes mixed logical sends in order while one multi-image job keeps sibling concurrency', async () => {
    const starts: string[] = [];
    const textResult = deferred<{ tempGuid: string }>();
    const contactResult = deferred<{ tempGuid: string }>();
    const firstImageResult = deferred<{ tempGuid: string }>();
    const secondImageResult = deferred<{ tempGuid: string }>();
    const reactionResult = deferred<{ tempGuid: string }>();
    const replyResult = deferred<{ tempGuid: string }>();
    mockSendText
      .mockImplementationOnce(() => {
        starts.push('text');
        return textResult.promise;
      })
      .mockImplementationOnce(() => {
        starts.push('reply');
        return replyResult.promise;
      });
    mockSendContact.mockImplementationOnce(() => {
      starts.push('contact');
      return contactResult.promise;
    });
    mockSendImage
      .mockImplementationOnce(() => {
        starts.push('image-1');
        return firstImageResult.promise;
      })
      .mockImplementationOnce(() => {
        starts.push('image-2');
        return secondImageResult.promise;
      });
    mockSendReaction.mockImplementationOnce(() => {
      starts.push('reaction');
      return reactionResult.promise;
    });

    const text = send({ chatGuid: 'chat-a', text: 'first' });
    const contact = sendContactCard({
      chatGuid: 'chat-a',
      contact: { firstName: 'Alice' },
    });
    const images = sendImages({
      chatGuid: 'chat-a',
      images: [
        { uri: 'file:///one.jpg', name: 'one.jpg', mimeType: 'image/jpeg', size: 1 },
        { uri: 'file:///two.jpg', name: 'two.jpg', mimeType: 'image/jpeg', size: 2 },
      ],
    });
    const reaction = react({
      chatGuid: 'chat-a',
      targetGuid: 'target-a',
      reaction: 'love',
    });
    const threadedReply = reply({
      chatGuid: 'chat-a',
      text: 'last',
      replyToGuid: 'target-a',
    });

    await waitUntil(() => starts.length === 1);
    expect(starts).toEqual(['text']);

    textResult.resolve({ tempGuid: 'temp-text' });
    await waitUntil(() => starts.length === 2);
    expect(starts).toEqual(['text', 'contact']);

    contactResult.resolve({ tempGuid: 'temp-contact' });
    await waitUntil(() => starts.length === 4);
    expect(starts).toEqual(['text', 'contact', 'image-1', 'image-2']);

    firstImageResult.resolve({ tempGuid: 'temp-image-1' });
    await Promise.resolve();
    expect(starts).toHaveLength(4);
    secondImageResult.resolve({ tempGuid: 'temp-image-2' });
    await waitUntil(() => starts.length === 5);
    expect(starts[4]).toBe('reaction');

    reactionResult.resolve({ tempGuid: 'temp-reaction' });
    await waitUntil(() => starts.length === 6);
    expect(starts[5]).toBe('reply');
    replyResult.resolve({ tempGuid: 'temp-reply' });

    await expect(Promise.all([text, contact, images, reaction, threadedReply])).resolves.toEqual([
      { tempGuid: 'temp-text' },
      { tempGuid: 'temp-contact' },
      [{ tempGuid: 'temp-image-1' }, { tempGuid: 'temp-image-2' }],
      { tempGuid: 'temp-reaction' },
      { tempGuid: 'temp-reply' },
    ]);
  });

  it('does not put edit and unsend mutations behind the logical-send queue', async () => {
    const sendResult = deferred<{ tempGuid: string }>();
    mockSendText.mockReturnValueOnce(sendResult.promise);

    const pendingSend = send({ chatGuid: 'chat-a', text: 'slow send' });
    await waitUntil(() => mockSendText.mock.calls.length === 1);
    const edit = editText({ messageGuid: 'message-a', newText: 'edited', chatGuid: 'chat-a' });
    const retract = unsend({ messageGuid: 'message-b', chatGuid: 'chat-a' });

    await expect(edit).resolves.toEqual({ ok: true });
    await expect(retract).resolves.toEqual({ ok: true });
    expect(mockSendEdit).toHaveBeenCalledTimes(1);
    expect(mockSendUnsend).toHaveBeenCalledTimes(1);

    sendResult.resolve({ tempGuid: 'temp-slow' });
    await expect(pendingSend).resolves.toEqual({ tempGuid: 'temp-slow' });
  });

  it('snapshots mutable send payloads before they wait behind an earlier job', async () => {
    const blockerResult = deferred<{ tempGuid: string }>();
    mockSendText.mockImplementationOnce(() => blockerResult.promise);
    const blocker = send({ chatGuid: 'blocker-chat', text: 'blocker' });
    await waitUntil(() => mockSendText.mock.calls.length === 1);

    const textArgs = {
      chatGuid: 'text-chat',
      text: 'original text',
      mentions: [{ start: 0, length: 8, address: 'alice@example.com' }],
    };
    const singleImageArgs = {
      chatGuid: 'single-image-chat',
      image: {
        uri: 'file:///single.jpg',
        name: 'single.jpg',
        mimeType: 'image/jpeg',
        size: 10,
      },
    };
    const imageBatchArgs = {
      chatGuid: 'batch-chat',
      images: [{ uri: 'file:///batch.jpg', name: 'batch.jpg', mimeType: 'image/jpeg', size: 20 }],
    };
    const contactArgs = {
      chatGuid: 'contact-chat',
      contact: {
        firstName: 'Alice',
        phones: [{ number: '+15550000001', label: 'cell' }],
        emails: [{ address: 'alice@example.com', label: 'home' }],
      },
      replyToGuid: 'contact-reply',
    };
    const reactionArgs = {
      chatGuid: 'reaction-chat',
      targetGuid: 'reaction-target',
      reaction: 'love',
      selectedMessageText: 'original target',
    };
    const replyArgs = {
      chatGuid: 'reply-chat',
      text: 'original reply',
      replyToGuid: 'reply-target',
      effectId: 'original-effect',
    };

    const queued = [
      send(textArgs),
      sendImage(singleImageArgs),
      sendImages(imageBatchArgs),
      sendContactCard(contactArgs),
      react(reactionArgs),
      reply(replyArgs),
    ];

    textArgs.chatGuid = 'mutated-text-chat';
    textArgs.text = 'mutated text';
    textArgs.mentions[0]!.address = 'mutated@example.com';
    singleImageArgs.chatGuid = 'mutated-single-chat';
    singleImageArgs.image.uri = 'file:///mutated-single.jpg';
    imageBatchArgs.chatGuid = 'mutated-batch-chat';
    imageBatchArgs.images[0]!.uri = 'file:///mutated-batch.jpg';
    imageBatchArgs.images.push({
      uri: 'file:///extra.jpg',
      name: 'extra.jpg',
      mimeType: 'image/jpeg',
      size: 30,
    });
    contactArgs.chatGuid = 'mutated-contact-chat';
    contactArgs.contact.firstName = 'Mallory';
    contactArgs.contact.phones[0]!.number = '+15559999999';
    contactArgs.contact.emails[0]!.address = 'mallory@example.com';
    contactArgs.replyToGuid = 'mutated-contact-reply';
    reactionArgs.chatGuid = 'mutated-reaction-chat';
    reactionArgs.targetGuid = 'mutated-reaction-target';
    reactionArgs.reaction = 'dislike';
    reactionArgs.selectedMessageText = 'mutated target';
    replyArgs.chatGuid = 'mutated-reply-chat';
    replyArgs.text = 'mutated reply';
    replyArgs.replyToGuid = 'mutated-reply-target';
    replyArgs.effectId = 'mutated-effect';

    blockerResult.resolve({ tempGuid: 'temp-blocker' });
    await expect(Promise.all([blocker, ...queued])).resolves.toHaveLength(7);

    expect(mockSendText.mock.calls[1]?.[2]).toEqual({
      chatGuid: 'text-chat',
      text: 'original text',
      mentions: [{ start: 0, length: 8, address: 'alice@example.com' }],
    });
    expect(mockSendImage.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'single-image-chat',
      image: {
        uri: 'file:///single.jpg',
        name: 'single.jpg',
        mimeType: 'image/jpeg',
        size: 10,
      },
    });
    expect(mockSendImage.mock.calls[1]?.[2]).toEqual({
      chatGuid: 'batch-chat',
      image: {
        uri: 'file:///batch.jpg',
        name: 'batch.jpg',
        mimeType: 'image/jpeg',
        size: 20,
      },
    });
    expect(mockSendContact.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'contact-chat',
      contact: {
        firstName: 'Alice',
        phones: [{ number: '+15550000001', label: 'cell' }],
        emails: [{ address: 'alice@example.com', label: 'home' }],
      },
      selectedMessageGuid: 'contact-reply',
    });
    expect(mockSendReaction.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'reaction-chat',
      targetGuid: 'reaction-target',
      reaction: 'love',
      selectedMessageText: 'original target',
    });
    expect(mockSendText.mock.calls[2]?.[2]).toEqual({
      chatGuid: 'reply-chat',
      text: 'original reply',
      selectedMessageGuid: 'reply-target',
      effectId: 'original-effect',
    });
  });

  it('refuses a 33rd retained logical send visibly without invoking its transport', async () => {
    const firstResult = deferred<{ tempGuid: string }>();
    mockSendText.mockReturnValueOnce(firstResult.promise);
    const retained = Array.from({ length: 32 }, (_, index) =>
      send({ chatGuid: 'chat-a', text: `retained-${index}` }),
    );
    await waitUntil(() => mockSendText.mock.calls.length === 1);

    await expect(send({ chatGuid: 'chat-a', text: 'over-capacity' })).resolves.toBeNull();
    expect(showToast).toHaveBeenCalledWith('Too many messages are waiting—try again in a moment');
    expect(mockSendText).toHaveBeenCalledTimes(1);

    firstResult.resolve({ tempGuid: 'temp-first' });
    await Promise.all(retained);
    expect(mockSendText).toHaveBeenCalledTimes(32);
  });

  it('suppresses unresolved-message copy when Disconnect invalidates the lease during the DB await', async () => {
    const { db } = await createTestDb();
    (getDatabase as jest.Mock).mockReturnValueOnce(db);
    const deletion = deferred<'unresolved-temp'>();
    mockDiscardOutgoingWithinTransaction.mockResolvedValueOnce(false);
    mockDeleteMessageLocalWithinTransaction.mockReturnValueOnce(deletion.promise);
    const screenLease = captureRealtimeDeliveryLease();

    const pending = discardMessage('temp-stale-account', 1_000, screenLease);
    await waitUntil(() => mockDeleteMessageLocalWithinTransaction.mock.calls.length === 1);

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
