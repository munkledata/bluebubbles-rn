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
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const mockIsDevServer = jest.fn(() => false);

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
jest.mock('@ui/conversations/pickReminderTime', () => ({ pickReminderTime: jest.fn() }));
jest.mock('@/services/send', () => ({
  discardMessage: jest.fn(async () => {}),
  react: jest.fn(),
  unsend: jest.fn(),
}));

interface DialogButton {
  text: string;
  style?: string;
  onPress?: () => void;
}
const dialogs: Array<{ title: string; buttons: DialogButton[] }> = [];
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: jest.fn((title: string, _body?: string, buttons?: DialogButton[]) => {
    dialogs.push({ title, buttons: buttons ?? [] });
  }),
}));

// eslint-disable-next-line import/first
import { useMessageActions } from '@features/conversations/useMessageActions';
// eslint-disable-next-line import/first
import { discardMessage, react } from '@/services/send';
// eslint-disable-next-line import/first
import { devSendFakeReaction } from '@features/conversations/devSeed';
// eslint-disable-next-line import/first
import { scheduleMessageReminder } from '@/services/notifications/remindersService';
// eslint-disable-next-line import/first
import { pickReminderTime } from '@ui/conversations/pickReminderTime';

const mockScheduleMessageReminder = scheduleMessageReminder as jest.Mock;
const mockPickReminderTime = pickReminderTime as jest.Mock;

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

async function mount(messages: EnrichedMessage[]) {
  const setReplyTo = jest.fn();
  const hook = await renderHook(() =>
    useMessageActions({
      guid: 'iMessage;-;+15550001111',
      messages,
      chatTitle: 'Alice',
      setReplyTo,
      setEditing: jest.fn(),
    }),
  );
  return { ...hook, setReplyTo };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevServer.mockReturnValue(false);
  mockPickReminderTime.mockResolvedValue(2_000);
  mockScheduleMessageReminder.mockResolvedValue(1);
  dialogs.length = 0;
});

describe('useMessageActions — DEV reaction account scope', () => {
  it('keeps confirmed reaction and reply actions on their exact message identity', async () => {
    mockIsDevServer.mockReturnValue(true);
    const target = msg('message-a', null);
    const { result, setReplyTo } = await mount([target]);
    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });

    await act(async () => {
      result.current.onReact('love');
    });

    expect(devSendFakeReaction).toHaveBeenCalledWith(
      'iMessage;-;+15550001111',
      'message-a',
      'love',
      undefined,
      0,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );

    mockIsDevServer.mockReturnValue(false);
    await act(async () => {
      result.current.onReact('like');
      result.current.onReplyToSelected();
      result.current.onSwipeReply(target);
    });

    expect(react).toHaveBeenCalledWith(
      {
        chatGuid: 'iMessage;-;+15550001111',
        targetGuid: 'message-a',
        reaction: 'like',
        emoji: undefined,
        partIndex: 0,
        selectedMessageText: 'hi',
      },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
      expect.any(Function),
    );
    const expectedReply = {
      guid: 'message-a',
      text: 'hi',
      subject: undefined,
      balloonBundleId: undefined,
      isFromMe: 1,
      senderName: null,
      hasAttachments: 0,
      hasVisibleAttachments: 0,
      attachmentDescription: undefined,
      targetPartIndex: 0,
    };
    expect(setReplyTo).toHaveBeenNthCalledWith(1, expectedReply);
    expect(setReplyTo).toHaveBeenNthCalledWith(2, expectedReply);
  });

  it('keeps a lean interactive payload out of attachment actions and reply previews', async () => {
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
    const { result, setReplyTo } = await mount([target]);

    await act(async () => {
      result.current.onLongPressMessage(target, rect);
      result.current.onSwipeReply(target);
    });

    expect(result.current.selected).toMatchObject({
      balloonBundleId: 'com.apple.Handwriting.HandwritingProvider',
      hasVisibleAttachments: 0,
      attachments: [],
    });
    expect(setReplyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        balloonBundleId: 'com.apple.Handwriting.HandwritingProvider',
        hasVisibleAttachments: 0,
      }),
    );

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

  it('rejects temp identities from live and DEV reactions, long-press reply, and swipe reply', async () => {
    const target = msg('temp-message-a', 'sending');
    const { result, setReplyTo } = await mount([target]);
    await act(async () => {
      result.current.onLongPressMessage(target, rect);
    });

    await act(async () => {
      result.current.onReact('love');
      result.current.onReplyToSelected();
      result.current.onSwipeReply(target);
    });
    mockIsDevServer.mockReturnValue(true);
    await act(async () => {
      result.current.onReact('love');
    });

    expect(react).not.toHaveBeenCalled();
    expect(devSendFakeReaction).not.toHaveBeenCalled();
    expect(setReplyTo).not.toHaveBeenCalled();
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
