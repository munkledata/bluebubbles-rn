#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { DL01_FIXTURE_TOKEN_ENV, startDl01FixtureServer } from './dl01-hostile-fixture.mjs';

const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,62}$/;

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

/** Parse only an exact device-loopback origin; paths, credentials, and implicit ports are refused. */
export function parseDeviceBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be an exact http://127.0.0.1:PORT origin.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('--base-url must be an exact http://127.0.0.1:PORT origin.');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--base-url contains an invalid port.');
  }
  return { origin: `http://127.0.0.1:${port}`, port };
}

export function parseDl01DeviceFixtureArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !['--serial', '--package', '--base-url', '--firebase-project-id'].includes(key) ||
      value === undefined ||
      values.has(key)
    ) {
      throw new Error(`Unknown, repeated, or incomplete argument: ${String(key)}`);
    }
    values.set(key, value);
  }
  const serial = requiredString(values.get('--serial'), '--serial', SERIAL);
  const packageName = requiredString(values.get('--package'), '--package', PACKAGE);
  const base = parseDeviceBaseUrl(values.get('--base-url'));
  const firebaseProjectId = values.get('--firebase-project-id') ?? null;
  if (firebaseProjectId !== null && !PROJECT_ID.test(firebaseProjectId)) {
    throw new Error('--firebase-project-id is invalid.');
  }
  return { serial, packageName, base, firebaseProjectId };
}

function adb(serial, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'adb',
      ['-s', serial, ...args],
      { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          // Do not propagate child-process objects: they can retain command output unrelated to
          // this fixture. A stable operation label is enough for the operator to act on.
          reject(new Error(`adb ${args[0] ?? 'operation'} failed.`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function reverseMappings(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      remote: parts.at(-2),
      local: parts.at(-1),
    }));
}

async function verifyExactDevice(serial, packageName) {
  const state = (await adb(serial, ['get-state'])).trim();
  if (state !== 'device') throw new Error('The exact Android serial is not ready.');
  const installed = (await adb(serial, ['shell', 'pm', 'path', packageName])).trim();
  const installedPaths = installed.split(/\r?\n/u).filter((line) => line.length > 0);
  // Play-delivered apps commonly have base + split APK paths. Every returned row must still come
  // from pm's exact-package query; accepting all-valid rows avoids falsely rejecting that layout.
  if (installedPaths.length === 0 || installedPaths.some((line) => !line.startsWith('package:'))) {
    throw new Error('The exact Android package is not installed on that device.');
  }
}

async function main() {
  const args = parseDl01DeviceFixtureArgs(process.argv.slice(2));
  const token = process.env[DL01_FIXTURE_TOKEN_ENV];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${DL01_FIXTURE_TOKEN_ENV} is required and is never printed.`);
  }

  await verifyExactDevice(args.serial, args.packageName);
  const remote = `tcp:${args.base.port}`;
  const local = `tcp:${args.base.port}`;
  const mappings = reverseMappings(await adb(args.serial, ['reverse', '--list']));
  if (mappings.some((mapping) => mapping.remote === remote)) {
    throw new Error(
      `The exact device port ${args.base.port} already has an adb reverse mapping; refusing to replace it.`,
    );
  }

  const fixture = await startDl01FixtureServer({
    authToken: token,
    host: '127.0.0.1',
    port: args.base.port,
    firebaseProjectId: args.firebaseProjectId,
  });
  let reverseAdded = false;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    if (reverseAdded) {
      try {
        const current = reverseMappings(await adb(args.serial, ['reverse', '--list']));
        if (current.some((mapping) => mapping.remote === remote && mapping.local === local)) {
          await adb(args.serial, ['reverse', '--remove', remote]);
        } else if (current.some((mapping) => mapping.remote === remote)) {
          process.stderr.write(
            'Warning: the DL-01 adb reverse mapping changed ownership and was not removed.\n',
          );
        }
      } catch {
        process.stderr.write(
          'Warning: the exact DL-01 adb reverse mapping could not be removed.\n',
        );
      }
    }
    await fixture.close();
  };

  try {
    // Keep the pre-check for a clear operator error, and also make the mutation atomic against a
    // competing session that could add this mapping between that check and this command.
    await adb(args.serial, ['reverse', '--no-rebind', remote, local]);
    reverseAdded = true;
    process.stdout.write(`DL-01 device fixture is ready at ${args.base.origin}\n`);
    process.stdout.write('The exact device and installed package were verified.\n');
    process.stdout.write(
      'No app install, uninstall, launch, stop, or process kill was performed.\n',
    );
    process.stdout.write('The bearer credential and any FCM registration remain memory-only.\n');
    process.stdout.write(`Host status endpoint: ${fixture.origin}/_dl01/v1/status\n`);

    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'DL-01 device fixture failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
