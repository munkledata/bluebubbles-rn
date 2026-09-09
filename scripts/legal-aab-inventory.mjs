#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { isValidReleaseBuildReceipt } from './android-release-receipt.mjs';
import { isLegalFileName } from './legal-file-name.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_METADATA_PATH = 'BUNDLE-METADATA/com.android.tools.build.gradle/app-metadata.properties';
const DEPENDENCIES_PATH = 'BUNDLE-METADATA/com.android.tools.build.libraries/dependencies.pb';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_NAME_BYTES = 1024;
const MAX_DECLARED_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SELECTED_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_SELECTED_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_DEPENDENCIES_BYTES = 4 * 1024 * 1024;
const MAX_PROTO_FIELDS = 200_000;
const MAX_PROTO_LIBRARIES = 20_000;
const MAX_PROTO_STRING_BYTES = 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const ABSOLUTE_USER_DIRECTORY_PATTERN =
  /\/+Users\/+[^/\x00-\x1f]{1,128}(?:\/+|$)|\/+home\/+[^/\x00-\x1f]{1,128}(?:\/+|$)/i;

// op-sqlite 17.1.2 packages these two reviewed outputs from the pinned
// io.github.ronickg:openssl:3.3.2-1 AAR. That upstream binary contains a generic build-machine
// path. The exception is deliberately bound to both the archive path and the complete file digest;
// any rebuilt, renamed, or additional file remains blocked by the ordinary metadata scan.
export const REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS = Object.freeze([
  Object.freeze({
    path: 'base/lib/arm64-v8a/libcrypto.so',
    rule: 'absolute-user-directory',
    sha256: 'da06ab9b38e9e28d2f9ab0040d398ec076d981f3a309325971a978e6135b80b1',
    review: 'io.github.ronickg:openssl:3.3.2-1',
  }),
  Object.freeze({
    path: 'BUNDLE-METADATA/com.android.tools.build.debugsymbols/arm64-v8a/libcrypto.so.sym',
    rule: 'absolute-user-directory',
    sha256: '168e5685408ac41ccc9338a7e202b03de1bf2575f8100678d54626a7bdc45a6b',
    review: 'io.github.ronickg:openssl:3.3.2-1',
  }),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`AAB legal inventory refused input: ${message}`);
}

function readRegularFileOnce(path, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`${label} cannot be opened without following symbolic links`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} is not a regular file`);
    if (before.size <= 0 || before.size > maximumBytes)
      fail(`${label} is empty or exceeds its ${maximumBytes}-byte limit`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} became shorter while it was being read`);
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0)
      fail(`${label} grew while it was being read`);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function ensureExistingDirectoryPathWithoutSymlinks(root, directory, label) {
  const fromRoot = relative(root, directory);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    fail(`${label} escapes the repository`);
  let cursor = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) fail(`${label} parent directory does not exist`);
    const state = lstatSync(cursor);
    if (state.isSymbolicLink() || !state.isDirectory())
      fail(`${label} parent is not a real directory`);
  }
}

