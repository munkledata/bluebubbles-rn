/**
 * MessageRow memo contract (AGENTS.md: "React.memo on a list row is INERT unless the list passes
 * STABLE callbacks"). MessageRow is `React.memo`'d; the payoff is that the chat screen's frequent
 * state changes (typing/reply/selection) don't re-render every message row — only a real message
 * change does. That payoff EXISTS ONLY IF the parent hands the row stable props: a fresh
 * `() => …` closure each render fails the shallow prop compare and defeats the memo.
 *
 * We prove BOTH halves of the gotcha:
 *   - STABLE callbacks (useCallback): a parent re-render with the SAME message does NOT re-render
 *     the row; swapping in a DIFFERENT message DOES.
 *   - UNSTABLE callbacks (fresh closure each render): the very same same-message parent re-render
 *     DOES re-render the row — the memo is defeated. This is the regression the gotcha warns about.
 *
 * Render counting: we mock MessageBubble (the one child MessageRow always renders exactly once) to
 * a probe that pings a jest.fn on every render. `mockMessageBubbleRender.mock.calls.length` is thus
 * MessageRow's own render count. Mocking the module also keeps the real MessageBubble's ky/native
 * import graph out of this test entirely.
 */
import React, { useCallback } from 'react';
import { renderWithTheme, act } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const mockMessageBubbleRender = jest.fn();
jest.mock('@ui/conversations/MessageBubble', () => ({
  MessageBubble: () => {
    mockMessageBubbleRender();
    return null;
  },
}));

// eslint-disable-next-line import/first
import { MessageRow } from '@ui/conversations/MessageRow';

function makeMsg(over: Partial<EnrichedMessage> = {}): EnrichedMessage {
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

const renderCount = (): number => mockMessageBubbleRender.mock.calls.length;

/** Parent that passes STABLE (useCallback) handlers — the correct pattern from MessageList. */
function StableParent({ msg }: { msg: EnrichedMessage }): React.JSX.Element {
  const onRetry = useCallback((_m: EnrichedMessage) => {}, []);
  const onLongPress = useCallback((_m: EnrichedMessage) => {}, []);
  return (
    <MessageRow
      msg={msg}
      older={null}
      newer={null}
      isGroup={false}
      isLastOutgoing={false}
      onRetry={onRetry}
      onLongPress={onLongPress}
    />
  );
}

/** Parent that passes a FRESH closure each render — the anti-pattern the gotcha warns against. */
function UnstableParent({ msg }: { msg: EnrichedMessage }): React.JSX.Element {
  return (
    <MessageRow
      msg={msg}
      older={null}
      newer={null}
      isGroup={false}
      isLastOutgoing={false}
      onRetry={(m) => {
        void m;
      }}
    />
  );
}

describe('MessageRow memo contract', () => {
  it('with STABLE callbacks: a same-message parent re-render does NOT re-render the row', async () => {
    const msgA = makeMsg();
    const view = await renderWithTheme(<StableParent msg={msgA} />);
    expect(renderCount()).toBe(1);

    // Parent re-renders with the SAME message reference + stable callbacks → memo bails out.
    await act(async () => {
      view.rerender(<StableParent msg={msgA} />);
    });
    expect(renderCount()).toBe(1);
  });

  it('with STABLE callbacks: swapping in a DIFFERENT message DOES re-render the row', async () => {
    const msgA = makeMsg();
    const view = await renderWithTheme(<StableParent msg={msgA} />);
    expect(renderCount()).toBe(1);

    const msgB = makeMsg({ guid: 'msg-2', text: 'a different message' });
    await act(async () => {
      view.rerender(<StableParent msg={msgB} />);
    });
    // The msg prop changed identity → shallow compare fails → row re-renders.
    expect(renderCount()).toBe(2);
  });

  it('with UNSTABLE callbacks: a same-message parent re-render DOES re-render the row (memo defeated)', async () => {
    const msgA = makeMsg();
    const view = await renderWithTheme(<UnstableParent msg={msgA} />);
    expect(renderCount()).toBe(1);

    // Same message, but the fresh onRetry closure fails the shallow prop compare → memo is inert.
    // This is exactly the regression AGENTS.md documents.
    await act(async () => {
      view.rerender(<UnstableParent msg={msgA} />);
    });
    expect(renderCount()).toBe(2);
  });
});
