/**
 * A sent message is promoted from its temp guid to the server's guid IN PLACE (the row keeps its
 * id). The list must key rows by that id: keyed by guid, the promotion remounted the bubble half a
 * second into its send effect. Asserts the decision (does the row survive?), not device layout.
 */
import React from 'react';

const mockMounts = { mounted: 0, unmounted: 0 };

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
      scrollToEnd: jest.fn(),
      scrollToIndex: jest.fn(),
      scrollToOffset: jest.fn(),
    }));
    const { data = [], renderItem, keyExtractor, onLoad } = props;
    ReactLib.useEffect(() => {
      onLoad?.({ elapsedTimeInMs: 0 });
    }, []);
    // Keys exactly as the real list would key its rows.
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

jest.mock('@ui/conversations/MessageRow', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return {
    MessageRow: (p: { msg?: { text?: string | null } }) => {
      ReactLib.useEffect(() => {
        mockMounts.mounted += 1;
        return () => {
          mockMounts.unmounted += 1;
        };
      }, []);
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
import { renderWithTheme, act, screen } from '../support/renderWithTheme';
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
    isFromMe: 1,
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
    stickers: [],
    replyPreview: null,
    ...over,
  } as EnrichedMessage;
}

const GUID = 'iMessage;-;+15551230000';

describe('MessageList — row identity across guid promotion', () => {
  beforeEach(() => {
    mockMounts.mounted = 0;
    mockMounts.unmounted = 0;
  });

  it('keeps the same row mounted when a sent message trades its temp guid for the server guid', async () => {
    const temp = make({ id: 7, guid: 'temp-abc', text: 'On its way' });
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={[temp]} />,
    );
    expect(screen.getByText('On its way')).toBeTruthy();
    expect(mockMounts.mounted).toBe(1);

    const promoted = make({ id: 7, guid: 'server-guid-1', text: 'On its way' });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[promoted]} />);
    });

    expect(mockMounts.unmounted).toBe(0);
    expect(mockMounts.mounted).toBe(1);
  });

  it('still remounts when a different row takes the place (a new id)', async () => {
    const first = make({ id: 7, guid: 'temp-abc', text: 'First' });
    const { rerender } = await renderWithTheme(
      <MessageList chatGuid={GUID} isGroup={false} messages={[first]} />,
    );
    const other = make({ id: 8, guid: 'server-guid-2', text: 'Second' });
    await act(async () => {
      rerender(<MessageList chatGuid={GUID} isGroup={false} messages={[other]} />);
    });
    expect(mockMounts.unmounted).toBe(1);
    expect(mockMounts.mounted).toBe(2);
  });
});
