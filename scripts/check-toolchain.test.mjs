import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORBIDDEN_NATIVE_BOUNDARY_PACKAGES,
  REQUIRED_EAS_CLI_VERSION,
  REQUIRED_EAS_SUBMIT_CONFIG,
  REQUIRED_NATIVE_BOUNDARY_PINS,
  REQUIRED_NODE_ENGINE,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  REQUIRED_RELEASE_SCRIPTS,
  npmVersionFromUserAgent,
  validateToolchain,
} from './check-toolchain.mjs';

const EXPECTED_NATIVE_BOUNDARY_PINS = Object.freeze({
  '@op-engineering/op-sqlite': '17.1.2',
  '@react-native-firebase/app': '25.1.0',
  '@react-native-firebase/messaging': '25.1.0',
  '@shopify/flash-list': '2.0.2',
  'drizzle-orm': '0.45.2',
  'react-native-notify-kit': '10.4.8',
  'react-native-webview': '13.16.1',
});
const EXPECTED_FORBIDDEN_NATIVE_BOUNDARY_PACKAGES = Object.freeze(['expo-share-intent']);

function validInput() {
  return {
    actualNode: REQUIRED_NODE_VERSION,
    childNpm: REQUIRED_NPM_VERSION,
    hasNpmShrinkwrap: false,
    invokingNpm: REQUIRED_NPM_VERSION,
    nvmNode: REQUIRED_NODE_VERSION,
    packageJson: {
      packageManager: `npm@${REQUIRED_NPM_VERSION}`,
      engines: { node: REQUIRED_NODE_ENGINE },
      dependencies: { ...EXPECTED_NATIVE_BOUNDARY_PINS },
      scripts: { ...REQUIRED_RELEASE_SCRIPTS },
    },
    packageLock: {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { ...EXPECTED_NATIVE_BOUNDARY_PINS } },
        ...Object.fromEntries(
          Object.entries(EXPECTED_NATIVE_BOUNDARY_PINS).map(([packageName, version]) => [
            `node_modules/${packageName}`,
            { version },
          ]),
        ),
      },
    },
    eas: {
      cli: { version: REQUIRED_EAS_CLI_VERSION },
      build: Object.fromEntries([
        ['base', { node: REQUIRED_NODE_VERSION }],
        ...['development', 'preview', 'production'].map((profile) => [
          profile,
          { extends: 'base', environment: profile },
        ]),
      ]),
      submit: structuredClone(REQUIRED_EAS_SUBMIT_CONFIG),
    },
  };
}

function expectToolchainError(input, marker, label) {
  const errors = validateToolchain(input);
  assert.ok(
    errors.some((error) => error.includes(marker)),
    `${label}: ${errors.join('; ')}`,
  );
}

test('accepts the reviewed toolchain, environments, and Internal Testing submission', () => {
  assert.deepEqual(validateToolchain(validInput()), []);
});

test('accepts direct node invocation when npm on PATH is still pinned', () => {
  assert.deepEqual(validateToolchain({ ...validInput(), invokingNpm: undefined }), []);
});

test('owns the exact reviewed native boundary and forbidden-package sets', () => {
  assert.deepEqual(REQUIRED_NATIVE_BOUNDARY_PINS, EXPECTED_NATIVE_BOUNDARY_PINS);
  assert.deepEqual(FORBIDDEN_NATIVE_BOUNDARY_PACKAGES, EXPECTED_FORBIDDEN_NATIVE_BOUNDARY_PACKAGES);
});

