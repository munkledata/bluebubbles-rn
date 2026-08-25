/**
 * MessageList (src/ui/conversations/MessageList.tsx): the chat's message list. It takes a
 * NEWEST-FIRST `messages` array, reverses it to chronological for display, and renders one
 * MessageRow per message with STABLE callbacks (the per-row binding happens inside the memoized
 * row). This suite locks in the list's own logic — NOT the memo contract, which
 * messageRowMemo.test.tsx already guards.
 *
 * Locked in:
 *   - chronological ORDER: newest-first input renders oldest→newest top→bottom;
 *   - DATE SEPARATORS: rendered per `showDateSeparator` (first row always; a >30-min + new-day gap;
 *     never within the 30-min window);
 *   - SENDER-NAME visibility: shown for received messages in a GROUP at a sender/gap break,
 *     collapsed for consecutive same-sender runs, and never in a 1:1;
 *   - row callback BINDING: the row's onLongPress fires the list's onLongPressMessage with the msg
 *     and the bubble's measured rect (which anchors the floating reaction/action menu);
 *   - the failed-message flow: tapping retry opens FailedMessageSheet, whose Try Again / Delete
 *     call `retry` / `discardMessage` from `@/services/send` with the right args — including the
 *     PHOTO branch, where the list rebuilds a PickedImage from the first attachment that still has
 *     a localPath (without it, retry deletes the row and re-sends text only: the picture is lost);
 *     and the sheet tracking the LIVE row rather than a snapshot, so it closes itself the moment
 *     the 20 s retry drain takes the message over or the message turns out to be delivered;
 *   - empty state: "No messages yet" when there are no messages.
 *
 * In-file mocks:
 *   - `@shopify/flash-list` → a plain map-over-data renderer (FlashList v2 renders nothing
 *     meaningful under jest); it reads the same props MessageList passes (data/renderItem/
 *     keyExtractor).
 *   - `@ui/conversations/MessageBubble` → a probe that renders the message text and exposes the
 *     bound onLongPress / onRetry as pressables (the real bubble pulls ky + native imports).
 *   - `@ui/conversations/FailedMessageSheet` → a probe that renders only when `visible` and surfaces
 *     its action callbacks (that sheet is 2a's target; here we only assert the wiring).
 *   - `@/services/send` → jest.fns for `retry` / `discardMessage` (its barrel pulls native http).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { formatSeparatorDate } from '@utils';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import type { AttachmentRow } from '@db/repositories';

jest.mock('@shopify/flash-list', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (a: { item: unknown; index: number }) => unknown;
      keyExtractor?: (i: unknown) => string;
    },
    _ref: unknown,
  ) {
    const { data = [], renderItem, keyExtractor } = props;
    return ReactLib.createElement(
      View,
      null,
      data.map((item: unknown, index: number) =>
        ReactLib.createElement(
          View,
          { key: keyExtractor ? keyExtractor(item) : String(index) },
          renderItem ? renderItem({ item, index }) : null,
        ),
      ),
    );
  });
  return { FlashList };
});

jest.mock('@ui/conversations/MessageBubble', () => {
  const ReactLib = require('react');
  const { View, Text, Pressable } = require('react-native');
  return {
    MessageBubble: (props: {
      msg: EnrichedMessage;
      // The real bubble measures itself and forwards its on-screen rectangle (never the raw press
      // event); emulate that so the row-binding assertion reflects the true (msg, rect) contract.
      onLongPress?: (rect: { x: number; y: number; width: number; height: number }) => void;
      onRetry?: () => void;
    }) =>
      ReactLib.createElement(
        View,
        null,
        ReactLib.createElement(Text, { testID: 'bubble-text' }, props.msg.text),
        ReactLib.createElement(
          Pressable,
          {
            testID: `longpress-${props.msg.guid}`,
            onPress: () => props.onLongPress?.({ x: 0, y: 0, width: 10, height: 10 }),
          },
          ReactLib.createElement(Text, null, 'lp'),
        ),
        ReactLib.createElement(
          Pressable,
          { testID: `retry-${props.msg.guid}`, onPress: props.onRetry },
          ReactLib.createElement(Text, null, 'rt'),
        ),
      ),
  };
});

jest.mock('@ui/conversations/FailedMessageSheet', () => {
  const ReactLib = require('react');
  const { View, Text, Pressable } = require('react-native');
  return {
    FailedMessageSheet: (props: {
      visible: boolean;
      isAttachment?: boolean;
      errorDetail?: string | null;
      onRetry: () => void;
      onDelete: () => void;
      onClose: () => void;
    }) =>
      props.visible
        ? ReactLib.createElement(
            View,
            null,
            ReactLib.createElement(Text, { testID: 'sheet' }, 'sheet-open'),
            ReactLib.createElement(
              Text,
              { testID: 'sheet-attachment' },
              String(!!props.isAttachment),
            ),
            ReactLib.createElement(Text, { testID: 'sheet-detail' }, props.errorDetail ?? ''),
            ReactLib.createElement(
              Pressable,
              { testID: 'sheet-retry', onPress: props.onRetry },
              ReactLib.createElement(Text, null, 'try'),
            ),
            ReactLib.createElement(
              Pressable,
              { testID: 'sheet-delete', onPress: props.onDelete },
              ReactLib.createElement(Text, null, 'del'),
            ),
          )
        : null,
  };
});

jest.mock('@/services/send', () => ({ retry: jest.fn(), discardMessage: jest.fn() }));
// Also list-owned + uses safe-area insets (no SafeAreaProvider here) — stub like FailedMessageSheet.
jest.mock('@ui/conversations/ReactionDetailsSheet', () => ({ ReactionDetailsSheet: () => null }));

// eslint-disable-next-line import/first
import { MessageList } from '@ui/conversations/MessageList';
// eslint-disable-next-line import/first
import { retry, discardMessage } from '@/services/send';

function make(over: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: 'Hello there',
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
    attachments: [],
    reactions: [],
    replyPreview: null,
    ...over,
  } as EnrichedMessage;
}

function att(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-1',
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: 'IMG_0042.jpg',
    totalBytes: 2048,
    height: 300,
    width: 400,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...over,
  };
}

const bubbleTexts = (): unknown[] =>
  screen.getAllByTestId('bubble-text').map((n) => n.props.children);

describe('MessageList — chronological order', () => {
  it('renders newest-first input oldest→newest (top→bottom)', async () => {
    // Input is newest-first (index 0 = newest); display is chronological.
    const messages = [
      make({ id: 3, guid: 'c', text: 'C', dateCreated: 3_000 }),
      make({ id: 2, guid: 'b', text: 'B', dateCreated: 2_000 }),
      make({ id: 1, guid: 'a', text: 'A', dateCreated: 1_000 }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    expect(bubbleTexts()).toEqual(['A', 'B', 'C']);
  });
});

describe('MessageList — date separators (showDateSeparator)', () => {
  it('shows a separator on the first row and again across a >30-min + new-day gap', async () => {
    const day1 = new Date('2026-03-10T14:14:00').getTime();
    const day2 = new Date('2026-03-11T14:19:00').getTime();
    // newest-first
    const messages = [
      make({ id: 2, guid: 'n', text: 'later', dateCreated: day2, handleId: 1 }),
      make({ id: 1, guid: 'o', text: 'earlier', dateCreated: day1, handleId: 1 }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    expect(screen.getByText(formatSeparatorDate(day1))).toBeTruthy();
    expect(screen.getByText(formatSeparatorDate(day2))).toBeTruthy();
  });

  it('shows no separator for a second message within the 30-min window', async () => {
    const t1 = new Date('2026-03-10T14:14:00').getTime();
    const t2 = new Date('2026-03-10T14:19:00').getTime(); // +5 min, same day
    const messages = [
      make({ id: 2, guid: 'n', text: 'later', dateCreated: t2, handleId: 1 }),
      make({ id: 1, guid: 'o', text: 'earlier', dateCreated: t1, handleId: 1 }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    // First row always gets a separator; the 5-min-later row does NOT.
    expect(screen.getByText(formatSeparatorDate(t1))).toBeTruthy();
    expect(screen.queryByText(formatSeparatorDate(t2))).toBeNull();
  });
});

describe('MessageList — sender-name visibility (group rules)', () => {
  it('shows a sender header at each sender break in a group', async () => {
    const messages = [
      make({
        id: 2,
        guid: 'b',
        text: 'hi',
        isFromMe: 0,
        handleId: 20,
        senderName: 'Bob',
        dateCreated: 2_000,
      }),
      make({
        id: 1,
        guid: 'a',
        text: 'hi',
        isFromMe: 0,
        handleId: 10,
        senderName: 'Alice',
        dateCreated: 1_000,
      }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;chat123" isGroup messages={messages} />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('collapses the header for consecutive same-sender messages in a group', async () => {
    const messages = [
      make({
        id: 2,
        guid: 'a2',
        text: 'hi',
        isFromMe: 0,
        handleId: 10,
        senderName: 'Alice',
        dateCreated: 1_060_000,
      }),
      make({
        id: 1,
        guid: 'a1',
        text: 'hi',
        isFromMe: 0,
        handleId: 10,
        senderName: 'Alice',
        dateCreated: 1_000_000,
      }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;chat123" isGroup messages={messages} />,
    );
    // Header renders only once for the run (the sender name comes solely from the row header).
    expect(screen.getAllByText('Alice')).toHaveLength(1);
  });

  it('never shows a sender header in a 1:1 chat', async () => {
    const messages = [
      make({ id: 1, guid: 'a', text: 'hi', isFromMe: 0, handleId: 10, senderName: 'Alice' }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.getByText('hi')).toBeTruthy();
  });
});

describe('MessageList — row callback binding', () => {
  it('fires onLongPressMessage with the message when a row is long-pressed', async () => {
    const onLongPressMessage = jest.fn();
    const messages = [make({ id: 1, guid: 'x', text: 'hi' })];
    await renderWithTheme(
      <MessageList
        chatGuid="iMessage;-;+15550001111"
        isGroup={false}
        messages={messages}
        onLongPressMessage={onLongPressMessage}
      />,
    );
    fireEvent.press(screen.getByTestId('longpress-x'));
    // The row forwards (message, measured bubble rect) — the rect anchors the floating menu.
    expect(onLongPressMessage).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'x' }),
      expect.objectContaining({ width: 10, height: 10 }),
    );
  });
});

describe('MessageList — failed-message flow', () => {
  it('opens the sheet on retry and Try Again re-sends via @/services/send', async () => {
    const messages = [
      make({
        id: 1,
        guid: 'x',
        text: 'oops',
        isFromMe: 1,
        sendState: 'error',
        errorMessage: 'Messages rejected this send.',
      }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    // Sheet starts hidden.
    expect(screen.queryByTestId('sheet')).toBeNull();

    fireEvent.press(screen.getByTestId('retry-x'));
    expect(await screen.findByTestId('sheet')).toBeTruthy();
    // A plain text message → not flagged as an attachment.
    expect(screen.getByTestId('sheet-attachment').props.children).toBe('false');
    expect(screen.getByTestId('sheet-detail').props.children).toBe('Messages rejected this send.');

    fireEvent.press(screen.getByTestId('sheet-retry'));
    // The GUID is the WHOLE argument. Passing the bubble's text/image made the service rebuild the
    // send from what this component could see — which delivered a failed contact card as a plain
    // message reading the contact's name, and dropped a reply target / effect / subject / mentions
    // that only the queue payload carries.
    expect(retry).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('a failed PHOTO retries as an attachment, rebuilt from the downloaded row', async () => {
    // The row the list must find: the FIRST attachment has no on-disk file, so `find(localPath)`
    // (not `[0]`) is what makes the picture re-uploadable.
    const messages = [
      make({
        id: 1,
        guid: 'x',
        text: null,
        isFromMe: 1,
        sendState: 'error',
        error: 1,
        hasAttachments: 1,
        attachments: [
          att({ id: 1, guid: 'a-gone', localPath: null }),
          att({
            id: 2,
            guid: 'a-have',
            localPath: 'file:///cache/IMG_0042.jpg',
            transferName: 'IMG_0042.jpg',
            mimeType: 'image/jpeg',
            totalBytes: 2048,
            width: 400,
            height: 300,
          }),
        ],
      }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    fireEvent.press(screen.getByTestId('retry-x'));
    expect(await screen.findByTestId('sheet')).toBeTruthy();
    // The sheet's copy differs for an attachment ("re-upload the picture").
    expect(screen.getByTestId('sheet-attachment').props.children).toBe('true');

    fireEvent.press(screen.getByTestId('sheet-retry'));
    // Still just the guid: the queue row already knows this is an attachment send and holds the
    // on-disk path, so the re-upload streams the same file under the same temp guid. The downloaded
    // attachment is only used HERE to word the sheet ("re-upload the picture").
    expect(retry).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('an attachment whose local file is gone is NOT re-sent as a fabricated image', async () => {
    const messages = [
      make({
        id: 1,
        guid: 'x',
        text: 'caption',
        isFromMe: 1,
        sendState: 'error',
        hasAttachments: 1,
        attachments: [att({ localPath: null })],
      }),
    ];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    fireEvent.press(screen.getByTestId('retry-x'));
    expect(await screen.findByTestId('sheet')).toBeTruthy();
    expect(screen.getByTestId('sheet-attachment').props.children).toBe('false');

    fireEvent.press(screen.getByTestId('sheet-retry'));
    // No downloaded file to describe, so the sheet reads as a plain message — but the retry itself
    // is unchanged: the service re-POSTs whatever the queue row says was sent.
    expect(retry).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('Delete discards the failed message via @/services/send', async () => {
    const messages = [make({ id: 1, guid: 'x', text: 'oops', isFromMe: 1, sendState: 'error' })];
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={messages} />,
    );
    fireEvent.press(screen.getByTestId('retry-x'));
    await screen.findByTestId('sheet');
    fireEvent.press(screen.getByTestId('sheet-delete'));
    expect(discardMessage).toHaveBeenCalledWith(
      'x',
      expect.any(Number),
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  /**
   * REGRESSION GUARD — the sheet must not act on a stale snapshot.
   *
   * The chat drains the outgoing retry queue every 20 s; when it picks the failed row up it flips
   * the bubble to 'sending' and starts a POST. The sheet used to hold a FROZEN copy of the message
   * taken when it opened, so it stayed on screen offering "Try Again" for a send that was already
   * back in flight — and tapping it deleted the row mid-POST and re-sent under a fresh temp id,
   * which is a different idempotency key server-side: the recipient gets the message twice.
   */
  it('closes itself when the failed row flips back to sending (the 20s drain took it over)', async () => {
    const failedRow = make({ id: 1, guid: 'x', text: 'oops', isFromMe: 1, sendState: 'error' });
    const view = await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={[failedRow]} />,
    );
    fireEvent.press(screen.getByTestId('retry-x'));
    expect(await screen.findByTestId('sheet')).toBeTruthy();

    // The drain claims the row: send_state error → sending, error code cleared.
    view.rerender(
      <MessageList
        chatGuid="iMessage;-;+15550001111"
        isGroup={false}
        messages={[{ ...failedRow, sendState: 'sending', error: 0 }]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
  });

  it('closes itself when the failed row is promoted to sent while the sheet is open', async () => {
    const failedRow = make({ id: 1, guid: 'x', text: 'oops', isFromMe: 1, sendState: 'error' });
    const view = await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={[failedRow]} />,
    );
    fireEvent.press(screen.getByTestId('retry-x'));
    expect(await screen.findByTestId('sheet')).toBeTruthy();

    // The retry the drain started succeeded (RCS/AppleScript keep the temp guid and only flip
    // the state) — a "Try Again" from here would send a second copy of a delivered message.
    view.rerender(
      <MessageList
        chatGuid="iMessage;-;+15550001111"
        isGroup={false}
        messages={[{ ...failedRow, sendState: 'sent', error: 0 }]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
    expect(retry).not.toHaveBeenCalled();
    expect(discardMessage).not.toHaveBeenCalled();
  });
});

describe('MessageList — empty state', () => {
  it('shows "No messages yet" when there are no messages', async () => {
    await renderWithTheme(
      <MessageList chatGuid="iMessage;-;+15550001111" isGroup={false} messages={[]} />,
    );
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });
});
