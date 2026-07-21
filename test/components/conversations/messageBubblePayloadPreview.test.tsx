/**
 * MessageBubble × Apple rich-link metadata (`payload_data`) — the Phase-3 "previews without
 * fetching" contract:
 *   - a message whose row carries server-decoded payloadData renders the link card DIRECTLY
 *     from it: useUrlPreview receives null (no network, no url_previews cache) and global.fetch
 *     is never touched;
 *   - a message without payloadData falls back to the fetch path (useUrlPreview gets the URL);
 *   - an unsafe (private-host) image URL in the payload is dropped by the SSRF guard — the card
 *     still renders text-only; if the payload has NOTHING safe to render, the bubble falls back
 *     to the fetch path entirely.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import type { MessagePreview, MessageRow, ReactionRow } from '@db/repositories';

// Same reasoning as messageBubble.test.tsx: keep the attachment/services (ESM `ky`) module
// graph out of this suite — these are text-with-link bubbles only.
jest.mock('@ui/attachments', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    AttachmentView: () => React.createElement(Text, null, 'ATT'),
    AttachmentGalleryGrid: () => React.createElement(Text, null, 'GRID'),
  };
});

// Observe the URL the bubble hands the fetch-path hook (null == "payload covered it").
jest.mock('@features/conversations/useUrlPreview', () => ({
  useUrlPreview: jest.fn(() => null),
}));

// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';
// eslint-disable-next-line import/first
import { useUrlPreview } from '@features/conversations/useUrlPreview';
// eslint-disable-next-line import/first
import { useRedactedModeStore } from '@state/redactedModeStore';

const mockUseUrlPreview = useUrlPreview as jest.Mock;
const mockFetch = jest.fn();

beforeEach(() => {
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
  mockUseUrlPreview.mockClear();
  mockFetch.mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

type BubbleMsg = MessageRow & {
  attachments?: never[];
  reactions?: ReactionRow[];
  replyPreview?: MessagePreview | null;
};

function makeMsg(over: Partial<BubbleMsg> = {}): BubbleMsg {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: 'https://example.com/article',
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

const PAYLOAD = JSON.stringify({
  urlData: [
    {
      url: 'https://example.com/article',
      originalUrl: 'https://example.com/article',
      title: 'Server Title',
      summary: 'Server summary.',
      siteName: 'Example News',
      itemType: 'article',
      imageUrl: 'https://cdn.example.com/img.jpg',
      iconUrl: 'https://example.com/favicon.ico',
      videoUrl: null,
    },
  ],
});

describe('MessageBubble payloadData preview', () => {
  it('renders the card from server metadata without fetching (hook gets null, fetch untouched)', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: PAYLOAD })} showTail />);
    expect(await screen.findByText('Server Title')).toBeTruthy();
    expect(screen.getByText('Server summary.')).toBeTruthy();
    expect(screen.getByText('Example News')).toBeTruthy();
    expect(screen.getByTestId('url-preview-image')).toBeTruthy();
    // The fetch-path hook was disabled (null url) and no network request ever happened.
    expect(mockUseUrlPreview).toHaveBeenLastCalledWith(null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the fetch path when the row has no payloadData', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    expect(mockUseUrlPreview).toHaveBeenLastCalledWith('https://example.com/article');
    // Hook returned null (mock) → no card; the raw link text stays tappable.
    expect(screen.queryByText('Server Title')).toBeNull();
  });

  it('drops an unsafe (private-host) payload image but keeps the text card', async () => {
    const payload = JSON.stringify({
      urlData: [
        {
          url: 'https://example.com/article',
          title: 'Server Title',
          imageUrl: 'http://192.168.1.5/steal.jpg',
          iconUrl: 'http://localhost/icon.ico',
        },
      ],
    });
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: payload })} showTail />);
    expect(await screen.findByText('Server Title')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockUseUrlPreview).toHaveBeenLastCalledWith(null);
  });

  it('falls back to the fetch path when the payload has nothing safe to render', async () => {
    const payload = JSON.stringify({
      urlData: [{ url: 'https://example.com/article', imageUrl: 'http://10.0.0.1/x.jpg' }],
    });
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: payload })} showTail />);
    expect(mockUseUrlPreview).toHaveBeenLastCalledWith('https://example.com/article');
  });

  it('suppresses the payload card under redacted mode (no URL/title leak)', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: PAYLOAD })} showTail />);
    expect(screen.queryByText('Server Title')).toBeNull();
    expect(mockUseUrlPreview).toHaveBeenLastCalledWith(null);
  });
});
