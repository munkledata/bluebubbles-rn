#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractZipEntry,
  readAabArchiveSnapshot,
  REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS,
  scanZipArchiveForSensitiveMetadata,
} from './legal-aab-inventory.mjs';

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
const DEFAULT_NETWORK_SECURITY_CONFIG = 'android/app/src/main/res/xml/network_security_config.xml';
const PACKAGED_MANIFEST_ENTRY = 'base/manifest/AndroidManifest.xml';
const PACKAGED_RESOURCES_ENTRY = 'base/resources.pb';
const PACKAGED_SHORTCUTS_ENTRY = 'base/res/xml/shortcuts.xml';
const PACKAGED_DEX_PATTERN = /^base\/dex\/[^/]+\.dex$/;
const MAX_PACKAGED_DEX_BYTES = 256 * 1024 * 1024;
const ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android';
const FORBIDDEN_INBOUND_SHARE_DEX_MARKERS = ['ExpoShareIntent', 'expo/modules/shareintent'];
const EXPO_FILE_SYSTEM_VERSION = '57.0.6';
const PATCH_PACKAGE_VERSION = '8.0.1';
const EXPO_FILE_SYSTEM_PATCH_PATH = `patches/expo-file-system+${EXPO_FILE_SYSTEM_VERSION}.patch`;
const EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH =
  'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/legacy/FileSystemLegacyModule.kt';
const EXPO_FILE_SYSTEM_REDIRECT_TEST_PATH =
  'node_modules/expo-file-system/android/src/test/java/expo/modules/filesystem/legacy/FileSystemLegacyRedirectPolicyTest.kt';

// These exact product-owned runtime values bind an AAB to the pinned-shortcut retirement added in
// 9d97eab. Generic ShortcutManager method names are deliberately excluded because AndroidX itself
// contributes them to DEX even when Gator's cleanup implementation is stale or absent.
export const REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS = [
  'GatorShareShortcuts',
  'clearShareShortcuts',
  'com.bluegreengatorapps.messages.category.RETIRED_SHORTCUT',
  'gator.retired',
  'gator-retired-shortcut',
  'This shortcut is no longer available',
  'Direct Share cleanup could not replace ',
];

export const FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS = [
  'com.bluegreengatorapps.messages.category.SHARE_TARGET',
  'setShareShortcuts',
  'getLaunchShortcutId',
  'share shortcuts were not published (device cap or disabled shortcuts)',
];

// The exact package-registration descriptor gives a precise error for the usual autolinking path,
// while the namespace prefix catches any other class from the retired community WebView package.
// Expo DOM's supported bridge uses the separate expo/modules/webview namespace.
export const FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS = [
  'Lcom/reactnativecommunity/webview/RNCWebViewPackage;',
  'Lcom/reactnativecommunity/webview/',
];

export const FORBIDDEN_PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  'android.permission.USE_FULL_SCREEN_INTENT',
];

export const GOOGLE_MAPS_API_KEY_METADATA_NAME = 'com.google.android.geo.API_KEY';
export const GOOGLE_MAPS_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;
export const NETWORK_SECURITY_CONFIG_REFERENCE = '@xml/network_security_config';

function countOccurrences(source, needle) {
  if (typeof source !== 'string' || needle.length === 0) return 0;
  return source.split(needle).length - 1;
}

/**
 * Keep the SDK 57 upload redirect repair durable across installs and native builds.
 *
 * Expo file-system ships a prebuilt Android AAR, so merely patching its Kotlin source is inert.
 * The exact package must remain pinned, patch-package must restore the source after npm ci, and
 * Expo autolinking must compile that source instead of resolving the bundled AAR.
 */
