#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const DL01_FIXTURE_TOKEN_ENV = 'GATOR_DL01_FIXTURE_TOKEN';
export const DL01_DEFAULT_PORT = 43_117;
export const DL01_MODES = Object.freeze([
  'false-smaller-length',
  'false-larger-length',
  'missing-length-eof',
  'chunked-finite',
  'chunked-endless',
  'stall',
  'delayed-deadline',
  'held-valid-image',
  'max-plus-one',
  'valid-max-image',
  'invalid-image',
  'oversized-dimensions',
  'valid-image',
]);
export const DL01_TARGETS = Object.freeze(['attachment', 'wallpaper']);
export const DL01_MAX_ATTACHMENT_COUNT = 16;
export const DL01_FIXTURE_SETS = Object.freeze(['dl01', 'feat07', 'notif01', 'notif03', 'feat05c']);
export const NOTIF03_STEPS = Object.freeze([
  'history-1',
  'history-pair',
  'history-4',
  'history-5',
  'history-6',
  'history-7',
  'late-unseen',
  'withdraw-middle',
  'resource-1',
  'resource-2',
  'resource-3',
  'resource-4',
  'resource-5',
  'resource-6',
]);
export const SEND01_FAILURE_STEPS = Object.freeze(['active-chat', 'other-chat', 'background']);
const SEND01_FAILURE_CHAT_GUID = 'iMessage;-;notif01-a@example.invalid';
const SEND01_FAILURE_DETAIL = 'The test server rejected this message. No message was delivered.';
const SEND01_HOLD_CAP_MS = 25_000;
export const FEAT07_DOCUMENT_COUNT = 52;
export const FEAT07_LARGE_PDF_BYTES = 6 * 1024 * 1024;

const MODE_SET = new Set(DL01_MODES);
const TARGET_SET = new Set(DL01_TARGETS);
const FIXTURE_SET = new Set(DL01_FIXTURE_SETS);
const API_PREFIX = '/api/v1';
const CONTROL_PREFIX = '/_dl01/v1';
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_TARGET_BYTES = 4 * 1024;
const MAX_HISTORY = 32;
const DEFAULT_REQUEST_READ_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_CAP_MS = 135_000;
const DEFAULT_ATTACHMENT_DEADLINE_DELAY_MS = 125_000;
const DEFAULT_WALLPAPER_DEADLINE_DELAY_MS = 65_000;
export const DL01_DEFAULT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const DL01_DEFAULT_WALLPAPER_MAX_BYTES = 10 * 1024 * 1024;
const FCM_ENCRYPTION_TYPE = 'AEAD_GCM_V3_IDENTITY';
const FCM_FRAME_MAX_BYTES = 4_096;
const FCM_EVENT_TYPE = 'new-message';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,62}$/;
const SCOPED_CREDENTIAL = /^bbd_device_v1_[A-Za-z0-9_-]{43}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const CANONICAL_EVENT_TYPE = /^[a-z][a-z0-9-]{0,63}$/;
const SERVER_INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const PUSH_IDENTITY = Object.freeze({
  serverInstallationId: SERVER_INSTALLATION_ID,
  principalId: PRINCIPAL_ID,
  deviceId: DEVICE_ID,
});
const HTTP_REASONS = Object.freeze({
  200: 'OK',
  201: 'Created',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
});

// A complete, tiny PNG that Android ImageDecoder accepts.
export const DL01_VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngWithDimensions(width, height) {
  const image = Buffer.from(DL01_VALID_PNG);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  image.writeUInt32BE(crc32(image.subarray(12, 29)), 29);
  return image;
}

function notificationAvatarPng() {
  const chunk = (kind, bytes) => {
    const type = Buffer.from(kind, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1_024, 0);
  header.writeUInt32BE(1_024, 4);
  header[8] = 8;
  header[9] = 6; // RGBA; a real decodable image, not the hostile IHDR-only fixture.
  const pixels = Buffer.alloc(1_024 * (1 + 1_024 * 4));
  for (let row = 0; row < 1_024; row += 1) {
    for (let col = 0; col < 1_024; col += 1) {
      const offset = row * (1 + 1_024 * 4) + 1 + col * 4;
      pixels[offset] = 30;
      pixels[offset + 1] = 160;
      pixels[offset + 2] = 90;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    DL01_VALID_PNG.subarray(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Both edges remain below the native 16,384 edge cap while their product exceeds the attachment
// 64-Mi-pixel cap (and therefore also the wallpaper 16-Mi-pixel cap).
export const DL01_OVERSIZED_DIMENSION_PNG = pngWithDimensions(8_193, 8_193);
const INVALID_IMAGE = Buffer.from('gator-dl01-not-an-image', 'ascii');

const PDF_PASSWORD_PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);

function pdfPasswordBytes(value) {
  const bytes = Buffer.from(value, 'latin1').subarray(0, 32);
  return bytes.length === 32
    ? bytes
    : Buffer.concat([bytes, PDF_PASSWORD_PADDING.subarray(0, 32 - bytes.length)]);
}

function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let swapIndex = 0;
  for (let index = 0; index < state.length; index += 1) {
    swapIndex = (swapIndex + state[index] + key[index % key.length]) & 0xff;
    [state[index], state[swapIndex]] = [state[swapIndex], state[index]];
  }
  const output = Buffer.alloc(input.length);
  let left = 0;
  let right = 0;
  for (let index = 0; index < input.length; index += 1) {
    left = (left + 1) & 0xff;
    right = (right + state[left]) & 0xff;
    [state[left], state[right]] = [state[right], state[left]];
    output[index] = input[index] ^ state[(state[left] + state[right]) & 0xff];
  }
  return output;
}

function assemblePdf(objects, trailerFields = '', paddingBytes = 0) {
  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks = [header];
  const offsets = [0];
  let offset = header.length;
  for (const [number, body] of objects) {
    if (number !== offsets.length) throw new Error('PDF fixture objects must be contiguous.');
    offsets.push(offset);
    const prefix = Buffer.from(`${number} 0 obj\n`, 'ascii');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    chunks.push(prefix, body, suffix);
    offset += prefix.length + body.length + suffix.length;
  }
  if (paddingBytes > 0) {
    const padding = Buffer.alloc(paddingBytes, 0x20);
    chunks.push(padding);
    offset += padding.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerFields} >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  chunks.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(chunks);
}

function simplePdfObjects(content) {
  return [
    [1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii')],
    [2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii')],
    [
      3,
      Buffer.from(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        'ascii',
      ),
    ],
    [
      4,
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'),
        content,
        Buffer.from('\nendstream', 'ascii'),
      ]),
    ],
    [5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')],
  ];
}

export function createFeat07Pdf(label = 'Gator FEAT-07 synthetic PDF') {
  if (typeof label !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/u.test(label)) {
    throw new Error('The FEAT-07 PDF label is invalid.');
  }
  const escaped = label.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const content = Buffer.from(`BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\n`, 'ascii');
  return assemblePdf(simplePdfObjects(content));
}

export function createExactLengthFeat07Pdf(totalBytes) {
  requireInteger(totalBytes, 'exact PDF byte length', 1_024, 512 * 1024 * 1024);
  const content = Buffer.from('BT /F1 18 Tf 72 720 Td (Gator FEAT-07 large PDF) Tj ET\n', 'ascii');
  let paddingBytes = Math.max(0, totalBytes - assemblePdf(simplePdfObjects(content)).length);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = assemblePdf(simplePdfObjects(content), '', paddingBytes);
    const difference = totalBytes - candidate.length;
    if (difference === 0) return candidate;
    paddingBytes += difference;
    if (paddingBytes < 0) break;
  }
  throw new Error('The exact FEAT-07 PDF length could not be constructed.');
}

export function createEncryptedFeat07Pdf(password = 'gator') {
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(password)) {
    throw new Error('The FEAT-07 PDF password is invalid.');
  }
  const userPassword = pdfPasswordBytes(password);
  const ownerPassword = pdfPasswordBytes('gator-owner');
  const ownerKey = createHash('md5').update(ownerPassword).digest().subarray(0, 5);
  const ownerEntry = rc4(ownerKey, userPassword);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const fileId = createHash('md5').update('gator-feat07-encrypted-pdf').digest();
  const fileKey = createHash('md5')
    .update(userPassword)
    .update(ownerEntry)
    .update(permissions)
    .update(fileId)
    .digest()
    .subarray(0, 5);
  const userEntry = rc4(fileKey, PDF_PASSWORD_PADDING);
  const plainContent = Buffer.from(
    'BT /F1 18 Tf 72 720 Td (Gator FEAT-07 encrypted PDF) Tj ET\n',
    'ascii',
  );
  const objectKey = createHash('md5')
    .update(fileKey)
    .update(Buffer.from([4, 0, 0, 0, 0]))
    .digest()
    .subarray(0, 10);
  const encryptedContent = rc4(objectKey, plainContent);
  const objects = simplePdfObjects(encryptedContent);
  objects.push([
    6,
    Buffer.from(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P -4 >>`,
      'ascii',
    ),
  ]);
  return assemblePdf(
    objects,
    ` /Encrypt 6 0 R /ID [<${fileId.toString('hex')}><${fileId.toString('hex')}>]`,
  );
}

/**
 * Return a structurally valid 1x1 PNG of exactly `totalBytes` bytes. The padding lives in a
 * private ancillary chunk before IEND, so it contributes to the transported file without
 * changing the decoded image or relying on trailing bytes after the PNG terminator.
 */
export function createExactLengthValidPng(totalBytes) {
  requireInteger(totalBytes, 'exact PNG byte length', DL01_VALID_PNG.length, 512 * 1024 * 1024);
  if (totalBytes === DL01_VALID_PNG.length) return Buffer.from(DL01_VALID_PNG);

  const addedBytes = totalBytes - DL01_VALID_PNG.length;
  if (addedBytes < 12) {
    throw new Error(
      `An exact PNG larger than the fixture image needs at least ${DL01_VALID_PNG.length + 12} bytes.`,
    );
  }
  const dataBytes = addedBytes - 12;
  const ancillaryChunk = Buffer.alloc(addedBytes);
  ancillaryChunk.writeUInt32BE(dataBytes, 0);
  ancillaryChunk.write('raNd', 4, 4, 'ascii');
  ancillaryChunk.writeUInt32BE(crc32(ancillaryChunk.subarray(4, 8 + dataBytes)), 8 + dataBytes);

  const iendOffset = DL01_VALID_PNG.length - 12;
  return Buffer.concat([
    DL01_VALID_PNG.subarray(0, iendOffset),
    ancillaryChunk,
    DL01_VALID_PNG.subarray(iendOffset),
  ]);
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requireAuthToken(value) {
  if (typeof value !== 'string' || !BEARER_TOKEN.test(value)) {
    throw new Error(
      `${DL01_FIXTURE_TOKEN_ENV} must be a 16-512 character bearer containing only URL-safe characters.`,
    );
  }
  return value;
}

function requireProjectId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) {
    throw new Error('The Firebase project id is invalid.');
  }
  return value;
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function statusLine(status) {
  return `HTTP/1.1 ${status} ${HTTP_REASONS[status] ?? 'Response'}\r\n`;
}

function responseHead(status, headers = {}) {
  const lines = [statusLine(status).trimEnd()];
  const combined = {
    Connection: 'close',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  for (const [name, value] of Object.entries(combined)) lines.push(`${name}: ${String(value)}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
}

function sendJson(socket, status, value, extraHeaders = {}) {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  socket.end(
    Buffer.concat([
      responseHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...extraHeaders,
      }),
      body,
    ]),
  );
}

function envelope(data, status = 200) {
  return { status, message: status >= 400 ? 'fixture request rejected' : 'success', data };
}

function sendApiError(socket, status) {
  sendJson(socket, status, envelope(null, status));
}

function parseJsonBody(request) {
  if (request.body.length === 0) return {};
  let value;
  try {
    value = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new FixtureHttpError(400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FixtureHttpError(400);
  }
  return value;
}

class FixtureHttpError extends Error {
  constructor(status) {
    super(`fixture HTTP ${status}`);
    this.status = status;
  }
}

function parseRequestHead(headerBytes) {
  const text = headerBytes.toString('latin1');
  const lines = text.split('\r\n');
  const requestLine = lines.shift();
  const match = /^(GET|POST) ([^\s]{1,4096}) HTTP\/1\.[01]$/.exec(requestLine ?? '');
  if (!match) throw new FixtureHttpError(400);
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new FixtureHttpError(400);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\0\r\n]/.test(value)) {
      throw new FixtureHttpError(400);
    }
    const prior = headers.get(name) ?? [];
    prior.push(value);
    headers.set(name, prior);
  }
  if ((headers.get('transfer-encoding')?.length ?? 0) !== 0) throw new FixtureHttpError(400);
  const lengths = headers.get('content-length') ?? [];
  if (lengths.length > 1) throw new FixtureHttpError(400);
  const rawLength = lengths[0] ?? '0';
  if (!/^\d+$/.test(rawLength)) throw new FixtureHttpError(400);
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new FixtureHttpError(413);
  }
  let url;
  try {
    url = new URL(match[2], 'http://fixture.invalid');
  } catch {
    throw new FixtureHttpError(400);
  }
  if (
    url.origin !== 'http://fixture.invalid' ||
    Buffer.byteLength(url.pathname) > MAX_TARGET_BYTES
  ) {
    throw new FixtureHttpError(400);
  }
  return { method: match[1], url, headers, contentLength };
}

