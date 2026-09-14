import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  classifyZipArchiveSensitiveMetadata,
  containsAbsoluteUserDirectory,
  extractZipEntry,
  parseAppDependencies,
  parseZipArchive,
  REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS,
  scanZipArchiveForSensitiveMetadata,
  validateGoogleMapsKeyDigestBinding,
  validateReleaseBuildReceiptProvenance,
} from './legal-aab-inventory.mjs';

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries, options = {}) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const [name, source] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(source);
    const compressed =
      options.method === 8
        ? Buffer.concat([deflateRawSync(contents), options.trailing ?? Buffer.alloc(0)])
        : contents;
    const crc = crc32(contents);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(options.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localRecords.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(options.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length + compressed.length;
  }
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function field(number, value, wire = 2) {
  if (wire === 0) return Buffer.concat([varint(number * 8), varint(value)]);
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(body.length), body]);
}

function maven(group, artifact, version) {
  return field(1, Buffer.concat([field(1, group), field(2, artifact), field(5, version)]));
}

test('ZIP boundary hashes valid entries and rejects ambiguous or unsafe records', () => {
  const valid = zip([['base/assets/font.ttf', 'font bytes']]);
  const parsed = parseZipArchive(valid);
  assert.equal(parsed.entries.length, 1);
  assert.equal(extractZipEntry(valid, parsed.entries[0]).toString(), 'font bytes');
  assert.throws(
    () =>
      parseZipArchive(
        zip([
          ['same', 'a'],
          ['same', 'b'],
        ]),
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      parseZipArchive(
        zip([
          ['Same', 'a'],
          ['same', 'b'],
        ]),
      ),
    /collision/,
  );
  assert.throws(() => parseZipArchive(zip([['../escape', 'a']])), /unsafe archive entry/);
  assert.throws(() => parseZipArchive(zip([['hidden/', 'payload']])), /directory entry/);

  const corrupt = Buffer.from(valid);
  corrupt[30 + Buffer.byteLength('base/assets/font.ttf')] ^= 0xff;
  const corruptEntry = parseZipArchive(corrupt).entries[0];
  assert.throws(() => extractZipEntry(corrupt, corruptEntry), /CRC-32/);

  const trailing = zip([['base/assets/font.ttf', 'font bytes']], {
    method: 8,
    trailing: Buffer.from('hidden'),
  });
  const trailingEntry = parseZipArchive(trailing).entries[0];
  assert.throws(() => extractZipEntry(trailing, trailingEntry), /trailing compressed bytes/);

  const centralOffset = valid.readUInt32LE(valid.length - 22 + 16);
  const localMismatch = Buffer.from(valid);
  localMismatch.writeUInt32LE(0, 14);
  assert.throws(() => parseZipArchive(localMismatch), /local and central CRC or sizes differ/);

  const descriptor = Buffer.from(valid);
  descriptor.writeUInt16LE(0x0808, 6);
  descriptor.writeUInt16LE(0x0808, centralOffset + 8);
  assert.throws(() => parseZipArchive(descriptor), /unsupported ZIP flags/);

  const symlink = Buffer.from(valid);
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset + 38);
  assert.throws(() => parseZipArchive(symlink), /not a regular file/);

  const preamble = Buffer.concat([Buffer.from([0]), valid]);
  const movedEnd = preamble.length - 22;
  const movedCentral = centralOffset + 1;
  preamble.writeUInt32LE(movedCentral, movedEnd + 16);
  preamble.writeUInt32LE(1, movedCentral + 42);
  assert.throws(() => parseZipArchive(preamble), /unaccounted preamble/);
});

test('sensitive metadata scan finds configured raw user-directory markers without returning contents', () => {
  const privateUsername = 'private-person';
  const privateRemainder = 'private-checkout';
  const archive = zip([
    ['base/assets/app.config', `{"path":"/Users/${privateUsername}/${privateRemainder}"}`],
    ['base/assets/url.txt', 'https://example.invalid/docs/public/path'],
  ]);

  assert.equal(containsAbsoluteUserDirectory('/home/runner/work/project'), true);
  assert.equal(containsAbsoluteUserDirectory('C:\\Users\\builder\\project'), true);
  assert.equal(containsAbsoluteUserDirectory('C:\\\\Users\\\\builder\\\\project'), true);
  assert.equal(containsAbsoluteUserDirectory('file:///Users/builder/project'), true);
  assert.equal(containsAbsoluteUserDirectory('\\/Users\\/builder\\/project'), true);
  assert.equal(containsAbsoluteUserDirectory('/Users/builder/'), true);
  assert.equal(containsAbsoluteUserDirectory('\\\\server\\Users\\builder\\project'), true);
  assert.equal(containsAbsoluteUserDirectory('\\\\?\\C:\\Users\\builder\\project'), true);
  assert.equal(containsAbsoluteUserDirectory('https://example.invalid/home/public/path'), true);
  assert.equal(containsAbsoluteUserDirectory('/var/tmp/project'), false);

  const findings = scanZipArchiveForSensitiveMetadata(archive);
  assert.deepEqual(findings, [{ path: 'base/assets/app.config', rule: 'absolute-user-directory' }]);
  assert.equal(JSON.stringify(findings).includes(privateUsername), false);
  assert.equal(JSON.stringify(findings).includes(privateRemainder), false);
});

