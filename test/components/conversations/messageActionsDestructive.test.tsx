/**
 * The two DESTRUCTIVE affordances in `useMessageActions` — "Cancel Sending"/"Remove" from the
 * long-press menu, and the multi-select "Delete" — neither of which had a test.
 *
 * 1. THE SNAPSHOT. `selected` is frozen when the bubble is long-pressed and never re-derived from
 *    the live rows. While the user reads the menu and confirms the dialog (seconds), the send can
 *    complete — promoted to its real guid, or flipped to 'sent' keeping the temp guid on the
 *    guid-less ack paths. Routing the tap at the optimistic-only write meant it then matched
 *    NOTHING, its boolean was discarded, the dialog closed, and the destructive action the user
 *    asked for silently did nothing — with Delete deliberately hidden from this menu as the
 *    alternative. So it goes through `discardMessage`, which falls through to the tombstone.
 *
 * 2. THE BULK LOOP. `discardMessage` opens a write TRANSACTION and the queue slot is claimed
 *    SYNCHRONOUSLY, so N unawaited calls claim all N slots in loop order before any of them runs
 *    and each chain's later plain writes land inside the NEXT one's transaction. The loop must
 *    therefore be sequential: chain i finished before chain i+1 starts.
 *
 * 3. SERVER-TARGET ACTIONS. A temp message has no server GUID yet, so neither a tapback nor a
 *    reply may capture that local-only identity. This applies to both long-press handlers and the
 *    direct swipe-to-reply callback.
 *
 * The hook is driven directly (renderHook); `showDialog` is captured so the confirm button can be
 * pressed, and every native/service leaf is mocked.
 */
