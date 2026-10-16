import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Some limits and formats exist twice: in Kotlin, which enforces them, and in TypeScript, which
 * validates what crosses the bridge or shapes what is sent to it. Nothing linked the copies, so
 * changing one side quietly broke the feature (review M162). This test reads both sources and
 * compares the values, so a one-sided change fails here instead of on a phone.
 *
 * Deliberately not paired: the share MIME pattern (JavaScript also accepts `*`, which Kotlin never
 * emits because it maps wildcards to application/octet-stream) and the 4096 cache-scan limit
 * (Kotlin bounds the path, JavaScript the `file://` URI built from it).
 */
const repo = resolve(__dirname, '../..');
const DOWNLOAD =
  'modules/gator-bounded-download/android/src/main/java/expo/modules/gatorboundeddownload';
const SHARE = 'modules/gator-share-intake/android/src/main/java/expo/modules/gatorshareintake';

const sources = new Map<string, string>();
function source(path: string): string {
  let text = sources.get(path);
  if (text === undefined) {
    text = readFileSync(resolve(repo, path), 'utf8');
    sources.set(path, text);
  }
  return text;
}

/** The right-hand side of `const val NAME =` (Kotlin) or `const NAME =` (TypeScript). */
function expressionOf(path: string, name: string): string {
  const text = source(path);
  const match = path.endsWith('.kt')
    ? new RegExp(`\\bconst val ${name}\\s*=\\s*([^\\n]+)`).exec(text)
    : new RegExp(`\\bconst ${name}\\s*=\\s*([^;\\n]+);`).exec(text);
  if (!match?.[1]) throw new Error(`${name} not found in ${path}`);
  return match[1].replace(/\s*\/\/.*$/, '').trim();
}

/** Evaluate an integer expression of literals, `+ - *` and other constants in the same file. */
function valueOf(path: string, name: string): number {
  const tokens = expressionOf(path, name)
    .replace(/(\d)_(?=\d)/g, '$1')
    .replace(/(\d+)L\b/g, '$1')
    .split(/\s*([+*-])\s*/)
    .filter((token) => token.length > 0);
  const operand = (token: string): number => {
    if (/^\d+$/.test(token)) return Number(token);
    if (/^[A-Z][A-Z0-9_]*$/.test(token)) return valueOf(path, token);
    throw new Error(`unsupported token ${token} in ${name}`);
  };
  // Products first, then sums: enough for every constant compared here.
  const terms: number[] = [];
  const signs: number[] = [1];
  let product = operand(tokens[0]!);
  for (let i = 1; i < tokens.length; i += 2) {
    const operator = tokens[i];
    const next = operand(tokens[i + 1]!);
    if (operator === '*') {
      product *= next;
    } else {
      terms.push(product);
      signs.push(operator === '-' ? -1 : 1);
      product = next;
    }
  }
  terms.push(product);
  return terms.reduce((sum, term, index) => sum + signs[index]! * term, 0);
}

/** The pattern text of `Regex("...")` (Kotlin) or `/.../` (TypeScript). */
function patternOf(path: string, name: string): string {
  const text = source(path);
  const match = path.endsWith('.kt')
    ? new RegExp(`\\bval ${name} = Regex\\("([^"]+)"\\)`).exec(text)
    : new RegExp(`\\bconst ${name} = /(.+)/[a-z]*;`).exec(text);
  if (!match?.[1]) throw new Error(`${name} pattern not found in ${path}`);
  return match[1];
}

const SYNCED = `${DOWNLOAD}/SyncedBackgroundCachePolicy.kt`;
const SCANNER = `${DOWNLOAD}/AttachmentCacheScanner.kt`;
const CACHE_POLICY = `${DOWNLOAD}/AttachmentCachePolicy.kt`;
const SHARE_POLICY = `${SHARE}/ShareIntakePolicy.kt`;
const BOUNDED_DOWNLOAD = 'src/native/boundedDownload.ts';
const SYNCED_SERVICE = 'src/services/backgrounds/syncedBackground.ts';
const SHARE_BRIDGE = 'src/native/shareIntake.ts';

