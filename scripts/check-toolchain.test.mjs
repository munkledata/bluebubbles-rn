import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_EAS_CLI_VERSION,
  REQUIRED_EAS_SUBMIT_CONFIG,
  REQUIRED_NODE_ENGINE,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  REQUIRED_RELEASE_SCRIPTS,
  npmVersionFromUserAgent,
  validateToolchain,
} from './check-toolchain.mjs';

function validInput() {
  return {
    actualNode: REQUIRED_NODE_VERSION,
    childNpm: REQUIRED_NPM_VERSION,
    invokingNpm: REQUIRED_NPM_VERSION,
    nvmNode: REQUIRED_NODE_VERSION,
    packageJson: {
      packageManager: `npm@${REQUIRED_NPM_VERSION}`,
      engines: { node: REQUIRED_NODE_ENGINE },
      scripts: {
        'release:prepare:patch': 'npm version patch --no-git-tag-version',
        ...REQUIRED_RELEASE_SCRIPTS,
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

test('accepts the reviewed toolchain, environments, and Internal Testing submission', () => {
  assert.deepEqual(validateToolchain(validInput()), []);
});

test('accepts direct node invocation when npm on PATH is still pinned', () => {
  assert.deepEqual(validateToolchain({ ...validInput(), invokingNpm: undefined }), []);
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
    'release:android must equal the reviewed local-build-only command',
    'release:android:local must equal the reviewed local-build-only command',
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
        error.includes('release:android must equal the reviewed local-build-only command'),
      ),
      String(script),
    );
  }
});

test('rejects hosted or submitting drift in the local release implementation', () => {
  const variants = [
    "npx --yes --ignore-scripts --package eas-cli@21.5.0 -c 'unset npm_config_ignore_scripts; exec eas build -p android --profile production'",
    "npx --yes --ignore-scripts --package eas-cli@21.5.0 -c 'unset npm_config_ignore_scripts; exec eas build -p android --profile production --local --auto-submit'",
    'npm run some-submit-wrapper',
  ];

  for (const script of variants) {
    const input = validInput();
    input.packageJson.scripts['release:android:local'] = script;
    const errors = validateToolchain(input);
    assert.ok(
      errors.some((error) =>
        error.includes('release:android:local must equal the reviewed local-build-only command'),
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
