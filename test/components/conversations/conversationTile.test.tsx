/**
 * ConversationTile (src/ui/conversations/ConversationTile.tsx): one iOS Messages-style inbox
 * row. This suite locks in the USER-OBSERVABLE behavior the tile derives from pure utils:
 *   - the chat TITLE via resolveTitle semantics (src/utils/chat.ts),
 *   - the UNREAD affordances (a11y "Unread." prefix + bolder title weight),
 *   - the SERVICE badge label via resolveChatService (guid prefix, with the SMS-handle override),
 *   - REDACTED-mode masking driven by useRedactedModeStore (title→"Contact", preview→"Message",
 *     real name/text absent from the tree),
 *   - press / long-press callbacks wired to the row guid + row.
 *
 * Expected values come from the SOURCE (chat.ts / privacy.ts / message.ts), never from guesses.
 *
 * NOTE (reported, not tested): the tile does NOT render anything for row.isPinned — pinning is a
 * LIST concern (ConversationListScreen splits pinned rows into PinnedGrid). So there is no
 * pinned-state affordance in the tile to assert; the "isPinned is inert here" contract is pinned
 * by a test below.
 *
 * Mocks declared in-file: `@/services` — ConversationTile imports `markRead` from it, and that
 * barrel's module graph pulls native modules (libsodium / cert-pinning) at import time, which
 * have no native half under jest. Only `markRead` is referenced (in a swipe callback), so a
 * jest.fn stub is sufficient. `@db/database` is already stubbed by the shared setup.
 */
import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { ConversationTile } from '@ui/conversations/ConversationTile';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { InboxRow } from '@db/repositories';

// markRead's barrel loads native modules at import; only the fn identity matters here.
jest.mock('@/services', () => ({ markRead: jest.fn() }));

// The ServiceBadge marks its label accessibilityElementsHidden (decorative), so RNTL's default
// query excludes it — opt hidden elements in when asserting the badge text.
const HIDDEN = { includeHiddenElements: true } as const;

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

afterEach(() => {
  // The shared setup resets only the theme store; redacted mode is this suite's to clean up.
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
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
    expect(screen.getByText('3')).toBeTruthy(); // the numeric count badge
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

describe('ConversationTile — redacted (privacy) mode', () => {
  it('masks the title to "Contact" and the preview to "Message", hiding the real name/text', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(
      <ConversationTile
        row={makeRow({ participantNames: 'Alice', lastText: 'hey there' })}
        onPress={() => {}}
      />,
    );
    expect(screen.getByText('Contact')).toBeTruthy();
    expect(screen.getByText('Message')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.queryByText('hey there')).toBeNull();
    // The a11y label is redacted too (no identity leak to a screen reader).
    expect(screen.getByLabelText('Contact. Message')).toBeTruthy();
  });

  it('shows the real title/preview when redacted mode is off (default)', async () => {
    await renderWithTheme(<ConversationTile row={makeRow()} onPress={() => {}} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('hey there')).toBeTruthy();
    expect(screen.queryByText('Contact')).toBeNull();
  });
});

describe('ConversationTile — press callbacks', () => {
  it('fires onPress with the row guid when tapped', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <ConversationTile row={makeRow({ guid: 'iMessage;-;+15551230000' })} onPress={onPress} />,
    );
    fireEvent.press(screen.getByLabelText('Alice. hey there'));
    expect(onPress).toHaveBeenCalledWith('iMessage;-;+15551230000');
  });

  it('fires onLongPress with the row when long-pressed', async () => {
    const onLongPress = jest.fn();
    const row = makeRow();
    await renderWithTheme(
      <ConversationTile row={row} onPress={() => {}} onLongPress={onLongPress} />,
    );
    fireEvent(screen.getByLabelText('Alice. hey there'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith(row);
  });
});

describe('ConversationTile — pinned state is inert in the tile', () => {
  it('renders identically whether or not row.isPinned is set (pinning is a list concern)', async () => {
    // The tile has no pin affordance — ConversationListScreen splits pinned rows into PinnedGrid.
    await renderWithTheme(<ConversationTile row={makeRow({ isPinned: 1 })} onPress={() => {}} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByLabelText('Alice. hey there')).toBeTruthy();
  });
});
