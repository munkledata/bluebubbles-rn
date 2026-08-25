import type { EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import type { DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  cancelSendFailureNotification,
  postSendFailureNotification,
} from '../notifications/notifeeService';

function deliveryContext(commitGuard?: DbCommitGuard): EventDeliveryContext | undefined {
  return commitGuard ? { generation: -1, isCurrent: commitGuard } : undefined;
}

/** A native presentation failure must never roll back or disguise the durable send outcome. */
export async function notifyFailedSend(
  db: AppDatabase,
  chatGuid: string,
  messageGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  if (commitGuard && !commitGuard()) return;
  try {
    await postSendFailureNotification(db, chatGuid, messageGuid, deliveryContext(commitGuard));
  } catch (error) {
    if (commitGuard && !commitGuard()) return;
    logger.warn('[send] failed to post failure notice', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

/** Withdraw stale failure state after the same durable row reconciles successfully. */
export async function clearFailedSendNotice(
  db: AppDatabase,
  messageGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  if (commitGuard && !commitGuard()) return;
  try {
    await cancelSendFailureNotification(db, messageGuid, deliveryContext(commitGuard));
  } catch (error) {
    if (commitGuard && !commitGuard()) return;
    logger.warn('[send] failed to clear failure notice', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
