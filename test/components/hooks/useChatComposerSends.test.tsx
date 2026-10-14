/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockEditText = jest.fn();
const mockReply = jest.fn();
const mockSend = jest.fn();
const mockSendEffect = jest.fn();
const mockSendMention = jest.fn();
const mockSendFormatted = jest.fn();
const mockSchedule = jest.fn();
const mockScheduleAttachment = jest.fn();
const mockDevSendFake = jest.fn();
const mockIsDevServer = jest.fn(() => false);
const mockShowToast = jest.fn();
const mockShowDialog = jest.fn();

jest.mock('@/services/send', () => ({
  editText: (...args: unknown[]) => mockEditText(...args),
  reply: (...args: unknown[]) => mockReply(...args),
  send: (...args: unknown[]) => mockSend(...args),
  sendEffect: (...args: unknown[]) => mockSendEffect(...args),
  sendMention: (...args: unknown[]) => mockSendMention(...args),
  sendFormatted: (...args: unknown[]) => mockSendFormatted(...args),
  schedule: (...args: unknown[]) => mockSchedule(...args),
  scheduleAttachment: (...args: unknown[]) => mockScheduleAttachment(...args),
}));
jest.mock('@features/conversations/devSeed', () => ({
  devSendFake: (...args: unknown[]) => mockDevSendFake(...args),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));
jest.mock('@ui', () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));
jest.mock('@ui/conversations/sendNotices', () => ({ presentSendIssue: jest.fn() }));
jest.mock('@core/secure', () => ({ logger: { warn: jest.fn() } }));

import type { MessagePreview } from '@db/repositories';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import {
  useChatComposerSends,
  type ChatComposerSendOptions,
  type ComposerEditTarget,
} from '@features/conversations/useChatComposerSends';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { renderHook } from '../support/renderWithTheme';

const CHAT = 'iMessage;-;+15550001111';
const ALL_AVAILABLE: ChatComposerSendOptions['capabilities'] = {
  imessageScheduledAttachmentsAvailable: true,
  imessageEditsAvailable: true,
  imessageRepliesAvailable: true,
  imessageEffectsAvailable: true,
  imessageMentionsAvailable: true,
  mentionParticipants: [
    { address: 'ann@example.com', label: 'Ann' },
    { address: 'ben@example.com', label: 'Ben' },
  ],
  imessageFormattedAvailable: true,
};

function preview(guid: string): MessagePreview {
  return {
    guid,
    text: 'original',
    senderName: 'Ann',
    isFromMe: 0,
    hasAttachments: 0,
    targetPartIndex: 0,
  };
}

/** Make a queue-backed service call report the DB queue handoff, then succeed. */
function queuesThenSends(onQueuedArgIndex: number) {
  return (...args: unknown[]) => {
    (args[onQueuedArgIndex] as () => void)();
    return Promise.resolve({ status: 'sent' });
  };
}

async function sends(overrides: Partial<ChatComposerSendOptions> = {}) {
  const options: ChatComposerSendOptions = {
    guid: CHAT,
    accountLease: captureRealtimeDeliveryLease(),
    capabilities: ALL_AVAILABLE,
    editing: null,
    setEditing: jest.fn(),
    replyTo: null,
    setReplyTo: jest.fn(),
    ...overrides,
  };
  const { result } = await renderHook(() => useChatComposerSends(options));
  return { ...result.current, options };
}

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
});

