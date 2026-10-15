/**
 * MessageBubble × link-preview consent (review M212). A preview asks the Gator server to fetch the
 * linked page, which a sender could use to learn that the message was opened:
 *   - your own and saved contacts' links load automatically, as before;
 *   - an unknown sender's link waits for a tap on "Load link preview";
 *   - a preview already cached on this phone still shows, because that needs no request;
 *   - a recycled list row never carries one message's tap to another message.
 */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { MessagePreview, MessageRow, ReactionRow, UrlPreviewRow } from '@db/repositories';

// Same reasoning as messageBubble.test.tsx: keep the attachment/services (ESM `ky`) module
// graph out of this suite — these are text-with-link bubbles only.
jest.mock('@ui/attachments', () => {
  // Jest must load these after installing the module mock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    AttachmentView: () => React.createElement(Text, null, 'ATT'),
    AttachmentGalleryGrid: () => React.createElement(Text, null, 'GRID'),
    // A marker carrying the COUNT so wiring is assertable without rendering the real overlay
    // (which pulls @/services/download -> ky, ESM and untransformed in this project).
    StickerOverlay: ({ stickers }: { stickers: unknown[] }) =>
      React.createElement(Text, null, 'STICKER:' + stickers.length),
  };
});

// Run the real useUrlPreview query callback without opening op-sqlite in the component test.
jest.mock('@db/useReactiveQuery', () => {
  // Jest must load React after installing the module mock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    __esModule: true,
    useReactiveQuery: (
      run: () => Promise<unknown>,
      _tables: string[],
      deps: unknown[],
      options: { enabled?: boolean } = {},
    ) => {
      const enabled = options.enabled !== false;
      const [state, setState] = React.useState({
        data: null,
        isLoading: enabled,
        error: null,
      });
      React.useEffect(() => {
        let cancelled = false;
        if (!enabled) {
          setState({ data: null, isLoading: false, error: null });
          return () => {
            cancelled = true;
          };
        }
        run()
          .then((data) => {
            if (!cancelled) setState({ data, isLoading: false, error: null });
          })
          .catch((error: Error) => {
            if (!cancelled) setState({ data: null, isLoading: false, error });
          });
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, ...deps]);
      return state;
    },
  };
});

jest.mock('@db/repositories', () => ({ getUrlPreview: jest.fn() }));
jest.mock('@/services/urlPreviewLoader', () => ({
  readUrlPreviewAndLoad: jest.fn(async () => null),
}));

jest.mock('@utils', () => ({
  ...jest.requireActual('@utils'),
  safeOpenUrl: jest.fn(async () => true),
}));

// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';
// eslint-disable-next-line import/first
import { getUrlPreview } from '@db/repositories';
// eslint-disable-next-line import/first
import { readUrlPreviewAndLoad } from '@/services/urlPreviewLoader';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

const mockGetUrlPreview = getUrlPreview as jest.MockedFunction<typeof getUrlPreview>;
const mockLoad = readUrlPreviewAndLoad as jest.MockedFunction<typeof readUrlPreviewAndLoad>;

const LINK = 'https://consent.example/article-m212';
const OTHER_LINK = 'https://consent.example/other-m212';
const LOADED_TITLE = 'Loaded title m212';
const LOAD_BUTTON = { name: 'Load link preview' };

function loaded(url: string): UrlPreviewRow {
  return {
    url,
    title: LOADED_TITLE,
    description: null,
    imageUrl: null,
    siteName: null,
    fetchedAt: Date.now(),
    error: 0,
  };
}

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
    text: LINK,
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

beforeEach(() => {
  mockGetUrlPreview.mockReset().mockResolvedValue(null);
  mockLoad.mockReset().mockImplementation(async (url) => loaded(url));
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://gator.example',
    password: 'test-password',
    serverInfo: { supports_url_preview_proxy: true } as never,
  });
});

describe('MessageBubble link-preview consent', () => {
  it('loads an unknown sender’s link preview only after a tap', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ senderKnown: 0 })} showTail />);

    const load = await screen.findByRole('button', LOAD_BUTTON);
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, LINK);
    expect(mockLoad).not.toHaveBeenCalled();

    await fireEvent.press(load);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith(LINK, expect.anything()));
    expect(await screen.findByText(LOADED_TITLE)).toBeTruthy();
    expect(screen.queryByRole('button', LOAD_BUTTON)).toBeNull();
  });

  it.each([
    ['a saved contact', { senderKnown: 1 }],
    ['you', { isFromMe: 1 }],
  ] as const)('loads a link from %s automatically', async (_label, over) => {
    await renderWithTheme(<MessageBubble msg={makeMsg(over)} showTail />);

    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith(LINK, expect.anything()));
    expect(await screen.findByText(LOADED_TITLE)).toBeTruthy();
    expect(screen.queryByRole('button', LOAD_BUTTON)).toBeNull();
  });

  it('shows an unknown sender’s already-cached preview without asking the server', async () => {
    mockGetUrlPreview.mockResolvedValue(loaded(LINK));
    await renderWithTheme(<MessageBubble msg={makeMsg({ senderKnown: 0 })} showTail />);

    expect(await screen.findByText(LOADED_TITLE)).toBeTruthy();
    expect(screen.queryByRole('button', LOAD_BUTTON)).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('offers no button once this phone has cached a failed fetch for the link', async () => {
    mockGetUrlPreview.mockResolvedValue({ ...loaded(LINK), title: null, error: 1 });
    await renderWithTheme(<MessageBubble msg={makeMsg({ senderKnown: 0 })} showTail />);

    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, LINK));
    await waitFor(() => expect(screen.queryByRole('button', LOAD_BUTTON)).toBeNull());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('does not carry a tap to another unknown sender’s message in a recycled row', async () => {
    const view = await renderWithTheme(
      <MessageBubble msg={makeMsg({ senderKnown: 0 })} showTail />,
    );
    await fireEvent.press(await screen.findByRole('button', LOAD_BUTTON));
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));

    await act(async () => {
      view.rerender(
        <MessageBubble
          msg={makeMsg({ guid: 'msg-2', text: OTHER_LINK, senderKnown: 0 })}
          showTail
        />,
      );
    });

    expect(await screen.findByRole('button', LOAD_BUTTON)).toBeTruthy();
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('offers no button when the server cannot fetch previews', async () => {
    useSessionStore.setState({ serverInfo: { supports_url_preview_proxy: false } as never });
    await renderWithTheme(<MessageBubble msg={makeMsg({ senderKnown: 0 })} showTail />);

    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, LINK));
    expect(screen.queryByRole('button', LOAD_BUTTON)).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
