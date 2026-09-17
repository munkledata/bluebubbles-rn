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
jest.mock('@/services/send/outgoingPasteOwnership', () => ({
  createOutgoingPasteOwnershipPreparer: jest.fn(() => jest.fn()),
}));
jest.mock('@/services/send/sendReactionService', () => ({ sendReactionMessage: jest.fn() }));
jest.mock('@/services/send/sendEditService', () => ({
  sendEdit: jest.fn(),
  sendUnsend: jest.fn(),
}));
jest.mock('@/services/send/rcsAttemptCapability', () => ({
  ...jest.requireActual('@/services/send/rcsAttemptCapability'),
  captureSessionRcsCapabilityLease: jest.fn(),
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
import { captureSessionRcsCapabilityLease } from '@/services/send/rcsAttemptCapability';
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
const mockCaptureCapability = captureSessionRcsCapabilityLease as jest.Mock;
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
  mockCaptureCapability.mockReturnValue({
    kind: 'session',
    origin: 'https://capability.test',
    revision: 1,
    serverInfo: {
      private_api: true,
      rcs: true,
      supports_message_part_topology: true,
      supports_send_contact: true,
    },
    isCurrent: () => true,
    publish: () => true,
  });
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('UI send account lease', () => {
  it('fails closed for helper-only mutations while preserving an enabled RCS reaction', async () => {
    mockCaptureCapability.mockReturnValue({
      kind: 'session',
      origin: 'https://capability.test',
      revision: 1,
      serverInfo: { private_api: false, rcs: true, supports_message_part_topology: true },
      isCurrent: () => true,
      publish: () => true,
    });

    await expect(
      react({ chatGuid: 'iMessage;-;+15551234567', targetGuid: 'm1', reaction: 'love' }),
    ).resolves.toBeNull();
    await expect(
      editText({ chatGuid: 'iMessage;-;+15551234567', messageGuid: 'm1', newText: 'edited' }),
    ).resolves.toBeNull();
    await expect(
      unsend({ chatGuid: 'iMessage;-;+15551234567', messageGuid: 'm1' }),
    ).resolves.toBeNull();
    await expect(
      send({ chatGuid: 'iMessage;-;+15551234567', text: 'party', effectId: 'confetti' }),
    ).resolves.toBeNull();
    await expect(
      reply({ chatGuid: 'iMessage;-;+15551234567', text: 'reply', replyToGuid: 'm1' }),
    ).resolves.toBeNull();

    expect(mockSendReaction).not.toHaveBeenCalled();
    expect(mockSendEdit).not.toHaveBeenCalled();
    expect(mockSendUnsend).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();

    await expect(
      send({ chatGuid: 'iMessage;-;+15551234567', text: 'plain text' }),
    ).resolves.toEqual({ tempGuid: 'temp-text' });
    expect(mockSendText).toHaveBeenCalledTimes(1);

    await expect(
      react({ chatGuid: 'RCS;-;+15551234567', targetGuid: 'rcs-m1', reaction: 'love' }),
    ).resolves.toEqual({ tempGuid: 'temp-reaction' });
    expect(mockSendReaction).toHaveBeenCalledTimes(1);
  });

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
    await expect(retry('temp-a', screenLease)).resolves.toBe('stale');
    await expect(discardMessage('message-a', 1_000, screenLease)).resolves.toBe('stale');

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

  it('passes a text persistence guard tied to its captured lease', async () => {
    const sendQueued = jest.fn();
    const sendLease = captureRealtimeDeliveryLease();
    await expect(
      send({ chatGuid: 'chat-a', text: 'plain text' }, sendLease, undefined, sendQueued),
    ).resolves.toEqual({ tempGuid: 'temp-text' });

    expect(mockSendText).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      { chatGuid: 'chat-a', text: 'plain text', mentions: undefined },
      expect.any(Number),
      expect.any(Function),
      undefined,
      expect.any(Function),
      expect.anything(),
    );
    const sendGuard = mockSendText.mock.calls[0]?.[6] as (() => boolean) | undefined;
    const sendAdmission = mockSendText.mock.calls[0]?.[4] as
      ((tempGuid: string) => void) | undefined;
    expect(sendGuard?.()).toBe(true);
    sendAdmission?.('temp-send');
    expect(sendQueued).toHaveBeenCalledWith('temp-send');

    await pauseRealtimeDeliveries();
    expect(sendGuard?.()).toBe(false);
    sendAdmission?.('late-send');
    expect(sendQueued).toHaveBeenCalledTimes(1);
    resumeRealtimeDeliveries();
  });

  it('passes both contact persistence fronts guards tied to their captured leases', async () => {
    const directQueued = jest.fn();
    const pickerQueued = jest.fn();
    const directLease = captureRealtimeDeliveryLease();
    await expect(
      sendContactCard(
        {
          chatGuid: 'RCS;-;chat-a',
          contact: { firstName: 'Alice' },
        },
        directLease,
        undefined,
        directQueued,
      ),
    ).resolves.toEqual({ tempGuid: 'temp-contact' });

    mockPickContact.mockResolvedValueOnce({ firstName: 'Bob' });
    const pickerLease = captureRealtimeDeliveryLease();
    await expect(
      pickAndSendContact('RCS;-;chat-b', pickerLease, undefined, undefined, pickerQueued),
    ).resolves.toEqual({ tempGuid: 'temp-contact' });

    expect(mockSendContact).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      {
        chatGuid: 'RCS;-;chat-a',
        contact: { firstName: 'Alice' },
        selectedMessageGuid: undefined,
        partIndex: undefined,
      },
      expect.any(Number),
      expect.any(Function),
      expect.anything(),
      expect.any(Function),
    );
    expect(mockSendContact).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      {
        chatGuid: 'RCS;-;chat-b',
        contact: { firstName: 'Bob' },
        selectedMessageGuid: undefined,
        partIndex: undefined,
      },
      expect.any(Number),
      expect.any(Function),
      expect.anything(),
      expect.any(Function),
    );
    const directGuard = mockSendContact.mock.calls[0]?.[4] as (() => boolean) | undefined;
    const pickerGuard = mockSendContact.mock.calls[1]?.[4] as (() => boolean) | undefined;
    const directAdmission = mockSendContact.mock.calls[0]?.[6] as
      ((tempGuid: string) => void) | undefined;
    const pickerAdmission = mockSendContact.mock.calls[1]?.[6] as
      ((tempGuid: string) => void) | undefined;
    expect(directGuard?.()).toBe(true);
    expect(pickerGuard?.()).toBe(true);
    directAdmission?.('temp-direct-contact');
    pickerAdmission?.('temp-picker-contact');
    expect(directQueued).toHaveBeenCalledWith('temp-direct-contact');
    expect(pickerQueued).toHaveBeenCalledWith('temp-picker-contact');

    await pauseRealtimeDeliveries();
    expect(directGuard?.()).toBe(false);
    expect(pickerGuard?.()).toBe(false);
    directAdmission?.('late-direct-contact');
    pickerAdmission?.('late-picker-contact');
    expect(directQueued).toHaveBeenCalledTimes(1);
    expect(pickerQueued).toHaveBeenCalledTimes(1);
    resumeRealtimeDeliveries();
  });

  it('passes single and multi-image persistence guards tied to their captured leases', async () => {
    const singleQueued = jest.fn();
    const batchAdmission = jest.fn();
    const singleLease = captureRealtimeDeliveryLease();
    await expect(
      sendImage(
        {
          chatGuid: 'RCS;-;chat-a',
          image: { uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 10 },
        },
        singleLease,
        undefined,
        singleQueued,
      ),
    ).resolves.toEqual({ tempGuid: 'temp-image' });

    const batchLease = captureRealtimeDeliveryLease();
    await expect(
      sendImages(
        {
          chatGuid: 'RCS;-;chat-b',
          images: [
            { uri: 'file:///b.jpg', name: 'b.jpg', mimeType: 'image/jpeg', size: 20 },
            { uri: 'file:///c.jpg', name: 'c.jpg', mimeType: 'image/jpeg', size: 30 },
          ],
        },
        batchLease,
        undefined,
        batchAdmission,
      ),
    ).resolves.toEqual([{ tempGuid: 'temp-image' }, { tempGuid: 'temp-image' }]);

    expect(mockSendImage).toHaveBeenCalledTimes(3);
    for (const call of mockSendImage.mock.calls) {
      expect(call).toEqual([
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ chatGuid: expect.stringMatching(/^RCS;-;chat-[ab]$/) }),
        expect.anything(),
        expect.any(Number),
        expect.any(Function),
        undefined,
        expect.any(Function),
        expect.any(Function),
        expect.anything(),
      ]);
    }
    const singleGuard = mockSendImage.mock.calls[0]?.[5] as (() => boolean) | undefined;
    const firstBatchGuard = mockSendImage.mock.calls[1]?.[5] as (() => boolean) | undefined;
    const secondBatchGuard = mockSendImage.mock.calls[2]?.[5] as (() => boolean) | undefined;
    expect(singleGuard?.()).toBe(true);
    expect(firstBatchGuard?.()).toBe(true);
    expect(secondBatchGuard?.()).toBe(true);
    expect(mockSendImage.mock.calls[0]?.[7]).not.toBe(mockSendImage.mock.calls[1]?.[7]);
    expect(mockSendImage.mock.calls[1]?.[7]).toBe(mockSendImage.mock.calls[2]?.[7]);
    const singleAdmission = mockSendImage.mock.calls[0]?.[8] as
      ((tempGuid: string) => void) | undefined;
    const firstBatchAdmission = mockSendImage.mock.calls[1]?.[8] as
      ((tempGuid: string) => void) | undefined;
    singleAdmission?.('temp-single');
    firstBatchAdmission?.('temp-b');
    expect(singleQueued).toHaveBeenCalledWith('temp-single');
    expect(batchAdmission).toHaveBeenCalledWith({
      uri: 'file:///b.jpg',
      queued: true,
      tempGuid: 'temp-b',
    });

    await pauseRealtimeDeliveries();
    expect(singleGuard?.()).toBe(false);
    expect(firstBatchGuard?.()).toBe(false);
    expect(secondBatchGuard?.()).toBe(false);
    singleAdmission?.('late-single');
    firstBatchAdmission?.('late-b');
    expect(singleQueued).toHaveBeenCalledTimes(1);
    expect(batchAdmission).toHaveBeenCalledTimes(1);
    resumeRealtimeDeliveries();
  });

  it('passes React persistence a commit guard tied to the captured screen lease', async () => {
    const screenLease = captureRealtimeDeliveryLease();
    await expect(
      react(
        { chatGuid: 'RCS;-;chat-a', targetGuid: 'rcs-message-a', reaction: 'love' },
        screenLease,
      ),
    ).resolves.toEqual({ tempGuid: 'temp-reaction' });

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { chatGuid: 'RCS;-;chat-a', targetGuid: 'rcs-message-a', reaction: 'love' },
      expect.any(Number),
      expect.any(Function),
      expect.anything(),
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
    mockSendText.mockImplementationOnce(() => {
      starts.push('text');
      return textResult.promise;
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
      chatGuid: 'RCS;-;contact-chat',
      contact: { firstName: 'Alice' },
    });
    const images = sendImages({
      chatGuid: 'RCS;-;image-chat',
      images: [
        { uri: 'file:///one.jpg', name: 'one.jpg', mimeType: 'image/jpeg', size: 1 },
        { uri: 'file:///two.jpg', name: 'two.jpg', mimeType: 'image/jpeg', size: 2 },
      ],
    });
    const reaction = react({
      chatGuid: 'RCS;-;reaction-chat',
      targetGuid: 'rcs-target-a',
      reaction: 'love',
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

    await expect(Promise.all([text, contact, images, reaction])).resolves.toEqual([
      { tempGuid: 'temp-text' },
      { tempGuid: 'temp-contact' },
      [{ tempGuid: 'temp-image-1' }, { tempGuid: 'temp-image-2' }],
      { tempGuid: 'temp-reaction' },
    ]);
  });

  it('rejects retired edit and unsend immediately instead of retaining them in the send queue', async () => {
    const sendResult = deferred<{ tempGuid: string }>();
    mockSendText.mockReturnValueOnce(sendResult.promise);

    const pendingSend = send({ chatGuid: 'chat-a', text: 'slow send' });
    await waitUntil(() => mockSendText.mock.calls.length === 1);
    const edit = editText({ messageGuid: 'message-a', newText: 'edited', chatGuid: 'chat-a' });
    const retract = unsend({ messageGuid: 'message-b', chatGuid: 'chat-a' });

    await expect(edit).resolves.toBeNull();
    await expect(retract).resolves.toBeNull();
    expect(mockSendEdit).not.toHaveBeenCalled();
    expect(mockSendUnsend).not.toHaveBeenCalled();

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
    };
    const singleImageArgs = {
      chatGuid: 'RCS;-;single-image-chat',
      image: {
        uri: 'file:///single.jpg',
        name: 'single.jpg',
        mimeType: 'image/jpeg',
        size: 10,
      },
    };
    const imageBatchArgs = {
      chatGuid: 'RCS;-;batch-chat',
      images: [{ uri: 'file:///batch.jpg', name: 'batch.jpg', mimeType: 'image/jpeg', size: 20 }],
    };
    const contactArgs = {
      chatGuid: 'RCS;-;contact-chat',
      contact: {
        firstName: 'Alice',
        phones: [{ number: '+15550000001', label: 'cell' }],
        emails: [{ address: 'alice@example.com', label: 'home' }],
      },
    };
    const reactionArgs = {
      chatGuid: 'RCS;-;reaction-chat',
      targetGuid: 'rcs-reaction-target',
      reaction: 'love',
      selectedMessageText: 'original target',
    };

    const queued = [
      send(textArgs),
      sendImage(singleImageArgs),
      sendImages(imageBatchArgs),
      sendContactCard(contactArgs),
      react(reactionArgs),
    ];

    textArgs.chatGuid = 'mutated-text-chat';
    textArgs.text = 'mutated text';
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
    reactionArgs.chatGuid = 'mutated-reaction-chat';
    reactionArgs.targetGuid = 'mutated-reaction-target';
    reactionArgs.reaction = 'dislike';
    reactionArgs.selectedMessageText = 'mutated target';
    blockerResult.resolve({ tempGuid: 'temp-blocker' });
    await expect(Promise.all([blocker, ...queued])).resolves.toHaveLength(6);

    expect(mockSendText.mock.calls[1]?.[2]).toEqual({
      chatGuid: 'text-chat',
      text: 'original text',
      mentions: undefined,
    });
    expect(mockSendImage.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'RCS;-;single-image-chat',
      image: {
        uri: 'file:///single.jpg',
        name: 'single.jpg',
        mimeType: 'image/jpeg',
        size: 10,
      },
    });
    expect(mockSendImage.mock.calls[1]?.[2]).toEqual({
      chatGuid: 'RCS;-;batch-chat',
      image: {
        uri: 'file:///batch.jpg',
        name: 'batch.jpg',
        mimeType: 'image/jpeg',
        size: 20,
      },
    });
    expect(mockSendContact.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'RCS;-;contact-chat',
      contact: {
        firstName: 'Alice',
        phones: [{ number: '+15550000001', label: 'cell' }],
        emails: [{ address: 'alice@example.com', label: 'home' }],
      },
      selectedMessageGuid: undefined,
      partIndex: undefined,
    });
    expect(mockSendReaction.mock.calls[0]?.[2]).toEqual({
      chatGuid: 'RCS;-;reaction-chat',
      targetGuid: 'rcs-reaction-target',
      reaction: 'love',
      selectedMessageText: 'original target',
    });
  });

  it('refuses a 33rd retained logical send visibly without invoking its transport', async () => {
    const firstResult = deferred<{ tempGuid: string }>();
    mockSendText.mockReturnValueOnce(firstResult.promise);
    const retained = Array.from({ length: 32 }, (_, index) =>
      send({ chatGuid: 'chat-a', text: `retained-${index}` }),
    );
    await waitUntil(() => mockSendText.mock.calls.length === 1);

    const reportIssue = jest.fn();
    await expect(
      send({ chatGuid: 'chat-a', text: 'over-capacity' }, undefined, reportIssue),
    ).resolves.toBeNull();
    expect(reportIssue).toHaveBeenCalledWith('queue-capacity');
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
    await expect(pending).resolves.toBe('stale');
    await drain;
    resumeRealtimeDeliveries();
  });

  it('keeps tracking sibling image sends after one item rejects early', async () => {
    const slowImage = deferred<{ tempGuid: string }>();
    mockSendImage
      .mockRejectedValueOnce(new Error('first image failed'))
      .mockReturnValueOnce(slowImage.promise);

    const pending = sendImages({
      chatGuid: 'RCS;-;chat-a',
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

    const pending = pickAndSendContact('RCS;-;chat-a', screenLease);
    await waitUntil(() => mockPickContact.mock.calls.length === 1);

    // No account mutation has begun, so Disconnect need not wait for a user-controlled OS sheet.
    await expect(pauseRealtimeDeliveries()).resolves.toBeUndefined();
    resumeRealtimeDeliveries();
    picked.resolve({ firstName: 'Alice A' });

    await expect(pending).resolves.toBeNull();
    expect(mockSendContact).not.toHaveBeenCalled();
  });
});
