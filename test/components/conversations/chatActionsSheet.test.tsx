/**
 * ChatActionsSheet (src/ui/conversations/ChatActionsSheet.tsx): the long-press action sheet for an
 * inbox row (pin / mute / archive / mark read/unread / delete). Locks in:
 *   - the heading shows the target chat title;
 *   - each row's LABEL flips on the target's current state (Pin↔Unpin, Mute↔Unmute,
 *     Archive↔Unarchive, Mark as Read↔Mark as Unread);
 *   - pressing a row calls the RIGHT device-local mutation with the row guid + toggled value,
 *     then closes the sheet (run() → fn().finally(onClose));
 *   - Mark as Read routes to the service `markRead(guid)`; Mark as Unread to the local repo;
 *   - Delete does NOT mutate directly — it closes the sheet and opens a confirm dialog whose
 *     message names the chat;
 *   - a null target renders no rows.
 *
 * In-file mocks:
 *   - `@db/repositories`: the sheet imports the five chat mutations; the real barrel pulls
 *     op-sqlite/drizzle native at import. Stub each as a jest.fn resolving void.
 *   - `@/services`: only `markRead` is referenced; its barrel loads native modules at import.
 *   - `@ui/dialog/dialogStore`: spy `showDialog` so the Delete-confirm can be asserted without
 *     driving the real dialog store/Modal.
 *   `@db/database` (getDatabase) is already stubbed by the shared setup to a jest.fn() → undefined,
 *   so the mutations are called with `(undefined, guid, …)`.
 *
 * run() is async (fn().finally(onClose)); after each press we `await waitFor` on onClose so the
 * deferred close never bleeds into the next test's act environment.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { ChatActionsSheet, type ChatActionTarget } from '@ui/conversations/ChatActionsSheet';
import { setChatPin, setChatMute, setChatArchive, setChatUnreadLocal } from '@db/repositories';
import { markRead } from '@/services';
import { showDialog } from '@ui/dialog/dialogStore';

// Zero insets so useSafeAreaInsets() resolves without a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@db/repositories', () => ({
  setChatPin: jest.fn(() => Promise.resolve()),
  setChatMute: jest.fn(() => Promise.resolve()),
  setChatArchive: jest.fn(() => Promise.resolve()),
  setChatUnreadLocal: jest.fn(() => Promise.resolve()),
  deleteChatLocal: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/services', () => ({ markRead: jest.fn(() => Promise.resolve()) }));

jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

const mockSetChatPin = setChatPin as jest.Mock;
const mockSetChatMute = setChatMute as jest.Mock;
const mockSetChatArchive = setChatArchive as jest.Mock;
const mockSetChatUnreadLocal = setChatUnreadLocal as jest.Mock;
const mockMarkRead = markRead as jest.Mock;
const mockShowDialog = showDialog as jest.Mock;

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
  mockSetChatPin.mockClear();
  mockSetChatMute.mockClear();
  mockSetChatArchive.mockClear();
  mockSetChatUnreadLocal.mockClear();
  mockMarkRead.mockClear();
  mockShowDialog.mockClear();
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
    expect(mockSetChatPin).toHaveBeenCalledWith(undefined, t.guid, true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unpin" for a pinned chat and unpins it on press', async () => {
    const t = makeTarget({ isPinned: true });
    const onClose = await renderSheet(t);
    expect(screen.queryByText('Pin')).toBeNull();
    fireEvent.press(screen.getByText('Unpin'));
    expect(mockSetChatPin).toHaveBeenCalledWith(undefined, t.guid, false);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Mute', () => {
  it('shows "Mute" and sets muteType to "mute" on press', async () => {
    const t = makeTarget({ muted: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mute'));
    expect(mockSetChatMute).toHaveBeenCalledWith(undefined, t.guid, 'mute');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unmute" and clears the muteType (null) on press', async () => {
    const t = makeTarget({ muted: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Unmute'));
    expect(mockSetChatMute).toHaveBeenCalledWith(undefined, t.guid, null);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Archive', () => {
  it('shows "Archive" and archives on press', async () => {
    const t = makeTarget({ isArchived: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Archive'));
    expect(mockSetChatArchive).toHaveBeenCalledWith(undefined, t.guid, true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows "Unarchive" and unarchives on press', async () => {
    const t = makeTarget({ isArchived: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Unarchive'));
    expect(mockSetChatArchive).toHaveBeenCalledWith(undefined, t.guid, false);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Mark read / unread', () => {
  it('an UNREAD chat shows "Mark as Read" and routes to markRead(guid)', async () => {
    const t = makeTarget({ unread: true });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mark as Read'));
    expect(mockMarkRead).toHaveBeenCalledWith(t.guid);
    expect(mockSetChatUnreadLocal).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a READ chat shows "Mark as Unread" and routes to the local repo', async () => {
    const t = makeTarget({ unread: false });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Mark as Unread'));
    expect(mockSetChatUnreadLocal).toHaveBeenCalledWith(undefined, t.guid);
    expect(mockMarkRead).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('ChatActionsSheet — Delete', () => {
  it('closes the sheet and opens a confirm dialog naming the chat (no direct mutation)', async () => {
    const t = makeTarget({ title: 'Alice' });
    const onClose = await renderSheet(t);
    fireEvent.press(screen.getByText('Delete'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenCalledTimes(1);
    const [heading, message] = mockShowDialog.mock.calls[0]!;
    expect(heading).toBe('Delete Conversation');
    expect(message).toContain('Alice');
  });
});