test('rejects drift in every reviewed native boundary pin', () => {
  for (const [packageName, expected] of Object.entries(EXPECTED_NATIVE_BOUNDARY_PINS)) {
    for (const [label, replacement] of [
      ['missing', undefined],
      ['caret range', `^${expected}`],
      ['tilde range', `~${expected}`],
      ['tag', 'latest'],
      ['alias', `npm:${packageName}@${expected}`],
      ['wrong exact version', '0.0.0'],
    ]) {
      const input = validInput();
      if (replacement == null) delete input.packageJson.dependencies[packageName];
      else input.packageJson.dependencies[packageName] = replacement;
      expectToolchainError(input, `dependencies.${packageName}`, `${packageName}: ${label}`);
    }

    for (const owner of ['manifest', 'lock root', 'lock package name']) {
      const input = validInput();
      const aliasName = 'reviewed-boundary-alias';
      if (owner === 'manifest') {
        input.packageJson.dependencies[aliasName] = `npm:${packageName}@0.0.0`;
      } else if (owner === 'lock root') {
        input.packageLock.packages[''].dependencies = {
          [aliasName]: `npm:${packageName}@0.0.0`,
        };
      } else {
        input.packageLock.packages[`node_modules/${aliasName}`] = {
          name: packageName,
          version: '0.0.0',
        };
      }
      expectToolchainError(input, 'alias protected package', `${packageName}: ${owner} alias`);
    }

    for (const [label, overrides] of [
      ['direct override', { [packageName]: expected }],
      ['root override alias', { replacement: `npm:${packageName}@0.0.0` }],
      ['nested override alias', { parent: { child: `npm:${packageName}@0.0.0` } }],
    ]) {
      const input = validInput();
      input.packageJson.overrides = overrides;
      expectToolchainError(input, `protected package ${packageName}`, `${packageName}: ${label}`);
    }

    for (const [label, mutate] of [
      [
        'wrong lock-root pin',
        (input) => (input.packageLock.packages[''].dependencies[packageName] = '0.0.0'),
      ],
      [
        'wrong top-level lock version',
        (input) => (input.packageLock.packages[`node_modules/${packageName}`].version = '0.0.0'),
      ],
      [
        'nested second lock copy',
        (input) =>
          (input.packageLock.packages[`node_modules/example/node_modules/${packageName}`] = {
            version: '0.0.0',
          }),
      ],
    ]) {
      const input = validInput();
      mutate(input);
      expectToolchainError(input, 'package-lock.json', `${packageName}: ${label}`);
    }

    for (const section of ['devDependencies', 'peerDependencies']) {
      const input = validInput();
      input.packageJson[section] = { [packageName]: expected };
      expectToolchainError(
        input,
        `${section}.${packageName}`,
        `${packageName}: duplicated in ${section}`,
      );
    }

    for (const [label, replacement] of [
      ['exact duplicate', expected],
      ['ranged override', `^${expected}`],
    ]) {
      const input = validInput();
      input.packageJson.optionalDependencies = { [packageName]: replacement };
      expectToolchainError(
        input,
        `optionalDependencies.${packageName}`,
        `${packageName}: ${label} in optionalDependencies`,
      );
    }

    const movedToOptional = validInput();
    delete movedToOptional.packageJson.dependencies[packageName];
    movedToOptional.packageJson.optionalDependencies = { [packageName]: expected };
    expectToolchainError(
      movedToOptional,
      `dependencies.${packageName}`,
      `${packageName}: missing from production dependencies after optional move`,
    );
    expectToolchainError(
      movedToOptional,
      `optionalDependencies.${packageName}`,
      `${packageName}: moved to optionalDependencies`,
    );
  }
});

test('keeps the retired share-intent package out of every install declaration', () => {
  const packageName = EXPECTED_FORBIDDEN_NATIVE_BOUNDARY_PACKAGES[0];
  assert.ok(packageName);

  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const input = validInput();
    input.packageJson[section] = { ...input.packageJson[section], [packageName]: '1.0.0' };
    expectToolchainError(input, `${section}.${packageName}`, section);
  }

  for (const packagePath of [
    `node_modules/${packageName}`,
    `node_modules/example/node_modules/${packageName}`,
  ]) {
    const input = validInput();
    input.packageLock.packages[packagePath] = { version: '1.0.0' };
    expectToolchainError(input, `package-lock.json must not contain ${packageName}`, packagePath);
  }

  const rootLockDeclaration = validInput();
  rootLockDeclaration.packageLock.packages[''].dependencies[packageName] = '1.0.0';
  expectToolchainError(
    rootLockDeclaration,
    `package-lock.json must not contain ${packageName}`,
    'root lock declaration',
  );

  for (const [label, mutate] of [
    ['legacy version', (input) => (input.packageLock.lockfileVersion = 1)],
    ['missing packages', (input) => delete input.packageLock.packages],
    ['array packages', (input) => (input.packageLock.packages = [])],
    ['missing root package', (input) => delete input.packageLock.packages['']],
  ]) {
    const input = validInput();
    mutate(input);
    expectToolchainError(input, 'lockfileVersion 3 packages shape', label);
  }

  for (const overrides of [
    { [packageName]: '8.0.1' },
    { replacement: `npm:${packageName}@8.0.1` },
    { parent: { child: `npm:${packageName}@8.0.1` } },
  ]) {
    const input = validInput();
    input.packageJson.overrides = overrides;
    expectToolchainError(input, `protected package ${packageName}`, 'share-intent override');
  }

  const shrinkwrap = validInput();
  shrinkwrap.hasNpmShrinkwrap = true;
  expectToolchainError(shrinkwrap, 'npm-shrinkwrap.json', 'preferred unchecked shrinkwrap');
});

