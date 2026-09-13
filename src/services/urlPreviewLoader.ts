import * as urlPreviewsApi from '@core/api/endpoints/urlPreviews';
import type { UrlPreviewResult } from '@core/api/endpoints/urlPreviews';
import { getDatabase } from '@db/database';
import {
  getUrlPreview,
  isUrlPreviewCacheFresh,
  sanitizeUrlPreviewImageUrl,
  setUrlPreviewWithinTransaction,
  type UrlPreviewRow,
} from '@db/repositories';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';
import { http } from './clients';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
  type RealtimeDeliveryResult,
} from './realtime/deliveryCoordinator';

const MAX_URL_CHARS = 2_048;
export const URL_PREVIEW_MAX_ACTIVE = 2;
export const URL_PREVIEW_MAX_QUEUED = 64;

export type UrlPreviewLoadOutcome =
  'stored' | 'negative' | 'stale' | 'queue_full' | 'skipped' | 'failed';

interface PreviewTransport {
  /** Non-secret identity used only to coalesce work within one exact pinned transport. */
  readonly key: string;
  isCurrent(): boolean;
  fetch(url: string, signal: AbortSignal): Promise<UrlPreviewResult>;
}

interface PreviewWriteData {
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  error?: boolean;
}

export interface UrlPreviewSessionIdentity {
  readonly accountEpoch: number;
  readonly transportRevision: number;
}

export interface UrlPreviewLoaderDependencies {
  captureSessionIdentity(): UrlPreviewSessionIdentity;
  captureLease(): RealtimeDeliveryLease;
  subscribeInvalidation(generation: number, listener: () => void): () => void;
  subscribeTransportInvalidation(
    identity: UrlPreviewSessionIdentity,
    listener: () => void,
  ): () => void;
  captureTransport(): PreviewTransport;
  getDatabase(): AppDatabase;
  readPreview(db: AppDatabase, url: string): Promise<UrlPreviewRow | null>;
  /** Test seam paired with writePreview; production uses the concrete teardown coordinator. */
  runTrackedWork?(
    lease: RealtimeDeliveryLease,
    task: (lease: RealtimeDeliveryLease) => Promise<unknown>,
  ): Promise<RealtimeDeliveryResult>;
  /** Test seam; production omits this and calls the reviewed repository transaction directly. */
  writePreview?(
    db: AppDatabase,
    url: string,
    data: PreviewWriteData,
    now: number,
    commitGuard?: DbCommitGuard,
  ): Promise<void>;
  now(): number;
}

type QueueState = 'queued' | 'active' | 'settled';

interface QueueTask {
  state: QueueState;
  readonly run: () => Promise<void>;
}

interface QueueTicket {
  /** Remove only work that has not started. Active work is stopped through its AbortSignal. */
  cancelQueued(): boolean;
}

/** A tiny fixed-capacity FIFO. Admission and queue publication are synchronous. */
class BoundedPreviewQueue {
  readonly #queued: QueueTask[] = [];
  #active = 0;

  submit(run: () => Promise<void>): QueueTicket | null {
    const task: QueueTask = { state: 'queued', run };
    if (this.#active < URL_PREVIEW_MAX_ACTIVE) {
      this.#start(task);
    } else {
      if (this.#queued.length >= URL_PREVIEW_MAX_QUEUED) return null;
      this.#queued.push(task);
    }

    return {
      cancelQueued: (): boolean => {
        if (task.state !== 'queued') return false;
        const index = this.#queued.indexOf(task);
        if (index < 0) return false;
        this.#queued.splice(index, 1);
        task.state = 'settled';
        return true;
      },
    };
  }

  #start(task: QueueTask): void {
    task.state = 'active';
    this.#active += 1;
    void Promise.resolve()
      .then(task.run)
      .catch(() => undefined)
      .finally(() => {
        task.state = 'settled';
        this.#active -= 1;
        const next = this.#queued.shift();
        if (next) this.#start(next);
      });
  }
}

interface InFlightPreview {
  readonly promise: Promise<UrlPreviewLoadOutcome>;
}

interface PreviewScope {
  readonly lease: RealtimeDeliveryLease;
  readonly transport: PreviewTransport;
  readonly db: AppDatabase;
  readonly controller: AbortController;
  readonly key: string;
  ownsWork(): boolean;
  onInvalidated(listener: () => void): void;
  release(): void;
}

function cleanText(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function positiveWrite(result: UrlPreviewResult): PreviewWriteData | null {
  const siteName = cleanText(result.siteName);
  const title = cleanText(result.title) ?? siteName;
  const description = cleanText(result.description);
  const imageUrl = sanitizeUrlPreviewImageUrl(result.imageDataUrl);
  if (!title && !description && !imageUrl) return null;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(siteName ? { siteName } : {}),
  };
}

// Keep the historical service export used by focused loader tests while the cache policy itself
// lives beside the repository that owns the timestamps and limits.
export { isUrlPreviewCacheFresh } from '@db/repositories';

