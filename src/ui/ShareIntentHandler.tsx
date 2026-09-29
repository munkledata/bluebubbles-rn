import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { logger } from '@core/secure';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import {
  consumeShareIntakeBatchIfComplete,
  drainShareIntake,
  isShareIntakeReceiptComplete,
  readShareIntakeReceipt,
  startShareIntake,
} from '@/services/share/shareIntake';
import { resolveShareShortcutTarget } from '@/services/shortcuts/shareShortcuts';
import { useShareIntentStore } from '@state/shareIntentStore';
import { showToast } from './toast/toastStore';
import { useChatNavigator } from './useChatNavigator';
import { LoadErrorBoundary } from './LoadErrorBoundary';

/**
 * Native capture lives above App Lock. It stages only complete app-private batches and never opens
 * a route or renders shared content while the protected tree is unavailable.
 */
function ShareIntentCaptureInner(): null {
  useEffect(() => startShareIntake(), []);
  return null;
}

export function ShareIntentCapture(): React.JSX.Element {
  return (
    <LoadErrorBoundary fallback={null} onError={() => logger.warn('[share] capture failed')}>
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
  return 'Gator could not import that shared item.';
}

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
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [routeRetryNonce, setRouteRetryNonce] = useState(0);
  const routedBatchRef = useRef<string | null>(null);
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
      if (receiptStatus !== 'delivered' || !accountLease.isCurrent()) return;
      const { receipt, completedDestination } = reconciliation;
      if (completedDestination) {
        // A successful acknowledgement clears this exact Zustand batch, which cleans up this
        // effect. The protected navigator itself is still mounted, so use its lifetime—not the old
        // batch dependency's `active` flag—to finish the already-owned route.
        if (!mountedRef.current) return;
        routeFailuresRef.current = { batchId, count: 0 };
        logger.debug('[share] opening completed receipt destination');
        openChat(`/chat/${encodeURIComponent(completedDestination)}`);
        void drainShareIntake();
        return;
      }
      if (!active) return;
      if (receipt?.destination) {
        routeFailuresRef.current = { batchId, count: 0 };
        logger.debug('[share] resuming partial receipt destination');
        openChat(
          `/chat/${encodeURIComponent(receipt.destination.chatGuid)}?shareBatch=${encodeURIComponent(batchId)}`,
        );
        return;
      }
      if (receipt?.newChatPlan) {
        routeFailuresRef.current = { batchId, count: 0 };
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
        return;
      }
      const encodedBatch = encodeURIComponent(batchId);
      routeFailuresRef.current = { batchId, count: 0 };
      if (resolved) {
        logger.debug('[share] opening resolved Direct Share target');
        openChat(`/chat/${encodeURIComponent(resolved)}?shareBatch=${encodedBatch}`);
      } else {
        logger.debug('[share] opening generic recipient review');
        router.push(`/new-chat?shareBatch=${encodedBatch}`);
      }
    })().catch((error: unknown) => {
      if (!active || !accountLease.isCurrent()) return;
      routedBatchRef.current = null;
      const failureCount = routeFailuresRef.current.count + 1;
      routeFailuresRef.current = { batchId, count: failureCount };
      logger.warn('[share] navigation failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      if (failureCount <= 2) {
        showToast('Gator could not open the shared item. Retrying…');
        setRouteRetryNonce((current) => current + 1);
        return;
      }
      showToast('Gator could not open the shared item. Review it to retry or discard it.');
      router.push(`/new-chat?shareBatch=${encodeURIComponent(batchId)}`);
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
  return (
    <LoadErrorBoundary fallback={null} onError={() => logger.warn('[share] navigator failed')}>
      <ShareIntentNavigatorInner />
    </LoadErrorBoundary>
  );
}
