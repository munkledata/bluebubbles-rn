import { mailtoUrlForAddress, safeOpenUrl, telUrlForAddress } from '@utils';

const ACTION_VIEW = 'android.intent.action.VIEW';
const ACTION_INSERT_OR_EDIT = 'android.intent.action.INSERT_OR_EDIT';
const CONTACT_URI_PREFIX = 'content://com.android.contacts/contacts/';
const CONTACT_ITEM_TYPE = 'vnd.android.cursor.item/contact';
// Android's ContactsContract.Intents.Insert extra names.
const INSERT_PHONE_EXTRA = 'phone';
const INSERT_EMAIL_EXTRA = 'email';
/** Android contact ids are row ids; anything else is not a linked device contact. */
const ANDROID_CONTACT_ID = /^[0-9]{1,18}$/;

export interface MemberContactActionDependencies {
  openUrl: (url: string) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  startActivity: (
    action: string,
    params: { data?: string; type?: string; extra?: Record<string, string> },
  ) => Promise<void>;
  isAndroid: () => boolean | Promise<boolean>;
}

const defaultDependencies: MemberContactActionDependencies = {
  openUrl: safeOpenUrl,
  copyText: async (text) => {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
  },
  startActivity: async (action, params) => {
    const IntentLauncher = await import('expo-intent-launcher');
    await IntentLauncher.startActivityAsync(action, params);
  },
  // Lazy, like safeOpenUrl, so `react-native` stays out of the pure-Node test graph.
  isAndroid: async () => (await import('react-native')).Platform.OS === 'android',
};

/** The number or email address Android's "add to a contact" screen fills in; null for neither. */
function addToContactsExtra(address: string): Record<string, string> | null {
  const phone = telUrlForAddress(address);
  if (phone !== null) return { [INSERT_PHONE_EXTRA]: phone.slice('tel:'.length) };
  const email = mailtoUrlForAddress(address);
  if (email !== null) return { [INSERT_EMAIL_EXTRA]: email.slice('mailto:'.length) };
  return null;
}

/** True when a member's linked contact id can open that contact in the phone's Contacts app. */
export function canViewMemberContact(contactSourceId: string | null | undefined): boolean {
  return typeof contactSourceId === 'string' && ANDROID_CONTACT_ID.test(contactSourceId);
}

/** Copy a participant's address. Android 13 and later confirm a copy themselves. */
export async function copyMemberAddress(
  address: string,
  dependencies: MemberContactActionDependencies = defaultDependencies,
): Promise<boolean> {
  const trimmed = address.trim();
  if (trimmed.length === 0) return false;
  try {
    await dependencies.copyText(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Open the phone app on a participant's number. False when the address is not a dialable number. */
export async function callMember(
  address: string,
  dependencies: MemberContactActionDependencies = defaultDependencies,
): Promise<boolean> {
  const url = telUrlForAddress(address);
  return url !== null && dependencies.openUrl(url);
}

/** Open the mail app on a participant's email address. False when the address is not an email. */
export async function emailMember(
  address: string,
  dependencies: MemberContactActionDependencies = defaultDependencies,
): Promise<boolean> {
  const url = mailtoUrlForAddress(address);
  return url !== null && dependencies.openUrl(url);
}

/**
 * Show a participant in the phone's Contacts app: their linked contact when there is one, otherwise
 * Android's "add to a contact" screen with the number or email address filled in. Nothing is saved
 * until the person confirms it in the Contacts app.
 */
export async function openMemberContact(
  member: { address: string; contactSourceId: string | null | undefined },
  dependencies: MemberContactActionDependencies = defaultDependencies,
): Promise<boolean> {
  try {
    if (!(await dependencies.isAndroid())) return false;
    if (canViewMemberContact(member.contactSourceId)) {
      await dependencies.startActivity(ACTION_VIEW, {
        data: `${CONTACT_URI_PREFIX}${member.contactSourceId}`,
      });
      return true;
    }
    const extra = addToContactsExtra(member.address);
    if (extra === null) return false;
    await dependencies.startActivity(ACTION_INSERT_OR_EDIT, { type: CONTACT_ITEM_TYPE, extra });
    return true;
  } catch {
    return false;
  }
}
