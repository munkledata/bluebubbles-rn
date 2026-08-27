import { Linking } from 'react-native';
import { showDialog } from '../dialog/dialogStore';

type ContactsPurpose = 'sync' | 'share';

function rationale(purpose: ContactsPurpose): string {
  const use =
    purpose === 'sync'
      ? 'show saved names and photos in conversations'
      : 'let you choose a device contact to send as a contact card';
  return `Gator can read your device contacts to ${use}. This is optional. You can still type phone numbers and email addresses without allowing Contacts access.`;
}

/** Explain optional Contacts access before the caller is allowed to launch Android's prompt. */
export function showContactsPermissionRationale(options: {
  purpose: ContactsPurpose;
  isCurrent: () => boolean;
  onContinue: () => void;
}): void {
  if (!options.isCurrent()) return;
  showDialog('Allow Contacts access?', rationale(options.purpose), [
    { text: 'Not Now', style: 'cancel' },
    {
      text: 'Continue',
      onPress: () => {
        if (options.isCurrent()) options.onContinue();
      },
    },
  ]);
}

export async function openContactsPermissionSettings(isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  try {
    await Linking.openSettings();
  } catch {
    if (isCurrent()) {
      showDialog('Contacts', 'Couldn’t open Android app settings. Open Settings and select Gator.');
    }
  }
}

/** Keep both a normal denial and Android's permanent denial actionable. */
export function showContactsPermissionRecovery(options: {
  canAskAgain: boolean;
  isCurrent: () => boolean;
  onTryAgain: () => void;
}): void {
  if (!options.isCurrent()) return;
  const action = options.canAskAgain
    ? {
        text: 'Try Again',
        onPress: () => {
          if (options.isCurrent()) options.onTryAgain();
        },
      }
    : {
        text: 'Open Settings',
        onPress: () => void openContactsPermissionSettings(options.isCurrent),
      };
  showDialog(
    'Contacts access denied',
    options.canAskAgain
      ? 'Gator still works without Contacts access. You can try again or keep typing phone numbers and email addresses manually.'
      : 'Android won’t show the Contacts prompt again. Gator still works with manually typed phone numbers and email addresses; to enable contacts, open Gator’s app settings.',
    [{ text: 'Not Now', style: 'cancel' }, action],
  );
}
