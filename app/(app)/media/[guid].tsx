import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  getAttachmentByGuid,
  listChatImageAttachmentsByAttachmentGuid,
  type AttachmentRow,
} from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { ZoomableImage } from '@ui/attachments/ZoomableImage';
import { useAttachmentCachePathProtection } from '@ui/attachments/useAttachmentCachePathProtection';
import { showDialog } from '@ui/dialog/dialogStore';
import { showToast } from '@ui/toast/toastStore';
import { isLocalFileUri } from '@utils';

type AccountTaskResult<T> = { owned: true; value: T } | { owned: false };

interface MediaGallery {
  items: AttachmentRow[];
  index: number;
}

interface LoadedMedia {
  routeGuid: string;
  routeLifetime: number;
  attachment: AttachmentRow | null;
  gallery: MediaGallery | null;
  pageIndex: number;
  pageLifetime: number;
}

interface MediaSourceGrant {
  routeGuid: string;
  routeLifetime: number;
  pageLifetime: number;
  attachmentGuid: string;
  localPath: string | null;
  mimeType: string | null;
}

interface MediaActionOperation {
  token: symbol;
  source: MediaSourceGrant;
}

/** Keep a media read/native action attached to the account that mounted this route. */
async function runMediaAccountTask<T>(
  lease: RealtimeDeliveryLease,
  task: () => Promise<T>,
): Promise<AccountTaskResult<T>> {
  let value: T | undefined;
  let completed = false;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent()) return;
      value = await task();
      if (!activeLease.isCurrent()) return;
      completed = true;
    });
    if (status === 'paused' || !completed || !lease.isCurrent()) return { owned: false };
    return { owned: true, value: value as T };
  } catch (error) {
    // Disconnect owns failures from account-A work after its lease is retired. Surfacing them in
    // account B would be both confusing and an account-existence leak.
    if (!lease.isCurrent()) return { owned: false };
    throw error;
  }
}

/**
 * Fullscreen media viewer. Images open in a swipe-carousel across EVERY photo in the chat (with an
 * "N of M" counter), each pinch-to-zoomable; a video opens singly with native controls. Share +
 * save-to-Photos act on the currently-visible item.
 */