export function validateExpoFileSystemRedirectContainment({
  packageJson,
  packageLock,
  patchSource,
  legacyModuleSource,
  appConfigSource,
}) {
  const errors = [];
  if (packageJson?.dependencies?.['expo-file-system'] !== EXPO_FILE_SYSTEM_VERSION) {
    errors.push(`expo-file-system must be pinned exactly to ${EXPO_FILE_SYSTEM_VERSION}`);
  }
  if (
    packageLock?.packages?.['']?.dependencies?.['expo-file-system'] !== EXPO_FILE_SYSTEM_VERSION
  ) {
    errors.push(
      `package-lock root must pin expo-file-system exactly to ${EXPO_FILE_SYSTEM_VERSION}`,
    );
  }
  if (
    packageLock?.packages?.['node_modules/expo-file-system']?.version !== EXPO_FILE_SYSTEM_VERSION
  ) {
    errors.push(`package-lock must resolve expo-file-system ${EXPO_FILE_SYSTEM_VERSION}`);
  }
  if (packageJson?.devDependencies?.['patch-package'] !== PATCH_PACKAGE_VERSION) {
    errors.push(`patch-package must be pinned exactly to ${PATCH_PACKAGE_VERSION}`);
  }
  if (packageLock?.packages?.['']?.devDependencies?.['patch-package'] !== PATCH_PACKAGE_VERSION) {
    errors.push(`package-lock root must pin patch-package exactly to ${PATCH_PACKAGE_VERSION}`);
  }
  if (packageLock?.packages?.['node_modules/patch-package']?.version !== PATCH_PACKAGE_VERSION) {
    errors.push(`package-lock must resolve patch-package ${PATCH_PACKAGE_VERSION}`);
  }
  const postinstallSteps = String(packageJson?.scripts?.postinstall ?? '')
    .split(/\s*&&\s*/)
    .filter(Boolean);
  if (!postinstallSteps.includes('patch-package')) {
    errors.push('package.json postinstall must run patch-package');
  }

  const sourceBuild = packageJson?.expo?.autolinking?.android?.buildFromSource;
  if (
    !Array.isArray(sourceBuild) ||
    sourceBuild.filter((name) => name === 'expo-file-system').length !== 1
  ) {
    errors.push('Expo Android autolinking must build expo-file-system from source exactly once');
  }

  const builder = legacyModuleSource?.match(
    /val builder = OkHttpClient\.Builder\(\)([\s\S]*?)client = builder\.build\(\)/,
  )?.[1];
  if (!builder || countOccurrences(builder, '.followRedirects(false)') !== 1) {
    errors.push('legacy expo-file-system OkHttp builder must disable redirects exactly once');
  }
  if (!builder || countOccurrences(builder, '.followSslRedirects(false)') !== 1) {
    errors.push('legacy expo-file-system OkHttp builder must disable SSL redirects exactly once');
  }

  if (
    !patchSource?.includes(`a/${EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH}`) ||
    !patchSource.includes('+          .followRedirects(false)') ||
    !patchSource.includes('+          .followSslRedirects(false)')
  ) {
    errors.push(`${EXPO_FILE_SYSTEM_PATCH_PATH} must carry both legacy OkHttp redirect flags`);
  }
  const nativeProofMarkers = [
    'a/node_modules/expo-file-system/android/build.gradle',
    `b/${EXPO_FILE_SYSTEM_REDIRECT_TEST_PATH}`,
    "+  testImplementation 'com.squareup.okhttp3:mockwebserver:4.9.2'",
    '+      val statuses = listOf(301, 302, 303, 307, 308)',
    '+      assertEquals(0, trap.requestCount)',
    '+  fun `redirect policy preserves successful request progress`() {',
    '+  fun `redirect policy preserves active call cancellation`() {',
  ];
  if (nativeProofMarkers.some((marker) => !patchSource?.includes(marker))) {
    errors.push(
      `${EXPO_FILE_SYSTEM_PATCH_PATH} must carry the redirect trap, progress, and cancellation native proof`,
    );
  }
  if (
    !appConfigSource?.includes('process.env.EXPO_PUBLIC_USE_RN_FETCH') ||
    !appConfigSource.includes("rnFetchEscapeHatch === '1'") ||
    !appConfigSource.includes("rnFetchEscapeHatch === 'true'")
  ) {
    errors.push('app config must reject the EXPO_PUBLIC_USE_RN_FETCH redirect escape hatch');
  }
  return errors;
}

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

