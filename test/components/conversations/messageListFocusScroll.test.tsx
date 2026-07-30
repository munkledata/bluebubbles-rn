/**
 * Regression guard for MessageList's focus-scroll (the centering nudge that follows an anchored
 * open — a search hit, a reminder deep-link, a ThreadSheet jump).
 *
 * `initialScrollIndex` does the landing at mount; 450ms later a deferred `scrollToIndex` nudges the
 * target toward the middle of the viewport. That nudge used to CLOSE OVER `focusIndex`, which is
 * recomputed the moment the anchored window arrives (`useReactiveQuery` keeps serving the previous
 * deps' rows until the new query resolves, and a mid-session jump doesn't remount the screen). The
 * captured index was therefore normally stale — out of range it was silently dropped by FlashList,
 * but in range (a deep unread backlog, a jump near the top of the window) it scrolled to the WRONG
 * message half a second after landing. The index is now read from a ref at FIRE time.
 *
 * Like the sibling pinned/scroll-on-send suites this asserts the DECISION (which scroll is issued,
 * with which index) through a FlashList mock; real layout is device-only.
 */
import React from 'react';

// `mock`-prefixed so jest's hoisted factory may reference them (temporal-dead-zone rule).
const mockScrollToIndex = jest.fn();
const mockScrollToEnd = jest.fn();

jest.mock('@shopify/flash-list', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (a: { item: unknown; index: number }) => unknown;
      keyExtractor?: (i: unknown) => string;
      onLoad?: (info: { elapsedTimeInMs: number }) => void;
    },
    ref: unknown,
  ) {
    ReactLib.useImperativeHandle(ref, () => ({
      scrollToEnd: mockScrollToEnd,
      scrollToIndex: mockScrollToIndex,
      scrollToOffset: jest.fn(),
    }));
    const { data = [], renderItem, keyExtractor, onLoad } = props;
    ReactLib.useEffect(() => {
      onLoad?.({ elapsedTimeInMs: 0 });
    }, []);
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

// Keep the row tree shallow — only the scroll decision matters here.
jest.mock('@ui/conversations/MessageBubble', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return {
    MessageBubble: (p: { msg?: { text?: string } }) =>
      ReactLib.createElement(Text, null, p.msg?.text ?? ''),
  };
});
jest.mock('@ui/conversations/FailedMessageSheet', () => ({ FailedMessageSheet: () => null }));
jest.mock('@ui/conversations/ReactionDetailsSheet', () => ({ ReactionDetailsSheet: () => null }));
jest.mock('@/services/send', () => ({ retry: jest.fn(), discardMessage: jest.fn() }));

// eslint-disable-next-line import/first
import { MessageList } from '@ui/conversations/MessageList';
// eslint-disable-next-line import/first
import { act, renderWithTheme } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import type { EnrichedMessage } from '@features/conversations/useMessages';

const GUID = 'iMessage;-;+15551230000';

function make(guid: string, dateCreated: number): EnrichedMessage {
  return {
    id: dateCreated,
    guid,
    chatId: 1,
    handleId: null,
    text: guid.toUpperCase(),
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated,
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
    attachments: [],
    reactions: [],
    stickers: [],
    replyPreview: null,
  } as EnrichedMessage;
}

/** `messages` is NEWEST-FIRST and the list reverses it — build windows newest-first. */
const window = (...guids: string[]): EnrichedMessage[] =>
  guids.map((g, i) => make(g, 10_000 - i * 1_000));

// The recent window still on screen when a jump is requested: chronological [a, b, c, d, e].
const STALE = window('e', 'd', 'c', 'b', 'a');
// The anchored window the reactive query resolves to a beat later, centered on 'a':
// chronological [y, z, a, b, c] — the SAME target now sits at index 2, not 0.
const ANCHORED = window('c', 'b', 'a', 'z', 'y');

const NUDGE_MS = 450;

describe('MessageList — anchored focus scroll', () => {
  beforeEach(() => {
    mockScrollToIndex.mockClear();
    mockScrollToEnd.mockClear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('nudges the focus target toward center once the deferred timer fires', async () => {
    await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={ANCHORED} focusGuid="a" />,
    );
    expect(mockScrollToIndex).not.toHaveBeenCalled(); // deferred, not immediate
    await act(async () => {
      jest.advanceTimersByTime(NUDGE_MS);
    });
    expect(mockScrollToIndex).toHaveBeenCalledWith({
      index: 2,
      animated: false,
      viewPosition: 0.35,
    });
  });

  it('reads the index at FIRE time, so the anchored window landing mid-wait re-targets it', async () => {
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={STALE} focusGuid="a" />,
    );
    // The anchored window resolves while the nudge is still pending: 'a' moves 0 → 2.
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={ANCHORED} focusGuid="a" />);
    });
    await act(async () => {
      jest.advanceTimersByTime(NUDGE_MS);
    });
    expect(mockScrollToIndex).toHaveBeenCalledTimes(1);
    // index 0 would be the closed-over stale value — that's the yank to the wrong message.
    expect(mockScrollToIndex).toHaveBeenCalledWith({
      index: 2,
      animated: false,
      viewPosition: 0.35,
    });
  });

  it('issues no scroll when the target has left the loaded window by the time the timer fires', async () => {
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={STALE} focusGuid="a" />,
    );
    await act(async () => {
      rerender(
        <MessageList chatGuid={GUID} isGroup={false} messages={window('z', 'y')} focusGuid="a" />,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(NUDGE_MS);
    });
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('never nudges on an ordinary (non-anchored) open', async () => {
    await renderWithTheme(<MessageList chatGuid={GUID} isGroup={false} messages={STALE} />);
    await act(async () => {
      jest.advanceTimersByTime(NUDGE_MS);
    });
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });
});