export default function MediaViewer(): React.JSX.Element {
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const win = Dimensions.get('window');
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const mountAliveRef = useRef(true);
  const accountRetiredRef = useRef(!accountLease.isCurrent());
  const [accountRetired, setAccountRetired] = useState(accountRetiredRef.current);
  const routeLifetimeRef = useRef(0);
  const pageLifetimeRef = useRef(0);
  const [renderRouteLifetime, setRenderRouteLifetime] = useState(0);
  const activeRouteGuidRef = useRef(guid);
  const activeLoadedRef = useRef<LoadedMedia | null>(null);
  const [loaded, setLoaded] = useState<LoadedMedia | null>(null);
  const [pagingEnabled, setPagingEnabled] = useState(true);
  const sharing = useRef<MediaActionOperation | null>(null);
  const saving = useRef<MediaActionOperation | null>(null);

  const routeTransitionPending = activeRouteGuidRef.current !== guid;

  const routeGrantIsCurrent = useCallback(
    (routeGuid: string, routeLifetime: number): boolean =>
      mountAliveRef.current &&
      !accountRetiredRef.current &&
      accountLease.isCurrent() &&
      activeRouteGuidRef.current === routeGuid &&
      routeLifetimeRef.current === routeLifetime,
    [accountLease],
  );

  const clearLoadedMedia = useCallback((): void => {
    activeLoadedRef.current = null;
    setLoaded(null);
    setPagingEnabled(true);
  }, []);

  const revokeRouteLifetime = useCallback((): number => {
    const nextRouteLifetime = routeLifetimeRef.current + 1;
    routeLifetimeRef.current = nextRouteLifetime;
    pageLifetimeRef.current += 1;
    setRenderRouteLifetime(nextRouteLifetime);
    clearLoadedMedia();
    return nextRouteLifetime;
  }, [clearLoadedMedia]);

  // A recycled route must not render the previous GUID for even one committed frame. The render
  // above already sees routeTransitionPending; this layout commit gives the replacement route a
  // fresh ownership lifetime before it can load or publish anything.
  useLayoutEffect(() => {
    if (!routeTransitionPending) return;
    activeRouteGuidRef.current = guid;
    revokeRouteLifetime();
  }, [guid, revokeRouteLifetime, routeTransitionPending]);

  // Account retirement is monotonic for the lease captured by this mounted route. Force the
  // resolved tree to unmount immediately so image/video reader pins release without an unrelated
  // render, and keep every retained callback/result tied to the retired lifetime.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        accountRetiredRef.current = true;
        revokeRouteLifetime();
        setAccountRetired(true);
      }),
    [accountLease, revokeRouteLifetime],
  );

  // Hardware Back and parent navigation can unmount without using this screen's Close button.
  // Revoke synchronously so manually retained Pressability callbacks and global result publication
  // cannot outlive the route.
  useLayoutEffect(
    () => () => {
      mountAliveRef.current = false;
      routeLifetimeRef.current += 1;
      pageLifetimeRef.current += 1;
      activeLoadedRef.current = null;
    },
    [],
  );

  const visibleLoaded =
    !routeTransitionPending &&
    !accountRetired &&
    loaded?.routeGuid === guid &&
    loaded.routeLifetime === renderRouteLifetime &&
    routeGrantIsCurrent(loaded.routeGuid, loaded.routeLifetime)
      ? loaded
      : null;
  const visibleAtt = visibleLoaded?.attachment ?? null;
  const visibleGallery = visibleLoaded?.gallery ?? null;
  const pageIndex = visibleLoaded?.pageIndex ?? 0;
  const isVideo = (visibleAtt?.mimeType ?? '').startsWith('video');

  useEffect(() => {
    const loadRouteGuid = guid;
    const loadRouteLifetime = renderRouteLifetime;
    if (
      accountRetired ||
      routeTransitionPending ||
      !routeGrantIsCurrent(loadRouteGuid, loadRouteLifetime)
    ) {
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const result = await runMediaAccountTask(accountLease, async () => {
          const db = getDatabase();
          const attachment = await getAttachmentByGuid(db, loadRouteGuid);
          if (!attachment || (attachment.mimeType ?? '').startsWith('video')) {
            return { attachment, galleryResult: null };
          }
          const siblings = await listChatImageAttachmentsByAttachmentGuid(db, loadRouteGuid);
          // Fall back to a one-item gallery if the tapped image isn't in the set (shouldn't happen).
          const items = siblings.items.length > 0 ? siblings.items : [attachment];
          const index = siblings.index >= 0 ? siblings.index : 0;
          return { attachment, galleryResult: { items, index } };
        });
        if (!alive || !result.owned || !routeGrantIsCurrent(loadRouteGuid, loadRouteLifetime)) {
          return;
        }
        const galleryResult = result.value.galleryResult;
        const maxIndex = Math.max(0, (galleryResult?.items.length ?? 1) - 1);
        const initialIndex = galleryResult
          ? Math.min(Math.max(galleryResult.index, 0), maxIndex)
          : 0;
        const nextPageLifetime = pageLifetimeRef.current + 1;
        pageLifetimeRef.current = nextPageLifetime;
        const normalizedGallery = galleryResult ? { ...galleryResult, index: initialIndex } : null;
        const nextLoaded: LoadedMedia = {
          routeGuid: loadRouteGuid,
          routeLifetime: loadRouteLifetime,
          attachment: result.value.attachment,
          gallery: normalizedGallery,
          pageIndex: initialIndex,
          pageLifetime: nextPageLifetime,
        };
        activeLoadedRef.current = nextLoaded;
        setLoaded(nextLoaded);
        setPagingEnabled(true);
      } catch (error) {
        if (alive && routeGrantIsCurrent(loadRouteGuid, loadRouteLifetime)) {
          logger.warn('[media] could not load attachment viewer', error);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    accountLease,
    accountRetired,
    guid,
    renderRouteLifetime,
    routeGrantIsCurrent,
    routeTransitionPending,
  ]);

  // The item the action bar (share/save) + counter refer to = the visible page (else the tapped att).
  // Never fall back from an invalid gallery index to the tapped attachment: that would make the
  // action bar operate on media that is not actually visible.
  const current = visibleGallery ? (visibleGallery.items[pageIndex] ?? null) : visibleAtt;
  const currentSource: MediaSourceGrant | null =
    visibleLoaded && current
      ? {
          routeGuid: visibleLoaded.routeGuid,
          routeLifetime: visibleLoaded.routeLifetime,
          pageLifetime: visibleLoaded.pageLifetime,
          attachmentGuid: current.guid,
          localPath: current.localPath,
          mimeType: current.mimeType ?? null,
        }
      : null;
  const local = isLocalFileUri(currentSource?.localPath);

  const sourceGrantIsCurrent = useCallback(
    (source: MediaSourceGrant): boolean => {
      if (!routeGrantIsCurrent(source.routeGuid, source.routeLifetime)) return false;
      const active = activeLoadedRef.current;
      if (
        !active ||
        active.routeGuid !== source.routeGuid ||
        active.routeLifetime !== source.routeLifetime ||
        active.pageLifetime !== source.pageLifetime ||
        pageLifetimeRef.current !== source.pageLifetime
      ) {
        return false;
      }
      const activeAttachment = active.gallery
        ? (active.gallery.items[active.pageIndex] ?? null)
        : active.attachment;
      return (
        activeAttachment?.guid === source.attachmentGuid &&
        activeAttachment.localPath === source.localPath &&
        (activeAttachment.mimeType ?? null) === source.mimeType
      );
    },
    [routeGrantIsCurrent],
  );

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const active = activeLoadedRef.current;
      if (
        !visibleLoaded ||
        !visibleGallery ||
        !active ||
        active.routeGuid !== visibleLoaded.routeGuid ||
        active.routeLifetime !== visibleLoaded.routeLifetime ||
        active.pageLifetime !== visibleLoaded.pageLifetime ||
        !routeGrantIsCurrent(visibleLoaded.routeGuid, visibleLoaded.routeLifetime)
      ) {
        return;
      }
      const maxIndex = Math.max(0, visibleGallery.items.length - 1);
      const rawIndex = Math.round(e.nativeEvent.contentOffset.x / win.width);
      const nextIndex = Math.min(Math.max(rawIndex, 0), maxIndex);
      if (nextIndex === active.pageIndex) return;
      const nextPageLifetime = pageLifetimeRef.current + 1;
      pageLifetimeRef.current = nextPageLifetime;
      const nextLoaded: LoadedMedia = {
        ...active,
        pageIndex: nextIndex,
        pageLifetime: nextPageLifetime,
      };
      activeLoadedRef.current = nextLoaded;
      setLoaded(nextLoaded);
      setPagingEnabled(true);
    },
    [routeGrantIsCurrent, visibleGallery, visibleLoaded, win.width],
  );

  // Both actions REPORT their outcome. They used to `await` the helper and discard its answer,
  // which made a successful save pixel-identical to a dead button (and hid every failure), so the
  // pills read as broken even when they worked. A toast for the happy path (non-blocking, and the
  // host is `pointerEvents:'none'` so it can't eat a swipe), a dialog when there is something the
  // user has to act on.
  //
  // The in-flight guards matter BECAUSE of that reporting: a user whose buttons appear dead taps
  // twice, and expo-sharing throws "sharing already in progress" on a concurrent call — which
  // would now raise a "couldn't open the share sheet" dialog (and upload an error report) for a
  // sheet that opened perfectly on the first tap. Per-action refs, not one shared flag, so a share
  // that never settles can't also disable saving.
  const onShare = async (): Promise<void> => {
    const source = currentSource;
    if (
      !source ||
      !source.localPath ||
      !local ||
      sharing.current ||
      !sourceGrantIsCurrent(source)
    ) {
      return;
    }
    const operation: MediaActionOperation = { token: Symbol('media-share'), source };
    sharing.current = operation;
    const localPath = source.localPath;
    const operationIsCurrent = (): boolean =>
      sharing.current?.token === operation.token && sourceGrantIsCurrent(operation.source);
    try {
      const result = await runMediaAccountTask(accountLease, () =>
        shareAttachment(localPath, source.mimeType),
      );
      if (!result.owned || !operationIsCurrent() || result.value.ok) {
        return;
      }
      showDialog(
        'Share',
        result.value.reason === 'unavailable'
          ? 'Sharing isn’t available on this device.'
          : 'Couldn’t open the share sheet for this photo. The details are in Settings → App Logs.',
      );
    } catch {
      if (operationIsCurrent()) {
        showDialog(
          'Share',
          'Couldn’t open the share sheet for this photo. The details are in Settings → App Logs.',
        );
      }
    } finally {
      if (sharing.current?.token === operation.token) sharing.current = null;
    }
  };

  const onSave = async (): Promise<void> => {
    const source = currentSource;
    if (!source || !source.localPath || !local || saving.current || !sourceGrantIsCurrent(source)) {
      return;
    }
    const operation: MediaActionOperation = { token: Symbol('media-save'), source };
    saving.current = operation;
    const localPath = source.localPath;
    const operationIsCurrent = (): boolean =>
      saving.current?.token === operation.token && sourceGrantIsCurrent(operation.source);
    try {
      const result = await runMediaAccountTask(accountLease, () =>
        saveAttachmentsToPhotos([localPath]),
      );
      if (!result.owned || !operationIsCurrent()) return;
      if (result.value.status === 'saved') showToast('Saved to Photos');
      else if (result.value.status === 'denied')
        showDialog('Save', 'Photos permission is required to save attachments.');
      else showToast('Couldn’t save this photo');
    } catch {
      if (operationIsCurrent()) showToast('Couldn’t save this photo');
    } finally {
      if (saving.current?.token === operation.token) saving.current = null;
    }
  };

  const revokeViewerBeforeClose = (): void => {
    if (!mountAliveRef.current) return;
    mountAliveRef.current = false;
    routeLifetimeRef.current += 1;
    pageLifetimeRef.current += 1;
    activeLoadedRef.current = null;
    router.back();
  };

  const closeButton = (
    <Pressable
      onPress={revokeViewerBeforeClose}
      hitSlop={12}
      style={styles.pill}
      accessibilityRole="button"
      accessibilityLabel="Close media viewer"
    >
      <Text style={styles.glyph}>✕</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      {visibleAtt && isVideo ? (
        visibleAtt.localPath ? (
          <ProtectedFullscreenVideo uri={visibleAtt.localPath} />
        ) : null
      ) : visibleGallery ? (
        <FlatList
          key={`media-gallery:${visibleLoaded?.routeGuid ?? ''}:${visibleLoaded?.routeLifetime ?? -1}`}
          data={visibleGallery.items}
          keyExtractor={(a) => a.guid}
          horizontal
          pagingEnabled
          scrollEnabled={pagingEnabled}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={pageIndex}
          getItemLayout={(_d, i) => ({ length: win.width, offset: win.width * i, index: i })}
          onMomentumScrollEnd={onScrollEnd}
          renderItem={({ item, index }) => (
            <ProtectedZoomableImage
              uri={item.localPath}
              blurhash={item.blurhash}
              width={win.width}
              height={win.height}
              active={index === pageIndex}
              // Zoomed → disable paging so a one-finger drag pans the photo instead of changing it.
              onZoomChange={(zoomed) => {
                const active = activeLoadedRef.current;
                if (
                  !visibleLoaded ||
                  !active ||
                  active.routeGuid !== visibleLoaded.routeGuid ||
                  active.routeLifetime !== visibleLoaded.routeLifetime ||
                  active.pageLifetime !== visibleLoaded.pageLifetime ||
                  active.pageIndex !== index ||
                  active.gallery?.items[index]?.guid !== item.guid ||
                  !routeGrantIsCurrent(visibleLoaded.routeGuid, visibleLoaded.routeLifetime)
                ) {
                  return;
                }
                setPagingEnabled(!zoomed);
              }}
            />
          )}
        />
      ) : null}

      <View style={[styles.bar, { top: insets.top + 6 }]} pointerEvents="box-none">
        {closeButton}
        {/* "N of M" while paging through more than one photo. */}
        {visibleGallery && visibleGallery.items.length > 1 ? (
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>
              {pageIndex + 1} of {visibleGallery.items.length}
            </Text>
          </View>
        ) : null}
        <View style={styles.actions} pointerEvents="box-none">
          <Pressable
            onPress={() => void onShare()}
            disabled={!local}
            hitSlop={12}
            style={[styles.pill, !local && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Share media"
          >
            <Text style={styles.glyph}>⤴</Text>
          </Pressable>
          <Pressable
            onPress={() => void onSave()}
            disabled={!local}
            hitSlop={12}
            style={[styles.pill, !local && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Save media"
          >
            <Text style={styles.glyph}>⤓</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** FlatList mounts adjacent carousel pages too; every mounted native image owns a distinct pin. */
function ProtectedZoomableImage({
  uri,
  blurhash,
  width,
  height,
  active,
  onZoomChange,
}: {
  uri: string | null;
  blurhash: string | null;
  width: number;
  height: number;
  active: boolean;
  onZoomChange: (zoomed: boolean) => void;
}): React.JSX.Element {
  const protectedUri = useAttachmentCachePathProtection(uri);
  return (
    <ZoomableImage
      uri={isLocalFileUri(protectedUri) ? protectedUri : null}
      blurhash={blurhash}
      width={width}
      height={height}
      active={active}
      onZoomChange={onZoomChange}
    />
  );
}

/** Do not construct expo-video's native player until the cache path has a live reader pin. */
function ProtectedFullscreenVideo({ uri }: { uri: string }): React.JSX.Element | null {
  const protectedUri = useAttachmentCachePathProtection(uri);
  return isLocalFileUri(protectedUri) ? <FullscreenVideo uri={protectedUri} /> : null;
}

/** Fullscreen native video with controls; autoplays on mount. useVideoPlayer auto-releases
 *  on unmount, so no manual cleanup is needed (this screen owns the player for its lifetime). */
function FullscreenVideo({ uri }: { uri: string }): React.JSX.Element {
  const win = Dimensions.get('window');
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: win.width, height: win.height }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counter: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10 },
  pill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.35 },
  glyph: { color: '#fff', fontSize: 20, fontWeight: '600' },
});