import { useState } from 'react';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const mockIsDevServer = jest.fn(() => false);
let mockRcsEnabled = false;
const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_CHAT_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.dGhyZWFkLTE`;
const RCS_MESSAGE_GUID = `rcs-g1.${RCS_PROVIDER_EPOCH}.bWVzc2FnZS1h`;

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
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
jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));
jest.mock('@state/sessionStore', () => ({
  useRcsEnabled: () => mockRcsEnabled,
  useRcsMutationEnabled: () => mockRcsEnabled,
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

interface DialogButton {
  text: string;
  style?: string;
  onPress?: () => void;
}
const dialogs: Array<{ title: string; body: string | undefined; buttons: DialogButton[] }> = [];
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: jest.fn((title: string, body?: string, buttons?: DialogButton[]) => {
    dialogs.push({ title, body, buttons: buttons ?? [] });
  }),
}));

// eslint-disable-next-line import/first
import { useMessageActions } from '@features/conversations/useMessageActions';
// eslint-disable-next-line import/first
import { checkUnsend, discardMessage, react, unsend } from '@/services/send';
// eslint-disable-next-line import/first
import { deleteMessageFromMac } from '@/services/remoteMessageDeleteUiService';
// eslint-disable-next-line import/first
import { devSendFakeReaction } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { scheduleMessageReminder } from '@/services/notifications/remindersService';
// eslint-disable-next-line import/first
import { pickReminderTime } from '@ui/conversations/pickReminderTime';

const mockScheduleMessageReminder = scheduleMessageReminder as jest.Mock;
const mockPickReminderTime = pickReminderTime as jest.Mock;
const mockUnsend = unsend as jest.Mock;
const mockCheckUnsend = checkUnsend as jest.Mock;
const mockDeleteMessageFromMac = deleteMessageFromMac as jest.Mock;

/** Press the destructive button of the last dialog that was shown. */
function pressDestructive(): void {
  const last = dialogs[dialogs.length - 1];
  const btn = last?.buttons.find((b) => b.style === 'destructive');
  if (!btn) throw new Error(`no destructive button in dialog: ${last?.title}`);
  btn.onPress?.();
}

const msg = (guid: string, sendState: string | null): EnrichedMessage =>
  ({
    id: 1,
    guid,
    text: 'hi',
    isFromMe: 1,
    sendState,
    error: 0,
    dateCreated: 1000,
    dateDelivered: null,
    dateRead: null,
    dateEdited: null,
    dateRetracted: null,
    senderName: null,
    senderService: null,
    messageSummaryInfo: null,
    threadOriginatorGuid: null,
    hasAttachments: 0,
    attachments: [],
    reactions: [],
  }) as unknown as EnrichedMessage;

const rect = { x: 0, y: 0, width: 10, height: 10 };

async function mount(
  messages: EnrichedMessage[],
  guid = 'iMessage;-;+15550001111',
  edit?: { enabled: boolean; setEditing: jest.Mock },
  unsendEnabled = false,
  remoteDeleteEnabled = false,
  refreshMessages?: jest.Mock,
) {
  const hook = await renderHook(() => {
    const [liveMessages, setLiveMessages] = useState(messages);
    return {
      ...useMessageActions({
        guid,
        messages: liveMessages,
        chatTitle: 'Alice',
        imessageEditsAvailable: edit?.enabled,
        imessageUnsendsAvailable: unsendEnabled,
        imessageRemoteDeleteAvailable: remoteDeleteEnabled,
        setEditing: edit?.setEditing,
        refreshMessages,
      }),
      setLiveMessages,
    };
  });
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevServer.mockReturnValue(false);
  mockRcsEnabled = false;
  mockPickReminderTime.mockResolvedValue(2_000);
  mockScheduleMessageReminder.mockResolvedValue(1);
  mockUnsend.mockResolvedValue({ status: 'accepted' });
  mockDeleteMessageFromMac.mockResolvedValue({ status: 'accepted' });
  dialogs.length = 0;
});

describe('useMessageActions — narrow iMessage actions and RCS reactions', () => {
  it('never exposes or sends an iMessage reaction, even when RCS exists elsewhere', async () => {
    mockRcsEnabled = true;
    mockIsDevServer.mockReturnValue(true);
    const target = msg('message-a', null);
    const { result } = await mount([target]);

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.canReact).toBe(false);
    await act(async () => result.current.onReact('love'));

    expect(react).not.toHaveBeenCalled();
    expect(devSendFakeReaction).not.toHaveBeenCalled();
    expect(result.current).not.toHaveProperty('onReplyToSelected');
    expect(result.current).not.toHaveProperty('onSwipeReply');
    expect(result.current).not.toHaveProperty('onEditSelected');
    expect(result.current).not.toHaveProperty('onUnsendSelected');
    expect(result.current).not.toHaveProperty('onRemoteDeleteSelected');
  });

  it('allows whole-message reactions only for a confirmed RCS message with live capability', async () => {
    mockRcsEnabled = true;
    const target = msg(RCS_MESSAGE_GUID, null);
    const { result } = await mount([target], RCS_CHAT_GUID);
    await act(async () => result.current.onLongPressMessage(target, rect));

    expect(result.current.selected?.canReact).toBe(true);
    await act(async () => result.current.onReact('love'));
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: RCS_CHAT_GUID,
        targetGuid: RCS_MESSAGE_GUID,
        reaction: 'love',
        partIndex: 0,
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      expect.any(Function),
    );
  });

  it('admits only a recent exact plain-text part-zero message into edit mode', async () => {
    const setEditing = jest.fn();
    const target = {
      ...msg('message-editable', 'sent'),
      dateCreated: Date.now(),
      senderService: 'iMessage',
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
    } as EnrichedMessage;
    const { result } = await mount([target], 'iMessage;-;+15550001111', {
      enabled: true,
      setEditing,
    });

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.editPartIndex).toBe(0);
    await act(async () => result.current.onEditSelected?.());
    expect(setEditing).toHaveBeenCalledWith({
      guid: 'message-editable',
      text: 'hi',
      partIndex: 0,
    });
  });

  // A request that can't leave the phone can't unsend anything, but the app could not tell that
  // apart from a lost answer afterwards and left the message hidden as "unsent" for good.
  it('refuses to unsend while the phone is offline, before hiding anything', async () => {
    useTransportHealthStore.setState({ network: 'offline' });
    try {
      const target = {
        ...msg('message-offline-unsend', 'sent'),
        dateCreated: Date.now(),
        isSent: 1,
        error: 0,
        senderService: 'iMessage',
        subject: null,
        attributedBody: null,
        payloadData: null,
        balloonBundleId: null,
        expressiveSendStyleId: null,
        threadOriginatorGuid: null,
        threadOriginatorPart: null,
        associatedMessageGuid: null,
        associatedMessageType: null,
        associatedMessageEmoji: null,
        messagePartTopology: JSON.stringify({
          complete: true,
          originalPartIndexes: [0],
          currentParts: [{ index: 0, kind: 'text' }],
          attachmentOwnership: [],
        }),
      } as EnrichedMessage;
      const { result } = await mount([target], 'iMessage;-;+15550001111', undefined, true);

      await act(async () => result.current.onLongPressMessage(target, rect));
      await act(async () => result.current.onUnsendSelected?.());

      expect(dialogs.at(-1)?.title).toBe('You’re Offline');
      expect(mockUnsend).not.toHaveBeenCalled();
    } finally {
      useTransportHealthStore.setState({ network: 'unknown' });
    }
  });

  it.each([
    ['restored', 'Message Not Unsent'],
    ['outcome-unknown', 'Still Not Confirmed'],
  ] as const)(
    'checks an unconfirmed unsend again and explains a %s result',
    async (status, title) => {
      mockCheckUnsend.mockResolvedValueOnce({ status });
      const refreshMessages = jest.fn();
      const target = {
        ...msg('message-unconfirmed', 'sent'),
        unsendUnconfirmed: 1,
      } as EnrichedMessage;
      const { result } = await mount(
        [target],
        'iMessage;-;+15550001111',
        undefined,
        true,
        false,
        refreshMessages,
      );

      await act(async () => result.current.onCheckUnsend?.(target));

      await waitFor(() =>
        expect(mockCheckUnsend).toHaveBeenCalledWith(
          { messageGuid: 'message-unconfirmed', chatGuid: 'iMessage;-;+15550001111' },
          expect.objectContaining({ isCurrent: expect.any(Function) }),
        ),
      );
      await waitFor(() => expect(dialogs.at(-1)?.title).toBe(title));
      expect(refreshMessages).toHaveBeenCalled();
    },
  );

  it('says nothing when the check confirms the unsend', async () => {
    mockCheckUnsend.mockResolvedValueOnce({ status: 'confirmed' });
    const refreshMessages = jest.fn();
    const target = {
      ...msg('message-unconfirmed', 'sent'),
      unsendUnconfirmed: 1,
    } as EnrichedMessage;
    const { result } = await mount(
      [target],
      'iMessage;-;+15550001111',
      undefined,
      true,
      false,
      refreshMessages,
    );

    await act(async () => result.current.onCheckUnsend?.(target));

    await waitFor(() => expect(refreshMessages).toHaveBeenCalled());
    expect(dialogs).toHaveLength(0);
  });

  it('requires confirmation before one narrow unsend and warns on unknown outcome', async () => {
    mockUnsend.mockResolvedValueOnce({ status: 'outcome-unknown' });
    const target = {
      ...msg('message-unsendable', 'sent'),
      dateCreated: Date.now(),
      isSent: 1,
      error: 0,
      senderService: 'iMessage',
      subject: null,
      attributedBody: null,
      payloadData: null,
      balloonBundleId: null,
      expressiveSendStyleId: null,
      threadOriginatorGuid: null,
      threadOriginatorPart: null,
      associatedMessageGuid: null,
      associatedMessageType: null,
      associatedMessageEmoji: null,
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
    } as EnrichedMessage;
    const refreshMessages = jest.fn();
    const { result } = await mount(
      [target],
      'iMessage;-;+15550001111',
      undefined,
      true,
      false,
      refreshMessages,
    );

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.unsendPartIndex).toBe(0);
    await act(async () => result.current.onUnsendSelected?.());
    expect(mockUnsend).not.toHaveBeenCalled();
    expect(dialogs.at(-1)?.title).toBe('Unsend message?');

    await act(async () => pressDestructive());
    await waitFor(() =>
      expect(mockUnsend).toHaveBeenCalledWith(
        {
          messageGuid: 'message-unsendable',
          chatGuid: 'iMessage;-;+15550001111',
          partIndex: 0,
        },
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
    expect(mockUnsend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialogs.at(-1)?.title).toBe('Unsend Not Confirmed'));
    expect(dialogs.at(-1)?.buttons).toHaveLength(0);
    // The "not confirmed" note lives outside the message row, so the window re-reads it now.
    expect(refreshMessages).toHaveBeenCalled();
  });

  it('warns about iCloud and never retries an unconfirmed whole-message Mac deletion', async () => {
    mockDeleteMessageFromMac.mockResolvedValueOnce({ status: 'outcome-unknown' });
    const target = {
      ...msg('message-remote-delete', 'sent'),
      senderService: 'iMessage',
      hasAttachments: 1,
      attachments: [
        {
          guid: 'attachment-1',
          mimeType: 'image/jpeg',
          localPath: null,
          hideAttachment: 0,
        },
      ],
    } as EnrichedMessage;
    const { result } = await mount([target], 'iMessage;-;+15550001111', undefined, false, true);

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.canRemoteDeleteFromMac).toBe(true);
    await act(async () => result.current.onRemoteDeleteSelected?.());
    expect(mockDeleteMessageFromMac).not.toHaveBeenCalled();
    expect(dialogs.at(-1)).toMatchObject({
      title: 'Delete from Mac?',
      body: expect.stringContaining('may also be deleted from your other Apple devices'),
    });
    expect(dialogs.at(-1)?.body).toContain('does not unsend it for anyone else');

    await act(async () => pressDestructive());
    await waitFor(() =>
      expect(mockDeleteMessageFromMac).toHaveBeenCalledWith(
        {
          messageGuid: 'message-remote-delete',
          chatGuid: 'iMessage;-;+15550001111',
        },
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
    expect(mockDeleteMessageFromMac).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialogs.at(-1)?.title).toBe('Deletion Not Confirmed'));
    expect(dialogs.at(-1)?.body).toContain('Check Messages on your Mac before trying again');
  });

  it.each([
    ['outside the two-minute window', { dateCreated: Date.now() - 120_001 }],
    ['errored', { error: 1 }],
    ['an edit marker', { dateEdited: Date.now() - 1_000 }],
    [
      'prior edit history',
      {
        messageSummaryInfo: JSON.stringify({
          editedParts: { '0': [{ date: Date.now() - 1_000, text: 'old text' }] },
        }),
      },
    ],
    ['a subject', { subject: 'Subject' }],
    ['an effect', { expressiveSendStyleId: 'com.apple.messages.effect.CKConfettiEffect' }],
    ['a reply', { threadOriginatorGuid: 'reply-target', threadOriginatorPart: 0 }],
    [
      'an audio attachment',
      {
        hasAttachments: 1,
        attachments: [
          {
            guid: 'audio-1',
            mimeType: 'audio/mp4',
            localPath: '/audio.m4a',
            hideAttachment: 0,
          },
        ],
      },
    ],
    [
      'a mention',
      {
        attributedBody: JSON.stringify([
          {
            string: 'Hi @Alice',
            runs: [
              {
                range: [3, 6],
                attributes: { __kIMMentionConfirmedMention: 'handle-guid' },
              },
            ],
          },
        ]),
      },
    ],
  ])('does not expose Unsend for %s', async (_label, overrides) => {
    const target = {
      ...msg('message-ineligible', 'sent'),
      dateCreated: Date.now(),
      isSent: 1,
      error: 0,
      senderService: 'iMessage',
      subject: null,
      attributedBody: null,
      payloadData: null,
      balloonBundleId: null,
      expressiveSendStyleId: null,
      threadOriginatorGuid: null,
      threadOriginatorPart: null,
      associatedMessageGuid: null,
      associatedMessageType: null,
      associatedMessageEmoji: null,
      messagePartTopology: JSON.stringify({
        complete: true,
        originalPartIndexes: [0],
        currentParts: [{ index: 0, kind: 'text' }],
        attachmentOwnership: [],
      }),
      ...overrides,
    } as EnrichedMessage;
    const { result } = await mount([target], 'iMessage;-;+15550001111', undefined, true);

    await act(async () => result.current.onLongPressMessage(target, rect));
    expect(result.current.selected?.unsendPartIndex).toBeUndefined();
  });

  it('blocks an RCS reaction when the live RCS capability is false', async () => {
    const target = msg(RCS_MESSAGE_GUID, null);
    const { result } = await mount([target], RCS_CHAT_GUID);
    await act(async () => result.current.onLongPressMessage(target, rect));

    expect(result.current.selected?.canReact).toBe(false);
    await act(async () => result.current.onReact('love'));
    expect(react).not.toHaveBeenCalled();
  });

  it('offers Share and Save for real photos sent through an iMessage app', async () => {
    const target = {
      ...msg('message-photos-app', null),
      text: null,
      balloonBundleId:
        'com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.mobileslideshow.PhotosMessagesApp',
      hasAttachments: 1,
      attachments: [
        {
          guid: 'photos-app-photo',
          mimeType: 'image/jpeg',
          transferName: 'IMG_0001.JPG',
          localPath: 'file:///cache/photos-app-photo.jpg',
          hideAttachment: 0,
        },
        {
          guid: 'photos-app-payload',
          mimeType: null,
          transferName: 'A1B2.pluginPayloadAttachment',
          localPath: null,
          hideAttachment: 0,
        },
      ],
    } as unknown as EnrichedMessage;
    const { result } = await mount([target]);

    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });

    expect(result.current.selected).toMatchObject({
      hasVisibleAttachments: 1,
      attachments: [
        {
          guid: 'photos-app-photo',
          localPath: 'file:///cache/photos-app-photo.jpg',
          mimeType: 'image/jpeg',
        },
      ],
    });
  });

  it('keeps a lean interactive payload out of local attachment actions', async () => {
    const target = {
      ...msg('message-balloon', null),
      text: null,
      balloonBundleId: 'com.apple.Handwriting.HandwritingProvider',
      hasAttachments: 1,
      attachments: [
        {
          guid: 'private-plugin-payload',
          mimeType: 'application/octet-stream',
          localPath: '/private/plugin-payload',
          hideAttachment: 0,
        },
      ],
    } as unknown as EnrichedMessage;
    const { result } = await mount([target]);

    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });

    expect(result.current.selected).toMatchObject({
      balloonBundleId: 'com.apple.Handwriting.HandwritingProvider',
      hasVisibleAttachments: 0,
      attachments: [],
    });
    await act(async () => {
      result.current.onRemindLater();
    });
    await waitFor(() =>
      expect(mockScheduleMessageReminder).toHaveBeenCalledWith(
        expect.objectContaining({
          messageGuid: 'message-balloon',
          messagePreview: 'Handwritten message',
        }),
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });

  it('rejects temp identities from live and DEV reactions', async () => {
    mockRcsEnabled = true;
    const target = msg('temp-message-a', 'sending');
    const { result } = await mount([target], 'RCS;-;thread-1');
    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });

    await act(async () => {
      result.current.onReact('love');
    });
    mockIsDevServer.mockReturnValue(true);
    await act(async () => {
      result.current.onReact('love');
    });

    expect(react).not.toHaveBeenCalled();
    expect(devSendFakeReaction).not.toHaveBeenCalled();
  });

  it('retires a frozen action snapshot when a live retraction arrives', async () => {
    const target = msg('message-retracted-live', null);
    const { result } = await mount([target]);
    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });
    expect(result.current.selected?.guid).toBe(target.guid);

    await act(async () => {
      result.current.setLiveMessages([
        { ...target, dateRetracted: 2_000, retractionState: 'unknown' },
      ] as EnrichedMessage[]);
    });
    expect(result.current.selected).toBeNull();

    await act(async () => {
      result.current.onReact('love');
    });
    expect(react).not.toHaveBeenCalled();
  });
});

describe('useMessageActions — "Cancel Sending" / "Remove"', () => {
  it('goes through discardMessage, so a send that COMPLETED during the dialog is still removed', async () => {
    const sending = msg('temp-live', 'sending');
    const { result } = await mount([sending]);

    await act(async () => {
      result.current.onLongPressMessage(sending, rect);
    });
    await act(async () => {
      result.current.onCancelSelected();
    });
    expect(dialogs[dialogs.length - 1]?.title).toBe('Cancel sending?');

    // …the send lands while the confirmation is on screen, then the user confirms.
    await act(async () => {
      pressDestructive();
    });

    // The optimistic-only write would have matched nothing here and reported false to nobody.
    await waitFor(() =>
      expect(discardMessage).toHaveBeenCalledWith(
        'temp-live',
        expect.any(Number),
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });

  it('uses the same write for the errored "Remove" wording', async () => {
    const errored = msg('temp-err', 'error');
    const { result } = await mount([errored]);

    await act(async () => {
      result.current.onLongPressMessage(errored, rect);
    });
    await act(async () => {
      result.current.onCancelSelected();
    });
    expect(dialogs[dialogs.length - 1]?.title).toBe('Remove message?');

    await act(async () => {
      pressDestructive();
    });
    await waitFor(() =>
      expect(discardMessage).toHaveBeenCalledWith(
        'temp-err',
        expect.any(Number),
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });
});

describe('useMessageActions — bulk Delete', () => {
  it('discards the selection SEQUENTIALLY (never N transactions in flight at once)', async () => {
    // Record overlap: each call resolves on a later microtask, so an unawaited loop would show
    // several in flight simultaneously.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    (discardMessage as jest.Mock).mockImplementation(async (g: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(g);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    });

    const rows = ['a', 'b', 'c'].map((g) => msg(g, null));
    const { result } = await mount(rows);
    await act(async () => {
      result.current.onLongPressMessage(rows[0]!, rect);
    });
    await act(async () => {
      result.current.onEnterSelect();
    });
    await act(async () => {
      result.current.onToggleSelect(rows[1]!);
      result.current.onToggleSelect(rows[2]!);
    });
    await act(async () => {
      result.current.onBulkDelete();
    });

    await act(async () => {
      pressDestructive();
    });

    await waitFor(() => expect(discardMessage).toHaveBeenCalledTimes(3));
    expect(maxInFlight).toBe(1); // 3 here = every tombstone but the last rides a sibling's atomicity
    expect(order).toEqual(['a', 'b', 'c']);
    // One timestamp for the whole selection: a bulk delete tombstones as a single act.
    const stamps = (discardMessage as jest.Mock).mock.calls.map((c) => c[1] as number);
    expect(new Set(stamps).size).toBe(1);
    // …and multi-select exits.
    expect(result.current.selectedGuids).toBeNull();
  });
});
