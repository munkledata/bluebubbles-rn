import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logger } from '@core/secure';
import { runTrackedRealtimeWork } from '@/services/realtime/deliveryCoordinator';
import {
  consumeShareIntakeBatchIfComplete,
  drainShareIntake,
  isShareIntakeReceiptComplete,
  noteShareIntakeForeground,
  readShareIntakeReceipt,
  startShareIntake,
} from '@/services/share/shareIntake';
import { resolveShareShortcutTarget } from '@/services/shortcuts/shareShortcuts';
import { useShareIntentStore } from '@state/shareIntentStore';
import { showToast } from './toast/toastStore';
import { useChatNavigator } from './useChatNavigator';
import { LoadErrorBoundary } from './LoadErrorBoundary';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

/**
 * Native capture lives above App Lock. It stages only complete app-private batches and never opens
 * a route or renders shared content while the protected tree is unavailable.
 */
function ShareIntentCaptureInner(): null {
  useEffect(() => startShareIntake(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') noteShareIntakeForeground();
    });
    return () => subscription.remove();
  }, []);
  return null;
}

/**
 * A share boundary that failed renders nothing until the app restarts. Remount it the next time the
 * app comes to the foreground, so a one-off failure cannot stop sharing for the rest of the run.
 */
function useBoundaryResetOnForeground(stage: 'signal' | 'route'): {
  resetKey: number;
  markFailed: () => void;
} {
  const [resetKey, setResetKey] = useState(0);
  const failedRef = useRef(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !failedRef.current) return;
      failedRef.current = false;
      logger.event('share.intake', { stage, outcome: 'boundary-reset' });
      setResetKey((key) => key + 1);
    });
    return () => subscription.remove();
  }, [stage]);
  const markFailed = useCallback(() => {
    failedRef.current = true;
  }, []);
  return { resetKey, markFailed };
}

export function ShareIntentCapture(): React.JSX.Element {
  const { resetKey, markFailed } = useBoundaryResetOnForeground('signal');
  return (
    <LoadErrorBoundary
      key={resetKey}
      fallback={null}
      onError={() => {
        logger.warn('[share] capture failed');
        markFailed();
      }}
    >
      <ShareIntentCaptureInner />
    </LoadErrorBoundary>
  );
}

function rejectionMessage(reason: string): string {
  if (reason === 'count') return 'Too many items were shared at once.';
  if (reason === 'file_size' || reason === 'batch_size' || reason === 'cache_quota') {
    return 'The shared items are too large for Gator.';
  }
  if (reason === 'deadline' || reason === 'busy') {
    return 'Gator could not finish importing that share. Try again.';
  }
  if (reason === 'permission') return 'The sending app did not grant access to the shared file.';
  if (reason === 'pickup') {
    return 'Gator could not open a shared item. It will try again the next time you open Gator.';
  }
  return 'Gator could not import that shared item.';
}

/** A route just sent gets this long to show its screen before the held share counts as unshown. */
const REROUTE_GRACE_MS = 3_000;

