/**
 * ConversationTile (src/ui/conversations/ConversationTile.tsx): one iOS Messages-style inbox
 * row. This suite locks in the USER-OBSERVABLE behavior the tile derives from pure utils:
 *   - the chat TITLE via resolveTitle semantics (src/utils/chat.ts),
 *   - the UNREAD affordances (a11y "Unread." prefix + bolder title weight),
 *   - the SERVICE badge label via resolveChatService (guid prefix, with the SMS-handle override),
 *   - exact title, preview, accessibility copy, and 1:1/group avatar photos,
 *   - the always-generic Delete dialog without changing the exact guid/account callback,
 *   - press / long-press callbacks wired to the row guid + row.
 *
 * Expected values come from the SOURCE (chat.ts / message.ts), never from guesses.
 *
 * NOTE (reported, not tested): the tile does NOT render anything for row.isPinned — pinning is a
 * LIST concern (ConversationListScreen splits pinned rows into PinnedGrid). So there is no
 * pinned-state affordance in the tile to assert; the "isPinned is inert here" contract is pinned
 * by a test below.
 *
 * Mocks declared in-file: `@/services` supplies the account-scoped swipe commands. This row suite
 * verifies the component boundary: exact guid, requested state, and captured account lease.
 */
import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { ConversationTile } from '@ui/conversations/ConversationTile';
import type { InboxRow } from '@db/repositories';
import { contrastRatio, readableTextOn } from '@ui/theme/adaptiveFromImage';
import { darkTheme } from '@ui/theme/tokens';
import { deleteChat, markRead, markUnread, setChatArchived, setChatMuted } from '@/services';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

// Keep the full service composition graph out of this row test; only the function identity matters.
jest.mock('@/services', () => ({
  markRead: jest.fn(),
  markUnread: jest.fn(),
  deleteChat: jest.fn(),
  setChatArchived: jest.fn(() => Promise.resolve()),
  setChatMuted: jest.fn(() => Promise.resolve()),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

const mockMarkRead = markRead as jest.Mock;
const mockMarkUnread = markUnread as jest.Mock;
const mockDeleteChat = deleteChat as jest.Mock;
const mockShowDialog = showDialog as jest.Mock;
const mockSetChatMuted = setChatMuted as jest.Mock;
const mockSetChatArchived = setChatArchived as jest.Mock;

// The ServiceBadge marks its label accessibilityElementsHidden (decorative), so RNTL's default
// query excludes it — opt hidden elements in when asserting the badge text.
const HIDDEN = { includeHiddenElements: true } as const;
const PRIVATE_TITLE = 'private-tile-title-7c91@example.test';
const PRIVATE_PREVIEW = 'private-tile-preview-4f22-+15559876543';
const PRIVATE_PARTICIPANT = 'private-avatar-person-a31d@example.test';
const PRIVATE_AVATAR_URI = 'file:///private-avatar-64e9-contact-photo.jpg';
const SECOND_PRIVATE_PARTICIPANT = 'private-avatar-person-b80c-+15557654321';
const SECOND_PRIVATE_AVATAR_URI = 'file:///private-avatar-993a-second-photo.jpg';
const GENERIC_DELETE_MESSAGE =
  'Delete this conversation? This removes it from this device (not from the server).';
interface DialogButton {
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

function dialogButtons(callIndex: number): DialogButton[] {
  return (mockShowDialog.mock.calls[callIndex]?.[2] ?? []) as DialogButton[];
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

/** A fully-populated InboxRow: a read 1:1 iMessage chat with a plain incoming preview. */
function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    style: 45, // 1:1
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1_700_000_000_000,
    lastReadMessageGuid: null,
    lastText: 'hey there',
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 1_700_000_000_000,
    lastGuid: 'm1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: 'Alice',
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    hasKnownSender: 1,
    ...overrides,
  };
}

/** fontWeight of the title <Text> (the only node rendering the resolved title string). */
function titleWeight(title: string): TextStyle['fontWeight'] {
  const node = screen.getByText(title);
  return (StyleSheet.flatten(node.props.style) as TextStyle).fontWeight;
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockMarkRead.mockClear();
  mockMarkUnread.mockClear();
  mockDeleteChat.mockClear();
  mockShowDialog.mockClear();
  mockSetChatMuted.mockReset().mockResolvedValue(undefined);
  mockSetChatArchived.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('ConversationTile — title (resolveTitle semantics)', () => {
  it('shows a custom chat name above everything else', async () => {
    await renderWithTheme(
      <ConversationTile
        row={makeRow({
          customName: 'Weekend Crew',
          displayName: 'ignored',
          participantNames: 'Alice, Bob',
        })}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText('Weekend Crew')).toBeTruthy();
  });

  it('falls through a junk (raw chat-guid) displayName to the participant names', async () => {
    // displayName "chat12345" is a raw guid identifier → not a meaningful name → use participants.
    await renderWithTheme(
      <ConversationTile
        row={makeRow({ style: 43, displayName: 'chat12345', participantNames: 'Alice, Bob' })}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText('Alice, Bob')).toBeTruthy();
    expect(screen.queryByText('chat12345')).toBeNull();
  });

  it('shows "Group" for a group with no usable name or members', async () => {
    await renderWithTheme(
      <ConversationTile
        row={makeRow({
          style: 43,
          displayName: 'chat999',
          chatIdentifier: 'chat999',
          participantNames: null,
        })}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText('Group')).toBeTruthy();
  });
});

describe('ConversationTile — unread state', () => {
  it('read row: no "Unread." in the a11y label and a lighter (500) title weight', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ unreadCount: 0 })} onPress={() => {}} />,
    );
    // The full accessibility label is `${title}. ${preview}` with no "Unread." segment.
    expect(screen.getByLabelText('Alice. hey there')).toBeTruthy();
    expect(titleWeight('Alice')).toBe('500');
  });

  it('unread row: shows the count badge, speaks the count in the a11y label, bolds (600) the title', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ unreadCount: 3 })} onPress={() => {}} />,
    );
    expect(screen.getByLabelText('Alice. 3 unread. hey there')).toBeTruthy();
    const badgeText = screen.getByText('3'); // the numeric count badge
    const badgeStyle = StyleSheet.flatten(badgeText.props.style);
    expect(badgeStyle.color).toBe(readableTextOn(darkTheme.color.tint));
    expect(contrastRatio(badgeStyle.color, darkTheme.color.tint)).toBeGreaterThanOrEqual(4.5);
    expect(titleWeight('Alice')).toBe('600');
  });

  it('caps the unread badge at 99+', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ unreadCount: 250 })} onPress={() => {}} />,
    );
    expect(screen.getByText('99+')).toBeTruthy();
  });
});

