/**
 * Redacted (privacy) mode end-to-end (AGENTS.md privacy guarantees; src/utils/privacy.ts). When
 * `useRedactedModeStore.enabled` is on, the inbox row AND the chat bubble must mask content so a
 * shoulder-surfer / screenshot leaks nothing: contact names → "Contact", message text → "Message".
 *
 * conversationTile.test.tsx already covers the tile's masking basics. This suite's value-add:
 *   1. the MessageBubble side (received text bubble + retracted tombstone), and
 *   2. a "nowhere in the tree" sweep — the real name/text must not appear ANYWHERE in the rendered
 *      output (serialized tree, including accessibility labels), not merely be absent as a visible
 *      text node. queryByText proves the placeholder shows; the tree sweep proves nothing leaked.
 *
 * We drive the REAL store (setState), reset in beforeEach. Expected placeholders come from
 * privacy.ts (redactTitle/redactPreview/redactMessageText → "Contact" / "Message").
 */
import React from 'react';
import { renderWithTheme, screen } from './support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { InboxRow, MessagePreview, MessageRow } from '@db/repositories';

// ConversationTile imports markRead from the @/services barrel (pulls native modules at import);
// MessageBubble renders attachments through @ui/attachments (transitively ky, an untransformed ESM
// module). Neither is exercised here — stub both to keep the module graph off native/ESM code.
jest.mock('@/services', () => ({ markRead: jest.fn() }));
jest.mock('@ui/attachments', () => ({ AttachmentView: () => null }));

// eslint-disable-next-line import/first
import { ConversationTile } from '@ui/conversations/ConversationTile';
// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';

const SECRET_NAME = 'Alice Wonderland';
const SECRET_TEXT = 'meet me at the docks at noon';

/** Serialize the whole rendered tree (text + props like accessibilityLabel) for a leak sweep. */
function serializeTree(): string {
  return JSON.stringify(screen.toJSON());
}

function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    style: 45,
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1_700_000_000_000,
    lastReadMessageGuid: null,
    lastText: SECRET_TEXT,
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 1_700_000_000_000,
    lastGuid: 'm1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: SECRET_NAME,
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    ...overrides,
  };
}

type BubbleMsg = MessageRow & { replyPreview?: MessagePreview | null };

function makeMsg(over: Partial<BubbleMsg> = {}): BubbleMsg {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: SECRET_TEXT,
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1_000,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...over,
  };
}

beforeEach(() => {
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
});

describe('Redacted mode — ConversationTile', () => {
  it('masks the tile title + preview and leaks neither the name nor the text anywhere in the tree', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<ConversationTile row={makeRow()} onPress={() => {}} />);

    // Placeholders are shown…
    expect(screen.getByText('Contact')).toBeTruthy();
    expect(screen.getByText('Message')).toBeTruthy();
    // …and the real name/text appear NOWHERE (visible text nor accessibility labels).
    const tree = serializeTree();
    expect(tree).not.toContain(SECRET_NAME);
    expect(tree).not.toContain(SECRET_TEXT);
  });

  it('shows the real title + preview when redacted mode is off', async () => {
    await renderWithTheme(<ConversationTile row={makeRow()} onPress={() => {}} />);
    expect(screen.getByText(SECRET_NAME)).toBeTruthy();
    expect(screen.getByText(SECRET_TEXT)).toBeTruthy();
    expect(screen.queryByText('Contact')).toBeNull();
  });
});

describe('Redacted mode — MessageBubble', () => {
  it('masks a received text bubble to "Message" and leaks the real text nowhere in the tree', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: SECRET_TEXT })} showTail />);

    expect(screen.getByText('Message')).toBeTruthy();
    expect(screen.queryByText(SECRET_TEXT)).toBeNull();
    expect(serializeTree()).not.toContain(SECRET_TEXT);
  });

  it('masks a received retracted tombstone so the sender name never appears', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ senderName: SECRET_NAME, dateRetracted: 6_000, text: SECRET_TEXT })}
        showTail
      />,
    );
    // Redacted tombstone drops the real sender name → generic "They unsent a message".
    expect(screen.getByText('They unsent a message')).toBeTruthy();
    const tree = serializeTree();
    expect(tree).not.toContain(SECRET_NAME);
    expect(tree).not.toContain(SECRET_TEXT);
  });

  it('shows the real bubble text when redacted mode is off', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: SECRET_TEXT })} showTail />);
    expect(screen.getByText(SECRET_TEXT)).toBeTruthy();
    expect(screen.queryByText('Message')).toBeNull();
  });
});

describe('Redacted mode — ReplyQuote (via a reply bubble)', () => {
  const SECRET_QUOTE = 'the safe combination is 4815162342';
  const replyMsg = () =>
    makeMsg({
      text: SECRET_TEXT,
      threadOriginatorGuid: 'orig-1',
      replyPreview: {
        guid: 'orig-1',
        text: SECRET_QUOTE,
        senderName: SECRET_NAME,
        isFromMe: 0,
        hasAttachments: 0,
      },
    });

  it('masks the quoted sender + text and leaks neither anywhere in the tree', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<MessageBubble msg={replyMsg()} showTail />);

    // The quote shows generic placeholders…
    expect(screen.getByText('Contact')).toBeTruthy();
    expect(screen.getAllByText('Message').length).toBeGreaterThanOrEqual(1);
    // …and the quoted sender/text appear NOWHERE (incl. the quote's accessibility label).
    const tree = serializeTree();
    expect(tree).not.toContain(SECRET_NAME);
    expect(tree).not.toContain(SECRET_QUOTE);
    expect(tree).not.toContain(SECRET_TEXT);
  });

  it('keeps "You" for an own quoted message (reveals nothing) while masking its text', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    const msg = replyMsg();
    msg.replyPreview!.isFromMe = 1;
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(serializeTree()).not.toContain(SECRET_QUOTE);
  });

  it('shows the real quoted sender + text when redacted mode is off', async () => {
    await renderWithTheme(<MessageBubble msg={replyMsg()} showTail />);
    expect(screen.getByText(SECRET_NAME)).toBeTruthy();
    expect(screen.getByText(SECRET_QUOTE)).toBeTruthy();
    expect(screen.queryByText('Contact')).toBeNull();
  });
});
