/**
 * The UI mention entry point (`sendMention` in the send barrel) checks the chat's address shape before
 * it hands the send to the mention service. It must take an `any;+;` group exactly while bbd's FP-006
 * gate is open, matching the service's own target proof and the endpoint.
 */
jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => ({ account: 'A' })) }));
jest.mock('@/services/clients', () => ({
  http: { account: 'A', shared: true },
  accountHttp: () => ({ account: 'A' }),
}));
jest.mock('@/services/send/rcsAttemptCapability', () => ({
  ...jest.requireActual('@/services/send/rcsAttemptCapability'),
  captureSessionRcsCapabilityLease: jest.fn(),
}));
jest.mock('@/services/send/sendMentionService', () => ({ sendIMessageMention: jest.fn() }));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(async () => true),
  expoFileSize: jest.fn(async () => null),
}));
// The barrel also loads modules that import native Expo libraries, which these tests never use.
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-test'),
  sendTextMessage: jest.fn(),
}));
jest.mock('@/services/send/outgoingPasteOwnership', () => ({
  createOutgoingPasteOwnershipPreparer: jest.fn(() => jest.fn()),
}));
jest.mock('@/services/contacts/contactsService', () => ({ pickContact: jest.fn() }));
jest.mock('@/services/location/currentLocation', () => ({ acquireCurrentLocation: jest.fn() }));
jest.mock('@/services/location/expoLocationAdapter', () => ({
  getExpoLocationAdapter: jest.fn(() => ({ native: 'location' })),
}));
// eslint-disable-next-line import/first
import { sendMention } from '@/services/send';
// eslint-disable-next-line import/first
import { captureSessionRcsCapabilityLease } from '@/services/send/rcsAttemptCapability';
// eslint-disable-next-line import/first
import { sendIMessageMention } from '@/services/send/sendMentionService';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockCaptureCapability = captureSessionRcsCapabilityLease as jest.Mock;
const mockSendIMessageMention = sendIMessageMention as jest.Mock;

const MENTIONS = [{ start: 6, length: 3, address: 'ann@example.com' }];

function capabilityWith(serverInfo: Record<string, unknown>) {
  return {
    kind: 'session',
    origin: 'https://capability.test',
    revision: 1,
    serverInfo: { version: '2.0.15', ...serverInfo },
    isCurrent: () => true,
    publish: () => true,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resumeRealtimeDeliveries();
  mockSendIMessageMention.mockResolvedValue({ status: 'accepted', tempGuid: 'temp-mention' });
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('UI mention entry point', () => {
  it('hands an any;+; group to the mention service only while the restored gate is open', async () => {
    const args = { chatGuid: 'any;+;chat-1234', text: 'Hello Ann', mentions: MENTIONS };

    mockCaptureCapability.mockReturnValue(capabilityWith({ supports_imessage_mentions: true }));
    await expect(sendMention(args)).resolves.toBeNull();
    expect(mockSendIMessageMention).not.toHaveBeenCalled();

    mockCaptureCapability.mockReturnValue(
      capabilityWith({
        supports_imessage_mentions: true,
        supports_imessage_group_reactions: true,
      }),
    );
    await expect(sendMention(args)).resolves.toEqual({
      status: 'accepted',
      tempGuid: 'temp-mention',
    });
    expect(mockSendIMessageMention).toHaveBeenCalledTimes(1);
    expect(mockSendIMessageMention.mock.calls[0]?.[2]).toEqual(args);
  });

  it('keeps the reviewed iMessage;+; group and refuses non-group or unswitched sends', async () => {
    mockCaptureCapability.mockReturnValue(capabilityWith({ supports_imessage_mentions: true }));
    await expect(
      sendMention({ chatGuid: 'iMessage;+;chat-1234', text: 'Hello Ann', mentions: MENTIONS }),
    ).resolves.toEqual({ status: 'accepted', tempGuid: 'temp-mention' });

    mockCaptureCapability.mockReturnValue(
      capabilityWith({
        supports_imessage_mentions: true,
        supports_imessage_group_reactions: true,
      }),
    );
    await expect(
      sendMention({ chatGuid: 'any;-;+15551234567', text: 'Hello Ann', mentions: MENTIONS }),
    ).resolves.toBeNull();
    mockCaptureCapability.mockReturnValue(
      capabilityWith({ supports_imessage_group_reactions: true }),
    );
    await expect(
      sendMention({ chatGuid: 'any;+;chat-1234', text: 'Hello Ann', mentions: MENTIONS }),
    ).resolves.toBeNull();
    expect(mockSendIMessageMention).toHaveBeenCalledTimes(1);
  });
});
