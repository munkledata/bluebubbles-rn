const DEFAULT_LOCALE = 'en';

const ENGLISH_MESSAGES = {
  'connect.action.manual': 'Enter Manually',
  'connect.action.scan': 'Scan QR Code',
  'connect.subtitle':
    'Scan the QR code shown on your {serverName}, or enter the URL and password or paired-client credential manually.',
  'connect.title': 'Connect',
  'contactsPermission.action.continue': 'Continue',
  'contactsPermission.action.notNow': 'Not Now',
  'contactsPermission.action.openSettings': 'Open Settings',
  'contactsPermission.action.tryAgain': 'Try Again',
  'contactsPermission.dialog.denied.message.retry':
    '{appName} still works without Contacts access. You can try again or keep typing phone numbers and email addresses manually.',
  'contactsPermission.dialog.denied.message.settings':
    'Android won’t show the Contacts prompt again. {appName} still works with manually typed phone numbers and email addresses; to enable contacts, open {appName}’s app settings.',
  'contactsPermission.dialog.denied.title': 'Contacts access denied',
  'contactsPermission.dialog.rationale.message.share':
    '{appName} can read your device contacts to let you choose a device contact to send as a contact card. This is optional. You can still type phone numbers and email addresses without allowing Contacts access.',
  'contactsPermission.dialog.rationale.message.sync':
    '{appName} can read your device contacts to show saved names and photos in conversations. This is optional. You can still type phone numbers and email addresses without allowing Contacts access.',
  'contactsPermission.dialog.rationale.title': 'Allow Contacts access?',
  'contactsPermission.dialog.settingsFailed.message':
    'Couldn’t open Android app settings. Open Settings and select {appName}.',
  'manual.action.connect': 'Connect',
  'manual.field.password.label': 'Password or paired-client credential',
  'manual.field.password.placeholder': 'Password or paired-client credential',
  'manual.field.url.label': 'Server URL',
  'manual.field.url.placeholder': 'https://your-server.ngrok.io',
  'manual.insecure.label': 'Allow insecure connection',
  'manual.insecure.warning.prefix': 'This server uses unencrypted ',
  'manual.insecure.warning.protocol': 'http://',
  'manual.insecure.warning.suffix': '. Only enable for a server you trust.',
  'manual.subtitle': 'Enter your {serverName} URL and password or paired-client credential.',
  'manual.title': 'Server details',
  'permissions.action.checkAgain': 'Check Again',
  'permissions.action.continue': 'Continue to Messages',
  'permissions.action.enableNotifications': 'Enable Notifications',
  'permissions.action.openAppSettings': 'Open App Settings',
  'permissions.action.openNotificationSettings': 'Open Notification Settings',
  'permissions.action.syncAgain': 'Sync Again',
  'permissions.action.syncContacts': 'Sync Contacts',
  'permissions.contacts.copy':
    'Allow Contacts access to show saved names and photos. You can always start a message by typing a phone number or email address instead.',
  'permissions.dialog.contactsFailed.message':
    'Contacts could not be synced. You can try again from Settings.',
  'permissions.dialog.contactsSynced.message.one':
    'Read {contacts} contact, matched {matched}. You can sync again from Settings.',
  'permissions.dialog.contactsSynced.message.other':
    'Read {contacts} contacts, matched {matched}. You can sync again from Settings.',
  'permissions.dialog.contactsSynced.title': 'Contacts synced',
  'permissions.dialog.notificationsUnavailable.message':
    'Android notification access is unavailable. Try again later.',
  'permissions.dialog.notificationSettingsFailed.message':
    'Couldn’t open Android notification settings. Open Settings and select {appName}.',
  'permissions.dialog.saveFailed.message':
    '{appName} kept this step open so it won’t be skipped. Try Continue again.',
  'permissions.dialog.saveFailed.title': 'Couldn’t save this choice',
  'permissions.intro':
    'Both choices are optional. {appName} keeps working if you choose Not Now or deny either Android prompt.',
  'permissions.notifications.copy':
    'Allow notifications to see new messages, calls, reminders, and send failures while {appName} is not open.',
  'permissions.section.contacts': 'Contacts',
  'permissions.section.notifications': 'Notifications',
  'permissions.status.allowed': 'Allowed',
  'permissions.status.checking': 'Checking…',
  'permissions.status.contactsDeniedRetry': 'Denied — you can try again',
  'permissions.status.contactsDeniedSettings': 'Denied — enable in Android settings',
  'permissions.status.contactsOptional': 'Optional — not requested',
  'permissions.status.enabled': 'Enabled',
  'permissions.status.notificationDeniedSettings': 'Denied — open Android settings to enable',
  'permissions.status.notificationNotEnabled': 'Not enabled yet',
  'permissions.status.unavailable': 'Status unavailable',
  'permissions.title': 'Choose what {appName} can access',
  'product.serverName': 'Gator Server',
  'scan.action.manual': 'Enter Manually',
  'scan.error.empty': 'No data was scanned. Please try again.',
  'scan.error.invalid': 'Invalid QR code.',
  'scan.error.invalidJson': 'That code is not a valid {appName} setup QR code.',
  'scan.error.invalidShape': 'That {appName} QR code has an invalid format.',
  'scan.error.missingCredentials':
    'The QR code does not contain a valid server URL and password or paired-client credential.',
  'scan.instruction.pointCamera': 'Point your camera at the server QR code',
  'scan.permission.action.grant': 'Grant Camera Access',
  'scan.permission.message': 'Allow camera access to scan your server’s setup QR code.',
  'scan.permission.title': 'Camera access needed',
  'scan.status.connecting': 'Connecting…',
  'sync.action.background': 'Continue in Background',
  'sync.action.continue': 'Continue',
  'sync.count.chat.one': 'chat',
  'sync.count.chat.other': 'chats',
  'sync.count.message.one': 'message',
  'sync.count.message.other': 'messages',
  'sync.count.separator': ' · ',
  'sync.detail.error':
    'Some messages may still be catching up — you can continue and they’ll fill in.',
  'sync.title.complete': 'Sync complete',
  'sync.title.error': 'Sync had trouble',
  'sync.title.progress': 'Syncing your messages…',
  'welcome.action.start': 'Get Started',
  'welcome.brand': 'Gator',
  'welcome.dev.action': 'Dev: seed & open inbox',
  'welcome.dev.dialog.messageSuffix': ' could not prepare the local fixture session.',
  'welcome.dev.dialog.title': 'Developer fixtures',
  'welcome.subtitle': 'Your Mac’s messages, on Android.',
} as const;

