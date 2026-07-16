/**
 * ThreadSheet (src/ui/conversations/ThreadSheet.tsx): the "View Thread" bottom sheet listing the
 * reply chain (originator + replies). Locked in:
 *   - loads via listThreadMessages(originatorGuid) and titles with the REPLY count (rows - 1,
 *     singular/plural);
 *   - originator row is marked "· original", own rows say "You", text-less rows show the
 *     attachment fallback;
 *   - tapping a row closes the sheet and jumps to that message (no jump when dateCreated is null);
 *   - redacted mode masks both the sender name and the body (AGENTS.md privacy rule);
 *   - a null originatorGuid renders nothing and never queries the DB.
 *
 * In-file mocks: `react-native-safe-area-context` (zero insets, mirrors messageActionsOverlay
 * .test.tsx) and `@db/repositories` (listThreadMessages only; `@db/database` is stubbed by the
 * shared setup). Renders inside a RN Modal with async row loading → assert via findBy / waitFor.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { MessageRow } from '@db/repositories';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockListThreadMessages = jest.fn();
jest.mock('@db/repositories', () => ({
  listThreadMessages: (...args: unknown[]) => mockListThreadMessages(...args),
}));

// eslint-disable-next-line import/first
import { ThreadSheet } from '@ui/conversations/ThreadSheet';

function row(over: Partial<MessageRow> & { guid: string }): MessageRow {
  return {
    id: 1,
    chatId: 1,
    handleId: null,
    text: 'hello',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1_700_000_000_000,
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
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...over,
  };
}

const THREAD: MessageRow[] = [
  row({ guid: 'orig', isFromMe: 1, text: 'original message' }),
  row({ guid: 'r1', senderName: 'Alice', text: 'first reply', dateCreated: 1_700_000_100_000 }),
  row({ guid: 'r2', senderName: null, text: null, dateCreated: 1_700_000_200_000 }),
];

describe('ThreadSheet', () => {
  beforeEach(() => {
    mockListThreadMessages.mockReset().mockResolvedValue(THREAD);
    useRedactedModeStore.setState({ enabled: false });
  });

  it('loads the thread and renders the originator + replies with a reply count', async () => {
    await renderWithTheme(
      <ThreadSheet originatorGuid="orig" onClose={jest.fn()} onJump={jest.fn()} />,
    );
    expect(await screen.findByText('Thread · 2 replies')).toBeTruthy();
    expect(mockListThreadMessages).toHaveBeenCalledWith(undefined, 'orig');
    expect(screen.getByText('You · original')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('original message')).toBeTruthy();
    expect(screen.getByText('first reply')).toBeTruthy();
    // Unknown sender + text-less row fall back.
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('📎 Attachment')).toBeTruthy();
  });

  it('uses the singular label for exactly one reply', async () => {
    mockListThreadMessages.mockResolvedValue(THREAD.slice(0, 2));
    await renderWithTheme(
      <ThreadSheet originatorGuid="orig" onClose={jest.fn()} onJump={jest.fn()} />,
    );
    expect(await screen.findByText('Thread · 1 reply')).toBeTruthy();
  });

  it('closes and jumps to the tapped message', async () => {
    const onClose = jest.fn();
    const onJump = jest.fn();
    await renderWithTheme(<ThreadSheet originatorGuid="orig" onClose={onClose} onJump={onJump} />);
    fireEvent.press(await screen.findByLabelText("Jump to Alice's message"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).toHaveBeenCalledWith({ guid: 'r1', dateCreated: 1_700_000_100_000 });
  });

  it('closes without jumping when the row has no dateCreated', async () => {
    mockListThreadMessages.mockResolvedValue([
      row({ guid: 'orig', isFromMe: 1 }),
      row({ guid: 'r1', senderName: 'Alice', dateCreated: null }),
    ]);
    const onClose = jest.fn();
    const onJump = jest.fn();
    await renderWithTheme(<ThreadSheet originatorGuid="orig" onClose={onClose} onJump={onJump} />);
    fireEvent.press(await screen.findByLabelText("Jump to Alice's message"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onJump).not.toHaveBeenCalled();
  });

  it('masks sender names and bodies in redacted mode', async () => {
    useRedactedModeStore.setState({ enabled: true });
    await renderWithTheme(
      <ThreadSheet originatorGuid="orig" onClose={jest.fn()} onJump={jest.fn()} />,
    );
    expect(await screen.findByText('Thread · 2 replies')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.queryByText('first reply')).toBeNull();
    expect(screen.getAllByText('Contact').length).toBe(2); // Alice + Unknown rows
    expect(screen.getAllByText('Message').length).toBeGreaterThan(0);
  });

  it('renders nothing and skips the query when originatorGuid is null', async () => {
    await renderWithTheme(
      <ThreadSheet originatorGuid={null} onClose={jest.fn()} onJump={jest.fn()} />,
    );
    await waitFor(() => expect(screen.queryByText(/Thread ·/)).toBeNull());
    expect(mockListThreadMessages).not.toHaveBeenCalled();
  });
});
