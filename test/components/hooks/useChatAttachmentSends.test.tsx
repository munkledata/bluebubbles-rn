/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockGetInfoAsync = jest.fn();
const mockSendVoice = jest.fn();
const mockSendImage = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
}));
jest.mock('@/services/send', () => ({
  isSupportedImessageAttachmentFile: jest.fn(() => true),
  sendImage: (...args: unknown[]) => mockSendImage(...args),
  sendImages: jest.fn(),
  sendTextAttachment: jest.fn(),
  sendVoice: (...args: unknown[]) => mockSendVoice(...args),
}));
jest.mock('@ui', () => ({ showToast: jest.fn() }));
jest.mock('@ui/conversations/sendNotices', () => ({ presentSendIssue: jest.fn() }));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('@core/secure', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

import {
  pickDocumentFilesForLease,
  useChatAttachmentSends,
  type ChatAttachmentSendOptions,
} from '@features/conversations/useChatAttachmentSends';
import { sendImages, sendTextAttachment } from '@/services/send';
import { showToast } from '@ui';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { renderHook } from '../support/renderWithTheme';

const CHAT = 'iMessage;-;+15550001111';
const RECORDING = 'file:///cache/recordings/rec-1.m4a';
const VOICE: ChatAttachmentSendOptions['capabilities'] = {
  attachmentFeaturesAvailable: true,
  imessageAttachmentFeaturesAvailable: true,
  imessageNarrowAttachmentsAvailable: true,
  imessageRestoredAttachmentsAvailable: false,
  imessagePdfFeaturesAvailable: false,
  imessageCaptionFeaturesAvailable: false,
  voiceFeaturesAvailable: true,
  imessageVoiceAvailable: true,
};

/** A queue-backed send that reports the DB queue handoff, then succeeds. */
function queues(...args: unknown[]): Promise<unknown> {
  (args[3] as () => void)();
  return Promise.resolve(undefined);
}

async function voiceSender(capabilities = VOICE) {
  const { result } = await renderHook(() =>
    useChatAttachmentSends({
      guid: CHAT,
      accountLease: captureRealtimeDeliveryLease(),
      chatService: capabilities.imessageVoiceAvailable ? 'iMessage' : 'RCS',
      capabilities,
      ownedShareIdentity: null,
    }),
  );
  return result.current.onSendVoice;
}

beforeEach(() => {
  mockSendVoice.mockImplementation(queues);
  mockSendImage.mockImplementation(queues);
});

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
});

// The iMessage path then loads expo-file-system with a lazy import() to check the recording's size.
// Jest here cannot run a dynamic import (it needs --experimental-vm-modules), so that size check and
// the iMessage voice send itself are verified on a device, not in this file.
describe('useChatAttachmentSends voice notes', () => {
  it('refuses an iMessage voice note that is not a local m4a file', async () => {
    const onSendVoice = await voiceSender();

    await expect(onSendVoice('file:///cache/recordings/rec-1.aac')).resolves.toBe(false);
    await expect(onSendVoice('https://example.com/rec-1.m4a')).resolves.toBe(false);

    // Refused before any file check: nothing was loaded, checked or logged.
    expect(mockGetInfoAsync).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockSendVoice).not.toHaveBeenCalled();
  });

  it('sends an RCS voice note through the attachment path', async () => {
    const onSendVoice = await voiceSender({ ...VOICE, imessageVoiceAvailable: false });

    await expect(onSendVoice(RECORDING)).resolves.toBe(true);

    expect(mockSendImage.mock.calls[0]?.[0]).toEqual({
      chatGuid: CHAT,
      image: { uri: RECORDING, name: 'rec-1.m4a', mimeType: 'audio/mp4', size: 0 },
    });
    expect(mockGetInfoAsync).not.toHaveBeenCalled();
  });

  it('refuses a voice note when this chat cannot take voice', async () => {
    const onSendVoice = await voiceSender({
      ...VOICE,
      voiceFeaturesAvailable: false,
      imessageVoiceAvailable: false,
    });

    await expect(onSendVoice(RECORDING)).resolves.toBe(false);

    expect(mockSendVoice).not.toHaveBeenCalled();
    expect(mockSendImage).not.toHaveBeenCalled();
  });
});

