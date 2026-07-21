/**
 * Regression guard for the pinned-to-bottom follow model (MessageList.tsx + @utils scrollPin).
 *
 * The list stays "pinned" to the newest message: every content-size change re-scrolls to the
 * end (the convergence loop that self-heals late row-height changes like URL-preview cards).
 * Only a USER DRAG can unpin; reaching the bottom re-pins; sending re-pins from anywhere. The
 * floating "jump to newest" button (with a missed-count badge) shows while unpinned, and in an
 * anchored (search-hit) session becomes the exit hatch (onExitAnchor).
 *
 * Like messageListScrollOnSend.test.tsx this asserts the DECISIONS (which scrolls are issued,
 * when the button shows) via a FlashList mock — it additionally publishes the latest props so
 * tests can drive onScroll / onScrollBeginDrag / onMomentumScrollEnd / onContentSizeChange with
 * synthetic events. On-device layout/timing is covered by the manual checklist.
 */
import React from 'react';

// `mock`-prefixed so jest's hoisted factory may reference them (temporal-dead-zone rule).
const mockScrollToEnd = jest.fn();
const mockListProps: { current: Record<string, unknown> } = { current: {} };

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
      scrollToIndex: jest.fn(),
      scrollToOffset: jest.fn(),
    }));
    mockListProps.current = props as Record<string, unknown>;
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

// Keep the row tree shallow — we only care about pin/scroll behaviour.
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
import { act, fireEvent, renderWithTheme, waitFor } from '../support/renderWithTheme';
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
const FAB_LABEL = 'Scroll to newest message';
// messages prop is NEWEST-FIRST; two received messages to start.
const initial = (): EnrichedMessage[] => [
  make({ id: 2, guid: 'b', text: 'B', dateCreated: 2_000, isFromMe: 0 }),
  make({ id: 1, guid: 'a', text: 'A', dateCreated: 1_000, isFromMe: 0 }),
];

/** A scroll event whose viewport bottom sits `dist` px above the content bottom. */
const scrollEvent = (dist: number) => ({
  nativeEvent: {
    contentSize: { height: 2_000, width: 400 },
    layoutMeasurement: { height: 800, width: 400 },
    contentOffset: { y: 2_000 - 800 - dist, x: 0 },
  },
});

type Handler = ((...args: unknown[]) => void) | undefined;
const drive = async (name: string, ...args: unknown[]): Promise<void> => {
  await act(async () => {
    (mockListProps.current[name] as Handler)?.(...args);
  });
};

/** Mount with the initial rows, let the onLoad landing fire, and start from a clean mock. */
async function mountAtBottom(
  msgs: EnrichedMessage[],
): Promise<Awaited<ReturnType<typeof renderWithTheme>>> {
  const result = await renderWithTheme(<MessageList chatGuid={GUID} isGroup={false} messages={msgs} />);
  await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
  mockScrollToEnd.mockClear();
  return result;
}

/** User drags up and settles `dist` px above the bottom (unpins when past the threshold). */
async function dragAwayFromBottom(dist = 600): Promise<void> {
  await drive('onScrollBeginDrag', scrollEvent(dist));
  await drive('onScroll', scrollEvent(dist));
  await drive('onMomentumScrollEnd', scrollEvent(dist));
}

