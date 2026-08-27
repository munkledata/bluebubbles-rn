import type { DiscardMessageResult, ManualRetryResult, SendOperationIssue } from '@/services/send';
import { showToast } from '../toast/toastStore';

/** UI copy for a typed issue reported by a user-initiated send operation. */
export function presentSendIssue(issue: SendOperationIssue): void {
  if (issue === 'queue-capacity') {
    showToast('Too many messages are waiting—try again in a moment');
  }
}

/** UI copy for the non-success states of a manual failed-message retry. */
export function presentManualRetryResult(result: ManualRetryResult): void {
  switch (result) {
    case 'already-sending':
      showToast('Already trying to send this message');
      break;
    case 'already-settled':
      showToast('Message was already sent');
      break;
    case 'unretryable':
      showToast('This message can’t be sent again');
      break;
    case 'unsendable':
      showToast('Original file is no longer available');
      break;
    case 'failed':
      showToast('Couldn’t retry — try again in a moment');
      break;
    case 'retried':
    case 'stale':
      break;
  }
}

/** UI copy for a delete whose selected temporary identity can no longer be proved. */
export function presentDiscardMessageResult(result: DiscardMessageResult): void {
  if (result === 'message-changed') showToast('Message changed—select it again');
}
