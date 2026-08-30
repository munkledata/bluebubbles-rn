#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DEBUG_MANIFESTS = [
  'android/app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/debug/processDebugMainManifest/AndroidManifest.xml',
];
const DEFAULT_RELEASE_MANIFESTS = [
  'android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
  'android/app/build/intermediates/merged_manifests/release/processReleaseMainManifest/AndroidManifest.xml',
];
const DEFAULT_RELEASE_BUNDLE = 'android/app/build/outputs/bundle/release/app-release.aab';
const PACKAGED_MANIFEST_ENTRY = 'base/manifest/AndroidManifest.xml';
const PACKAGED_SHORTCUTS_ENTRY = 'base/res/xml/shortcuts.xml';
const PACKAGED_DEX_PATTERN = 'base/dex/*.dex';
const ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android';
const FORBIDDEN_INBOUND_SHARE_DEX_MARKERS = ['ExpoShareIntent', 'expo/modules/shareintent'];

export const FORBIDDEN_PERMISSIONS = [
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  'android.permission.USE_FULL_SCREEN_INTENT',
];

// Expo's dev-client overlay legitimately needs this in a debuggable build. It remains forbidden
// in the release manifest and packaged AAB, which are the artifacts shipped to users.
const DEBUG_ONLY_ALLOWED_PERMISSIONS = new Set(['android.permission.SYSTEM_ALERT_WINDOW']);

// This is the sensitive/product permission contract. The merged manifest also contains normal
// platform permissions such as INTERNET and WAKE_LOCK from the runtime and its libraries.
export const REQUIRED_PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA',
];

const REQUIRED_COMPONENTS = [
  {
    tag: 'service',
    name: 'app.notifee.core.ReceiverService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingHeadlessService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'receiver',
    name: 'expo.modules.taskManager.TaskBroadcastReceiver',
    attributes: { 'android:exported': 'false' },
  },
  {
    tag: 'service',
    name: 'expo.modules.taskManager.TaskJobService',
    attributes: {
      'android:enabled': 'true',
      'android:exported': 'false',
      'android:permission': 'android.permission.BIND_JOB_SERVICE',
    },
  },
];

const FORBIDDEN_INBOUND_SHARE_ACTIONS = [
  'android.intent.action.SEND',
  'android.intent.action.SEND_MULTIPLE',
];

const REQUIRED_ENTRY_IMPORTS = [
  './src/services/errors/registerReactNativeExceptionPrivacy',
  './src/services/logging/registerPersistentLogs',
  './src/services/notifications/backgroundEvents',
  './src/services/background/registerBackgroundSyncHeadlessTask',
  './src/services/notifications/registerFcmBackgroundHandler',
  './src/services/download/registerBoundedNativeDownloadCleanup',
];

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attributes.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attributes;
}

// Android's merged manifest is regular element/attribute XML. This small parser deliberately
// strips comments and records the element hierarchy, which prevents a marker in a comment, the
// wrong tag, or the wrong parent from satisfying a component assertion without adding a package.
function parseElements(manifest) {
  const source = manifest.replace(/<!--[\s\S]*?-->/g, '');
  const elements = [];
  const stack = [];
  const tagPattern = /<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.:-]*)([^<>]*?)>/g;

  for (const match of source.matchAll(tagPattern)) {
    const closing = match[1] === '/';
    const name = match[2];
    if (closing) {
      const index = stack.findLastIndex((element) => element.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }

    const parent = stack.at(-1);
    const element = {
      name,
      attributes: parseAttributes(match[3] ?? ''),
      parent,
      children: [],
    };
    if (parent) parent.children.push(element);
    elements.push(element);

    if (!/\/\s*>$/.test(match[0])) stack.push(element);
  }

  return elements;
}

function permissionElementsOf(elements) {
  return elements.filter(
    (element) =>
      /^uses-permission(?:-sdk-\d+)?$/.test(element.name) && element.parent?.name === 'manifest',
  );
}

function permissionsOf(permissionElements) {
  return new Set(
    permissionElements
      .map((element) => element.attributes.get('android:name'))
      .filter((name) => typeof name === 'string'),
  );
}

function hasIntentFilter(activity, requirements) {
  return activity.children
    .filter((child) => child.name === 'intent-filter')
    .some((filter) =>
      requirements.every(([tag, attribute, value]) =>
        filter.children.some(
          (child) => child.name === tag && child.attributes.get(attribute) === value,
        ),
      ),
    );
}

function findLauncherActivity(application) {
  return application?.children.find(
    (child) =>
      child.name === 'activity' &&
      hasIntentFilter(child, [
        ['action', 'android:name', 'android.intent.action.MAIN'],
        ['category', 'android:name', 'android.intent.category.LAUNCHER'],
      ]),
  );
}