/**
 * Own automatic preview requests for the process. Work is coalesced only when URL, account
 * generation, and pinned server transport all match; a replacement account/transport starts a
 * distinct operation and cannot adopt the old result.
 */
export class UrlPreviewLoader {
  readonly #queue = new BoundedPreviewQueue();
  readonly #inFlight = new Map<string, InFlightPreview>();

  constructor(private readonly dependencies: UrlPreviewLoaderDependencies) {
    if (!!dependencies.runTrackedWork !== !!dependencies.writePreview) {
      throw new TypeError('URL preview loader test seams must be supplied together');
    }
  }

  load(url: string): Promise<UrlPreviewLoadOutcome> {
    const scope = this.#capture(url);
    return scope ? this.#enqueue(scope, url) : Promise.resolve('skipped');
  }

  /**
   * Read this account's cache first, then start a refresh only when that row is stale. Capturing the
   * complete account/transport/DB scope before the read prevents an A-to-B switch during that await
   * from sending account A's rendered URL through account B's authenticated server.
   */
  readAndLoadForSession(
    url: string,
    expectedIdentity: UrlPreviewSessionIdentity,
  ): Promise<UrlPreviewRow | null> {
    const scope = this.#capture(url, expectedIdentity);
    return scope ? this.#readAndLoad(scope, url) : Promise.resolve(null);
  }

  #capture(url: string, expectedIdentity?: UrlPreviewSessionIdentity): PreviewScope | null {
    if (
      typeof url !== 'string' ||
      url.length < 1 ||
      url.length > MAX_URL_CHARS ||
      !urlPreviewsApi.isUrlPreviewRequestUrl(url)
    ) {
      return null;
    }

    let lease: RealtimeDeliveryLease;
    let transport: PreviewTransport;
    let identity: UrlPreviewSessionIdentity;
    try {
      // Both identities are frozen synchronously, before a queue wait or network/DB await.
      identity = this.dependencies.captureSessionIdentity();
      if (
        expectedIdentity &&
        (identity.accountEpoch !== expectedIdentity.accountEpoch ||
          identity.transportRevision !== expectedIdentity.transportRevision)
      ) {
        return null;
      }
      lease = this.dependencies.captureLease();
      transport = this.dependencies.captureTransport();
    } catch {
      return null;
    }
    const key = JSON.stringify([identity.accountEpoch, lease.generation, transport.key, url]);
    const controller = new AbortController();
    let invalidated = false;
    let released = false;
    let invalidationListener: (() => void) | undefined;
    let unsubscribeRealtime: (() => void) | undefined;
    let unsubscribeTransport: (() => void) | undefined;
    const ownsWork = (): boolean => {
      if (
        invalidated ||
        controller.signal.aborted ||
        !lease.isCurrent() ||
        !transport.isCurrent()
      ) {
        return false;
      }
      try {
        const current = this.dependencies.captureSessionIdentity();
        return (
          current.accountEpoch === identity.accountEpoch &&
          current.transportRevision === identity.transportRevision
        );
      } catch {
        return false;
      }
    };
    const invalidate = (): void => {
      invalidated = true;
      if (!controller.signal.aborted) controller.abort();
      invalidationListener?.();
    };

    try {
      // Registration may call `invalidate` immediately. It is deliberately installed before the
      // first await so Disconnect can always see and stop this operation.
      unsubscribeRealtime = this.dependencies.subscribeInvalidation(lease.generation, invalidate);
      unsubscribeTransport = this.dependencies.subscribeTransportInvalidation(identity, invalidate);
    } catch {
      unsubscribeRealtime?.();
      return null;
    }
    if (!ownsWork()) {
      unsubscribeRealtime?.();
      unsubscribeTransport?.();
      return null;
    }

    let db: AppDatabase;
    try {
      // Capture the current account's handle before the work can wait behind another preview.
      db = this.dependencies.getDatabase();
    } catch {
      unsubscribeRealtime?.();
      unsubscribeTransport?.();
      return null;
    }