test('rejects drift in every executable and declarative toolchain boundary', () => {
  const input = validInput();
  const errors = validateToolchain({
    ...input,
    actualNode: '24.18.0',
    childNpm: '11.16.0',
    invokingNpm: '11.15.0',
    nvmNode: '24',
    packageJson: {
      packageManager: 'npm@11',
      engines: { node: '>=24' },
      dependencies: { ...EXPECTED_NATIVE_BOUNDARY_PINS },
      scripts: {
        'release:prepare:patch': 'npm version minor --no-git-tag-version',
        'release:android': 'npm version patch --no-git-tag-version && eas build --auto-submit',
        'release:android:local':
          'npm version patch --no-git-tag-version && eas build --local && eas submit',
      },
    },
    eas: {
      cli: { version: '>= 12.0.0' },
      build: {
        ...input.eas.build,
        base: { node: '24.5.0' },
        preview: {
          extends: 'development',
          environment: 'production',
          env: { NODE_ENV: 'production' },
        },
      },
      submit: {
        production: {
          android: {
            ...REQUIRED_EAS_SUBMIT_CONFIG.production.android,
            track: 'production',
          },
        },
      },
    },
  });

  for (const expected of [
    '.nvmrc',
    'runtime',
    'engines.node',
    'packageManager',
    'npm on PATH',
    'invoking npm',
    'release:prepare:patch',
    'release:android must equal the reviewed phased-release command',
    'release:android:local is not a reviewed release command',
    'EAS CLI',
    'EAS base',
    'preview profile must extend base',
    'preview profile must select the preview environment',
    'must not overload NODE_ENV',
    'EAS submit configuration',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected,
    );
  }
});

test('rejects any drift from the sole private Android Internal Testing submit profile', () => {
  const variants = [
    [
      'missing submit configuration',
      (input) => {
        delete input.eas.submit;
      },
    ],
    ['null submit configuration', (input) => (input.eas.submit = null)],
    ['empty submit configuration', (input) => (input.eas.submit = {})],
    ['array submit configuration', (input) => (input.eas.submit = [])],
    ['string submit configuration', (input) => (input.eas.submit = 'internal')],
    [
      'renamed profile',
      (input) => {
        input.eas.submit = { internal: structuredClone(input.eas.submit.production) };
      },
    ],
    [
      'second submit profile',
      (input) => {
        input.eas.submit.preview = structuredClone(input.eas.submit.production);
      },
    ],
    [
      'iOS submit path',
      (input) => {
        input.eas.submit.production.ios = {};
      },
    ],
    [
      'profile inheritance',
      (input) => {
        input.eas.submit.production.extends = 'base';
      },
    ],
    [
      'missing Android path',
      (input) => {
        delete input.eas.submit.production.android;
      },
    ],
    [
      'missing explicit track',
      (input) => {
        delete input.eas.submit.production.android.track;
      },
    ],
    [
      'missing service-account path',
      (input) => {
        delete input.eas.submit.production.android.serviceAccountKeyPath;
      },
    ],
    [
      'different service-account path',
      (input) => {
        input.eas.submit.production.android.serviceAccountKeyPath = './other.json';
      },
    ],
    [
      'application override',
      (input) => {
        input.eas.submit.production.android.applicationId = 'com.example.other';
      },
    ],
    [
      'release status',
      (input) => {
        input.eas.submit.production.android.releaseStatus = 'draft';
      },
    ],
    [
      'rollout',
      (input) => {
        input.eas.submit.production.android.rollout = 0.1;
      },
    ],
    [
      'review behavior',
      (input) => {
        input.eas.submit.production.android.changesNotSentForReview = true;
      },
    ],
    [
      'unknown Android option',
      (input) => {
        input.eas.submit.production.android.unreviewed = true;
      },
    ],
    ...['production', 'alpha', 'beta', 'qa', 'INTERNAL', '$EAS_BUILD_PROFILE'].map((track) => [
      `track ${track}`,
      (input) => {
        input.eas.submit.production.android.track = track;
      },
    ]),
  ];

  for (const [name, mutate] of variants) {
    const input = validInput();
    mutate(input);
    assert.ok(
      validateToolchain(input).some((error) => error.includes('EAS submit configuration')),
      name,
    );
  }

  const reordered = validInput();
  reordered.eas.submit = {
    production: {
      android: {
        serviceAccountKeyPath: './play-service-account.json',
        track: 'internal',
      },
    },
  };
  assert.deepEqual(validateToolchain(reordered), []);
});

