import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  getVisibleAttachmentByGuid,
  listChatImageAttachmentsByAttachmentGuid,
} from '@db/repositories';
import { download, redownload } from '@/services/download';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { useDownloadStore } from '@state/downloadStore';
import {
  activePageAttachment,
  PAGE_CHECK_INDICATOR_DELAY_MS,
  sameMediaSource,
  withRefreshedActivePage,
  type LoadedMedia,
  type MediaDownloadIntent,
  type MediaDownloadOperation,
  type MediaLoadFailure,
  type MediaSourceGrant,
} from '@ui/attachments/mediaViewerModel';
import {
  MediaDownloadOverlay,
  MediaPageCheckOverlay,
  MediaViewerTopBar,
} from '@ui/attachments/MediaViewerControls';
import { ProtectedFullscreenVideo, ProtectedZoomableImage } from '@ui/attachments/MediaViewerPages';
import { useAttachmentCachePathProtection } from '@ui/attachments/useAttachmentCachePathProtection';
import { useMediaShareSave } from '@ui/attachments/useMediaShareSave';
import { isLocalFileUri } from '@utils';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { useShownAfterDelay } from '@ui/hooks/useShownAfterDelay';
import { runAccountOperation } from '@/services/realtime/accountOperation';

/**
 * Fullscreen media viewer. Images open in a swipe-carousel across EVERY photo in the chat (with an
 * "N of M" counter), each pinch-to-zoomable; a video opens singly with native controls. Share +
 * save-to-Photos act on the currently-visible item.
 */
export default function MediaViewer(): React.JSX.Element {
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const router = useRouter();
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
  const current = visibleLoaded ? activePageAttachment(visibleLoaded) : null;
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
      return activePageAttachment(active)?.guid === attachmentGuid;
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

        const nextLoaded = withRefreshedActivePage(active, attachment);
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
      const activeAttachment = activePageAttachment(active);
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

  /** Publish the end of a transfer this viewer started, unless a newer request replaced it. */
  const followViewerTransfer = useCallback(
    (operation: MediaDownloadOperation, task: Promise<string | null>): void => {
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
    },
    [pendingDownloadIsCurrent],
  );

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
          operation.joinedFinishedMarker &&
          attachment &&
          attachment.guid === operation.source.attachmentGuid &&
          !isLocalFileUri(attachment.localPath)
        ) {
          // The request found only a finished marker, and the DB proves that file is gone (cache
          // eviction or Repair Downloads). Nothing is transferring, so start the requested
          // download instead of reporting a failure nothing attempted. It restarts only once.
          const restarted: MediaDownloadOperation = { ...operation, joinedFinishedMarker: false };
          pendingDownloadRef.current = restarted;
          setPendingDownload(restarted);
          useDownloadStore.getState().clear(attachmentGuid);
          try {
            followViewerTransfer(
              restarted,
              download({ ...attachment, localPath: null }, 'manual', accountLease),
            );
          } catch (error) {
            logger.warn('[media] attachment download could not start', error);
            useDownloadStore.getState().fail(attachmentGuid);
          }
          return;
        }
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
        if (activePageAttachment(active)?.guid !== attachment.guid) return;

        const nextLoaded = withRefreshedActivePage(active, attachment);
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
      followViewerTransfer,
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

    const liveDownloadState = useDownloadStore.getState();
    const liveStatus = liveDownloadState.status[source.attachmentGuid];
    const joinedFinishedMarker =
      !recoversMediaFailure &&
      liveStatus === 'idle' &&
      liveDownloadState.progress[source.attachmentGuid] === 1;
    const operation: MediaDownloadOperation = {
      token: Symbol(`media-${intent}-download`),
      intent,
      phase: 'downloading',
      recoversMediaFailure,
      source,
      joinedFinishedMarker,
    };
    pendingDownloadRef.current = operation;
    downloadRefreshRef.current = null;
    setPendingDownload(operation);

    if (!recoversMediaFailure && (liveStatus === 'downloading' || joinedFinishedMarker)) {
      // Another surface already owns the transfer, or just finished it. Keep this requested intent
      // and let the existing terminal-state effect re-read the authoritative DB row; invoking the
      // public front door again here would cancel an RCS backoff owner or collide with its path.
      // That re-read starts the transfer itself when a finished marker outlived its file.
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
      followViewerTransfer(operation, task);
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
    const activeAttachment = active ? activePageAttachment(active) : null;
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

  const { performShare, performSave } = useMediaShareSave(accountLease, sourceGrantIsCurrent);

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
    const attachment = active ? activePageAttachment(active) : null;
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

  const pendingForCurrent =
    pendingDownload && pendingDownloadIsCurrent(pendingDownload) ? pendingDownload : null;
  const pageCheckBusy = visibleLoaded?.pageStatus === 'checking';
  // A page check is one indexed read that usually finishes before a spinner could be read, so
  // showing it at once flashed "Checking media…" on every swipe. Show it only once it is slow.
  const checkingPageKey =
    visibleLoaded?.pageStatus === 'checking'
      ? `${visibleLoaded.routeLifetime}:${visibleLoaded.pageLifetime}`
      : null;
  const showPageCheckIndicator = useShownAfterDelay(checkingPageKey, PAGE_CHECK_INDICATOR_DELAY_MS);
  const downloadBusy =
    !local &&
    (downloadStatus === 'downloading' ||
      (pendingForCurrent?.phase === 'downloading' && downloadStatus !== 'error'));
  const mediaActionBusy = pageCheckBusy || downloadBusy || pendingForCurrent != null;
  const mediaActionsAvailable =
    !!currentSource && sourceGrantIsCurrent(currentSource) && !mediaActionBusy;
  const downloadIntent = pendingForCurrent?.intent ?? 'download';
  const retryingExistingPath = isLocalFileUri(currentSource?.localPath);

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
        <MediaPageCheckOverlay
          checking={visibleLoaded?.pageStatus === 'checking'}
          showIndicator={showPageCheckIndicator}
          onRetry={retryCurrentPageRefresh}
        />
      ) : currentSource && !local ? (
        <MediaDownloadOverlay
          intent={downloadIntent}
          busy={downloadBusy}
          progress={downloadProgress}
          failed={downloadStatus === 'error' || pendingForCurrent?.phase === 'adopted'}
          fileMissing={retryingExistingPath}
          onDownload={() => requestDownload(downloadIntent, pendingForCurrent?.token)}
        />
      ) : null}

      <MediaViewerTopBar
        pageNumber={pageIndex + 1}
        pageCount={visibleGallery?.items.length ?? 0}
        actionsAvailable={mediaActionsAvailable}
        actionsBusy={mediaActionBusy}
        onClose={revokeViewerBeforeClose}
        onShare={onShare}
        onSave={onSave}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
