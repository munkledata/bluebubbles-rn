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
const mockLoggerWarn = jest.fn();
let mockRouteGuid = 'att-1';

jest.mock('@core/secure', () => ({ logger: { warn: mockLoggerWarn } }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: mockRouteGuid }),
  useRouter: () => ({ back: mockBack, push: jest.fn(), replace: jest.fn() }),
  usePathname: () => `/media/${mockRouteGuid}`,
}));

jest.mock('expo-video', () => {
  const useVideoPlayer = jest.fn(() => ({ loop: false, play: jest.fn(), pause: jest.fn() }));
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
  getAttachmentByGuid: jest.fn(),
  listChatImageAttachmentsByAttachmentGuid: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));

// eslint-disable-next-line import/first
import { getAttachmentByGuid, listChatImageAttachmentsByAttachmentGuid } from '@db/repositories';
// eslint-disable-next-line import/first
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
// eslint-disable-next-line import/first
import MediaViewer from '../../../app/(app)/media/[guid]';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const getAtt = getAttachmentByGuid as jest.Mock;
const listGallery = listChatImageAttachmentsByAttachmentGuid as jest.Mock;
const share = shareAttachment as jest.Mock;
const save = saveAttachmentsToPhotos as jest.Mock;
const mockUseVideoPlayer = (jest.requireMock('expo-video') as { useVideoPlayer: jest.Mock })
  .useVideoPlayer;
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

interface MediaListProbe {
  props: {
    data: unknown[];
    initialScrollIndex: number;
    scrollEnabled: boolean;
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

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockRouteGuid = 'att-1';
  useToastStore.setState({ current: null, queue: [] });
  useDialogStore.setState({ current: null, queue: [] });
  getAtt.mockReset().mockResolvedValue(ATT);
  listGallery.mockReset().mockResolvedValue({ items: [ATT], index: 0 });
  share.mockReset();
  save.mockReset();
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
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
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
        name: `media ${PRIVATE_SECOND_IMAGE_URI} ${PRIVATE_SECOND_BLURHASH}`,
      }),
    ).toBeTruthy();
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
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
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

    fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
    expect(save).toHaveBeenCalledWith([PRIVATE_IMAGE_URI], expect.any(Function));
  });

  it('explains a refused Photos permission instead of failing silently', async () => {
    save.mockResolvedValue({ status: 'denied' });
    await renderViewer();

    fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Save'));
    expect(useDialogStore.getState().current?.message).toMatch(/permission/i);
    expect(useToastStore.getState().current).toBeNull();
  });

  it('reports a failed save', async () => {
    save.mockResolvedValue({ status: 'error' });
    await renderViewer();

    fireEvent.press(pills()[1]!);

    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toMatch(/couldn’t save/i),
    );
  });
});

describe('MediaViewer share button', () => {
  it('says nothing when the share sheet opened — the sheet IS the feedback', async () => {
    share.mockResolvedValue({ ok: true });
    await renderViewer();

    fireEvent.press(pills()[0]!);

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

    fireEvent.press(pills()[0]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Share'));
    expect(useDialogStore.getState().current?.message).toMatch(/App Logs/);
  });

  it('distinguishes "sharing unavailable on this device"', async () => {
    share.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await renderViewer();

    fireEvent.press(pills()[0]!);

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

  /**
   * Let a pending handler run to completion. NOT `act()` — the handlers under test touch refs and
   * the toast/dialog stores, never component state, and a bare `act(async () => {})` between
   * RNTL's own act-wrapped calls trips React 19's overlapping-act detection, which silently
   * corrupts every LATER test in the file (they fail to render at all).
   */
  it('ignores a second share tap while the first is still in flight', async () => {
    const d = deferred<{ ok: true }>();
    share.mockReturnValue(d.promise);
    await renderViewer();

    fireEvent.press(pills()[0]!);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    fireEvent.press(pills()[0]!);
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

    fireEvent.press(pills()[1]!);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.press(pills()[1]!);
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

    fireEvent.press(pills()[0]!);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
    d.settle({ ok: true });
    await flush();
  });
});

describe('MediaViewer gating', () => {
  // The pills are disabled for an undownloaded photo, so no helper may be called at all. This is
  // the branch that must NOT start reporting outcomes — there is nothing to act on.
  it('does nothing when the photo has no local file', async () => {
    const remote = { ...ATT, localPath: null };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    await renderWithTheme(<MediaViewer />);
    await waitFor(() => expect(screen.getByTestId('img:none')).toBeTruthy());

    fireEvent.press(pills()[0]!);
    fireEvent.press(pills()[1]!);

    expect(share).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();
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
      await waitFor(() => expect(getAtt).toHaveBeenCalledTimes(1));
      expect(getAtt).toHaveBeenCalledWith(undefined, 'att-1');
      if (type === 'image') {
        expect(await screen.findByTestId('img:none')).toBeTruthy();
      } else {
        await act(async () => flush());
        expect(screen.queryByTestId('video-view')).toBeNull();
      }
      expect(mockProtectPath).not.toHaveBeenCalled();
      expect(mockUseVideoPlayer).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Share media' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save media' })).toBeDisabled();
      expect(share).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('pins each mounted carousel cell independently and withholds a refused adjacent path', async () => {
    const second = {
      ...ATT,
      id: 2,
      guid: 'att-2',
      transferName: 'b.jpg',
      localPath: 'file:///docs/b.jpg',
    };
    listGallery.mockResolvedValue({ items: [ATT, second], index: 0 });
    mockProtectPath.mockImplementation((path) =>
      path.endsWith('/b.jpg') ? null : { path, release: mockReleaseProtection },
    );

    await renderWithTheme(<MediaViewer />);
    await waitFor(() => {
      expect(mockProtectPath).toHaveBeenCalledWith(PRIVATE_IMAGE_URI);
      expect(mockProtectPath).toHaveBeenCalledWith('file:///docs/b.jpg');
    });
    expect(screen.getByTestId(`img:${PRIVATE_IMAGE_URI}`)).toBeTruthy();
    expect(screen.queryByTestId('img:file:///docs/b.jpg')).toBeNull();
    expect(screen.getByTestId('img:none')).toBeTruthy();
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
