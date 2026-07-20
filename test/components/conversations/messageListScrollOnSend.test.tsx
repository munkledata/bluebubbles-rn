/**
 * Regression guard for the "scroll to my just-sent message" fix (MessageList.tsx).
 *
 * When the user sends, their new message is appended as the chronological tail and the
 * list must scroll to the bottom to reveal it (deferred one rAF so FlashList has measured
 * the new row first). Incoming (not-from-me) messages must NOT trigger this manual scroll —
 * FlashList's own autoscrollToBottomThreshold handles the near-bottom case natively.
 *
 * The shared FlashList mock in messageList.test.tsx ignores the ref (scroll is a no-op),
 * so this file uses its OWN mock that exposes scrollToEnd via useImperativeHandle.
 * Per AGENTS.md: this asserts the DECISION (do we call scrollToEnd?), not on-device layout
 * — the one-frame timing itself is verified on device.
 */
import React from 'react';

// `mock`-prefixed so jest's hoisted factory may reference it (temporal-dead-zone rule).
const mockScrollToEnd = jest.fn();

jest.mock('@shopify/flash-list', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: { data?: unknown[]; renderItem?: (a: { item: unknown; index: number }) => unknown; keyExtractor?: (i: unknown) => string; onLoad?: (info: { elapsedTimeInMs: number }) => void },
    ref: unknown,
  ) {
    ReactLib.useImperativeHandle(ref, () => ({
      scrollToEnd: mockScrollToEnd,
      scrollToIndex: jest.fn(),
      scrollToOffset: jest.fn(),
    }));
    const { data = [], renderItem, keyExtractor, onLoad } = props;
    // Real FlashList raises onLoad once it has drawn/measured its first render; the initial
    // "scroll to newest" now hangs off that, so fire it once on mount to mirror the device.
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

// Keep the row tree shallow — we only care about the scroll behaviour.
jest.mock('@ui/conversations/MessageBubble', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return { MessageBubble: (p: { msg?: { text?: string } }) => ReactLib.createElement(Text, null, p.msg?.text ?? '') };
});
jest.mock('@ui/conversations/FailedMessageSheet', () => ({ FailedMessageSheet: () => null }));
// Also list-owned + uses safe-area insets (no SafeAreaProvider here) — stub like FailedMessageSheet.
jest.mock('@ui/conversations/ReactionDetailsSheet', () => ({ ReactionDetailsSheet: () => null }));
jest.mock('@/services/send', () => ({ retry: jest.fn(), discardMessage: jest.fn() }));

// eslint-disable-next-line import/first
import { MessageList } from '@ui/conversations/MessageList';
// eslint-disable-next-line import/first
import { renderWithTheme, waitFor, act } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import type { EnrichedMessage } from '@features/conversations/useMessages';

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

const GUID = 'iMessage;-;+15551230000';
// messages prop is NEWEST-FIRST; two received messages to start.
const initial = (): EnrichedMessage[] => [
  make({ id: 2, guid: 'b', text: 'B', dateCreated: 2_000, isFromMe: 0 }),
  make({ id: 1, guid: 'a', text: 'A', dateCreated: 1_000, isFromMe: 0 }),
];

describe('MessageList — scroll to newest on send', () => {
  beforeEach(() => mockScrollToEnd.mockClear());

  it('scrolls to the end (animated) when the user’s OWN new message is appended', async () => {
    const msgs = initial();
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={msgs} />,
    );
    // The first populate lands at the newest message; let it fire, then reset.
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    mockScrollToEnd.mockClear();

    // User sends → a from-me message becomes the newest (prepended to newest-first).
    const sent = make({ id: 3, guid: 'c', text: 'C', dateCreated: 3_000, isFromMe: 1 });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[sent, ...msgs]} />);
    });
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true }));
  });

  it('does NOT manually scroll when an INCOMING message is appended', async () => {
    const msgs = initial();
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={msgs} />,
    );
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    mockScrollToEnd.mockClear();

    const incoming = make({ id: 3, guid: 'c', text: 'C', dateCreated: 3_000, isFromMe: 0 });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[incoming, ...msgs]} />);
      // let any pending rAF flush inside act (there should be none for incoming)
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
  });
});
