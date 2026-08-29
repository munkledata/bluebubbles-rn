/**
 * ChatActionsSheet (src/ui/conversations/ChatActionsSheet.tsx): the long-press action sheet for an
 * inbox row (pin / mute / archive / mark read/unread / delete). Locks in:
 *   - the heading shows the exact target chat title;
 *   - each row's LABEL flips on the target's current state (Pin↔Unpin, Mute↔Unmute,
 *     Archive↔Unarchive, Mark as Read↔Mark as Unread);
 *   - pressing a row calls the RIGHT service command with the row guid + toggled value and the
 *     account lease captured by this sheet, then closes the sheet (run() → fn().finally(onClose));
 *   - Mark as Read routes to the service `markRead(guid)`; Mark as Unread to `markUnread(guid)`
 *     (local flip + best-effort server sync — the service owns the RCS/Private-API gating);
 *   - Delete does NOT mutate directly — it closes the sheet and opens a confirm dialog whose
 *     message is always generic; the dialog's DESTRUCTIVE button is what actually calls the
 *     `deleteChat` SERVICE (with the target's guid), and Cancel deletes nothing. It must be the
 *     service, not the repository: the repo call alone leaves the chat's reminders' OS alarms
 *     armed, and those outlive the row;
 *   - a null target renders no rows.
 *
 * In-file mocks:
 *   - `@/services`: every action command is a jest.fn resolving void. Repository/transaction
 *     behavior belongs to the service tests; this suite proves the sheet calls that boundary.
 *   - `@ui/dialog/dialogStore`: spy `showDialog` so the Delete-confirm can be asserted without
 *     driving the real dialog store/Modal.
 * run() is async (fn().finally(onClose)); after each press we `await waitFor` on onClose so the
 * deferred close never bleeds into the next test's act environment.
 */
import React from 'react';
import { act, renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { ChatActionsSheet, type ChatActionTarget } from '@ui/conversations/ChatActionsSheet';
import {
  deleteChat,
  markRead,
  markUnread,
  movePinnedChat,
  setChatArchived,
  setChatMuted,
  setChatPinned,
} from '@/services';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { showDialog } from '@ui/dialog/dialogStore';

// Zero insets so useSafeAreaInsets() resolves without a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/services', () => ({
  markRead: jest.fn(() => Promise.resolve()),
  markUnread: jest.fn(() => Promise.resolve()),
  deleteChat: jest.fn(() => Promise.resolve()),
  movePinnedChat: jest.fn(() => Promise.resolve()),
  setChatArchived: jest.fn(() => Promise.resolve()),
  setChatMuted: jest.fn(() => Promise.resolve()),
  setChatPinned: jest.fn(() => Promise.resolve()),
}));

jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

const mockSetChatPinned = setChatPinned as jest.Mock;
const mockSetChatMuted = setChatMuted as jest.Mock;
const mockSetChatArchived = setChatArchived as jest.Mock;
const mockMovePinnedChat = movePinnedChat as jest.Mock;
const mockMarkUnread = markUnread as jest.Mock;
const mockMarkRead = markRead as jest.Mock;
const mockShowDialog = showDialog as jest.Mock;
const mockDeleteChat = deleteChat as jest.Mock;
const PRIVATE_TITLE = 'private-conversation-title-7c91@example.test';
const GENERIC_DELETE_MESSAGE =
  'Delete this conversation? This removes it from this device (not from the server).';

