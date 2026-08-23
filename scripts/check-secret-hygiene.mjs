#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_FILE_EXTENSION = /\.(?:jks|keystore|p8|p12|pem|key)$/i;
const SERVICE_ACCOUNT_FILE = /(?:service[-_]?account|credentials?)[^/]*\.json$/i;

export function forbiddenSecretPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const name = basename(normalized);
  if (name === '.env.example') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name === 'google-services.json' || name === 'play-service-account.json') return true;
  return PRIVATE_FILE_EXTENSION.test(name) || SERVICE_ACCOUNT_FILE.test(name);
}

export function findHighConfidenceSecrets(source) {
  const findings = [];
  const privateKeyHeader = new RegExp(
    ['-{5}', 'BEGIN', '(?: RSA| EC| OPENSSH)?', ' PRIVATE KEY', '-{5}'].join(''),
  );
  if (privateKeyHeader.test(source)) findings.push('private-key material');

  const serviceAccountType = new RegExp(
    ['["\']type["\']', '\\s*:\\s*', '["\']service_', 'account["\']'].join(''),
  );
  const privateKeyField = new RegExp(['["\']private_', 'key["\']', '\\s*:'].join(''));
  if (serviceAccountType.test(source) && privateKeyField.test(source)) {
    findings.push('Google service-account credential');
  }

  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(source)) findings.push('AWS access-key id');
  if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(source)) findings.push('GitHub access token');
  if (/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(source)) findings.push('Slack access token');
  return findings;
}

export function validateIgnorePolicy({ gitignore, easignore }) {
  const errors = [];
  for (const required of ['.env', '.env.*', '!.env.example']) {
    if (!gitignore.split(/\r?\n/).includes(required)) {
      errors.push(`.gitignore must contain ${required}`);
    }
    if (!easignore.split(/\r?\n/).includes(required)) {
      errors.push(`.easignore must contain ${required}`);
    }
  }
  for (const required of ['google-services.json', 'play-service-account.json']) {
    if (!gitignore.split(/\r?\n/).includes(required)) {
      errors.push(`.gitignore must contain ${required}`);
    }
  }
  if (!easignore.split(/\r?\n/).includes('play-service-account.json')) {
    errors.push('.easignore must contain play-service-account.json');
  }
  for (const required of ['*.jks', '*.keystore', '*.p8', '*.p12', '*.pem', '*.key']) {
    if (!gitignore.split(/\r?\n/).includes(required)) {
      errors.push(`.gitignore must contain ${required}`);
    }
    if (!easignore.split(/\r?\n/).includes(required)) {
      errors.push(`.easignore must contain ${required}`);
    }
  }
  return errors;
}

function gitPaths(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean);
}

export function runSecretHygieneCheck({ root = process.cwd() } = {}) {
  const errors = validateIgnorePolicy({
    gitignore: readFileSync(resolve(root, '.gitignore'), 'utf8'),
    easignore: readFileSync(resolve(root, '.easignore'), 'utf8'),
  });
  const tracked = gitPaths(root, ['ls-files', '-z']);

  for (const path of tracked) {
    if (forbiddenSecretPath(path)) {
      errors.push(`tracked secret/config filename is forbidden: ${path}`);
      continue;
    }
    const absolute = resolve(root, path);
    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (source.includes('\0')) continue;
    for (const finding of findHighConfidenceSecrets(source)) {
      errors.push(`${finding} found in ${relative(root, absolute)}`);
    }
  }

  const historical = gitPaths(root, [
    'log',
    '--all',
    '--name-only',
    '--pretty=format:',
    '-z',
  ]);
  for (const path of new Set(historical)) {
    if (forbiddenSecretPath(path)) {
      errors.push(`secret/config filename exists in Git history: ${path}`);
    }
  }

  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { trackedFiles: tracked.length, historicalPaths: new Set(historical).size };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runSecretHygieneCheck();
    console.log(
      `Secret hygiene guard passed: ${result.trackedFiles} tracked files; ${result.historicalPaths} historical paths checked.`,
    );
  } catch (error) {
    console.error(
      `Secret hygiene guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