function validateSystemCaNetworkSecurityConfigElements(elements) {
  const root = elements.filter(
    (element) => element.name === 'network-security-config' && !element.parent,
  );
  const base = elements.filter(
    (element) => element.name === 'base-config' && element.parent === root[0],
  );
  const anchors = elements.filter(
    (element) => element.name === 'trust-anchors' && element.parent === base[0],
  );
  const certificates = elements.filter(
    (element) => element.name === 'certificates' && element.parent === anchors[0],
  );
  const errors = [];

  if (root.length !== 1 || base.length !== 1 || anchors.length !== 1 || certificates.length !== 1) {
    errors.push('network security config must contain one base system-CA trust chain');
    return errors;
  }
  if (elements.length !== 4) {
    errors.push(
      'network security config must not contain domain, debug, pin, or extra trust rules',
    );
  }
  if (
    base[0].attributes.size !== 1 ||
    base[0].attributes.get('cleartextTrafficPermitted') !== 'true'
  ) {
    errors.push(
      'network security base config must preserve cleartext for the separately consented HTTP path',
    );
  }
  if (certificates[0].attributes.size !== 1 || certificates[0].attributes.get('src') !== 'system') {
    errors.push('network security config must trust only Android system CAs');
  }
  if (certificates[0].compiledAttributeKinds?.has('src')) {
    errors.push('network security config certificate src must be a literal, uncompiled value');
  }
  if (root[0].attributes.size !== 0 || anchors[0].attributes.size !== 0) {
    errors.push('network security config must not add unreviewed root or trust-anchor attributes');
  }

  return errors;
}

export function validateSystemCaNetworkSecurityConfig(source) {
  return validateSystemCaNetworkSecurityConfigElements(parseElements(source));
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
  const matches = messageFields(fields, number);
  if (matches.length > 1) throw new Error(`protobuf field ${number} is unexpectedly repeated`);
  return matches[0]?.toString('utf8');
}

function scalarField(fields, number) {
  const matches = fields.filter((field) => field.number === number && field.wireType === 0);
  if (matches.length > 1) throw new Error(`protobuf field ${number} is unexpectedly repeated`);
  return matches[0]?.value;
}

