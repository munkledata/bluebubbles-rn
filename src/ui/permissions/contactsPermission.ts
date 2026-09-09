import { Linking } from 'react-native';
import { createI18n, type I18n } from '@utils/i18n';
import { showDialog } from '../dialog/dialogStore';

type ContactsPurpose = 'sync' | 'share';

function rationale(i18n: I18n, purpose: ContactsPurpose): string {
  const key =
    purpose === 'sync'
      ? 'contactsPermission.dialog.rationale.message.sync'
      : 'contactsPermission.dialog.rationale.message.share';
  return i18n.format(key, { appName: i18n.text('welcome.brand') });
}

/** Explain optional Contacts access before the caller is allowed to launch Android's prompt. */
export function showContactsPermissionRationale(options: {
  purpose: ContactsPurpose;
  isCurrent: () => boolean;
  onContinue: () => void;
}): void {
  if (!options.isCurrent()) return;
  const i18n = createI18n();
  showDialog(
    i18n.text('contactsPermission.dialog.rationale.title'),
    rationale(i18n, options.purpose),
    [
      { text: i18n.text('contactsPermission.action.notNow'), style: 'cancel' },
      {
        text: i18n.text('contactsPermission.action.continue'),
        onPress: () => {
          if (options.isCurrent()) options.onContinue();
        },
      },
    ],
  );
}

export async function openContactsPermissionSettings(isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  const i18n = createI18n();
  try {
    await Linking.openSettings();
  } catch {
    if (isCurrent()) {
      showDialog(
        i18n.text('permissions.section.contacts'),
        i18n.format('contactsPermission.dialog.settingsFailed.message', {
          appName: i18n.text('welcome.brand'),
        }),
      );
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
  const i18n = createI18n();
  const appName = i18n.text('welcome.brand');
  const action = options.canAskAgain
    ? {
        text: i18n.text('contactsPermission.action.tryAgain'),
        onPress: () => {
          if (options.isCurrent()) options.onTryAgain();
        },
      }
    : {
        text: i18n.text('contactsPermission.action.openSettings'),
        onPress: () => void openContactsPermissionSettings(options.isCurrent),
      };
  showDialog(
    i18n.text('contactsPermission.dialog.denied.title'),
    options.canAskAgain
      ? i18n.format('contactsPermission.dialog.denied.message.retry', { appName })
      : i18n.format('contactsPermission.dialog.denied.message.settings', { appName }),
    [{ text: i18n.text('contactsPermission.action.notNow'), style: 'cancel' }, action],
  );
}