function selectArtifactPath(root, explicitPath, candidates) {
  if (explicitPath) return resolve(root, explicitPath);
  return (
    candidates.map((candidate) => resolve(root, candidate)).find(existsSync) ??
    resolve(root, candidates[0])
  );
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;

  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('protobuf varint exceeds JavaScript safe integer range');
      }
      return { value: Number(value), offset };
    }
    shift += 7n;
  }

  throw new Error('protobuf contains a truncated or oversized varint');
}

function decodeProtoFields(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = Math.floor(key.value / 8);
    const wireType = key.value & 0x07;
    if (number === 0) throw new Error('protobuf field number must be non-zero');

    if (wireType === 0) {
      const scalar = readVarint(buffer, offset);
      fields.push({ number, wireType, value: scalar.value });
      offset = scalar.offset;
    } else if (wireType === 1 || wireType === 5) {
      const length = wireType === 1 ? 8 : 4;
      if (offset + length > buffer.length) throw new Error('protobuf fixed field is truncated');
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === 2) {
      const size = readVarint(buffer, offset);
      offset = size.offset;
      const end = offset + size.value;
      if (end > buffer.length) throw new Error('protobuf length-delimited field is truncated');
      fields.push({ number, wireType, value: buffer.subarray(offset, end) });
      offset = end;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }

  return fields;
}

function messageFields(fields, number) {
  return fields
    .filter((field) => field.number === number && field.wireType === 2)
    .map((field) => field.value);
}

function stringField(fields, number) {
  return messageFields(fields, number)[0]?.toString('utf8');
}

function decodeProtoXmlAttribute(input) {
  const fields = decodeProtoFields(input);
  const namespace = stringField(fields, 1) ?? '';
  const name = stringField(fields, 2);
  if (!name) throw new Error('protobuf XML attribute is missing its name');
  return {
    name: namespace === ANDROID_NAMESPACE ? `android:${name}` : name,
    value: stringField(fields, 3) ?? '',
  };
}

function decodeProtoXmlNode(input, parent, elements) {
  const fields = decodeProtoFields(input);
  const encodedElement = messageFields(fields, 1)[0];
  if (!encodedElement) return undefined;

  const elementFields = decodeProtoFields(encodedElement);
  const name = stringField(elementFields, 3);
  if (!name) throw new Error('protobuf XML element is missing its name');
  const element = { name, attributes: new Map(), parent, children: [] };
  for (const encodedAttribute of messageFields(elementFields, 4)) {
    const attribute = decodeProtoXmlAttribute(encodedAttribute);
    element.attributes.set(attribute.name, attribute.value);
  }
  if (parent) parent.children.push(element);
  elements.push(element);
  for (const encodedChild of messageFields(elementFields, 5)) {
    decodeProtoXmlNode(encodedChild, element, elements);
  }
  return element;
}

export function decodeProtoXml(input) {
  const elements = [];
  const root = decodeProtoXmlNode(input, undefined, elements);
  if (!root) throw new Error('protobuf XML document has no root element');
  return elements;
}

