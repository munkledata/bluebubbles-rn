#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REQUIRED_NODE_VERSION = '24.19.0';
export const REQUIRED_NODE_ENGINE = '>=24.19.0 <25';
export const REQUIRED_NPM_VERSION = '11.17.0';
export const REQUIRED_EAS_CLI_VERSION = '21.5.0';
export const REQUIRED_ANDROID_ARCHITECTURES = Object.freeze({
  development: 'arm64-v8a,x86_64',
  preview: 'arm64-v8a,x86_64',
  production: 'arm64-v8a',
});
export const REQUIRED_NATIVE_BOUNDARY_PINS = Object.freeze({
  '@op-engineering/op-sqlite': '17.1.2',
  '@react-native-firebase/app': '25.1.0',
  '@react-native-firebase/messaging': '25.1.0',
  '@shopify/flash-list': '2.0.2',
  'drizzle-orm': '0.45.2',
  'react-native-notify-kit': '10.4.8',
  'react-native-webview': '13.16.1',
});
export const FORBIDDEN_NATIVE_BOUNDARY_PACKAGES = Object.freeze(['expo-share-intent']);
const ALTERNATE_DEPENDENCY_SECTIONS = Object.freeze([
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const DEPENDENCY_SECTIONS = Object.freeze(['dependencies', ...ALTERNATE_DEPENDENCY_SECTIONS]);
const REQUIRED_EAS_BUILD_PROFILES = Object.freeze(['base', 'development', 'preview', 'production']);
const EAS_NPX_ENV_UNSET =
  'unset npm_config_ignore_scripts npm_config_call npm_config_package npm_config_yes; ';
export const REQUIRED_ANDROID_RELEASE_POLICY = Object.freeze({
  easCliPackage: `eas-cli@${REQUIRED_EAS_CLI_VERSION}`,
  localBuildPluginPackage: `eas-cli-local-build-plugin@${REQUIRED_EAS_CLI_VERSION}`,
  buildCommand: `${EAS_NPX_ENV_UNSET}exec eas build -p android --profile production --local --output "$GATOR_RELEASE_OUTPUT" --non-interactive --freeze-credentials`,
  submitCommand: `${EAS_NPX_ENV_UNSET}exec eas submit -p android --profile production --path "$GATOR_RELEASE_ARTIFACT" --non-interactive --wait`,
});
export const REQUIRED_EAS_SUBMIT_CONFIG = Object.freeze({
  production: Object.freeze({
    android: Object.freeze({
      track: 'internal',
      serviceAccountKeyPath: './play-service-account.json',
    }),
  }),
});
export const REQUIRED_RELEASE_SCRIPTS = Object.freeze({
  'release:android': 'node scripts/release-android.mjs help',
  'release:android:preflight': 'node scripts/release-android.mjs preflight',
  'release:android:prepare': 'node scripts/release-android.mjs prepare',
  'release:android:build': 'node scripts/release-android.mjs build',
  'release:android:validate': 'node scripts/release-android.mjs validate',
  'release:android:promote': 'node scripts/release-android.mjs promote',
  'release:android:submit': 'node scripts/release-android.mjs submit',
  'release:android:status': 'node scripts/release-android.mjs status',
  'release:android:reconcile': 'node scripts/release-android.mjs reconcile',
  'release:android:cleanup': 'node scripts/release-android.mjs cleanup',
});
const PROTECTED_NATIVE_BOUNDARY_PACKAGES = new Set([
  ...Object.keys(REQUIRED_NATIVE_BOUNDARY_PINS),
  ...FORBIDDEN_NATIVE_BOUNDARY_PACKAGES,
]);
const REVIEWED_RELEASE_SCRIPT_NAMES = new Set(Object.keys(REQUIRED_RELEASE_SCRIPTS));
const EAS_BUILD_OR_SUBMIT_PATTERN =
  /(?:(?:\beas\b|\beas-cli(?:@[^\s'\"]+)?\b)[^\n]*(?:\bbuild\b|\bsubmit\b)|--auto-submit\b)/;
const ENVIRONMENT_SMOKE_FLAG = '--environment-smoke';
const ENVIRONMENT_SMOKE_STEP_NAME = 'Smoke controlled environment config resolution';
const ENVIRONMENT_SMOKE_COMMAND = `node scripts/check-toolchain.mjs ${ENVIRONMENT_SMOKE_FLAG}`;
const ENVIRONMENT_PROBE_FILE = '__gator_environment_probe_file__';
const LOCAL_GOOGLE_SERVICES_FILE = './google-services.json';
const REQUIRED_EXPO_IDENTITY = Object.freeze({
  name: 'Gator',
  slug: 'bluegreengatorappsmessages',
  androidPackage: 'com.bluegreengatorapps.messages',
});
export function npmVersionFromUserAgent(userAgent) {
  return userAgent?.match(/(?:^|\s)npm\/([^ ]+)/)?.[1];
}

function npmAliasTarget(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('npm:')) return undefined;
  const targetAndVersion = spec.slice('npm:'.length);
  const versionSeparator = targetAndVersion.startsWith('@')
    ? targetAndVersion.indexOf('@', targetAndVersion.indexOf('/') + 1)
    : targetAndVersion.indexOf('@');
  return versionSeparator < 0
    ? targetAndVersion || undefined
    : targetAndVersion.slice(0, versionSeparator) || undefined;
}

function rejectProtectedAliases(owner, dependencyOwner, errors) {
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [declaredName, spec] of Object.entries(dependencyOwner?.[section] ?? {})) {
      const target = npmAliasTarget(spec);
      if (target && PROTECTED_NATIVE_BOUNDARY_PACKAGES.has(target)) {
        errors.push(
          `${owner} ${section}.${declaredName} must not alias protected package ${target}`,
        );
      }
    }
  }
}

function overrideSelectorTarget(selector) {
  if (typeof selector !== 'string' || selector === '.' || selector.startsWith('$'))
    return undefined;
  const versionSeparator = selector.startsWith('@')
    ? selector.indexOf('@', selector.indexOf('/') + 1)
    : selector.indexOf('@');
  return versionSeparator < 0 ? selector : selector.slice(0, versionSeparator);
}

function rejectProtectedOverrides(value, errors, path = 'package.json overrides') {
  if (typeof value === 'string') {
    const aliasTarget = npmAliasTarget(value);
    if (aliasTarget && PROTECTED_NATIVE_BOUNDARY_PACKAGES.has(aliasTarget)) {
      errors.push(`${path} must not alias protected package ${aliasTarget}`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;

  for (const [selector, nestedValue] of Object.entries(value)) {
    const selectedPackage = overrideSelectorTarget(selector);
    if (selectedPackage && PROTECTED_NATIVE_BOUNDARY_PACKAGES.has(selectedPackage)) {
      errors.push(`${path}.${selector} must not override protected package ${selectedPackage}`);
    }
    rejectProtectedOverrides(nestedValue, errors, `${path}.${selector}`);
  }
}

export function reviewedEasNpxArgs(phase) {
  const command =
    phase === 'build'
      ? REQUIRED_ANDROID_RELEASE_POLICY.buildCommand
      : phase === 'submit'
        ? REQUIRED_ANDROID_RELEASE_POLICY.submitCommand
        : null;
  if (!command) throw new Error(`unreviewed EAS release phase: ${String(phase)}`);
  return [
    '--yes',
    '--ignore-scripts',
    '--package',
    REQUIRED_ANDROID_RELEASE_POLICY.easCliPackage,
    '-c',
    command,
  ];
}

export function reviewedLocalBuildPluginNpxArgs() {
  return [
    '--yes',
    '--ignore-scripts',
    '--package',
    REQUIRED_ANDROID_RELEASE_POLICY.localBuildPluginPackage,
    '-c',
    'command -v eas-cli-local-build-plugin',
  ];
}

export function validateReleaseRunnerSource(source) {
  if (typeof source !== 'string') return ['Android release runner source is unavailable'];
  const errors = [];
  for (const marker of [
    "reviewedEasNpxArgs('build')",
    "reviewedEasNpxArgs('submit')",
    'reviewedLocalBuildPluginNpxArgs()',
  ]) {
    if (source.split(marker).length !== 2) {
      errors.push(`Android release runner must use exactly one ${marker} invocation`);
    }
  }
  if (
    /exec eas (?:build|submit)\b|eas-cli(?:-local-build-plugin)?@|--auto-submit\b|--latest\b/.test(
      source,
    )
  ) {
    errors.push(
      'Android release runner must obtain EAS commands and package pins only from the reviewed policy helpers',
    );
  }
  return errors;
}

export function validateToolchain({
  actualNode,
  childNpm,
  eas,
  hasNpmShrinkwrap,
  invokingNpm,
  nvmNode,
  packageLock,
  packageJson,
}) {
  const errors = [];
  const expectedPackageManager = `npm@${REQUIRED_NPM_VERSION}`;

  if (nvmNode !== REQUIRED_NODE_VERSION) {
    errors.push(`.nvmrc is ${nvmNode}, but the reviewed Node version is ${REQUIRED_NODE_VERSION}`);
  }
  if (actualNode !== REQUIRED_NODE_VERSION) {
    errors.push(`runtime is ${actualNode}, but Node ${REQUIRED_NODE_VERSION} is required`);
  }
  if (packageJson?.engines?.node !== REQUIRED_NODE_ENGINE) {
    errors.push(
      `package.json engines.node is ${String(packageJson?.engines?.node)}, but ${REQUIRED_NODE_ENGINE} is required`,
    );
  }
  if (packageJson?.packageManager !== expectedPackageManager) {
    errors.push(
      `package.json packageManager is ${String(packageJson?.packageManager)}, but ${expectedPackageManager} is required`,
    );
  }
  if (childNpm !== REQUIRED_NPM_VERSION) {
    errors.push(`npm on PATH is ${childNpm}, but npm ${REQUIRED_NPM_VERSION} is required`);
  }
  if (invokingNpm != null && invokingNpm !== REQUIRED_NPM_VERSION) {
    errors.push(`invoking npm is ${invokingNpm}, but npm ${REQUIRED_NPM_VERSION} is required`);
  }

  if (hasNpmShrinkwrap) {
    errors.push('npm-shrinkwrap.json must remain absent so package-lock.json is authoritative');
  }

  if (
    packageLock?.lockfileVersion !== 3 ||
    !packageLock.packages ||
    typeof packageLock.packages !== 'object' ||
    Array.isArray(packageLock.packages) ||
    !Object.hasOwn(packageLock.packages, '')
  ) {
    errors.push('package-lock.json must use the reviewed lockfileVersion 3 packages shape');
  }

  rejectProtectedAliases('package.json', packageJson, errors);
  rejectProtectedAliases('package-lock.json root', packageLock?.packages?.[''], errors);
  rejectProtectedOverrides(packageJson?.overrides, errors);

  for (const [packageName, expected] of Object.entries(REQUIRED_NATIVE_BOUNDARY_PINS)) {
    const actual = packageJson?.dependencies?.[packageName];
    if (actual !== expected) {
      errors.push(
        `package.json dependencies.${packageName} is ${String(actual)}, but the reviewed native boundary pin is exactly ${expected}`,
      );
    }
    for (const section of ALTERNATE_DEPENDENCY_SECTIONS) {
      if (Object.hasOwn(packageJson?.[section] ?? {}, packageName)) {
        const action = section === 'optionalDependencies' ? 'override' : 'redeclare';
        errors.push(
          `package.json ${section}.${packageName} must not ${action} a shipped native boundary`,
        );
      }
    }

    const lockRootActual = packageLock?.packages?.['']?.dependencies?.[packageName];
    if (lockRootActual !== expected) {
      errors.push(
        `package-lock.json root dependencies.${packageName} is ${String(lockRootActual)}, but the reviewed native boundary pin is exactly ${expected}`,
      );
    }

    const lockPackagePath = `node_modules/${packageName}`;
    const matchingLockPaths = Object.keys(packageLock?.packages ?? {}).filter(
      (packagePath) =>
        packagePath === lockPackagePath || packagePath.endsWith(`/node_modules/${packageName}`),
    );
    if (matchingLockPaths.length !== 1 || matchingLockPaths[0] !== lockPackagePath) {
      errors.push(
        `package-lock.json must contain only the top-level ${lockPackagePath} entry for the reviewed native boundary`,
      );
    } else {
      const lockVersion = packageLock.packages[lockPackagePath]?.version;
      if (lockVersion !== expected) {
        errors.push(
          `package-lock.json ${lockPackagePath} is ${String(lockVersion)}, but the reviewed native boundary version is exactly ${expected}`,
        );
      }
    }
  }

  for (const packageName of FORBIDDEN_NATIVE_BOUNDARY_PACKAGES) {
    for (const section of DEPENDENCY_SECTIONS) {
      if (Object.hasOwn(packageJson?.[section] ?? {}, packageName)) {
        errors.push(`package.json ${section}.${packageName} must remain absent`);
      }
    }

    const lockPackagePath = `node_modules/${packageName}`;
    const hasLockPackage = Object.keys(packageLock?.packages ?? {}).some(
      (packagePath) =>
        packagePath === lockPackagePath || packagePath.endsWith(`/node_modules/${packageName}`),
    );
    const lockRoot = packageLock?.packages?.[''];
    const hasLockDeclaration = ['dependencies', ...ALTERNATE_DEPENDENCY_SECTIONS].some((section) =>
      Object.hasOwn(lockRoot?.[section] ?? {}, packageName),
    );
    const hasLegacyLockPackage = Object.hasOwn(packageLock?.dependencies ?? {}, packageName);
    if (hasLockPackage || hasLockDeclaration || hasLegacyLockPackage) {
      errors.push(`package-lock.json must not contain ${packageName}`);
    }
  }

  for (const [packagePath, metadata] of Object.entries(packageLock?.packages ?? {})) {
    const semanticName = metadata?.name;
    if (
      typeof semanticName === 'string' &&
      PROTECTED_NATIVE_BOUNDARY_PACKAGES.has(semanticName) &&
      packagePath !== `node_modules/${semanticName}`
    ) {
      errors.push(
        `package-lock.json ${packagePath} must not alias protected package ${semanticName}`,
      );
    }
  }

  for (const [scriptName, expected] of Object.entries(REQUIRED_RELEASE_SCRIPTS)) {
    if (packageJson?.scripts?.[scriptName] !== expected) {
      errors.push(`${scriptName} must equal the reviewed phased-release command: ${expected}`);
    }
  }
  for (const [scriptName, script] of Object.entries(packageJson?.scripts ?? {})) {
    if (scriptName.startsWith('release:') && !REVIEWED_RELEASE_SCRIPT_NAMES.has(scriptName)) {
      errors.push(`${scriptName} is not a reviewed release command`);
    }
    if (typeof script === 'string' && EAS_BUILD_OR_SUBMIT_PATTERN.test(script)) {
      errors.push(
        `${scriptName} must not invoke EAS directly; use the reviewed release:android phase commands`,
      );
    }
  }

  if (eas?.cli?.version !== REQUIRED_EAS_CLI_VERSION) {
    errors.push(
      `EAS CLI constraint is ${String(eas?.cli?.version)}, but ${REQUIRED_EAS_CLI_VERSION} is required`,
    );
  }
  if (eas?.build?.base?.node !== REQUIRED_NODE_VERSION) {
    errors.push(
      `EAS base profile uses ${String(eas?.build?.base?.node)}, but Node ${REQUIRED_NODE_VERSION} is required`,
    );
  }
  if (eas?.build?.base?.environment !== 'production') {
    errors.push('EAS base profile must select the production environment');
  }
  if (eas?.build?.base?.env != null) {
    errors.push('EAS base profile must not declare inherited env values');
  }
  const buildProfiles = Object.keys(eas?.build ?? {}).sort();
  if (!isDeepStrictEqual(buildProfiles, [...REQUIRED_EAS_BUILD_PROFILES].sort())) {
    errors.push(`EAS build profiles must be exactly ${REQUIRED_EAS_BUILD_PROFILES.join(', ')}`);
  }

  for (const profile of ['development', 'preview', 'production']) {
    const config = eas?.build?.[profile];
    if (config?.extends !== 'base') errors.push(`EAS ${profile} profile must extend base`);
    if (config?.environment !== profile) {
      errors.push(`EAS ${profile} profile must select the ${profile} environment`);
    }
    const expectedEnvironment = {
      GATOR_ANDROID_ARCHITECTURES: REQUIRED_ANDROID_ARCHITECTURES[profile],
    };
    if (!isDeepStrictEqual(config?.env, expectedEnvironment)) {
      errors.push(
        `EAS ${profile} profile env must contain only GATOR_ANDROID_ARCHITECTURES=${REQUIRED_ANDROID_ARCHITECTURES[profile]}`,
      );
    }
  }

  if (!isDeepStrictEqual(eas?.submit, REQUIRED_EAS_SUBMIT_CONFIG)) {
    errors.push(
      'EAS submit configuration must be exactly the reviewed production.android Internal Testing path',
    );
  }

  return errors;
}

export function environmentProbeLanes(eas) {
  return [
    {
      lane: 'local',
      environment: 'local',
      architectures: REQUIRED_ANDROID_ARCHITECTURES.development,
      firebaseConfig: 'local-fallback',
      googleServicesFile: LOCAL_GOOGLE_SERVICES_FILE,
    },
    ...['development', 'preview', 'production'].map((profile) => ({
      lane: profile === 'development' ? 'ci' : profile,
      environment: eas?.build?.[profile]?.environment,
      architectures: eas?.build?.[profile]?.env?.GATOR_ANDROID_ARCHITECTURES,
      firebaseConfig: 'sentinel-file-path',
      googleServicesFile: ENVIRONMENT_PROBE_FILE,
    })),
  ];
}

export function validateResolvedEnvironmentConfig(config, lane) {
  const errors = [];
  if (config?.name !== REQUIRED_EXPO_IDENTITY.name) {
    errors.push(`${lane.lane} Expo name must remain ${REQUIRED_EXPO_IDENTITY.name}`);
  }
  if (config?.slug !== REQUIRED_EXPO_IDENTITY.slug) {
    errors.push(`${lane.lane} Expo slug must remain ${REQUIRED_EXPO_IDENTITY.slug}`);
  }
  if (config?.android?.package !== REQUIRED_EXPO_IDENTITY.androidPackage) {
    errors.push(
      `${lane.lane} Android package must remain ${REQUIRED_EXPO_IDENTITY.androidPackage}`,
    );
  }
  if (config?.android?.googleServicesFile !== lane.googleServicesFile) {
    errors.push(`${lane.lane} Firebase config did not resolve from ${lane.firebaseConfig}`);
  }

  const architecturePlugins = Array.isArray(config?.plugins)
    ? config.plugins.filter(
        (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withArm64Only',
      )
    : [];
  if (architecturePlugins.length !== 1) {
    errors.push(`${lane.lane} must resolve exactly one Android architecture plugin`);
  } else if (architecturePlugins[0]?.[1]?.architectures !== lane.architectures) {
    errors.push(`${lane.lane} Android architectures did not resolve to ${lane.architectures}`);
  }

  return errors;
}

export function validateEnvironmentSmokeWorkflowSource(source) {
  if (typeof source !== 'string') return ['CI workflow source is unavailable'];
  const checkStart = source.indexOf('\n  check:\n');
  const checkEnd = source.indexOf('\n  android:\n', checkStart + 1);
  if (checkStart < 0 || checkEnd < 0) {
    return ['CI workflow must retain the check job before the Android job'];
  }

  const checkJob = source.slice(checkStart, checkEnd);
  const checkoutPattern =
    /^      - uses: actions\/checkout@[a-f0-9]{40} # v\d+\.\d+\.\d+\n        with:\n(?:          #.*\n)*          fetch-depth: 0\n          persist-credentials: false$/gm;
  const nameLine = `      - name: ${ENVIRONMENT_SMOKE_STEP_NAME}`;
  const commandLine = `        run: ${ENVIRONMENT_SMOKE_COMMAND}`;
  const nameCount = checkJob.split(nameLine).length - 1;
  const commandCount = checkJob.split(commandLine).length - 1;
  const stepStart = checkJob.indexOf(nameLine);
  const nextStep = checkJob.indexOf('\n      - ', stepStart + nameLine.length);
  const step =
    stepStart < 0
      ? ''
      : checkJob.slice(stepStart, nextStep < 0 ? checkJob.length : nextStep).trimEnd();
  const expectedStep = `${nameLine}\n${commandLine}`;
  const installIndex = checkJob.indexOf('        run: npm ci');
  const expectedSequence = [
    '      - name: Install dependencies',
    '        run: npm ci',
    '',
    expectedStep,
  ].join('\n');
  const errors = [];

  if ([...checkJob.matchAll(checkoutPattern)].length !== 1) {
    errors.push(
      'CI check job checkout must disable persisted credentials before evaluating Expo config.',
    );
  }

  if (nameCount !== 1 || commandCount !== 1 || step !== expectedStep) {
    errors.push(
      `CI check job must run exactly one blocking "${ENVIRONMENT_SMOKE_STEP_NAME}" step: ${ENVIRONMENT_SMOKE_COMMAND}`,
    );
  }
  if (
    installIndex < 0 ||
    stepStart < installIndex ||
    checkJob.split(expectedSequence).length !== 2
  ) {
    errors.push('CI environment smoke must run immediately after npm ci installs Expo.');
  }
  return errors;
}

export function environmentProbeProcessEnv(lane, ambientEnvironment = process.env) {
  const environment = {
    EXPO_NO_CLIENT_ENV_VARS: '1',
    EXPO_NO_DOTENV: '1',
    EXPO_NO_TELEMETRY: '1',
  };
  for (const name of [
    'ComSpec',
    'HOME',
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]) {
    if (ambientEnvironment[name] != null) environment[name] = ambientEnvironment[name];
  }
  if (lane.lane !== 'local') {
    environment.CI = '1';
    environment.GATOR_ANDROID_ARCHITECTURES = lane.architectures;
    environment.GOOGLE_SERVICES_JSON = lane.googleServicesFile;
  }
  return environment;
}

function resolvePublicExpoConfig(root, lane) {
  const expoCli = resolve(root, 'node_modules/expo/bin/cli');
  if (!existsSync(expoCli)) {
    throw new Error(
      'Environment smoke requires installed dependencies; run npm ci before this command.',
    );
  }

  try {
    return JSON.parse(
      execFileSync(process.execPath, [expoCli, 'config', '--type', 'public', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: environmentProbeProcessEnv(lane),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      }),
    );
  } catch {
    throw new Error(`Expo config resolution failed for the ${lane.lane} environment.`);
  }
}

export function runEnvironmentSmoke({
  root = process.cwd(),
  resolveConfig = resolvePublicExpoConfig,
  toolchain,
} = {}) {
  const eas = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));
  const resolvedToolchain = toolchain ?? runToolchainCheck({ root });
  const results = [];

  for (const lane of environmentProbeLanes(eas)) {
    const config = resolveConfig(root, lane);
    const errors = validateResolvedEnvironmentConfig(config, lane);
    if (errors.length > 0) {
      throw new Error(`Environment model drift:\n- ${errors.join('\n- ')}`);
    }
    results.push({
      lane: lane.lane,
      environment: lane.environment,
      node: resolvedToolchain.node,
      npm: resolvedToolchain.npm,
      easCli: resolvedToolchain.easCli,
      androidArchitectures: lane.architectures,
      firebaseConfig: lane.firebaseConfig,
    });
  }

  return results;
}

export function formatEnvironmentProbe(result) {
  return `Environment smoke passed: lane=${result.lane}; environment=${result.environment}; Node ${result.node}; npm ${result.npm}; EAS CLI ${result.easCli}; Android architectures=${result.androidArchitectures}; Firebase config=${result.firebaseConfig}.`;
}

function readNpmVersion() {
  try {
    return execFileSync('npm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
}

export function runToolchainCheck({ root = process.cwd() } = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  const eas = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));
  const releaseRunnerSource = readFileSync(resolve(root, 'scripts/release-android.mjs'), 'utf8');
  const workflowSource = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const nvmNode = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
  const actualNode = process.versions.node;
  const childNpm = readNpmVersion();
  const invokingNpm = npmVersionFromUserAgent(process.env.npm_config_user_agent);
  const errors = [
    ...validateToolchain({
      actualNode,
      childNpm,
      eas,
      hasNpmShrinkwrap: existsSync(resolve(root, 'npm-shrinkwrap.json')),
      invokingNpm,
      nvmNode,
      packageLock,
      packageJson,
    }),
    ...validateReleaseRunnerSource(releaseRunnerSource),
    ...validateEnvironmentSmokeWorkflowSource(workflowSource),
  ];

  if (errors.length > 0) throw new Error(`Toolchain drift:\n- ${errors.join('\n- ')}`);
  return {
    node: actualNode,
    npm: childNpm,
    easCli: eas.cli.version,
    androidSubmitTrack: eas.submit.production.android.track,
  };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== ENVIRONMENT_SMOKE_FLAG) || args.length > 1) {
      throw new Error(`Usage: node scripts/check-toolchain.mjs [${ENVIRONMENT_SMOKE_FLAG}]`);
    }
    const result = runToolchainCheck();
    console.log(
      `Toolchain guard passed: Node ${result.node}; npm ${result.npm}; EAS CLI ${result.easCli} pinned in config and release commands; Android submission pinned to ${result.androidSubmitTrack}.`,
    );
    if (args[0] === ENVIRONMENT_SMOKE_FLAG) {
      for (const environmentResult of runEnvironmentSmoke({ toolchain: result })) {
        console.log(formatEnvironmentProbe(environmentResult));
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
