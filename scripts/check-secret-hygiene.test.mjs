import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findHighConfidenceSecrets,
  forbiddenSecretPath,
  validateIgnorePolicy,
} from './check-secret-hygiene.mjs';

test('rejects common local secret/config filenames but permits the safe example', () => {
  for (const path of [
    '.env',
    '.env.production',
    'android/upload.keystore',
    'keys/release.jks',
    'google-services.json',
    'ops/play-service-account.json',
    'ops/service_account_prod.json',
  ]) {
    assert.equal(forbiddenSecretPath(path), true, path);
  }
  assert.equal(forbiddenSecretPath('.env.example'), false);
  assert.equal(forbiddenSecretPath('test/fixtures/google-services.ci.json'), false);
});

test('detects high-confidence private keys and provider tokens', () => {
  const privateKey = [
    ['-----BEGIN', ' PRIVATE KEY-----'].join(''),
    'fake',
    ['-----END', ' PRIVATE KEY-----'].join(''),
  ].join('\n');
  const serviceAccount = JSON.stringify({
    type: ['service', 'account'].join('_'),
    ['private_' + 'key']: privateKey,
  });
  const githubToken = ['gh', 'p_', 'a'.repeat(36)].join('');
  const slackToken = ['xox', 'b-', 'a'.repeat(24)].join('');

  assert.deepEqual(findHighConfidenceSecrets(privateKey), ['private-key material']);
  assert.deepEqual(findHighConfidenceSecrets(serviceAccount), [
    'private-key material',
    'Google service-account credential',
  ]);
  assert.deepEqual(findHighConfidenceSecrets(githubToken), ['GitHub access token']);
  assert.deepEqual(findHighConfidenceSecrets(slackToken), ['Slack access token']);
});

test('does not flag ordinary application source or public identifiers', () => {
  assert.deepEqual(
    findHighConfidenceSecrets(`const packageName = 'com.bluegreengatorapps.messages';`),
    [],
  );
});

test('requires env and signing-secret ignore rules on both Git and EAS surfaces', () => {
  const valid = [
    '.env',
    '.env.*',
    '!.env.example',
    'google-services.json',
    'play-service-account.json',
    '*.jks',
    '*.keystore',
    '*.p8',
    '*.p12',
    '*.pem',
    '*.key',
  ].join('\n');
  assert.deepEqual(validateIgnorePolicy({ gitignore: valid, easignore: valid }), []);

  const errors = validateIgnorePolicy({ gitignore: '', easignore: '' });
  assert.ok(errors.some((error) => error.includes('.gitignore must contain .env')));
  assert.ok(errors.some((error) => error.includes('.easignore must contain .env')));
  assert.ok(errors.some((error) => error.includes('google-services.json')));
  assert.ok(errors.some((error) => error.includes('*.keystore')));
});