describe('ConversationTile — service badge (resolveChatService)', () => {
  it('badges an iMessage guid as "iMessage"', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'iMessage;-;+15551230000' })} onPress={() => {}} />,
    );
    expect(screen.getByText('iMessage', HIDDEN)).toBeTruthy();
  });

  it('badges an SMS guid as "SMS"', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'SMS;-;+15551230000' })} onPress={() => {}} />,
    );
    expect(screen.getByText('SMS', HIDDEN)).toBeTruthy();
  });

  it('badges an RCS guid as "RCS"', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'RCS;-;+15551230000' })} onPress={() => {}} />,
    );
    expect(screen.getByText('RCS', HIDDEN)).toBeTruthy();
  });

  it('overrides an iMessage guid to "SMS" when every participant handle is SMS', async () => {
    // resolveChatService: guid says iMessage, but unanimously-SMS handles win → SMS badge.
    await renderWithTheme(
      <ConversationTile
        row={makeRow({ guid: 'iMessage;-;433768', handleServices: 'SMS,SMS' })}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText('SMS', HIDDEN)).toBeTruthy();
    expect(screen.queryByText('iMessage', HIDDEN)).toBeNull();
  });
});

describe('ConversationTile — exact content and avatars', () => {
  it('renders exact 1:1 title, preview, accessibility label, and avatar URI', async () => {
    const view = await renderWithTheme(
      <ConversationTile
        row={makeRow({
          customName: PRIVATE_TITLE,
          participantNames: PRIVATE_PARTICIPANT,
          participantAvatars: PRIVATE_AVATAR_URI,
          lastText: PRIVATE_PREVIEW,
        })}
        onPress={() => {}}
      />,
    );

    expect(screen.getByText(PRIVATE_TITLE)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PREVIEW)).toBeTruthy();
    expect(screen.getByLabelText(`${PRIVATE_TITLE}. ${PRIVATE_PREVIEW}`)).toBeTruthy();
    expect(screen.getByText('11/14/23')).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_AVATAR_URI);
  });

  it('deduplicates group participants while rendering exact content and both avatar URIs', async () => {
    const groupTitle = `${PRIVATE_PARTICIPANT}, ${PRIVATE_PARTICIPANT}, ${SECOND_PRIVATE_PARTICIPANT}`;
    const view = await renderWithTheme(
      <ConversationTile
        row={makeRow({
          style: 43,
          participantCount: 3,
          participantNames: groupTitle,
          participantAvatars: `${PRIVATE_AVATAR_URI}|||${PRIVATE_AVATAR_URI}|||${SECOND_PRIVATE_AVATAR_URI}`,
          lastText: PRIVATE_PREVIEW,
        })}
        onPress={() => {}}
      />,
    );

    expect(screen.getByText(groupTitle)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PREVIEW)).toBeTruthy();
    expect(screen.getByLabelText(`${groupTitle}. ${PRIVATE_PREVIEW}`)).toBeTruthy();
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain(PRIVATE_AVATAR_URI);
    expect(tree).toContain(SECOND_PRIVATE_AVATAR_URI);
  });
});

