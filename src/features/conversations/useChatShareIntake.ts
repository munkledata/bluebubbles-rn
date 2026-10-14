import { useCallback, useEffect, useRef, useState } from 'react';
import type { Href, useRouter } from 'expo-router';
import { logger } from '@core/secure';
import { DRAFT_KV_PREFIX, type ShareIntakeManifestIdentity } from '@db/repositories';
import { runAccountOperation } from '@/services/realtime/accountOperation';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  admitShareIntakeTextDraft,
  consumeShareIntakeBatch,
  discardShareIntakeItem,
  drainShareIntake,
  isShareIntakeFileSettled,
  isShareIntakeReceiptComplete,
  readShareIntakeReceipt,
} from '@/services/share/shareIntake';
import { useShareIntentStore } from '@state/shareIntentStore';
import { showToast, type PendingAttachment } from '@ui';
import type { ComposerAdmissionResult } from '@ui/conversations/useComposerAuthoringSession';
import { showDialog, type DialogButton } from '@ui/dialog/dialogStore';

export interface ChatShareIntakeOptions {
  guid: string;
  /** The `shareBatch` route param: the native share this chat was opened for, if any. */
  shareBatchId: string | undefined;
  accountLease: RealtimeDeliveryLease;
  /** Must keep one identity across renders (the screen passes `useRouter()`). */
  router: Pick<ReturnType<typeof useRouter>, 'replace'>;
  /** The chat's saved draft (null until loaded). Shared text is merged into it. */
  draft: string | null;
  /**
   * Must keep one identity across renders (the screen passes its `useState` setter): the receipt
   * load and the shared-text merge re-run whenever `router` or `setDraft` changes identity.
   */
  setDraft: (draft: string) => void;
  attachmentFeaturesAvailable: boolean;
  serverInfoLoaded: boolean;
  /** The guid of the loaded chat header, or undefined while it loads. */
  headerGuid: string | undefined;
}

/**
 * A native share (Android share sheet or Direct Share) opened into this chat.
 *
 * The chat claims only the exact share batch its route names. It first loads the share's durable
 * receipt: a share already bound to another chat (or to a new-chat plan) is redirected there, and
 * items already handled are not offered again. Shared files become composer attachments; shared
 * text merges into the chat's draft once that merge and the receipt commit together. When every
 * item is settled, the batch is consumed and the next pending share starts. Files this chat cannot
 * take are offered another conversation instead of only "Discard".
 *
 * The screen's Back handling reads `shareBatchPending`, clears it after discarding the batch, and
 * lets the route's own share redirects through via `bypassNextRemovalRef`.
 */