export function validatePackagedAndroidBundle({ manifestProto, shortcutsProto, dexBytes }) {
  const errors = [];

  try {
    const manifestElements = decodeProtoXml(manifestProto);
    errors.push(
      ...validateManifestElements(manifestElements).map((error) => `packaged manifest: ${error}`),
    );
  } catch (error) {
    errors.push(
      `packaged manifest protobuf is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // shortcuts.xml is optional while IPC-01 is fail-closed. If another library happens to package
  // one, inspect its XML rather than treating the filename itself as proof of an inbound target.
  if (shortcutsProto) {
    try {
      const shortcutsElements = decodeProtoXml(shortcutsProto);
      if (shortcutsElements.some((element) => element.name === 'share-target')) {
        errors.push(
          'packaged shortcuts.xml must not contain <share-target> while inbound sharing is disabled',
        );
      }
    } catch (error) {
      errors.push(
        `packaged shortcuts.xml protobuf is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (dexBytes) {
    for (const marker of FORBIDDEN_INBOUND_SHARE_DEX_MARKERS) {
      if (dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX contains disabled inbound-share native marker: ${marker}`);
      }
    }
  }

  return errors;
}

function readBundleEntry(bundlePath, entryPath, maxBuffer = 16 * 1024 * 1024) {
  const result = spawnSync('unzip', ['-p', bundlePath, entryPath], {
    encoding: null,
    maxBuffer,
  });
  if (result.error) {
    throw new Error(`could not run unzip: ${result.error.message}`);
  }
  if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    const detail = result.stderr?.toString('utf8').trim();
    throw new Error(
      `could not read ${entryPath} from AAB${detail ? `: ${detail}` : ` (unzip exit ${String(result.status)})`}`,
    );
  }
  return result.stdout;
}

function listBundleEntries(bundlePath) {
  const result = spawnSync('unzip', ['-Z1', bundlePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`could not run unzip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `could not list AAB entries${detail ? `: ${detail}` : ` (unzip exit ${String(result.status)})`}`,
    );
  }
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

/**
 * Inspect one built Android App Bundle without requiring a generated native tree.
 *
 * This is the release-tool boundary: it applies the same packaged manifest/shortcuts/DEX contract
 * as the full Android build guard, then returns only the finite identity fields needed to bind an
 * artifact to its release record.
 */
export function inspectPackagedAndroidBundle(bundlePath) {
  const bundleEntries = listBundleEntries(bundlePath);
  const manifestProto = readBundleEntry(bundlePath, PACKAGED_MANIFEST_ENTRY);
  const errors = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: bundleEntries.has(PACKAGED_SHORTCUTS_ENTRY)
      ? readBundleEntry(bundlePath, PACKAGED_SHORTCUTS_ENTRY)
      : undefined,
    // The package/lock/autolinking checks prevent a clean build from linking the removed module.
    // This additionally rejects a stale or otherwise contaminated release artifact.
    dexBytes: readBundleEntry(bundlePath, PACKAGED_DEX_PATTERN, 256 * 1024 * 1024),
  });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));

  const manifest = decodeProtoXml(manifestProto).find(
    (element) => element.name === 'manifest' && element.parent == null,
  );
  if (!manifest) throw new Error('packaged manifest identity is missing its root element');
  const applicationId = manifest.attributes.get('package');
  const versionName =
    manifest.attributes.get('android:versionName') ?? manifest.attributes.get('versionName');
  const versionCodeText =
    manifest.attributes.get('android:versionCode') ?? manifest.attributes.get('versionCode');
  if (!applicationId) throw new Error('packaged manifest identity is missing package');
  if (!versionName) throw new Error('packaged manifest identity is missing versionName');
  if (!versionCodeText || !/^[1-9]\d*$/.test(versionCodeText)) {
    throw new Error('packaged manifest identity has an invalid versionCode');
  }
  const versionCode = Number(versionCodeText);
  if (!Number.isSafeInteger(versionCode)) {
    throw new Error('packaged manifest identity versionCode exceeds the safe integer range');
  }

  return { applicationId, versionName, versionCode };
}

function validateManifestElements(elements, { debug = false } = {}) {
  const errors = [];
  const permissionElements = permissionElementsOf(elements);
  const permissions = permissionsOf(permissionElements);

  for (const permission of FORBIDDEN_PERMISSIONS) {
    if (debug && DEBUG_ONLY_ALLOWED_PERMISSIONS.has(permission)) continue;
    if (permissions.has(permission)) errors.push(`forbidden permission is merged: ${permission}`);
  }
  for (const permission of REQUIRED_PERMISSIONS) {
    const declarations = permissionElements.filter(
      (element) => element.attributes.get('android:name') === permission,
    );
    if (declarations.length === 0) {
      errors.push(`required permission is missing: ${permission}`);
    } else if (declarations.every((element) => element.attributes.has('android:maxSdkVersion'))) {
      errors.push(`required permission is capped by android:maxSdkVersion: ${permission}`);
    }
  }

  const application = elements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  if (application?.attributes.get('android:allowBackup') !== 'false') {
    errors.push('application must set android:allowBackup="false"');
  }

  for (const component of REQUIRED_COMPONENTS) {
    const element = application?.children.find(
      (child) =>
        child.name === component.tag && child.attributes.get('android:name') === component.name,
    );
    if (!element) {
      errors.push(`merged manifest is missing <${component.tag}> ${component.name}`);
      continue;
    }
    for (const [attribute, value] of Object.entries(component.attributes)) {
      if (element.attributes.get(attribute) !== value) {
        errors.push(`${component.name} must set ${attribute}="${value}"`);
      }
    }
  }

  const launcherActivity = findLauncherActivity(application);
  if (!launcherActivity) {
    errors.push('merged manifest is missing the launcher activity');
  } else {
    const shortcuts = launcherActivity.children.find(
      (child) =>
        child.name === 'meta-data' &&
        child.attributes.get('android:name') === 'android.app.shortcuts',
    );
    if (shortcuts) {
      errors.push(
        'launcher activity must not declare android.app.shortcuts meta-data while inbound sharing is disabled',
      );
    }
  }

  // Only component intent-filters make Gator an inbound target. Android package-visibility
  // declarations under <queries> may legitimately mention ACTION_SEND so expo-sharing can find an
  // outbound receiver; those are deliberately outside the application/component hierarchy below.
  for (const component of application?.children ?? []) {
    if (component.name !== 'activity' && component.name !== 'activity-alias') continue;
    for (const filter of component.children.filter((child) => child.name === 'intent-filter')) {
      for (const action of filter.children
        .filter((child) => child.name === 'action')
        .map((child) => child.attributes.get('android:name'))) {
        if (action && FORBIDDEN_INBOUND_SHARE_ACTIONS.includes(action)) {
          errors.push(
            `${component.attributes.get('android:name') ?? component.name} must not declare inbound ${action}`,
          );
        }
      }
    }
  }

  return errors;
}