function readOneRequest(socket, options, onRequest) {
  let buffer = Buffer.alloc(0);
  let parsed = null;
  let headerEnd = -1;
  let complete = false;
  socket.setTimeout(options.requestReadTimeoutMs, () => socket.destroy());
  socket.on('data', (chunk) => {
    if (complete) return;
    if (buffer.length + chunk.length > MAX_REQUEST_HEADER_BYTES + MAX_REQUEST_BODY_BYTES + 4) {
      complete = true;
      sendApiError(socket, 413);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    try {
      if (parsed === null) {
        headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          if (buffer.length > MAX_REQUEST_HEADER_BYTES) throw new FixtureHttpError(413);
          return;
        }
        if (headerEnd > MAX_REQUEST_HEADER_BYTES) throw new FixtureHttpError(413);
        parsed = parseRequestHead(buffer.subarray(0, headerEnd));
      }
      const expected = headerEnd + 4 + parsed.contentLength;
      if (buffer.length < expected) return;
      if (buffer.length !== expected) throw new FixtureHttpError(400);
      complete = true;
      socket.setTimeout(0);
      const request = {
        ...parsed,
        body: buffer.subarray(headerEnd + 4, expected),
      };
      void Promise.resolve(onRequest(request)).catch((error) =>
        sendApiError(socket, error instanceof FixtureHttpError ? error.status : 500),
      );
    } catch (error) {
      complete = true;
      sendApiError(socket, error instanceof FixtureHttpError ? error.status : 400);
    }
  });
}

function headerValue(request, name) {
  const values = request.headers.get(name);
  return values?.length === 1 ? values[0] : null;
}

function isAuthorized(request, token) {
  const header = headerValue(request, 'authorization');
  return typeof header === 'string' && constantTimeEqual(header, `Bearer ${token}`);
}