    return {
      lease,
      transport,
      db,
      controller,
      key,
      ownsWork,
      onInvalidated: (listener): void => {
        invalidationListener = listener;
        if (invalidated) listener();
      },
      release: (): void => {
        if (released) return;
        released = true;
        invalidationListener = undefined;
        unsubscribeRealtime?.();
        unsubscribeTransport?.();
      },
    };
  }

  async #readAndLoad(scope: PreviewScope, url: string): Promise<UrlPreviewRow | null> {
    let cached: UrlPreviewRow | null;
    try {
      cached = await this.dependencies.readPreview(scope.db, url);
    } catch {
      scope.release();
      return null;
    }
    if (!scope.ownsWork()) {
      scope.release();
      return null;
    }
    if (isUrlPreviewCacheFresh(cached, this.dependencies.now())) {
      scope.release();
      return cached;
    }

    // An expired row is not displayed past its TTL. Fetch/write failures settle quietly in the
    // background; the repository's reactive notification publishes a successful replacement.
    void this.#enqueue(scope, url);
    return null;
  }

  #enqueue(scope: PreviewScope, url: string): Promise<UrlPreviewLoadOutcome> {
    const existing = this.#inFlight.get(scope.key);
    if (existing) {
      scope.release();
      return existing.promise;
    }

    let ticket: QueueTicket | undefined;
    let job: InFlightPreview | undefined;
    let finished = false;
    let resolveOutcome!: (outcome: UrlPreviewLoadOutcome) => void;
    const promise = new Promise<UrlPreviewLoadOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const finish = (outcome: UrlPreviewLoadOutcome): void => {
      if (finished) return;
      finished = true;
      scope.release();
      if (job && this.#inFlight.get(scope.key) === job) this.#inFlight.delete(scope.key);
      resolveOutcome(outcome);
    };
    const invalidate = (): void => {
      if (job && this.#inFlight.get(scope.key) === job) this.#inFlight.delete(scope.key);
      if (ticket?.cancelQueued()) finish('stale');
    };

    job = { promise };
    this.#inFlight.set(scope.key, job);
    scope.onInvalidated(invalidate);
    if (finished || !scope.ownsWork()) {
      finish('stale');
      return promise;
    }

    const submitted = this.#queue.submit(async () => {
      let outcome: UrlPreviewLoadOutcome;
      try {
        outcome = await this.#run(scope, url);
      } catch {
        outcome = scope.ownsWork() ? 'failed' : 'stale';
      }
      finish(outcome);
    });
    ticket = submitted ?? undefined;
    if (!submitted) finish('queue_full');
    return promise;
  }

  async #run(scope: PreviewScope, url: string): Promise<UrlPreviewLoadOutcome> {
    if (!scope.ownsWork()) return 'stale';

    let result: UrlPreviewResult;
    try {
      result = await scope.transport.fetch(url, scope.controller.signal);
    } catch {
      if (!scope.ownsWork()) return 'stale';
      return this.#commit(scope, url, { error: true }, 'negative');
    }
    if (!scope.ownsWork()) return 'stale';

    const preview = positiveWrite(result);
    return preview
      ? this.#commit(scope, url, preview, 'stored')
      : this.#commit(scope, url, { error: true }, 'negative');
  }

  async #commit(
    scope: PreviewScope,
    url: string,
    data: PreviewWriteData,
    success: 'stored' | 'negative',
  ): Promise<UrlPreviewLoadOutcome> {
    if (!scope.ownsWork()) return 'stale';
    let stored = false;
    try {
      const runTrackedWork = this.dependencies.runTrackedWork;
      const writePreview = this.dependencies.writePreview;
      const tracked =
        runTrackedWork && writePreview
          ? await runTrackedWork(scope.lease, async () => {
              if (!scope.ownsWork()) return;
              await writePreview(scope.db, url, data, this.dependencies.now(), scope.ownsWork);
              stored = scope.ownsWork();
            })
          : await runTrackedRealtimeWork(scope.lease, async () => {
              if (!scope.ownsWork()) return;
              await withDbTransaction(
                scope.db,
                (context) =>
                  setUrlPreviewWithinTransaction(context, url, data, this.dependencies.now()),
                scope.ownsWork,
              );
              stored = scope.ownsWork();
            });
      return tracked === 'delivered' && stored && scope.ownsWork() ? success : 'stale';
    } catch {
      return scope.ownsWork() ? 'failed' : 'stale';
    }
  }
}

const loader = new UrlPreviewLoader({
  captureSessionIdentity: () => ({
    accountEpoch: sessionAccessors.getEpoch(),
    transportRevision: sessionAccessors.getTransportRevision(),
  }),
  captureLease: captureRealtimeDeliveryLease,
  subscribeInvalidation: subscribeRealtimeGenerationInvalidation,
  subscribeTransportInvalidation: (identity, listener): (() => void) => {
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (
        state.epoch !== identity.accountEpoch ||
        state.transportRevision !== identity.transportRevision
      ) {
        listener();
      }
    });
    const current = useSessionStore.getState();
    if (
      current.epoch !== identity.accountEpoch ||
      current.transportRevision !== identity.transportRevision
    ) {
      listener();
    }
    return unsubscribe;
  },
  captureTransport: (): PreviewTransport => {
    const pinned = http.pinTransport();
    const snapshot = pinned.snapshotTransport();
    return {
      key: JSON.stringify([snapshot.origin, snapshot.transportRevision ?? null]),
      isCurrent: () => pinned.isTransportCurrent(),
      fetch: (url, signal) => urlPreviewsApi.fetchUrlPreview(pinned, url, signal),
    };
  },
  getDatabase,
  readPreview: getUrlPreview,
  now: Date.now,
});

/** Read the scoped cache and, only after that read, quietly refresh a stale/missing row. */
export function readUrlPreviewAndLoad(
  url: string,
  expectedIdentity: UrlPreviewSessionIdentity,
): Promise<UrlPreviewRow | null> {
  return loader.readAndLoadForSession(url, expectedIdentity);
}