test('reads npm versions from npm user-agent strings', () => {
  assert.equal(
    npmVersionFromUserAgent('npm/11.17.0 node/v24.19.0 darwin arm64 workspaces/false'),
    '11.17.0',
  );
  assert.equal(npmVersionFromUserAgent(undefined), undefined);
});

test('rejects hosted, missing, indirect, wrong-target, submitting, and unpinned release commands', () => {
  const variants = [
    undefined,
    '',
    'echo no-build',
    'npx --yes eas-cli@21.5.0 build -p ios --profile production',
    'npx --yes eas-cli@21.5.0 build -p android --profile development',
    'npm run some-submit-wrapper',
    'npx --yes eas-cli@20.3.0 build -p android --profile production',
    'npx --yes eas-cli@21.5.0 build -p android --profile production',
    'npx --yes --ignore-scripts eas-cli@21.5.0 build -p android --profile production',
    'npx --yes eas-cli@21.5.0 build -p android --profile production --auto-submit',
  ];

  for (const script of variants) {
    const input = validInput();
    input.packageJson.scripts['release:android'] = script;
    const errors = validateToolchain(input);
    assert.ok(
      errors.some((error) =>
        error.includes('release:android must equal the reviewed phased-release command'),
      ),
      String(script),
    );
  }
});

test('rejects hosted or submitting drift in the phased release commands', () => {
  const variants = [
    "npx --yes --ignore-scripts --package eas-cli@21.5.0 -c 'unset npm_config_ignore_scripts; exec eas build -p android --profile production'",
    "npx --yes --ignore-scripts --package eas-cli@21.5.0 -c 'unset npm_config_ignore_scripts; exec eas build -p android --profile production --local --auto-submit'",
    'npm run some-submit-wrapper',
  ];

  for (const script of variants) {
    const input = validInput();
    input.packageJson.scripts['release:android:build'] = script;
    const errors = validateToolchain(input);
    assert.ok(
      errors.some((error) =>
        error.includes('release:android:build must equal the reviewed phased-release command'),
      ),
      script,
    );
  }
});

test('rejects additional release names and EAS build or submit entry points', () => {
  const variants = [
    ['release:android:cloud', 'npm run hidden-cloud-builder'],
    ['build:android:cloud', 'npx --yes eas-cli@21.5.0 build -p android'],
    [
      'build:android:auto-submit',
      'npx --yes eas-cli@21.5.0 build -p android --local --auto-submit-with-profile=production',
    ],
    ['submit:android', 'eas submit -p android --profile production'],
    [
      'deploy:android',
      "npx --yes --package eas-cli@21.5.0 -c 'eas submit -p android --profile production'",
    ],
  ];

  for (const [scriptName, script] of variants) {
    const input = validInput();
    input.packageJson.scripts[scriptName] = script;
    const errors = validateToolchain(input);
    assert.ok(
      errors.some((error) => error.includes(scriptName)),
      scriptName,
    );
  }
});