export function validateAndroidBuild({ manifest, packageJson, entrySource, debug = false }) {
  return [
    ...validateManifestElements(parseElements(manifest), { debug }),
    ...validateHeadlessEntry({ packageJson, entrySource }),
  ];
}

function entrySideEffectImports(entrySource) {
  return [...entrySource.matchAll(/^\s*import\s+['"]([^'"]+)['"];?\s*$/gm)].map(
    (match) => match[1],
  );
}

/**
 * Validate the JavaScript bundle entry without requiring generated Android artifacts.
 *
 * The full Android guard reuses this exact function for manifest/AAB validation, while the ordinary
 * architecture gate can call it directly so a missing, late, or bypassed headless registration
 * fails during repository-local checks too.
 */
export function validateHeadlessEntry({ packageJson, entrySource }) {
  const errors = [];

  if (packageJson.main !== 'index.js') errors.push('package.json main must remain index.js');
  const entryImports = entrySideEffectImports(entrySource);
  const routerIndex = entryImports.indexOf('expo-router/entry');
  if (entryImports[0] !== './src/services/errors/registerReactNativeExceptionPrivacy') {
    errors.push(
      'the React Native exception privacy boundary must be the first index.js side-effect import',
    );
  }
  if (entryImports[1] !== './src/services/logging/registerPersistentLogs') {
    errors.push(
      'the persistent log sink must be the second index.js side-effect import, before headless tasks',
    );
  }
  if (routerIndex < 0) {
    errors.push('index.js must import expo-router/entry');
  } else if (routerIndex !== entryImports.length - 1) {
    errors.push('expo-router/entry must be the final side-effect import');
  }
  for (const requiredImport of REQUIRED_ENTRY_IMPORTS) {
    const index = entryImports.indexOf(requiredImport);
    if (index < 0) errors.push(`index.js is missing required startup import ${requiredImport}`);
    else if (routerIndex >= 0 && index > routerIndex) {
      errors.push(`${requiredImport} must load before expo-router/entry`);
    }
  }

  return errors;
}

export function runHeadlessEntryCheck({ root = process.cwd() } = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const entrySource = readFileSync(resolve(root, 'index.js'), 'utf8');
  const errors = validateHeadlessEntry({ packageJson, entrySource });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { imports: entrySideEffectImports(entrySource).length };
}

export function runAndroidBuildCheck({
  root = process.cwd(),
  debugManifestPath,
  releaseManifestPath,
  releaseBundlePath,
} = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const entrySource = readFileSync(resolve(root, 'index.js'), 'utf8');
  const manifests = [
    ['debug', selectArtifactPath(root, debugManifestPath, DEFAULT_DEBUG_MANIFESTS)],
    ['release', selectArtifactPath(root, releaseManifestPath, DEFAULT_RELEASE_MANIFESTS)],
  ];
  const errors = [];

  for (const [label, path] of manifests) {
    if (!existsSync(path)) {
      errors.push(`${label} merged manifest is missing: ${path}`);
      continue;
    }
    errors.push(
      ...validateAndroidBuild({
        manifest: readFileSync(path, 'utf8'),
        packageJson,
        entrySource,
        debug: label === 'debug',
      }).map((error) => `${label} manifest: ${error}`),
    );
  }

  const bundlePath = resolve(root, releaseBundlePath ?? DEFAULT_RELEASE_BUNDLE);
  const bundleExists =
    existsSync(bundlePath) && statSync(bundlePath).isFile() && statSync(bundlePath).size > 0;
  if (!bundleExists) {
    errors.push(`release AAB is missing or empty: ${bundlePath}`);
  } else {
    try {
      inspectPackagedAndroidBundle(bundlePath);
    } catch (error) {
      errors.push(
        `release AAB inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return {
    debugManifestPath: manifests[0][1],
    releaseManifestPath: manifests[1][1],
    releaseBundlePath: bundlePath,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runAndroidBuildCheck({
      debugManifestPath: process.argv[2],
      releaseManifestPath: process.argv[3],
      releaseBundlePath: process.argv[4],
    });
    console.log(
      `Android artifact guard passed: debug ${result.debugManifestPath}; release ${result.releaseManifestPath}; AAB ${result.releaseBundlePath}.`,
    );
  } catch (error) {
    console.error(
      `Android artifact guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