function boundedNumber(value, fallback, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function fixtureHandle(rcsPermissions) {
  return {
    originalROWID: 1,
    address: 'dl01-fixture@example.invalid',
    service: rcsPermissions ? 'RCS' : 'iMessage',
    country: null,
    uncanonicalizedId: null,
    color: '#336699',
    displayName: 'DL-01 Fixture',
  };
}

const FIXTURE_CONTACT_ID = 'dl01-fixture-contact';
const FIXTURE_CONTACT_ADDRESS = 'dl01-fixture@example.invalid';

function fixtureContact() {
  return {
    id: FIXTURE_CONTACT_ID,
    displayName: 'DL-01 Fixture',
    firstName: 'DL-01',
    lastName: 'Fixture',
    phoneNumbers: [],
    emails: [FIXTURE_CONTACT_ADDRESS],
    hasAvatar: true,
    avatarEtag: 'synthetic-v1',
  };
}

function createCase(generation, mode, target, now, attachmentCount = 1, rcsPermissions = false) {
  const chatGuid = rcsPermissions ? `RCS;-;dl01-chat-${generation}` : `dl01-chat-${generation}`;
  const messageGuid = `dl01-message-${generation}`;
  const attachmentGuid = `dl01-attachment-${generation}`;
  const handle = fixtureHandle(rcsPermissions);
  const chatSummary = {
    guid: chatGuid,
    originalROWID: generation,
    chatIdentifier: 'dl01-fixture@example.invalid',
    displayName: 'DL-01 Fixture',
    style: 45,
    isArchived: false,
    isPinned: false,
    muteType: null,
    participants: [handle],
    backgroundChannelGuid: target === 'wallpaper' ? `dl01-wallpaper-${generation}` : null,
  };
  const attachment = {
    originalROWID: generation,
    guid: attachmentGuid,
    uti: 'public.png',
    mimeType: 'image/png',
    transferName: 'dl01-fixture.png',
    // The metadata deliberately remains a small, eligible hint. Hostile modes independently lie
    // or stream past it so the native actual-byte boundary, rather than sync preflight, is tested.
    totalBytes: DL01_VALID_PNG.length,
    height: 1,
    width: 1,
    webUrl: null,
    hasLivePhoto: false,
    isSticker: false,
    hideAttachment: false,
    blurhash: null,
    metadata: null,
  };
  // Keep the original single-attachment payload byte-for-byte compatible. Extra entries use only
  // fields needed for an eligible PNG download, keeping a 16-attachment message inside the
  // authenticated FCM V3 frame bound.
  const attachments = Array.from({ length: attachmentCount }, (_, index) => {
    if (index === 0) return attachment;
    return {
      guid: `${attachmentGuid}-${index + 1}`,
      mimeType: 'image/png',
      totalBytes: DL01_VALID_PNG.length,
      height: 1,
      width: 1,
    };
  });
  const message = {
    originalROWID: generation,
    guid: messageGuid,
    text: null,
    subject: null,
    handleId: handle.originalROWID,
    handle,
    isFromMe: false,
    isSent: true,
    dateCreated: now + generation,
    hasAttachments: target === 'attachment',
    attachments: target === 'attachment' ? attachments : [],
    chats: [chatSummary],
    chatGuid,
  };
  const chat = { ...chatSummary, lastMessage: message, lastReadMessageGuid: null };
  return {
    generation,
    mode,
    target,
    chatGuid,
    messageGuid,
    attachmentGuid,
    attachmentGuids: attachments.map((candidate) => candidate.guid),
    attachmentCount: target === 'attachment' ? attachmentCount : 0,
    chat,
    message,
    downloadRequests: 0,
  };
}

const FEAT07_CHAT_GUID = 'iMessage;-;feat07-fixture@example.invalid';
const FEAT07_CONTACT_ADDRESS = 'feat07-fixture@example.invalid';

// Stable synthetic identities. NOTIF-01 is six arrivals or fixed A/B grouped withdrawals;
// NOTIF-03 is a fixed history/resource matrix.
// Neither mode opens Messages databases or sends to a recipient.
function createNotificationMessage(alias, rowId, dateCreated, seed = false, mode = 'notif01') {
  const chatRowId = alias === 'a' ? 1 : alias === 'b' ? 2 : 3;
  const address = `${mode}-${alias}@example.invalid`;
  const handle = {
    originalROWID: chatRowId,
    address,
    service: 'iMessage',
    country: null,
    uncanonicalizedId: null,
    color: '#336699',
    displayName: alias === 'c' ? '🧪'.repeat(130) : `Notification Test ${alias.toUpperCase()}`,
  };
  const chat = {
    guid: `iMessage;-;${address}`,
    originalROWID: chatRowId,
    chatIdentifier: address,
    displayName: handle.displayName,
    style: 45,
    isArchived: false,
    isPinned: false,
    muteType: null,
    participants: [handle],
    backgroundChannelGuid: null,
  };
  const message = {
    originalROWID: rowId,
    guid: `${mode}-message-${rowId}`,
    text: seed ? `Test chat ${alias.toUpperCase()} ready` : `Notification check ${rowId - 2}`,
    subject: null,
    handleId: handle.originalROWID,
    handle,
    isFromMe: seed,
    isSent: true,
    dateCreated,
    hasAttachments: false,
    attachments: [],
    chats: [chat],
    chatGuid: chat.guid,
  };
  return { message, chat: { ...chat, lastMessage: message, lastReadMessageGuid: null } };
}

function createNotificationFixture(now, mode) {
  const aliases = mode === 'notif03' ? ['a', 'b', 'c'] : ['a', 'b'];
  const seeds = aliases.map((alias, index) =>
    createNotificationMessage(alias, index + 1, now - (aliases.length - 1) + index, true, mode),
  );
  return {
    chats: new Map(seeds.map(({ chat }) => [chat.guid, chat])),
    messages: seeds.map(({ message }) => message),
    sending: false,
    deliveryHalted: false,
    step: 0,
    avatar: mode === 'notif03' ? notificationAvatarPng() : null,
    avatarRequests: 0,
  };
}

// Client-only search proof: fixed synthetic data, never a Messages database or a recipient send.
// Normal sync exposes only the seed. Canonical history reveals remote hits only after search.
function createSearchFixture(now, scenario) {
  const replacement = scenario === 'replacement';
  const prefix = replacement ? 'feat05c-replacement' : 'feat05c';
  const needle = replacement ? 'Replacementneedle' : 'Searchneedle';
  const definitions = [
    [
      'iMessage',
      `${prefix}-a@example.invalid`,
      `${replacement ? 'Replacement' : 'Search'} Fixture A`,
    ],
    [
      'SMS',
      replacement ? '+15550100503' : '+15550100502',
      `${replacement ? 'Replacement' : 'Search'} Fixture B`,
    ],
  ];
  const chats = definitions.map(([service, address, displayName], index) => ({
    guid: `${service};-;${address}`,
    originalROWID: index + 1,
    chatIdentifier: address,
    displayName,
    style: 45,
    isArchived: false,
    isPinned: false,
    muteType: null,
    backgroundChannelGuid: null,
    participants: [{ originalROWID: index + 1, address, service, displayName }],
  }));
  const messages = ['local duplicate', 'remote iMessage', 'remote SMS'].map((label, index) => {
    const chat = chats[index === 2 ? 1 : 0];
    const handle = chat.participants[0];
    return {
      originalROWID: index + 1,
      guid: `${prefix}-message-${index + 1}`,
      text: `${needle} ${label}`,
      subject: null,
      handleId: handle.originalROWID,
      handle,
      isFromMe: true,
      isSent: true,
      dateCreated: now - (3 - index) * 1_000,
      hasAttachments: false,
      attachments: [],
      chats: [chat],
      chatGuid: chat.guid,
    };
  });
  if (scenario === 'full') {
    messages[0].dateCreated = now - 800_000;
    messages[1].dateCreated = now - 700_000;
    messages[1].text = 'Anchorneedle remote iMessage';
    const add = (guid, text, dateCreated, chatIndex) => {
      const chat = chats[chatIndex];
      messages.push({
        ...messages[0],
        originalROWID: messages.length + 1,
        guid,
        text,
        dateCreated,
        handleId: chat.participants[0].originalROWID,
        handle: chat.participants[0],
        chats: [chat],
        chatGuid: chat.guid,
      });
    };
    for (let index = 0; index < 60; index += 1) {
      const suffix = String(index).padStart(3, '0');
      add(
        `feat05c-match-${suffix}`,
        `Searchneedle bounded ${suffix}`,
        now - 600_000 + Math.floor(index / 2) * 1_000,
        index % 2,
      );
    }
    for (let index = 0; index < 200; index += 1) {
      add(`feat05c-context-${index}`, `Context line ${index}`, now - 200_000 + index * 500, 0);
    }
    add('feat05c-held', 'Retireneedle account A held hit', now - 900_000, 0);
  }
  return {
    scenario,
    chats: chats.map((chat, index) => ({
      ...chat,
      lastMessage: index === 0 ? messages[0] : null,
      lastReadMessageGuid: null,
    })),
    messages,
    stage: 'supported',
    revealed: false,
    searchRequests: 0,
    successfulSearches: 0,
    failedSearches: 0,
    historyRequests: 0,
    holdNext: false,
    heldResponse: null,
    heldSearches: 0,
    heldClosed: 0,
    releasedSearches: 0,
  };
}

function notif03Events(proof, step, now) {
  if (step === 'withdraw-middle') {
    const target = proof.messages.find((message) => message.text === 'History line 4');
    if (!target) throw new FixtureHttpError(409);
    // The canonical query and encrypted update agree: re-opening cannot resurrect withdrawn text.
    target.dateRetracted = now;
    target.text = null;
    return [{ eventType: 'updated-message', payload: { guid: target.guid, dateRetracted: now } }];
  }
  const numbers =
    step === 'history-pair'
      ? [2, 3]
      : step === 'late-unseen'
        ? [0]
        : [Number(step.split('-').at(-1))];
  return numbers.map((number) => {
    const resource = step.startsWith('resource-');
    const rowId = proof.messages.length + 1;
    const dateCreated =
      step === 'late-unseen'
        ? proof.messages.find((message) => message.text === 'History line 1').dateCreated
        : Math.max(now, proof.messages.at(-1).dateCreated + 1);
    const { message, chat } = createNotificationMessage(
      resource ? 'c' : 'a',
      rowId,
      dateCreated,
      false,
      'notif03',
    );
    message.text = resource
      ? String.fromCodePoint(0x1f600 + number) + '🧪'.repeat(519)
      : step === 'late-unseen'
        ? 'Late unseen line'
        : `History line ${number}`;
    proof.messages.push(message);
    if (step !== 'late-unseen') proof.chats.set(chat.guid, chat);
    // Keep the 4KiB encrypted FCM envelope bounded; canonical REST supplies the seeded chat/handle.
    const payload = {
      guid: message.guid,
      originalROWID: rowId,
      dateCreated,
      text: message.text,
      handleId: message.handleId,
      handle: {
        originalROWID: message.handle.originalROWID,
        address: message.handle.address,
        service: message.handle.service,
      },
      chatGuid: message.chatGuid,
      isFromMe: false,
      isSent: true,
      hasAttachments: false,
    };
    return { eventType: 'new-message', payload };
  });
}

function feat07Attachment(alias, index, options) {
  const guid = `feat07-attachment-${String(index + 1).padStart(2, '0')}`;
  return {
    alias,
    guid,
    retryOnce: options.retryOnce === true,
    bytes: options.bytes,
    contentType: options.mimeType,
    transferName: options.transferName,
    requests: 0,
    failures: 0,
    bytesServed: 0,
    model: {
      originalROWID: 7_000 + index,
      guid,
      uti: options.uti,
      mimeType: options.mimeType,
      transferName: options.transferName,
      totalBytes: options.bytes.length,
      height: options.height ?? null,
      width: options.width ?? null,
      webUrl: null,
      hasLivePhoto: false,
      isSticker: false,
      hideAttachment: false,
      blurhash: null,
      metadata: null,
    },
  };
}

function feat07Message(asset, index, chatSummary, handle, now) {
  return {
    originalROWID: 8_000 - index,
    guid: `feat07-message-${String(index + 1).padStart(2, '0')}`,
    text: null,
    subject: null,
    handleId: handle.originalROWID,
    handle,
    isFromMe: false,
    isSent: true,
    dateCreated: now - index * 1_000,
    hasAttachments: true,
    attachments: [asset.model],
    chats: [chatSummary],
    chatGuid: FEAT07_CHAT_GUID,
  };
}

function createFeat07FixtureSet(now, videoBytes, largePdfBytes) {
  if (
    !Buffer.isBuffer(videoBytes) ||
    videoBytes.length < 12 ||
    videoBytes.length > 128 * 1024 * 1024 ||
    videoBytes.subarray(4, 8).toString('ascii') !== 'ftyp'
  ) {
    throw new Error('The FEAT-07 video must be a bounded MP4 file.');
  }
  requireInteger(largePdfBytes, 'FEAT-07 large PDF bytes', 1_024, 64 * 1024 * 1024);

  const assetSpecs = [
    {
      alias: 'video',
      bytes: Buffer.from(videoBytes),
      mimeType: 'video/mp4',
      transferName: 'feat07-video.mp4',
      uti: 'public.mpeg-4',
    },
    {
      alias: 'image-two',
      bytes: createExactLengthValidPng(128),
      mimeType: 'image/png',
      transferName: 'feat07-image-two.png',
      uti: 'public.png',
      width: 1,
      height: 1,
    },
    {
      alias: 'image-one',
      bytes: Buffer.from(DL01_VALID_PNG),
      mimeType: 'image/png',
      transferName: 'feat07-image-one.png',
      uti: 'public.png',
      width: 1,
      height: 1,
    },
    {
      alias: 'document-valid',
      bytes: createFeat07Pdf('Gator FEAT-07 valid document'),
      mimeType: 'application/pdf',
      transferName: '01-valid.pdf',
      uti: 'com.adobe.pdf',
    },
    {
      alias: 'document-retry',
      bytes: createFeat07Pdf('Gator FEAT-07 retry document'),
      mimeType: 'application/pdf',
      transferName: '02-retry.pdf',
      uti: 'com.adobe.pdf',
      retryOnce: true,
    },
    {
      alias: 'document-vcard',
      bytes: Buffer.from(
        'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Fixture;Gator FEAT-07;;;\r\nFN:Gator FEAT-07 Fixture\r\nEMAIL:feat07@example.invalid\r\nEND:VCARD\r\n',
        'utf8',
      ),
      mimeType: 'text/vcard',
      transferName: '03-contact.vcf',
      uti: 'public.vcard',
    },
    {
      alias: 'document-encrypted',
      bytes: createEncryptedFeat07Pdf(),
      mimeType: 'application/pdf',
      transferName: '04-encrypted-password-gator.pdf',
      uti: 'com.adobe.pdf',
    },
    {
      alias: 'document-malformed',
      bytes: Buffer.from(
        '%PDF-1.7\nGator FEAT-07 deliberately malformed document\n%%EOF\n',
        'ascii',
      ),
      mimeType: 'application/pdf',
      transferName: '05-malformed.pdf',
      uti: 'com.adobe.pdf',
    },
    {
      alias: 'document-large',
      bytes: createExactLengthFeat07Pdf(largePdfBytes),
      mimeType: 'application/pdf',
      transferName: '06-large.pdf',
      uti: 'com.adobe.pdf',
    },
    ...Array.from({ length: FEAT07_DOCUMENT_COUNT - 6 }, (_, index) => ({
      alias: `document-page-${String(index + 1).padStart(2, '0')}`,
      bytes: createFeat07Pdf(`Gator FEAT-07 page document ${String(index + 1).padStart(2, '0')}`),
      mimeType: 'application/pdf',
      transferName:
        index === FEAT07_DOCUMENT_COUNT - 7
          ? '52-oldest-page.pdf'
          : `${String(index + 7).padStart(2, '0')}-page.pdf`,
      uti: 'com.adobe.pdf',
    })),
  ];
  const assets = assetSpecs.map((spec, index) => feat07Attachment(spec.alias, index, spec));
  const handle = {
    originalROWID: 707,
    address: FEAT07_CONTACT_ADDRESS,
    service: 'iMessage',
    country: null,
    uncanonicalizedId: null,
    color: '#336699',
    displayName: 'FEAT-07 Fixture',
  };
  const chatSummary = {
    guid: FEAT07_CHAT_GUID,
    originalROWID: 707,
    chatIdentifier: FEAT07_CONTACT_ADDRESS,
    displayName: 'FEAT-07 Fixture',
    style: 45,
    isArchived: false,
    isPinned: false,
    muteType: null,
    participants: [handle],
    backgroundChannelGuid: null,
  };
  const messages = assets.map((asset, index) =>
    feat07Message(asset, index, chatSummary, handle, now),
  );
  const chat = { ...chatSummary, lastMessage: messages[0], lastReadMessageGuid: null };
  return {
    chat,
    messages,
    assets,
    assetsByGuid: new Map(assets.map((asset) => [asset.guid, asset])),
    documentCount: assets.filter(
      (asset) =>
        !asset.model.mimeType.startsWith('image/') && !asset.model.mimeType.startsWith('video/'),
    ).length,
  };
}

async function loadFeat07Video(configuration) {
  const supplied = configuration?.feat07VideoBytes;
  const path = configuration?.feat07VideoPath;
  if (supplied !== undefined && path !== undefined) {
    throw new Error('Provide FEAT-07 video bytes or a path, not both.');
  }
  if (supplied !== undefined) return Buffer.from(supplied);
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('The FEAT-07 fixture requires one local MP4 path.');
  }
  let file;
  try {
    file = await open(path, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 12 || metadata.size > 128 * 1024 * 1024) {
      throw new Error('invalid bounded MP4');
    }
    return await file.readFile();
  } catch {
    throw new Error('The FEAT-07 MP4 could not be read.');
  } finally {
    await file?.close();
  }
}