/** The `buttons` array handed to showDialog by the last call (dialogStore's 3rd arg). */
interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}
function lastDialogButtons(): DialogButton[] {
  return (mockShowDialog.mock.calls[0]?.[2] ?? []) as DialogButton[];
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

async function invokeConfiguredPress(press: () => void): Promise<void> {
  await act(async () => {
    press();
    await Promise.resolve();
  });
}

function makeTarget(overrides: Partial<ChatActionTarget> = {}): ChatActionTarget {
  return {
    guid: 'iMessage;-;+15551230000',
    title: 'Alice',
    isPinned: false,
    isArchived: false,
    muted: false,
    unread: false,
    ...overrides,
  };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockSetChatPinned.mockReset().mockResolvedValue(undefined);
  mockSetChatMuted.mockReset().mockResolvedValue(undefined);
  mockSetChatArchived.mockReset().mockResolvedValue(undefined);
  mockMovePinnedChat.mockReset().mockResolvedValue(undefined);
  mockMarkUnread.mockReset().mockResolvedValue(undefined);
  mockMarkRead.mockReset().mockResolvedValue(undefined);
  mockShowDialog.mockClear();
  mockDeleteChat.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

async function renderSheet(target: ChatActionTarget) {
  const onClose = jest.fn();
  await renderWithTheme(<ChatActionsSheet target={target} onClose={onClose} />);
  return onClose;
}

describe('ChatActionsSheet — heading + null target', () => {
  it('shows the target title as the heading', async () => {
    await renderSheet(makeTarget({ title: 'Weekend Crew' }));
    expect(screen.getByText('Weekend Crew')).toBeTruthy();
  });

  it('renders no action rows when target is null', async () => {
    await renderWithTheme(<ChatActionsSheet target={null} onClose={jest.fn()} />);
    expect(screen.queryByText('Pin')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });
});

describe('ChatActionsSheet — Pin', () => {
  it('shows "Pin" for an unpinned chat and pins it on press', async () => {
    const t = makeTarget({ isPinned: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Pin'));
    await waitFor(() => expect(mockSetChatPinned).toHaveBeenCalledTimes(1));
    expect(mockSetChatPinned).toHaveBeenCalledWith(
      t.guid,
      true,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unpin" for a pinned chat and unpins it on press', async () => {
    const t = makeTarget({ isPinned: true });
    const onClose = await renderSheet(t);
    expect(screen.queryByText('Pin')).toBeNull();
    fireEvent.press(screen.getByText('Unpin'));
    await waitFor(() => expect(mockSetChatPinned).toHaveBeenCalledTimes(1));
    expect(mockSetChatPinned).toHaveBeenCalledWith(
      t.guid,
      false,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps a retained Pin callback bound to the account that rendered it', async () => {
    const t = makeTarget({ isPinned: false });
    const onClose = await renderSheet(t);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    fireEvent.press(screen.getByText('Pin'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const retainedLease = mockSetChatPinned.mock.calls[0]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatPinned).toHaveBeenCalledWith(t.guid, true, retainedLease);
    expect(retainedLease.isCurrent()).toBe(false);
  });

  it('waits for the Pin service command to settle before closing', async () => {
    const gate = deferred();
    mockSetChatPinned.mockReturnValueOnce(gate.promise);
    const onClose = await renderSheet(makeTarget({ isPinned: false }));

    fireEvent.press(screen.getByText('Pin'));
    await waitFor(() => expect(mockSetChatPinned).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — pinned order', () => {
  it('shows only available directions and swaps with the exact neighbor', async () => {
    const target = makeTarget({
      isPinned: true,
      moveEarlierGuid: 'earlier-guid',
      moveLaterGuid: null,
    });
    const onClose = await renderSheet(target);

    expect(screen.getByText('Move Earlier')).toBeTruthy();
    expect(screen.queryByText('Move Later')).toBeNull();
    fireEvent.press(screen.getByText('Move Earlier'));

    await waitFor(() => expect(mockMovePinnedChat).toHaveBeenCalledTimes(1));
    expect(mockMovePinnedChat).toHaveBeenCalledWith(
      {
        chatGuid: target.guid,
        adjacentChatGuid: 'earlier-guid',
        direction: 'earlier',
        sender: 'any',
      },
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Mute', () => {
  it('shows "Mute" and enables mute through the service command', async () => {
    const t = makeTarget({ muted: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mute'));
    await waitFor(() => expect(mockSetChatMuted).toHaveBeenCalledTimes(1));
    expect(mockSetChatMuted).toHaveBeenCalledWith(
      t.guid,
      true,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unmute" and disables mute through the service command', async () => {
    const t = makeTarget({ muted: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Unmute'));
    await waitFor(() => expect(mockSetChatMuted).toHaveBeenCalledTimes(1));
    expect(mockSetChatMuted).toHaveBeenCalledWith(
      t.guid,
      false,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('waits for the Mute service command to settle before closing', async () => {
    const gate = deferred();
    mockSetChatMuted.mockReturnValueOnce(gate.promise);
    const onClose = await renderSheet(makeTarget({ muted: false }));

    fireEvent.press(screen.getByText('Mute'));
    await waitFor(() => expect(mockSetChatMuted).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Archive', () => {
  it('shows "Archive" and archives on press', async () => {
    const t = makeTarget({ isArchived: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Archive'));
    await waitFor(() => expect(mockSetChatArchived).toHaveBeenCalledTimes(1));
    expect(mockSetChatArchived).toHaveBeenCalledWith(
      t.guid,
      true,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unarchive" and unarchives on press', async () => {
    const t = makeTarget({ isArchived: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Unarchive'));
    await waitFor(() => expect(mockSetChatArchived).toHaveBeenCalledTimes(1));
    expect(mockSetChatArchived).toHaveBeenCalledWith(
      t.guid,
      false,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps retained Mute and Archive callbacks bound to their original account', async () => {
    const target = makeTarget({
      guid: 'iMessage;-;+15557654321',
      muted: false,
      isArchived: false,
    });
    const oldClose = jest.fn();
    const oldView = await renderWithTheme(<ChatActionsSheet target={target} onClose={oldClose} />);
    const oldMute = retainConfiguredPress(screen.getByRole('button', { name: 'Mute' }));
    const oldArchive = retainConfiguredPress(screen.getByRole('button', { name: 'Archive' }));

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await invokeConfiguredPress(oldMute);
    await waitFor(() => expect(oldClose).toHaveBeenCalledTimes(1));
    await invokeConfiguredPress(oldArchive);
    await waitFor(() => expect(oldClose).toHaveBeenCalledTimes(2));
    const oldMuteLease = mockSetChatMuted.mock.calls[0]?.[2] as { isCurrent(): boolean };
    const oldArchiveLease = mockSetChatArchived.mock.calls[0]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatMuted).toHaveBeenCalledWith(target.guid, true, oldMuteLease);
    expect(mockSetChatArchived).toHaveBeenCalledWith(target.guid, true, oldArchiveLease);
    expect(oldMuteLease).toBe(oldArchiveLease);
    expect(oldMuteLease.isCurrent()).toBe(false);

    await oldView.unmount();
    const freshClose = await renderSheet(target);
    const freshMute = retainConfiguredPress(screen.getByRole('button', { name: 'Mute' }));
    const freshArchive = retainConfiguredPress(screen.getByRole('button', { name: 'Archive' }));
    await invokeConfiguredPress(freshMute);
    await waitFor(() => expect(freshClose).toHaveBeenCalledTimes(1));
    await invokeConfiguredPress(freshArchive);
    await waitFor(() => expect(freshClose).toHaveBeenCalledTimes(2));

    const freshMuteLease = mockSetChatMuted.mock.calls[1]?.[2] as { isCurrent(): boolean };
    const freshArchiveLease = mockSetChatArchived.mock.calls[1]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatMuted).toHaveBeenNthCalledWith(2, target.guid, true, freshMuteLease);
    expect(mockSetChatArchived).toHaveBeenNthCalledWith(2, target.guid, true, freshArchiveLease);
    expect(freshMuteLease).toBe(freshArchiveLease);
    expect(freshMuteLease).not.toBe(oldMuteLease);
    expect(freshMuteLease.isCurrent()).toBe(true);
  });
});

describe('ChatActionsSheet — Mark read / unread', () => {
  it('an UNREAD chat shows "Mark as Read" and routes to markRead(guid)', async () => {
    const t = makeTarget({ unread: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mark as Read'));
    expect(mockMarkRead).toHaveBeenCalledWith(
      t.guid,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockMarkUnread).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a READ chat shows "Mark as Unread" and routes to the markUnread service', async () => {
    const t = makeTarget({ unread: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mark as Unread'));
    expect(mockMarkUnread).toHaveBeenCalledWith(
      t.guid,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockMarkRead).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Delete', () => {
  it('closes the sheet and opens a generic confirm dialog (no direct mutation)', async () => {
    const t = makeTarget({ title: PRIVATE_TITLE });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Delete'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenCalledTimes(1);
    const [heading, message] = mockShowDialog.mock.calls[0]!;
    expect(heading).toBe('Delete Conversation');
    expect(message).toBe(GENERIC_DELETE_MESSAGE);
    expect(JSON.stringify(mockShowDialog.mock.calls[0])).not.toContain(PRIVATE_TITLE);
    // Pressing Delete must NOT have deleted anything yet — the dialog owns that.
    expect(mockDeleteChat).not.toHaveBeenCalled();
  });

  it("the dialog's destructive button deletes THIS chat locally", async () => {
    const t = makeTarget({ guid: 'iMessage;-;+15559998888', title: 'Alice' });
    await renderSheet(t);
    fireEvent.press(screen.getByText('Delete'));

    const buttons = lastDialogButtons();
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    const destructive = buttons.find((b) => b.style === 'destructive');
    expect(destructive).toBeDefined();

    // The actual deletion lives behind this callback — invoking it is the only way to prove
    // the sheet wired the RIGHT guid through the confirm dialog.
    destructive!.onPress?.();
    expect(mockDeleteChat).toHaveBeenCalledTimes(1);
    expect(mockDeleteChat).toHaveBeenCalledWith(
      'iMessage;-;+15559998888',
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
  });

  it("keeps the dialog's delayed Delete callback bound to the sheet's original account", async () => {
    const t = makeTarget({ guid: 'same-guid', title: 'Alice' });
    await renderSheet(t);
    fireEvent.press(screen.getByText('Delete'));
    const destructive = lastDialogButtons().find((b) => b.style === 'destructive');

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    destructive?.onPress?.();

    const lease = mockDeleteChat.mock.calls[0]?.[1] as { isCurrent(): boolean };
    expect(mockDeleteChat).toHaveBeenCalledWith('same-guid', lease);
    expect(lease.isCurrent()).toBe(false);
  });

  it("the dialog's Cancel button deletes nothing", async () => {
    const t = makeTarget({ guid: 'iMessage;-;+15559998888' });
    await renderSheet(t);
    fireEvent.press(screen.getByText('Delete'));

    const cancel = lastDialogButtons().find((b) => b.style === 'cancel');
    expect(cancel?.text).toBe('Cancel');
    cancel?.onPress?.(); // no-op by design
    expect(mockDeleteChat).not.toHaveBeenCalled();
  });
});
