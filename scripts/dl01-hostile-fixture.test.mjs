import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';

import {
  createFcmV3Frame,
  DL01_MODES,
  DL01_OVERSIZED_DIMENSION_PNG,
  DL01_VALID_PNG,
  encodeFcmPushIdentityV3,
  startDl01FixtureServer,
} from './dl01-hostile-fixture.mjs';
import { parseDeviceBaseUrl, parseDl01DeviceFixtureArgs } from './run-dl01-device-fixture.mjs';

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

test('DL-01 fixture exposes only authenticated synthetic sync and bounded hostile modes', async (t) => {
  const fcmCalls = [];
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    port: 0,
    firebaseProjectId: 'fixture-project',
    connectionCapMs: 90,
    attachmentDeadlineDelayMs: 40,
    wallpaperDeadlineDelayMs: 30,
    attachmentMaxBytes: 64,
    wallpaperMaxBytes: 96,
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
      const raw = await rawRequest(
        fixture.port,
        `/api/v1/attachment/${encodeURIComponent(attachment.guid)}/download`,
      );
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
      } else if (mode === 'max-plus-one') {
        assert.equal(decodeChunks(response.body).bytes.length, 65);
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
    assert.equal(decodeChunks(splitResponse(raw).body).bytes.length, 97);
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
    'self-revoke acknowledges cleanup, clears registration, and rejects reuse',
    async () => {
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
      const afterRevokeStatus = fixture.status();
      assert.equal(afterRevokeStatus.fcm.registrationReady, false);
      assert.equal(JSON.stringify(afterRevokeStatus).includes(FCM_TOKEN), false);
      assert.equal(JSON.stringify(afterRevokeStatus).includes(PUSH_KEY), false);

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