// [what, Kotlin file, Kotlin name, TypeScript file, TypeScript name, TypeScript minus Kotlin]
const NUMBERS: [string, string, string, string, string, number][] = [
  [
    'synced-background cache bytes',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_MAX_BYTES',
    BOUNDED_DOWNLOAD,
    'SYNCED_BACKGROUND_FINAL_MAX_BYTES',
    0,
  ],
  [
    'synced-background cache bytes (service)',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_MAX_BYTES',
    SYNCED_SERVICE,
    'SYNCED_BACKGROUND_CACHE_MAX_BYTES',
    0,
  ],
  [
    'synced-background cache files',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_MAX_FILES',
    BOUNDED_DOWNLOAD,
    'SYNCED_BACKGROUND_FINAL_MAX_FILES',
    0,
  ],
  [
    'synced-background cache files (service)',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_MAX_FILES',
    SYNCED_SERVICE,
    'SYNCED_BACKGROUND_CACHE_MAX_FILES',
    0,
  ],
  [
    'synced-background admission bytes',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES',
    BOUNDED_DOWNLOAD,
    'SYNCED_BACKGROUND_ADMISSION_MAX_BYTES',
    0,
  ],
  [
    'synced-background admission files',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES',
    BOUNDED_DOWNLOAD,
    'SYNCED_BACKGROUND_ADMISSION_MAX_FILES',
    0,
  ],
  [
    'synced-background recent-file grace',
    SYNCED,
    'SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS',
    SYNCED_SERVICE,
    'SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS',
    0,
  ],
  [
    'synced-background download bytes',
    SYNCED,
    'SYNCED_BACKGROUND_DOWNLOAD_MAX_BYTES',
    SYNCED_SERVICE,
    'SYNCED_BACKGROUND_MAX_BYTES',
    0,
  ],
  [
    'cache scan files per page',
    SCANNER,
    'ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE',
    BOUNDED_DOWNLOAD,
    'ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE',
    0,
  ],
  [
    'cache scan total files',
    SCANNER,
    'ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES',
    BOUNDED_DOWNLOAD,
    'ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES',
    0,
  ],
  [
    'cache scan id chars',
    SCANNER,
    'MAX_SCAN_ID_CHARS',
    BOUNDED_DOWNLOAD,
    'ATTACHMENT_CACHE_SCAN_MAX_ID_CHARS',
    0,
  ],
  // Every unfinished native page consumes at least one node, so one extra page always suffices.
  [
    'cache scan pages',
    SCANNER,
    'ATTACHMENT_CACHE_SCAN_MAX_TOTAL_NODES',
    BOUNDED_DOWNLOAD,
    'ATTACHMENT_CACHE_SCAN_MAX_PAGES',
    1,
  ],
  [
    'encoded media segment chars',
    CACHE_POLICY,
    'MAX_ENCODED_MEDIA_SEGMENT_CHARS',
    'src/utils/mediaPathLimits.ts',
    'MEDIA_PATH_ENCODED_VALUE_MAX_CHARS',
    0,
  ],
  ['shared files per batch', SHARE_POLICY, 'MAX_SHARED_FILES', SHARE_BRIDGE, 'MAX_FILES', 0],
  ['shared file bytes', SHARE_POLICY, 'MAX_SHARED_FILE_BYTES', SHARE_BRIDGE, 'MAX_FILE_BYTES', 0],
  [
    'shared batch bytes',
    SHARE_POLICY,
    'MAX_SHARED_BATCH_BYTES',
    SHARE_BRIDGE,
    'MAX_BATCH_BYTES',
    0,
  ],
  ['shared text bytes', SHARE_POLICY, 'MAX_SHARED_TEXT_BYTES', SHARE_BRIDGE, 'MAX_TEXT_BYTES', 0],
];

const PATTERNS: [string, string, string, string, string][] = [
  ['share batch id', SHARE_POLICY, 'SHARE_BATCH_ID', SHARE_BRIDGE, 'BATCH_ID'],
  ['share target token', SHARE_POLICY, 'SHARE_SHORTCUT_ID', SHARE_BRIDGE, 'TARGET_TOKEN'],
  ['shared file name', SHARE_POLICY, 'SHARE_FILE_NAME', SHARE_BRIDGE, 'FILE_NAME'],
];

describe('native limit drift (M162)', () => {
  it('evaluates the expressions it compares', () => {
    expect(valueOf(SYNCED, 'SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_BYTES')).toBe(90 * 1024 * 1024);
    expect(valueOf(SYNCED, 'SYNCED_BACKGROUND_CACHE_ADMISSION_MAX_FILES')).toBe(255);
    expect(valueOf(SCANNER, 'ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES')).toBe(8192);
  });

  it.each(NUMBERS)(
    '%s matches across the bridge',
    (_what, kotlinPath, kotlinName, tsPath, tsName, offset) => {
      expect(valueOf(tsPath, tsName)).toBe(valueOf(kotlinPath, kotlinName) + offset);
    },
  );

  it.each(PATTERNS)(
    '%s pattern matches across the bridge',
    (_what, kotlinPath, kotlinName, tsPath, tsName) => {
      expect(patternOf(tsPath, tsName)).toBe(patternOf(kotlinPath, kotlinName));
    },
  );
});