function socketLifetime(socket, milliseconds) {
  const timer = setTimeout(() => socket.destroy(), milliseconds);
  timer.unref?.();
  socket.once('close', () => clearTimeout(timer));
}

function beginTransfer(socket, state) {
  const transfer = {
    completed: false,
    held: false,
    releaseHeld: null,
    attempt(byteCount) {
      state.transferBytesAttempted += byteCount;
    },
    hold(releaseHeld) {
      if (this.held || this.completed || socket.destroyed) return false;
      this.held = true;
      this.releaseHeld = releaseHeld;
      state.heldTransfers.add(this);
      return true;
    },
    release() {
      if (!this.held) return false;
      this.held = false;
      state.heldTransfers.delete(this);
      const releaseHeld = this.releaseHeld;
      this.releaseHeld = null;
      releaseHeld?.();
      return true;
    },
  };
  state.transferStarted += 1;
  state.activeDownloadConnections += 1;
  socket.once('finish', () => {
    if (transfer.completed) return;
    transfer.completed = true;
    state.transferResponsesFinished += 1;
  });
  socket.once('close', () => {
    state.activeDownloadConnections = Math.max(0, state.activeDownloadConnections - 1);
    if (transfer.held) {
      transfer.held = false;
      transfer.releaseHeld = null;
      state.heldTransfers.delete(transfer);
    }
    if (!transfer.completed) state.transferClosedEarly += 1;
  });
  return transfer;
}

function chunkFrame(bytes) {
  return Buffer.concat([
    Buffer.from(`${bytes.length.toString(16)}\r\n`, 'ascii'),
    bytes,
    Buffer.from('\r\n', 'ascii'),
  ]);
}

function endChunked(socket) {
  if (!socket.destroyed) socket.end('0\r\n\r\n');
}

function sendFiniteChunks(socket, buffers, transfer) {
  for (const bytes of buffers) {
    if (bytes.length > 0) {
      transfer.attempt(bytes.length);
      socket.write(chunkFrame(bytes));
    }
  }
  endChunked(socket);
}

function pumpGeneratedChunks(socket, totalBytes, transfer, options = {}) {
  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const intervalMs = options.intervalMs ?? 0;
  let written = 0;
  let timer;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  socket.once('close', cleanup);
  const schedule = () => {
    if (socket.destroyed) return;
    if (written >= totalBytes) {
      socket.removeListener('close', cleanup);
      cleanup();
      endChunked(socket);
      return;
    }
    const count = Math.min(chunkBytes, totalBytes - written);
    const frame = chunkFrame(Buffer.alloc(count, 0x41));
    written += count;
    transfer.attempt(count);
    const continueWriting = () => {
      if (intervalMs > 0) timer = setTimeout(schedule, intervalMs);
      else setImmediate(schedule);
    };
    if (socket.write(frame)) continueWriting();
    else socket.once('drain', continueWriting);
  };
  schedule();
}

function serveDownload(socket, scenario, options, transfer) {
  const contentHeaders = { 'Content-Type': 'image/png' };
  const valid = DL01_VALID_PNG;
  switch (scenario.mode) {
    case 'false-smaller-length': {
      // Stop inside the image data, not merely before the optional trailing chunk. OkHttp obeys
      // the false fixed length and cannot observe the extra TCP bytes, so decoded-image validation
      // is what must reject the deliberately truncated representation.
      const declared = Math.max(1, Math.floor(valid.length / 2));
      transfer.attempt(valid.length);
      socket.end(
        Buffer.concat([
          responseHead(200, { ...contentHeaders, 'Content-Length': declared }),
          valid,
        ]),
      );
      return;
    }
    case 'false-larger-length':
      transfer.attempt(valid.length);
      socket.end(
        Buffer.concat([
          responseHead(200, { ...contentHeaders, 'Content-Length': valid.length + 17 }),
          valid,
        ]),
      );
      return;
    case 'missing-length-eof':
      transfer.attempt(valid.length);
      socket.end(Buffer.concat([responseHead(200, contentHeaders), valid]));
      return;
    case 'chunked-finite': {
      socket.write(responseHead(200, { ...contentHeaders, 'Transfer-Encoding': 'chunked' }));
      const first = Math.max(1, Math.floor(valid.length / 3));
      sendFiniteChunks(
        socket,
        [valid.subarray(0, first), valid.subarray(first, first * 2), valid.subarray(first * 2)],
        transfer,
      );
      return;
    }
    case 'chunked-endless': {
      socket.write(responseHead(200, { ...contentHeaders, 'Transfer-Encoding': 'chunked' }));
      socketLifetime(socket, options.connectionCapMs);
      const chunk = Buffer.alloc(64 * 1024, 0x45);
      let timer;
      const write = () => {
        if (socket.destroyed) return;
        const next = () => {
          timer = setTimeout(write, options.endlessChunkIntervalMs);
        };
        transfer.attempt(chunk.length);
        if (socket.write(chunkFrame(chunk))) next();
        else socket.once('drain', next);
      };
      socket.once('close', () => {
        if (timer !== undefined) clearTimeout(timer);
      });
      write();
      return;
    }
    case 'stall':
      socket.write(
        responseHead(200, { ...contentHeaders, 'Content-Length': DL01_VALID_PNG.length }),
      );
      socketLifetime(socket, options.connectionCapMs);
      return;
    case 'delayed-deadline': {
      socket.write(responseHead(200, { ...contentHeaders, 'Transfer-Encoding': 'chunked' }));
      transfer.attempt(8);
      socket.write(chunkFrame(valid.subarray(0, 8)));
      socketLifetime(socket, options.connectionCapMs);
      const delay =
        scenario.target === 'wallpaper'
          ? options.wallpaperDeadlineDelayMs
          : options.attachmentDeadlineDelayMs;
      const timer = setTimeout(() => {
        if (!socket.destroyed) sendFiniteChunks(socket, [valid.subarray(8)], transfer);
      }, delay);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
      return;
    }
    case 'max-plus-one': {
      const maximum =
        scenario.target === 'wallpaper' ? options.wallpaperMaxBytes : options.attachmentMaxBytes;
      socket.write(responseHead(200, { ...contentHeaders, 'Transfer-Encoding': 'chunked' }));
      socketLifetime(socket, options.connectionCapMs);
      pumpGeneratedChunks(socket, maximum + 1, transfer);
      return;
    }
    case 'held-valid-image': {
      socket.write(responseHead(200, { ...contentHeaders, 'Transfer-Encoding': 'chunked' }));
      socketLifetime(socket, options.connectionCapMs);
      transfer.hold(() => sendFiniteChunks(socket, [valid], transfer));
      return;
    }
    case 'valid-max-image': {
      const maximum =
        scenario.target === 'wallpaper' ? options.wallpaperMaxBytes : options.attachmentMaxBytes;
      const exact = createExactLengthValidPng(maximum);
      transfer.attempt(exact.length);
      socket.end(
        Buffer.concat([
          responseHead(200, { ...contentHeaders, 'Content-Length': exact.length }),
          exact,
        ]),
      );
      return;
    }
    case 'invalid-image':
      transfer.attempt(INVALID_IMAGE.length);
      socket.end(
        Buffer.concat([
          responseHead(200, { ...contentHeaders, 'Content-Length': INVALID_IMAGE.length }),
          INVALID_IMAGE,
        ]),
      );
      return;
    case 'oversized-dimensions':
      transfer.attempt(DL01_OVERSIZED_DIMENSION_PNG.length);
      socket.end(
        Buffer.concat([
          responseHead(200, {
            ...contentHeaders,
            'Content-Length': DL01_OVERSIZED_DIMENSION_PNG.length,
          }),
          DL01_OVERSIZED_DIMENSION_PNG,
        ]),
      );
      return;
    case 'valid-image':
      transfer.attempt(valid.length);
      socket.end(
        Buffer.concat([
          responseHead(200, { ...contentHeaders, 'Content-Length': valid.length }),
          valid,
        ]),
      );
      return;
    default:
      sendApiError(socket, 404);
  }
}

function requireCanonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function uuidBytes(value, label) {
  requireCanonicalUuid(value, label);
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function utf8Field(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`Invalid ${label}.`);
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > maximumBytes || bytes.toString('utf8') !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return bytes;
}

function taggedField(tag, bytes) {
  if (!Number.isInteger(tag) || tag < 1 || tag > 255 || bytes.length > 0xffff) {
    throw new Error('Invalid FCM identity field.');
  }
  const header = Buffer.alloc(3);
  header[0] = tag;
  header.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function timestampBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

/** Exact Node-side implementation of the documented GTRPUSH V3 identity AAD. */
export function encodeFcmPushIdentityV3(identity) {
  if (identity?.version !== 3) throw new Error('Invalid FCM identity version.');
  const eventType = utf8Field(identity.eventType, 'event type', 64);
  if (!CANONICAL_EVENT_TYPE.test(identity.eventType)) throw new Error('Invalid event type.');
  const hasMessage = identity.messageId !== undefined;
  const messageId = hasMessage
    ? utf8Field(identity.messageId, 'message id', 1_024)
    : Buffer.alloc(0);
  if (
    !Number.isSafeInteger(identity.issuedAt) ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.expiresAt <= identity.issuedAt ||
    identity.expiresAt - identity.issuedAt > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('Invalid FCM identity lifetime.');
  }
  return Buffer.concat([
    Buffer.from([0x47, 0x54, 0x52, 0x50, 0x55, 0x53, 0x48, 0x00, 0x03, 0x09]),
    taggedField(1, eventType),
    taggedField(2, uuidBytes(identity.serverInstallationId, 'server installation id')),
    taggedField(3, uuidBytes(identity.principalId, 'principal id')),
    taggedField(4, uuidBytes(identity.deviceId, 'device id')),
    taggedField(5, uuidBytes(identity.occurrenceId, 'occurrence id')),
    taggedField(6, Buffer.from([hasMessage ? 1 : 0])),
    taggedField(7, messageId),
    taggedField(8, timestampBytes(identity.issuedAt, 'issue time')),
    taggedField(9, timestampBytes(identity.expiresAt, 'expiry')),
  ]);
}

function decodePushKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid FCM push key.');
  }
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) {
    throw new Error('Invalid FCM push key.');
  }
  return key;
}