/** Resolve and route one exact native claim only after the connected, unlocked tree exists. */
function ShareIntentNavigatorInner(): null {
  const router = useRouter();
  const openChat = useChatNavigator();
  const batchId = useShareIntentStore((state) => state.batchId);
  const createdAtMs = useShareIntentStore((state) => state.createdAtMs);
  const targetToken = useShareIntentStore((state) => state.targetToken);
  const text = useShareIntentStore((state) => state.text);
  const files = useShareIntentStore((state) => state.files);
  const failureReason = useShareIntentStore((state) => state.failureReason);
  const rerouteRequest = useShareIntentStore((state) => state.rerouteRequest);
  const waitingNotice = useShareIntentStore((state) => state.waitingNotice);
  const accountLease = useScreenAccountLease();
  const [routeRetryNonce, setRouteRetryNonce] = useState(0);
  const routedBatchRef = useRef<string | null>(null);
  // Requests and notices from before this mount are moot: a fresh navigator routes the held batch.
  const handledRerouteRef = useRef(rerouteRequest);
  const shownNoticeRef = useRef(waitingNotice);
  const routingRef = useRef(false);
  const lastRoutedAtRef = useRef(0);
  const routeFailuresRef = useRef<{ batchId: string | null; count: number }>({
    batchId: null,
    count: 0,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!failureReason) return;
    showToast(rejectionMessage(failureReason));
    useShareIntentStore.getState().clearFailureReason();
  }, [failureReason]);

  useEffect(() => {
    if (waitingNotice === shownNoticeRef.current) return;
    shownNoticeRef.current = waitingNotice;
    showToast('Finish or discard your earlier shared item; your new share is waiting.');
  }, [waitingNotice]);

  // Open the held batch again when no screen shows it: its route was dropped, or its screen closed
  // without settling. A route still being worked out, or sent moments ago, is left to land.
  useEffect(() => {
    if (rerouteRequest === handledRerouteRef.current) return;
    handledRerouteRef.current = rerouteRequest;
    const state = useShareIntentStore.getState();
    if (
      state.batchId === null ||
      routedBatchRef.current !== state.batchId ||
      state.owners !== 0 ||
      routingRef.current ||
      Date.now() - lastRoutedAtRef.current < REROUTE_GRACE_MS
    ) {
      return;
    }
    routedBatchRef.current = null;
    logger.event('share.intake', { stage: 'route', outcome: 'reopened' });
    setRouteRetryNonce((current) => current + 1);
  }, [rerouteRequest]);

  useEffect(() => {
    if (batchId === null) {
      routedBatchRef.current = null;
      routeFailuresRef.current = { batchId: null, count: 0 };
      return;
    }
    if (routeFailuresRef.current.batchId !== batchId) {
      routeFailuresRef.current = { batchId, count: 0 };
    }
    if (routedBatchRef.current === batchId || !accountLease.isCurrent()) return;
    routedBatchRef.current = batchId;
    // A navigator remounted after a failure can find a screen still showing this batch. Leave it
    // there; if that screen closes without settling the batch, a reopen request routes it again.
    if (useShareIntentStore.getState().owners > 0) return;
    routingRef.current = true;
    let active = true;

    void (async () => {
      if (createdAtMs == null) throw new Error('staged share has no native creation time');
      const identity = {
        batchId,
        nativeCreatedAtMs: createdAtMs,
        hasText: text !== null,
        fileCount: files.length,
      };
      const reconciliation: {
        receipt?: Awaited<ReturnType<typeof readShareIntakeReceipt>>;
        completedDestination?: string;
      } = {};
      const receiptStatus = await runTrackedRealtimeWork(accountLease, async () => {
        const receipt = await readShareIntakeReceipt(identity);
        reconciliation.receipt = receipt;
        if (receipt?.destination && isShareIntakeReceiptComplete(receipt)) {
          if (
            !(await consumeShareIntakeBatchIfComplete(identity, {
              lease: accountLease,
              drainNext: false,
            }))
          ) {
            throw new Error('complete shared receipt could not be acknowledged');
          }
          reconciliation.completedDestination = receipt.destination.chatGuid;
        }
      });
      if (receiptStatus !== 'delivered' || !accountLease.isCurrent()) {
        logger.event('share.intake', { stage: 'route', outcome: 'not-delivered' });
        return;
      }
      const { receipt, completedDestination } = reconciliation;
      if (completedDestination) {
        // A successful acknowledgement clears this exact Zustand batch, which cleans up this
        // effect. The protected navigator itself is still mounted, so use its lifetime—not the old
        // batch dependency's `active` flag—to finish the already-owned route.
        if (!mountedRef.current) {
          logger.event('share.intake', { stage: 'route', outcome: 'inactive' });
          return;
        }
        routeFailuresRef.current = { batchId, count: 0 };
        logger.event('share.intake', { stage: 'route', outcome: 'completed' });
        logger.debug('[share] opening completed receipt destination');
        openChat(`/chat/${encodeURIComponent(completedDestination)}`);
        void drainShareIntake();
        return;
      }
      if (!active) {
        logger.event('share.intake', { stage: 'route', outcome: 'inactive' });
        return;
      }
      if (receipt?.destination) {
        routeFailuresRef.current = { batchId, count: 0 };
        logger.event('share.intake', { stage: 'route', outcome: 'resume-chat' });
        logger.debug('[share] resuming partial receipt destination');
        openChat(
          `/chat/${encodeURIComponent(receipt.destination.chatGuid)}?shareBatch=${encodeURIComponent(batchId)}`,
        );
        return;
      }
      if (receipt?.newChatPlan) {
        routeFailuresRef.current = { batchId, count: 0 };
        logger.event('share.intake', { stage: 'route', outcome: 'resume-new-chat' });
        logger.debug('[share] resuming durable new-chat plan');
        router.push(`/new-chat?shareBatch=${encodeURIComponent(batchId)}`);
        return;
      }
      const resolved = targetToken
        ? await resolveShareShortcutTarget(targetToken, accountLease)
        : null;
      if (
        !active ||
        !accountLease.isCurrent() ||
        useShareIntentStore.getState().batchId !== batchId
      ) {
        logger.event('share.intake', { stage: 'route', outcome: 'inactive' });
        return;
      }
      const encodedBatch = encodeURIComponent(batchId);
      routeFailuresRef.current = { batchId, count: 0 };
      if (resolved) {
        logger.event('share.intake', { stage: 'route', outcome: 'chat', target: 'resolved' });
        logger.debug('[share] opening resolved Direct Share target');
        openChat(`/chat/${encodeURIComponent(resolved)}?shareBatch=${encodedBatch}`);
      } else {
        logger.event('share.intake', {
          stage: 'route',
          outcome: 'new-chat',
          target: targetToken ? 'unresolved' : 'none',
        });
        logger.debug('[share] opening generic recipient review');
        router.push(`/new-chat?shareBatch=${encodedBatch}`);
      }
    })()
      .catch((error: unknown) => {
        if (!active || !accountLease.isCurrent()) {
          logger.event('share.intake', { stage: 'route', outcome: 'inactive' });
          return;
        }
        routedBatchRef.current = null;
        const failureCount = routeFailuresRef.current.count + 1;
        routeFailuresRef.current = { batchId, count: failureCount };
        logger.warn('[share] navigation failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        if (failureCount <= 2) {
          logger.event('share.intake', { stage: 'route', outcome: 'retry' });
          showToast('Gator could not open the shared item. Retrying…');
          setRouteRetryNonce((current) => current + 1);
          return;
        }
        logger.event('share.intake', { stage: 'route', outcome: 'review' });
        showToast('Gator could not open the shared item. Review it to retry or discard it.');
        router.push(`/new-chat?shareBatch=${encodeURIComponent(batchId)}`);
      })
      .finally(() => {
        routingRef.current = false;
        lastRoutedAtRef.current = Date.now();
      });

    return () => {
      active = false;
    };
  }, [
    accountLease,
    batchId,
    createdAtMs,
    files,
    openChat,
    routeRetryNonce,
    router,
    targetToken,
    text,
  ]);

  return null;
}

/** Connected-layout consumer; App Lock unmounts it while shared content must remain hidden. */
export function ShareIntentNavigator(): React.JSX.Element {
  const { resetKey, markFailed } = useBoundaryResetOnForeground('route');
  return (
    <LoadErrorBoundary
      key={resetKey}
      fallback={null}
      onError={() => {
        logger.warn('[share] navigator failed');
        markFailed();
      }}
    >
      <ShareIntentNavigatorInner />
    </LoadErrorBoundary>
  );
}
