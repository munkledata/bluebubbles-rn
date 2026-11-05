/**
 * "Message <name>" on a group message (`useMessageActions`): the sender's existing one-to-one
 * iMessage chat opens through the screen's chat navigator; otherwise the new-message screen opens
 * with the sender filled in and the group's service pre-picked. Nothing is ever sent from here.
 */
import { useState } from 'react';
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

const mockPush = jest.fn();
const mockFindChats = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
// `@db/database` is already mocked by test/components/support/setup.ts, which loads first, so a
// second jest.mock here would be ignored: the shared getDatabase mock is given a value instead.
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  findChatsByParticipantAddresses: (...args: unknown[]) => mockFindChats(...args),
}));
jest.mock('@/services/media', () => ({
  saveAttachmentsToPhotos: jest.fn(),
  shareAttachment: jest.fn(),
}));
jest.mock('@/services/notifications/remindersService', () => ({
  scheduleMessageReminder: jest.fn(),
}));
jest.mock('@features/conversations/devSeed', () => ({
  devSendFakeReaction: jest.fn(),
  devUnsendFake: jest.fn(),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => false }));
jest.mock('@state/sessionStore', () => ({
  useRcsEnabled: () => false,
  useRcsMutationEnabled: () => false,
}));
jest.mock('@ui/conversations/pickReminderTime', () => ({ pickReminderTime: jest.fn() }));
jest.mock('@/services/send', () => ({
  checkUnsend: jest.fn(),
  discardMessage: jest.fn(async () => {}),
  react: jest.fn().mockResolvedValue(null),
  unsend: jest.fn(),
}));
jest.mock('@/services/remoteMessageDeleteUiService', () => ({
  deleteMessageFromMac: jest.fn(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

// eslint-disable-next-line import/first
import { useMessageActions } from '@features/conversations/useMessageActions';
// eslint-disable-next-line import/first
import { DIRECT_MESSAGE_UNAVAILABLE } from '@features/conversations/directMessagePlan';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';

const GROUP = 'iMessage;+;chat-group-1';
const SENDER = '+15551112222';
const rect = { x: 0, y: 0, width: 10, height: 10 };

function groupMessage(overrides: Record<string, unknown> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'server-guid-1',
    text: 'see you there',
    isFromMe: 0,
    sendState: null,
    error: 0,
    dateCreated: 1000,
    dateDelivered: null,
    dateRead: null,
    dateEdited: null,
    dateRetracted: null,
    senderName: 'Laura',
    senderAddress: SENDER,
    senderService: 'iMessage',
    messageSummaryInfo: null,
    threadOriginatorGuid: null,
    hasAttachments: 0,
    attachments: [],
    reactions: [],
    ...overrides,
  } as unknown as EnrichedMessage;
}

interface MountOptions {
  service?: 'iMessage' | 'RCS' | null;
  newChatAvailable?: boolean;
  lease?: RealtimeDeliveryLease;
}

async function mount(message: EnrichedMessage, options: MountOptions = {}) {
  const openChat = jest.fn();
  const hook = await renderHook(() => {
    const [liveMessages] = useState([message]);
    return useMessageActions({
      guid: GROUP,
      messages: liveMessages,
      accountLease: options.lease,
      openChat,
      directMessageService: options.service === undefined ? 'iMessage' : options.service,
      newChatAvailable: options.newChatAvailable ?? true,
    });
  });
  await act(async () => hook.result.current.onLongPressMessage(message, rect));
  return { ...hook, openChat };
}

async function messageSender(result: { current: { onMessageSenderSelected: () => void } }) {
  await act(async () => {
    result.current.onMessageSenderSelected();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getDatabase as jest.Mock).mockReturnValue('current-account-db');
  mockFindChats.mockResolvedValue([]);
});

describe('useMessageActions: Message <name> on a group message', () => {
  it('opens the sender’s existing one-to-one iMessage chat through the chat navigator', async () => {
    mockFindChats.mockResolvedValue([
      { guid: `iMessage;-;${SENDER}`, latestMessageDate: 5, name: null, isGroup: false },
    ]);
    const { result, openChat } = await mount(groupMessage());
    expect(result.current.selected?.senderAddress).toBe(SENDER);

    await messageSender(result);
    await waitFor(() =>
      expect(openChat).toHaveBeenCalledWith('/chat/iMessage%3B-%3B%2B15551112222'),
    );
    expect(mockFindChats).toHaveBeenCalledWith('current-account-db', [SENDER], 'iMessage');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('otherwise opens the new-message screen with the sender and the group’s service', async () => {
    const { result, openChat } = await mount(groupMessage());
    await messageSender(result);
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/new-chat',
        params: { to: SENDER, service: 'iMessage' },
      }),
    );
    expect(openChat).not.toHaveBeenCalled();
  });

  it('leaves an RCS one-to-one to the server: no local lookup, RCS pre-picked', async () => {
    const { result } = await mount(groupMessage({ senderService: 'RCS' }), { service: 'RCS' });
    await messageSender(result);
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/new-chat',
        params: { to: SENDER, service: 'RCS' },
      }),
    );
    expect(mockFindChats).not.toHaveBeenCalled();
  });

  it('still opens the new-message screen when the lookup fails, without logging the address', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFindChats.mockRejectedValue(new Error('planted lookup failure'));
    const { result } = await mount(groupMessage());
    await messageSender(result);
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/new-chat',
        params: { to: SENDER, service: 'iMessage' },
      }),
    );
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENDER);
    warn.mockRestore();
  });

  it('explains when there is no chat yet and the server cannot start one', async () => {
    const { result, openChat } = await mount(groupMessage(), { newChatAvailable: false });
    await messageSender(result);
    await waitFor(() =>
      expect(showDialog).toHaveBeenCalledWith('Message', DIRECT_MESSAGE_UNAVAILABLE),
    );
    expect(openChat).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does nothing for your own message or one with no sender address', async () => {
    for (const message of [
      groupMessage({ isFromMe: 1 }),
      groupMessage({ senderAddress: null }),
      groupMessage({ senderAddress: '   ' }),
    ]) {
      const { result, openChat, unmount } = await mount(message);
      await messageSender(result);
      expect(openChat).not.toHaveBeenCalled();
      await unmount();
    }
    expect(mockFindChats).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not navigate once the account that opened the chat has changed', async () => {
    let current = true;
    const lease: RealtimeDeliveryLease = { generation: 1, isCurrent: () => current };
    let finishLookup!: (matches: unknown[]) => void;
    mockFindChats.mockReturnValue(
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
    );
    const { result, openChat } = await mount(groupMessage(), { lease });
    await messageSender(result);
    await waitFor(() => expect(mockFindChats).toHaveBeenCalled());
    current = false;
    await act(async () => {
      finishLookup([
        { guid: `iMessage;-;${SENDER}`, latestMessageDate: 5, name: null, isGroup: false },
      ]);
    });
    expect(openChat).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
