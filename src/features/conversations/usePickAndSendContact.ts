import { useCallback } from 'react';
import { logger } from '@core/secure';
import { getContactsPermissionState } from '@/services/contacts/contactsService';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { isContactsPermissionDeniedError, pickAndSendContact } from '@/services/send';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { showDialog } from '@ui/dialog/dialogStore';
import {
  showContactsPermissionRationale,
  showContactsPermissionRecovery,
} from '@ui/permissions/contactsPermission';
import { observeQueueAdmission } from './observeQueueAdmission';

/**
 * Send Contact for the open chat: explain optional Contacts access when needed, open the native
 * contact picker, and send the chosen card. A denied permission offers recovery instead of failing
 * silently; a canceled picker stays silent.
 */
export function usePickAndSendContact(
  guid: string,
  accountLease: RealtimeDeliveryLease,
  contactCardAvailable: boolean,
): () => void {
  const runContactPicker = useCallback((): void => {
    if (!contactCardAvailable) return;
    const attempt = (): void => {
      void observeQueueAdmission(
        (onQueued) => pickAndSendContact(guid, accountLease, presentSendIssue, undefined, onQueued),
        () => undefined,
        (e) => {
          if (!accountLease.isCurrent()) return;
          if (isContactsPermissionDeniedError(e)) {
            showContactsPermissionRecovery({
              canAskAgain: e.canAskAgain,
              isCurrent: () => accountLease.isCurrent(),
              onTryAgain: attempt,
            });
            return;
          }
          logger.warn('[chat] contact pick/send failed', e);
        },
      );
    };
    attempt();
  }, [accountLease, contactCardAvailable, guid]);
  const onPickContact = useCallback((): void => {
    void getContactsPermissionState()
      .then((permission) => {
        if (!accountLease.isCurrent()) return;
        if (permission.status === 'granted') {
          runContactPicker();
          return;
        }
        if (permission.status === 'denied' && !permission.canAskAgain) {
          showContactsPermissionRecovery({
            canAskAgain: false,
            isCurrent: () => accountLease.isCurrent(),
            onTryAgain: runContactPicker,
          });
          return;
        }
        showContactsPermissionRationale({
          purpose: 'share',
          isCurrent: () => accountLease.isCurrent(),
          onContinue: runContactPicker,
        });
      })
      .catch((error) => {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] contact permission check failed', error);
          showDialog(
            'Contacts',
            'Contacts access is unavailable. You can keep messaging without sharing a contact card.',
          );
        }
      });
  }, [accountLease, runContactPicker]);
  return onPickContact;
}