test('sensitive metadata exceptions require an exact archive path and complete file digest', () => {
  const reviewedPath = 'base/lib/arm64-v8a/libfixture.so';
  const reviewedContents = Buffer.from('upstream build root /home/runner/work/fixture');
  const reviewedException = {
    path: reviewedPath,
    rule: 'absolute-user-directory',
    sha256: createHash('sha256').update(reviewedContents).digest('hex'),
    review: 'example.invalid:fixture:1.0.0',
  };
  const reviewedArchive = zip([[reviewedPath, reviewedContents]]);

  assert.deepEqual(scanZipArchiveForSensitiveMetadata(reviewedArchive), [
    { path: reviewedPath, rule: 'absolute-user-directory' },
  ]);
  assert.deepEqual(
    classifyZipArchiveSensitiveMetadata(reviewedArchive, undefined, {
      reviewedExceptions: [reviewedException],
    }),
    {
      findings: [],
      reviewedFindings: [
        {
          path: reviewedPath,
          rule: 'absolute-user-directory',
          sha256: reviewedException.sha256,
          review: reviewedException.review,
        },
      ],
    },
  );

  const changedBytes = zip([[reviewedPath, Buffer.concat([reviewedContents, Buffer.from([0])])]]);
  assert.deepEqual(
    scanZipArchiveForSensitiveMetadata(changedBytes, undefined, {
      reviewedExceptions: [reviewedException],
    }),
    [{ path: reviewedPath, rule: 'absolute-user-directory' }],
  );
  const renamedArchive = zip([['base/lib/arm64-v8a/librenamed.so', reviewedContents]]);
  assert.deepEqual(
    scanZipArchiveForSensitiveMetadata(renamedArchive, undefined, {
      reviewedExceptions: [reviewedException],
    }),
    [{ path: 'base/lib/arm64-v8a/librenamed.so', rule: 'absolute-user-directory' }],
  );
  const additionalMarker = zip([
    [reviewedPath, reviewedContents],
    ['base/lib/arm64-v8a/libextra.so', '/Users/builder/extra'],
  ]);
  assert.deepEqual(
    scanZipArchiveForSensitiveMetadata(additionalMarker, undefined, {
      reviewedExceptions: [reviewedException],
    }),
    [{ path: 'base/lib/arm64-v8a/libextra.so', rule: 'absolute-user-directory' }],
  );
});

test('reviewed Android path exceptions remain pinned to the two audited OpenSSL outputs', () => {
  assert.deepEqual(REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS, [
    {
      path: 'base/lib/arm64-v8a/libcrypto.so',
      rule: 'absolute-user-directory',
      sha256: 'da06ab9b38e9e28d2f9ab0040d398ec076d981f3a309325971a978e6135b80b1',
      review: 'io.github.ronickg:openssl:3.3.2-1',
    },
    {
      path: 'BUNDLE-METADATA/com.android.tools.build.debugsymbols/arm64-v8a/libcrypto.so.sym',
      rule: 'absolute-user-directory',
      sha256: '168e5685408ac41ccc9338a7e202b03de1bf2575f8100678d54626a7bdc45a6b',
      review: 'io.github.ronickg:openssl:3.3.2-1',
    },
  ]);
  assert.equal(Object.isFrozen(REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS), true);
  assert.equal(REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS.every(Object.isFrozen), true);
});

test('legal provenance binds the exact AAB, build receipt hash, and bounded native proof', () => {
  const runId = 'android-0.1.44-abcdef0-20260909013045';
  const artifactSha256 = 'a'.repeat(64);
  const nativePathProof = {
    schemaVersion: 1,
    compileDatabases: 3,
    compileCommands: 41,
    databaseBytes: 8192,
    sourceDestination: '/gator/source',
    gradleDestination: '/gator/gradle',
  };
  const build = {
    schemaVersion: 2,
    runId,
    mode: 'local',
    profile: 'production',
    environment: 'production',
    output: 'artifact.pending.aab',
    startedAt: '2026-09-09T01:30:45.000Z',
    finishedAt: '2026-09-09T01:31:45.000Z',
    remoteVersionMayHaveAdvanced: true,
    exitCode: 0,
    artifact: { filename: 'artifact.pending.aab', bytes: 4096, sha256: artifactSha256 },
    nativePathProof,
  };
  const buildReceiptSource = Buffer.from(`${JSON.stringify(build, null, 2)}\n`);
  const buildReceiptSha256 = createHash('sha256').update(buildReceiptSource).digest('hex');
  const validation = {
    build: {
      mode: 'local',
      profile: 'production',
      environment: 'production',
      easCli: '21.5.0',
      receipt: 'build.json',
      receiptSha256: buildReceiptSha256,
      nativePathProof,
    },
  };
  const input = {
    build,
    buildReceiptSource,
    validation,
    runId,
    artifactBytes: 4096,
    artifactSha256,
  };
  assert.deepEqual(validateReleaseBuildReceiptProvenance(input), {
    buildReceiptSha256,
    nativePathProof,
  });

  for (const mutation of [
    { ...input, artifactSha256: 'b'.repeat(64) },
    {
      ...input,
      validation: {
        build: { ...validation.build, receiptSha256: 'b'.repeat(64) },
      },
    },
    {
      ...input,
      validation: {
        build: {
          ...validation.build,
          nativePathProof: { ...nativePathProof, compileDatabases: 0 },
        },
      },
    },
    { ...input, validation: { build: { ...validation.build, hostPath: '/Users/reviewer' } } },
    { ...input, build: { ...build, schemaVersion: 1 } },
  ]) {
    assert.throws(() => validateReleaseBuildReceiptProvenance(mutation), /AAB legal inventory/);
  }
});