describe('MessageList — pinned-to-bottom convergence', () => {
  beforeEach(() => {
    mockScrollToEnd.mockClear();
    mockListProps.current = {};
  });

  it('re-scrolls to the end on every content growth while pinned (the convergence loop)', async () => {
    await mountAtBottom(initial());
    await drive('onContentSizeChange', 400, 2_100);
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
    // A later growth (e.g. a URL-preview card popping in) re-lands again.
    mockScrollToEnd.mockClear();
    await drive('onContentSizeChange', 400, 2_220);
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('re-lands at the bottom when the viewport resizes while pinned (keyboard open/close, typing bubble)', async () => {
    const { getByTestId } = await mountAtBottom(initial());
    const wrapper = getByTestId('message-list-wrapper');
    const layout = (height: number) => ({
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height } },
    });
    await act(async () => {
      fireEvent(wrapper, 'layout', layout(800)); // first measure — primes the baseline, no scroll
    });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent(wrapper, 'layout', layout(500)); // keyboard shrank the list → re-land at bottom
    });
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });

    // A reader scrolled up (unpinned) is left alone by the same resize.
    mockScrollToEnd.mockClear();
    await dragAwayFromBottom();
    await act(async () => {
      fireEvent(wrapper, 'layout', layout(800)); // keyboard closed
    });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
  });

  it('scroll events WITHOUT a drag never unpin (programmatic scrolls cannot self-unpin)', async () => {
    const { queryByLabelText } = await mountAtBottom(initial());
    // A short-landing programmatic scroll reports a big distance — but no drag started it.
    await drive('onScroll', scrollEvent(600));
    await drive('onMomentumScrollEnd', scrollEvent(600));
    expect(queryByLabelText(FAB_LABEL)).toBeNull(); // still pinned → no button
    await drive('onContentSizeChange', 400, 2_100);
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false }); // loop still live
  });

  it('a user drag away unpins (button appears, growth no longer scrolls); returning to the bottom re-pins', async () => {
    const { queryByLabelText, findByLabelText } = await mountAtBottom(initial());
    await dragAwayFromBottom();
    expect(await findByLabelText(FAB_LABEL)).toBeTruthy(); // unpinned → button shows
    await drive('onContentSizeChange', 400, 2_100);
    expect(mockScrollToEnd).not.toHaveBeenCalled(); // reader is left alone

    // Scroll back down to the bottom (any source) → re-pins, button hides, loop resumes.
    await drive('onScroll', scrollEvent(10));
    await waitFor(() => expect(queryByLabelText(FAB_LABEL)).toBeNull());
    await drive('onContentSizeChange', 400, 2_200);
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('sending while scrolled up re-pins and reveals the sent message', async () => {
    const msgs = initial();
    const { rerender, queryByLabelText } = await mountAtBottom(msgs);
    await dragAwayFromBottom();
    expect(queryByLabelText(FAB_LABEL)).toBeTruthy();

    const sent = make({ id: 3, guid: 'c', text: 'C', dateCreated: 3_000, isFromMe: 1 });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[sent, ...msgs]} />);
    });
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true }));
    expect(queryByLabelText(FAB_LABEL)).toBeNull(); // re-pinned
  });

  it('counts incoming messages missed while unpinned on the badge and clears it on re-pin', async () => {
    const msgs = initial();
    const { rerender, findByText, queryByText } = await mountAtBottom(msgs);
    await dragAwayFromBottom();

    const in1 = make({ id: 3, guid: 'c', text: 'C', dateCreated: 3_000, isFromMe: 0 });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[in1, ...msgs]} />);
    });
    const in2 = make({ id: 4, guid: 'd', text: 'D', dateCreated: 4_000, isFromMe: 0 });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[in2, in1, ...msgs]} />);
    });
    expect(await findByText('2')).toBeTruthy();
    expect(mockScrollToEnd).not.toHaveBeenCalled(); // never yanked the reader

    await drive('onScroll', scrollEvent(0)); // back at the bottom
    await waitFor(() => expect(queryByText('2')).toBeNull());
  });

  it('tapping the button re-pins and scrolls to the newest message', async () => {
    const { findByLabelText, queryByLabelText } = await mountAtBottom(initial());
    await dragAwayFromBottom();
    const fab = await findByLabelText(FAB_LABEL);
    fireEvent.press(fab);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true }));
    await waitFor(() => expect(queryByLabelText(FAB_LABEL)).toBeNull()); // pinned again
  });

  it('in an anchored session the button is always shown and exits the anchor instead of scrolling', async () => {
    const onExitAnchor = jest.fn();
    const { findByLabelText } = await renderWithTheme(
      <MessageList
        chatGuid={GUID}
        isGroup={false}
        messages={initial()}
        onExitAnchor={onExitAnchor}
      />,
    );
    const fab = await findByLabelText(FAB_LABEL); // visible without any unpin
    mockScrollToEnd.mockClear();
    fireEvent.press(fab);
    await waitFor(() => expect(onExitAnchor).toHaveBeenCalledTimes(1));
    expect(mockScrollToEnd).not.toHaveBeenCalled(); // the window bottom is not the newest — no lie
  });
});