function writeOutputAtomically(root, projectPath, source) {
  const output = resolve(root, projectPath);
  const outputRelative = relative(root, output).replaceAll(sep, '/');
  if (!/^legal\/generated\/aab-inventory-[A-Za-z0-9._-]+\.json$/.test(outputRelative))
    fail('--output must be a named AAB inventory under legal/generated');
  ensureExistingDirectoryPathWithoutSymlinks(root, dirname(output), 'output path');
  if (existsSync(output)) {
    const state = lstatSync(output);
    if (state.isSymbolicLink() || !state.isFile())
      fail('output target is not a regular, non-symbolic-link file');
  }
  const temporary = resolve(
    dirname(output),
    `.${basename(output)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o644,
    );
    writeFileSync(descriptor, source, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, output);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function assertInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) fail(message);
  return value;
}

function checkedEnd(start, length, limit, label) {
  assertInteger(start, `${label} offset is invalid`);
  assertInteger(length, `${label} length is invalid`);
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > limit) fail(`${label} exceeds its container`);
  return end;
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function normalizeArchivePath(value) {
  if (
    !value ||
    value.length > MAX_ENTRY_NAME_BYTES ||
    value.includes('\\') ||
    /[\0-\x1f\x7f]/.test(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`unsafe archive entry name: ${JSON.stringify(value)}`);
  }
  const directory = value.endsWith('/');
  const parts = (directory ? value.slice(0, -1) : value).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    fail(`unsafe archive entry path: ${JSON.stringify(value)}`);
  if (value.normalize('NFC') !== value)
    fail(`archive entry name is not NFC-normalized: ${JSON.stringify(value)}`);
  return { path: value, directory };
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - (65_535 + 22));
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  fail('classic ZIP end-of-central-directory record is missing');
}

export function parseZipArchive(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('archive bytes are unavailable');
  if (bytes.length > MAX_ARCHIVE_BYTES) fail('archive exceeds the 512 MiB inspection limit');
  if (bytes.length < 22) fail('archive is shorter than a ZIP end record');

  const eocd = findEndOfCentralDirectory(bytes);
  if (bytes.readUInt16LE(eocd + 20) !== 0) fail('ZIP archive comments are not accepted');
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    fail('multi-disk and ZIP64 archives are not accepted');
  }
  if (entryCount === 0 || entryCount > MAX_ENTRIES)
    fail(`archive entry count must be between 1 and ${MAX_ENTRIES}`);
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES)
    fail('central directory exceeds the 16 MiB inspection limit');
  if (centralOffset + centralSize !== eocd)
    fail('central directory bounds do not match the ZIP end record');

  const entries = [];
  const exactNames = new Set();
  const foldedNames = new Map();
  let cursor = centralOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (checkedEnd(cursor, 46, eocd, 'central-directory header') > eocd)
      fail('central-directory header is truncated');
    if (bytes.readUInt32LE(cursor) !== 0x02014b50)
      fail(`central-directory record ${index} has the wrong signature`);
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk !== 0
    ) {
      fail(`entry ${index} requires ZIP64 or another disk`);
    }
    if ((flags & ~0x0806) !== 0)
      fail(`entry ${index} uses unsupported ZIP flags 0x${flags.toString(16)}`);
    if (![0, 8].includes(method))
      fail(`entry ${index} uses unsupported compression method ${method}`);
    if (method === 0 && (flags & 0x0006) !== 0)
      fail(`stored entry ${index} sets deflate-only flags`);
    if (method === 0 && compressedBytes !== uncompressedBytes)
      fail(`stored entry ${index} has different compressed and uncompressed sizes`);
    if (extraLength !== 0 || commentLength !== 0)
      fail(`entry ${index} uses unsupported ZIP extra fields or comments`);
    if (nameLength === 0 || nameLength > MAX_ENTRY_NAME_BYTES)
      fail(`entry ${index} has an invalid name length`);
    const recordEnd = checkedEnd(
      cursor,
      46 + nameLength + extraLength + commentLength,
      eocd,
      `central-directory record ${index}`,
    );
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (nameBytes.some((byte) => byte < 0x20 || byte > 0x7e))
      fail(`entry ${index} name is not printable ASCII`);
    const normalized = normalizeArchivePath(decodeUtf8(nameBytes, `entry ${index} name`));
    const folded = normalized.path.toLocaleLowerCase('en-US');
    if (exactNames.has(normalized.path)) fail(`duplicate archive entry: ${normalized.path}`);
    if (foldedNames.has(folded))
      fail(
        `case-insensitive archive entry collision: ${foldedNames.get(folded)} and ${normalized.path}`,
      );
    exactNames.add(normalized.path);
    foldedNames.set(folded, normalized.path);

    const host = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0o170000;
    if (host !== 3) fail(`archive entry lacks auditable Unix file mode: ${normalized.path}`);
    if (normalized.directory) {
      if (
        unixType !== 0o040000 ||
        compressedBytes !== 0 ||
        uncompressedBytes !== 0 ||
        crc !== 0 ||
        method !== 0
      ) {
        fail(
          `directory entry has mode, payload, CRC, or compression ambiguity: ${normalized.path}`,
        );
      }
    } else if (unixType !== 0o100000) {
      fail(`archive entry is not a regular file: ${normalized.path}`);
    }

    declaredUncompressedBytes += uncompressedBytes;
    if (
      !Number.isSafeInteger(declaredUncompressedBytes) ||
      declaredUncompressedBytes > MAX_DECLARED_UNCOMPRESSED_BYTES
    ) {
      fail('declared uncompressed archive exceeds the 2 GiB inspection limit');
    }
    entries.push({
      index,
      path: normalized.path,
      directory: normalized.directory,
      flags,
      method,
      crc,
      compressedBytes,
      uncompressedBytes,
      localOffset,
      nameBytes,
    });
    cursor = recordEnd;
  }
  if (cursor !== eocd) fail('central directory contains trailing or unparsed records');

  const localRanges = [];
  for (const entry of entries) {
    const headerEnd = checkedEnd(
      entry.localOffset,
      30,
      centralOffset,
      `local header ${entry.path}`,
    );
    if (bytes.readUInt32LE(entry.localOffset) !== 0x04034b50)
      fail(`local header has the wrong signature: ${entry.path}`);
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localCrc = bytes.readUInt32LE(entry.localOffset + 14);
    const localCompressedBytes = bytes.readUInt32LE(entry.localOffset + 18);
    const localUncompressedBytes = bytes.readUInt32LE(entry.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const nameEnd = checkedEnd(
      headerEnd,
      localNameLength,
      centralOffset,
      `local name ${entry.path}`,
    );
    const dataStart = checkedEnd(
      nameEnd,
      localExtraLength,
      centralOffset,
      `local extra ${entry.path}`,
    );
    const dataEnd = checkedEnd(
      dataStart,
      entry.compressedBytes,
      centralOffset,
      `compressed data ${entry.path}`,
    );
    if (localFlags !== entry.flags || localMethod !== entry.method)
      fail(`local and central flags or compression differ: ${entry.path}`);
    if (
      localCrc !== entry.crc ||
      localCompressedBytes !== entry.compressedBytes ||
      localUncompressedBytes !== entry.uncompressedBytes
    ) {
      fail(`local and central CRC or sizes differ: ${entry.path}`);
    }
    if (localExtraLength !== 0) fail(`local ZIP extra fields are not accepted: ${entry.path}`);
    if (!bytes.subarray(headerEnd, nameEnd).equals(entry.nameBytes))
      fail(`local and central names differ: ${entry.path}`);
    entry.dataStart = dataStart;
    entry.dataEnd = dataEnd;
    localRanges.push({ start: entry.localOffset, end: dataEnd, path: entry.path });
  }
  localRanges.sort((a, b) => a.start - b.start);
  if (localRanges[0]?.start !== 0) fail('ZIP contains an unaccounted preamble');
  for (let index = 1; index < localRanges.length; index += 1) {
    const previous = localRanges[index - 1];
    const current = localRanges[index];
    if (current.start !== previous.end)
      fail(`local ZIP records overlap or leave a gap: ${previous.path} and ${current.path}`);
  }
  if (localRanges.at(-1)?.end !== centralOffset)
    fail('ZIP contains unaccounted bytes before the central directory');
  return { entries, declaredUncompressedBytes };
}

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

export function extractZipEntry(bytes, entry, maximumBytes = MAX_SELECTED_ENTRY_BYTES) {
  if (entry.directory) fail(`cannot read directory entry: ${entry.path}`);
  if (entry.uncompressedBytes > maximumBytes)
    fail(`${entry.path} exceeds its ${maximumBytes}-byte extraction limit`);
  if (
    entry.uncompressedBytes > 1024 * 1024 &&
    entry.uncompressedBytes > Math.max(1, entry.compressedBytes) * 100
  ) {
    fail(`${entry.path} exceeds the 100:1 compression-ratio limit`);
  }
  const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
  let contents;
  try {
    if (entry.method === 0) {
      contents = Buffer.from(compressed);
    } else {
      const inflated = inflateRawSync(compressed, {
        maxOutputLength: Math.min(maximumBytes, entry.uncompressedBytes + 1),
        info: true,
      });
      if (inflated.engine.bytesWritten !== compressed.length)
        fail(`${entry.path} contains trailing compressed bytes`);
      contents = inflated.buffer;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AAB legal inventory refused input:'))
      throw error;
    fail(`${entry.path} cannot be decompressed: ${error instanceof Error ? error.message : error}`);
  }
  if (contents.length !== entry.uncompressedBytes)
    fail(`${entry.path} decompressed size does not match its central record`);
  if (crc32(contents) !== entry.crc) fail(`${entry.path} fails CRC-32 verification`);
  return contents;
}

export function containsAbsoluteUserDirectory(contents) {
  const source = Buffer.isBuffer(contents) ? contents.toString('latin1') : String(contents);
  return ABSOLUTE_USER_DIRECTORY_PATTERN.test(source.replaceAll('\\', '/'));
}

function reviewedSensitiveMetadataExceptionMap(reviewedExceptions) {
  if (!Array.isArray(reviewedExceptions)) fail('reviewed metadata exceptions must be an array');
  const result = new Map();
  for (const exception of reviewedExceptions) {
    if (
      !exception ||
      typeof exception.path !== 'string' ||
      normalizeArchivePath(exception.path).directory ||
      exception.rule !== 'absolute-user-directory' ||
      !/^[a-f0-9]{64}$/.test(exception.sha256) ||
      typeof exception.review !== 'string' ||
      !exception.review.trim()
    ) {
      fail('reviewed metadata exception is malformed');
    }
    if (result.has(exception.path)) fail('reviewed metadata exception path is duplicated');
    result.set(exception.path, exception);
  }
  return result;
}

function classifySensitiveMetadataEntry(entry, contents, reviewedExceptions) {
  if (!containsAbsoluteUserDirectory(contents)) return null;
  const exception = reviewedExceptions.get(entry.path);
  const digest = exception ? sha256(contents) : null;
  if (exception && digest === exception.sha256) {
    return {
      reviewed: true,
      finding: {
        path: entry.path,
        rule: 'absolute-user-directory',
        sha256: digest,
        review: exception.review,
      },
    };
  }
  return {
    reviewed: false,
    finding: { path: entry.path, rule: 'absolute-user-directory' },
  };
}

export function classifyZipArchiveSensitiveMetadata(
  bytes,
  archive = parseZipArchive(bytes),
  { reviewedExceptions = [] } = {},
) {
  const findings = [];
  const reviewedFindings = [];
  const exceptionMap = reviewedSensitiveMetadataExceptionMap(reviewedExceptions);
  let selectedBytes = 0;
  for (const entry of archive.entries) {
    if (entry.directory) continue;
    selectedBytes += entry.uncompressedBytes;
    if (selectedBytes > MAX_SELECTED_TOTAL_BYTES)
      fail('archive file payload exceeds the 512 MiB total inspection limit');
    const result = classifySensitiveMetadataEntry(
      entry,
      extractZipEntry(bytes, entry),
      exceptionMap,
    );
    if (!result) continue;
    (result.reviewed ? reviewedFindings : findings).push(result.finding);
  }
  return { findings, reviewedFindings };
}

export function scanZipArchiveForSensitiveMetadata(
  bytes,
  archive = parseZipArchive(bytes),
  options,
) {
  return classifyZipArchiveSensitiveMetadata(bytes, archive, options).findings;
}

export function inspectAabSensitiveMetadata(aabPath) {
  const snapshot = readAabArchiveSnapshot(aabPath);
  return scanZipArchiveForSensitiveMetadata(snapshot.bytes, snapshot.archive);
}

export function readAabArchiveSnapshot(aabPath) {
  const bytes = readRegularFileOnce(resolve(aabPath), MAX_ARCHIVE_BYTES, 'AAB');
  return { bytes, archive: parseZipArchive(bytes) };
}

function readVarint(bytes, state, budget, label) {
  let value = 0n;
  let shift = 0n;
  let last = 0;
  let count = 0;
  while (count < 10) {
    if (state.offset >= bytes.length) fail(`${label} contains a truncated protobuf varint`);
    const byte = bytes[state.offset];
    state.offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    last = byte;
    count += 1;
    if ((byte & 0x80) === 0) {
      if (count > 1 && (last & 0x7f) === 0) fail(`${label} contains a non-canonical varint`);
      if (count === 10 && last > 1) fail(`${label} contains an overflowing varint`);
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(`${label} varint exceeds safe integer range`);
      budget.fields += 1;
      if (budget.fields > MAX_PROTO_FIELDS)
        fail('dependency metadata has too many protobuf fields');
      return Number(value);
    }
    shift += 7n;
  }
  fail(`${label} contains an overlong protobuf varint`);
}

function parseFields(bytes, allowed, budget, label) {
  const state = { offset: 0 };
  const fields = new Map();
  while (state.offset < bytes.length) {
    const key = readVarint(bytes, state, budget, label);
    const number = Math.floor(key / 8);
    const wire = key & 7;
    const expected = allowed.get(number);
    if (expected === undefined) fail(`${label} contains unknown field ${number}`);
    const expectedWires = Array.isArray(expected) ? expected : [expected];
    if (!expectedWires.includes(wire))
      fail(
        `${label} field ${number} has wire type ${wire}, expected ${expectedWires.join(' or ')}`,
      );
    let value;
    if (wire === 0) {
      value = readVarint(bytes, state, budget, label);
    } else if (wire === 2) {
      const length = readVarint(bytes, state, budget, label);
      const end = checkedEnd(state.offset, length, bytes.length, `${label} field ${number}`);
      value = bytes.subarray(state.offset, end);
      state.offset = end;
    } else {
      fail(`${label} field ${number} uses an unsupported wire type`);
    }
    const values = fields.get(number) ?? [];
    values.push(value);
    fields.set(number, values);
  }
  return fields;
}

function singular(fields, number, label, required = false) {
  const values = fields.get(number) ?? [];
  if (values.length > 1) fail(`${label} repeats singular field ${number}`);
  if (required && values.length !== 1) fail(`${label} is missing required field ${number}`);
  return values[0];
}

function protoString(value, label, required = false) {
  if (value === undefined) {
    if (required) fail(`${label} is missing`);
    return null;
  }
  if (value.length > MAX_PROTO_STRING_BYTES) fail(`${label} exceeds 1 KiB`);
  const text = decodeUtf8(value, label);
  if (!text || text !== text.trim() || /[\0-\x1f\x7f]/.test(text)) fail(`${label} is invalid`);
  return text;
}

function mavenPart(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value))
    fail(`${label} is outside the supported Maven coordinate grammar`);
  return value;
}

function parseMavenLibrary(bytes, budget, index) {
  const fields = parseFields(
    bytes,
    new Map([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
    ]),
    budget,
    `Maven library ${index}`,
  );
  const group = protoString(
    singular(fields, 1, `Maven library ${index}`),
    `Maven group ${index}`,
    true,
  );
  const artifact = protoString(
    singular(fields, 2, `Maven library ${index}`),
    `Maven artifact ${index}`,
    true,
  );
  const packaging = protoString(
    singular(fields, 3, `Maven library ${index}`),
    `Maven packaging ${index}`,
  );
  const classifier = protoString(
    singular(fields, 4, `Maven library ${index}`),
    `Maven classifier ${index}`,
  );
  const version = protoString(
    singular(fields, 5, `Maven library ${index}`),
    `Maven version ${index}`,
    true,
  );
  mavenPart(group, `Maven group ${index}`);
  mavenPart(artifact, `Maven artifact ${index}`);
  mavenPart(version, `Maven version ${index}`);
  if (packaging) mavenPart(packaging, `Maven packaging ${index}`);
  if (classifier) mavenPart(classifier, `Maven classifier ${index}`);
  const coordinate = `${group}:${artifact}:${version}${classifier ? `:${classifier}` : ''}${packaging ? `@${packaging}` : ''}`;
  return { kind: 'maven', group, artifact, version, packaging, classifier, coordinate };
}

function parseDigest(bytes, budget, index) {
  const fields = parseFields(bytes, new Map([[1, 2]]), budget, `library digest ${index}`);
  const digest = singular(fields, 1, `library digest ${index}`);
  if (digest === undefined) return null;
  if (digest.length !== 32) fail(`library digest ${index} is not a SHA-256 value`);
  return digest.toString('hex');
}

function parseWrappedIndex(bytes, budget, label) {
  const fields = parseFields(bytes, new Map([[1, 0]]), budget, label);
  return singular(fields, 1, label) ?? 0;
}

function parseLibrary(bytes, budget, index) {
  const fields = parseFields(
    bytes,
    new Map([
      [1, 2],
      [2, 2],
      [3, 2],
    ]),
    budget,
    `library ${index}`,
  );
  const maven = singular(fields, 1, `library ${index}`);
  if (!maven) fail(`library ${index} is not a Maven library in the supported AGP schema`);
  const identity = parseMavenLibrary(maven, budget, index);
  const digestBytes = singular(fields, 2, `library ${index}`);
  const repoBytes = singular(fields, 3, `library ${index}`);
  return {
    index,
    ...identity,
    sha256: digestBytes ? parseDigest(digestBytes, budget, index) : null,
    repositoryIndex: repoBytes
      ? parseWrappedIndex(repoBytes, budget, `repository index ${index}`)
      : null,
  };
}

function repeatedIndexes(fields, number, budget, label) {
  const result = [];
  for (const value of fields.get(number) ?? []) {
    if (typeof value === 'number') {
      result.push(value);
      continue;
    }
    const state = { offset: 0 };
    while (state.offset < value.length)
      result.push(readVarint(value, state, budget, `${label} packed field ${number}`));
  }
  return result;
}

function parseLibraryDependencies(bytes, budget, recordIndex) {
  const label = `dependency edges ${recordIndex}`;
  const fields = parseFields(
    bytes,
    new Map([
      [1, 0],
      [2, [0, 2]],
    ]),
    budget,
    label,
  );
  return {
    libraryIndex: singular(fields, 1, label) ?? 0,
    dependencyIndexes: repeatedIndexes(fields, 2, budget, label),
  };
}

function parseModuleDependencies(bytes, budget, recordIndex) {
  const label = `module dependencies ${recordIndex}`;
  const fields = parseFields(
    bytes,
    new Map([
      [1, 2],
      [2, [0, 2]],
    ]),
    budget,
    label,
  );
  return {
    moduleName: protoString(singular(fields, 1, label), `module name ${recordIndex}`, true),
    dependencyIndexes: repeatedIndexes(fields, 2, budget, label),
  };
}

function publicRepositoryUrl(value, index) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`repository URL ${index} is invalid`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`repository URL ${index} is not a public credential-free HTTPS URL`);
  }
  return parsed.href;
}

function parseRepository(bytes, budget, index) {
  const fields = parseFields(
    bytes,
    new Map([
      [1, 2],
      [2, 2],
    ]),
    budget,
    `repository ${index}`,
  );
  const kinds = [
    ['maven', singular(fields, 1, `repository ${index}`)],
    ['ivy', singular(fields, 2, `repository ${index}`)],
  ].filter(([, value]) => value !== undefined);
  if (kinds.length !== 1) fail(`repository ${index} must contain exactly one recognized kind`);
  const [kind, nested] = kinds[0];
  const nestedFields = parseFields(
    nested,
    new Map([[1, 2]]),
    budget,
    `repository ${index} ${kind}`,
  );
  const rawUrl = protoString(
    singular(nestedFields, 1, `repository ${index} ${kind}`),
    `repository URL ${index}`,
    true,
  );
  return {
    index,
    kind,
    url: publicRepositoryUrl(rawUrl, index),
  };
}

export function parseAppDependencies(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_DEPENDENCIES_BYTES)
    fail('dependencies.pb is empty or exceeds 4 MiB');
  const budget = { fields: 0 };
  const fields = parseFields(
    bytes,
    new Map([
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
    ]),
    budget,
    'AppDependencies',
  );
  const rawLibraries = fields.get(1) ?? [];
  if (rawLibraries.length === 0 || rawLibraries.length > MAX_PROTO_LIBRARIES)
    fail(`dependency metadata must contain between 1 and ${MAX_PROTO_LIBRARIES} libraries`);
  const libraries = rawLibraries.map((value, index) => parseLibrary(value, budget, index));
  const libraryDependencies = (fields.get(2) ?? []).map((value, index) =>
    parseLibraryDependencies(value, budget, index),
  );
  const modules = (fields.get(3) ?? []).map((value, index) =>
    parseModuleDependencies(value, budget, index),
  );
  const repositories = (fields.get(4) ?? []).map((value, index) =>
    parseRepository(value, budget, index),
  );
  if (modules.length === 0) fail('dependency metadata contains no bundle-module roots');

  const assertLibraryIndex = (value, label) => {
    if (!Number.isInteger(value) || value < 0 || value >= libraries.length)
      fail(`${label} references nonexistent library index ${value}`);
  };
  const edgeOwners = new Set();
  for (const record of libraryDependencies) {
    assertLibraryIndex(record.libraryIndex, 'dependency edge owner');
    if (edgeOwners.has(record.libraryIndex))
      fail(`dependency metadata repeats edge owner ${record.libraryIndex}`);
    edgeOwners.add(record.libraryIndex);
    for (const value of record.dependencyIndexes) assertLibraryIndex(value, 'dependency edge');
    record.dependencyIndexes.sort((a, b) => a - b);
  }
  const moduleNames = new Set();
  for (const module of modules) {
    if (moduleNames.has(module.moduleName))
      fail(`dependency metadata repeats module ${module.moduleName}`);
    moduleNames.add(module.moduleName);
    for (const value of module.dependencyIndexes)
      assertLibraryIndex(value, `module ${module.moduleName}`);
    module.dependencyIndexes.sort((a, b) => a - b);
  }
  const identityTuple = (library) =>
    library.kind === 'maven'
      ? [
          library.kind,
          library.group,
          library.artifact,
          library.version,
          library.classifier,
          library.packaging,
        ]
      : [library.kind, library.packageName, library.version];
  const coordinateOwners = new Map();
  const inconsistentCoordinates = [];
  for (const library of libraries) {
    if (library.repositoryIndex !== null && library.repositoryIndex >= repositories.length)
      fail(`library ${library.index} references nonexistent repository ${library.repositoryIndex}`);
    const identity = JSON.stringify(identityTuple(library));
    const prior = coordinateOwners.get(identity);
    if (prior && prior.sha256 !== library.sha256) inconsistentCoordinates.push(library.coordinate);
    else coordinateOwners.set(identity, library);
  }
  if (coordinateOwners.size !== libraries.length)
    fail(
      inconsistentCoordinates.length
        ? `dependency coordinates map to different digests: ${[...new Set(inconsistentCoordinates)].join(', ')}`
        : 'dependency metadata contains duplicate library coordinates',
    );

  const edgesByOwner = new Map(
    libraryDependencies.map((record) => [record.libraryIndex, record.dependencyIndexes]),
  );
  const reachable = new Set();
  const pending = modules.flatMap((module) => module.dependencyIndexes);
  while (pending.length) {
    const index = pending.pop();
    if (reachable.has(index)) continue;
    reachable.add(index);
    for (const dependencyIndex of edgesByOwner.get(index) ?? []) pending.push(dependencyIndex);
  }
  if (reachable.size !== libraries.length)
    fail(
      `${libraries.length - reachable.size} dependency records are unreachable from bundle modules`,
    );

  const coordinateLines = libraries
    .map((library) => JSON.stringify(identityTuple(library)))
    .sort(compareText)
    .map((line) => `${line}\n`)
    .join('');

  return {
    libraries: [...libraries].sort((a, b) => compareText(a.coordinate, b.coordinate)),
    libraryDependencies: libraryDependencies.sort((a, b) => a.libraryIndex - b.libraryIndex),
    modules: modules.sort((a, b) => compareText(a.moduleName, b.moduleName)),
    repositories,
    parserFieldCount: budget.fields,
    reachableLibraries: reachable.size,
    coordinateSetSha256: sha256(coordinateLines),
  };
}

function isLegalPath(path) {
  return isLegalFileName(path.slice(path.lastIndexOf('/') + 1));
}

function classifyEntry(path) {
  if (/\.(?:ttf|otf|woff2?)$/i.test(path)) return 'fonts';
  if (/\.(?:tflite|lite|onnx|ort|task)$/i.test(path)) return 'models';
  if (/^[^/]+\/lib\/[^/]+\/[^/]+\.so$/i.test(path)) return 'nativeLibraries';
  if (/\/(?:assets\/)?index\.android\.bundle$/i.test(path)) return 'javascriptBundles';
  if (/^[^/]+\/dex\/[^/]+\.dex$/i.test(path)) return 'dexFiles';
  if (isLegalPath(path)) return 'embeddedLegalFiles';
  return null;
}

function parseAppMetadata(bytes) {
  if (bytes.length === 0 || bytes.length > 64 * 1024)
    fail('app-metadata.properties is empty or exceeds 64 KiB');
  const text = decodeUtf8(bytes, 'app-metadata.properties');
  const properties = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) fail('app-metadata.properties contains an unsupported property line');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(key) || !value || key in properties)
      fail('app-metadata.properties contains an invalid or duplicate property');
    properties[key] = value;
  }
  for (const required of ['appMetadataVersion', 'androidGradlePluginVersion']) {
    if (!properties[required]) fail(`app-metadata.properties is missing ${required}`);
  }
  const sorted = Object.fromEntries(
    Object.entries(properties).sort(([left], [right]) => compareText(left, right)),
  );
  if (
    JSON.stringify(sorted) !==
    JSON.stringify({ androidGradlePluginVersion: '8.12.0', appMetadataVersion: '1.1' })
  ) {
    fail('app metadata is outside the audited app-metadata 1.1 / AGP 8.12.0 schema');
  }
  return sorted;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitRaw(root, args) {
  return execFileSync('git', args, { cwd: root });
}

function readJsonRecord(path, label) {
  const source = readRegularFileOnce(path, 1024 * 1024, label);
  let value;
  try {
    value = JSON.parse(decodeUtf8(source, label));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
  if (source.toString('utf8') !== `${JSON.stringify(value, null, 2)}\n`)
    fail(`${label} is not canonical JSON or contains duplicate keys`);
  return { value, source };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not match the artifact or release receipt`);
}