function wrappedIdField(fields, number, label) {
  const messages = messageFields(fields, number);
  if (messages.length !== 1) throw new Error(`${label} must contain exactly one id wrapper`);
  const id = scalarField(decodeProtoFields(messages[0]), 1);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} is missing a valid id`);
  return id;
}

function qualifiedProtoXmlName(namespace, localName, label) {
  if (localName.includes(':')) {
    throw new Error(`protobuf XML ${label} local name must not contain a namespace prefix`);
  }
  if (!namespace) return localName;
  if (namespace === ANDROID_NAMESPACE) return `android:${localName}`;
  return `{${namespace}}${localName}`;
}

function decodeProtoXmlAttribute(input) {
  const fields = decodeProtoFields(input);
  const namespace = stringField(fields, 1) ?? '';
  const localName = stringField(fields, 2);
  if (!localName) throw new Error('protobuf XML attribute is missing its name');
  const name = qualifiedProtoXmlName(namespace, localName, 'attribute');
  const compiledItems = messageFields(fields, 6);
  if (compiledItems.length > 1) {
    throw new Error(`protobuf XML attribute ${name} repeats its compiled item`);
  }
  let compiledResourceId;
  let compiledReferenceName;
  let compiledItemKind;
  let compiledReferenceIsPlain = false;
  if (compiledItems.length === 1) {
    const itemFields = decodeProtoFields(compiledItems[0]);
    const itemValues = itemFields.filter((field) => field.number >= 1 && field.number <= 7);
    if (itemValues.length !== 1 || itemValues[0].wireType !== 2) {
      throw new Error(`protobuf XML attribute ${name} compiled item must have exactly one value`);
    }
    compiledItemKind = itemValues[0].number;
    if (compiledItemKind === 1) {
      const referenceFields = decodeProtoFields(itemValues[0].value);
      compiledResourceId = scalarField(referenceFields, 2);
      compiledReferenceName = stringField(referenceFields, 3);
      compiledReferenceIsPlain =
        (scalarField(referenceFields, 1) ?? 0) === 0 &&
        (scalarField(referenceFields, 4) ?? 0) === 0 &&
        messageFields(referenceFields, 5).length === 0 &&
        (scalarField(referenceFields, 7) ?? 0) === 0 &&
        !itemFields.some((field) => field.number >= 8);
    }
  }
  return {
    name,
    value: stringField(fields, 3) ?? '',
    compiledResourceId,
    compiledReferenceName,
    compiledItemKind,
    compiledReferenceIsPlain,
  };
}

function decodeProtoXmlNode(input, parent, elements) {
  const fields = decodeProtoFields(input);
  const encodedElements = messageFields(fields, 1);
  const encodedTexts = messageFields(fields, 2);
  if (encodedElements.length + encodedTexts.length !== 1) {
    throw new Error('protobuf XML node must contain exactly one element or text value');
  }
  if (encodedTexts.length === 1) return undefined;
  const encodedElement = encodedElements[0];

  const elementFields = decodeProtoFields(encodedElement);
  const namespace = stringField(elementFields, 2) ?? '';
  const localName = stringField(elementFields, 3);
  if (!localName) throw new Error('protobuf XML element is missing its name');
  const name = qualifiedProtoXmlName(namespace, localName, 'element');
  const element = {
    name,
    attributes: new Map(),
    compiledAttributeKinds: new Map(),
    compiledReferenceNames: new Map(),
    plainCompiledReferences: new Set(),
    compiledResourceIds: new Map(),
    parent,
    children: [],
  };
  for (const encodedAttribute of messageFields(elementFields, 4)) {
    const attribute = decodeProtoXmlAttribute(encodedAttribute);
    if (element.attributes.has(attribute.name)) {
      throw new Error(`protobuf XML element ${name} repeats attribute ${attribute.name}`);
    }
    element.attributes.set(attribute.name, attribute.value);
    if (attribute.compiledItemKind !== undefined) {
      element.compiledAttributeKinds.set(attribute.name, attribute.compiledItemKind);
    }
    if (attribute.compiledReferenceIsPlain) {
      element.plainCompiledReferences.add(attribute.name);
    }
    if (attribute.compiledReferenceName !== undefined) {
      element.compiledReferenceNames.set(attribute.name, attribute.compiledReferenceName);
    }
    if (attribute.compiledResourceId !== undefined) {
      element.compiledResourceIds.set(attribute.name, attribute.compiledResourceId);
    }
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

/**
 * Resolve the manifest's compiled Network Security Config reference through the AAB resource table.
 * This prevents a safe-looking, unused XML file from hiding a qualified variant or values alias
 * that Android would select at runtime.
 */
export function resolvePackagedNetworkSecurityConfig(manifestProto, resourcesProto) {
  const manifestElements = decodeProtoXml(manifestProto);
  const manifest = manifestElements.find(
    (element) => element.name === 'manifest' && element.parent == null,
  );
  const application = manifestElements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  const packageName = manifest?.attributes.get('package');
  const reference = application?.attributes.get('android:networkSecurityConfig');
  const compiledResourceId = application?.compiledResourceIds.get('android:networkSecurityConfig');
  if (!packageName) throw new Error('packaged manifest is missing its application package');
  if (reference !== NETWORK_SECURITY_CONFIG_REFERENCE) {
    throw new Error(
      `packaged manifest must reference ${NETWORK_SECURITY_CONFIG_REFERENCE} exactly`,
    );
  }
  if (
    application?.compiledAttributeKinds.get('android:networkSecurityConfig') !== 1 ||
    !application?.plainCompiledReferences.has('android:networkSecurityConfig')
  ) {
    throw new Error(
      'packaged manifest network security config must compile to one plain resource reference',
    );
  }
  const compiledReferenceName = application.compiledReferenceNames.get(
    'android:networkSecurityConfig',
  );
  if (compiledReferenceName && compiledReferenceName !== 'xml/network_security_config') {
    throw new Error(
      'packaged manifest network security config compiled reference has the wrong name',
    );
  }
  if (!Number.isSafeInteger(compiledResourceId) || compiledResourceId <= 0) {
    throw new Error(
      'packaged manifest network security config is missing its compiled resource id',
    );
  }

  const tableFields = decodeProtoFields(resourcesProto);
  const matches = [];
  for (const packageMessage of messageFields(tableFields, 2)) {
    const packageFields = decodeProtoFields(packageMessage);
    const candidatePackageName = stringField(packageFields, 2);
    if (candidatePackageName !== packageName) continue;
    const packageId = wrappedIdField(packageFields, 1, `resource package ${packageName}`);

    for (const typeMessage of messageFields(packageFields, 3)) {
      const typeFields = decodeProtoFields(typeMessage);
      if (stringField(typeFields, 2) !== 'xml') continue;
      const typeId = wrappedIdField(typeFields, 1, 'xml resource type');

      for (const entryMessage of messageFields(typeFields, 3)) {
        const entryFields = decodeProtoFields(entryMessage);
        if (stringField(entryFields, 2) !== 'network_security_config') continue;
        const entryId = wrappedIdField(entryFields, 1, 'network_security_config resource');
        matches.push({
          resourceId: packageId * 0x1000000 + typeId * 0x10000 + entryId,
          activeValues: messageFields(entryFields, 6),
          disabledValues: messageFields(entryFields, 8),
        });
      }
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `AAB resource table must contain exactly one ${packageName}:xml/network_security_config entry`,
    );
  }
  const match = matches[0];
  if (match.resourceId !== compiledResourceId) {
    throw new Error(
      'packaged manifest network security config id does not match the named resource-table entry',
    );
  }
  if (match.disabledValues.length !== 0) {
    throw new Error('network_security_config must not have flag-disabled resource variants');
  }
  if (match.activeValues.length !== 1) {
    throw new Error('network_security_config must have exactly one active resource value');
  }

  const configValueFields = decodeProtoFields(match.activeValues[0]);
  const configurations = messageFields(configValueFields, 1);
  if (
    configurations.length > 1 ||
    (configurations.length === 1 && decodeProtoFields(configurations[0]).length !== 0)
  ) {
    throw new Error('network_security_config must not have a qualified resource variant');
  }
  const values = messageFields(configValueFields, 2);
  if (values.length !== 1) throw new Error('network_security_config resource value is missing');
  const valueFields = decodeProtoFields(values[0]);
  const items = messageFields(valueFields, 4);
  if (items.length !== 1 || messageFields(valueFields, 5).length !== 0) {
    throw new Error('network_security_config resource value must be one file item');
  }

  const itemFields = decodeProtoFields(items[0]);
  if (messageFields(itemFields, 1).length !== 0) {
    throw new Error('network_security_config resource aliases are forbidden');
  }
  if (
    itemFields.some(
      (field) =>
        (field.number >= 1 && field.number <= 7 && field.number !== 5) || field.number >= 8,
    )
  ) {
    throw new Error('network_security_config must be an unflagged protobuf XML file reference');
  }
  const files = messageFields(itemFields, 5);
  if (files.length !== 1) {
    throw new Error('network_security_config must resolve to exactly one protobuf XML file');
  }
  const fileFields = decodeProtoFields(files[0]);
  const path = stringField(fileFields, 1);
  const fileType = scalarField(fileFields, 2);
  if (
    !path ||
    !/^res\/(?:[^/]+\/)?[^/]+\.xml$/.test(path) ||
    path.includes('..') ||
    fileType !== 3
  ) {
    throw new Error('network_security_config must resolve to a safe PROTO_XML resource path');
  }

  return { path, resourceId: compiledResourceId };
}

export function validatePackagedAndroidBundle({
  manifestProto,
  networkSecurityConfigProto,
  shortcutsProto,
  dexBytes,
}) {
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

  if (!networkSecurityConfigProto) {
    errors.push('packaged network security config protobuf is missing');
  } else {
    try {
      errors.push(
        ...validateSystemCaNetworkSecurityConfigElements(
          decodeProtoXml(networkSecurityConfigProto),
        ).map((error) => `packaged network security config: ${error}`),
      );
    } catch (error) {
      errors.push(
        `packaged network security config protobuf is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    for (const marker of REQUIRED_PINNED_SHORTCUT_CLEANUP_DEX_MARKERS) {
      if (!dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX is missing required pinned-shortcut cleanup marker: ${marker}`);
      }
    }
    for (const marker of FORBIDDEN_LEGACY_SHORTCUT_PUBLISHER_DEX_MARKERS) {
      if (dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX contains forbidden legacy shortcut-publishing marker: ${marker}`);
      }
    }
    const communityWebViewMarker = FORBIDDEN_COMMUNITY_WEBVIEW_DEX_MARKERS.find((marker) =>
      dexBytes.includes(Buffer.from(marker, 'utf8')),
    );
    if (communityWebViewMarker) {
      errors.push(
        `packaged DEX contains forbidden direct community WebView marker: ${communityWebViewMarker}`,
      );
    }
    for (const marker of FORBIDDEN_INBOUND_SHARE_DEX_MARKERS) {
      if (dexBytes.includes(Buffer.from(marker, 'utf8'))) {
        errors.push(`packaged DEX contains disabled inbound-share native marker: ${marker}`);
      }
    }
  }

  return errors;
}

