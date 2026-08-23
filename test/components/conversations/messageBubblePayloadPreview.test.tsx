/**
 * MessageBubble × NET-00 URL-preview containment:
 *   - a message whose row carries server-decoded payloadData renders the link card DIRECTLY
 *     from text metadata, but never mounts its remote image;
 *   - a message without payloadData reads the local url_previews cache only;
 *   - opening a raw link or cached card uses the external URL opener and never invokes the old
 *     in-app HTML/image fetch pipeline.
 */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { MessagePreview, MessageRow, ReactionRow, UrlPreviewRow } from '@db/repositories';

// Same reasoning as messageBubble.test.tsx: keep the attachment/services (ESM `ky`) module
// graph out of this suite — these are text-with-link bubbles only.
jest.mock('@ui/attachments', () => {
  const React = require('react');
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

// Keep the literal-host validator real, but make the retired in-app fetch pipeline observable.
jest.mock('@/services/urlPreview', () => ({
  ...jest.requireActual('@/services/urlPreview'),
  fetchOgMetadata: jest.fn(async () => ({ kind: 'transient' })),
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
import { fetchOgMetadata } from '@/services/urlPreview';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';

const mockGetUrlPreview = getUrlPreview as jest.MockedFunction<typeof getUrlPreview>;
const mockFetchOgMetadata = fetchOgMetadata as jest.MockedFunction<typeof fetchOgMetadata>;
const mockSafeOpenUrl = safeOpenUrl as jest.MockedFunction<typeof safeOpenUrl>;
const mockFetch = jest.fn();
const originalFetch = global.fetch;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockGetUrlPreview.mockResolvedValue(null);
  mockFetch.mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
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

const URL_A = 'https://preview-a-2t.example/rendezvous-a-91f3';
const URL_B = 'https://preview-b-2t.example/rendezvous-b-82e4';
const A_TITLE = 'cached-a-title-2t-a71d';
const A_DESCRIPTION = 'cached-a-description-2t-b62c';
const A_SITE = 'cached-a-site-2t-c53b';
const B_TITLE = 'cached-b-title-2t-d44a';
const B_DESCRIPTION = 'cached-b-description-2t-e35f';
const B_SITE = 'cached-b-site-2t-f26e';
const STALE_ERROR = 'stale-preview-error-2t-g17d';

function cachedPreview(
  url: string,
  title: string,
  description: string,
  siteName: string,
): UrlPreviewRow {
  return {
    url,
    title,
    description,
    imageUrl: null,
    siteName,
    fetchedAt: 123,
    error: 0,
  };
}

const CACHED_A = cachedPreview(URL_A, A_TITLE, A_DESCRIPTION, A_SITE);
const CACHED_B = cachedPreview(URL_B, B_TITLE, B_DESCRIPTION, B_SITE);

describe('MessageBubble payloadData preview', () => {
  it('drops retained cached URL A metadata immediately while URL B is still loading', async () => {
    const lookupB = deferred<UrlPreviewRow | null>();
    mockGetUrlPreview.mockImplementation((_db, url) => {
      if (url === URL_A) return Promise.resolve(CACHED_A);
      if (url === URL_B) return lookupB.promise;
      return Promise.resolve(null);
    });

    const view = await renderWithTheme(
      <MessageBubble msg={makeMsg({ guid: 'preview-msg-a', text: URL_A })} showTail />,
    );
    expect(await screen.findByText(A_TITLE)).toBeTruthy();
    expect(screen.getByText(A_DESCRIPTION)).toBeTruthy();
    expect(screen.getByText(A_SITE)).toBeTruthy();

    await act(async () => {
      view.rerender(
        <MessageBubble msg={makeMsg({ guid: 'preview-msg-b', text: URL_B })} showTail />,
      );
    });
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenLastCalledWith(undefined, URL_B));
    const whileBLoads = JSON.stringify(view.toJSON());

    await act(async () => {
      lookupB.resolve(CACHED_B);
      await lookupB.promise;
    });

    expect(whileBLoads).toContain(URL_B);
    for (const canary of [URL_A, A_TITLE, A_DESCRIPTION, A_SITE]) {
      expect(whileBLoads).not.toContain(canary);
    }
    expect(screen.getByText(B_TITLE)).toBeTruthy();
    expect(screen.getByText(B_DESCRIPTION)).toBeTruthy();
    expect(screen.getByText(B_SITE)).toBeTruthy();
    fireEvent.press(screen.getByText(B_TITLE));
    await waitFor(() => expect(mockSafeOpenUrl).toHaveBeenCalledWith(URL_B));
    expect(mockSafeOpenUrl).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'rejection'] as const)(
    'keeps deferred URL A %s from publishing over URL B and accepts fresh B metadata',
    async (outcome) => {
      const lookupA = deferred<UrlPreviewRow | null>();
      const lookupB = deferred<UrlPreviewRow | null>();
      mockGetUrlPreview.mockImplementation((_db, url) => {
        if (url === URL_A) return lookupA.promise;
        if (url === URL_B) return lookupB.promise;
        return Promise.resolve(null);
      });

      const view = await renderWithTheme(
        <MessageBubble msg={makeMsg({ guid: 'deferred-preview-a', text: URL_A })} showTail />,
      );
      await waitFor(() => expect(mockGetUrlPreview).toHaveBeenLastCalledWith(undefined, URL_A));

      await act(async () => {
        view.rerender(
          <MessageBubble msg={makeMsg({ guid: 'deferred-preview-b', text: URL_B })} showTail />,
        );
      });
      await waitFor(() => expect(mockGetUrlPreview).toHaveBeenLastCalledWith(undefined, URL_B));

      await act(async () => {
        lookupB.resolve(CACHED_B);
        await lookupB.promise;
      });
      expect(screen.getByText(B_TITLE)).toBeTruthy();
      expect(screen.getByText(B_DESCRIPTION)).toBeTruthy();
      expect(screen.getByText(B_SITE)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') {
          lookupA.resolve(CACHED_A);
          await lookupA.promise;
        } else {
          const settled = lookupA.promise.catch(() => undefined);
          lookupA.reject(new Error(STALE_ERROR));
          await settled;
        }
      });
      const afterOldSettles = JSON.stringify(view.toJSON());

      for (const canary of [B_TITLE, B_DESCRIPTION, B_SITE]) {
        expect(afterOldSettles).toContain(canary);
      }
      for (const canary of [URL_A, A_TITLE, A_DESCRIPTION, A_SITE, STALE_ERROR]) {
        expect(afterOldSettles).not.toContain(canary);
      }
      expect(screen.getByText(B_TITLE)).toBeTruthy();
      expect(screen.getByText(B_DESCRIPTION)).toBeTruthy();
      expect(screen.getByText(B_SITE)).toBeTruthy();
      fireEvent.press(screen.getByText(B_TITLE));
      await waitFor(() => expect(mockSafeOpenUrl).toHaveBeenCalledWith(URL_B));
      expect(mockSafeOpenUrl).toHaveBeenCalledTimes(1);
    },
  );

  it('renders server text metadata without a cache lookup or remote image request', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: PAYLOAD })} showTail />);
    expect(await screen.findByText('Server Title')).toBeTruthy();
    expect(screen.getByText('Server summary.')).toBeTruthy();
    expect(screen.getByText('Example News')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a cache miss renders the raw link without starting the in-app fetch pipeline', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledTimes(1));
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://example.com/article');
    expect(screen.queryByText('Server Title')).toBeNull();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('https://example.com/article'));
    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/article'),
    );
    expect(mockGetUrlPreview).toHaveBeenCalledTimes(1);
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a cached text card remains visible but its remote image never mounts or fetches', async () => {
    const cached: UrlPreviewRow = {
      url: 'https://example.com/article',
      title: 'Cached Title',
      description: 'Cached description.',
      imageUrl: 'https://cdn.example.com/cached.jpg',
      siteName: 'Cached Site',
      fetchedAt: 123,
      error: 0,
    };
    mockGetUrlPreview.mockResolvedValue(cached);

    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    expect(await screen.findByText('Cached Title')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Cached Title'));
    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/article'),
    );
    expect(mockGetUrlPreview).toHaveBeenCalledTimes(1);
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades an image-only cached row to a text-only domain card', async () => {
    mockGetUrlPreview.mockResolvedValue({
      url: 'https://example.com/article',
      title: null,
      description: null,
      imageUrl: 'https://cdn.example.com/cached.jpg',
      siteName: null,
      fetchedAt: 123,
      error: 0,
    });

    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);

    expect(await screen.findAllByText('example.com')).toHaveLength(2);
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('drops an unsafe payload image but keeps the text card', async () => {
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
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an image-only payload never mounts the remote image', async () => {
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({
          payloadData: JSON.stringify({
            urlData: [
              {
                url: 'https://example.com/article',
                imageUrl: 'https://cdn.example.com/image-only.jpg',
              },
            ],
          }),
        })}
        showTail
      />,
    );
    expect(await screen.findAllByText('example.com')).toHaveLength(2);
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the local cache when payload metadata has nothing safe to render', async () => {
    const payload = JSON.stringify({
      urlData: [{ url: 'https://example.com/article', imageUrl: 'http://10.0.0.1/x.jpg' }],
    });
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: payload })} showTail />);
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledTimes(1));
    expect(mockFetchOgMetadata).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