export function validateReleaseBuildReceiptProvenance({
  build,
  buildReceiptSource,
  validation,
  runId,
  artifactBytes,
  artifactSha256,
}) {
  const canonicalSource = `${JSON.stringify(build, null, 2)}\n`;
  if (buildReceiptSource.toString('utf8') !== canonicalSource) {
    fail('build receipt is not canonical JSON or does not match its parsed record');
  }
  if (
    !isValidReleaseBuildReceipt(build, {
      runId,
      artifact: { bytes: artifactBytes, sha256: artifactSha256 },
    })
  ) {
    fail('build receipt does not bind the exact promoted AAB and native-path proof');
  }
  const buildReceiptSha256 = sha256(buildReceiptSource);
  const expectedValidationBuildKeys = [
    'easCli',
    'environment',
    'mode',
    'nativePathProof',
    'profile',
    'receipt',
    'receiptSha256',
  ];
  if (
    !validation?.build ||
    !isDeepStrictEqual(Object.keys(validation.build).sort(), expectedValidationBuildKeys)
  ) {
    fail('validation build provenance has an unexpected shape');
  }
  assertEqual(validation.build.mode, 'local', 'validation build mode');
  assertEqual(validation.build.profile, 'production', 'validation build profile');
  assertEqual(validation.build.environment, 'production', 'validation build environment');
  assertEqual(validation.build.easCli, '21.5.0', 'validation EAS CLI');
  assertEqual(validation.build.receipt, 'build.json', 'validation build receipt path');
  assertEqual(
    validation.build.receiptSha256,
    buildReceiptSha256,
    'validation build receipt SHA-256',
  );
  if (!isDeepStrictEqual(validation.build.nativePathProof, build.nativePathProof)) {
    fail('validation native-path proof does not match the build receipt');
  }
  return { buildReceiptSha256, nativePathProof: build.nativePathProof };
}

