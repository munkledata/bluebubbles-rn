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
import { AccessibilityInfo, StyleSheet } from 'react-native';

// `mock`-prefixed so jest's hoisted factory may reference them (temporal-dead-zone rule).
const mockScrollToEnd = jest.fn();
const mockScrollToIndex = jest.fn();
const mockListProps: { current: Record<string, unknown> } = { current: {} };
const mockJumpToReplyByMessage = new Map<string, () => void>();

jest.mock('@shopify/flash-list', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (a: { item: unknown; index: number }) => React.ReactNode;
      keyExtractor?: (i: unknown) => string;
      onLoad?: (info: { elapsedTimeInMs: number }) => void;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    ReactLib.useImperativeHandle(ref, () => ({
      scrollToEnd: mockScrollToEnd,
      scrollToIndex: mockScrollToIndex,
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
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    MessageBubble: (p: { msg?: { guid?: string; text?: string }; onJumpToReply?: () => void }) => {
      if (p.msg?.guid && p.onJumpToReply) {
        mockJumpToReplyByMessage.set(p.msg.guid, p.onJumpToReply);
      }
      return ReactLib.createElement(Text, null, p.msg?.text ?? '');
    },
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
// eslint-disable-next-line import/first
import { contrastRatio, readableTextOn } from '@ui/theme/adaptiveFromImage';
// eslint-disable-next-line import/first
import { darkTheme } from '@ui/theme/tokens';
// eslint-disable-next-line import/first
import { useReduceMotionPreferenceRef } from '@ui/hooks/useReduceMotionPreference';

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
const initialWithReply = (): EnrichedMessage[] => [
  make({
    id: 3,
    guid: 'reply',
    text: 'Reply',
    dateCreated: 3_000,
    isFromMe: 0,
    threadOriginatorGuid: 'a',
  }),
  ...initial(),
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

async function settleInitialMotionPreference(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
}

async function emitReduceMotion(enabled: boolean): Promise<void> {
  expect(reduceMotionListener).toBeDefined();
  await act(async () => reduceMotionListener?.(enabled));
}

function autoFollowAnimation(): unknown {
  const config = mockListProps.current.maintainVisibleContentPosition as
    { animateAutoScrollToBottom?: boolean } | undefined;
  return config?.animateAutoScrollToBottom;
}

function SharedMotionRefProbe(): null {
  useReduceMotionPreferenceRef();
  return null;
}

/** Mount with the initial rows, let the onLoad landing fire, and start from a clean mock. */
async function mountAtBottom(
  msgs: EnrichedMessage[],
  settlePreference = true,
): Promise<Awaited<ReturnType<typeof renderWithTheme>>> {
  const result = await renderWithTheme(
    <MessageList chatGuid={GUID} isGroup={false} messages={msgs} />,
  );
  await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
  if (settlePreference) await settleInitialMotionPreference();
  mockScrollToEnd.mockClear();
  return result;
}

/** User drags up and settles `dist` px above the bottom (unpins when past the threshold). */
async function dragAwayFromBottom(dist = 600): Promise<void> {
  await drive('onScrollBeginDrag', scrollEvent(dist));
  await drive('onScroll', scrollEvent(dist));
  await drive('onMomentumScrollEnd', scrollEvent(dist));
}

async function exerciseExplicitScrolls(
  view: Awaited<ReturnType<typeof renderWithTheme>>,
  msgs: EnrichedMessage[],
  animated: boolean,
): Promise<void> {
  await waitFor(() => expect(mockJumpToReplyByMessage.get('reply')).toBeDefined());
  const jumpToReply = mockJumpToReplyByMessage.get('reply');
  await act(async () => jumpToReply?.());
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({
    index: 0,
    animated,
    viewPosition: 0.4,
  });

  mockScrollToEnd.mockClear();
  const fab = await view.findByLabelText(FAB_LABEL);
  fireEvent.press(fab);
  await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated }));

  mockScrollToEnd.mockClear();
  const sent = make({ id: 4, guid: 'sent', text: 'Sent', dateCreated: 4_000, isFromMe: 1 });
  await act(async () => {
    view.rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[sent, ...msgs]} />);
  });
  await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated }));
}

