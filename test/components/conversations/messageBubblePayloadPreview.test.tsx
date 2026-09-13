/**
 * MessageBubble × NET-01 URL-preview presentation boundary:
 *   - a message whose row carries server-decoded payloadData renders its text immediately while
 *     the preview hook may augment it from the local/server-proxy cache path;
 *   - legacy remote image URLs never mount, while opening a raw link/card stays user-initiated;
 *   - this isolated presentation suite cannot invoke the authenticated loader or old direct fetch;
 *     the automatic capable-server path is covered by the hook/loader suites.
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
import { safeOpenUrl } from '@utils';

const mockGetUrlPreview = getUrlPreview as jest.MockedFunction<typeof getUrlPreview>;
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
    fetchedAt: Date.now(),
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

  it('renders sender metadata without directly fetching a third-party host', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: PAYLOAD })} showTail />);
    expect(await screen.findByText('Server Title')).toBeTruthy();
    expect(screen.getByText('Server summary.')).toBeTruthy();
    expect(screen.getByText('Example News')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://example.com/article');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps a payload-only preview independently discoverable and actionable as a link', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: null, payloadData: PAYLOAD })} showTail />,
    );

    const previewLink = await screen.findByRole('link', {
      name: 'Link preview: Server Title. Destination: example.com',
    });
    fireEvent.press(previewLink);

    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/article'),
    );
  });

  it('keeps the original payload URL as the immutable card destination after a redirect', async () => {
    const payload = JSON.stringify({
      urlData: [
        {
          originalUrl: 'https://sender.example/article',
          url: 'https://resolved-attacker.example/login',
          title: 'Redirected page title',
        },
      ],
    });
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: null, payloadData: payload })} showTail />,
    );

    const previewLink = await screen.findByRole('link', {
      name: 'Link preview: Redirected page title. Destination: sender.example',
    });
    fireEvent.press(previewLink);

    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://sender.example/article'),
    );
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://sender.example/article');
    expect(mockSafeOpenUrl).not.toHaveBeenCalledWith('https://resolved-attacker.example/login');
  });

  it.each(['mailto:person@example.com', 'tel:+15555550100'])(
    'does not create a hostname-less preview card for %s payload metadata',
    async (url) => {
      const payload = JSON.stringify({ urlData: [{ originalUrl: url, title: 'Opaque target' }] });
      await renderWithTheme(
        <MessageBubble msg={makeMsg({ text: null, payloadData: payload })} showTail />,
      );

      expect(screen.queryByRole('link')).toBeNull();
      expect(mockGetUrlPreview).not.toHaveBeenCalled();
      expect(mockSafeOpenUrl).not.toHaveBeenCalled();
    },
  );

  it('keeps an ineligible text URL visible instead of replacing it with payload metadata', async () => {
    const textUrl = 'https://example.com:8443/private';
    const payload = JSON.stringify({
      urlData: [
        {
          originalUrl: 'https://different.example/article',
          title: 'Different payload destination',
        },
      ],
    });
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: textUrl, payloadData: payload })} showTail />,
    );

    expect(await screen.findByText(textUrl)).toBeTruthy();
    expect(screen.queryByTestId('url-preview-card')).toBeNull();
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
  });

  it('never replaces a present-but-ineligible original payload URL with its resolved URL', async () => {
    const payload = JSON.stringify({
      urlData: [
        {
          originalUrl: 'https://sender.example:8443/article',
          url: 'https://resolved-attacker.example/login',
          title: 'Redirected page title',
        },
      ],
    });
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: null, payloadData: payload })} showTail />,
    );

    expect(screen.queryByTestId('url-preview-card')).toBeNull();
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();
  });

  it('a cache miss on the isolated legacy-server path keeps the raw link actionable', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledTimes(1));
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://example.com/article');
    expect(screen.queryByText('Server Title')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('https://example.com/article'));
    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/article'),
    );
    expect(mockGetUrlPreview).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a cached text card remains visible but its remote image never mounts or fetches', async () => {
    const cached: UrlPreviewRow = {
      url: 'https://example.com/article',
      title: 'Cached Title',
      description: 'Cached description.',
      imageUrl: 'https://cdn.example.com/cached.jpg',
      siteName: 'Cached Site',
      fetchedAt: Date.now(),
      error: 0,
    };
    mockGetUrlPreview.mockResolvedValue(cached);

    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    expect(await screen.findByText('Cached Title')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Cached Title'));
    await waitFor(() =>
      expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/article'),
    );
    expect(mockGetUrlPreview).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an image-only legacy row whose only artwork source is remote', async () => {
    mockGetUrlPreview.mockResolvedValue({
      url: 'https://example.com/article',
      title: null,
      description: null,
      imageUrl: 'https://cdn.example.com/cached.jpg',
      siteName: null,
      fetchedAt: Date.now(),
      error: 0,
    });

    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);

    expect(await screen.findByText('https://example.com/article')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-card')).toBeNull();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
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
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://example.com/article');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an image-only legacy payload falls back to its raw link without mounting the remote image', async () => {
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
    expect(await screen.findByText('https://example.com/article')).toBeTruthy();
    expect(screen.queryByTestId('url-preview-image')).toBeNull();
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, 'https://example.com/article');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the local cache when payload metadata has nothing safe to render', async () => {
    const payload = JSON.stringify({
      urlData: [{ url: 'https://example.com/article', imageUrl: 'http://10.0.0.1/x.jpg' }],
    });
    await renderWithTheme(<MessageBubble msg={makeMsg({ payloadData: payload })} showTail />);
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledTimes(1));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
