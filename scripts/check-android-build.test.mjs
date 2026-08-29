import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  FORBIDDEN_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  runAndroidBuildCheck,
  validateAndroidBuild,
  validatePackagedAndroidBundle,
} from './check-android-build.mjs';

const androidNamespace = 'http://schemas.android.com/apk/res/android';
const intendedPermissions = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.CAMERA',
];

function xmlNode(name, attributes = {}, children = []) {
  return { name, attributes, children };
}

function renderXml(node) {
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes} />`;
  return `<${node.name}${attributes}>${node.children.map(renderXml).join('')}</${node.name}>`;
}

function intentFilter(action, category, mimeType) {
  return xmlNode('intent-filter', {}, [
    xmlNode('action', { 'android:name': action }),
    xmlNode('category', { 'android:name': category }),
    ...(mimeType ? [xmlNode('data', { 'android:mimeType': mimeType })] : []),
  ]);
}

const manifestNode = xmlNode(
  'manifest',
  {
    'xmlns:android': androidNamespace,
    package: 'com.bluegreengatorapps.messages',
    'android:versionName': '0.1.41',
    'android:versionCode': '57',
  },
  [
    ...intendedPermissions.map((name) => xmlNode('uses-permission', { 'android:name': name })),
    // Package visibility for sharing OUT of Gator is harmless. It is not nested below an
    // application component, so it cannot make MainActivity an inbound Android share target.
    xmlNode('queries', {}, [
      xmlNode('intent', {}, [
        xmlNode('action', { 'android:name': 'android.intent.action.SEND' }),
        xmlNode('data', { 'android:mimeType': '*/*' }),
      ]),
    ]),
    xmlNode('application', { 'android:allowBackup': 'false' }, [
      xmlNode('activity', { 'android:name': '.MainActivity', 'android:exported': 'true' }, [
        intentFilter('android.intent.action.MAIN', 'android.intent.category.LAUNCHER'),
      ]),
      xmlNode('service', {
        'android:name': 'app.notifee.core.ReceiverService',
        'android:exported': 'false',
      }),
      xmlNode('service', {
        'android:name':
          'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingHeadlessService',
        'android:exported': 'false',
      }),
      xmlNode('service', {
        'android:name': 'io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService',
        'android:exported': 'false',
      }),
      xmlNode('receiver', {
        'android:name': 'expo.modules.taskManager.TaskBroadcastReceiver',
        'android:exported': 'false',
      }),
      xmlNode('service', {
        'android:name': 'expo.modules.taskManager.TaskJobService',
        'android:enabled': 'true',
        'android:exported': 'false',
        'android:permission': 'android.permission.BIND_JOB_SERVICE',
      }),
    ]),
  ],
);

function forbiddenShareTargetNode() {
  return xmlNode('shortcuts', {}, [
    xmlNode('share-target', { 'android:targetClass': '.MainActivity' }, [
      xmlNode('data', { 'android:mimeType': '*/*' }),
    ]),
  ]);
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function encodeMessageField(number, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeStringField(number, value) {
  return encodeMessageField(number, Buffer.from(value, 'utf8'));
}

function encodeXmlAttribute(name, value) {
  const androidName = name.startsWith('android:') ? name.slice('android:'.length) : undefined;
  return Buffer.concat([
    ...(androidName ? [encodeStringField(1, androidNamespace)] : []),
    encodeStringField(2, androidName ?? name),
    encodeStringField(3, value),
  ]);
}

function encodeXmlDocument(node) {
  const element = Buffer.concat([
    encodeStringField(3, node.name),
    ...Object.entries(node.attributes)
      .filter(([name]) => name !== 'xmlns:android')
      .map(([name, value]) => encodeMessageField(4, encodeXmlAttribute(name, value))),
    ...node.children.map((child) => encodeMessageField(5, encodeXmlDocument(child))),
  ]);
  return encodeMessageField(1, element);
}

const manifest = renderXml(manifestNode);
const entrySource = `
import './src/services/errors/registerReactNativeExceptionPrivacy';
import './src/services/logging/registerPersistentLogs';
import './src/services/notifications/backgroundEvents';
import './src/services/background/registerBackgroundSyncHeadlessTask';
import './src/services/notifications/registerFcmBackgroundHandler';
import './src/services/download/registerBoundedNativeDownloadCleanup';
import 'expo-router/entry';
`;

function validate(overrides = {}) {
  return validateAndroidBuild({
    manifest,
    packageJson: { main: 'index.js' },
    entrySource,
    ...overrides,
  });
}

test('accepts the expected manifest and headless entry order', () => {
  assert.deepEqual(REQUIRED_PERMISSIONS, intendedPermissions);
  assert.deepEqual(validate(), []);
});

test('requires every intended sensitive and product permission', () => {
  for (const permission of REQUIRED_PERMISSIONS) {
    const errors = validate({
      manifest: manifest.replace(`<uses-permission android:name="${permission}" />`, ''),
    });
    assert.ok(
      errors.some((error) => error.includes(permission)),
      permission,
    );
  }
});

test('rejects a required permission when every declaration is capped to an older Android SDK', () => {
  const permission = 'android.permission.CAMERA';
  const cappedDeclaration = `<uses-permission android:name="${permission}" android:maxSdkVersion="32" />`;
  const errors = validate({
    manifest: manifest.replace(
      `<uses-permission android:name="${permission}" />`,
      cappedDeclaration,
    ),
  });
  assert.ok(
    errors.some(
      (error) => error === `required permission is capped by android:maxSdkVersion: ${permission}`,
    ),
  );

  const cappedManifestNode = structuredClone(manifestNode);
  const permissionNode = cappedManifestNode.children.find(
    (child) => child.attributes['android:name'] === permission,
  );
  assert.ok(permissionNode);
  permissionNode.attributes['android:maxSdkVersion'] = '32';
  const packagedErrors = validatePackagedAndroidBundle({
    manifestProto: encodeXmlDocument(cappedManifestNode),
  });
  assert.ok(
    packagedErrors.some((error) =>
      error.includes(`required permission is capped by android:maxSdkVersion: ${permission}`),
    ),
  );
});

test('rejects every forbidden permission', () => {
  for (const permission of FORBIDDEN_PERMISSIONS) {
    const errors = validate({
      manifest: manifest.replace(
        '</manifest>',
        `<uses-permission android:name="${permission}" /></manifest>`,
      ),
    });
    assert.ok(
      errors.some((error) => error.includes(permission)),
      permission,
    );
  }

  const debugOverlay = validate({
    debug: true,
    manifest: manifest.replace(
      '</manifest>',
      '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" /></manifest>',
    ),
  });
  assert.ok(
    !debugOverlay.some((error) => error.includes('android.permission.SYSTEM_ALERT_WINDOW')),
  );
});

test('rejects backup enablement or an unsafe native component declaration', () => {
  const backupErrors = validate({
    manifest: manifest.replace('allowBackup="false"', 'allowBackup="true"'),
  });
  assert.ok(backupErrors.some((error) => error.includes('allowBackup')));

  const headlessErrors = validate({
    manifest: manifest.replace(
      'ReactNativeFirebaseMessagingHeadlessService" android:exported="false"',
      'ReactNativeFirebaseMessagingHeadlessService" android:exported="true"',
    ),
  });
  assert.ok(headlessErrors.some((error) => error.includes('android:exported="false"')));
});

test('does not accept component names in comments or on the wrong XML element', () => {
  const component =
    '<service android:name="app.notifee.core.ReceiverService" android:exported="false" />';
  const commentedErrors = validate({
    manifest: manifest.replace(component, `<!-- ${component} -->`),
  });
  assert.ok(commentedErrors.some((error) => error.includes('ReceiverService')));

  const wrongElementErrors = validate({
    manifest: manifest.replace(
      component,
      '<meta-data android:name="app.notifee.core.ReceiverService" android:value="false" />',
    ),
  });
  assert.ok(wrongElementErrors.some((error) => error.includes('<service>')));
});

test('allows outbound ACTION_SEND queries but rejects inbound component filters and metadata', () => {
  assert.deepEqual(validate(), []);

  for (const action of ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']) {
    const inboundFilter = renderXml(intentFilter(action, 'android.intent.category.DEFAULT', '*/*'));
    const errors = validate({
      manifest: manifest.replace('</activity>', `${inboundFilter}</activity>`),
    });
    assert.ok(
      errors.some((error) => error.includes(`must not declare inbound ${action}`)),
      action,
    );
  }

  const alias = renderXml(
    xmlNode('activity-alias', { 'android:name': '.ShareAlias' }, [
      intentFilter('android.intent.action.SEND', 'android.intent.category.DEFAULT', '*/*'),
    ]),
  );
  const aliasErrors = validate({
    manifest: manifest.replace('</application>', `${alias}</application>`),
  });
  assert.ok(aliasErrors.some((error) => error.includes('.ShareAlias must not declare inbound')));

  const metadata = renderXml(
    xmlNode('meta-data', {
      'android:name': 'android.app.shortcuts',
      'android:resource': '@xml/shortcuts',
    }),
  );
  const metadataErrors = validate({
    manifest: manifest.replace('</activity>', `${metadata}</activity>`),
  });
  assert.ok(
    metadataErrors.some((error) => error.includes('must not declare android.app.shortcuts')),
  );
});

test('rejects a bypassed or late expo-router bundle entry', () => {
  const wrongMain = validate({ packageJson: { main: 'expo-router/entry' } });
  assert.ok(wrongMain.some((error) => error.includes('package.json main')));

  const missingRestartCleanup = validate({
    entrySource: entrySource.replace(
      "import './src/services/download/registerBoundedNativeDownloadCleanup';\n",
      '',
    ),
  });
  assert.ok(
    missingRestartCleanup.some((error) =>
      error.includes(
        'required startup import ./src/services/download/registerBoundedNativeDownloadCleanup',
      ),
    ),
  );

  const latePrivacyBoundary = validate({
    entrySource: entrySource
      .replace("import './src/services/errors/registerReactNativeExceptionPrivacy';\n", '')
      .replace(
        "import './src/services/notifications/backgroundEvents';\n",
        "import './src/services/notifications/backgroundEvents';\nimport './src/services/errors/registerReactNativeExceptionPrivacy';\n",
      ),
  });
  assert.ok(
    latePrivacyBoundary.some((error) => error.includes('must be the first index.js side-effect')),
  );

  const latePersistentLogs = validate({
    entrySource: entrySource
      .replace("import './src/services/logging/registerPersistentLogs';\n", '')
      .replace(
        "import './src/services/notifications/backgroundEvents';\n",
        "import './src/services/notifications/backgroundEvents';\nimport './src/services/logging/registerPersistentLogs';\n",
      ),
  });
  assert.ok(latePersistentLogs.some((error) => error.includes('before headless tasks')));

  const lateRegistration = validate({
    entrySource: `import 'expo-router/entry';\nimport './src/services/notifications/registerFcmBackgroundHandler';`,
  });
  assert.ok(lateRegistration.some((error) => error.includes('final side-effect import')));
  assert.ok(lateRegistration.some((error) => error.includes('must load before')));
});

test('validates the packaged protobuf manifest and rejects a Direct Share resource', () => {
  const manifestProto = encodeXmlDocument(manifestNode);
  assert.deepEqual(
    validatePackagedAndroidBundle({ manifestProto, dexBytes: Buffer.from('clean dex') }),
    [],
  );

  const forbiddenTarget = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: encodeXmlDocument(forbiddenShareTargetNode()),
  });
  assert.ok(forbiddenTarget.some((error) => error.includes('must not contain <share-target>')));

  const forbiddenNativeModule = validatePackagedAndroidBundle({
    manifestProto,
    dexBytes: Buffer.from('Lexpo/modules/shareintent/ExpoShareIntentModule;'),
  });
  assert.ok(
    forbiddenNativeModule.some((error) => error.includes('disabled inbound-share native marker')),
  );

  const invalidShortcuts = validatePackagedAndroidBundle({
    manifestProto,
    shortcutsProto: Buffer.from('not protobuf XML'),
  });
  assert.ok(invalidShortcuts.some((error) => error.includes('shortcuts.xml protobuf is invalid')));
});

function writeTestAab(
  root,
  relativePath,
  { includeForbiddenShareTarget = false, includeForbiddenNativeModule = false } = {},
) {
  const staging = join(root, 'bundle-staging');
  const absolutePath = join(root, relativePath);
  rmSync(staging, { recursive: true, force: true });
  rmSync(absolutePath, { force: true });
  mkdirSync(join(staging, 'base', 'manifest'), { recursive: true });
  mkdirSync(join(staging, 'base', 'dex'), { recursive: true });
  writeFileSync(
    join(staging, 'base', 'manifest', 'AndroidManifest.xml'),
    encodeXmlDocument(manifestNode),
  );
  writeFileSync(
    join(staging, 'base', 'dex', 'classes.dex'),
    includeForbiddenNativeModule
      ? 'Lexpo/modules/shareintent/ExpoShareIntentModule;'
      : 'clean dex fixture',
  );
  if (includeForbiddenShareTarget) {
    mkdirSync(join(staging, 'base', 'res', 'xml'), { recursive: true });
    writeFileSync(
      join(staging, 'base', 'res', 'xml', 'shortcuts.xml'),
      encodeXmlDocument(forbiddenShareTargetNode()),
    );
  }
  const result = spawnSync('zip', ['-q', '-r', absolutePath, 'base'], {
    cwd: staging,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('artifact runner inspects both variants and the final release AAB contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'gator-android-guard-'));
  const debugManifestPath = 'artifacts/debug.xml';
  const releaseManifestPath = 'artifacts/release.xml';
  const releaseBundlePath = 'artifacts/app-release.aab';
  const options = {
    root,
    debugManifestPath,
    releaseManifestPath,
    releaseBundlePath,
  };

  try {
    mkdirSync(join(root, 'artifacts'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(join(root, 'index.js'), entrySource);
    writeFileSync(join(root, debugManifestPath), manifest);
    writeFileSync(
      join(root, releaseManifestPath),
      manifest.replace('<uses-permission android:name="android.permission.CAMERA" />', ''),
    );
    writeFileSync(join(root, releaseBundlePath), '');

    assert.throws(() => runAndroidBuildCheck(options), /release manifest:.*CAMERA/s);

    writeFileSync(join(root, releaseManifestPath), manifest);
    assert.throws(() => runAndroidBuildCheck(options), /release AAB is missing or empty/);

    writeFileSync(join(root, releaseBundlePath), 'not a ZIP-formatted AAB');
    assert.throws(() => runAndroidBuildCheck(options), /release AAB inspection failed/);

    writeTestAab(root, releaseBundlePath);
    assert.doesNotThrow(() => runAndroidBuildCheck(options));

    writeTestAab(root, releaseBundlePath, { includeForbiddenShareTarget: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged shortcuts.xml must not contain <share-target>/,
    );

    writeTestAab(root, releaseBundlePath, { includeForbiddenNativeModule: true });
    assert.throws(
      () => runAndroidBuildCheck(options),
      /packaged DEX contains disabled inbound-share native marker/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
