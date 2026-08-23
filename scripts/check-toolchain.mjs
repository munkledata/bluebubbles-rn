#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REQUIRED_NODE_VERSION = '24.19.0';
export const REQUIRED_NODE_ENGINE = '>=24.19.0 <25';
export const REQUIRED_NPM_VERSION = '11.17.0';
export const REQUIRED_EAS_CLI_VERSION = '21.5.0';
export const REQUIRED_EAS_SUBMIT_CONFIG = Object.freeze({
  production: Object.freeze({
    android: Object.freeze({
      track: 'internal',
      serviceAccountKeyPath: './play-service-account.json',
    }),
  }),
});
export const REQUIRED_RELEASE_SCRIPTS = {
  'release:android': 'npm run release:android:local',
  'release:android:local':
    'npm run check:toolchain && GOOGLE_SERVICES_JSON="${GOOGLE_SERVICES_JSON:-$PWD/google-services.json}" && test -f "$GOOGLE_SERVICES_JSON" && export GOOGLE_SERVICES_JSON && EAS_LOCAL_BUILD_PLUGIN_PATH="$(npx --yes --ignore-scripts --package eas-cli-local-build-plugin@21.5.0 -c \'command -v eas-cli-local-build-plugin\')" && test -x "$EAS_LOCAL_BUILD_PLUGIN_PATH" && export EAS_LOCAL_BUILD_PLUGIN_PATH && npx --yes --ignore-scripts --package eas-cli@21.5.0 -c \'unset npm_config_ignore_scripts npm_config_call npm_config_package npm_config_yes; exec eas build -p android --profile production --local --output ./gator-release.aab\'',
};
const REVIEWED_RELEASE_SCRIPT_NAMES = new Set([
  'release:prepare:patch',
  ...Object.keys(REQUIRED_RELEASE_SCRIPTS),
]);
const EAS_BUILD_OR_SUBMIT_PATTERN =
  /(?:(?:\beas\b|\beas-cli(?:@[^\s'\"]+)?\b)[^\n]*(?:\bbuild\b|\bsubmit\b)|--auto-submit\b)/;

export function npmVersionFromUserAgent(userAgent) {
  return userAgent?.match(/(?:^|\s)npm\/([^ ]+)/)?.[1];
}

export function validateToolchain({
  actualNode,
  childNpm,
  eas,
  invokingNpm,
  nvmNode,
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

  if (
    packageJson?.scripts?.['release:prepare:patch'] !== 'npm version patch --no-git-tag-version'
  ) {
    errors.push('release:prepare:patch must be the explicit package-version preparation command');
  }
  for (const [scriptName, expected] of Object.entries(REQUIRED_RELEASE_SCRIPTS)) {
    if (packageJson?.scripts?.[scriptName] !== expected) {
      errors.push(`${scriptName} must equal the reviewed local-build-only command: ${expected}`);
    }
  }
  for (const [scriptName, script] of Object.entries(packageJson?.scripts ?? {})) {
    if (scriptName.startsWith('release:') && !REVIEWED_RELEASE_SCRIPT_NAMES.has(scriptName)) {
      errors.push(`${scriptName} is not a reviewed release command`);
    }
    if (
      typeof script === 'string' &&
      EAS_BUILD_OR_SUBMIT_PATTERN.test(script) &&
      !(
        scriptName === 'release:android:local' &&
        script === REQUIRED_RELEASE_SCRIPTS['release:android:local']
      )
    ) {
      errors.push(
        `${scriptName} must not invoke an unreviewed EAS build or submit command; use release:android`,
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

  for (const profile of ['development', 'preview', 'production']) {
    const config = eas?.build?.[profile];
    if (config?.extends !== 'base') errors.push(`EAS ${profile} profile must extend base`);
    if (config?.environment !== profile) {
      errors.push(`EAS ${profile} profile must select the ${profile} environment`);
    }
    if (config?.env?.NODE_ENV != null) {
      errors.push(`EAS ${profile} profile must not overload NODE_ENV`);
    }
  }

  if (!isDeepStrictEqual(eas?.submit, REQUIRED_EAS_SUBMIT_CONFIG)) {
    errors.push(
      'EAS submit configuration must be exactly the reviewed production.android Internal Testing path',
    );
  }

  return errors;
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
  const eas = JSON.parse(readFileSync(resolve(root, 'eas.json'), 'utf8'));
  const nvmNode = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
  const actualNode = process.versions.node;
  const childNpm = readNpmVersion();
  const invokingNpm = npmVersionFromUserAgent(process.env.npm_config_user_agent);
  const errors = validateToolchain({
    actualNode,
    childNpm,
    eas,
    invokingNpm,
    nvmNode,
    packageJson,
  });

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
    const result = runToolchainCheck();
    console.log(
      `Toolchain guard passed: Node ${result.node}; npm ${result.npm}; EAS CLI ${result.easCli} pinned in config and release commands; Android submission pinned to ${result.androidSubmitTrack}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
