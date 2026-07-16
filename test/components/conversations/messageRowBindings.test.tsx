/**
 * MessageRow → MessageBubble binding stability. MessageBubble is React.memo'd, but that memo is
 * INERT if MessageRow hands it a fresh arrow per render (onRetry/onLongPress/onJumpToReply) — the
 * new closure fails the shallow prop compare. MessageRow therefore wraps each per-row binding in
 * useCallback keyed on [handler, msg] (or [handler, originator]).
 *
 * Proof: MessageBubble is mocked as a MEMOIZED probe. A MessageRow re-render that changes only a
 * row-level prop (isHighlighted — the memo on MessageRow itself fails, the row re-renders) must
 * NOT re-render the bubble (all its props, bindings included, are unchanged). Swapping in a new
 * `msg` object must.
 */
import React, { useCallback } from 'react';
import { renderWithTheme, act } from '../support/renderWithTheme';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const mockBubbleRender = jest.fn();
jest.mock('@ui/conversations/MessageBubble', () => {
  const ReactLib = require('react');
  return {
    MessageBubble: ReactLib.memo(() => {
      mockBubbleRender();
      return null;
    }),
  };
});

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
    threadOriginatorGuid: 'orig-1',
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

const bubbleRenders = (): number => mockBubbleRender.mock.calls.length;

/** Stable outer handlers (the MessageList pattern); `highlighted` flips a row-level prop. */
function Parent({
  msg,
  highlighted,
}: {
  msg: EnrichedMessage;
  highlighted: boolean;
}): React.JSX.Element {
  const onRetry = useCallback((_m: EnrichedMessage) => {}, []);
  const onLongPress = useCallback((_m: EnrichedMessage) => {}, []);
  const onJumpToReply = useCallback((_g: string) => {}, []);
  return (
    <MessageRow
      msg={msg}
      older={null}
      newer={null}
      isGroup={false}
      isLastOutgoing={false}
      onRetry={onRetry}
      onLongPress={onLongPress}
      onJumpToReply={onJumpToReply}
      isHighlighted={highlighted}
    />
  );
}

describe('MessageRow per-row binding stability', () => {
  it('a row re-render with the SAME msg (isHighlighted flip) does NOT re-render the memoized bubble', async () => {
    const msg = makeMsg();
    const view = await renderWithTheme(<Parent msg={msg} highlighted={false} />);
    expect(bubbleRenders()).toBe(1);

    // isHighlighted changed → MessageRow's own memo fails and the ROW re-renders — but every prop
    // it hands MessageBubble (msg + the useCallback bindings) is unchanged, so the bubble's memo
    // holds. A fresh `() => …` binding here would regress this to 2.
    await act(async () => {
      view.rerender(<Parent msg={msg} highlighted={true} />);
    });
    expect(bubbleRenders()).toBe(1);
  });

  it('swapping in a NEW msg object DOES re-render the bubble', async () => {
    const msg = makeMsg();
    const view = await renderWithTheme(<Parent msg={msg} highlighted={false} />);
    expect(bubbleRenders()).toBe(1);

    const changed = makeMsg({ sendState: 'error', error: 22 });
    await act(async () => {
      view.rerender(<Parent msg={changed} highlighted={false} />);
    });
    expect(bubbleRenders()).toBe(2);
  });
});