function jsonWithoutReleaseVersion(source, lockfile = false) {
  const value = JSON.parse(source);
  delete value.version;
  if (lockfile && value.packages?.['']) delete value.packages[''].version;
  return value;
}

function collectLocalReleaseReceiptBinding(root, runId, aabPath, aabBytes, aabSha256) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) fail('release run id is invalid');
  const runRoot = resolve(root, 'dist/release', runId);
  const fromRoot = relative(root, runRoot);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    fail('release run path escapes the repository');
  ensureExistingDirectoryPathWithoutSymlinks(root, runRoot, 'release run path');
  const buildPath = resolve(runRoot, 'build.json');
  const promotionPath = resolve(runRoot, 'promotion.json');
  const validationPath = resolve(runRoot, 'validation.json');
  const statePath = resolve(runRoot, 'state.json');
  const buildRecord = readJsonRecord(buildPath, 'build receipt');
  const promotionRecord = readJsonRecord(promotionPath, 'promotion receipt');
  const validationRecord = readJsonRecord(validationPath, 'validation receipt');
  const stateRecord = readJsonRecord(statePath, 'release state receipt');
  const build = buildRecord.value;
  const promotion = promotionRecord.value;
  const validation = validationRecord.value;
  const releaseState = stateRecord.value;
  assertEqual(promotion.schemaVersion, 1, 'promotion schema');
  assertEqual(validation.schemaVersion, 2, 'validation schema');
  assertEqual(releaseState.schemaVersion, 1, 'release state schema');
  assertEqual(promotion.runId, runId, 'promotion run id');
  assertEqual(validation.runId, runId, 'validation run id');
  assertEqual(releaseState.runId, runId, 'release state run id');
  assertEqual(releaseState.phase, 'promoted', 'release state phase');
  const buildProvenance = validateReleaseBuildReceiptProvenance({
    build,
    buildReceiptSource: buildRecord.source,
    validation,
    runId,
    artifactBytes: aabBytes.length,
    artifactSha256: aabSha256,
  });
  for (const [label, value] of [
    ['source commit', promotion.sourceCommit],
    ['promotion commit', promotion.commit],
    ['release tree', promotion.tree],
  ]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
      fail(`${label} is not a full Git id`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(promotion.targetVersion))
    fail('promotion target version is not a three-part numeric version');
  if (!Number.isSafeInteger(promotion.versionCode) || promotion.versionCode <= 0)
    fail('promotion version code is invalid');
  assertEqual(validation.applicationId, 'com.bluegreengatorapps.messages', 'application id');
  assertEqual(
    promotion.branch,
    `release/android-${promotion.targetVersion}`,
    'derived release branch',
  );
  assertEqual(
    promotion.artifactFilename,
    `gator-release-${promotion.targetVersion}-v${promotion.versionCode}-${promotion.commit.slice(0, 7)}.aab`,
    'derived artifact filename',
  );
  if (
    typeof promotion.uploadCertificateSha256 !== 'string' ||
    !/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/.test(promotion.uploadCertificateSha256)
  ) {
    fail('upload certificate fingerprint is malformed');
  }
  if (
    runId !==
      `android-${promotion.targetVersion}-${promotion.sourceCommit.slice(0, 7)}-${runId.slice(-14)}` ||
    !/^\d{14}$/.test(runId.slice(-14))
  ) {
    fail('release run id does not match target version and source commit');
  }
  assertEqual(promotion.artifactFilename, basename(aabPath), 'promoted artifact filename');
  assertEqual(promotion.sha256, aabSha256, 'promoted artifact SHA-256');
  assertEqual(validation.artifact?.sha256, aabSha256, 'validated artifact SHA-256');
  assertEqual(validation.artifact?.bytes, aabBytes.length, 'validated artifact size');
  assertEqual(validation.artifact?.filename, 'artifact.pending.aab', 'validated artifact filename');
  assertEqual(validation.validation?.status, 'passed', 'validation status');
  assertEqual(validation.validation?.validator, 'scripts/check-android-build.mjs', 'validator');
  const validationChecks = validation.validation?.checks;
  const requiredChecks = [
    'hash',
    'identity',
    'native-path-proof',
    'packaged-artifact',
    'signature',
    'zip-integrity',
  ];
  if (
    !Array.isArray(validationChecks) ||
    new Set(validationChecks).size !== validationChecks.length ||
    JSON.stringify([...validationChecks].sort(compareText)) !== JSON.stringify(requiredChecks)
  ) {
    fail('validation receipt does not contain the exact required check set');
  }
  assertEqual(validation.versionName, validation.targetVersion, 'validated version name');
  assertEqual(validation.artifact?.versionName, validation.targetVersion, 'artifact version name');
  assertEqual(validation.artifact?.versionCode, validation.versionCode, 'artifact version code');
  assertEqual(
    validation.artifact?.applicationId,
    validation.applicationId,
    'artifact application id',
  );
  assertEqual(promotion.sourceCommit, validation.sourceCommit, 'source commit');
  assertEqual(promotion.targetVersion, validation.targetVersion, 'target version');
  assertEqual(promotion.versionCode, validation.versionCode, 'version code');
  assertEqual(promotion.tree, validation.releaseTree, 'release tree');
  assertEqual(
    promotion.uploadCertificateSha256,
    validation.artifact?.uploadCertificateSha256,
    'upload certificate',
  );
  assertEqual(releaseState.source?.commit, promotion.sourceCommit, 'release-state source commit');
  assertEqual(
    releaseState.target?.version,
    promotion.targetVersion,
    'release-state target version',
  );
  assertEqual(releaseState.target?.applicationId, validation.applicationId, 'release-state app id');
  assertEqual(releaseState.target?.platform, 'android', 'release-state platform');
  assertEqual(releaseState.target?.profile, 'production', 'release-state build profile');
  assertEqual(releaseState.target?.track, 'internal', 'release-state distribution track');
  assertEqual(
    releaseState.artifact?.filename,
    promotion.artifactFilename,
    'release-state artifact',
  );
  assertEqual(releaseState.artifact?.bytes, aabBytes.length, 'release-state artifact size');
  assertEqual(releaseState.artifact?.sha256, aabSha256, 'release-state artifact SHA-256');
  assertEqual(releaseState.artifact?.versionName, promotion.targetVersion, 'release-state version');
  assertEqual(
    releaseState.artifact?.versionCode,
    promotion.versionCode,
    'release-state version code',
  );
  assertEqual(
    releaseState.artifact?.uploadCertificateSha256,
    promotion.uploadCertificateSha256,
    'release-state upload certificate',
  );
  assertEqual(releaseState.promotion?.status, 'promoted', 'release-state promotion status');
  assertEqual(releaseState.promotion?.commit, promotion.commit, 'release-state promotion commit');
  assertEqual(releaseState.promotion?.tree, promotion.tree, 'release-state promotion tree');
  assertEqual(releaseState.promotion?.branch, promotion.branch, 'release-state promotion branch');
  assertEqual(releaseState.target?.releaseBranch, promotion.branch, 'release branch');
  assertEqual(releaseState.preparation?.releaseTree, promotion.tree, 'prepared release tree');
  let commit;
  try {
    const [hash, parents, tree] = git(root, [
      'show',
      '-s',
      '--format=%H%n%P%n%T',
      promotion.commit,
    ]).split('\n');
    commit = { hash, parents: parents ? parents.split(' ') : [], tree };
  } catch {
    fail('promotion commit is not available in the local Git object database');
  }
  assertEqual(commit.hash, promotion.commit, 'promotion commit id');
  assertEqual(commit.tree, promotion.tree, 'promotion commit tree');
  if (commit.parents.length !== 1 || commit.parents[0] !== promotion.sourceCommit)
    fail('promotion commit is not a single version-only child of the recorded source commit');
  assertEqual(
    git(root, ['rev-parse', `${promotion.sourceCommit}^{tree}`]),
    releaseState.source?.tree,
    'source commit tree',
  );

  const changedPaths = git(root, ['diff', '--name-only', promotion.sourceCommit, promotion.commit])
    .split('\n')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(['package-lock.json', 'package.json']))
    fail('promotion commit changes files other than package.json and package-lock.json');

  const sourcePackage = gitRaw(root, ['show', `${promotion.sourceCommit}:package.json`]);
  const releasePackage = gitRaw(root, ['show', `${promotion.commit}:package.json`]);
  const sourceLock = gitRaw(root, ['show', `${promotion.sourceCommit}:package-lock.json`]);
  const releaseLock = gitRaw(root, ['show', `${promotion.commit}:package-lock.json`]);
  const releasePackageJson = JSON.parse(releasePackage);
  const releaseLockJson = JSON.parse(releaseLock);
  assertEqual(releasePackageJson.version, promotion.targetVersion, 'promoted package version');
  assertEqual(releaseLockJson.version, promotion.targetVersion, 'promoted lockfile version');
  assertEqual(
    releaseLockJson.packages?.['']?.version,
    promotion.targetVersion,
    'promoted root lock version',
  );
  if (
    JSON.stringify(jsonWithoutReleaseVersion(sourcePackage)) !==
      JSON.stringify(jsonWithoutReleaseVersion(releasePackage)) ||
    JSON.stringify(jsonWithoutReleaseVersion(sourceLock, true)) !==
      JSON.stringify(jsonWithoutReleaseVersion(releaseLock, true))
  ) {
    fail('promotion commit contains changes beyond the three release-version fields');
  }

  const currentHead = git(root, ['rev-parse', 'HEAD']);
  const currentTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  const workingTreeClean = status.length === 0;
  const currentCleanRelease = workingTreeClean && currentHead === promotion.commit;
  return {
    runId,
    buildReceipt: relative(root, buildPath).replaceAll(sep, '/'),
    buildReceiptSha256: buildProvenance.buildReceiptSha256,
    nativePathProof: buildProvenance.nativePathProof,
    promotionReceipt: relative(root, promotionPath).replaceAll(sep, '/'),
    promotionReceiptSha256: sha256(promotionRecord.source),
    validationReceipt: relative(root, validationPath).replaceAll(sep, '/'),
    validationReceiptSha256: sha256(validationRecord.source),
    releaseStateReceipt: relative(root, statePath).replaceAll(sep, '/'),
    releaseStateReceiptSha256: sha256(stateRecord.source),
    sourceCommit: promotion.sourceCommit,
    releaseCommit: promotion.commit,
    releaseTree: promotion.tree,
    targetVersion: promotion.targetVersion,
    versionCode: promotion.versionCode,
    uploadCertificateSha256: promotion.uploadCertificateSha256,
    releasePackageLockSha256: sha256(releaseLock),
    currentCheckout: {
      head: currentHead,
      tree: currentTree,
      packageLockSha256: sha256(
        readRegularFileOnce(
          resolve(root, 'package-lock.json'),
          64 * 1024 * 1024,
          'package-lock.json',
        ),
      ),
      clean: workingTreeClean,
      relation: currentCleanRelease ? 'exact-clean-release-commit' : 'historical',
    },
  };
}