/** Build version | AAD length | AAD | IV | tag | ciphertext, in canonical standard base64. */
export function createFcmV3Frame({ identity, plaintext, key, iv = randomBytes(12) }) {
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new Error('Invalid FCM IV.');
  const aad = encodeFcmPushIdentityV3(identity);
  if (aad.length === 0 || aad.length > 0xffff) throw new Error('Invalid FCM AAD size.');
  const plaintextBytes = utf8Field(plaintext, 'plaintext', 3_000);
  const cipher = createCipheriv('aes-256-gcm', decodePushKey(key), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(aad.length);
  const frame = Buffer.concat([
    Buffer.from([0x03]),
    length,
    aad,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  if (frame.length > FCM_FRAME_MAX_BYTES) throw new Error('FCM V3 frame exceeds its bound.');
  return frame.toString('base64');
}

function gcloudAccessToken() {
  return new Promise((resolve, reject) => {
    execFile(
      'gcloud',
      ['auth', 'print-access-token'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('gcloud could not provide an access token.'));
          return;
        }
        const token = stdout.trim();
        if (!/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) {
          reject(new Error('gcloud returned an invalid access token.'));
          return;
        }
        resolve(token);
      },
    );
  });
}

function registrationAck(registration, body, now) {
  if (
    body.provider !== 'fcm' ||
    typeof body.token !== 'string' ||
    body.token.length < 1 ||
    body.token.length > 4_096 ||
    typeof body.name !== 'string' ||
    body.name.length < 1 ||
    body.name.length > 256
  ) {
    throw new FixtureHttpError(400);
  }
  const encryption = body.pushEncryption;
  if (
    !encryption ||
    typeof encryption !== 'object' ||
    Array.isArray(encryption) ||
    encryption.type !== FCM_ENCRYPTION_TYPE ||
    typeof encryption.key !== 'string'
  ) {
    throw new FixtureHttpError(400);
  }
  decodePushKey(encryption.key);

  const rotation = encryption.rotation;
  if (rotation === undefined) {
    if (registration.key !== encryption.key) {
      registration.key = encryption.key;
      registration.keyVersion = 1;
      registration.rotationId = null;
      registration.previousKeyExpiresAt = null;
    }
  } else {
    if (
      !rotation ||
      typeof rotation !== 'object' ||
      Array.isArray(rotation) ||
      !UUID_V4.test(rotation.id) ||
      !Number.isSafeInteger(rotation.previousKeyVersion) ||
      rotation.previousKeyVersion < 1
    ) {
      throw new FixtureHttpError(400);
    }
    const exactRetry =
      registration.rotationId === rotation.id && registration.key === encryption.key;
    if (!exactRetry) {
      if (
        registration.key === null ||
        rotation.previousKeyVersion !== registration.keyVersion ||
        registration.key === encryption.key
      ) {
        throw new FixtureHttpError(409);
      }
      registration.key = encryption.key;
      registration.keyVersion += 1;
      registration.rotationId = rotation.id;
      registration.previousKeyExpiresAt = now + 30 * 60 * 1_000;
    }
  }
  registration.token = body.token;
  return {
    id: DEVICE_ID,
    pushEncryptionType: FCM_ENCRYPTION_TYPE,
    pushEncryptionIdentity: PUSH_IDENTITY,
    pushEncryptionKeyVersion: registration.keyVersion,
    ...(registration.rotationId === null
      ? {}
      : {
          pushEncryptionRotationId: registration.rotationId,
          pushEncryptionPreviousKeyExpiresAt: registration.previousKeyExpiresAt,
        }),
  };
}

function clearRegistration(registration) {
  registration.token = null;
  registration.key = null;
  registration.keyVersion = 0;
  registration.rotationId = null;
  registration.previousKeyExpiresAt = null;
}

function publicStatus(state, firebaseProjectId) {
  if (state.search !== null) {
    const { stage, revealed, searchRequests, successfulSearches, failedSearches, historyRequests } =
      state.search;
    return {
      fixtureSet: 'feat05c',
      search: {
        scenario: state.search.scenario,
        stage,
        revealed,
        searchRequests,
        successfulSearches,
        failedSearches,
        historyRequests,
        heldSearches: state.search.heldSearches,
        heldClosed: state.search.heldClosed,
        releasedSearches: state.search.releasedSearches,
        heldPending: state.search.heldResponse !== null,
      },
      totals: {
        apiRequests: state.apiRequests,
        controlRequests: state.controlRequests,
        unauthorizedRequests: state.unauthorizedRequests,
        downloadRequests: state.downloadRequests,
        fcmSends: state.fcmSends,
      },
      fcm: { enabled: false, registrationReady: state.registration.token !== null },
    };
  }
  if (state.notification !== null) {
    return {
      fixtureSet: state.fixtureSet,
      chats: state.notification.chats.size,
      incomingMessages:
        state.notification.messages.length - (state.fixtureSet === 'notif03' ? 3 : 2),
      deliveryHalted: state.notification.deliveryHalted,
      ...(state.sendFailureProof === null
        ? {}
        : {
            sendFailureProof: {
              acceptedRequests: state.sendFailureProof.acceptedRequests,
              releasedResponses: state.sendFailureProof.releasedResponses,
              cancelledRequests: state.sendFailureProof.cancelledRequests,
              heldPending: state.sendFailureProof.heldResponse !== null,
              pendingStep: state.sendFailureProof.heldResponse?.step ?? null,
              nextStep: state.sendFailureProof.halted
                ? null
                : (SEND01_FAILURE_STEPS[state.sendFailureProof.acceptedRequests] ?? null),
              halted: state.sendFailureProof.halted,
            },
          }),
      ...(state.fixtureSet === 'notif03'
        ? {
            completedSteps: state.notification.step,
            nextStep: NOTIF03_STEPS[state.notification.step] ?? null,
            avatarRequests: state.notification.avatarRequests,
          }
        : {}),
      totals: {
        apiRequests: state.apiRequests,
        controlRequests: state.controlRequests,
        unauthorizedRequests: state.unauthorizedRequests,
        downloadRequests: state.downloadRequests,
        fcmSends: state.fcmSends,
      },
      fcm: {
        enabled: firebaseProjectId !== null,
        registrationReady: state.registration.token !== null && state.registration.key !== null,
      },
    };
  }
  if (state.feat07 !== null) {
    return {
      fixtureSet: 'feat07',
      feat07: {
        messages: state.feat07.messages.length,
        documents: state.feat07.documentCount,
        media: state.feat07.messages.length - state.feat07.documentCount,
        assets: state.feat07.assets.map((asset) => ({
          alias: asset.alias,
          requests: asset.requests,
          failures: asset.failures,
          bytesServed: asset.bytesServed,
        })),
      },
      totals: {
        apiRequests: state.apiRequests,
        controlRequests: state.controlRequests,
        unauthorizedRequests: state.unauthorizedRequests,
        downloadRequests: state.downloadRequests,
        activeDownloadConnections: state.activeDownloadConnections,
        fcmSends: state.fcmSends,
      },
      transfers: {
        started: state.transferStarted,
        bytesAttempted: state.transferBytesAttempted,
        responsesFinished: state.transferResponsesFinished,
        closedEarly: state.transferClosedEarly,
        held: state.heldTransfers.size,
      },
      fcm: { enabled: false, registrationReady: false },
    };
  }
  const current = state.current;
  return {
    scenario: {
      generation: current.generation,
      mode: current.mode,
      target: current.target,
      attachmentCount: current.attachmentCount,
      downloadRequests: current.downloadRequests,
    },
    totals: {
      apiRequests: state.apiRequests,
      controlRequests: state.controlRequests,
      unauthorizedRequests: state.unauthorizedRequests,
      downloadRequests: state.downloadRequests,
      activeDownloadConnections: state.activeDownloadConnections,
      fcmSends: state.fcmSends,
    },
    transfers: {
      started: state.transferStarted,
      bytesAttempted: state.transferBytesAttempted,
      responsesFinished: state.transferResponsesFinished,
      closedEarly: state.transferClosedEarly,
      held: state.heldTransfers.size,
    },
    fcm: {
      enabled: firebaseProjectId !== null,
      registrationReady: state.registration.token !== null && state.registration.key !== null,
    },
  };
}

async function sendCurrentFcm(
  state,
  options,
  message = state.current.message,
  eventType = FCM_EVENT_TYPE,
) {
  if (eventType !== 'new-message' && eventType !== 'updated-message')
    throw new FixtureHttpError(400);
  if (options.firebaseProjectId === null) throw new FixtureHttpError(503);
  const registration = state.registration;
  if (registration.token === null || registration.key === null) throw new FixtureHttpError(409);
  const enrollment = {
    token: registration.token,
    key: registration.key,
    keyVersion: registration.keyVersion,
  };
  const issuedAt = options.now();
  const identity = {
    version: 3,
    eventType,
    ...PUSH_IDENTITY,
    occurrenceId: options.randomUuid(),
    messageId: message.guid,
    issuedAt,
    expiresAt: issuedAt + 5 * 60 * 1_000,
  };
  const plaintext = JSON.stringify(message);
  const frame = createFcmV3Frame({
    identity,
    plaintext,
    key: enrollment.key,
    iv: options.randomBytes(12),
  });
  let accessToken;
  try {
    accessToken = await options.getAccessToken();
  } catch {
    throw new FixtureHttpError(503);
  }
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(accessToken)) {
    throw new FixtureHttpError(503);
  }
  if (
    !state.credentialActive ||
    registration.token !== enrollment.token ||
    registration.key !== enrollment.key ||
    registration.keyVersion !== enrollment.keyVersion
  ) {
    throw new FixtureHttpError(409);
  }
  let response;
  try {
    response = await options.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${options.firebaseProjectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          message: {
            token: enrollment.token,
            data: {
              type: eventType,
              data: frame,
              encrypted: 'true',
              encryptionType: FCM_ENCRYPTION_TYPE,
            },
            android: { priority: 'high' },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new FixtureHttpError(503);
  }
  try {
    if (!response || response.ok !== true) throw new FixtureHttpError(503);
  } finally {
    try {
      await response?.body?.cancel();
    } catch {
      // The status is authoritative; response-body cleanup is best effort and never logged.
    }
  }
  state.fcmSends += 1;
}

function requireMethod(request, method) {
  if (request.method !== method) throw new FixtureHttpError(405);
}

function cancelSendFailureProof(proof) {
  if (proof === null) return;
  proof.halted = true;
  const held = proof.heldResponse;
  if (held === null) return;
  proof.heldResponse = null;
  proof.cancelledRequests += 1;
  held.socket.destroy();
}

function releaseSendFailure(socket, proof) {
  proof.releasedResponses += 1;
  sendJson(socket, 400, {
    ...envelope(null, 400),
    error: { message: SEND01_FAILURE_DETAIL },
  });
}

function decodePathSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes('/') || decoded.includes('\0')) {
      throw new Error('invalid path segment');
    }
    return decoded;
  } catch {
    throw new FixtureHttpError(400);
  }
}

function responseCaseForChat(state, encodedGuid) {
  const guid = decodePathSegment(encodedGuid);
  return state.history.get(guid) ?? null;
}

function numericQuery(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function appendHistory(state, scenario) {
  state.history.set(scenario.chatGuid, scenario);
  while (state.history.size > MAX_HISTORY) {
    const oldest = state.history.keys().next().value;
    state.history.delete(oldest);
  }
}

function serveFeat07Download(socket, asset, state) {
  if (asset.retryOnce && asset.requests === 1) {
    asset.failures += 1;
    sendApiError(socket, 503);
    return;
  }
  const transfer = beginTransfer(socket, state);
  transfer.attempt(asset.bytes.length);
  asset.bytesServed += asset.bytes.length;
  socket.write(
    responseHead(200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.bytes.length,
    }),
  );
  socket.end(asset.bytes);
}

/**
 * Start a loopback-only raw HTTP fixture. It intentionally uses net.Server so responses may violate
 * HTTP body framing in ways node:http correctly refuses to generate.
 */