describe('useChatComposerSends', () => {
  it('sends a pending edit and clears only that edit once accepted', async () => {
    const editing: ComposerEditTarget = { guid: 'msg-1', text: 'old', partIndex: 0 };
    mockEditText.mockResolvedValue({ status: 'sent' });
    const { onSend, options } = await sends({ editing });

    await expect(onSend('new text')).resolves.toBe(true);

    expect(mockEditText).toHaveBeenCalledWith(
      { chatGuid: CHAT, messageGuid: 'msg-1', newText: 'new text', partIndex: 0 },
      options.accountLease,
    );
    const clear = (options.setEditing as jest.Mock).mock.calls[0]?.[0] as (
      current: ComposerEditTarget | null,
    ) => ComposerEditTarget | null;
    expect(clear(editing)).toBeNull();
    const newer = { guid: 'msg-2', text: 'x', partIndex: 0 as const };
    expect(clear(newer)).toBe(newer);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps a rejected edit, and warns when an edit outcome is unknown', async () => {
    const editing: ComposerEditTarget = { guid: 'msg-1', text: 'old', partIndex: 0 };
    mockEditText.mockResolvedValueOnce({ status: 'rejected' });
    const rejected = await sends({ editing });
    await expect(rejected.onSend('new')).resolves.toBe(false);
    expect(rejected.options.setEditing).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenLastCalledWith('Edit Not Sent', expect.any(String));

    mockEditText.mockResolvedValueOnce({ status: 'outcome-unknown' });
    const unknown = await sends({ editing });
    await expect(unknown.onSend('new')).resolves.toBe(true);
    expect(mockShowDialog).toHaveBeenLastCalledWith('Edit Not Confirmed', expect.any(String));
  });

  it('keeps the edit text when editing is not available', async () => {
    const { onSend } = await sends({
      editing: { guid: 'msg-1', text: 'old', partIndex: 0 },
      capabilities: { ...ALL_AVAILABLE, imessageEditsAvailable: false },
    });

    await expect(onSend('new')).resolves.toBe(false);
    expect(mockEditText).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  it('queues a reply and clears the reply target once it reaches the queue', async () => {
    mockReply.mockImplementation(queuesThenSends(3));
    const { onSend, options } = await sends({ replyTo: preview('msg-2') });

    await expect(onSend('hi')).resolves.toBe(true);

    expect(mockReply.mock.calls[0]?.[0]).toEqual({
      chatGuid: CHAT,
      text: 'hi',
      replyToGuid: 'msg-2',
      replyToPartIndex: 0,
    });
    const clear = (options.setReplyTo as jest.Mock).mock.calls[0]?.[0] as (
      current: MessagePreview | null,
    ) => MessagePreview | null;
    expect(clear(preview('msg-2'))).toBeNull();
    expect(clear(preview('msg-3'))?.guid).toBe('msg-3');
  });

  it('keeps the reply target and draft when the reply fails before the queue', async () => {
    mockReply.mockRejectedValue(new Error('offline'));
    const { onSend, options } = await sends({ replyTo: preview('msg-2') });

    await expect(onSend('hi')).resolves.toBe(false);

    expect(options.setReplyTo).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      'Couldn’t queue that reply. Your draft is still here',
    );
  });

  it('tells you when a plain message never reached the queue, and keeps the draft', async () => {
    // A capability refresh during queue admission makes send() resolve null without queueing.
    mockSend.mockResolvedValue(null);
    const { onSend } = await sends();

    await expect(onSend('hello')).resolves.toBe(false);

    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      'Couldn’t queue that message. Your draft is still here—try again when connected',
    );
  });

  it('shows only the queue-full notice when a send or reply is refused for capacity', async () => {
    const refusedForCapacity = (...args: unknown[]) => {
      (args[2] as (issue: string) => void)('queue-capacity');
      return Promise.resolve(null);
    };
    mockSend.mockImplementation(refusedForCapacity);
    mockReply.mockImplementation(refusedForCapacity);
    const plain = await sends();
    const replying = await sends({ replyTo: preview('msg-2') });

    await expect(plain.onSend('hello')).resolves.toBe(false);
    await expect(replying.onSend('hi')).resolves.toBe(false);

    expect(jest.mocked(presentSendIssue).mock.calls).toEqual([
      ['queue-capacity'],
      ['queue-capacity'],
    ]);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('sends plain text, or the dev fake on the local dev server', async () => {
    mockSend.mockImplementation(queuesThenSends(3));
    const real = await sends();
    await expect(real.onSend('hello')).resolves.toBe(true);
    expect(mockSend.mock.calls[0]?.[0]).toEqual({ chatGuid: CHAT, text: 'hello' });

    mockIsDevServer.mockReturnValue(true);
    mockDevSendFake.mockImplementation(queuesThenSends(4));
    const dev = await sends();
    await expect(dev.onSend('hello')).resolves.toBe(true);
    expect(mockDevSendFake).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    mockIsDevServer.mockReturnValue(false);
  });

  it('sends effects, mentions and formatted text only while the chat supports them', async () => {
    const unsupported = await sends({
      capabilities: {
        ...ALL_AVAILABLE,
        imessageEffectsAvailable: false,
        imessageFormattedAvailable: false,
        mentionParticipants: [{ address: 'ann@example.com', label: 'Ann' }],
      },
    });
    await expect(unsupported.onSendEffect('boom', 'effect-id')).resolves.toBe(false);
    await expect(unsupported.onSendFormatted('bold', [])).resolves.toBe(false);
    await expect(unsupported.onSendMention('@Ann', [])).resolves.toBe(false);
    expect(mockSendEffect).not.toHaveBeenCalled();
    expect(mockSendFormatted).not.toHaveBeenCalled();
    expect(mockSendMention).not.toHaveBeenCalled();

    mockSendEffect.mockResolvedValue({ status: 'rejected' });
    const supported = await sends();
    await expect(supported.onSendEffect('boom', 'effect-id')).resolves.toBe(false);
    expect(mockShowDialog).toHaveBeenLastCalledWith('Effect Not Sent', expect.any(String));
  });

  it('reports a schedule that fails, and refuses a file schedule the chat cannot do', async () => {
    mockSchedule.mockRejectedValue(new Error('offline'));
    const scheduled = await sends();
    scheduled.onSchedule('later', 1_900_000_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockShowDialog).toHaveBeenCalledWith('Scheduled', 'Couldn’t schedule that message.');

    const noFiles = await sends({
      capabilities: { ...ALL_AVAILABLE, imessageScheduledAttachmentsAvailable: false },
    });
    const item = { uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 1 };
    await expect(noFiles.onScheduleAttachment('later', item, 1_900_000_000_000)).resolves.toBe(
      false,
    );
    expect(mockScheduleAttachment).not.toHaveBeenCalled();
  });
});
