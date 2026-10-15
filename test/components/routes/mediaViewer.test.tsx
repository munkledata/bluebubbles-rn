/**
 * MediaViewer route (app/(app)/media/[guid].tsx): the fullscreen photo viewer opened by tapping
 * a picture in a thread.
 *
 * THE BUG THIS LOCKS DOWN: both action pills used to `await` their helper and DISCARD the answer.
 * `saveAttachmentsToPhotos` returns a result (saved | none | denied | stale | error) and
 * `shareAttachment` reports whether the sheet opened at all — and every one of those outcomes,
 * INCLUDING complete success, rendered as absolutely nothing on screen. A save that worked was
 * pixel-identical to a dead button, which is exactly how it was reported.
 *
 * So these tests assert the OUTCOME REPORTING, not the native work: the media helpers are mocked
 * to return each status, and the assertions read the real toast/dialog stores (the same singletons
 * `AppToast`/`AppDialog` render from at the app root).
 *
 * Mock notes: the ZoomableImage subtree is swapped for a plain View (it pulls in expo-image), and
 * `expo-video` is stubbed because the module is imported at file scope even for a photo. The
 * jest.mock factories create their `jest.fn()`s inline — a factory must not dereference an outer
 * `const mock…`, which is still undefined at factory-eval time.
 */
import React from 'react';
import { Dimensions } from 'react-native';
import {
  act,
  fireEvent,
  renderWithTheme,
  screen,
  waitFor,
  type RenderResult,
} from '../support/renderWithTheme';
import { useDialogStore } from '@ui/dialog/dialogStore';
import { useToastStore } from '@ui/toast/toastStore';

const mockBack = jest.fn();
let mockRouteGuid = 'att-1';

jest.mock('@core/secure', () => ({ logger: { warn: jest.fn() } }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: mockRouteGuid }),
  useRouter: () => ({ back: mockBack, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => `/media/${mockRouteGuid}`,
}));

jest.mock('expo-video', () => {
  const useVideoPlayer = jest.fn(() => {
    const player = {
      loop: false,
      status: 'idle',
      play: jest.fn(),
      pause: jest.fn(),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    };
    return player;
  });
  return {
    useVideoPlayer,
    VideoView: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { View } = require('react-native');
      return <View testID="video-view" />;
    },
  };
});

const mockReleaseProtection = jest.fn();
const mockProtectPath = jest.fn<{ path: string; release: () => void } | null, [string]>((path) => ({
  path,
  release: mockReleaseProtection,
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => mockProtectPath(path) },
}));