function publicEntry(entry, contents) {
  return {
    path: entry.path,
    bytes: contents.length,
    compressedBytes: entry.compressedBytes,
    sha256: sha256(contents),
  };
}

export function buildAabInventory({ root = ROOT, aabPath, runId }) {
  if (!aabPath || !runId) fail('both --aab and --run are required');
  const resolvedAab = resolve(aabPath);
  const bytes = readRegularFileOnce(resolvedAab, MAX_ARCHIVE_BYTES, 'AAB');
  const artifactSha256 = sha256(bytes);
  const archive = parseZipArchive(bytes);
  const appMetadataEntry = archive.entries.find((entry) => entry.path === APP_METADATA_PATH);
  const dependencyEntry = archive.entries.find((entry) => entry.path === DEPENDENCIES_PATH);
  if (!appMetadataEntry) fail(`${APP_METADATA_PATH} is missing`);
  if (!dependencyEntry) fail(`${DEPENDENCIES_PATH} is missing`);
  const appMetadataBytes = extractZipEntry(bytes, appMetadataEntry, 64 * 1024);
  const appMetadata = parseAppMetadata(appMetadataBytes);
  const dependencyBytes = extractZipEntry(bytes, dependencyEntry, MAX_DEPENDENCIES_BYTES);
  const dependencies = parseAppDependencies(dependencyBytes);
  const receiptBinding = collectLocalReleaseReceiptBinding(
    root,
    runId,
    resolvedAab,
    bytes,
    artifactSha256,
  );

  const archiveFiles = [];
  const groups = {
    fonts: [],
    models: [],
    nativeLibraries: [],
    javascriptBundles: [],
    dexFiles: [],
    embeddedLegalFiles: [],
  };
  const sensitiveMetadataFindings = [];
  const reviewedSensitiveMetadataExceptions = [];
  const reviewedExceptionMap = reviewedSensitiveMetadataExceptionMap(
    REVIEWED_ANDROID_ABSOLUTE_PATH_EXCEPTIONS,
  );
  let selectedBytes = 0;
  for (const entry of archive.entries) {
    if (entry.directory) continue;
    selectedBytes += entry.uncompressedBytes;
    if (selectedBytes > MAX_SELECTED_TOTAL_BYTES)
      fail('archive file payload exceeds the 512 MiB total hashing limit');
    const contents = extractZipEntry(bytes, entry);
    const record = publicEntry(entry, contents);
    archiveFiles.push(record);
    const sensitiveMetadata = classifySensitiveMetadataEntry(entry, contents, reviewedExceptionMap);
    if (sensitiveMetadata) {
      (sensitiveMetadata.reviewed
        ? reviewedSensitiveMetadataExceptions
        : sensitiveMetadataFindings
      ).push(sensitiveMetadata.finding);
    }
    const group = classifyEntry(entry.path);
    if (group) groups[group].push(record);
  }
  archiveFiles.sort((a, b) => compareText(a.path, b.path));
  for (const values of Object.values(groups)) values.sort((a, b) => compareText(a.path, b.path));

  const dependenciesMissingSha256 = dependencies.libraries.filter((item) => !item.sha256).length;
  const dependenciesMissingRepository = dependencies.libraries.filter(
    (item) => item.repositoryIndex === null,
  ).length;
  const unresolvedPackagedProvenanceRecords =
    groups.fonts.length + groups.models.length + groups.nativeLibraries.length;
  return {
    schemaVersion: 1,
    artifact: {
      filename: basename(resolvedAab),
      bytes: bytes.length,
      sha256: artifactSha256,
    },
    localReleaseReceiptBinding: receiptBinding,
    coverage: {
      archiveCentralDirectory: 'complete-and-bounded',
      archiveFileHashes: 'complete-and-crc-verified',
      gradleDependencies: DEPENDENCIES_PATH,
      fonts: 'complete-extension-match',
      models: 'complete-extension-match',
      nativeLibraries: 'complete-so-match',
      javascriptBundles: 'complete-index-android-bundle-match',
      dexFiles: 'complete-dex-match',
      embeddedLegalFiles: 'complete-legal-basename-match',
      exactCurrentReleaseLegalCoverage: false,
      npmJavaScriptBundleGraph: false,
      artifactToApprovedProvenanceReconciliation: false,
    },
    summary: {
      archiveEntries: archive.entries.length,
      archiveFiles: archiveFiles.length,
      declaredUncompressedBytes: archive.declaredUncompressedBytes,
      dependencyRecords: dependencies.libraries.length,
      reachableDependencyRecords: dependencies.reachableLibraries,
      dependencyEdgeRecords: dependencies.libraryDependencies.length,
      moduleRecords: dependencies.modules.length,
      repositoryRecords: dependencies.repositories.length,
      dependenciesMissingSha256,
      dependenciesMissingRepository,
      fonts: groups.fonts.length,
      models: groups.models.length,
      nativeLibraries: groups.nativeLibraries.length,
      javascriptBundles: groups.javascriptBundles.length,
      dexFiles: groups.dexFiles.length,
      embeddedLegalFiles: groups.embeddedLegalFiles.length,
      sensitiveMetadataFindings: sensitiveMetadataFindings.length,
      reviewedSensitiveMetadataExceptions: reviewedSensitiveMetadataExceptions.length,
      unresolvedPackagedProvenanceRecords,
    },
    reviewIssues: [
      ...(receiptBinding.currentCheckout.relation === 'historical'
        ? ['artifact is historical relative to the current checkout']
        : []),
      'local ignored release receipts establish self-consistency, not authenticated provenance',
      ...(dependenciesMissingSha256
        ? [`${dependenciesMissingSha256} Gradle dependency records omit a SHA-256 digest`]
        : []),
      ...(dependenciesMissingRepository
        ? [`${dependenciesMissingRepository} Gradle dependency records omit a repository index`]
        : []),
      'AAB metadata does not expose the exact npm modules retained in the Hermes JavaScript bundle',
      `${unresolvedPackagedProvenanceRecords} packaged font/model/native-library files remain unmapped to approved provenance`,
      'embedded legal files have been hashed but their obligations have not been legally reviewed',
      ...(sensitiveMetadataFindings.length
        ? [
            `${sensitiveMetadataFindings.length} packaged files contain an absolute user-directory marker`,
          ]
        : []),
      ...(reviewedSensitiveMetadataExceptions.length
        ? [
            `${reviewedSensitiveMetadataExceptions.length} packaged files contain exact hash-bound reviewed upstream path markers`,
          ]
        : []),
    ],
    dependencyMetadata: {
      path: DEPENDENCIES_PATH,
      bytes: dependencyBytes.length,
      sha256: sha256(dependencyBytes),
      parserFieldCount: dependencies.parserFieldCount,
      coordinateSetSha256: dependencies.coordinateSetSha256,
    },
    appMetadata: {
      path: APP_METADATA_PATH,
      bytes: appMetadataBytes.length,
      sha256: sha256(appMetadataBytes),
      properties: appMetadata,
    },
    dependencies: {
      libraries: dependencies.libraries,
      libraryDependencies: dependencies.libraryDependencies,
      modules: dependencies.modules,
      repositories: dependencies.repositories,
    },
    archiveFiles,
    sensitiveMetadataFindings,
    reviewedSensitiveMetadataExceptions,
    ...groups,
  };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--aab', '--run', '--output'].includes(name)) fail(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${name} requires a value`);
    if (result[name]) fail(`${name} may be specified only once`);
    result[name] = value;
    index += 1;
  }
  if (!result['--aab'] || !result['--run']) fail('--aab PATH and --run RUN_ID are required');
  return result;
}

function run() {
  const args = parseArguments(process.argv.slice(2));
  const inventory = buildAabInventory({
    aabPath: args['--aab'],
    runId: args['--run'],
  });
  const source = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args['--output']) {
    writeOutputAtomically(ROOT, args['--output'], source);
  } else {
    process.stdout.write(source);
  }
  const summary = inventory.summary;
  process.stderr.write(
    `AAB legal inventory passed: ${summary.archiveEntries} entries, ${summary.dependencyRecords} dependencies, ${summary.fonts} fonts, ${summary.models} models, ${summary.nativeLibraries} native libraries, ${summary.embeddedLegalFiles} embedded legal files; checkout relation ${inventory.localReleaseReceiptBinding.currentCheckout.relation}; complete legal coverage remains false.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