export async function startDl01FixtureServer(configuration) {
  const authToken = requireAuthToken(configuration?.authToken);
  const fixtureSet = configuration?.fixtureSet ?? 'dl01';
  if (!FIXTURE_SET.has(fixtureSet)) throw new Error('The fixture set is invalid.');
  if (
    configuration?.sendFailureProof !== undefined &&
    typeof configuration.sendFailureProof !== 'boolean'
  ) {
    throw new Error('The send failure proof option must be a boolean.');
  }
  const sendFailureProof = configuration?.sendFailureProof === true;
  if (sendFailureProof && fixtureSet !== 'notif01') {
    throw new Error('The send failure proof requires the NOTIF-01 fixture.');
  }
  const searchScenario = configuration?.searchScenario ?? 'basic';
  if (!['basic', 'full', 'replacement'].includes(searchScenario)) {
    throw new Error('The search scenario is invalid.');
  }
  if (
    configuration?.searchMessages !== undefined &&
    typeof configuration.searchMessages !== 'function'
  ) {
    throw new Error('The search provider must be a function.');
  }
  if (
    fixtureSet !== 'feat05c' &&
    (configuration?.searchScenario !== undefined || configuration?.searchMessages !== undefined)
  ) {
    throw new Error('Search options require the search fixture.');
  }
  const host = configuration?.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('The DL-01 fixture may bind only to a loopback address.');
  }
  const port = requireInteger(configuration?.port ?? 0, 'port', 0, 65_535);
  const firebaseProjectId = requireProjectId(configuration?.firebaseProjectId);
  if (sendFailureProof && firebaseProjectId !== null) {
    throw new Error('The send failure proof does not support outbound FCM.');
  }
  if (
    (fixtureSet === 'feat07' || fixtureSet === 'feat05c') &&
    (firebaseProjectId !== null || configuration?.rcsPermissions === true)
  ) {
    throw new Error('The document/search fixture does not support FCM or RCS options.');
  }
  if (
    (fixtureSet === 'notif01' || fixtureSet === 'notif03') &&
    configuration?.rcsPermissions === true
  ) {
    throw new Error('The notification fixture does not support RCS options.');
  }
  const options = {
    requestReadTimeoutMs: requireInteger(
      configuration?.requestReadTimeoutMs ?? DEFAULT_REQUEST_READ_TIMEOUT_MS,
      'request read timeout',
      10,
      60_000,
    ),
    connectionCapMs: requireInteger(
      configuration?.connectionCapMs ?? DEFAULT_CONNECTION_CAP_MS,
      'connection cap',
      20,
      20 * 60 * 1_000,
    ),
    attachmentDeadlineDelayMs: requireInteger(
      configuration?.attachmentDeadlineDelayMs ?? DEFAULT_ATTACHMENT_DEADLINE_DELAY_MS,
      'attachment deadline delay',
      1,
      20 * 60 * 1_000,
    ),
    wallpaperDeadlineDelayMs: requireInteger(
      configuration?.wallpaperDeadlineDelayMs ?? DEFAULT_WALLPAPER_DEADLINE_DELAY_MS,
      'wallpaper deadline delay',
      1,
      20 * 60 * 1_000,
    ),
    attachmentMaxBytes: requireInteger(
      configuration?.attachmentMaxBytes ?? DL01_DEFAULT_ATTACHMENT_MAX_BYTES,
      'attachment byte cap',
      1,
      512 * 1024 * 1024,
    ),
    wallpaperMaxBytes: requireInteger(
      configuration?.wallpaperMaxBytes ?? DL01_DEFAULT_WALLPAPER_MAX_BYTES,
      'wallpaper byte cap',
      1,
      512 * 1024 * 1024,
    ),
    endlessChunkIntervalMs: requireInteger(
      configuration?.endlessChunkIntervalMs ?? 5,
      'endless chunk interval',
      1,
      60_000,
    ),
    firebaseProjectId,
    rcsPermissions: configuration?.rcsPermissions === true,
    now: configuration?.now ?? Date.now,
    randomUuid: configuration?.randomUuid ?? randomUUID,
    randomBytes: configuration?.randomBytes ?? randomBytes,
    getAccessToken: configuration?.getAccessToken ?? gcloudAccessToken,
    fetchImpl: configuration?.fetchImpl ?? globalThis.fetch,
  };
  if (typeof options.fetchImpl !== 'function')
    throw new Error('A fetch implementation is required.');

  const feat07 =
    fixtureSet === 'feat07'
      ? createFeat07FixtureSet(
          options.now(),
          await loadFeat07Video(configuration),
          configuration?.feat07LargePdfBytes ?? FEAT07_LARGE_PDF_BYTES,
        )
      : null;
  const first = createCase(
    1,
    'valid-image',
    'attachment',
    options.now(),
    1,
    options.rcsPermissions,
  );
  const state = {
    fixtureSet,
    feat07,
    sendFailureProof: sendFailureProof
      ? {
          acceptedRequests: 0,
          releasedResponses: 0,
          cancelledRequests: 0,
          heldResponse: null,
          halted: false,
        }
      : null,
    search: fixtureSet === 'feat05c' ? createSearchFixture(options.now(), searchScenario) : null,
    notification:
      fixtureSet === 'notif01' || fixtureSet === 'notif03'
        ? createNotificationFixture(options.now(), fixtureSet)
        : null,
    generation: 1,
    current: first,
    history: new Map([[first.chatGuid, first]]),
    registration: {
      token: null,
      key: null,
      keyVersion: 0,
      rotationId: null,
      previousKeyExpiresAt: null,
    },
    credentialActive: true,
    apiRequests: 0,
    controlRequests: 0,
    unauthorizedRequests: 0,
    downloadRequests: 0,
    activeDownloadConnections: 0,
    fcmSends: 0,
    transferStarted: 0,
    transferBytesAttempted: 0,
    transferResponsesFinished: 0,
    transferClosedEarly: 0,
    heldTransfers: new Set(),
  };
  const sockets = new Set();

  const route = async (socket, request) => {
    const { pathname } = request.url;
    const controlRequest = pathname.startsWith(CONTROL_PREFIX);
    if (!isAuthorized(request, authToken) || (!state.credentialActive && !controlRequest)) {
      state.unauthorizedRequests += 1;
      sendJson(socket, 401, envelope(null, 401), { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    if (controlRequest) state.controlRequests += 1;
    else if (pathname.startsWith(API_PREFIX)) state.apiRequests += 1;

    if (pathname === `${CONTROL_PREFIX}/status`) {
      requireMethod(request, 'GET');
      sendJson(socket, 200, { ok: true, ...publicStatus(state, firebaseProjectId) });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/send01/release`) {
      const proof = state.sendFailureProof;
      if (proof === null) throw new FixtureHttpError(404);
      requireMethod(request, 'POST');
      if (!state.credentialActive) throw new FixtureHttpError(401);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 1 || !['other-chat', 'background'].includes(body.step)) {
        throw new FixtureHttpError(400);
      }
      const held = proof.heldResponse;
      if (proof.halted || held === null || held.step !== body.step) throw new FixtureHttpError(409);
      if (held.socket.destroyed) {
        cancelSendFailureProof(proof);
        throw new FixtureHttpError(409);
      }
      proof.heldResponse = null;
      releaseSendFailure(held.socket, proof);
      sendJson(socket, 200, { ok: true, released: 1 });
      return;
    }
    if (pathname === `${API_PREFIX}/message/text`) {
      const proof = state.sendFailureProof;
      if (proof === null) throw new FixtureHttpError(404);
      requireMethod(request, 'POST');
      if (
        proof.halted ||
        proof.heldResponse !== null ||
        proof.acceptedRequests >= SEND01_FAILURE_STEPS.length
      ) {
        throw new FixtureHttpError(409);
      }
      const body = parseJsonBody(request);
      const allowedKeys = new Set([
        'chatGuid',
        'tempGuid',
        'method',
        'text',
        'clientAttemptGeneration',
      ]);
      if (
        Object.keys(body).some((key) => !allowedKeys.has(key)) ||
        body.chatGuid !== SEND01_FAILURE_CHAT_GUID ||
        body.method !== 'apple-script' ||
        typeof body.tempGuid !== 'string' ||
        !/^temp-[a-z0-9]{8}$/.test(body.tempGuid) ||
        body.text !== `Send failure check ${proof.acceptedRequests + 1}` ||
        (Object.hasOwn(body, 'clientAttemptGeneration') &&
          (!Number.isSafeInteger(body.clientAttemptGeneration) ||
            body.clientAttemptGeneration < 1 ||
            body.clientAttemptGeneration > 2_147_483_647))
      ) {
        throw new FixtureHttpError(400);
      }
      const step = SEND01_FAILURE_STEPS[proof.acceptedRequests];
      proof.acceptedRequests += 1;
      if (step === 'active-chat') {
        releaseSendFailure(socket, proof);
      } else {
        // Retain only this response socket and a fixed step, never its message body or identifiers.
        const held = { socket, step };
        proof.heldResponse = held;
        socket.once('close', () => {
          if (proof.heldResponse === held) cancelSendFailureProof(proof);
        });
        socketLifetime(socket, Math.min(options.connectionCapMs, SEND01_HOLD_CAP_MS));
      }
      return;
    }
    if (
      pathname === `${CONTROL_PREFIX}/feat05c/hold` ||
      pathname === `${CONTROL_PREFIX}/feat05c/release-search`
    ) {
      requireMethod(request, 'POST');
      const proof = state.search;
      if (proof === null || proof.scenario !== 'full') throw new FixtureHttpError(404);
      if (Object.keys(parseJsonBody(request)).length !== 0) throw new FixtureHttpError(400);
      if (pathname.endsWith('/hold')) {
        if (
          !state.credentialActive ||
          proof.stage !== 'supported' ||
          proof.holdNext ||
          proof.heldSearches !== 0
        )
          throw new FixtureHttpError(409);
        proof.holdNext = true;
      } else {
        const held = proof.heldResponse;
        if (held === null) throw new FixtureHttpError(409);
        proof.heldResponse = null;
        proof.releasedSearches += 1;
        // Only the original account-A socket can receive its immutable admitted response.
        if (!held.socket.destroyed)
          sendJson(held.socket, 200, envelope({ messages: held.messages }));
      }
      sendJson(socket, 200, { ok: true });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/feat05c/stage`) {
      requireMethod(request, 'POST');
      const proof = state.search;
      if (proof === null) throw new FixtureHttpError(404);
      if (!state.credentialActive) throw new FixtureHttpError(401);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 1 || !['unavailable', 'old-server'].includes(body.stage)) {
        throw new FixtureHttpError(400);
      }
      const next = proof.stage === 'supported' ? 'unavailable' : 'old-server';
      if (proof.stage === 'old-server' || body.stage !== next) throw new FixtureHttpError(409);
      proof.stage = body.stage;
      sendJson(socket, 200, { ok: true, stage: proof.stage });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/notif01/send`) {
      requireMethod(request, 'POST');
      const proof = state.notification;
      if (proof === null || fixtureSet !== 'notif01') throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 1 || (body.chat !== 'a' && body.chat !== 'b')) {
        throw new FixtureHttpError(400);
      }
      if (firebaseProjectId === null) throw new FixtureHttpError(503);
      if (
        !state.credentialActive ||
        state.registration.token === null ||
        state.registration.key === null ||
        proof.sending ||
        proof.deliveryHalted ||
        proof.step !== 0 ||
        proof.messages.length >= 8
      ) {
        throw new FixtureHttpError(409);
      }
      proof.sending = true;
      try {
        const rowId = proof.messages.length + 1;
        const dateCreated = Math.max(options.now(), proof.messages.at(-1).dateCreated + 1);
        const { message, chat } = createNotificationMessage(body.chat, rowId, dateCreated);
        // Publish canonical history before delivery; background hydration sees the same payload.
        proof.messages.push(message);
        proof.chats.set(chat.guid, chat);
        await sendCurrentFcm(state, options, message);
        sendJson(socket, 200, { ok: true, chat: body.chat, check: rowId - 2, sent: true });
      } catch (error) {
        // An uncertain Google delivery must not be retried as a fresh message or counted as proof.
        proof.deliveryHalted = true;
        throw error;
      } finally {
        proof.sending = false;
      }
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/notif01/withdraw-grouped`) {
      requireMethod(request, 'POST');
      const proof = state.notification;
      if (proof === null || fixtureSet !== 'notif01') throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 1 || (body.chat !== 'a' && body.chat !== 'b')) {
        throw new FixtureHttpError(400);
      }
      if (firebaseProjectId === null) throw new FixtureHttpError(503);
      // Only initial A/check 1 then B/check 2 may enter the fixed A-then-B withdrawal lane.
      // No caller can select a GUID, rewrite text, or resume arrivals after withdrawal starts.
      if (
        !state.credentialActive ||
        state.registration.token === null ||
        state.registration.key === null ||
        proof.sending ||
        proof.deliveryHalted ||
        proof.messages.length !== 4 ||
        proof.messages[2]?.handleId !== 1 ||
        proof.messages[3]?.handleId !== 2 ||
        body.chat !== ['a', 'b'][proof.step]
      ) {
        throw new FixtureHttpError(409);
      }
      proof.sending = true;
      try {
        const target = proof.messages[proof.step + 2];
        const dateRetracted = Math.max(options.now(), target.dateCreated + 1);
        target.dateRetracted = dateRetracted;
        target.text = null;
        await sendCurrentFcm(
          state,
          options,
          { guid: target.guid, dateRetracted },
          'updated-message',
        );
        proof.step += 1;
        sendJson(socket, 200, { ok: true, chat: body.chat, withdrawn: true });
      } catch (error) {
        proof.deliveryHalted = true;
        throw error;
      } finally {
        proof.sending = false;
      }
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/notif03/step`) {
      requireMethod(request, 'POST');
      const proof = state.notification;
      if (proof === null || fixtureSet !== 'notif03') throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 1 || !NOTIF03_STEPS.includes(body.step))
        throw new FixtureHttpError(400);
      if (firebaseProjectId === null) throw new FixtureHttpError(503);
      if (
        !state.credentialActive ||
        state.registration.token === null ||
        state.registration.key === null ||
        proof.sending ||
        proof.deliveryHalted ||
        body.step !== NOTIF03_STEPS[proof.step]
      ) {
        throw new FixtureHttpError(409);
      }
      proof.sending = true;
      try {
        const events = notif03Events(proof, body.step, options.now());
        // Only the fixed pair overlaps delivery; operator calls themselves remain serialized.
        await Promise.all(
          events.map(({ payload, eventType }) =>
            sendCurrentFcm(state, options, payload, eventType),
          ),
        );
        proof.step += 1;
        sendJson(socket, 200, { ok: true, step: body.step, sends: events.length });
      } catch (error) {
        proof.deliveryHalted = true;
        throw error;
      } finally {
        proof.sending = false;
      }
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/scenario`) {
      requireMethod(request, 'POST');
      if (state.feat07 !== null || state.notification !== null || state.search !== null)
        throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (!MODE_SET.has(body.mode) || !TARGET_SET.has(body.target)) {
        throw new FixtureHttpError(400);
      }
      const attachmentCount = body.attachmentCount === undefined ? 1 : body.attachmentCount;
      if (
        !Number.isSafeInteger(attachmentCount) ||
        attachmentCount < 1 ||
        attachmentCount > DL01_MAX_ATTACHMENT_COUNT ||
        (body.target !== 'attachment' && body.attachmentCount !== undefined)
      ) {
        throw new FixtureHttpError(400);
      }
      state.generation += 1;
      state.current = createCase(
        state.generation,
        body.mode,
        body.target,
        options.now(),
        attachmentCount,
        options.rcsPermissions,
      );
      appendHistory(state, state.current);
      sendJson(socket, 200, {
        ok: true,
        scenario: {
          generation: state.current.generation,
          mode: state.current.mode,
          target: state.current.target,
          attachmentCount: state.current.attachmentCount,
        },
      });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/release-held`) {
      requireMethod(request, 'POST');
      if (state.feat07 !== null || state.notification !== null || state.search !== null)
        throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 0) throw new FixtureHttpError(400);
      let released = 0;
      for (const transfer of [...state.heldTransfers]) {
        if (transfer.release()) released += 1;
      }
      sendJson(socket, 200, { ok: true, released });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/fcm/send-current`) {
      requireMethod(request, 'POST');
      if (state.feat07 !== null || state.notification !== null || state.search !== null)
        throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 0) throw new FixtureHttpError(400);
      await sendCurrentFcm(state, options);
      sendJson(socket, 200, { ok: true, sent: true });
      return;
    }

    if (pathname === `${API_PREFIX}/server/info`) {
      requireMethod(request, 'GET');
      const scoped = state.feat07 === null && SCOPED_CREDENTIAL.test(authToken);
      sendJson(
        socket,
        200,
        envelope({
          server_version: '2.0.16',
          version: '2.0.16',
          private_api: false,
          supports_header_auth: true,
          supports_scoped_device_credentials: scoped,
          supports_fcm_device_encryption: scoped,
          supports_fcm_push_encryption_v3: scoped,
          supports_fcm_push_key_rotation: scoped,
          supports_repair_snapshot: false,
          supports_message_deleted: false,
          supports_message_search: state.search !== null && state.search.stage !== 'old-server',
          supports_message_part_topology: false,
          supports_error_log_upload: false,
          supports_url_preview_proxy: false,
          rcs: options.rcsPermissions,
        }),
      );
      return;
    }
    if (pathname === `${API_PREFIX}/ping`) {
      requireMethod(request, 'GET');
      sendJson(socket, 200, envelope({ pong: true }));
      return;
    }
    if (pathname === `${API_PREFIX}/devices`) {
      requireMethod(request, 'POST');
      if (state.feat07 !== null || !SCOPED_CREDENTIAL.test(authToken)) {
        throw new FixtureHttpError(409);
      }
      const ack = registrationAck(state.registration, parseJsonBody(request), options.now());
      sendJson(socket, 201, envelope(ack, 201));
      return;
    }
    if (pathname === `${API_PREFIX}/device-credentials/revoke-self`) {
      requireMethod(request, 'POST');
      if (!SCOPED_CREDENTIAL.test(authToken)) throw new FixtureHttpError(409);
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 0) throw new FixtureHttpError(400);
      // Queue the successful acknowledgement before invalidating the credential. This request has
      // already passed authentication and remains able to finish, while the synchronous state
      // transition below rejects every request routed afterward.
      sendJson(socket, 200, envelope({ revoked: true, deviceId: DEVICE_ID, deviceRemoved: true }));
      clearRegistration(state.registration);
      state.credentialActive = false;
      cancelSendFailureProof(state.sendFailureProof);
      return;
    }
    if (pathname === `${API_PREFIX}/chat/query`) {
      requireMethod(request, 'POST');
      const body = parseJsonBody(request);
      const offset = boundedNumber(body.offset, 0);
      const limit = boundedNumber(body.limit, 1, 1);
      const chat = state.feat07?.chat ?? state.current.chat;
      const chats =
        state.search?.chats ??
        (state.notification === null ? [chat] : [...state.notification.chats.values()]);
      sendJson(socket, 200, envelope({ chats: chats.slice(offset, offset + limit) }));
      return;
    }
    if (pathname === `${API_PREFIX}/message/query`) {
      requireMethod(request, 'POST');
      const body = parseJsonBody(request);
      if (state.feat07 !== null || state.notification !== null || state.search !== null) {
        const limit = boundedNumber(body.limit, 1_000, 1);
        const rowCursor = boundedNumber(body.afterRowId, 0);
        const timeCursor = boundedNumber(body.after, 0);
        const messages = [
          ...(state.search !== null
            ? state.search.messages.slice(0, 1)
            : (state.notification?.messages ?? state.feat07.messages)),
        ]
          .filter((message) =>
            body.afterRowId !== undefined
              ? message.originalROWID > rowCursor
              : message.dateCreated > timeCursor,
          )
          .sort((left, right) => left.originalROWID - right.originalROWID)
          .slice(0, limit);
        sendJson(socket, 200, envelope({ messages }));
      } else {
        const afterRowId = boundedNumber(body.afterRowId, 0);
        const afterTimestamp = boundedNumber(body.after, 0);
        const include =
          state.current.message.originalROWID > afterRowId &&
          (body.afterRowId !== undefined || state.current.message.dateCreated > afterTimestamp);
        sendJson(socket, 200, envelope({ messages: include ? [state.current.message] : [] }));
      }
      return;
    }

    if (pathname === `${API_PREFIX}/message/search/bounded`) {
      requireMethod(request, 'POST');
      const proof = state.search;
      if (proof === null) throw new FixtureHttpError(404);
      const body = parseJsonBody(request);
      if (
        Object.keys(body).length !== 2 ||
        typeof body.text !== 'string' ||
        body.text.length > 256 ||
        body.text !== body.text.normalize('NFC').trim() ||
        Array.from(body.text).length < 2 ||
        Array.from(body.text).length > 128 ||
        body.limit !== 50
      ) {
        throw new FixtureHttpError(400);
      }
      proof.searchRequests += 1;
      if (proof.stage !== 'supported') {
        proof.failedSearches += 1;
        throw new FixtureHttpError(proof.stage === 'old-server' ? 404 : 503);
      }
      const messages = configuration?.searchMessages
        ? await configuration.searchMessages(body.text)
        : proof.messages
            .filter((message) => message.text.toLowerCase().includes(body.text.toLowerCase()))
            .sort(
              (left, right) =>
                right.dateCreated - left.dateCreated ||
                (left.guid < right.guid ? -1 : left.guid > right.guid ? 1 : 0),
            )
            .slice(0, 50);
      // Fail closed on production-provider wire defects; never repair or truncate them.
      if (
        !Array.isArray(messages) ||
        messages.length > 50 ||
        messages.some((message) => {
          const canonical = proof.messages.find((row) => row.guid === message?.guid);
          return (
            !canonical ||
            message.chatGuid !== canonical.chatGuid ||
            !Array.isArray(message.chats) ||
            message.chats.length !== 1 ||
            message.chats[0]?.guid !== canonical.chatGuid
          );
        })
      )
        throw new FixtureHttpError(500);
      if (socket.destroyed || !state.credentialActive) return;
      proof.successfulSearches += 1;
      if (messages.some((message) => message.originalROWID > 1)) proof.revealed = true;
      if (proof.holdNext && body.text === 'Retireneedle') {
        proof.holdNext = false;
        proof.heldSearches += 1;
        proof.heldResponse = { socket, messages: structuredClone(messages) };
        socket.once('close', () => {
          proof.heldClosed += 1;
        });
        return;
      }
      sendJson(socket, 200, envelope({ messages }));
      return;
    }

    if (pathname === `${API_PREFIX}/contact/query`) {
      requireMethod(request, 'POST');
      const body = parseJsonBody(request);
      if (
        !Array.isArray(body.addresses) ||
        body.addresses.some((address) => typeof address !== 'string')
      ) {
        throw new FixtureHttpError(400);
      }
      const contacts =
        state.notification !== null
          ? [...state.notification.chats.values()]
              .filter((chat) => body.addresses.includes(chat.chatIdentifier))
              .map((chat) => ({
                id: `${fixtureSet}-contact-${chat.originalROWID}`,
                displayName: chat.displayName,
                firstName: 'Notification',
                lastName: `Test ${String.fromCharCode(64 + chat.originalROWID)}`,
                phoneNumbers: [],
                emails: [chat.chatIdentifier],
                hasAvatar: fixtureSet === 'notif03' && chat.originalROWID === 3,
                avatarEtag:
                  fixtureSet === 'notif03' && chat.originalROWID === 3 ? 'synthetic-v1' : null,
              }))
          : state.feat07 !== null && body.addresses.includes(FEAT07_CONTACT_ADDRESS)
            ? [
                {
                  id: 'feat07-fixture-contact',
                  displayName: 'FEAT-07 Fixture',
                  firstName: 'FEAT-07',
                  lastName: 'Fixture',
                  phoneNumbers: [],
                  emails: [FEAT07_CONTACT_ADDRESS],
                  hasAvatar: false,
                  avatarEtag: null,
                },
              ]
            : state.feat07 === null && body.addresses.includes(FIXTURE_CONTACT_ADDRESS)
              ? [fixtureContact()]
              : [];
      sendJson(socket, 200, envelope({ contacts }));
      return;
    }

    const contactAvatarMatch = /^\/api\/v1\/contact\/([^/]+)\/avatar$/.exec(pathname);
    if (contactAvatarMatch) {
      requireMethod(request, 'GET');
      const id = decodePathSegment(contactAvatarMatch[1]);
      if (fixtureSet === 'notif03' && id === 'notif03-contact-3') {
        const avatar = state.notification.avatar;
        state.notification.avatarRequests += 1;
        state.downloadRequests += 1;
        socket.end(
          Buffer.concat([
            responseHead(200, { 'Content-Type': 'image/png', 'Content-Length': avatar.length }),
            avatar,
          ]),
        );
        return;
      }
      if (state.feat07 !== null || state.notification !== null || state.search !== null) {
        sendApiError(socket, 404);
        return;
      }
      if (id !== FIXTURE_CONTACT_ID) {
        sendApiError(socket, 404);
        return;
      }
      socket.end(
        Buffer.concat([
          responseHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': DL01_VALID_PNG.length,
          }),
          DL01_VALID_PNG,
        ]),
      );
      return;
    }

    const attachmentMatch = /^\/api\/v1\/attachment\/([^/]+)\/download$/.exec(pathname);
    if (attachmentMatch) {
      requireMethod(request, 'GET');
      const guid = decodePathSegment(attachmentMatch[1]);
      const feat07Asset = state.feat07?.assetsByGuid.get(guid);
      if (feat07Asset) {
        feat07Asset.requests += 1;
        state.downloadRequests += 1;
        serveFeat07Download(socket, feat07Asset, state);
        return;
      }
      if (state.feat07 !== null || state.notification !== null || state.search !== null) {
        sendApiError(socket, 404);
        return;
      }
      const scenario = [...state.history.values()].find(
        (candidate) =>
          candidate.target === 'attachment' && candidate.attachmentGuids.includes(guid),
      );
      if (!scenario) {
        sendApiError(socket, 404);
        return;
      }
      scenario.downloadRequests += 1;
      state.downloadRequests += 1;
      const transfer = beginTransfer(socket, state);
      serveDownload(socket, scenario, options, transfer);
      return;
    }

    const backgroundMatch = /^\/api\/v1\/chat\/([^/]+)\/background$/.exec(pathname);
    if (backgroundMatch) {
      requireMethod(request, 'GET');
      if (state.feat07 !== null || state.notification !== null || state.search !== null) {
        sendApiError(socket, 404);
        return;
      }
      const scenario = responseCaseForChat(state, backgroundMatch[1]);
      if (!scenario || scenario.target !== 'wallpaper') {
        sendApiError(socket, 404);
        return;
      }
      scenario.downloadRequests += 1;
      state.downloadRequests += 1;
      const transfer = beginTransfer(socket, state);
      serveDownload(socket, scenario, options, transfer);
      return;
    }

    const chatMessagesMatch = /^\/api\/v1\/chat\/([^/]+)\/message$/.exec(pathname);
    if (chatMessagesMatch) {
      requireMethod(request, 'GET');
      const guid = decodePathSegment(chatMessagesMatch[1]);
      if (state.search !== null) {
        const proof = state.search;
        if (!proof.chats.some((chat) => chat.guid === guid)) throw new FixtureHttpError(404);
        proof.historyRequests += 1;
        const offset = numericQuery(request.url, 'offset', 0);
        const limit = numericQuery(request.url, 'limit', 100);
        const messages = proof.messages
          .filter(
            (message) =>
              message.chatGuid === guid && (proof.revealed || message.originalROWID === 1),
          )
          .sort((left, right) => right.dateCreated - left.dateCreated);
        sendJson(socket, 200, envelope({ messages: messages.slice(offset, offset + limit) }));
        return;
      }
      if (state.notification !== null) {
        if (!state.notification.chats.has(guid)) throw new FixtureHttpError(404);
        const offset = numericQuery(request.url, 'offset', 0);
        const limit = numericQuery(request.url, 'limit', 100);
        const messages = state.notification.messages.filter((message) => message.chatGuid === guid);
        sendJson(socket, 200, envelope({ messages: messages.slice(offset, offset + limit) }));
        return;
      }
      if (state.feat07 !== null && guid === FEAT07_CHAT_GUID) {
        const offset = numericQuery(request.url, 'offset', 0);
        const limit = numericQuery(request.url, 'limit', 100);
        sendJson(
          socket,
          200,
          envelope({ messages: state.feat07.messages.slice(offset, offset + limit) }),
        );
        return;
      }
      if (state.feat07 !== null) {
        sendApiError(socket, 404);
        return;
      }
      const scenario = responseCaseForChat(state, chatMessagesMatch[1]);
      if (!scenario) {
        sendApiError(socket, 404);
        return;
      }
      const offset = numericQuery(request.url, 'offset', 0);
      const limit = numericQuery(request.url, 'limit', 100);
      sendJson(
        socket,
        200,
        envelope({ messages: offset === 0 && limit > 0 ? [scenario.message] : [] }),
      );
      return;
    }

    const chatMatch = /^\/api\/v1\/chat\/([^/]+)$/.exec(pathname);
    if (chatMatch) {
      requireMethod(request, 'GET');
      const guid = decodePathSegment(chatMatch[1]);
      if (state.search !== null) {
        const chat = state.search.chats.find((candidate) => candidate.guid === guid);
        if (!chat) throw new FixtureHttpError(404);
        sendJson(socket, 200, envelope({ chat }));
        return;
      }
      if (state.notification !== null) {
        const chat = state.notification.chats.get(guid);
        if (!chat) throw new FixtureHttpError(404);
        sendJson(socket, 200, envelope({ chat }));
        return;
      }
      if (state.feat07 !== null && guid === FEAT07_CHAT_GUID) {
        sendJson(socket, 200, envelope({ chat: state.feat07.chat }));
        return;
      }
      if (state.feat07 !== null) {
        sendApiError(socket, 404);
        return;
      }
      const scenario = responseCaseForChat(state, chatMatch[1]);
      if (!scenario) {
        sendApiError(socket, 404);
        return;
      }
      sendJson(socket, 200, envelope({ chat: scenario.chat }));
      return;
    }

    sendApiError(socket, 404);
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once('close', () => sockets.delete(socket));
    readOneRequest(socket, options, (request) => route(socket, request));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The DL-01 fixture did not receive a TCP address.');
  }
  let closed = false;
  return Object.freeze({
    fixtureSet,
    host,
    port: address.port,
    origin: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    modes: DL01_MODES,
    targets: DL01_TARGETS,
    status: () => structuredClone(publicStatus(state, firebaseProjectId)),
    searchFixtureData: () =>
      state.search === null
        ? null
        : structuredClone({ chats: state.search.chats, messages: state.search.messages }),
    async close() {
      if (closed) return;
      closed = true;
      // Drop secret-bearing in-memory registration references before closing sockets.
      clearRegistration(state.registration);
      state.credentialActive = false;
      cancelSendFailureProof(state.sendFailureProof);
      if (state.search !== null) state.search.heldResponse = null;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

export function parseDl01FixtureArgs(argv) {
  const parsed = {
    port: DL01_DEFAULT_PORT,
    firebaseProjectId: null,
    rcsPermissions: false,
    fixtureSet: 'dl01',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--fixture-set' && value !== undefined && FIXTURE_SET.has(value)) {
      parsed.fixtureSet = value;
      index += 1;
    } else if (key === '--port' && value !== undefined) {
      parsed.port = requireInteger(Number(value), 'port', 1, 65_535);
      index += 1;
    } else if (key === '--firebase-project-id' && value !== undefined) {
      parsed.firebaseProjectId = requireProjectId(value);
      index += 1;
    } else if (key === '--rcs-permissions' && value === 'yes') {
      parsed.rcsPermissions = true;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${String(key)}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseDl01FixtureArgs(process.argv.slice(2));
  const token = requireAuthToken(process.env[DL01_FIXTURE_TOKEN_ENV]);
  const fixture = await startDl01FixtureServer({
    authToken: token,
    fixtureSet: args.fixtureSet,
    port: args.port,
    firebaseProjectId: args.firebaseProjectId,
    rcsPermissions: args.rcsPermissions,
  });
  const label =
    args.fixtureSet === 'dl01'
      ? 'DL-01'
      : args.fixtureSet === 'notif01'
        ? 'NOTIF-01'
        : args.fixtureSet === 'notif03'
          ? 'NOTIF-03'
          : args.fixtureSet === 'feat05c'
            ? 'FEAT-05C'
            : 'FEAT-07';
  process.stdout.write(`${label} fixture listening on ${fixture.origin}\n`);
  if (args.fixtureSet === 'dl01') {
    process.stdout.write(`Modes: ${fixture.modes.join(', ')}\n`);
    process.stdout.write(`Targets: ${fixture.targets.join(', ')}\n`);
  }
  process.stdout.write('The bearer credential is held in memory and is not printed.\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'DL-01 fixture failed.'}\n`);
    process.exitCode = 1;
  });
}