describe('MessageList — pinned-to-bottom convergence', () => {
  beforeEach(() => {
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    mockListProps.current = {};
    mockJumpToReplyByMessage.clear();
    reduceMotionListener = undefined;
    removeReduceMotionListener = jest.fn();
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      return { remove: removeReduceMotionListener };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('joins an already-resolved ref owner immediately and leaves it alive when the list unmounts first', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const msgs = initialWithReply();
    const view = await renderWithTheme(
      <>
        <SharedMotionRefProbe />
      </>,
    );
    await settleInitialMotionPreference();
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <>
          <SharedMotionRefProbe />
          <MessageList chatGuid={GUID} isGroup={false} messages={msgs} />
        </>,
      );
    });
    await waitFor(() => expect(mockJumpToReplyByMessage.get('reply')).toBeDefined());
    expect(autoFollowAnimation()).toBe(false);
    const jumpToReply = mockJumpToReplyByMessage.get('reply');
    await act(async () => jumpToReply?.());
    expect(mockScrollToIndex).toHaveBeenLastCalledWith({
      index: 0,
      animated: false,
      viewPosition: 0.4,
    });
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <>
          <SharedMotionRefProbe />
        </>,
      );
    });
    expect(removeReduceMotionListener).not.toHaveBeenCalled();

    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
  });

  it('keeps a synchronous true event authoritative for render and stable delayed paths', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    mockAddEventListener.mockImplementationOnce((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      listener(true);
      return { remove: removeReduceMotionListener };
    });
    const msgs = initialWithReply();
    await renderWithTheme(<MessageList chatGuid={GUID} isGroup={false} messages={msgs} />);
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(autoFollowAnimation()).toBe(false);
    await waitFor(() => expect(mockJumpToReplyByMessage.get('reply')).toBeDefined());
    const stableJump = mockJumpToReplyByMessage.get('reply');
    await act(async () => stableJump?.());
    expect(mockScrollToIndex).toHaveBeenLastCalledWith({
      index: 0,
      animated: false,
      viewPosition: 0.4,
    });

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(autoFollowAnimation()).toBe(false);
    expect(mockJumpToReplyByMessage.get('reply')).toBe(stableJump);
    mockScrollToIndex.mockClear();
    await act(async () => stableJump?.());
    expect(mockScrollToIndex).toHaveBeenLastCalledWith({
      index: 0,
      animated: false,
      viewPosition: 0.4,
    });
  });

  it('keeps all four motion paths immediate while preference is unknown, without replaying them', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const msgs = initialWithReply();
    const view = await mountAtBottom(msgs, false);

    expect(autoFollowAnimation()).toBe(false);
    await exerciseExplicitScrolls(view, msgs, false);

    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(autoFollowAnimation()).toBe(true);
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    expect(mockScrollToIndex).not.toHaveBeenCalled();

    await dragAwayFromBottom();
    const fab = await view.findByLabelText(FAB_LABEL);
    fireEvent.press(fab);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true }));
  });

  it('keeps all four motion paths immediate when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const msgs = initialWithReply();
    const view = await mountAtBottom(msgs);

    expect(autoFollowAnimation()).toBe(false);
    await exerciseExplicitScrolls(view, msgs, false);
  });

  it('retains all four existing animations when Reduce Motion is initially disabled', async () => {
    const msgs = initialWithReply();
    const view = await mountAtBottom(msgs);

    expect(autoFollowAnimation()).toBe(true);
    await exerciseExplicitScrolls(view, msgs, true);
  });

  it('retains the existing animations for future actions when the native query rejects', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('motion preference unavailable'));
    const msgs = initialWithReply();
    const view = await mountAtBottom(msgs);

    expect(autoFollowAnimation()).toBe(true);
    await exerciseExplicitScrolls(view, msgs, true);
  });

  it.each([
    ['false event over a stale true query', false, true, true],
    ['true event over a stale false query', true, false, false],
  ] as const)(
    'keeps the %s authoritative without replacing memoized row callbacks',
    async (_label, eventValue, staleQueryValue, animated) => {
      const preference = deferred<boolean>();
      mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
      const msgs = initialWithReply();
      await mountAtBottom(msgs, false);
      await waitFor(() => expect(mockJumpToReplyByMessage.get('reply')).toBeDefined());
      const originalJump = mockJumpToReplyByMessage.get('reply');

      await emitReduceMotion(eventValue);
      await act(async () => {
        preference.resolve(staleQueryValue);
        await preference.promise;
      });

      expect(autoFollowAnimation()).toBe(animated);
      expect(mockJumpToReplyByMessage.get('reply')).toBe(originalJump);
      await act(async () => originalJump?.());
      expect(mockScrollToIndex).toHaveBeenLastCalledWith({
        index: 0,
        animated,
        viewPosition: 0.4,
      });
    },
  );

  it('reads a live true event when a just-sent scroll frame actually fires', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const msgs = initial();
    const view = await mountAtBottom(msgs);
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    const sent = make({ id: 3, guid: 'sent', text: 'Sent', dateCreated: 3_000, isFromMe: 1 });
    await act(async () => {
      view.rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[sent, ...msgs]} />);
    });
    expect(callbacks).toHaveLength(1);

    await emitReduceMotion(true);
    mockScrollToEnd.mockClear();
    await act(async () => callbacks[0]?.(0));
    expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('cancels a pending sent-message frame and ignores late preference work after unmount', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callbacks.push(callback);
        return 77;
      });
    const cancelFrame = jest.spyOn(global, 'cancelAnimationFrame');
    const msgs = initial();
    const view = await mountAtBottom(msgs, false);
    await emitReduceMotion(false);

    const sent = make({ id: 3, guid: 'sent', text: 'Sent', dateCreated: 3_000, isFromMe: 1 });
    await act(async () => {
      view.rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[sent, ...msgs]} />);
    });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);
    const lateListener = reduceMotionListener;

    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledWith(77);

    mockScrollToEnd.mockClear();
    await act(async () => {
      lateListener?.(true);
      preference.resolve(true);
      await preference.promise;
      callbacks[0]?.(0);
    });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
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
    const badgeText = await findByText('2');
    const badgeStyle = StyleSheet.flatten(badgeText.props.style);
    expect(badgeStyle.color).toBe(readableTextOn(darkTheme.color.tint));
    expect(contrastRatio(badgeStyle.color, darkTheme.color.tint)).toBeGreaterThanOrEqual(4.5);
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

  /**
   * `focusGuid` (a reminder deep-link / search hit) had ZERO test coverage repo-wide — a grep for
   * it across test/ returned nothing. The test below this one drives the anchored FAB but never
   * sets `focusGuid`, so the anchor path it names was executed by no test: not the
   * `initialScrollIndex` landing, not the keyed remount, and not the frozen pin machine.
   *
   * `messages` is NEWEST-FIRST and the list reverses it, so for initial() the chronological rows
   * are ['a', 'b'] — 'a' is index 0.
   */
  it('lands on the focus target via initialScrollIndex when it is inside the loaded window', async () => {
    await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={initial()} focusGuid="a" />,
    );
    await waitFor(() => expect(mockListProps.current.initialScrollIndex).toBe(0));
  });

  it('degrades to a normal open when the focus target is NOT in the loaded window', async () => {
    // The chat should just open normally rather than jumping somewhere arbitrary.
    await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={initial()} focusGuid="not-loaded" />,
    );
    await waitFor(() => expect(mockListProps.current.data).toHaveLength(2));
    expect(mockListProps.current.initialScrollIndex).toBeUndefined();
  });

  it('passes no initialScrollIndex on an ordinary (non-anchored) open', async () => {
    await mountAtBottom(initial());
    expect(mockListProps.current.initialScrollIndex).toBeUndefined();
  });

  /**
   * THE behavioural consequence of anchoring: the window's bottom is NOT the newest message, so
   * the convergence loop must be OFF. If the pin machine stayed live, every content growth would
   * yank the user from the message they were deep-linked to down to the newest one.
   */
  it('freezes the pin machine while anchored — content growth must NOT scroll to the end', async () => {
    await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={initial()} focusGuid="a" />,
    );
    await waitFor(() => expect(mockListProps.current.initialScrollIndex).toBe(0));
    mockScrollToEnd.mockClear();

    await drive('onContentSizeChange', 400, 2_100);
    await drive('onContentSizeChange', 400, 2_400);

    expect(mockScrollToEnd).not.toHaveBeenCalled();
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

  // Regression guard (device-found, 2026-07-29): with the RN default
  // keyboardShouldPersistTaps="never", a touch on the list while the keyboard is up dismisses the
  // keyboard AND swallows the touch, so swipe-to-reply did nothing whenever the composer had focus.
  // Measured 0/6 with the keyboard open vs 4/4/12/12 closed, identically on a Pixel 10 Pro XL
  // (Android 17) and a Galaxy S25 Ultra (Android 16) — i.e. not OEM-specific. Config-level guard
  // because RNTL has no soft keyboard to drive.
  it('sets keyboardShouldPersistTaps="handled" so a touch cannot swallow row gestures', async () => {
    await renderWithTheme(<MessageList chatGuid={GUID} isGroup={false} messages={initial()} />);
    await waitFor(() => expect(mockListProps.current).toBeTruthy());
    expect(mockListProps.current.keyboardShouldPersistTaps).toBe('handled');
  });
});
