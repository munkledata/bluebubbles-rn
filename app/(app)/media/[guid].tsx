import { useEventListener } from 'expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  getVisibleAttachmentByGuid,
  listChatImageAttachmentsByAttachmentGuid,
  type AttachmentRow,
} from '@db/repositories';
import { download, redownload } from '@/services/download';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { useDownloadStore } from '@state/downloadStore';
import { ProgressRing } from '@ui/attachments/ProgressRing';
import { ZoomableImage } from '@ui/attachments/ZoomableImage';
import { useAttachmentCachePathProtection } from '@ui/attachments/useAttachmentCachePathProtection';
import { showDialog } from '@ui/dialog/dialogStore';
import { showToast } from '@ui/toast/toastStore';
import { isLocalFileUri } from '@utils';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { runAccountOperation } from '@/services/realtime/accountOperation';

interface MediaGallery {
  items: AttachmentRow[];
  index: number;
}

/** How long a page check may run before the viewer shows its "Checking media…" spinner. */
const PAGE_CHECK_INDICATOR_DELAY_MS = 300;

interface LoadedMedia {
  routeGuid: string;
  routeLifetime: number;
  attachment: AttachmentRow | null;
  gallery: MediaGallery | null;
  pageIndex: number;
  pageLifetime: number;
  pageStatus: 'checking' | 'ready' | 'error';
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

type MediaDownloadIntent = 'download' | 'share' | 'save';

interface MediaDownloadOperation {
  token: symbol;
  intent: MediaDownloadIntent;
  phase: 'downloading' | 'adopted';
  recoversMediaFailure: boolean;
  source: MediaSourceGrant;
}

interface MediaLoadFailure {
  source: MediaSourceGrant;
}

function sameMediaSource(left: MediaSourceGrant, right: MediaSourceGrant): boolean {
  return (
    left.routeGuid === right.routeGuid &&
    left.routeLifetime === right.routeLifetime &&
    left.pageLifetime === right.pageLifetime &&
    left.attachmentGuid === right.attachmentGuid &&
    left.localPath === right.localPath &&
    left.mimeType === right.mimeType
  );
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
  const win = useWindowDimensions();
  const accountLease = useScreenAccountLease();
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
  const [cacheProtectionEpoch, setCacheProtectionEpoch] = useState(0);
  const sharing = useRef<MediaActionOperation | null>(null);
  const saving = useRef<MediaActionOperation | null>(null);
  const pendingDownloadRef = useRef<MediaDownloadOperation | null>(null);
  const downloadRefreshRef = useRef<symbol | null>(null);
  const [downloadRefreshEpoch, setDownloadRefreshEpoch] = useState(0);
  const [pendingDownload, setPendingDownload] = useState<MediaDownloadOperation | null>(null);
  const mediaLoadFailureRef = useRef<MediaLoadFailure | null>(null);
  const [mediaLoadFailure, setMediaLoadFailure] = useState<MediaLoadFailure | null>(null);

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

  const clearMediaLoadFailure = useCallback((): void => {
    mediaLoadFailureRef.current = null;
    setMediaLoadFailure(null);
  }, []);

  const clearLoadedMedia = useCallback((): void => {
    activeLoadedRef.current = null;
    pendingDownloadRef.current = null;
    downloadRefreshRef.current = null;
    setLoaded(null);
    setPendingDownload(null);
    clearMediaLoadFailure();
    setPagingEnabled(true);
  }, [clearMediaLoadFailure]);

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
      pendingDownloadRef.current = null;
      downloadRefreshRef.current = null;
      mediaLoadFailureRef.current = null;
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
        const result = await runAccountOperation(accountLease, async () => {
          const db = getDatabase();
          // Route params are public input. Admit only a real visible attachment here; internal
          // transfer/retry code keeps its separate unrestricted GUID lookup.
          const attachment = await getVisibleAttachmentByGuid(db, loadRouteGuid);
          if (!attachment || (attachment.mimeType ?? '').startsWith('video')) {
            return { attachment, galleryResult: null };
          }
          const siblings = await listChatImageAttachmentsByAttachmentGuid(db, loadRouteGuid);
          // The route lookup above is authoritative for the initially active page. Only accept the
          // sibling snapshot when it contains that exact row, then replace the snapshot copy with
          // the row we just read. This prevents the initial page from starting with a stale path.
          const exactIndex = siblings.items.findIndex((item) => item.guid === attachment.guid);
          const items = exactIndex >= 0 ? [...siblings.items] : [attachment];
          const index = exactIndex >= 0 ? exactIndex : 0;
          items[index] = attachment;
          return { attachment, galleryResult: { items, index } };
        });
        if (!alive || !result.ok || !routeGrantIsCurrent(loadRouteGuid, loadRouteLifetime)) {
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
          // Admission proves that the route is visible, but the gallery query above creates a
          // window in which a download/cache settlement can change this row. Run the same exact
          // active-page preflight used after a swipe before publishing any path or action.
          pageStatus: 'checking',
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
  const pageReady = visibleLoaded?.pageStatus === 'ready';

  const pageGrantIsCurrent = useCallback(
    (
      routeGuid: string,
      routeLifetime: number,
      pageLifetime: number,
      attachmentGuid: string,
    ): boolean => {
      if (!routeGrantIsCurrent(routeGuid, routeLifetime)) return false;
      const active = activeLoadedRef.current;
      if (
        !active ||
        active.routeGuid !== routeGuid ||
        active.routeLifetime !== routeLifetime ||
        active.pageLifetime !== pageLifetime ||
        pageLifetimeRef.current !== pageLifetime
      ) {
        return false;
      }
      const activeAttachment = active.gallery
        ? (active.gallery.items[active.pageIndex] ?? null)
        : active.attachment;
      return activeAttachment?.guid === attachmentGuid;
    },
    [routeGrantIsCurrent],
  );

  // A carousel row is only a snapshot. Every newly active page must re-read its exact visible row
  // before a path reaches native media, cache ownership, Download, Share, or Save. Page lifetime is
  // the request token: swiping away or retrying increments it, so an older result cannot publish.
  useEffect(() => {
    if (!visibleLoaded || visibleLoaded.pageStatus !== 'checking' || !current) return;
    const pageGrant = {
      routeGuid: visibleLoaded.routeGuid,
      routeLifetime: visibleLoaded.routeLifetime,
      pageLifetime: visibleLoaded.pageLifetime,
      attachmentGuid: current.guid,
    };
    let alive = true;
    void (async () => {
      try {
        const result = await runAccountOperation(accountLease, () =>
          getVisibleAttachmentByGuid(getDatabase(), pageGrant.attachmentGuid),
        );
        if (
          !alive ||
          !result.ok ||
          !pageGrantIsCurrent(
            pageGrant.routeGuid,
            pageGrant.routeLifetime,
            pageGrant.pageLifetime,
            pageGrant.attachmentGuid,
          )
        ) {
          return;
        }

        const attachment = result.value;
        const active = activeLoadedRef.current;
        if (!active || active.pageStatus !== 'checking') return;
        if (!attachment || attachment.guid !== pageGrant.attachmentGuid) {
          const failed: LoadedMedia = { ...active, pageStatus: 'error' };
          activeLoadedRef.current = failed;
          setLoaded(failed);
          return;
        }

        const nextGallery = active.gallery
          ? {
              ...active.gallery,
              items: active.gallery.items.map((item, index) =>
                index === active.pageIndex ? attachment : item,
              ),
            }
          : null;
        const nextLoaded: LoadedMedia = {
          ...active,
          attachment: active.attachment?.guid === attachment.guid ? attachment : active.attachment,
          gallery: nextGallery,
          pageStatus: 'ready',
        };
        activeLoadedRef.current = nextLoaded;
        setCacheProtectionEpoch((epoch) => epoch + 1);
        setLoaded(nextLoaded);
      } catch (error) {
        if (
          !alive ||
          !pageGrantIsCurrent(
            pageGrant.routeGuid,
            pageGrant.routeLifetime,
            pageGrant.pageLifetime,
            pageGrant.attachmentGuid,
          )
        ) {
          return;
        }
        const active = activeLoadedRef.current;
        if (!active || active.pageStatus !== 'checking') return;
        logger.warn('[media] could not refresh current attachment', error);
        const failed: LoadedMedia = { ...active, pageStatus: 'error' };
        activeLoadedRef.current = failed;
        setLoaded(failed);
      }
    })();
    return () => {
      alive = false;
    };
  }, [accountLease, current, pageGrantIsCurrent, visibleLoaded]);

  const currentSource = useMemo<MediaSourceGrant | null>(
    () =>
      visibleLoaded && current && pageReady
        ? {
            routeGuid: visibleLoaded.routeGuid,
            routeLifetime: visibleLoaded.routeLifetime,
            pageLifetime: visibleLoaded.pageLifetime,
            attachmentGuid: current.guid,
            localPath: current.localPath,
            mimeType: current.mimeType ?? null,
          }
        : null,
    [current, pageReady, visibleLoaded],
  );
  const mediaLoadFailureIsCurrent =
    mediaLoadFailure != null &&
    currentSource != null &&
    sameMediaSource(mediaLoadFailure.source, currentSource);
  // This active-item pin is deliberately separate from the mounted image/video reader pin below.
  // It makes action availability follow actual cache ownership instead of merely trusting a
  // persisted `file://` string. The native Share/Photos helpers acquire their own operation pin.
  const protectedCurrentPath = useAttachmentCachePathProtection(
    mediaLoadFailureIsCurrent ? null : currentSource?.localPath,
    cacheProtectionEpoch,
  );
  const local =
    isLocalFileUri(protectedCurrentPath) && protectedCurrentPath === currentSource?.localPath;
  const downloadStatus = useDownloadStore((state) =>
    current ? state.status[current.guid] : undefined,
  );
  const downloadProgress = useDownloadStore((state) =>
    current ? state.progress[current.guid] : undefined,
  );

  const sourceGrantMatchesActive = useCallback(
    (source: MediaSourceGrant): boolean => {
      if (!routeGrantIsCurrent(source.routeGuid, source.routeLifetime)) return false;
      const active = activeLoadedRef.current;
      if (
        !active ||
        active.routeGuid !== source.routeGuid ||
        active.routeLifetime !== source.routeLifetime ||
        active.pageLifetime !== source.pageLifetime ||
        pageLifetimeRef.current !== source.pageLifetime ||
        active.pageStatus !== 'ready'
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

  const sourceGrantIsCurrent = useCallback(
    (source: MediaSourceGrant): boolean => {
      const failure = mediaLoadFailureRef.current;
      return (
        sourceGrantMatchesActive(source) && !(failure && sameMediaSource(failure.source, source))
      );
    },
    [sourceGrantMatchesActive],
  );

  const clearPendingDownload = useCallback((token?: symbol): void => {
    if (token !== undefined && pendingDownloadRef.current?.token !== token) return;
    pendingDownloadRef.current = null;
    downloadRefreshRef.current = null;
    setPendingDownload(null);
  }, []);

  const pendingDownloadIsCurrent = useCallback(
    (operation: MediaDownloadOperation): boolean => {
      if (pendingDownloadRef.current?.token !== operation.token) return false;
      if (!operation.recoversMediaFailure) return sourceGrantIsCurrent(operation.source);
      const failure = mediaLoadFailureRef.current;
      return (
        sourceGrantMatchesActive(operation.source) &&
        failure != null &&
        sameMediaSource(failure.source, operation.source)
      );
    },
    [sourceGrantIsCurrent, sourceGrantMatchesActive],
  );

  const reportMediaLoadFailure = useCallback(
    (source: MediaSourceGrant): void => {
      if (!sourceGrantMatchesActive(source)) return;
      const existing = mediaLoadFailureRef.current;
      if (existing && sameMediaSource(existing.source, source)) return;
      mediaLoadFailureRef.current = { source };
      clearPendingDownload();
      setMediaLoadFailure({ source });
    },
    [clearPendingDownload, sourceGrantMatchesActive],
  );

  const failFinishedDownloadIfStillCurrent = useCallback((attachmentGuid: string): void => {
    const liveState = useDownloadStore.getState();
    if (liveState.status[attachmentGuid] === 'idle' && liveState.progress[attachmentGuid] === 1) {
      liveState.fail(attachmentGuid);
    }
  }, []);

  const refreshDownloadedAttachment = useCallback(
    async (operation: MediaDownloadOperation): Promise<void> => {
      if (
        operation.phase !== 'downloading' ||
        downloadRefreshRef.current === operation.token ||
        !pendingDownloadIsCurrent(operation)
      ) {
        return;
      }
      downloadRefreshRef.current = operation.token;
      const attachmentGuid = operation.source.attachmentGuid;
      let exactDownloadTransitioned = false;
      let retryAfterNewerTerminalTransition = false;
      const unsubscribeDownloadFence = useDownloadStore.subscribe((next, previous) => {
        if (
          next.status[attachmentGuid] !== previous.status[attachmentGuid] ||
          next.progress[attachmentGuid] !== previous.progress[attachmentGuid]
        ) {
          exactDownloadTransitioned = true;
        }
      });

      const rejectUnpublishableTerminal = (): void => {
        const liveState = useDownloadStore.getState();
        if (exactDownloadTransitioned) {
          // A newer owner may have started and finished while the stale DB read was pending. Ask
          // for a fresh authoritative read even when React observed only the identical idle/1 end
          // state, and never let this older read overwrite that owner's presentation result.
          retryAfterNewerTerminalTransition =
            liveState.status[attachmentGuid] === 'idle' && liveState.progress[attachmentGuid] === 1;
          return;
        }
        failFinishedDownloadIfStillCurrent(attachmentGuid);
      };
      try {
        const result = await runAccountOperation(accountLease, () =>
          getVisibleAttachmentByGuid(getDatabase(), attachmentGuid),
        );
        if (!result.ok || !pendingDownloadIsCurrent(operation)) return;
        if (exactDownloadTransitioned) {
          // Any exact-GUID transition during the await makes this read older than the latest
          // owner. Discard even a valid-looking local path, then reread if that owner is terminal.
          rejectUnpublishableTerminal();
          return;
        }

        const attachment = result.value;
        if (
          !attachment ||
          attachment.guid !== operation.source.attachmentGuid ||
          (operation.recoversMediaFailure && attachment.localPath === operation.source.localPath) ||
          (!operation.recoversMediaFailure && !isLocalFileUri(attachment.localPath))
        ) {
          // The transfer store is presentation-only. A successful transfer is not publishable
          // until the encrypted DB proves the exact visible row owns a local file URI.
          // Do not overwrite a newer external/RCS owner that started while this read was pending.
          rejectUnpublishableTerminal();
          return;
        }

        const active = activeLoadedRef.current;
        if (!active || !pendingDownloadIsCurrent(operation)) return;
        const activeAttachment = active.gallery
          ? (active.gallery.items[active.pageIndex] ?? null)
          : active.attachment;
        if (activeAttachment?.guid !== attachment.guid) return;

        const nextGallery = active.gallery
          ? {
              ...active.gallery,
              items: active.gallery.items.map((item, index) =>
                index === active.pageIndex ? attachment : item,
              ),
            }
          : null;
        const nextLoaded: LoadedMedia = {
          ...active,
          attachment: active.attachment?.guid === attachment.guid ? attachment : active.attachment,
          gallery: nextGallery,
          pageStatus: 'ready',
        };
        if (!isLocalFileUri(attachment.localPath)) {
          // A replacement can lose because another owner cleared the stale source instead of
          // installing a new file. Adopt that authoritative remote row, leave corrupt-recovery
          // mode, and make the next explicit Retry start an ordinary download.
          clearMediaLoadFailure();
          activeLoadedRef.current = nextLoaded;
          clearPendingDownload(operation.token);
          setCacheProtectionEpoch((epoch) => epoch + 1);
          setLoaded(nextLoaded);
          useDownloadStore.getState().fail(attachmentGuid);
          return;
        }
        const nextOperation: MediaDownloadOperation = {
          ...operation,
          phase: 'adopted',
          recoversMediaFailure: false,
          source: {
            ...operation.source,
            localPath: attachment.localPath,
            mimeType: attachment.mimeType ?? null,
          },
        };

        // Publish refs first so a retained callback cannot observe the rendered local path without
        // also seeing the matching, authoritative source grant.
        if (operation.recoversMediaFailure) clearMediaLoadFailure();
        activeLoadedRef.current = nextLoaded;
        pendingDownloadRef.current = nextOperation;
        setCacheProtectionEpoch((epoch) => epoch + 1);
        setLoaded(nextLoaded);
        setPendingDownload(nextOperation);
      } catch (error) {
        if (pendingDownloadIsCurrent(operation)) {
          logger.warn('[media] could not refresh downloaded attachment', error);
          rejectUnpublishableTerminal();
        }
      } finally {
        unsubscribeDownloadFence();
        if (downloadRefreshRef.current === operation.token) downloadRefreshRef.current = null;
        if (retryAfterNewerTerminalTransition && pendingDownloadIsCurrent(operation)) {
          setDownloadRefreshEpoch((epoch) => epoch + 1);
        }
      }
    },
    [
      accountLease,
      clearMediaLoadFailure,
      clearPendingDownload,
      failFinishedDownloadIfStillCurrent,
      pendingDownloadIsCurrent,
    ],
  );

  useEffect(() => {
    if (
      !pendingDownload ||
      pendingDownload.phase !== 'downloading' ||
      downloadStatus !== 'idle' ||
      !pendingDownloadIsCurrent(pendingDownload)
    ) {
      return;
    }
    // The external download store just reported its DB commit complete; this asynchronous read is
    // the synchronization boundary that safely publishes that authoritative row into the viewer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshDownloadedAttachment(pendingDownload);
  }, [
    downloadRefreshEpoch,
    downloadStatus,
    pendingDownload,
    pendingDownloadIsCurrent,
    refreshDownloadedAttachment,
  ]);

  const requestDownload = (intent: MediaDownloadIntent, replaceToken?: symbol): void => {
    const attachment = current;
    const source = currentSource;
    const activePending = pendingDownloadRef.current;
    const activeMediaFailure = mediaLoadFailureRef.current;
    const recoversMediaFailure =
      source != null &&
      activeMediaFailure != null &&
      sameMediaSource(activeMediaFailure.source, source);
    if (
      !attachment ||
      !source ||
      local ||
      !(recoversMediaFailure ? sourceGrantMatchesActive(source) : sourceGrantIsCurrent(source)) ||
      (activePending ? activePending.token !== replaceToken : replaceToken !== undefined)
    ) {
      return;
    }

    const operation: MediaDownloadOperation = {
      token: Symbol(`media-${intent}-download`),
      intent,
      phase: 'downloading',
      recoversMediaFailure,
      source,
    };
    pendingDownloadRef.current = operation;
    downloadRefreshRef.current = null;
    setPendingDownload(operation);

    const liveDownloadState = useDownloadStore.getState();
    const liveStatus = liveDownloadState.status[source.attachmentGuid];
    const liveProgress = liveDownloadState.progress[source.attachmentGuid];
    if (
      !recoversMediaFailure &&
      (liveStatus === 'downloading' || (liveStatus === 'idle' && liveProgress === 1))
    ) {
      // Another surface already owns the transfer, or just finished it. Keep this requested intent
      // and let the existing terminal-state effect re-read the authoritative DB row; invoking the
      // public front door again here would cancel an RCS backoff owner or collide with its path.
      return;
    }

    // Development fixtures can contain an https localPath. It is not a native/cache path and must
    // not be handed to cache reuse as though it were a downloaded file.
    const target = isLocalFileUri(attachment.localPath)
      ? attachment
      : { ...attachment, localPath: null };
    try {
      const task = recoversMediaFailure
        ? redownload(attachment, accountLease)
        : download(target, 'manual', accountLease);
      void task.then(
        (path) => {
          if (path != null || !pendingDownloadIsCurrent(operation)) return;
          // A null result may come from a refusal that never touched the store (e.g. RCS media
          // from a previous Google pairing), which left "Downloading media…" up with no Retry.
          // A transfer another owner still runs, or just finished, publishes its own end state.
          const guid = operation.source.attachmentGuid;
          const { status, progress } = useDownloadStore.getState();
          if (status[guid] === 'downloading' || (status[guid] === 'idle' && progress[guid] === 1)) {
            return;
          }
          useDownloadStore.getState().fail(guid);
        },
        (error: unknown) => {
          if (!pendingDownloadIsCurrent(operation)) return;
          logger.warn('[media] attachment download failed', error);
          useDownloadStore.getState().fail(operation.source.attachmentGuid);
        },
      );
    } catch (error) {
      if (!pendingDownloadIsCurrent(operation)) return;
      logger.warn('[media] attachment download could not start', error);
      useDownloadStore.getState().fail(operation.source.attachmentGuid);
    }
  };

  // A chat bubble or Shared Media cell may already own this transfer when the viewer opens. Join
  // its presentation state and perform the same authoritative DB adoption when it finishes.
  useEffect(() => {
    const source = currentSource;
    if (
      !source ||
      local ||
      downloadStatus !== 'downloading' ||
      pendingDownloadRef.current ||
      !sourceGrantIsCurrent(source)
    ) {
      return;
    }
    const operation: MediaDownloadOperation = {
      token: Symbol('media-observed-download'),
      intent: 'download',
      phase: 'downloading',
      recoversMediaFailure: false,
      source,
    };
    pendingDownloadRef.current = operation;
    setPendingDownload(operation);
  }, [currentSource, downloadStatus, local, sourceGrantIsCurrent]);

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
      clearPendingDownload();
      clearMediaLoadFailure();
      const nextLoaded: LoadedMedia = {
        ...active,
        pageIndex: nextIndex,
        pageLifetime: nextPageLifetime,
        pageStatus: 'checking',
      };
      activeLoadedRef.current = nextLoaded;
      setLoaded(nextLoaded);
      setPagingEnabled(true);
    },
    [
      clearMediaLoadFailure,
      clearPendingDownload,
      routeGrantIsCurrent,
      visibleGallery,
      visibleLoaded,
      win.width,
    ],
  );

  const onScrollBeginDrag = useCallback((): void => {
    if (!visibleLoaded || !current) return;
    const active = activeLoadedRef.current;
    const activeAttachment = active?.gallery
      ? (active.gallery.items[active.pageIndex] ?? null)
      : active?.attachment;
    if (
      !active ||
      active.routeGuid !== visibleLoaded.routeGuid ||
      active.routeLifetime !== visibleLoaded.routeLifetime ||
      active.pageLifetime !== visibleLoaded.pageLifetime ||
      activeAttachment?.guid !== current.guid ||
      !routeGrantIsCurrent(visibleLoaded.routeGuid, visibleLoaded.routeLifetime)
    ) {
      return;
    }
    const operation = pendingDownloadRef.current;
    if (
      !operation ||
      operation.intent === 'download' ||
      operation.source.routeGuid !== visibleLoaded.routeGuid ||
      operation.source.routeLifetime !== visibleLoaded.routeLifetime ||
      operation.source.pageLifetime !== visibleLoaded.pageLifetime ||
      operation.source.attachmentGuid !== current.guid
    ) {
      return;
    }

    // Swiping cancels the requested Share/Save continuation immediately, but the transfer itself
    // still belongs to the app. Replace the operation token so any retained async refresh from the
    // old intent becomes inert, then keep observing the transfer and adopt its DB result normally.
    const genericOperation: MediaDownloadOperation = {
      ...operation,
      token: Symbol('media-drag-download'),
      intent: 'download',
    };
    pendingDownloadRef.current = genericOperation;
    downloadRefreshRef.current = null;
    setPendingDownload(genericOperation);
  }, [current, routeGrantIsCurrent, visibleLoaded]);

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
  const performShare = useCallback(
    async (source: MediaSourceGrant): Promise<void> => {
      if (
        !source.localPath ||
        !isLocalFileUri(source.localPath) ||
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
        const result = await runAccountOperation(accountLease, () =>
          shareAttachment(localPath, source.mimeType, operationIsCurrent),
        );
        if (!result.ok || !operationIsCurrent() || result.value.ok) {
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
    },
    [accountLease, sourceGrantIsCurrent],
  );

  const performSave = useCallback(
    async (source: MediaSourceGrant): Promise<void> => {
      if (
        !source.localPath ||
        !isLocalFileUri(source.localPath) ||
        saving.current ||
        !sourceGrantIsCurrent(source)
      ) {
        return;
      }
      const operation: MediaActionOperation = { token: Symbol('media-save'), source };
      saving.current = operation;
      const localPath = source.localPath;
      const operationIsCurrent = (): boolean =>
        saving.current?.token === operation.token && sourceGrantIsCurrent(operation.source);
      try {
        const result = await runAccountOperation(accountLease, () =>
          saveAttachmentsToPhotos([localPath], operationIsCurrent),
        );
        if (!result.ok || !operationIsCurrent()) return;
        if (result.value.status === 'saved') showToast('Saved to Photos');
        else if (result.value.status === 'denied')
          showDialog('Save', 'Photos permission is required to save attachments.');
        else showToast('Couldn’t save this photo');
      } catch {
        if (operationIsCurrent()) showToast('Couldn’t save this photo');
      } finally {
        if (saving.current?.token === operation.token) saving.current = null;
      }
    },
    [accountLease, sourceGrantIsCurrent],
  );

  useEffect(() => {
    const operation = pendingDownload;
    if (
      !operation ||
      operation.phase !== 'adopted' ||
      !local ||
      protectedCurrentPath !== operation.source.localPath ||
      !pendingDownloadIsCurrent(operation)
    ) {
      return;
    }

    clearPendingDownload(operation.token);
    if (operation.intent === 'share') void performShare(operation.source);
    else if (operation.intent === 'save') void performSave(operation.source);
  }, [
    clearPendingDownload,
    local,
    pendingDownload,
    pendingDownloadIsCurrent,
    performSave,
    performShare,
    protectedCurrentPath,
  ]);

  const onShare = (): void => {
    const source = currentSource;
    if (!source || !sourceGrantIsCurrent(source)) return;
    if (!local) {
      requestDownload('share');
      return;
    }
    void performShare(source);
  };

  const onSave = (): void => {
    const source = currentSource;
    if (!source || !sourceGrantIsCurrent(source)) return;
    if (!local) {
      requestDownload('save');
      return;
    }
    void performSave(source);
  };

  const retryCurrentPageRefresh = (): void => {
    const active = activeLoadedRef.current;
    const attachment = active?.gallery
      ? (active.gallery.items[active.pageIndex] ?? null)
      : (active?.attachment ?? null);
    if (
      !active ||
      active.pageStatus !== 'error' ||
      !attachment ||
      !pageGrantIsCurrent(
        active.routeGuid,
        active.routeLifetime,
        active.pageLifetime,
        attachment.guid,
      )
    ) {
      return;
    }
    const nextPageLifetime = pageLifetimeRef.current + 1;
    pageLifetimeRef.current = nextPageLifetime;
    clearPendingDownload();
    clearMediaLoadFailure();
    const nextLoaded: LoadedMedia = {
      ...active,
      pageLifetime: nextPageLifetime,
      pageStatus: 'checking',
    };
    activeLoadedRef.current = nextLoaded;
    setLoaded(nextLoaded);
    setPagingEnabled(true);
  };

  const revokeViewerBeforeClose = (): void => {
    if (!mountAliveRef.current) return;
    mountAliveRef.current = false;
    routeLifetimeRef.current += 1;
    pageLifetimeRef.current += 1;
    activeLoadedRef.current = null;
    pendingDownloadRef.current = null;
    downloadRefreshRef.current = null;
    mediaLoadFailureRef.current = null;
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

  const pendingForCurrent =
    pendingDownload && pendingDownloadIsCurrent(pendingDownload) ? pendingDownload : null;
  const pageCheckBusy = visibleLoaded?.pageStatus === 'checking';
  // A page check is one indexed read that usually finishes before a spinner could be read, so
  // showing it at once flashed "Checking media…" on every swipe. Show it only once it is slow.
  const checkingPageKey =
    visibleLoaded?.pageStatus === 'checking'
      ? `${visibleLoaded.routeLifetime}:${visibleLoaded.pageLifetime}`
      : null;
  const [slowCheckPageKey, setSlowCheckPageKey] = useState<string | null>(null);
  useEffect(() => {
    if (checkingPageKey === null) return;
    const timer = setTimeout(
      () => setSlowCheckPageKey(checkingPageKey),
      PAGE_CHECK_INDICATOR_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [checkingPageKey]);
  const showPageCheckIndicator = checkingPageKey !== null && slowCheckPageKey === checkingPageKey;
  const downloadBusy =
    !local &&
    (downloadStatus === 'downloading' ||
      (pendingForCurrent?.phase === 'downloading' && downloadStatus !== 'error'));
  const mediaActionBusy = pageCheckBusy || downloadBusy || pendingForCurrent != null;
  const mediaActionsAvailable =
    !!currentSource && sourceGrantIsCurrent(currentSource) && !mediaActionBusy;
  const downloadIntent = pendingForCurrent?.intent ?? 'download';
  const downloadPurpose =
    downloadIntent === 'share'
      ? 'Downloading media to share'
      : downloadIntent === 'save'
        ? 'Downloading media to save'
        : 'Downloading media';
  const retryingExistingPath = isLocalFileUri(currentSource?.localPath);
  const retryLabel =
    downloadIntent === 'share'
      ? 'Retry download and share media'
      : downloadIntent === 'save'
        ? 'Retry download and save media'
        : 'Retry media download';

  return (
    <View style={styles.root}>
      {visibleAtt && isVideo ? (
        pageReady && visibleAtt.localPath && !mediaLoadFailureIsCurrent ? (
          <ProtectedFullscreenVideo
            uri={visibleAtt.localPath}
            protectionEpoch={cacheProtectionEpoch}
            onError={() => {
              if (currentSource) reportMediaLoadFailure(currentSource);
            }}
          />
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
          onScrollBeginDrag={onScrollBeginDrag}
          onMomentumScrollEnd={onScrollEnd}
          renderItem={({ item, index }) => {
            const activeReady = index === pageIndex && pageReady && !mediaLoadFailureIsCurrent;
            return (
              <ProtectedZoomableImage
                uri={activeReady ? item.localPath : null}
                blurhash={activeReady ? item.blurhash : null}
                width={win.width}
                height={win.height}
                active={index === pageIndex}
                protectionEpoch={index === pageIndex ? cacheProtectionEpoch : 0}
                onError={() => {
                  if (activeReady && currentSource) reportMediaLoadFailure(currentSource);
                }}
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
            );
          }}
        />
      ) : null}

      {current && !pageReady ? (
        <View style={styles.downloadOverlay} pointerEvents="box-none">
          {visibleLoaded?.pageStatus === 'checking' ? (
            showPageCheckIndicator ? (
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel="Checking current media"
                accessibilityLiveRegion="polite"
                style={styles.downloadPanel}
                pointerEvents="none"
              >
                <ProgressRing progress={null} />
                <Text style={styles.downloadMessage}>Checking media…</Text>
              </View>
            ) : null
          ) : (
            <View style={styles.downloadPanel}>
              <Text accessibilityLiveRegion="polite" style={styles.downloadMessage}>
                Couldn’t refresh media
              </Text>
              <Pressable
                onPress={retryCurrentPageRefresh}
                style={styles.downloadButton}
                accessibilityRole="button"
                accessibilityLabel="Retry media refresh"
              >
                <Text style={styles.downloadButtonText}>Retry</Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : currentSource && !local ? (
        <View style={styles.downloadOverlay} pointerEvents="box-none">
          {downloadBusy ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={downloadPurpose}
              accessibilityLiveRegion="polite"
              accessibilityValue={
                typeof downloadProgress === 'number'
                  ? { min: 0, max: 100, now: Math.round(downloadProgress * 100) }
                  : undefined
              }
              style={styles.downloadPanel}
              pointerEvents="none"
            >
              <ProgressRing progress={downloadProgress ?? null} />
              <Text style={styles.downloadMessage}>{downloadPurpose}…</Text>
            </View>
          ) : (
            <View style={styles.downloadPanel}>
              <Text accessibilityLiveRegion="polite" style={styles.downloadMessage}>
                {downloadStatus === 'error' || pendingForCurrent?.phase === 'adopted'
                  ? 'Download failed'
                  : retryingExistingPath
                    ? 'Media file unavailable'
                    : 'Not downloaded'}
              </Text>
              <Pressable
                onPress={() => requestDownload(downloadIntent, pendingForCurrent?.token)}
                style={styles.downloadButton}
                accessibilityRole="button"
                accessibilityLabel={
                  downloadStatus === 'error' ||
                  pendingForCurrent?.phase === 'adopted' ||
                  retryingExistingPath
                    ? retryLabel
                    : 'Download media'
                }
              >
                <Text style={styles.downloadButtonText}>
                  {downloadStatus === 'error' ||
                  pendingForCurrent?.phase === 'adopted' ||
                  retryingExistingPath
                    ? 'Retry'
                    : 'Download'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
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
            onPress={onShare}
            disabled={!mediaActionsAvailable}
            hitSlop={12}
            style={[styles.pill, !mediaActionsAvailable && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Share media"
            accessibilityHint="Downloads this media first when needed"
            accessibilityState={{ disabled: !mediaActionsAvailable, busy: mediaActionBusy }}
          >
            <Text style={styles.glyph}>⤴</Text>
          </Pressable>
          <Pressable
            onPress={onSave}
            disabled={!mediaActionsAvailable}
            hitSlop={12}
            style={[styles.pill, !mediaActionsAvailable && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Save media"
            accessibilityHint="Downloads this media first when needed"
            accessibilityState={{ disabled: !mediaActionsAvailable, busy: mediaActionBusy }}
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
  protectionEpoch,
  onError,
  onZoomChange,
}: {
  uri: string | null;
  blurhash: string | null;
  width: number;
  height: number;
  active: boolean;
  protectionEpoch: number;
  onError: () => void;
  onZoomChange: (zoomed: boolean) => void;
}): React.JSX.Element {
  const protectedUri = useAttachmentCachePathProtection(uri, protectionEpoch);
  return (
    <ZoomableImage
      uri={isLocalFileUri(protectedUri) ? protectedUri : null}
      blurhash={blurhash}
      width={width}
      height={height}
      active={active}
      onError={onError}
      onZoomChange={onZoomChange}
    />
  );
}

/** Do not construct expo-video's native player until the cache path has a live reader pin. */
function ProtectedFullscreenVideo({
  uri,
  protectionEpoch,
  onError,
}: {
  uri: string;
  protectionEpoch: number;
  onError: () => void;
}): React.JSX.Element | null {
  const protectedUri = useAttachmentCachePathProtection(uri, protectionEpoch);
  return isLocalFileUri(protectedUri) ? (
    <FullscreenVideo uri={protectedUri} onError={onError} />
  ) : null;
}

/** Fullscreen native video with controls; autoplays on mount. useVideoPlayer auto-releases
 *  on unmount, so no manual cleanup is needed (this screen owns the player for its lifetime). */
function FullscreenVideo({
  uri,
  onError,
}: {
  uri: string;
  onError: () => void;
}): React.JSX.Element {
  const win = useWindowDimensions();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'error') onError();
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
  downloadOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadPanel: {
    minWidth: 164,
    maxWidth: '80%',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  downloadMessage: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  downloadButton: {
    minHeight: 44,
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: '#fff',
  },
  downloadButtonText: { color: '#000', fontSize: 15, fontWeight: '700' },
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