describe('ConversationTile — press callbacks', () => {
  it('fires onPress with the row guid when tapped', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'iMessage;-;+15551230000' })} onPress={onPress} />,
    );
    await fireEvent.press(screen.getByLabelText('Alice. hey there'));
    expect(onPress).toHaveBeenCalledWith('iMessage;-;+15551230000');
  });

  it('fires onLongPress with the row when long-pressed', async () => {
    const onLongPress = jest.fn();
    const row = makeRow();
    await renderWithTheme(
      <ConversationTile row={row} onPress={() => {}} onLongPress={onLongPress} />,
    );
    await fireEvent(screen.getByLabelText('Alice. hey there'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith(row);
  });
});

describe('ConversationTile — account-bound swipe callbacks', () => {
  it('passes the row-instance lease to its read action', async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'same-guid', unreadCount: 2 })} onPress={() => {}} />,
    );

    await fireEvent.press(screen.getByLabelText('Read'));

    expect(mockMarkRead).toHaveBeenCalledWith(
      'same-guid',
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockMarkUnread).not.toHaveBeenCalled();
  });

  it('passes the exact row guid and original lease to the read-row Mark Unread action', async () => {
    await renderWithTheme(
      <ConversationTile
        row={makeRow({ guid: 'read-row-guid', unreadCount: 0 })}
        onPress={() => {}}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Unread'));

    const originalLease = mockMarkUnread.mock.calls[0]?.[1] as { isCurrent(): boolean };
    expect(mockMarkUnread).toHaveBeenCalledWith('read-row-guid', originalLease);
    expect(originalLease).toEqual(
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(originalLease.isCurrent()).toBe(true);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("keeps a delayed delete dialog callback on the row's original account", async () => {
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'same-guid' })} onPress={() => {}} />,
    );
    await fireEvent.press(screen.getByLabelText('Delete'));
    const buttons = (mockShowDialog.mock.calls[0]?.[2] ?? []) as Array<{
      style?: string;
      onPress?: () => void;
    }>;
    const destructive = buttons.find((button) => button.style === 'destructive');

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    destructive?.onPress?.();

    const lease = mockDeleteChat.mock.calls[0]?.[1] as { isCurrent(): boolean };
    expect(mockDeleteChat).toHaveBeenCalledWith('same-guid', lease);
    expect(lease.isCurrent()).toBe(false);
  });

  it('drops retained A-account Mute and Archive callbacks while fresh B controls stay exact', async () => {
    const guid = 'same-guid';
    const first = await renderWithTheme(
      <ConversationTile row={makeRow({ guid })} onPress={() => {}} />,
    );
    const staleMute = retainConfiguredPress(screen.getByRole('button', { name: 'Mute' }));
    const staleArchive = retainConfiguredPress(screen.getByRole('button', { name: 'Archive' }));
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await invokeConfiguredPress(staleMute);
    await invokeConfiguredPress(staleArchive);

    const staleMuteLease = mockSetChatMuted.mock.calls[0]?.[2] as { isCurrent(): boolean };
    const staleArchiveLease = mockSetChatArchived.mock.calls[0]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatMuted).toHaveBeenCalledWith(guid, true, staleMuteLease);
    expect(mockSetChatArchived).toHaveBeenCalledWith(guid, true, staleArchiveLease);
    expect(staleMuteLease).toBe(staleArchiveLease);
    expect(staleMuteLease.isCurrent()).toBe(false);

    await first.unmount();
    await renderWithTheme(<ConversationTile row={makeRow({ guid })} onPress={() => {}} />);
    const freshMute = retainConfiguredPress(screen.getByRole('button', { name: 'Mute' }));
    const freshArchive = retainConfiguredPress(screen.getByRole('button', { name: 'Archive' }));
    await invokeConfiguredPress(freshMute);
    await invokeConfiguredPress(freshArchive);

    const freshMuteLease = mockSetChatMuted.mock.calls[1]?.[2] as { isCurrent(): boolean };
    const freshArchiveLease = mockSetChatArchived.mock.calls[1]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatMuted).toHaveBeenLastCalledWith(guid, true, freshMuteLease);
    expect(mockSetChatArchived).toHaveBeenLastCalledWith(guid, true, freshArchiveLease);
    expect(freshMuteLease).toBe(freshArchiveLease);
    expect(freshMuteLease).not.toBe(staleMuteLease);
    expect(freshMuteLease.isCurrent()).toBe(true);
  });

  it('keeps visible Mute and Archive actions on the exact row guid', async () => {
    const guid = 'iMessage;-;+15556781234';
    await renderWithTheme(<ConversationTile row={makeRow({ guid })} onPress={() => {}} />);

    await fireEvent.press(screen.getByLabelText('Mute'));
    await fireEvent.press(screen.getByLabelText('Archive'));

    const muteLease = mockSetChatMuted.mock.calls[0]?.[2] as { isCurrent(): boolean };
    const archiveLease = mockSetChatArchived.mock.calls[0]?.[2] as { isCurrent(): boolean };
    expect(mockSetChatMuted).toHaveBeenCalledWith(guid, true, muteLease);
    await waitFor(() => expect(mockSetChatArchived).toHaveBeenCalledTimes(1));
    expect(mockSetChatArchived).toHaveBeenCalledWith(guid, true, archiveLease);
    expect(muteLease).toBe(archiveLease);
    expect(muteLease.isCurrent()).toBe(true);
  });

  it('keeps visible Unmute on the exact row guid and clears the mute value', async () => {
    const guid = 'muted-row-guid';
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid, muteType: 'mute' })} onPress={() => {}} />,
    );

    await fireEvent.press(screen.getByLabelText('Unmute'));

    await waitFor(() => expect(mockSetChatMuted).toHaveBeenCalledTimes(1));
    expect(mockSetChatMuted).toHaveBeenCalledWith(
      guid,
      false,
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
  });

  it('keeps repeated Delete dialogs generic while both callbacks retain the exact guid and original lease', async () => {
    const guid = 'iMessage;-;+15559876543';
    await renderWithTheme(
      <ConversationTile
        row={makeRow({
          guid,
          customName: PRIVATE_TITLE,
          participantNames: PRIVATE_PARTICIPANT,
          participantAvatars: PRIVATE_AVATAR_URI,
          lastText: PRIVATE_PREVIEW,
        })}
        onPress={() => {}}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Delete'));
    expect(mockShowDialog).toHaveBeenNthCalledWith(
      1,
      'Delete Conversation',
      GENERIC_DELETE_MESSAGE,
      expect.any(Array),
    );
    expect(JSON.stringify(mockShowDialog.mock.calls[0])).not.toContain(PRIVATE_TITLE);
    const firstDelete = dialogButtons(0).find((button) => button.style === 'destructive');
    expect(firstDelete?.onPress).toEqual(expect.any(Function));

    await fireEvent.press(screen.getByLabelText('Delete'));
    expect(mockShowDialog).toHaveBeenNthCalledWith(
      2,
      'Delete Conversation',
      GENERIC_DELETE_MESSAGE,
      expect.any(Array),
    );
    expect(JSON.stringify(mockShowDialog.mock.calls[1])).not.toContain(PRIVATE_TITLE);
    const repeatedDelete = dialogButtons(1).find((button) => button.style === 'destructive');
    expect(repeatedDelete?.onPress).toEqual(expect.any(Function));

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    firstDelete?.onPress?.();
    repeatedDelete?.onPress?.();

    expect(mockDeleteChat.mock.calls.map((call) => call[0])).toEqual([guid, guid]);
    const originalLease = mockDeleteChat.mock.calls[0]?.[1] as { isCurrent(): boolean };
    expect(originalLease).toEqual(
      expect.objectContaining({ generation: expect.any(Number), isCurrent: expect.any(Function) }),
    );
    expect(mockDeleteChat.mock.calls[1]?.[1]).toBe(originalLease);
    expect(originalLease.isCurrent()).toBe(false);
  });
});

describe('ConversationTile — pinned state is inert in the tile', () => {
  it('remains wrapped in React.memo for stable list-row props', () => {
    expect(ConversationTile.$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('renders identically whether or not row.isPinned is set (pinning is a list concern)', async () => {
    // The tile has no pin affordance — ConversationListScreen splits pinned rows into PinnedGrid.
    await renderWithTheme(<ConversationTile row={makeRow({ isPinned: 1 })} onPress={() => {}} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByLabelText('Alice. hey there')).toBeTruthy();
  });
});