/**
 * Inspect one built Android App Bundle without requiring a generated native tree.
 *
 * This is the release-tool boundary: it applies the same packaged manifest/shortcuts/DEX contract
 * as the full Android build guard, then returns only the finite identity fields needed to bind an
 * artifact to its release record.
 */
export function inspectPackagedAndroidBundle(
  bundlePath,
  { reviewedSensitiveMetadataExceptions = REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS } = {},
) {
  const snapshot = readAabArchiveSnapshot(bundlePath);
  const sensitiveMetadataFindings = scanZipArchiveForSensitiveMetadata(
    snapshot.bytes,
    snapshot.archive,
    { reviewedExceptions: reviewedSensitiveMetadataExceptions },
  );
  if (sensitiveMetadataFindings.length > 0) {
    throw new Error(
      [
        'packaged AAB contains forbidden absolute user-directory metadata:',
        ...sensitiveMetadataFindings.map((finding) => `- ${finding.path}: ${finding.rule}`),
      ].join('\n'),
    );
  }

  const manifestEntry = snapshot.archive.entries.find(
    (entry) => entry.path === PACKAGED_MANIFEST_ENTRY && !entry.directory,
  );
  if (!manifestEntry) throw new Error(`could not read ${PACKAGED_MANIFEST_ENTRY} from AAB`);
  const manifestProto = extractZipEntry(snapshot.bytes, manifestEntry, 16 * 1024 * 1024);
  const resourcesEntries = snapshot.archive.entries.filter(
    (entry) => entry.path === PACKAGED_RESOURCES_ENTRY && !entry.directory,
  );
  if (resourcesEntries.length !== 1) {
    throw new Error(
      `expected exactly one ${PACKAGED_RESOURCES_ENTRY} in AAB; found ${resourcesEntries.length}`,
    );
  }
  const resourcesProto = extractZipEntry(snapshot.bytes, resourcesEntries[0], 16 * 1024 * 1024);
  const resolvedNetworkSecurityConfig = resolvePackagedNetworkSecurityConfig(
    manifestProto,
    resourcesProto,
  );
  const packagedNetworkSecurityConfigPath = `base/${resolvedNetworkSecurityConfig.path}`;
  const networkSecurityConfigEntries = snapshot.archive.entries.filter(
    (entry) => entry.path === packagedNetworkSecurityConfigPath && !entry.directory,
  );
  if (networkSecurityConfigEntries.length !== 1) {
    throw new Error(
      `expected exactly one resolved ${packagedNetworkSecurityConfigPath} in AAB; found ${networkSecurityConfigEntries.length}`,
    );
  }
  const networkSecurityConfigProto = extractZipEntry(
    snapshot.bytes,
    networkSecurityConfigEntries[0],
    1024 * 1024,
  );
  const shortcutsEntry = snapshot.archive.entries.find(
    (entry) => entry.path === PACKAGED_SHORTCUTS_ENTRY && !entry.directory,
  );
  const dexEntries = snapshot.archive.entries
    .filter((entry) => PACKAGED_DEX_PATTERN.test(entry.path) && !entry.directory)
    .sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  const totalDexBytes = dexEntries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  if (dexEntries.length === 0 || totalDexBytes === 0 || totalDexBytes > MAX_PACKAGED_DEX_BYTES) {
    throw new Error('packaged DEX entries are missing, empty, or exceed the 256 MiB limit');
  }
  const errors = validatePackagedAndroidBundle({
    manifestProto,
    networkSecurityConfigProto,
    shortcutsProto: shortcutsEntry
      ? extractZipEntry(snapshot.bytes, shortcutsEntry, 16 * 1024 * 1024)
      : undefined,
    // The package/lock/autolinking checks prevent a clean build from linking the removed module.
    // This additionally rejects a stale or otherwise contaminated release artifact.
    dexBytes: Buffer.concat(
      dexEntries.map((entry) => extractZipEntry(snapshot.bytes, entry, MAX_PACKAGED_DEX_BYTES)),
      totalDexBytes,
    ),
  });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));

  const manifestElements = decodeProtoXml(manifestProto);
  const manifest = manifestElements.find(
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

  const googleMapsApiKey = googleMapsApiKeyFromElements(manifestElements).value;
  if (!googleMapsApiKey) {
    throw new Error('packaged manifest identity is missing its validated Google Maps API key');
  }

  return {
    applicationId,
    versionName,
    versionCode,
    googleMapsApiKeySha256: createHash('sha256').update(googleMapsApiKey).digest('hex'),
  };
}