export type TranslationKey = keyof typeof ENGLISH_MESSAGES;
export type TextDirection = 'ltr' | 'rtl';

export interface I18n {
  readonly locale: string;
  readonly direction: TextDirection;
  count(value: number, oneKey: TranslationKey, otherKey: TranslationKey): string;
  format(key: TranslationKey, values: Readonly<Record<string, string>>): string;
  number(value: number): string;
  text(key: TranslationKey): string;
}

const PSEUDO_EXEMPT_KEYS = new Set<TranslationKey>([
  'manual.field.url.placeholder',
  'manual.insecure.warning.protocol',
  'product.serverName',
  'sync.count.separator',
  'welcome.brand',
]);

const ACCENTED_CHARACTER: Readonly<Record<string, string>> = {
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ď',
  E: 'Ë',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Ï',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ř',
  S: 'Š',
  T: 'Ţ',
  U: 'Ü',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẍ',
  Y: 'Ÿ',
  Z: 'Ž',
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'ď',
  e: 'ë',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'ï',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ṁ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ř',
  s: 'š',
  t: 'ţ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẍ',
  y: 'ÿ',
  z: 'ž',
};

function canonicalLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function accentText(value: string): string {
  const characters = Array.from(value);
  const accented = characters
    .map((character) => ACCENTED_CHARACTER[character] ?? character)
    .join('');
  const padding = '·'.repeat(Math.max(2, Math.ceil(characters.length * 0.3)));
  return `⟦${accented} ${padding}⟧`;
}

function mirrorText(value: string): string {
  return `⁧⟦${Array.from(value).reverse().join('')}⟧⁩`;
}

function resolvePseudoLocale(locale: string): 'en-XA' | 'ar-XB' | null {
  const normalized = locale.toLowerCase();
  if (normalized === 'en-xa') return 'en-XA';
  if (normalized === 'ar-xb') return 'ar-XB';
  return null;
}

function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
  transformLiteral: (value: string) => string,
): string {
  const placeholder = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholder.exec(template)) !== null) {
    result += transformLiteral(template.slice(cursor, match.index));
    const name = match[1];
    if (!name || !Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Missing translation value for ${match[0]}`);
    }
    const replacement = values[name];
    if (replacement === undefined) throw new Error(`Missing translation value for ${match[0]}`);
    result += replacement;
    cursor = placeholder.lastIndex;
  }

  return result + transformLiteral(template.slice(cursor));
}

/** Resolves the locale already selected by the JavaScript runtime and falls back safely. */
export function resolveSystemLocale(): string {
  try {
    return canonicalLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * Small dependency-free translation boundary. Only catalog text is pseudo-localized; values such
 * as counts, names, message bodies, and server data must be formatted or rendered separately.
 */
export function createI18n(requestedLocale = resolveSystemLocale()): I18n {
  const locale = canonicalLocale(requestedLocale);
  const pseudoLocale = resolvePseudoLocale(locale);
  const numberFormatter = new Intl.NumberFormat(locale);

  const transformPseudoText = (value: string): string => {
    if (!value || !pseudoLocale) return value;
    return pseudoLocale === 'ar-XB' ? mirrorText(value) : accentText(value);
  };

  const text = (key: TranslationKey): string => {
    const value = ENGLISH_MESSAGES[key];
    if (!pseudoLocale || PSEUDO_EXEMPT_KEYS.has(key)) return value;
    return transformPseudoText(value);
  };

  return {
    locale,
    direction: pseudoLocale === 'ar-XB' ? 'rtl' : 'ltr',
    text,
    format: (key, values) =>
      interpolate(
        ENGLISH_MESSAGES[key],
        values,
        PSEUDO_EXEMPT_KEYS.has(key) ? (value) => value : transformPseudoText,
      ),
    number: (value) => numberFormatter.format(value),
    count: (value, oneKey, otherKey) =>
      `${numberFormatter.format(value)} ${text(value === 1 ? oneKey : otherKey)}`,
  };
}
