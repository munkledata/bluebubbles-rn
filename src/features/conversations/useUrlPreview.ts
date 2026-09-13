import { useEffect, useRef, useState } from 'react';
import { getDatabase } from '@db/database';
import { getUrlPreview, type UrlPreviewRow } from '@db/repositories';
import { isUrlPreviewCacheFresh, urlPreviewCacheExpiresAt } from '@db/repositories/urlPreviews';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { readUrlPreviewAndLoad } from '@/services/urlPreviewLoader';

const TABLES = ['url_previews'];

/**
 * URL-preview cache lookup with a capability-gated automatic refresh.
 *
 * The phone asks only its authenticated Gator server; arbitrary link/image hosts remain entirely
 * behind the server's bounded proxy. Cache writes wake this reactive query after the loader has
 * atomically published the complete text + optional data-image result.
 */
export function useUrlPreview(url: string | null): UrlPreviewRow | null {
  const [expiryRevision, setExpiryRevision] = useState(0);
  // A bubble owns the account that mounted it. If navigation teardown briefly leaves that old
  // component alive after an account switch, it must become inert rather than pairing A's URL prop
  // with B's live credentials/cache.
  const ownerRef = useRef<{
    accountEpoch: number;
    lease: ReturnType<typeof captureRealtimeDeliveryLease>;
  } | null>(null);
  ownerRef.current ??= {
    accountEpoch: sessionAccessors.getEpoch(),
    lease: captureRealtimeDeliveryLease(),
  };
  const previewProxySupported = useSessionStore(
    (state) =>
      state.status === 'connected' && state.serverInfo?.supports_url_preview_proxy === true,
  );
  const accountEpoch = useSessionStore((state) => state.epoch);
  const transportRevision = useSessionStore((state) => state.transportRevision);
  const ownerCurrent =
    ownerRef.current.accountEpoch === accountEpoch && ownerRef.current.lease.isCurrent();
  const { data } = useReactiveQuery<UrlPreviewRow | null>(
    async () => {
      if (!url) return null;
      // The capable path captures account, transport, cancellation, and DB before its cache await.
      // A miss therefore stays a raw link while a safe background completion wakes this query.
      const cached = previewProxySupported
        ? await readUrlPreviewAndLoad(url, {
            accountEpoch: ownerRef.current!.accountEpoch,
            transportRevision,
          })
        : await getUrlPreview(getDatabase(), url);
      // Apply the same lifetime gate to capable and legacy-server reads. The database may retain
      // an expired row until the next bounded prune, but it is never displayed or used to suppress
      // a refresh beyond its positive/negative TTL.
      if (!isUrlPreviewCacheFresh(cached)) return null;
      // An image-only result still needs a text label while the card image is loading/rendering.
      const title = cached.title ?? (cached.imageUrl?.trim() ? previewDomain(url) : null);
      return { ...cached, title };
    },
    TABLES,
    [url, previewProxySupported, accountEpoch, transportRevision, ownerCurrent, expiryRevision],
    // No URL → no query AND no url_previews subscription (every bubble mounts this hook).
    { enabled: url != null && ownerCurrent },
  );

  useEffect(() => {
    if (!ownerCurrent) return;
    const expiresAt = urlPreviewCacheExpiresAt(data);
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => setExpiryRevision((revision) => revision + 1),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [data, ownerCurrent]);

  // The timer causes a render at the boundary. Hide synchronously on that render while the
  // reactive query starts its cache re-read / capable-server refresh in the background.
  return ownerCurrent && isUrlPreviewCacheFresh(data) ? data : null;
}

function previewDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