// expo-image lives under here; the viewer's behavior under test doesn't need a real image.
jest.mock('@ui/attachments/ZoomableImage', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const ZoomableImage = jest.fn(
    (p: {
      uri: string | null;
      blurhash: string | null;
      active: boolean;
      onError: () => void;
      onZoomChange: (zoomed: boolean) => void;
    }) => (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`media ${p.uri ?? 'none'} ${p.blurhash ?? 'no-blurhash'}`}
        testID={`img:${p.uri ?? 'none'}`}
      />
    ),
  );
  return {
    ZoomableImage,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

const PRIVATE_IMAGE_URI = 'file:///docs/private-media-7e4a.jpg';
const PRIVATE_BLURHASH = 'private-media-blurhash-6b29';
const PRIVATE_SECOND_IMAGE_URI = 'file:///docs/private-media-c18d.jpg';
const PRIVATE_SECOND_BLURHASH = 'private-media-blurhash-d02f';
const PRIVATE_VIDEO_URI = 'file:///docs/private-video-f15c.mp4';

const ATT = {
  id: 1,
  guid: 'att-1',
  messageId: 1,
  mimeType: 'image/jpeg',
  transferName: 'a.jpg',
  totalBytes: 1000,
  height: 100,
  width: 100,
  blurhash: PRIVATE_BLURHASH,
  hasLivePhoto: 0,
  isSticker: 0,
  hideAttachment: 0,
  emojiImageContentIdentifier: null,
  emojiImageShortDescription: null,
  localPath: PRIVATE_IMAGE_URI,
  service: 'iMessage',
};

const SECOND_ATT = {
  ...ATT,
  id: 2,
  guid: 'att-2',
  transferName: 'private-second.jpg',
  blurhash: PRIVATE_SECOND_BLURHASH,
  localPath: PRIVATE_SECOND_IMAGE_URI,
};

const ROUTE_B_GUID = 'att-route-b-91df';
const ROUTE_B_FIRST = {
  ...ATT,
  id: 3,
  guid: 'att-route-b-first-31ac',
  transferName: 'route-b-first.jpg',
  blurhash: 'route-b-first-blur-194a',
  localPath: 'file:///docs/route-b-first-4fb2.jpg',
};
const ROUTE_B_TARGET = {
  ...ATT,
  id: 4,
  guid: ROUTE_B_GUID,
  transferName: 'route-b-target.jpg',
  blurhash: 'route-b-target-blur-7ec3',
  localPath: 'file:///docs/route-b-target-8d51.jpg',
};

jest.mock('@db/repositories', () => ({
  getVisibleAttachmentByGuid: jest.fn(),
  listChatImageAttachmentsByAttachmentGuid: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));

jest.mock('@/services/download', () => ({
  download: jest.fn(),
  redownload: jest.fn(),
}));

// eslint-disable-next-line import/first
import {
  getVisibleAttachmentByGuid,
  listChatImageAttachmentsByAttachmentGuid,
} from '@db/repositories';
// eslint-disable-next-line import/first
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
// eslint-disable-next-line import/first
import { download, redownload } from '@/services/download';
// eslint-disable-next-line import/first
import MediaViewer from '../../../app/(app)/media/[guid]';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { useDownloadStore } from '@state/downloadStore';

const getAtt = getVisibleAttachmentByGuid as jest.Mock;
const listGallery = listChatImageAttachmentsByAttachmentGuid as jest.Mock;
const share = shareAttachment as jest.Mock;
const save = saveAttachmentsToPhotos as jest.Mock;
const downloadMedia = download as jest.Mock;
const redownloadMedia = redownload as jest.Mock;
const mockUseVideoPlayer = (jest.requireMock('expo-video') as { useVideoPlayer: jest.Mock })
  .useVideoPlayer;
const mockLoggerWarn = (jest.requireMock('@core/secure') as { logger: { warn: jest.Mock } }).logger
  .warn;
const mockZoomableImage = (
  jest.requireMock('@ui/attachments/ZoomableImage') as { ZoomableImage: jest.Mock }
).ZoomableImage;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Drain an async event handler without nesting another React `act()` scope. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Render the viewer and wait until the photo (hence the enabled pills) is on screen. */
async function renderViewer(): Promise<RenderResult> {
  const view = await renderWithTheme(<MediaViewer />);
  await waitFor(() => expect(screen.getByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy());
  return view;
}

/** The two action pills, in bar order: share (⤴) then save (⤓). */
function pills(): ReturnType<typeof screen.getByText>[] {
  return [screen.getByText('⤴'), screen.getByText('⤓')];
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

function latestImageError(uri: string): () => void {
  const call = [...mockZoomableImage.mock.calls].reverse().find(([props]) => props.uri === uri);
  const onError = call?.[0]?.onError as (() => void) | undefined;
  if (!onError) throw new Error(`Expected an image error callback for ${uri}`);
  return onError;
}

function renderedMediaLabels(): string[] {
  return screen.queryAllByRole('image').map((node) => String(node.props.accessibilityLabel ?? ''));
}

function expectRenderedMediaToOmit(...privateValues: string[]): void {
  const renderedLabels = renderedMediaLabels().join('\n');
  for (const privateValue of privateValues) {
    expect(renderedLabels).not.toContain(privateValue);
  }
}

interface MediaListProbe {
  props: {
    data: unknown[];
    initialScrollIndex: number;
    scrollEnabled: boolean;
    onScrollBeginDrag: () => void;
    onMomentumScrollEnd: (event: object) => void;
  };
}

function mediaList(view: RenderResult): MediaListProbe {
  if (!view.root) throw new Error('Expected a rendered MediaViewer root');
  const candidates = view.root.queryAll(
    (node) =>
      Array.isArray(node.props.data) && typeof node.props.onMomentumScrollEnd === 'function',
  );
  const list = candidates[0];
  if (!list) throw new Error('Expected a rendered media FlatList');
  return list as unknown as MediaListProbe;
}

async function scrollToPage(view: RenderResult, rawIndex: number): Promise<void> {
  const callback = mediaList(view).props.onMomentumScrollEnd;
  await act(async () => {
    callback({
      nativeEvent: { contentOffset: { x: Dimensions.get('window').width * rawIndex, y: 0 } },
    });
  });
}

async function beginPageDrag(view: RenderResult): Promise<void> {
  await act(async () => mediaList(view).props.onScrollBeginDrag());
}

async function emitVideoError(): Promise<void> {
  const player = mockUseVideoPlayer.mock.results.at(-1)?.value as
    { addListener?: jest.Mock } | undefined;
  const listener = player?.addListener?.mock.calls.find(
    ([name]) => name === 'statusChange',
  )?.[1] as ((event: { status: string }) => void) | undefined;
  if (!listener) throw new Error('Expected an active video status listener');
  await act(async () => listener({ status: 'error' }));
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockRouteGuid = 'att-1';
  useToastStore.setState({ current: null, queue: [] });
  useDialogStore.setState({ current: null, queue: [] });
  getAtt
    .mockReset()
    .mockImplementation((_db, guid) =>
      Promise.resolve(guid === SECOND_ATT.guid ? SECOND_ATT : ATT),
    );
  listGallery.mockReset().mockResolvedValue({ items: [ATT], index: 0 });
  share.mockReset();
  save.mockReset();
  downloadMedia.mockReset().mockResolvedValue(null);
  redownloadMedia.mockReset().mockResolvedValue(null);
  useDownloadStore.getState().reset();
  mockReleaseProtection.mockClear();
  mockUseVideoPlayer.mockClear();
  mockZoomableImage.mockClear();
  mockBack.mockClear();
  mockLoggerWarn.mockClear();
  mockProtectPath.mockReset().mockImplementation((path) => ({
    path,
    release: mockReleaseProtection,
  }));
});

afterEach(() => {
  resumeRealtimeDeliveries();
  useDownloadStore.getState().reset();
});

describe('MediaViewer account ownership', () => {
  it('automatically hides and releases already-resolved account-A media', async () => {
    const view = await renderWithTheme(<MediaViewer />);
    await waitFor(() => expect(screen.getByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy());
    mockReleaseProtection.mockClear();

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });

    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_IMAGE_URI);
  });

  it.each(['success', 'rejection'] as const)(
    'drops a delayed account-A DB %s without logging or contaminating a fresh account',
    async (outcome) => {
      const pendingAttachment = deferred<typeof ATT>();
      getAtt.mockReset().mockReturnValueOnce(pendingAttachment.promise);
      const oldView = await renderWithTheme(<MediaViewer />);
      await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(1));

      await act(async () => {
        const pause = pauseRealtimeDeliveries();
        if (outcome === 'success') pendingAttachment.resolve(ATT);
        else pendingAttachment.reject(new Error('stale-account-media-load-error-61da'));
        await pendingAttachment.promise.catch(() => undefined);
        await pause;
      });
      resumeRealtimeDeliveries();

      expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(JSON.stringify(oldView.toJSON())).not.toContain('stale-account-media-load-error-61da');

      await act(async () => oldView.unmount());
      mockRouteGuid = ROUTE_B_GUID;
      getAtt.mockReset().mockResolvedValue(ROUTE_B_TARGET);
      listGallery.mockReset().mockResolvedValue({ items: [ROUTE_B_TARGET], index: 0 });
      const freshView = await renderWithTheme(<MediaViewer />);
      expect(await screen.findByTestId(`img:${ROUTE_B_TARGET.localPath}`)).toBeTruthy();
      expect(JSON.stringify(freshView.toJSON())).not.toContain(
        'stale-account-media-load-error-61da',
      );
    },
  );

  it('makes a retained account-A Share callback inert after reconnect', async () => {
    share.mockResolvedValue({ ok: true });
    const oldView = await renderViewer();
    const oldShare = retainConfiguredPress(screen.getByRole('button', { name: 'Share media' }));

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });
    oldShare();
    await flush();

    expect(share).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();

    await act(async () => oldView.unmount());
    await renderViewer();
    const freshShare = retainConfiguredPress(screen.getByRole('button', { name: 'Share media' }));
    freshShare();
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(PRIVATE_IMAGE_URI, 'image/jpeg', expect.any(Function)),
    );
  });

  it('makes a retained account-A Save callback inert after reconnect', async () => {
    save.mockResolvedValue({ status: 'saved', saved: 1 });
    const oldView = await renderViewer();
    const oldSave = retainConfiguredPress(screen.getByRole('button', { name: 'Save media' }));

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });
    oldSave();
    await flush();

    expect(save).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();

    await act(async () => oldView.unmount());
    await renderViewer();
    const freshSave = retainConfiguredPress(screen.getByRole('button', { name: 'Save media' }));
    freshSave();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith([PRIVATE_IMAGE_URI], expect.any(Function)),
    );
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
  });
});