test('Google Maps key evidence requires the exact validation check and matching SHA-256 digests', () => {
  const googleMapsApiKeySha256 = 'a'.repeat(64);
  const releaseState = {
    target: { googleMapsApiKeySha256 },
    artifact: { googleMapsApiKeySha256 },
  };
  const validation = {
    artifact: { googleMapsApiKeySha256 },
    validation: {
      checks: [
        'zip-integrity',
        'packaged-artifact',
        'identity',
        'signature',
        'hash',
        'google-maps-key-binding',
        'native-path-proof',
      ],
    },
  };

  assert.equal(
    validateGoogleMapsKeyDigestBinding({ releaseState, validation }),
    googleMapsApiKeySha256,
  );

  const withoutMapCheck = validation.validation.checks.filter(
    (check) => check !== 'google-maps-key-binding',
  );
  for (const mutation of [
    { releaseState, validation: { ...validation, validation: { checks: withoutMapCheck } } },
    {
      releaseState,
      validation: {
        ...validation,
        validation: {
          checks: [...validation.validation.checks, 'google-maps-key-binding'],
        },
      },
    },
    {
      releaseState: {
        ...releaseState,
        target: {},
      },
      validation,
    },
    {
      releaseState: {
        ...releaseState,
        artifact: {},
      },
      validation,
    },
    {
      releaseState,
      validation: {
        ...validation,
        artifact: {},
      },
    },
    {
      releaseState: {
        ...releaseState,
        target: { googleMapsApiKeySha256: googleMapsApiKeySha256.toUpperCase() },
      },
      validation,
    },
    {
      releaseState: {
        ...releaseState,
        target: { googleMapsApiKeySha256: 'a'.repeat(63) },
      },
      validation,
    },
    {
      releaseState: {
        ...releaseState,
        artifact: { googleMapsApiKeySha256: 'b'.repeat(64) },
      },
      validation,
    },
    {
      releaseState,
      validation: {
        ...validation,
        artifact: { googleMapsApiKeySha256: 'c'.repeat(64) },
      },
    },
  ]) {
    assert.throws(() => validateGoogleMapsKeyDigestBinding(mutation), /AAB legal inventory/);
  }
});

test('protobuf boundary accepts packed repeated edges and omitted zero owner', () => {
  const edge = Buffer.concat([field(2, Buffer.concat([varint(1), varint(1)]))]);
  const module = Buffer.concat([field(1, 'base'), field(2, Buffer.from([0]))]);
  const metadata = Buffer.concat([
    field(1, maven('example', 'root', '1.0')),
    field(1, maven('example', 'child', '1.0')),
    field(2, edge),
    field(3, module),
  ]);

  const parsed = parseAppDependencies(metadata);
  assert.equal(parsed.libraries.length, 2);
  assert.equal(parsed.reachableLibraries, 2);
  assert.deepEqual(parsed.libraryDependencies[0], {
    libraryIndex: 0,
    dependencyIndexes: [1, 1],
  });
  assert.throws(
    () => parseAppDependencies(Buffer.concat([metadata, field(9, 'unknown')])),
    /unknown/,
  );
  assert.throws(() => parseAppDependencies(Buffer.from([0x80])), /truncated protobuf varint/);
  assert.throws(() => parseAppDependencies(field(1, 1, 0)), /wire type/);

  assert.throws(
    () => parseAppDependencies(Buffer.concat([metadata, field(2, edge)])),
    /repeats edge owner/,
  );
  const outOfRangeEdge = field(2, field(2, Buffer.from([2])));
  assert.throws(
    () =>
      parseAppDependencies(
        Buffer.concat([field(1, maven('example', 'only', '1')), outOfRangeEdge, field(3, module)]),
      ),
    /nonexistent library index/,
  );
  const ambiguousMaven = field(
    1,
    Buffer.concat([field(1, 'bad:group'), field(2, 'artifact'), field(5, '1.0')]),
  );
  assert.throws(
    () => parseAppDependencies(Buffer.concat([field(1, ambiguousMaven), field(3, module)])),
    /Maven coordinate grammar/,
  );
});