function googleMapsApiKeyFromElements(elements) {
  const application = elements.find(
    (element) => element.name === 'application' && element.parent?.name === 'manifest',
  );
  const entries = (application?.children ?? []).filter(
    (child) =>
      child.name === 'meta-data' &&
      child.attributes.get('android:name') === GOOGLE_MAPS_API_KEY_METADATA_NAME,
  );
  return {
    count: entries.length,
    value: entries[0]?.attributes.get('android:value'),
  };
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
  if (
    application?.attributes.get('android:networkSecurityConfig') !==
    NETWORK_SECURITY_CONFIG_REFERENCE
  ) {
    errors.push(
      `application must set android:networkSecurityConfig="${NETWORK_SECURITY_CONFIG_REFERENCE}"`,
    );
  }

  const mapsApiKey = googleMapsApiKeyFromElements(elements);
  if (mapsApiKey.count !== 1) {
    errors.push('application must declare exactly one Google Maps API key metadata entry');
  } else if (!mapsApiKey.value || !GOOGLE_MAPS_API_KEY_PATTERN.test(mapsApiKey.value)) {
    errors.push('Google Maps API key metadata must contain a valid Google API key');
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
  const staticImports = [...entrySource.matchAll(/^\s*import\b[^\n]*$/gm)];
  if (staticImports.length !== entryImports.length) {
    errors.push('index.js may contain only ordered side-effect imports');
  }
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
  const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  const entrySource = readFileSync(resolve(root, 'index.js'), 'utf8');
  const manifests = [
    ['debug', selectArtifactPath(root, debugManifestPath, DEFAULT_DEBUG_MANIFESTS)],
    ['release', selectArtifactPath(root, releaseManifestPath, DEFAULT_RELEASE_MANIFESTS)],
  ];
  const errors = validateExpoFileSystemRedirectContainment({
    packageJson,
    packageLock,
    patchSource: readFileSync(resolve(root, EXPO_FILE_SYSTEM_PATCH_PATH), 'utf8'),
    legacyModuleSource: readFileSync(resolve(root, EXPO_FILE_SYSTEM_LEGACY_ANDROID_PATH), 'utf8'),
    appConfigSource: readFileSync(resolve(root, 'app.config.ts'), 'utf8'),
  }).map((error) => `network redirect containment: ${error}`);

  const networkSecurityConfigPath = resolve(root, DEFAULT_NETWORK_SECURITY_CONFIG);
  if (!existsSync(networkSecurityConfigPath)) {
    errors.push(`network security config is missing: ${networkSecurityConfigPath}`);
  } else {
    errors.push(
      ...validateSystemCaNetworkSecurityConfig(readFileSync(networkSecurityConfigPath, 'utf8')).map(
        (error) => `network security config: ${error}`,
      ),
    );
  }

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
    networkSecurityConfigPath,
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