type PickerLoader = Parameters<typeof pickDocumentFilesForLease>[1];
const ITEM = { uri: 'file:///cache/p.jpg', name: 'p.jpg', mimeType: 'image/jpeg', size: 10 };

async function sends(overrides: Partial<ChatAttachmentSendOptions> = {}) {
  const { result } = await renderHook(() =>
    useChatAttachmentSends({
      guid: CHAT,
      accountLease: captureRealtimeDeliveryLease(),
      chatService: 'iMessage',
      capabilities: VOICE,
      ownedShareIdentity: null,
      ...overrides,
    }),
  );
  return result.current;
}

describe('pickDocumentFilesForLease', () => {
  it('maps picked documents to pending attachments, returns nothing for a cancel, and explains a picker failure', async () => {
    const lease = captureRealtimeDeliveryLease();
    const picker = (assets: unknown, canceled = false): PickerLoader =>
      (async () => ({ getDocumentAsync: async () => ({ canceled, assets }) })) as PickerLoader;

    await expect(
      pickDocumentFilesForLease(
        lease,
        picker([
          { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 12 },
          { uri: 'file:///b.bin', name: 'b.bin', mimeType: null, size: null },
        ]),
        true,
        true,
      ),
    ).resolves.toEqual([
      { uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 12 },
      { uri: 'file:///b.bin', name: 'b.bin', mimeType: 'application/octet-stream', size: 0 },
    ]);
    await expect(pickDocumentFilesForLease(lease, picker(null, true))).resolves.toEqual([]);
    await expect(pickDocumentFilesForLease(lease, picker([]))).resolves.toEqual([]);
    expect(showDialog).not.toHaveBeenCalled();

    await expect(
      pickDocumentFilesForLease(lease, async () => {
        throw new Error('no picker');
      }),
    ).resolves.toEqual([]);
    expect(showDialog).toHaveBeenCalledWith('Attach', 'Couldn’t open the file picker.');
  });
});

describe('useChatAttachmentSends files and captions', () => {
  it('returns nothing to stage when attachments are unavailable and never opens the picker', async () => {
    const off = await sends({ capabilities: { ...VOICE, attachmentFeaturesAvailable: false } });
    await expect(off.pickFiles()).resolves.toEqual([]);
    await expect(off.onSendAttachments([ITEM])).resolves.toEqual([]);
    expect(off.onSendTextAttachment('hi', ITEM)).toBe(false);
    expect(sendImages).not.toHaveBeenCalled();
    expect(sendTextAttachment).not.toHaveBeenCalled();
  });

  it('refuses a captioned attachment outside iMessage and RCS, and queues it for RCS', async () => {
    const sms = await sends({ chatService: 'SMS' });
    expect(sms.onSendTextAttachment('hi', ITEM)).toBe(false);

    jest.mocked(sendTextAttachment).mockImplementation(queues as never);
    const rcs = await sends({ chatService: 'RCS' });
    await expect(rcs.onSendTextAttachment('hi', ITEM)).resolves.toBe(true);
    expect(jest.mocked(sendTextAttachment).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ chatGuid: CHAT, image: ITEM, text: 'hi', service: 'RCS' }),
    );
  });

  it('keeps the composer’s files when the queue handoff throws, and says so once', async () => {
    jest.mocked(sendImages).mockImplementation(() => {
      throw new Error('queue closed');
    });
    const rcs = await sends({
      chatService: 'RCS',
      capabilities: { ...VOICE, imessageAttachmentFeaturesAvailable: false },
    });
    await expect(rcs.onSendAttachments([ITEM])).resolves.toEqual([]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Couldn’t queue those attachments'),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[chat] attachment queue admission failed',
      expect.any(Error),
    );
  });
});
