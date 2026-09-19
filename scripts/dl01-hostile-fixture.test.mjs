import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createExactLengthValidPng,
  createFcmV3Frame,
  DL01_DEFAULT_ATTACHMENT_MAX_BYTES,
  DL01_DEFAULT_WALLPAPER_MAX_BYTES,
  DL01_MAX_ATTACHMENT_COUNT,
  DL01_MODES,
  DL01_OVERSIZED_DIMENSION_PNG,
  DL01_VALID_PNG,
  encodeFcmPushIdentityV3,
  startDl01FixtureServer,
} from './dl01-hostile-fixture.mjs';
import {
  parseDeviceBaseUrl,
  parseDl01CandidateArgs,
  parseDl01DeviceFixtureArgs,
  parseDownloadIntegrityUiSnapshot,
  parseDownloadIntegrityUiXml,
  parseInstalledPackageDump,
  verifyCandidateReceipts,
} from './run-dl01-device-fixture.mjs';

const AUTH_TOKEN = `bbd_device_v1_${'A'.repeat(43)}`;
const PUSH_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const FCM_TOKEN = 'memory-only-fcm-registration-token';
const ACCESS_TOKEN = `ya29.${'x'.repeat(40)}`;

function rawRequest(port, path, options = {}) {
  const method = options.method ?? 'GET';
  const body = Buffer.from(options.body ?? '', 'utf8');
  const authorization = options.authorization ?? AUTH_TOKEN;
  const request = Buffer.from(
    [
      `${method} ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${authorization}`,
      'Connection: close',
      `Content-Length: ${body.length}`,
      '',
      '',
    ].join('\r\n'),
    'ascii',
  );
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    }, 2_000);
    const finish = () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };
    socket.once('connect', () => socket.write(Buffer.concat([request, body])));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', finish);
    socket.once('close', () => {
      if (chunks.length > 0 && !socket.readableEnded) finish();
    });
    socket.once('error', (error) => {
      if (chunks.length > 0) finish();
      else {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

function splitResponse(response) {
  const boundary = response.indexOf('\r\n\r\n');
  assert.ok(boundary >= 0, 'response must contain a header boundary');
  const lines = response.subarray(0, boundary).toString('latin1').split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body: response.subarray(boundary + 4) };
}

function decodeChunks(body, requireTerminator = true) {
  const output = [];
  let offset = 0;
  let terminated = false;
  while (offset < body.length) {
    const end = body.indexOf('\r\n', offset);
    if (end < 0) break;
    const size = Number.parseInt(body.subarray(offset, end).toString('ascii'), 16);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    offset = end + 2;
    if (size === 0) {
      terminated = true;
      break;
    }
    if (offset + size + 2 > body.length) break;
    output.push(body.subarray(offset, offset + size));
    offset += size;
    assert.equal(body.subarray(offset, offset + 2).toString('ascii'), '\r\n');
    offset += 2;
  }
  if (requireTerminator) assert.equal(terminated, true);
  return { bytes: Buffer.concat(output), terminated };
}

async function control(fixture, path, body) {
  const response = await fetch(`${fixture.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  return { response, json };
}

async function waitForStatus(fixture, predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const status = await control(fixture, '/_dl01/v1/status');
    if (predicate(status.json)) return status.json;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('fixture status condition timed out');
}

function decryptV3Frame(frame, key) {
  const bytes = Buffer.from(frame, 'base64');
  assert.equal(bytes[0], 3);
  const aadLength = bytes.readUInt16BE(1);
  const aadStart = 3;
  const ivStart = aadStart + aadLength;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  const aad = bytes.subarray(aadStart, ivStart);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    bytes.subarray(ivStart, tagStart),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
  return {
    aad,
    plaintext: Buffer.concat([
      decipher.update(bytes.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString('utf8'),
  };
}

test('exact-cap fixture images remain complete PNGs at the production byte limits', () => {
  for (const byteLimit of [DL01_DEFAULT_ATTACHMENT_MAX_BYTES, DL01_DEFAULT_WALLPAPER_MAX_BYTES]) {
    const image = createExactLengthValidPng(byteLimit);
    assert.equal(image.length, byteLimit);
    assert.deepEqual(image.subarray(0, 8), DL01_VALID_PNG.subarray(0, 8));
    assert.equal(image.subarray(-8, -4).toString('ascii'), 'IEND');
    assert.equal(
      image.subarray(DL01_VALID_PNG.length - 8, DL01_VALID_PNG.length - 4).toString('ascii'),
      'raNd',
    );
  }
  assert.throws(() => createExactLengthValidPng(DL01_VALID_PNG.length + 1), /needs at least/);
});

test('DL-01 fixture exposes only authenticated synthetic sync and bounded hostile modes', async (t) => {
  const fcmCalls = [];
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    port: 0,
    firebaseProjectId: 'fixture-project',
    connectionCapMs: 90,
    attachmentDeadlineDelayMs: 40,
    wallpaperDeadlineDelayMs: 30,
    attachmentMaxBytes: 128,
    wallpaperMaxBytes: 160,
    endlessChunkIntervalMs: 1,
    getAccessToken: async () => ACCESS_TOKEN,
    fetchImpl: async (url, init) => {
      fcmCalls.push({ url, init });
      return new Response('{}', { status: 200 });
    },
  });
  t.after(() => fixture.close());

  await t.test('rejects missing auth and serves the minimal Gator envelopes', async () => {
    const unauthorized = await fetch(`${fixture.origin}/api/v1/server/info`);
    assert.equal(unauthorized.status, 401);

    const info = await control(fixture, '/api/v1/server/info');
    assert.equal(info.response.status, 200);
    assert.equal(info.json.data.supports_header_auth, true);
    assert.equal(info.json.data.supports_fcm_push_encryption_v3, true);
    assert.equal(info.json.data.supports_repair_snapshot, false);

    const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 200 });
    assert.equal(chats.json.data.chats.length, 1);
    const chat = chats.json.data.chats[0];
    assert.equal(chat.displayName, 'DL-01 Fixture');
    assert.equal(chat.lastMessage.attachments.length, 1);
    assert.match(chat.lastMessage.attachments[0].guid, /^dl01-attachment-/);

    const messages = await control(fixture, '/api/v1/message/query', {
      afterRowId: 0,
      limit: 250,
    });
    assert.equal(messages.json.data.messages[0].guid, chat.lastMessage.guid);
    assert.equal(JSON.stringify(messages.json).includes(AUTH_TOKEN), false);

    const contacts = await control(fixture, '/api/v1/contact/query', {
      addresses: ['dl01-fixture@example.invalid'],
    });
    assert.deepEqual(contacts.json.data.contacts, [
      {
        id: 'dl01-fixture-contact',
        displayName: 'DL-01 Fixture',
        firstName: 'DL-01',
        lastName: 'Fixture',
        phoneNumbers: [],
        emails: ['dl01-fixture@example.invalid'],
        hasAvatar: true,
        avatarEtag: 'synthetic-v1',
      },
    ]);
    const avatar = await fetch(
      `${fixture.origin}/api/v1/contact/dl01-fixture-contact/avatar?size=thumb`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), DL01_VALID_PNG);

    const invalidScenario = await control(fixture, '/_dl01/v1/scenario', {
      mode: 'not-a-fixture-mode',
      target: 'attachment',
    });
    assert.equal(invalidScenario.response.status, 400);
    assert.deepEqual(invalidScenario.json, {
      status: 400,
      message: 'fixture request rejected',
      data: null,
    });
  });

  await t.test('emits every transport/image mode with its exact framing contract', async () => {
    for (const mode of DL01_MODES) {
      const selected = await control(fixture, '/_dl01/v1/scenario', {
        mode,
        target: 'attachment',
      });
      assert.equal(selected.response.status, 200, mode);
      const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
      const attachment = chats.json.data.chats[0].lastMessage.attachments[0];
      const startedAt = Date.now();
      const pendingRaw = rawRequest(
        fixture.port,
        `/api/v1/attachment/${encodeURIComponent(attachment.guid)}/download`,
      );
      if (mode === 'held-valid-image') {
        await waitForStatus(fixture, (status) => status.transfers.held === 1);
        const unauthorizedRelease = await fetch(`${fixture.origin}/_dl01/v1/release-held`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(unauthorizedRelease.status, 401);
        assert.equal((await control(fixture, '/_dl01/v1/status')).json.transfers.held, 1);
        const released = await control(fixture, '/_dl01/v1/release-held', {});
        assert.deepEqual(released.json, { ok: true, released: 1 });
        const releasedAgain = await control(fixture, '/_dl01/v1/release-held', {});
        assert.deepEqual(releasedAgain.json, { ok: true, released: 0 });
      }
      const raw = await pendingRaw;
      const elapsed = Date.now() - startedAt;
      const response = splitResponse(raw);
      assert.equal(response.status, 200, mode);

      if (mode === 'false-smaller-length') {
        assert.ok(Number(response.headers.get('content-length')) < response.body.length);
      } else if (mode === 'false-larger-length') {
        assert.ok(Number(response.headers.get('content-length')) > response.body.length);
      } else if (mode === 'missing-length-eof') {
        assert.equal(response.headers.has('content-length'), false);
        assert.equal(response.headers.has('transfer-encoding'), false);
        assert.deepEqual(response.body, DL01_VALID_PNG);
      } else if (mode === 'chunked-finite') {
        assert.deepEqual(decodeChunks(response.body).bytes, DL01_VALID_PNG);
      } else if (mode === 'chunked-endless') {
        const decoded = decodeChunks(response.body, false);
        assert.equal(decoded.terminated, false);
        assert.ok(decoded.bytes.length > 0);
      } else if (mode === 'stall') {
        assert.equal(response.body.length, 0);
        assert.ok(elapsed >= 60);
      } else if (mode === 'delayed-deadline') {
        assert.deepEqual(decodeChunks(response.body).bytes, DL01_VALID_PNG);
        assert.ok(elapsed >= 25);
      } else if (mode === 'held-valid-image') {
        assert.deepEqual(decodeChunks(response.body).bytes, DL01_VALID_PNG);
      } else if (mode === 'max-plus-one') {
        assert.equal(decodeChunks(response.body).bytes.length, 129);
      } else if (mode === 'valid-max-image') {
        assert.equal(response.body.length, 128);
        assert.deepEqual(response.body, createExactLengthValidPng(128));
      } else if (mode === 'invalid-image') {
        assert.equal(response.body.subarray(0, 8).equals(DL01_VALID_PNG.subarray(0, 8)), false);
      } else if (mode === 'oversized-dimensions') {
        assert.deepEqual(response.body, DL01_OVERSIZED_DIMENSION_PNG);
        assert.equal(response.body.readUInt32BE(16), 8_193);
        assert.equal(response.body.readUInt32BE(20), 8_193);
      } else if (mode === 'valid-image') {
        assert.deepEqual(response.body, DL01_VALID_PNG);
      }
    }

    const status = await control(fixture, '/_dl01/v1/status');
    assert.equal(status.json.transfers.started, DL01_MODES.length);
    assert.ok(status.json.transfers.bytesAttempted >= 128);
    assert.equal(
      status.json.transfers.responsesFinished + status.json.transfers.closedEarly,
      DL01_MODES.length,
    );
    assert.ok(status.json.transfers.closedEarly >= 2);
    assert.equal(status.json.transfers.held, 0);
    assert.equal(JSON.stringify(status.json).includes('dl01-message-'), false);
  });

  await t.test('serves the selected mode through the wallpaper route too', async () => {
    await control(fixture, '/_dl01/v1/scenario', {
      mode: 'max-plus-one',
      target: 'wallpaper',
    });
    const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
    const chat = chats.json.data.chats[0];
    assert.match(chat.backgroundChannelGuid, /^dl01-wallpaper-/);
    assert.deepEqual(chat.lastMessage.attachments, []);
    const raw = await rawRequest(
      fixture.port,
      `/api/v1/chat/${encodeURIComponent(chat.guid)}/background`,
    );
    assert.equal(decodeChunks(splitResponse(raw).body).bytes.length, 161);

    await control(fixture, '/_dl01/v1/scenario', {
      mode: 'valid-max-image',
      target: 'wallpaper',
    });
    const exactChats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
    const exactChat = exactChats.json.data.chats[0];
    const exactRaw = await rawRequest(
      fixture.port,
      `/api/v1/chat/${encodeURIComponent(exactChat.guid)}/background`,
    );
    assert.deepEqual(splitResponse(exactRaw).body, createExactLengthValidPng(160));
  });

  await t.test(
    'keeps registration private and sends an exact V3 frame through injected FCM',
    async () => {
      await control(fixture, '/_dl01/v1/scenario', {
        mode: 'valid-image',
        target: 'attachment',
      });
      const registration = await control(fixture, '/api/v1/devices', {
        name: 'Fixture Android',
        provider: 'fcm',
        token: FCM_TOKEN,
        pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
      });
      assert.equal(registration.response.status, 201);
      assert.equal(registration.json.data.pushEncryptionKeyVersion, 1);
      assert.equal(
        registration.json.data.id,
        registration.json.data.pushEncryptionIdentity.deviceId,
      );

      const status = await control(fixture, '/_dl01/v1/status');
      assert.equal(status.json.fcm.registrationReady, true);
      const publicText = JSON.stringify(status.json);
      assert.equal(publicText.includes(FCM_TOKEN), false);
      assert.equal(publicText.includes(PUSH_KEY), false);
      assert.equal(publicText.includes(AUTH_TOKEN), false);

      const sent = await control(fixture, '/_dl01/v1/fcm/send-current', {});
      assert.equal(sent.response.status, 200);
      assert.deepEqual(sent.json, { ok: true, sent: true });
      assert.equal(fcmCalls.length, 1);
      assert.equal(fcmCalls[0].init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
      const outbound = JSON.parse(fcmCalls[0].init.body);
      assert.equal(outbound.message.token, FCM_TOKEN);
      assert.equal(outbound.message.data.encrypted, 'true');
      assert.equal(outbound.message.data.encryptionType, 'AEAD_GCM_V3_IDENTITY');
      const decrypted = decryptV3Frame(outbound.message.data.data, PUSH_KEY);
      const plaintext = JSON.parse(decrypted.plaintext);
      assert.match(plaintext.guid, /^dl01-message-/);
      assert.equal(plaintext.chatGuid, plaintext.chats[0].guid);
    },
  );

  await t.test(
    'seeds a bounded multi-attachment FCM scenario without exposing payloads',
    async () => {
      const selected = await control(fixture, '/_dl01/v1/scenario', {
        mode: 'valid-image',
        target: 'attachment',
        attachmentCount: DL01_MAX_ATTACHMENT_COUNT,
      });
      assert.equal(selected.response.status, 200);
      assert.equal(selected.json.scenario.attachmentCount, DL01_MAX_ATTACHMENT_COUNT);

      const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
      const attachments = chats.json.data.chats[0].lastMessage.attachments;
      assert.equal(attachments.length, DL01_MAX_ATTACHMENT_COUNT);
      assert.equal(
        new Set(attachments.map((attachment) => attachment.guid)).size,
        attachments.length,
      );

      const secondaryRaw = await rawRequest(
        fixture.port,
        `/api/v1/attachment/${encodeURIComponent(attachments.at(-1).guid)}/download`,
      );
      assert.deepEqual(splitResponse(secondaryRaw).body, DL01_VALID_PNG);

      const sent = await control(fixture, '/_dl01/v1/fcm/send-current', {});
      assert.deepEqual(sent.json, { ok: true, sent: true });
      assert.equal(fcmCalls.length, 2);
      const outbound = JSON.parse(fcmCalls.at(-1).init.body);
      const plaintext = JSON.parse(decryptV3Frame(outbound.message.data.data, PUSH_KEY).plaintext);
      assert.equal(plaintext.attachments.length, DL01_MAX_ATTACHMENT_COUNT);

      const status = await control(fixture, '/_dl01/v1/status');
      assert.equal(status.json.scenario.attachmentCount, DL01_MAX_ATTACHMENT_COUNT);
      const publicText = JSON.stringify(status.json);
      assert.equal(publicText.includes(plaintext.guid), false);
      assert.equal(publicText.includes(AUTH_TOKEN), false);

      const tooMany = await control(fixture, '/_dl01/v1/scenario', {
        mode: 'valid-image',
        target: 'attachment',
        attachmentCount: DL01_MAX_ATTACHMENT_COUNT + 1,
      });
      assert.equal(tooMany.response.status, 400);
      const wallpaperBatch = await control(fixture, '/_dl01/v1/scenario', {
        mode: 'valid-image',
        target: 'wallpaper',
        attachmentCount: 2,
      });
      assert.equal(wallpaperBatch.response.status, 400);
    },
  );

  await t.test(
    'self-revoke rejects app reuse while preserving authenticated proof controls',
    async () => {
      await control(fixture, '/_dl01/v1/scenario', {
        mode: 'held-valid-image',
        target: 'attachment',
      });
      const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
      const attachment = chats.json.data.chats[0].lastMessage.attachments[0];
      const pendingDownload = rawRequest(
        fixture.port,
        `/api/v1/attachment/${encodeURIComponent(attachment.guid)}/download`,
      );
      await waitForStatus(fixture, (status) => status.transfers.held === 1);

      const revoked = await control(fixture, '/api/v1/device-credentials/revoke-self', {});
      assert.equal(revoked.response.status, 200);
      assert.deepEqual(revoked.json, {
        status: 200,
        message: 'success',
        data: {
          revoked: true,
          deviceId: '33333333-3333-4333-8333-333333333333',
          deviceRemoved: true,
        },
      });
      const afterRevokeStatus = await control(fixture, '/_dl01/v1/status');
      assert.equal(afterRevokeStatus.response.status, 200);
      assert.equal(afterRevokeStatus.json.fcm.registrationReady, false);
      assert.equal(afterRevokeStatus.json.transfers.held, 1);
      assert.equal(JSON.stringify(afterRevokeStatus.json).includes(FCM_TOKEN), false);
      assert.equal(JSON.stringify(afterRevokeStatus.json).includes(PUSH_KEY), false);

      const released = await control(fixture, '/_dl01/v1/release-held', {});
      assert.deepEqual(released.json, { ok: true, released: 1 });
      assert.deepEqual(
        decodeChunks(splitResponse(await pendingDownload).body).bytes,
        DL01_VALID_PNG,
      );
      const settled = await waitForStatus(fixture, (status) => status.transfers.held === 0);
      assert.equal(settled.fcm.registrationReady, false);

      const rejectedAfterRevoke = await fetch(`${fixture.origin}/api/v1/server/info`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      assert.equal(rejectedAfterRevoke.status, 401);
    },
  );
});

test('V3 identity encoder matches the checked-in cross-runtime contract vector', () => {
  const identity = {
    version: 3,
    eventType: 'new-message',
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
    occurrenceId: '44444444-4444-4444-8444-444444444444',
    messageId: 'p:0/fixture-😀',
    issuedAt: 1_788_912_000_000,
    expiresAt: 1_788_912_300_000,
  };
  assert.equal(
    encodeFcmPushIdentityV3(identity).toString('base64'),
    'R1RSUFVTSAADCQEAC25ldy1tZXNzYWdlAgAQERERERERQRGBEREREREREQMAECIiIiIiIkIigiIiIiIiIiIEABAzMzMzMzNDM4MzMzMzMzMzBQAQRERERERERESERERERERERAYAAQEHABBwOjAvZml4dHVyZS3wn5iACAAIAAABoIN23AAJAAgAAAGgg3tv4A==',
  );
  const frame = createFcmV3Frame({
    identity,
    plaintext: '{"guid":"p:0/fixture-😀"}',
    key: PUSH_KEY,
    iv: Buffer.alloc(12, 0x3c),
  });
  assert.equal(decryptV3Frame(frame, PUSH_KEY).plaintext, '{"guid":"p:0/fixture-😀"}');
});

test('ADB runner requires one exact serial, package, and loopback base URL', () => {
  assert.deepEqual(
    parseDl01DeviceFixtureArgs([
      '--serial',
      'device-1234',
      '--package',
      'com.example.gator',
      '--base-url',
      'http://127.0.0.1:43117',
    ]),
    {
      serial: 'device-1234',
      packageName: 'com.example.gator',
      base: { origin: 'http://127.0.0.1:43117', port: 43_117 },
      firebaseProjectId: null,
    },
  );
  assert.throws(() => parseDl01DeviceFixtureArgs([]), /--serial/);
  assert.throws(
    () => parseDl01DeviceFixtureArgs(['--serial', 'x', '--package', 'com.x.app']),
    /--base-url/,
  );
  for (const unsafe of [
    'http://0.0.0.0:43117',
    'http://127.0.0.1:43117/path',
    'http://user@127.0.0.1:43117',
    'https://127.0.0.1:43117',
  ]) {
    assert.throws(() => parseDeviceBaseUrl(unsafe), /exact http/);
  }
});

test('candidate parser normalizes exact provenance inputs and rejects unsafe ambiguity', () => {
  const sha = 'A'.repeat(64);
  const commit = 'B'.repeat(40);
  const argv = [
    '--serial',
    'emulator-5556',
    '--package',
    'com.example.gator',
    '--expected-version',
    '0.1.54',
    '--expected-code',
    '74',
    '--expected-min-sdk',
    '36',
    '--expected-target-sdk',
    '36',
    '--expected-api',
    '37',
    '--expected-installer',
    'none',
    '--expected-play-cert-sha256',
    sha,
    '--expected-aab-sha256',
    sha,
    '--expected-source-commit',
    commit,
    '--require-qemu',
    'yes',
    '--aab',
    '/private/tmp/candidate.aab',
    '--validation-receipt',
    '/private/tmp/validation.json',
    '--promotion-receipt',
    '/private/tmp/promotion.json',
    '--state-receipt',
    '/private/tmp/state.json',
    '--submission-recovery-receipt',
    '/private/tmp/submission-recovery.json',
    '--apksigner',
    '/private/tmp/apksigner',
  ];
  const parsed = parseDl01CandidateArgs(argv, { diagnostics: true });
  assert.deepEqual(
    {
      serial: parsed.serial,
      packageName: parsed.packageName,
      expectedVersion: parsed.expectedVersion,
      expectedCode: parsed.expectedCode,
      expectedMinSdk: parsed.expectedMinSdk,
      expectedTargetSdk: parsed.expectedTargetSdk,
      expectedApi: parsed.expectedApi,
      expectedInstaller: parsed.expectedInstaller,
      expectedPlayCertificateSha256: parsed.expectedPlayCertificateSha256,
      expectedAabSha256: parsed.expectedAabSha256,
      expectedSourceCommit: parsed.expectedSourceCommit,
      requireQemu: parsed.requireQemu,
      submissionRecoveryReceiptPath: parsed.submissionRecoveryReceiptPath,
      scrolls: parsed.scrolls,
    },
    {
      serial: 'emulator-5556',
      packageName: 'com.example.gator',
      expectedVersion: '0.1.54',
      expectedCode: 74,
      expectedMinSdk: 36,
      expectedTargetSdk: 36,
      expectedApi: 37,
      expectedInstaller: null,
      expectedPlayCertificateSha256: sha.toLowerCase(),
      expectedAabSha256: sha.toLowerCase(),
      expectedSourceCommit: commit.toLowerCase(),
      requireQemu: true,
      submissionRecoveryReceiptPath: '/private/tmp/submission-recovery.json',
      scrolls: 8,
    },
  );
  assert.throws(() => parseDl01CandidateArgs([...argv, '--serial', 'other-device']), /repeated/);
  assert.throws(
    () =>
      parseDl01CandidateArgs(
        argv.map((value, index) => (argv[index - 1] === '--require-qemu' ? 'maybe' : value)),
      ),
    /must be yes or no/,
  );
});

test('candidate receipts accept only a strictly bound direct submission recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gator-dl01-recovery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    ['aab', 'validation', 'promotion', 'state', 'recovery'].map((name) => [
      name,
      join(directory, `${name}.${name === 'aab' ? 'aab' : 'json'}`),
    ]),
  );
  const aabBytes = Buffer.from('frozen-candidate-aab');
  const aabSha256 = createHash('sha256').update(aabBytes).digest('hex');
  const runId = 'android-0.1.55-abcdef0-20260918055448';
  const sourceCommit = 'a'.repeat(40);
  const releaseCommit = 'b'.repeat(40);
  const artifactFilename = `gator-release-0.1.55-v75-${releaseCommit.slice(0, 7)}.aab`;
  const submissionId = '8953c1c0-79f1-463a-a3cf-1ff1b49f46b5';
  const validation = {
    runId,
    applicationId: 'com.example.gator',
    versionName: '0.1.55',
    versionCode: 75,
    sourceCommit,
    artifact: {
      bytes: aabBytes.length,
      sha256: aabSha256,
      uploadCertificateSha256: 'c'.repeat(64),
    },
    validation: { status: 'passed' },
  };
  const promotion = {
    runId,
    sourceCommit,
    targetVersion: '0.1.55',
    versionCode: 75,
    sha256: aabSha256,
    commit: releaseCommit,
    artifactFilename,
  };
  const state = {
    schemaVersion: 1,
    runId,
    phase: 'submission_unknown',
    source: { commit: sourceCommit },
    target: {
      version: '0.1.55',
      platform: 'android',
      track: 'internal',
      applicationId: 'com.example.gator',
    },
    artifact: {
      filename: artifactFilename,
      applicationId: 'com.example.gator',
      versionName: '0.1.55',
      versionCode: 75,
      bytes: aabBytes.length,
      sha256: aabSha256,
    },
    toolchain: { easCli: '21.5.0' },
    promotion: { status: 'promoted', commit: releaseCommit, artifactFilename },
    submission: {
      schemaVersion: 1,
      runId,
      status: 'unknown',
      track: 'internal',
      exitCode: 1,
      signal: null,
      processGroupId: 1234,
      completedAt: '2026-09-18T06:24:20.912Z',
    },
  };
  await Promise.all([
    writeFile(paths.aab, aabBytes),
    writeFile(paths.validation, `${JSON.stringify(validation)}\n`),
    writeFile(paths.promotion, `${JSON.stringify(promotion)}\n`),
    writeFile(paths.state, `${JSON.stringify(state)}\n`),
  ]);
  const stateSha256 = createHash('sha256')
    .update(`${JSON.stringify(state)}\n`)
    .digest('hex');
  const recovery = {
    schemaVersion: 1,
    kind: 'direct-play-submission-recovery',
    runId,
    preservedStateSha256: stateSha256,
    sourceCommit,
    releaseCommit,
    applicationId: 'com.example.gator',
    versionName: '0.1.55',
    versionCode: 75,
    artifact: { filename: artifactFilename, bytes: aabBytes.length, sha256: aabSha256 },
    directSubmission: {
      cliVersion: '21.5.0',
      artifactSelection: 'explicit-path',
      submissionId,
      platform: 'ANDROID',
      status: 'FINISHED',
      error: null,
      track: 'internal',
      releaseStatus: 'COMPLETED',
      createdAt: '2026-09-18T06:28:02.540Z',
      completedAt: '2026-09-18T06:29:35.118Z',
    },
    playReadback: {
      applicationId: 'com.example.gator',
      track: 'internal',
      releaseName: '0.1.55',
      versionCode: 75,
      status: 'completed',
      observedAt: '2026-09-18T06:38:49.590Z',
    },
  };
  const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(paths.recovery, canonicalJson(recovery));
  const args = {
    packageName: 'com.example.gator',
    expectedVersion: '0.1.55',
    expectedCode: 75,
    expectedAabSha256: aabSha256,
    expectedSourceCommit: sourceCommit,
    aabPath: paths.aab,
    validationReceiptPath: paths.validation,
    promotionReceiptPath: paths.promotion,
    stateReceiptPath: paths.state,
    submissionRecoveryReceiptPath: paths.recovery,
  };

  const verified = await verifyCandidateReceipts(args);
  assert.equal(verified.phase, 'submission_unknown');
  assert.equal(verified.submissionEvidence, 'direct_recovery');
  assert.equal(verified.recoverySubmissionId, submissionId);
  await assert.rejects(
    verifyCandidateReceipts({ ...args, submissionRecoveryReceiptPath: null }),
    /requires a recovery receipt/,
  );
  const rejectedRecoveries = [
    ['state hash', { ...recovery, preservedStateSha256: 'd'.repeat(64) }],
    ['extra key', { ...recovery, unexpected: true }],
    [
      'EAS identifier',
      {
        ...recovery,
        directSubmission: { ...recovery.directSubmission, submissionId: 'not-a-uuid' },
      },
    ],
    [
      'EAS status',
      { ...recovery, directSubmission: { ...recovery.directSubmission, status: 'ERRORED' } },
    ],
    [
      'EAS error',
      { ...recovery, directSubmission: { ...recovery.directSubmission, error: 'failed' } },
    ],
    [
      'EAS platform',
      { ...recovery, directSubmission: { ...recovery.directSubmission, platform: 'IOS' } },
    ],
    [
      'reversed time',
      {
        ...recovery,
        directSubmission: {
          ...recovery.directSubmission,
          createdAt: '2026-09-18T06:30:00.000Z',
        },
      },
    ],
    ['candidate version', { ...recovery, versionName: '0.1.56' }],
    ['artifact hash', { ...recovery, artifact: { ...recovery.artifact, sha256: 'e'.repeat(64) } }],
    [
      'Play version code',
      { ...recovery, playReadback: { ...recovery.playReadback, versionCode: 74 } },
    ],
    ['Play status', { ...recovery, playReadback: { ...recovery.playReadback, status: 'draft' } }],
  ];
  for (const [label, candidate] of rejectedRecoveries) {
    await writeFile(paths.recovery, canonicalJson(candidate));
    await assert.rejects(
      verifyCandidateReceipts(args),
      /recovery receipt is missing or invalid/,
      label,
    );
  }
  await writeFile(
    paths.recovery,
    `${canonicalJson(recovery).trimEnd().slice(0, -1)},\n  "schemaVersion": 1\n}\n`,
  );
  await assert.rejects(verifyCandidateReceipts(args), /not canonical JSON/);
  await writeFile(paths.recovery, canonicalJson(recovery));
  const promotedState = {
    ...state,
    phase: 'promoted',
    submission: { status: 'not_started' },
  };
  await writeFile(paths.state, `${JSON.stringify(promotedState)}\n`);
  assert.equal(
    (
      await verifyCandidateReceipts({
        ...args,
        submissionRecoveryReceiptPath: null,
      })
    ).submissionEvidence,
    'not_started',
  );
  await assert.rejects(verifyCandidateReceipts(args), /must not have a recovery receipt/);
  const submittedState = {
    ...state,
    phase: 'submitted',
    submission: {
      schemaVersion: 1,
      runId,
      status: 'submitted',
      track: 'internal',
      artifactFilename,
      sha256: aabSha256,
      completedAt: '2026-09-18T06:29:35.118Z',
    },
  };
  await writeFile(paths.state, `${JSON.stringify(submittedState)}\n`);
  assert.equal(
    (
      await verifyCandidateReceipts({
        ...args,
        submissionRecoveryReceiptPath: null,
      })
    ).submissionEvidence,
    'runner',
  );
  await assert.rejects(verifyCandidateReceipts(args), /must not have a recovery receipt/);
});

test('installed package parser extracts only the exact Android identity', () => {
  const output = `
    Package [com.example.gator] (abc123):
      versionCode=74 minSdk=36 targetSdk=36
      versionName=0.1.54
      installerPackageName=com.android.vending
  `;
  assert.deepEqual(parseInstalledPackageDump(output, 'com.example.gator'), {
    versionCode: 74,
    minSdk: 36,
    targetSdk: 36,
    versionName: '0.1.54',
    installerPackageName: 'com.android.vending',
  });
  assert.throws(() => parseInstalledPackageDump(output, 'com.example.other'), /not installed/);
  assert.throws(
    () =>
      parseInstalledPackageDump(
        'Package [com.example.gator]\n versionCode=not-a-number minSdk=36 targetSdk=36',
        'com.example.gator',
      ),
    /could not be read/,
  );
});

test('diagnostic XML parser returns only allowlisted aggregate rows', () => {
  const rows = parseDownloadIntegrityUiXml(`<?xml version="1.0"?>
    <hierarchy>
      <node text="Download Integrity" bounds="[0,0][1080,100]" />
      <node text="EXACT CANDIDATE" bounds="[16,110][500,140]" />
      <node text="App version" bounds="[16,150][400,200]" />
      <node text="0.1.54" bounds="[600,150][1000,200]" />
      <node text="ATTACHMENT CACHE" bounds="[16,210][500,240]" />
      <node text="Within 4,096 files" bounds="[16,250][400,300]" />
      <node text="Yes" bounds="[600,250][1000,300]" />
      <node text="GALLERY / ALBUM RECEIPTS" bounds="[16,310][500,340]" />
      <node text="Latest terminal" bounds="[16,350][400,400]" />
      <node text="No" bounds="[600,350][1000,400]" />
      <node text="SYNCED WALLPAPERS" bounds="[16,410][500,440]" />
      <node text="Native files" bounds="[16,450][400,500]" />
      <node text="3" bounds="[600,450][1000,500]" />
      <node text="private-message-body" bounds="[16,510][600,560]" />
    </hierarchy>`);
  assert.deepEqual(rows, {
    'EXACT CANDIDATE / App version': '0.1.54',
    'ATTACHMENT CACHE / Within 4,096 files': 'Yes',
    'GALLERY / ALBUM RECEIPTS / Latest terminal': 'No',
    'SYNCED WALLPAPERS / Native files': '3',
  });
  assert.equal(JSON.stringify(rows).includes('private-message-body'), false);
  const continued = parseDownloadIntegrityUiSnapshot(
    '<node text="Download Integrity" bounds="[0,0][1080,100]"/><node text="Native files" bounds="[16,150][400,200]"/><node text="4" bounds="[600,150][1000,200]"/>',
    'ATTACHMENT CACHE',
  );
  assert.deepEqual(continued, {
    rows: { 'ATTACHMENT CACHE / Native files': '4' },
    section: 'ATTACHMENT CACHE',
  });
  assert.throws(
    () => parseDownloadIntegrityUiXml('<node text="App version"/><node text="0.1.54"/>'),
    /not visible/,
  );
  assert.throws(
    () =>
      parseDownloadIntegrityUiXml(
        '<node text="Download Integrity" bounds="[0,0][1080,100]"/><node text="EXACT CANDIDATE" bounds="[16,110][500,140]"/><node text="App build" bounds="[16,150][400,200]"/><node text="74" bounds="[600,150][1000,200]"/><node text="App build" bounds="[16,210][400,260]"/><node text="75" bounds="[600,210][1000,260]"/>',
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      parseDownloadIntegrityUiXml(
        '<node text="Download Integrity" bounds="[0,0][1080,100]"/><node text="GALLERY / ALBUM RECEIPTS" bounds="[16,110][500,140]"/><node text="Latest terminal" bounds="[16,150][400,200]"/><node text="private-message-body" bounds="[600,150][1000,200]"/>',
      ),
    /has no value/,
  );
});