export function useChatShareIntake({
  guid,
  shareBatchId,
  accountLease,
  router,
  draft,
  setDraft,
  attachmentFeaturesAvailable,
  serverInfoLoaded,
  headerGuid,
}: ChatShareIntakeOptions) {
  // Capture only the exact native claim carried by this route. Keep provenance so durable send
  // adoption copies from the native no-backup queue into the ordinary attachment cache.
  const [ownedShareIdentity] = useState<ShareIntakeManifestIdentity | null>(() => {
    const share = useShareIntentStore.getState();
    return typeof shareBatchId === 'string' &&
      share.batchId === shareBatchId &&
      share.createdAtMs != null
      ? {
          batchId: share.batchId,
          nativeCreatedAtMs: share.createdAtMs,
          hasText: share.text !== null,
          fileCount: share.files.length,
        }
      : null;
  });
  const ownedShareBatchId = ownedShareIdentity?.batchId ?? null;
  const [sharedAttachments] = useState<PendingAttachment[]>(() =>
    ownedShareBatchId
      ? useShareIntentStore.getState().files.map((file) => ({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          origin: file.origin,
          shareItemIndex: file.shareItemIndex,
        }))
      : [],
  );
  const [sharedText] = useState<string | null>(() =>
    ownedShareBatchId ? useShareIntentStore.getState().text : null,
  );
  const [shareBatchPending, setShareBatchPending] = useState(ownedShareBatchId !== null);
  const [remainingSharedAttachments, setRemainingSharedAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const [shareReceiptLoaded, setShareReceiptLoaded] = useState(ownedShareBatchId === null);
  const [sharedTextReady, setSharedTextReady] = useState(sharedText === null);
  const [sharedTextAlreadyApplied, setSharedTextAlreadyApplied] = useState(false);
  // The share's receipt already names this chat (its text merged or an item settled here), so the
  // share can no longer move to another conversation.
  const [shareBoundHere, setShareBoundHere] = useState(false);
  // The person chose to keep the shared text here although its files cannot come along.
  const [sharedTextChosenHere, setSharedTextChosenHere] = useState(false);
  const shareFinalizingRef = useRef(false);

  const finalizeShareIfReady = useCallback((): void => {
    if (!ownedShareBatchId || !shareBatchPending || !accountLease.isCurrent()) return;
    if (!ownedShareIdentity || shareFinalizingRef.current) return;
    shareFinalizingRef.current = true;
    void runAccountOperation(accountLease, async () => {
      const receipt = await readShareIntakeReceipt(ownedShareIdentity);
      if (!receipt || !isShareIntakeReceiptComplete(receipt)) return false;
      return consumeShareIntakeBatch(ownedShareBatchId, {
        lease: accountLease,
        drainNext: false,
      });
    })
      .then((result) => {
        if (result.ok && result.value) {
          setShareBatchPending(false);
          void drainShareIntake();
        } else {
          shareFinalizingRef.current = false;
        }
      })
      .catch((error: unknown) => {
        shareFinalizingRef.current = false;
        if (!accountLease.isCurrent()) return;
        logger.warn('[chat] shared batch completion failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showToast('Gator could not finish the share handoff. Your draft is still here.');
      });
  }, [accountLease, ownedShareBatchId, ownedShareIdentity, shareBatchPending]);

  const onShareAdmissionApplied = useCallback(
    (_result: ComposerAdmissionResult): void => {
      if (!ownedShareBatchId || !shareBatchPending || !accountLease.isCurrent()) return;
      finalizeShareIfReady();
    },
    [accountLease, finalizeShareIfReady, ownedShareBatchId, shareBatchPending],
  );

  const onRemoveSharedAttachment = useCallback(
    async (item: PendingAttachment): Promise<boolean> => {
      if (item.origin !== 'share') return true;
      if (!ownedShareIdentity || item.shareItemIndex == null || !accountLease.isCurrent()) {
        return false;
      }
      try {
        const outcome = await runTrackedRealtimeWork(accountLease, async () =>
          discardShareIntakeItem(
            {
              identity: ownedShareIdentity,
              chatGuid: guid,
              itemIndex: item.shareItemIndex!,
              appliedAtMs: Date.now(),
            },
            () => accountLease.isCurrent(),
          ),
        );
        if (outcome !== 'delivered' || !accountLease.isCurrent()) return false;
        finalizeShareIfReady();
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] shared attachment discard failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          showToast('Gator could not safely remove that shared file. Try again.');
        }
        return false;
      }
    },
    [accountLease, finalizeShareIfReady, guid, ownedShareIdentity],
  );

  // The route's own share redirects keep their batch, so the removal guard below must let them
  // through. Expo Router queues replace and runs the guard from that queue during the render it
  // schedules; clear an unused bypass only on a later task, after that has happened.
  const bypassNextRemovalRef = useRef(false);
  const replaceWithoutPrompt = useCallback(
    (href: Href): void => {
      bypassNextRemovalRef.current = true;
      try {
        router.replace(href);
      } finally {
        setTimeout(() => {
          bypassNextRemovalRef.current = false;
        }, 0);
      }
    },
    [router],
  );

  // Load the durable receipt before exposing native files. A replay filters already-admitted file
  // ordinals and forces any partially handled batch back to its original destination.
  useEffect(() => {
    if (!ownedShareIdentity || !accountLease.isCurrent()) return;
    let alive = true;
    let loadedReceipt: Awaited<ReturnType<typeof readShareIntakeReceipt>> = null;
    void runTrackedRealtimeWork(accountLease, async () => {
      loadedReceipt = await readShareIntakeReceipt(ownedShareIdentity);
    })
      .then((outcome) => {
        if (outcome === 'paused' || !alive || !accountLease.isCurrent()) return;
        const receipt = loadedReceipt;
        if (receipt?.destination && receipt.destination.chatGuid !== guid) {
          replaceWithoutPrompt(
            `/chat/${encodeURIComponent(receipt.destination.chatGuid)}?shareBatch=${encodeURIComponent(ownedShareIdentity.batchId)}`,
          );
          return;
        }
        if (receipt?.newChatPlan && !receipt.destination) {
          replaceWithoutPrompt(
            `/new-chat?shareBatch=${encodeURIComponent(ownedShareIdentity.batchId)}`,
          );
          return;
        }
        setRemainingSharedAttachments(
          sharedAttachments.filter(
            (file) =>
              file.shareItemIndex == null ||
              !isShareIntakeFileSettled(receipt, file.shareItemIndex),
          ),
        );
        if (sharedText && receipt?.items.text) {
          setSharedTextAlreadyApplied(true);
          setSharedTextReady(true);
        }
        setShareBoundHere(receipt?.destination?.chatGuid === guid);
        setShareReceiptLoaded(true);
        if (receipt && isShareIntakeReceiptComplete(receipt)) finalizeShareIfReady();
      })
      .catch((error: unknown) => {
        if (!alive || !accountLease.isCurrent()) return;
        logger.warn('[chat] shared receipt reconciliation failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showToast('Gator could not safely resume this share. Its files were not sent.');
      });
    return () => {
      alive = false;
    };
  }, [
    accountLease,
    finalizeShareIfReady,
    guid,
    ownedShareIdentity,
    replaceWithoutPrompt,
    sharedAttachments,
    sharedText,
  ]);

  // After a cold start server info and the header load in the background; "not loaded yet" is not
  // "unsupported", so files count as blocked only once both are known.
  const sharedFilesBlocked =
    ownedShareBatchId !== null &&
    shareReceiptLoaded &&
    remainingSharedAttachments.length > 0 &&
    !attachmentFeaturesAvailable &&
    serverInfoLoaded &&
    headerGuid === guid;

  // Text becomes removable from native storage only when its exact draft merge and replay receipt
  // commit together in the encrypted database. Merging binds the whole share to this chat, so while
  // its files are known not to fit here it waits for the person's choice.
  const sharedTextPersistStartedRef = useRef(false);
  useEffect(() => {
    if (
      !ownedShareBatchId ||
      !ownedShareIdentity ||
      !sharedText ||
      draft === null ||
      !shareReceiptLoaded ||
      sharedTextAlreadyApplied ||
      (sharedFilesBlocked && !shareBoundHere && !sharedTextChosenHere) ||
      sharedTextPersistStartedRef.current ||
      !accountLease.isCurrent()
    ) {
      return;
    }
    sharedTextPersistStartedRef.current = true;
    let admittedDraft: string | null = null;
    void runTrackedRealtimeWork(accountLease, async () => {
      const result = await admitShareIntakeTextDraft(
        {
          identity: ownedShareIdentity,
          chatGuid: guid,
          sharedText,
          draftKey: `${DRAFT_KV_PREFIX}${guid}`,
          appliedAtMs: Date.now(),
        },
        () => accountLease.isCurrent(),
      );
      admittedDraft = result.draft;
    })
      .then((outcome) => {
        if (outcome !== 'delivered' || admittedDraft === null || !accountLease.isCurrent()) return;
        setDraft(admittedDraft);
        setShareBoundHere(true);
        setSharedTextReady(true);
        finalizeShareIfReady();
      })
      .catch((error: unknown) => {
        sharedTextPersistStartedRef.current = false;
        if (accountLease.isCurrent()) {
          logger.warn('[chat] shared text draft persist failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      });
  }, [
    accountLease,
    draft,
    finalizeShareIfReady,
    guid,
    ownedShareBatchId,
    ownedShareIdentity,
    setDraft,
    shareBoundHere,
    shareReceiptLoaded,
    sharedFilesBlocked,
    sharedText,
    sharedTextAlreadyApplied,
    sharedTextChosenHere,
  ]);

  const removeBlockedSharedFiles = useCallback(async (): Promise<void> => {
    for (const item of remainingSharedAttachments) {
      if (!(await onRemoveSharedAttachment(item))) return;
    }
    if (accountLease.isCurrent()) setRemainingSharedAttachments([]);
  }, [accountLease, onRemoveSharedAttachment, remainingSharedAttachments]);

  // Shared files this chat can't take used to leave only "Discard": offer a way forward instead.
  // A share nothing has used yet can still move to another conversation, files and all.
  const sharedFilesDialogBatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sharedFilesBlocked || !ownedShareBatchId) return;
    if (sharedFilesDialogBatchRef.current === ownedShareBatchId) return;
    sharedFilesDialogBatchRef.current = ownedShareBatchId;
    const title = 'This conversation can’t receive files';
    if (shareBoundHere) {
      showDialog(
        title,
        'Part of this share is already in this conversation, which can’t take its files. Remove the files to finish sharing, or leave them for now.',
        [
          { text: 'Not Now', style: 'cancel' },
          {
            text: 'Remove Files',
            style: 'destructive',
            onPress: () => void removeBlockedSharedFiles(),
          },
        ],
      );
      return;
    }
    const batchId = ownedShareBatchId;
    const buttons: DialogButton[] = [
      {
        text: 'Not Now',
        style: 'cancel',
        // The composer waits for shared text, so "not now" keeps the text here; the files wait.
        onPress: sharedText ? () => setSharedTextChosenHere(true) : undefined,
      },
    ];
    if (sharedText) {
      buttons.push({
        text: 'Use Text Only',
        onPress: () => {
          setSharedTextChosenHere(true);
          void removeBlockedSharedFiles();
        },
      });
    }
    buttons.push({
      text: 'Choose Another Conversation',
      onPress: () => {
        if (accountLease.isCurrent()) {
          replaceWithoutPrompt(`/new-chat?shareBatch=${encodeURIComponent(batchId)}`);
        }
      },
    });
    showDialog(
      title,
      sharedText
        ? 'Send the shared text and files to another conversation, or use only the text here.'
        : 'Send the shared files to another conversation instead.',
      buttons,
    );
  }, [
    accountLease,
    ownedShareBatchId,
    removeBlockedSharedFiles,
    replaceWithoutPrompt,
    shareBoundHere,
    sharedFilesBlocked,
    sharedText,
  ]);

  return {
    ownedShareIdentity,
    ownedShareBatchId,
    shareBatchPending,
    setShareBatchPending,
    remainingSharedAttachments,
    shareReceiptLoaded,
    sharedTextReady,
    onShareAdmissionApplied,
    onRemoveSharedAttachment,
    bypassNextRemovalRef,
  };
}