describe('MediaViewer route, page, and mount ownership', () => {
  it('renders the exact gallery, counter, actions, and Close behavior', async () => {
    listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
    const view = await renderWithTheme(<MediaViewer />);

    expect(
      await screen.findByRole('image', {
        name: `media ${PRIVATE_IMAGE_URI} ${PRIVATE_BLURHASH}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('image', {
        name: 'media none no-blurhash',
      }),
    ).toBeTruthy();
    expectRenderedMediaToOmit(PRIVATE_SECOND_IMAGE_URI, PRIVATE_SECOND_BLURHASH);
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeEnabled();

    const oldShare = retainConfiguredPress(screen.getByRole('button', { name: 'Share media' }));
    const oldSave = retainConfiguredPress(screen.getByRole('button', { name: 'Save media' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close media viewer' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    oldShare();
    oldSave();
    await flush();
    expect(share).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    await act(async () => view.unmount());
    expect(mockReleaseProtection).toHaveBeenCalledTimes(2);
  });

  it('hides route A immediately, releases it, and mounts route B at its own initial index', async () => {
    const routeB = deferred<typeof ROUTE_B_TARGET>();
    getAtt.mockImplementation((_db, guid) =>
      guid === ROUTE_B_GUID ? routeB.promise : Promise.resolve(ATT),
    );
    listGallery.mockImplementation((_db, guid) =>
      Promise.resolve(
        guid === ROUTE_B_GUID
          ? { items: [ROUTE_B_FIRST, ROUTE_B_TARGET], index: 1 }
          : { items: [ATT, SECOND_ATT], index: 0 },
      ),
    );
    const view = await renderWithTheme(<MediaViewer />);
    expect(await screen.findByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy();
    mockReleaseProtection.mockClear();

    mockRouteGuid = ROUTE_B_GUID;
    await view.rerender(<MediaViewer />);
    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expect(screen.queryByTestId(`img:${PRIVATE_SECOND_IMAGE_URI}`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(2);

    routeB.resolve(ROUTE_B_TARGET);
    expect(await screen.findByTestId(`img:${ROUTE_B_TARGET.localPath}`)).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    const routeBList = mediaList(view);
    expect(routeBList.props.initialScrollIndex).toBe(1);
    share.mockResolvedValue({ ok: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        ROUTE_B_TARGET.localPath,
        ROUTE_B_TARGET.mimeType,
        expect.any(Function),
      ),
    );
  });

  it('does not let a retained route-A drag cancel route-B Share continuation', async () => {
    const routeARemote = { ...ATT, localPath: null };
    const routeBRemote = { ...ROUTE_B_TARGET, localPath: null };
    const routeBDownloaded = {
      ...routeBRemote,
      localPath: 'file:///docs/route-b-drag-finished.jpg',
    };
    let routeBFinished = false;
    getAtt.mockImplementation((_db, attachmentGuid) => {
      if (attachmentGuid !== ROUTE_B_GUID) return Promise.resolve(routeARemote);
      return Promise.resolve(routeBFinished ? routeBDownloaded : routeBRemote);
    });
    listGallery.mockImplementation((_db, attachmentGuid) =>
      Promise.resolve({
        items: [attachmentGuid === ROUTE_B_GUID ? routeBRemote : routeARemote],
        index: 0,
      }),
    );
    downloadMedia.mockImplementation((att: typeof routeARemote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    share.mockResolvedValue({ ok: true });
    const view = await renderWithTheme(<MediaViewer />);
    await screen.findByRole('button', { name: 'Download media' });

    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    const retainedRouteADrag = mediaList(view).props.onScrollBeginDrag;

    mockRouteGuid = ROUTE_B_GUID;
    await view.rerender(<MediaViewer />);
    await screen.findByRole('button', { name: 'Download media' });
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(2));
    await act(async () => retainedRouteADrag());

    routeBFinished = true;
    await act(async () => {
      useDownloadStore.getState().finish(ROUTE_B_GUID);
      await flush();
      await flush();
    });

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        routeBDownloaded.localPath,
        routeBDownloaded.mimeType,
        expect.any(Function),
      ),
    );
  });

  it.each(['success', 'rejection'] as const)(
    'does not adopt a late route-A load %s after route B is current',
    async (outcome) => {
      const routeA = deferred<typeof ATT>();
      getAtt.mockImplementation((_db, guid) =>
        guid === ROUTE_B_GUID ? Promise.resolve(ROUTE_B_TARGET) : routeA.promise,
      );
      listGallery.mockImplementation((_db, guid) =>
        Promise.resolve(
          guid === ROUTE_B_GUID
            ? { items: [ROUTE_B_FIRST, ROUTE_B_TARGET], index: 1 }
            : { items: [ATT], index: 0 },
        ),
      );
      const view = await renderWithTheme(<MediaViewer />);
      await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(1));

      mockRouteGuid = ROUTE_B_GUID;
      await view.rerender(<MediaViewer />);
      expect(await screen.findByTestId(`img:${ROUTE_B_TARGET.localPath}`)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') routeA.resolve(ATT);
        else routeA.reject(new Error('late-route-a-media-error-8a21'));
        await routeA.promise.catch(() => undefined);
      });
      expect(screen.getByTestId(`img:${ROUTE_B_TARGET.localPath}`)).toBeTruthy();
      expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
      expect(JSON.stringify(view.toJSON())).not.toContain('late-route-a-media-error-8a21');
    },
  );

  it.each([
    { action: 'Share result', button: 'Share media', nativeMock: share, rejects: false },
    { action: 'Share rejection', button: 'Share media', nativeMock: share, rejects: true },
    { action: 'Save result', button: 'Save media', nativeMock: save, rejects: false },
    { action: 'Save rejection', button: 'Save media', nativeMock: save, rejects: true },
  ])(
    'revokes old page callbacks and suppresses a stale $action across A → B → A',
    async ({ button, nativeMock, rejects }) => {
      listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
      const pending = deferred<unknown>();
      nativeMock.mockReturnValueOnce(pending.promise);
      const view = await renderViewer();
      const oldPress = retainConfiguredPress(screen.getByRole('button', { name: button }));
      oldPress();
      await waitFor(() => expect(nativeMock).toHaveBeenCalledTimes(1));

      await scrollToPage(view, 1);
      expect(screen.getByText('2 of 2')).toBeTruthy();
      await scrollToPage(view, 0);
      expect(screen.getByText('1 of 2')).toBeTruthy();
      await waitFor(() => expect(screen.getByRole('button', { name: button })).toBeEnabled());
      oldPress();
      const blockedCurrentPress = retainConfiguredPress(
        screen.getByRole('button', { name: button }),
      );
      blockedCurrentPress();
      await flush();
      expect(nativeMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (rejects) pending.reject(new Error('stale-page-native-error-49be'));
        else if (button === 'Share media') pending.resolve({ ok: false, reason: 'failed' });
        else pending.resolve({ status: 'saved', saved: 1 });
        await pending.promise.catch(() => undefined);
      });
      await flush();
      expect(useDialogStore.getState().current).toBeNull();
      expect(useToastStore.getState().current).toBeNull();
      expect(JSON.stringify(view.toJSON())).not.toContain('stale-page-native-error-49be');

      oldPress();
      await flush();
      expect(nativeMock).toHaveBeenCalledTimes(1);
      nativeMock.mockResolvedValueOnce(
        button === 'Share media' ? { ok: true } : { status: 'saved', saved: 1 },
      );
      const freshPress = retainConfiguredPress(screen.getByRole('button', { name: button }));
      freshPress();
      await waitFor(() => expect(nativeMock).toHaveBeenCalledTimes(2));
      if (button === 'Share media') {
        expect(nativeMock).toHaveBeenLastCalledWith(
          PRIVATE_IMAGE_URI,
          'image/jpeg',
          expect.any(Function),
        );
      } else {
        expect(nativeMock).toHaveBeenLastCalledWith([PRIVATE_IMAGE_URI], expect.any(Function));
      }
    },
  );

  it('clamps overscroll, never falls back to the tapped attachment, and ignores stale zoom', async () => {
    listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
    share.mockResolvedValue({ ok: true });
    const view = await renderViewer();
    const oldZoom = mockZoomableImage.mock.calls.find(
      ([props]) => props.uri === PRIVATE_IMAGE_URI,
    )?.[0]?.onZoomChange as ((zoomed: boolean) => void) | undefined;
    if (!oldZoom) throw new Error('Expected the first page zoom callback');

    await scrollToPage(view, 1);
    expect(screen.getByText('2 of 2')).toBeTruthy();
    await scrollToPage(view, 0);
    expect(screen.getByText('1 of 2')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    await act(async () => {
      oldZoom(true);
    });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(mediaList(view).props.scrollEnabled).toBe(true);

    const currentACalls = mockZoomableImage.mock.calls.filter(
      ([props]) => props.uri === PRIVATE_IMAGE_URI,
    );
    const freshZoom = currentACalls[currentACalls.length - 1]?.[0]?.onZoomChange as
      ((zoomed: boolean) => void) | undefined;
    if (!freshZoom) throw new Error('Expected the fresh first-page zoom callback');
    await act(async () => freshZoom(true));
    expect(mediaList(view).props.scrollEnabled).toBe(false);
    await act(async () => freshZoom(false));
    expect(mediaList(view).props.scrollEnabled).toBe(true);

    await scrollToPage(view, 99);
    expect(screen.getByText('2 of 2')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        PRIVATE_SECOND_IMAGE_URI,
        'image/jpeg',
        expect.any(Function),
      ),
    );

    await scrollToPage(view, -99);
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });

  it('pins video before player construction and releases it on automatic account retirement', async () => {
    const video = { ...ATT, mimeType: 'video/mp4', localPath: PRIVATE_VIDEO_URI };
    getAtt.mockResolvedValue(video);
    const view = await renderWithTheme(<MediaViewer />);
    expect(await screen.findByTestId('video-view')).toBeTruthy();
    expect(mockProtectPath).toHaveBeenCalledWith(PRIVATE_VIDEO_URI);
    expect(mockUseVideoPlayer).toHaveBeenCalledWith(PRIVATE_VIDEO_URI, expect.any(Function));
    expect(mockProtectPath.mock.invocationCallOrder[0]).toBeLessThan(
      mockUseVideoPlayer.mock.invocationCallOrder[0]!,
    );
    mockReleaseProtection.mockClear();

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });
    await waitFor(() => expect(screen.queryByTestId('video-view')).toBeNull());
    expect(mockReleaseProtection).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_VIDEO_URI);
  });

  it('does no read, pin, or player construction for an initially retired account', async () => {
    await pauseRealtimeDeliveries();
    const view = await renderWithTheme(<MediaViewer />);
    expect(getAtt).not.toHaveBeenCalled();
    expect(listGallery).not.toHaveBeenCalled();
    expect(mockProtectPath).not.toHaveBeenCalled();
    expect(mockUseVideoPlayer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    await act(async () => view.unmount());
    resumeRealtimeDeliveries();
  });

  it.each([
    {
      action: 'Share',
      button: 'Share media',
      nativeMock: share,
      rawError: 'current-share-rejection-28ad',
    },
    {
      action: 'Save',
      button: 'Save media',
      nativeMock: save,
      rawError: 'current-save-rejection-75ce',
    },
  ])(
    'publishes fixed copy for a current $action rejection and permits an exact retry',
    async ({ action, button, nativeMock, rawError }) => {
      nativeMock.mockRejectedValueOnce(new Error(rawError));
      const view = await renderViewer();
      const press = retainConfiguredPress(screen.getByRole('button', { name: button }));
      press();

      if (action === 'Share') {
        await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Share'));
        expect(useDialogStore.getState().current?.message).toMatch(/Couldn’t open the share sheet/);
      } else {
        await waitFor(() =>
          expect(useToastStore.getState().current?.message).toBe('Couldn’t save this photo'),
        );
      }
      expect(screen.getByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy();
      expect(JSON.stringify(view.toJSON())).not.toContain(rawError);

      useDialogStore.setState({ current: null, queue: [] });
      useToastStore.setState({ current: null, queue: [] });
      nativeMock.mockResolvedValueOnce(
        action === 'Share' ? { ok: true } : { status: 'saved', saved: 1 },
      );
      press();
      await waitFor(() => expect(nativeMock).toHaveBeenCalledTimes(2));
      if (action === 'Share') {
        expect(nativeMock).toHaveBeenLastCalledWith(
          PRIVATE_IMAGE_URI,
          'image/jpeg',
          expect.any(Function),
        );
        expect(useDialogStore.getState().current).toBeNull();
      } else {
        expect(nativeMock).toHaveBeenLastCalledWith([PRIVATE_IMAGE_URI], expect.any(Function));
        await waitFor(() =>
          expect(useToastStore.getState().current?.message).toBe('Saved to Photos'),
        );
      }
    },
  );

  it.each([
    {
      action: 'Share result after Close',
      button: 'Share media',
      nativeMock: share,
      revoke: 'close',
      rejects: false,
    },
    {
      action: 'Save rejection after unmount',
      button: 'Save media',
      nativeMock: save,
      revoke: 'unmount',
      rejects: true,
    },
  ] as const)(
    'suppresses an admitted $action and retained callback after mount revocation',
    async ({ button, nativeMock, revoke, rejects }) => {
      const pending = deferred<unknown>();
      nativeMock.mockReturnValueOnce(pending.promise);
      const view = await renderViewer();
      const retainedPress = retainConfiguredPress(screen.getByRole('button', { name: button }));
      retainedPress();
      await waitFor(() => expect(nativeMock).toHaveBeenCalledTimes(1));

      if (revoke === 'close') {
        await fireEvent.press(screen.getByRole('button', { name: 'Close media viewer' }));
        expect(mockBack).toHaveBeenCalledTimes(1);
      } else {
        await act(async () => view.unmount());
      }
      retainedPress();
      await flush();
      expect(nativeMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (rejects) pending.reject(new Error('revoked-mounted-action-error-35bf'));
        else pending.resolve({ ok: false, reason: 'failed' });
        await pending.promise.catch(() => undefined);
      });
      await flush();
      expect(useDialogStore.getState().current).toBeNull();
      expect(useToastStore.getState().current).toBeNull();
      if (revoke === 'close') {
        expect(JSON.stringify(view.toJSON())).not.toContain('revoked-mounted-action-error-35bf');
        await act(async () => view.unmount());
      }
    },
  );
});

describe('MediaViewer save button', () => {
  it('confirms a successful save with a toast — it used to show nothing at all', async () => {
    save.mockResolvedValue({ status: 'saved', saved: 1 });
    await renderViewer();

    await fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
    expect(save).toHaveBeenCalledWith([PRIVATE_IMAGE_URI], expect.any(Function));
  });

  it('explains a refused Photos permission instead of failing silently', async () => {
    save.mockResolvedValue({ status: 'denied' });
    await renderViewer();

    await fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Save'));
    expect(useDialogStore.getState().current?.message).toMatch(/permission/i);
    expect(useToastStore.getState().current).toBeNull();
  });

  it('reports a failed save', async () => {
    save.mockResolvedValue({ status: 'error' });
    await renderViewer();

    await fireEvent.press(pills()[1]!);

    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toMatch(/couldn’t save/i),
    );
  });
});

describe('MediaViewer share button', () => {
  it('says nothing when the share sheet opened — the sheet IS the feedback', async () => {
    share.mockResolvedValue({ ok: true });
    await renderViewer();

    await fireEvent.press(pills()[0]!);

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(PRIVATE_IMAGE_URI, 'image/jpeg', expect.any(Function)),
    );
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();
  });

  // The reported symptom: tapping share appeared to do nothing at all. A share sheet that fails to
  // open is a hard failure and must say so — it can no longer masquerade as a successful share.
  it('surfaces a share that never opened, and points at the log', async () => {
    share.mockResolvedValue({ ok: false, reason: 'failed' });
    await renderViewer();

    await fireEvent.press(pills()[0]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Share'));
    expect(useDialogStore.getState().current?.message).toMatch(/App Logs/);
  });

  it('distinguishes "sharing unavailable on this device"', async () => {
    share.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await renderViewer();

    await fireEvent.press(pills()[0]!);

    await waitFor(() =>
      expect(useDialogStore.getState().current?.message).toMatch(/isn’t available/i),
    );
  });
});

describe('MediaViewer double-tap', () => {
  // The reported symptom ("I tap and nothing happens") trains the user to tap twice. expo-sharing
  // throws "sharing already in progress" on a concurrent call, so without this guard the second
  // tap would raise a "couldn't open the share sheet" dialog — and upload an error report — for a
  // sheet that opened perfectly on the first tap.
  /**
   * A promise the test settles by hand, so it can hold an action "in flight" across a second tap.
   * EVERY deferred must be settled before the test ends and flushed — a promise still pending at
   * teardown leaves work queued against an unmounted tree and corrupts every LATER test in the
   * file (React 19 overlapping-act; see AGENTS.md).
   */
  function deferred<T>(): { promise: Promise<T>; settle: (v: T) => void } {
    let settle!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      settle = r;
    });
    return { promise, settle };
  }

  // Await each RNTL interaction before starting another act scope or settling native work.
  it('ignores a second share tap while the first is still in flight', async () => {
    const d = deferred<{ ok: true }>();
    share.mockReturnValue(d.promise);
    await renderViewer();

    await fireEvent.press(pills()[0]!);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await fireEvent.press(pills()[0]!);
    await flush(); // let the second tap's handler run (or be refused)

    expect(share).toHaveBeenCalledTimes(1);
    d.settle({ ok: true });
    await flush();
    // The first share opened the sheet, so nothing is reported — and crucially the refused second
    // tap did NOT raise a "couldn't open the share sheet" dialog.
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('ignores a second save tap while the first is still in flight', async () => {
    const d = deferred<{ status: 'saved'; saved: number }>();
    save.mockReturnValue(d.promise);
    await renderViewer();

    await fireEvent.press(pills()[1]!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await fireEvent.press(pills()[1]!);
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    d.settle({ status: 'saved', saved: 1 });
    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
  });

  // Separate refs, not one shared flag: a share whose native promise hasn't settled must not also
  // disable saving.
  it('an unsettled share does not disable the save button', async () => {
    const d = deferred<{ ok: true }>();
    share.mockReturnValue(d.promise);
    save.mockResolvedValue({ status: 'saved', saved: 1 });
    await renderViewer();

    await fireEvent.press(pills()[0]!);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
    d.settle({ ok: true });
    await flush();
  });
});

describe('MediaViewer gating', () => {
  it('preflights the initial page before publishing a path changed during route admission', async () => {
    const admitted = { ...ATT, localPath: null };
    const currentRow = { ...admitted, localPath: 'file:///docs/current-initial-att-1.jpg' };
    const preflight = deferred<typeof currentRow>();
    getAtt.mockReset().mockResolvedValueOnce(admitted).mockReturnValueOnce(preflight.promise);
    listGallery.mockResolvedValue({ items: [admitted], index: 0 });
    await renderWithTheme(<MediaViewer />);

    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();
    expectRenderedMediaToOmit(PRIVATE_BLURHASH);
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeDisabled();
    expect(downloadMedia).not.toHaveBeenCalled();

    await act(async () => {
      preflight.resolve(currentRow);
      await preflight.promise;
    });

    expect(await screen.findByTestId(`img:${currentRow.localPath}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Download media' })).toBeNull();
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('withholds an initial local path until preflight confirms that it was not cleared', async () => {
    const cleared = { ...ATT, localPath: null };
    const preflight = deferred<typeof cleared>();
    getAtt.mockReset().mockResolvedValueOnce(ATT).mockReturnValueOnce(preflight.promise);
    listGallery.mockResolvedValue({ items: [ATT], index: 0 });
    await renderWithTheme(<MediaViewer />);

    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();
    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expectRenderedMediaToOmit(PRIVATE_BLURHASH);
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeDisabled();

    await act(async () => {
      preflight.resolve(cleared);
      await preflight.promise;
    });

    expect(await screen.findByRole('button', { name: 'Download media' })).toBeTruthy();
    expect(screen.getByTestId('img:none')).toBeTruthy();
    expect(mockUseVideoPlayer).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('copy-on-write redownloads an image that native decoding rejects', async () => {
    const replacement = { ...ATT, localPath: 'file:///docs/redownloaded-att-1.jpg' };
    let authoritative: typeof ATT | typeof replacement = ATT;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    redownloadMedia.mockImplementation((att: typeof ATT) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderViewer();
    const staleImageError = latestImageError(PRIVATE_IMAGE_URI);

    await act(async () => staleImageError());
    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expectRenderedMediaToOmit(PRIVATE_BLURHASH);
    expect(screen.getByRole('button', { name: 'Retry media download' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Retry media download' }));
    expect(redownloadMedia).toHaveBeenCalledWith(ATT, expect.any(Object));
    expect(downloadMedia).not.toHaveBeenCalled();
    authoritative = replacement;
    await act(async () => {
      useDownloadStore.getState().finish(ATT.guid);
      await flush();
      await flush();
    });

    expect(await screen.findByTestId(`img:${replacement.localPath}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    await act(async () => staleImageError());
    expect(screen.getByTestId(`img:${replacement.localPath}`)).toBeTruthy();
  });

  it('adopts a cleared source after replacement loses and retries as an ordinary download', async () => {
    const remote = { ...ATT, localPath: null };
    let authoritative: typeof ATT | typeof remote = ATT;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    redownloadMedia.mockImplementation((att: typeof ATT) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderViewer();
    const staleImageError = latestImageError(PRIVATE_IMAGE_URI);

    await act(async () => staleImageError());
    await fireEvent.press(screen.getByRole('button', { name: 'Retry media download' }));
    authoritative = remote;
    await act(async () => {
      useDownloadStore.getState().finish(ATT.guid);
      await flush();
      await flush();
    });

    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Retry media download' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry media download' }));
    expect(downloadMedia).toHaveBeenCalledWith(remote, 'manual', expect.any(Object));
    expect(redownloadMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps rejected bytes hidden when an intermediate terminal read still returns that path', async () => {
    const replacement = { ...ATT, localPath: 'file:///docs/recovery-after-stale-terminal.jpg' };
    let authoritative: typeof ATT | typeof replacement = ATT;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    redownloadMedia.mockImplementation((att: typeof ATT) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderViewer();
    const staleImageError = latestImageError(PRIVATE_IMAGE_URI);

    await act(async () => staleImageError());
    await fireEvent.press(screen.getByRole('button', { name: 'Retry media download' }));
    await act(async () => {
      useDownloadStore.getState().finish(ATT.guid);
      await flush();
    });

    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expectRenderedMediaToOmit(PRIVATE_IMAGE_URI, PRIVATE_BLURHASH);
    expect(screen.getByRole('button', { name: 'Retry media download' })).toBeTruthy();

    authoritative = replacement;
    await act(async () => {
      useDownloadStore.getState().finish(ATT.guid);
      await flush();
      await flush();
    });
    expect(await screen.findByTestId(`img:${replacement.localPath}`)).toBeTruthy();
  });

  it('turns an expo-video player error into the same forced-redownload affordance', async () => {
    const video = { ...ATT, mimeType: 'video/mp4', localPath: PRIVATE_VIDEO_URI };
    getAtt.mockResolvedValue(video);
    redownloadMedia.mockImplementation((att: typeof video) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);
    expect(await screen.findByTestId('video-view')).toBeTruthy();

    await emitVideoError();
    expect(screen.queryByTestId('video-view')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry media download' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry media download' }));

    expect(redownloadMedia).toHaveBeenCalledWith(video, expect.any(Object));
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('visibly downloads a remote photo, adopts its DB path, then continues Share', async () => {
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/downloaded-att-1.jpg' };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    share.mockResolvedValue({ ok: true });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);
    expect(await screen.findByRole('button', { name: 'Download media' })).toBeTruthy();
    expect(screen.getAllByTestId('img:none').length).toBeGreaterThan(0);

    expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));

    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    expect(downloadMedia).toHaveBeenCalledWith(remote, 'manual', expect.any(Object));
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    await act(async () => useDownloadStore.getState().setProgress(remote.guid, 25, 100));
    expect(
      screen.getByRole('progressbar', { name: 'Downloading media to share' }).props
        .accessibilityValue,
    ).toEqual({ min: 0, max: 100, now: 25 });

    getAtt.mockResolvedValue(downloaded);
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
      await flush();
    });

    expect(screen.getByTestId(`img:${downloaded.localPath}`)).toBeTruthy();
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        downloaded.localPath,
        downloaded.mimeType,
        expect.any(Function),
      ),
    );
    expect(getAtt).toHaveBeenLastCalledWith(undefined, remote.guid);
  });

  it('shows indeterminate video progress, then renders and continues Save', async () => {
    const remote = { ...ATT, mimeType: 'video/mp4', localPath: null };
    const downloaded = { ...remote, localPath: PRIVATE_VIDEO_URI };
    getAtt.mockResolvedValue(remote);
    save.mockResolvedValue({ status: 'saved', saved: 1 });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);
    expect(await screen.findByRole('button', { name: 'Download media' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Save media' }));
    await act(async () => useDownloadStore.getState().setProgress(remote.guid, 20, -1));
    expect(
      screen.getByRole('progressbar', { name: 'Downloading media to save' }).props
        .accessibilityValue,
    ).toBeUndefined();

    getAtt.mockResolvedValue(downloaded);
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
      await flush();
    });

    expect(screen.getByTestId('video-view')).toBeTruthy();
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith([PRIVATE_VIDEO_URI], expect.any(Function)),
    );
  });

  it.each([
    { intent: 'Share', button: 'Share media', nativeMock: share },
    { intent: 'Save', button: 'Save media', nativeMock: save },
  ])(
    'cancels pending $intent continuation as soon as a page drag begins',
    async ({ button, nativeMock }) => {
      const remote = { ...ATT, localPath: null };
      const downloaded = { ...remote, localPath: 'file:///docs/drag-finished-att-1.jpg' };
      let authoritative: typeof remote | typeof downloaded = remote;
      getAtt.mockImplementation(() => Promise.resolve(authoritative));
      listGallery.mockResolvedValue({ items: [remote, SECOND_ATT], index: 0 });
      downloadMedia.mockImplementation((att: typeof remote) => {
        useDownloadStore.getState().start(att.guid);
        return Promise.resolve(null);
      });
      const view = await renderWithTheme(<MediaViewer />);
      await screen.findByRole('button', { name: 'Download media' });

      await fireEvent.press(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
      await beginPageDrag(view);
      expect(screen.getByRole('progressbar', { name: 'Downloading media' })).toBeTruthy();

      authoritative = downloaded;
      await act(async () => {
        useDownloadStore.getState().finish(remote.guid);
        await flush();
        await flush();
      });

      expect(await screen.findByTestId(`img:${downloaded.localPath}`)).toBeTruthy();
      expect(nativeMock).not.toHaveBeenCalled();
      expect(downloadMedia).toHaveBeenCalledTimes(1);
    },
  );

  it('offers Retry when a manual download is refused without ever starting', async () => {
    const remote = { ...ATT, localPath: null };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    // e.g. RCS media from a previous Google pairing: download() resolves null and never touches
    // the download store, which used to leave "Downloading media…" up with no way out.
    downloadMedia.mockResolvedValue(null);
    await renderWithTheme(<MediaViewer />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Download media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole('button', { name: 'Retry media download' })).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Downloading media' })).toBeNull();
  });

  it('keeps the reason a manual download was refused for, so the chat can say why', async () => {
    const remote = { ...ATT, localPath: null };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    // The downloader publishes its own failure, with a reason the owner can act on, then resolves
    // null. The viewer must not overwrite that published end state with a reasonless failure.
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().fail(att.guid, 'too-large');
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Download media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole('button', { name: 'Retry media download' })).toBeTruthy();
    expect(useDownloadStore.getState().failure[remote.guid]).toBe('too-large');
  });

  it('deduplicates Download taps and exposes an exact Retry after failure', async () => {
    const remote = { ...ATT, localPath: null };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);
    const button = await screen.findByRole('button', { name: 'Download media' });
    const retainedDownload = retainConfiguredPress(button);

    await fireEvent.press(button);
    retainedDownload();
    await flush();
    expect(downloadMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      useDownloadStore.getState().fail(remote.guid);
      await flush();
    });
    const retry = screen.getByRole('button', { name: 'Retry media download' });
    const retainedRetry = retainConfiguredPress(retry);
    await fireEvent.press(retry);
    retainedRetry();
    await flush();
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(2));
  });

  it('joins an externally started transfer before a retained Share callback can restart it', async () => {
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/external-flight-att-1.jpg' };
    let authoritative: typeof remote | typeof downloaded = remote;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    share.mockResolvedValue({ ok: true });
    await renderWithTheme(<MediaViewer />);
    const shareButton = await screen.findByRole('button', { name: 'Share media' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    const sharePress = retainConfiguredPress(shareButton);

    await act(async () => {
      useDownloadStore.getState().start(remote.guid);
      sharePress();
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('progressbar', { name: 'Downloading media to share' })).toBeTruthy();
    authoritative = downloaded;
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
      await flush();
    });

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        downloaded.localPath,
        downloaded.mimeType,
        expect.any(Function),
      ),
    );
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('authoritatively adopts an unobserved idle-success marker before starting a transfer', async () => {
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/unobserved-finish-att-1.jpg' };
    let authoritative: typeof remote | typeof downloaded = remote;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    share.mockResolvedValue({ ok: true });
    await renderWithTheme(<MediaViewer />);
    const shareButton = await screen.findByRole('button', { name: 'Share media' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    const sharePress = retainConfiguredPress(shareButton);

    authoritative = downloaded;
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      sharePress();
      await flush();
      await flush();
    });

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        downloaded.localPath,
        downloaded.mimeType,
        expect.any(Function),
      ),
    );
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('starts a real download on the first tap when a finished marker outlived its file', async () => {
    // A past transfer finished, then its file was removed (cache eviction or Repair Downloads).
    // Its presentation marker remains, but the authoritative row has no local file.
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/refetched-att-1.jpg' };
    let authoritative: typeof remote | typeof downloaded = remote;
    getAtt.mockImplementation(() => Promise.resolve(authoritative));
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await act(async () => useDownloadStore.getState().finish(remote.guid));
    await renderWithTheme(<MediaViewer />);

    await fireEvent.press(await screen.findByRole('button', { name: 'Download media' }));

    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    expect(downloadMedia).toHaveBeenCalledWith(remote, 'manual', expect.anything());
    expect(useDownloadStore.getState().status[remote.guid]).toBe('downloading');

    // The transfer it started is adopted like any other, without a second download.
    authoritative = downloaded;
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
    });
    expect(await screen.findByTestId(`img:${downloaded.localPath}`)).toBeTruthy();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a newer start-and-finish cycle when an older reread is stale', async () => {
    const remote = { ...ATT, localPath: null };
    const staleDownloaded = { ...remote, localPath: 'file:///docs/stale-external-att-1.jpg' };
    const downloaded = { ...remote, localPath: 'file:///docs/newer-external-att-1.jpg' };
    const staleRead = deferred<typeof staleDownloaded>();
    let readMode: 'initial' | 'stale' | 'current' = 'initial';
    getAtt.mockImplementation(() => {
      if (readMode === 'stale') return staleRead.promise;
      return Promise.resolve(readMode === 'current' ? downloaded : remote);
    });
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    share.mockResolvedValue({ ok: true });
    await renderWithTheme(<MediaViewer />);
    const shareButton = await screen.findByRole('button', { name: 'Share media' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    const sharePress = retainConfiguredPress(shareButton);

    readMode = 'stale';
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      sharePress();
    });
    await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(3));

    readMode = 'current';
    await act(async () => {
      useDownloadStore.getState().start(remote.guid);
      useDownloadStore.getState().finish(remote.guid);
      staleRead.resolve(staleDownloaded);
      await staleRead.promise;
      await flush();
      await flush();
    });

    expect(useDownloadStore.getState().status[remote.guid]).toBe('idle');
    expect(useDownloadStore.getState().progress[remote.guid]).toBe(1);
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(
        downloaded.localPath,
        downloaded.mimeType,
        expect.any(Function),
      ),
    );
    expect(downloadMedia).not.toHaveBeenCalled();
  });

  it('still fails the target when only an unrelated download changes during its stale reread', async () => {
    const remote = { ...ATT, localPath: null };
    const staleRead = deferred<typeof remote>();
    getAtt
      .mockReset()
      .mockResolvedValueOnce(remote)
      .mockResolvedValueOnce(remote)
      .mockReturnValueOnce(staleRead.promise);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    await renderWithTheme(<MediaViewer />);
    const shareButton = await screen.findByRole('button', { name: 'Share media' });
    await act(async () => useDownloadStore.getState().finish(remote.guid));
    await fireEvent.press(shareButton);
    await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(3));

    await act(async () => {
      useDownloadStore.getState().start('unrelated-guid');
      useDownloadStore.getState().finish('unrelated-guid');
      staleRead.resolve(remote);
      await staleRead.promise;
      await flush();
    });

    // The re-read still counts: the row has no file, so the viewer tried a real download, and the
    // mocked front door refused it without touching the store.
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(downloadMedia).toHaveBeenCalledWith(remote, 'manual', expect.anything());
    expect(useDownloadStore.getState().status[remote.guid]).toBe('error');
  });

  it('adopts a download completed offscreen without redownloading or resuming canceled Share', async () => {
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/stale-page-att-1.jpg' };
    const returnToA = deferred<typeof downloaded>();
    let useReturnRead = false;
    listGallery.mockResolvedValue({ items: [remote, SECOND_ATT], index: 0 });
    getAtt.mockImplementation((_db, attachmentGuid) => {
      if (attachmentGuid === SECOND_ATT.guid) return Promise.resolve(SECOND_ATT);
      return useReturnRead ? returnToA.promise : Promise.resolve(remote);
    });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    const view = await renderWithTheme(<MediaViewer />);
    await screen.findByRole('button', { name: 'Download media' });

    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    await scrollToPage(view, 1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
    });
    expect(share).not.toHaveBeenCalled();

    useReturnRead = true;
    await scrollToPage(view, 0);
    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeDisabled();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(share).not.toHaveBeenCalled();

    await act(async () => {
      returnToA.resolve(downloaded);
      await returnToA.promise;
    });

    expect(await screen.findByTestId(`img:${downloaded.localPath}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Download media' })).toBeNull();
    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(share).not.toHaveBeenCalled();
  });

  it('adopts an offscreen local-path removal before rendering or acting on the stale file', async () => {
    const cleared = { ...ATT, localPath: null };
    const returnToA = deferred<typeof cleared>();
    let useReturnRead = false;
    listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
    getAtt.mockImplementation((_db, attachmentGuid) => {
      if (attachmentGuid === SECOND_ATT.guid) return Promise.resolve(SECOND_ATT);
      return useReturnRead ? returnToA.promise : Promise.resolve(ATT);
    });
    downloadMedia.mockImplementation((att: typeof cleared) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    const view = await renderViewer();

    await scrollToPage(view, 1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
    useReturnRead = true;
    await scrollToPage(view, 0);

    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();
    expect(screen.queryByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save media' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();

    await act(async () => {
      returnToA.resolve(cleared);
      await returnToA.promise;
    });

    expect(await screen.findByRole('button', { name: 'Download media' })).toBeTruthy();
    expect(screen.getAllByTestId('img:none').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
    expect(downloadMedia).toHaveBeenCalledWith(cleared, 'manual', expect.any(Object));
    expect(share).not.toHaveBeenCalled();
  });

  it('shows the checking spinner only once a page check is slow', async () => {
    // A page check is one indexed read; showing the spinner at once flashed it on every swipe.
    const secondRead = deferred<typeof SECOND_ATT>();
    listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
    getAtt.mockImplementation((_db, attachmentGuid) =>
      attachmentGuid === SECOND_ATT.guid ? secondRead.promise : Promise.resolve(ATT),
    );
    const view = await renderViewer();

    await scrollToPage(view, 1);
    expect(screen.queryByRole('progressbar', { name: 'Checking current media' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();

    await act(async () => {
      secondRead.resolve(SECOND_ATT);
      await secondRead.promise;
    });
    await waitFor(() =>
      expect(screen.queryByRole('progressbar', { name: 'Checking current media' })).toBeNull(),
    );
    expect(await screen.findByTestId(`img:${PRIVATE_SECOND_IMAGE_URI}`)).toBeTruthy();
  });

  it('fails a page refresh closed and retries it with a fresh page lifetime', async () => {
    const firstRead = deferred<typeof SECOND_ATT>();
    let retrying = false;
    listGallery.mockResolvedValue({ items: [ATT, SECOND_ATT], index: 0 });
    getAtt.mockImplementation((_db, attachmentGuid) => {
      if (attachmentGuid === ATT.guid) return Promise.resolve(ATT);
      return retrying ? Promise.resolve(SECOND_ATT) : firstRead.promise;
    });
    const view = await renderViewer();

    await scrollToPage(view, 1);
    expect(await screen.findByRole('progressbar', { name: 'Checking current media' })).toBeTruthy();
    expectRenderedMediaToOmit(PRIVATE_SECOND_IMAGE_URI, PRIVATE_SECOND_BLURHASH);
    await act(async () => {
      firstRead.reject(new Error('current-page-refresh-error-47cc'));
      await firstRead.promise.catch(() => undefined);
    });

    expect(await screen.findByRole('button', { name: 'Retry media refresh' })).toBeTruthy();
    expect(screen.queryByTestId(`img:${PRIVATE_SECOND_IMAGE_URI}`)).toBeNull();
    expectRenderedMediaToOmit(PRIVATE_SECOND_BLURHASH);
    expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[media] could not refresh current attachment',
      expect.any(Error),
    );

    retrying = true;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry media refresh' }));
    expect(await screen.findByTestId(`img:${PRIVATE_SECOND_IMAGE_URI}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled());
  });

  it('does not continue a remote Save after Close revokes the viewer', async () => {
    const remote = { ...ATT, localPath: null };
    const downloaded = { ...remote, localPath: 'file:///docs/stale-closed-att-1.jpg' };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    downloadMedia.mockImplementation((att: typeof remote) => {
      useDownloadStore.getState().start(att.guid);
      return Promise.resolve(null);
    });
    await renderWithTheme(<MediaViewer />);
    await screen.findByRole('button', { name: 'Download media' });

    await fireEvent.press(screen.getByRole('button', { name: 'Save media' }));
    await waitFor(() => expect(downloadMedia).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'Close media viewer' }));
    getAtt.mockResolvedValue(downloaded);
    await act(async () => {
      useDownloadStore.getState().finish(remote.guid);
      await flush();
    });
    await flush();

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(getAtt).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('MediaViewer cache-reader protection', () => {
  it.each(['image', 'video'] as const)(
    'does not construct a native $type for an https path passed through by the protection hook',
    async (type) => {
      const remoteUri = `https://media.example.test/private-${type}-54da`;
      const remote = {
        ...ATT,
        mimeType: type === 'video' ? 'video/mp4' : 'image/jpeg',
        localPath: remoteUri,
      };
      getAtt.mockResolvedValue(remote);
      listGallery.mockResolvedValue({ items: [remote], index: 0 });

      await renderWithTheme(<MediaViewer />);
      await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(2));
      expect(getAtt).toHaveBeenCalledWith(undefined, 'att-1');
      if (type === 'image') {
        expect(await screen.findByTestId('img:none')).toBeTruthy();
      } else {
        await act(async () => flush());
        expect(screen.queryByTestId('video-view')).toBeNull();
      }
      expect(mockProtectPath).not.toHaveBeenCalled();
      expect(mockUseVideoPlayer).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Share media' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Save media' })).toBeEnabled();
      await fireEvent.press(screen.getByRole('button', { name: 'Share media' }));
      expect(downloadMedia).toHaveBeenCalledWith(
        { ...remote, localPath: null },
        'manual',
        expect.any(Object),
      );
      expect(share).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('does not pin an adjacent carousel path until its exact page passes preflight', async () => {
    const second = {
      ...ATT,
      id: 2,
      guid: 'att-2',
      transferName: 'b.jpg',
      localPath: 'file:///docs/b.jpg',
    };
    listGallery.mockResolvedValue({ items: [ATT, second], index: 0 });
    getAtt.mockImplementation((_db, attachmentGuid) =>
      Promise.resolve(attachmentGuid === second.guid ? second : ATT),
    );
    mockProtectPath.mockImplementation((path) =>
      path.endsWith('/b.jpg') ? null : { path, release: mockReleaseProtection },
    );

    const view = await renderWithTheme(<MediaViewer />);
    await waitFor(() => expect(mockProtectPath).toHaveBeenCalledWith(PRIVATE_IMAGE_URI));
    expect(mockProtectPath).not.toHaveBeenCalledWith('file:///docs/b.jpg');
    expect(screen.getByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy();
    expectRenderedMediaToOmit('file:///docs/b.jpg');

    await scrollToPage(view, 1);
    await waitFor(() => expect(mockProtectPath).toHaveBeenCalledWith('file:///docs/b.jpg'));
    expect(screen.queryByTestId('img:file:///docs/b.jpg')).toBeNull();
    expect(screen.getAllByTestId('img:none').length).toBeGreaterThan(0);
  });

  it('does not construct a native video player when its path cannot be pinned', async () => {
    const video = { ...ATT, mimeType: 'video/mp4', localPath: PRIVATE_VIDEO_URI };
    getAtt.mockResolvedValue(video);
    mockProtectPath.mockReturnValueOnce(null);

    await renderWithTheme(<MediaViewer />);
    await waitFor(() => expect(mockProtectPath).toHaveBeenCalledWith(PRIVATE_VIDEO_URI));
    expect(screen.queryByTestId('video-view')).toBeNull();
  });
});
