#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

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

const MODE_SET = new Set(DL01_MODES);
const TARGET_SET = new Set(DL01_TARGETS);
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

// Both edges remain below the native 16,384 edge cap while their product exceeds the attachment
// 64-Mi-pixel cap (and therefore also the wallpaper 16-Mi-pixel cap).
export const DL01_OVERSIZED_DIMENSION_PNG = pngWithDimensions(8_193, 8_193);
const INVALID_IMAGE = Buffer.from('gator-dl01-not-an-image', 'ascii');

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

function fixtureHandle() {
  return {
    originalROWID: 1,
    address: 'dl01-fixture@example.invalid',
    service: 'iMessage',
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

function createCase(generation, mode, target, now, attachmentCount = 1) {
  const chatGuid = `dl01-chat-${generation}`;
  const messageGuid = `dl01-message-${generation}`;
  const attachmentGuid = `dl01-attachment-${generation}`;
  const handle = fixtureHandle();
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

async function sendCurrentFcm(state, options) {
  if (options.firebaseProjectId === null) throw new FixtureHttpError(503);
  const registration = state.registration;
  if (registration.token === null || registration.key === null) throw new FixtureHttpError(409);
  const scenario = state.current;
  const issuedAt = options.now();
  const identity = {
    version: 3,
    eventType: FCM_EVENT_TYPE,
    ...PUSH_IDENTITY,
    occurrenceId: options.randomUuid(),
    messageId: scenario.messageGuid,
    issuedAt,
    expiresAt: issuedAt + 5 * 60 * 1_000,
  };
  const plaintext = JSON.stringify(scenario.message);
  const frame = createFcmV3Frame({
    identity,
    plaintext,
    key: registration.key,
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
            token: registration.token,
            data: {
              type: FCM_EVENT_TYPE,
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

/**
 * Start a loopback-only raw HTTP fixture. It intentionally uses net.Server so responses may violate
 * HTTP body framing in ways node:http correctly refuses to generate.
 */
export async function startDl01FixtureServer(configuration) {
  const authToken = requireAuthToken(configuration?.authToken);
  const host = configuration?.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('The DL-01 fixture may bind only to a loopback address.');
  }
  const port = requireInteger(configuration?.port ?? 0, 'port', 0, 65_535);
  const firebaseProjectId = requireProjectId(configuration?.firebaseProjectId);
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
    now: configuration?.now ?? Date.now,
    randomUuid: configuration?.randomUuid ?? randomUUID,
    randomBytes: configuration?.randomBytes ?? randomBytes,
    getAccessToken: configuration?.getAccessToken ?? gcloudAccessToken,
    fetchImpl: configuration?.fetchImpl ?? globalThis.fetch,
  };
  if (typeof options.fetchImpl !== 'function')
    throw new Error('A fetch implementation is required.');

  const first = createCase(1, 'valid-image', 'attachment', options.now());
  const state = {
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
    if (pathname === `${CONTROL_PREFIX}/scenario`) {
      requireMethod(request, 'POST');
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
      const body = parseJsonBody(request);
      if (Object.keys(body).length !== 0) throw new FixtureHttpError(400);
      await sendCurrentFcm(state, options);
      sendJson(socket, 200, { ok: true, sent: true });
      return;
    }

    if (pathname === `${API_PREFIX}/server/info`) {
      requireMethod(request, 'GET');
      const scoped = SCOPED_CREDENTIAL.test(authToken);
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
          supports_message_search: false,
          supports_message_part_topology: false,
          supports_error_log_upload: false,
          supports_url_preview_proxy: false,
          rcs: false,
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
      if (!SCOPED_CREDENTIAL.test(authToken)) throw new FixtureHttpError(409);
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
      return;
    }
    if (pathname === `${API_PREFIX}/chat/query`) {
      requireMethod(request, 'POST');
      const body = parseJsonBody(request);
      const offset = boundedNumber(body.offset, 0);
      const limit = boundedNumber(body.limit, 1, 1);
      sendJson(
        socket,
        200,
        envelope({ chats: offset === 0 && limit > 0 ? [state.current.chat] : [] }),
      );
      return;
    }
    if (pathname === `${API_PREFIX}/message/query`) {
      requireMethod(request, 'POST');
      const body = parseJsonBody(request);
      const afterRowId = boundedNumber(body.afterRowId, 0);
      const afterTimestamp = boundedNumber(body.after, 0);
      const include =
        state.current.message.originalROWID > afterRowId &&
        (body.afterRowId !== undefined || state.current.message.dateCreated > afterTimestamp);
      sendJson(socket, 200, envelope({ messages: include ? [state.current.message] : [] }));
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
      const contacts = body.addresses.includes(FIXTURE_CONTACT_ADDRESS) ? [fixtureContact()] : [];
      sendJson(socket, 200, envelope({ contacts }));
      return;
    }

    const contactAvatarMatch = /^\/api\/v1\/contact\/([^/]+)\/avatar$/.exec(pathname);
    if (contactAvatarMatch) {
      requireMethod(request, 'GET');
      const id = decodePathSegment(contactAvatarMatch[1]);
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
    host,
    port: address.port,
    origin: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    modes: DL01_MODES,
    targets: DL01_TARGETS,
    status: () => structuredClone(publicStatus(state, firebaseProjectId)),
    async close() {
      if (closed) return;
      closed = true;
      // Drop secret-bearing in-memory registration references before closing sockets.
      clearRegistration(state.registration);
      state.credentialActive = false;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

export function parseDl01FixtureArgs(argv) {
  const parsed = { port: DL01_DEFAULT_PORT, firebaseProjectId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--port' && value !== undefined) {
      parsed.port = requireInteger(Number(value), 'port', 1, 65_535);
      index += 1;
    } else if (key === '--firebase-project-id' && value !== undefined) {
      parsed.firebaseProjectId = requireProjectId(value);
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
    port: args.port,
    firebaseProjectId: args.firebaseProjectId,
  });
  process.stdout.write(`DL-01 fixture listening on ${fixture.origin}\n`);
  process.stdout.write(`Modes: ${fixture.modes.join(', ')}\n`);
  process.stdout.write(`Targets: ${fixture.targets.join(', ')}\n`);
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
