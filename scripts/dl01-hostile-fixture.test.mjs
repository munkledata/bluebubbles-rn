import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import {
  createEncryptedFeat07Pdf,
  createExactLengthFeat07Pdf,
  createExactLengthValidPng,
  createFeat07Pdf,
  createFcmV3Frame,
  DL01_DEFAULT_ATTACHMENT_MAX_BYTES,
  DL01_DEFAULT_WALLPAPER_MAX_BYTES,
  DL01_MAX_ATTACHMENT_COUNT,
  DL01_MODES,
  DL01_OVERSIZED_DIMENSION_PNG,
  DL01_VALID_PNG,
  NOTIF03_STEPS,
  SEND01_FAILURE_STEPS,
  encodeFcmPushIdentityV3,
  parseDl01FixtureArgs,
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

test('FEAT-05C exposes remote-only search hits without seeding ordinary sync', async (t) => {
  assert.equal(parseDl01FixtureArgs(['--fixture-set', 'feat05c']).fixtureSet, 'feat05c');
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'feat05c',
    now: () => 1_800_000_000_000,
  });
  t.after(() => fixture.close());
  const sync = () => control(fixture, '/api/v1/message/query', { afterRowId: 0, limit: 100 });
  const chats = (await control(fixture, '/api/v1/chat/query', { limit: 10 })).json.data.chats;
  assert.equal(chats.length, 2);
  assert.equal(chats[1].lastMessage, null);
  assert.deepEqual(
    (await sync()).json.data.messages.map((row) => row.guid),
    ['feat05c-message-1'],
  );
  const history = (index) =>
    control(fixture, `/api/v1/chat/${encodeURIComponent(chats[index].guid)}/message`);
  assert.equal((await history(1)).json.data.messages.length, 0);
  const result = await control(fixture, '/api/v1/message/search/bounded', {
    text: 'Searchneedle',
    limit: 50,
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Object.keys(result.json.data), ['messages']);
  const hits = result.json.data.messages;
  assert.deepEqual(
    hits.map((row) => row.guid),
    ['feat05c-message-3', 'feat05c-message-2', 'feat05c-message-1'],
  );
  assert.ok(hits.every((row) => row.chatGuid === row.chats[0].guid));
  assert.equal(hits[0].handle.service, 'SMS');
  assert.equal(hits[1].handle.service, 'iMessage');
  assert.deepEqual(hits[2], (await sync()).json.data.messages[0]);
  assert.deepEqual((await history(1)).json.data.messages, [hits[0]]);
  assert.deepEqual((await history(0)).json.data.messages, [hits[1], hits[2]]);
  assert.deepEqual(
    (await sync()).json.data.messages.map((row) => row.guid),
    ['feat05c-message-1'],
  );
  for (const path of ['scenario', 'release-held', 'fcm/send-current']) {
    assert.equal((await control(fixture, `/_dl01/v1/${path}`, {})).response.status, 404);
  }
  assert.equal((await control(fixture, '/api/v1/message/text', {})).response.status, 404);
  assert.equal(fixture.status().totals.fcmSends, 0);
  assert.equal(fixture.status().totals.downloadRequests, 0);
});

test('FEAT-05C bounds requests and advances only fixed authenticated failure stages', async (t) => {
  for (const config of [{ firebaseProjectId: 'fixture-project' }, { rcsPermissions: true }]) {
    await assert.rejects(
      startDl01FixtureServer({ authToken: AUTH_TOKEN, fixtureSet: 'feat05c', ...config }),
    );
  }
  const fixture = await startDl01FixtureServer({ authToken: AUTH_TOKEN, fixtureSet: 'feat05c' });
  t.after(() => fixture.close());
  const search = (body) => control(fixture, '/api/v1/message/search/bounded', body);
  for (const body of [
    { text: 'x', limit: 50 },
    { text: 'x'.repeat(129), limit: 50 },
    { text: ' Searchneedle', limit: 50 },
    { text: 'Searchneedle', limit: 51 },
    { text: 'Searchneedle', limit: 50, messages: [] },
  ])
    assert.equal((await search(body)).response.status, 400);
  const stage = (body) => control(fixture, '/_dl01/v1/feat05c/stage', body);
  const unauthorized = splitResponse(
    await rawRequest(fixture.port, '/_dl01/v1/feat05c/stage', {
      method: 'POST',
      body: JSON.stringify({ stage: 'unavailable' }),
      authorization: 'wrong',
    }),
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await stage({ stage: 'old-server' })).response.status, 409);
  assert.equal((await stage({ stage: 'unavailable', text: 'override' })).response.status, 400);
  assert.equal((await stage({ stage: 'unavailable' })).response.status, 200);
  assert.equal((await search({ text: 'Searchneedle', limit: 50 })).response.status, 503);
  assert.equal(
    (await control(fixture, '/api/v1/server/info')).json.data.supports_message_search,
    true,
  );
  assert.equal((await stage({ stage: 'old-server' })).response.status, 200);
  assert.equal(
    (await control(fixture, '/api/v1/server/info')).json.data.supports_message_search,
    false,
  );
  assert.equal((await stage({ stage: 'supported' })).response.status, 400);
  assert.equal((await stage({ stage: 'old-server' })).response.status, 409);
  assert.equal(
    (await control(fixture, '/api/v1/device-credentials/revoke-self', {})).response.status,
    200,
  );
  assert.equal((await search({ text: 'Searchneedle', limit: 50 })).response.status, 401);
  assert.equal((await stage({ stage: 'unavailable' })).response.status, 401);
});

test('FEAT-05C full search caps tied results and leaves the navigation target off-screen', async (t) => {
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'feat05c',
    searchScenario: 'full',
  });
  t.after(() => fixture.close());
  const snapshot = fixture.searchFixtureData();
  assert.equal(snapshot.messages.length, 264);
  snapshot.messages.length = 0;
  assert.equal(fixture.searchFixtureData().messages.length, 264);
  const result = (
    await control(fixture, '/api/v1/message/search/bounded', { text: 'Searchneedle', limit: 50 })
  ).json.data.messages;
  assert.equal(result.length, 50);
  assert.equal(new Set(result.map((row) => row.guid)).size, 50);
  assert.equal(result[0].guid, 'feat05c-message-3');
  assert.equal(result[1].guid, 'feat05c-match-058');
  assert.equal(result[2].guid, 'feat05c-match-059');
  const chat = fixture.searchFixtureData().chats[0];
  const history = (
    await control(fixture, `/api/v1/chat/${encodeURIComponent(chat.guid)}/message?limit=100`)
  ).json.data.messages;
  assert.equal(history.length, 100);
  assert.ok(history.every((row) => row.text.startsWith('Context line ')));
  assert.equal(
    (await control(fixture, '/api/v1/message/search/bounded', { text: 'Anchorneedle', limit: 50 }))
      .json.data.messages[0].guid,
    'feat05c-message-2',
  );
});

test('FEAT-05C injected results fail closed and held account-A replies remain on their original socket', async (t) => {
  let supplied;
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'feat05c',
    searchScenario: 'full',
    searchMessages: () => supplied,
  });
  t.after(() => fixture.close());
  const row = fixture
    .searchFixtureData()
    .messages.find((message) => message.guid === 'feat05c-held');
  for (const malformed of [
    [{ ...row, chatGuid: 'wrong' }],
    Array(51).fill(row),
    [{ ...row, chats: [row.chats[0], row.chats[0]] }],
  ]) {
    supplied = malformed;
    assert.equal(
      (
        await control(fixture, '/api/v1/message/search/bounded', {
          text: 'Retireneedle',
          limit: 50,
        })
      ).response.status,
      500,
    );
  }
  supplied = [row];
  assert.equal((await control(fixture, '/_dl01/v1/feat05c/hold', {})).response.status, 200);
  const controller = new AbortController();
  const pending = fetch(`${fixture.origin}/api/v1/message/search/bounded`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Retireneedle', limit: 50 }),
    signal: controller.signal,
  }).catch((error) => error.name);
  for (let attempt = 0; !fixture.status().search.heldPending && attempt < 100; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.status().search.heldPending, true);
  controller.abort();
  assert.equal(await pending, 'AbortError');
  for (let attempt = 0; fixture.status().search.heldClosed === 0 && attempt < 100; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.status().search.heldClosed, 1);
  assert.equal(
    (await control(fixture, '/api/v1/device-credentials/revoke-self', {})).response.status,
    200,
  );
  assert.equal(
    (await control(fixture, '/_dl01/v1/feat05c/release-search', {})).response.status,
    200,
  );
  assert.equal(fixture.status().search.releasedSearches, 1);
  assert.equal(fixture.status().search.heldPending, false);
});

function sendFailureBody(index) {
  return {
    chatGuid: 'iMessage;-;notif01-a@example.invalid',
    tempGuid: `temp-proof00${index}`,
    method: 'apple-script',
    text: `Send failure check ${index}`,
    clientAttemptGeneration: 1,
  };
}

test('SEND-01 proof is programmatic opt-in only, NOTIF-01 only, and cannot enable outbound FCM', async (t) => {
  for (const sendFailureProof of ['yes', 1, null, {}]) {
    await assert.rejects(
      startDl01FixtureServer({ authToken: AUTH_TOKEN, fixtureSet: 'notif01', sendFailureProof }),
      /must be a boolean/,
    );
  }
  for (const fixtureSet of ['dl01', 'feat07', 'notif03', 'feat05c']) {
    await assert.rejects(
      startDl01FixtureServer({ authToken: AUTH_TOKEN, fixtureSet, sendFailureProof: true }),
      /requires the NOTIF-01 fixture/,
    );
  }
  await assert.rejects(
    startDl01FixtureServer({
      authToken: AUTH_TOKEN,
      fixtureSet: 'notif01',
      sendFailureProof: true,
      firebaseProjectId: 'fixture-project',
    }),
    /does not support outbound FCM/,
  );
  assert.throws(() => parseDl01FixtureArgs(['--send-failure-proof', 'yes']), /Unknown/);
  assert.equal(Object.hasOwn(parseDl01FixtureArgs([]), 'sendFailureProof'), false);
  const fixture = await startDl01FixtureServer({ authToken: AUTH_TOKEN, fixtureSet: 'notif01' });
  t.after(() => fixture.close());
  assert.equal(Object.hasOwn(fixture.status(), 'sendFailureProof'), false);
  assert.equal(
    (await control(fixture, '/api/v1/message/text', sendFailureBody(1))).response.status,
    404,
  );
  assert.equal(
    (await control(fixture, '/_dl01/v1/send01/release', { step: 'other-chat' })).response.status,
    404,
  );
});

test('SEND-01 releases exactly three fixed synthetic failures with authenticated one-at-a-time holds', async (t) => {
  let outboundRequests = 0;
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif01',
    sendFailureProof: true,
    fetchImpl: async () => {
      outboundRequests += 1;
      throw new Error('no outbound transport is permitted');
    },
  });
  t.after(() => fixture.close());
  const post = (body) => control(fixture, '/api/v1/message/text', body);
  const release = (step) => control(fixture, '/_dl01/v1/send01/release', { step });
  assert.equal((await release('other-chat')).response.status, 409);
  for (const changes of [
    { chatGuid: 'iMessage;-;real@example.com' },
    { chatGuid: 'iMessage;-;notif01-b@example.invalid' },
    { text: 'arbitrary message' },
    { text: 'Send failure check 2' },
    { tempGuid: 'arbitrary' },
    { tempGuid: `temp-${'a'.repeat(500)}` },
    { method: 'private-api' },
    { clientAttemptGeneration: 0 },
    { clientAttemptGeneration: 2_147_483_648 },
    { clientAttemptGeneration: null },
    { recipient: 'outside@example.com' },
    { selectedMessageGuid: 'unexpected' },
  ])
    assert.equal((await post({ ...sendFailureBody(1), ...changes })).response.status, 400);
  assert.equal(
    splitResponse(
      await rawRequest(fixture.port, '/api/v1/message/text', {
        method: 'POST',
        body: JSON.stringify(sendFailureBody(1)),
        authorization: 'wrong-credential',
      }),
    ).status,
    401,
  );
  assert.equal(fixture.status().sendFailureProof.acceptedRequests, 0);
  const assertFailure = ({ response, json }) => {
    assert.equal(response.status, 400);
    assert.deepEqual(json, {
      status: 400,
      message: 'fixture request rejected',
      data: null,
      error: { message: 'The test server rejected this message. No message was delivered.' },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(json)) < 512);
  };
  const firstBody = sendFailureBody(1);
  delete firstBody.clientAttemptGeneration;
  assertFailure(await post(firstBody));
  for (const [index, step] of SEND01_FAILURE_STEPS.entries()) {
    if (index === 0) continue;
    const pending = post(sendFailureBody(index + 1));
    await waitForStatus(fixture, (status) => status.sendFailureProof.heldPending);
    assert.equal(fixture.status().sendFailureProof.pendingStep, step);
    assert.equal((await post(sendFailureBody(index + 1))).response.status, 409);
    assert.equal(
      splitResponse(
        await rawRequest(fixture.port, '/_dl01/v1/send01/release', {
          method: 'POST',
          body: JSON.stringify({ step }),
          authorization: 'wrong-credential',
        }),
      ).status,
      401,
    );
    assert.equal(
      (await release(step === 'other-chat' ? 'background' : 'other-chat')).response.status,
      409,
    );
    assert.equal(
      (await control(fixture, '/_dl01/v1/send01/release', { step, error: 'override' })).response
        .status,
      400,
    );
    assert.equal(fixture.status().sendFailureProof.heldPending, true);
    assert.deepEqual((await release(step)).json, { ok: true, released: 1 });
    assertFailure(await pending);
    assert.equal((await release(step)).response.status, 409);
  }
  assert.equal((await post(sendFailureBody(4))).response.status, 409);
  assert.deepEqual(fixture.status().sendFailureProof, {
    acceptedRequests: 3,
    releasedResponses: 3,
    cancelledRequests: 0,
    heldPending: false,
    pendingStep: null,
    nextStep: null,
    halted: false,
  });
  const info = (await control(fixture, '/api/v1/server/info')).json.data;
  assert.equal(info.supports_imessage_plain_text, undefined);
  assert.equal(outboundRequests, 0);
  assert.equal(fixture.status().totals.fcmSends, 0);
  const status = JSON.stringify(fixture.status());
  for (const secret of [
    AUTH_TOKEN,
    firstBody.chatGuid,
    firstBody.tempGuid,
    firstBody.text,
    'test server rejected',
  ]) {
    assert.equal(status.includes(secret), false);
  }
  assert.equal((await control(fixture, '/api/v1/message/query', {})).json.data.messages.length, 2);
});

test('SEND-01 held failures halt on revocation, close, client abort, or finite timeout', async (t) => {
  for (const stop of ['revoke', 'close', 'abort', 'timeout']) {
    await t.test(stop, async (t) => {
      const fixture = await startDl01FixtureServer({
        authToken: AUTH_TOKEN,
        fixtureSet: 'notif01',
        sendFailureProof: true,
        connectionCapMs: stop === 'timeout' ? 150 : 1_000,
      });
      t.after(() => fixture.close());
      await control(fixture, '/api/v1/message/text', sendFailureBody(1));
      const controller = new AbortController();
      const pending = fetch(`${fixture.origin}/api/v1/message/text`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sendFailureBody(2)),
        signal: controller.signal,
      }).then(
        () => 'unexpected response',
        () => 'closed',
      );
      await waitForStatus(fixture, (status) => status.sendFailureProof.heldPending);
      if (stop === 'revoke') {
        assert.equal(
          (await control(fixture, '/api/v1/device-credentials/revoke-self', {})).response.status,
          200,
        );
      } else if (stop === 'close') {
        await fixture.close();
      } else if (stop === 'abort') {
        controller.abort();
      }
      assert.equal(await pending, 'closed');
      if (stop !== 'close') {
        await waitForStatus(fixture, (status) => status.sendFailureProof.halted);
        assert.equal(
          (await control(fixture, '/_dl01/v1/send01/release', { step: 'other-chat' })).response
            .status,
          stop === 'revoke' ? 401 : 409,
        );
        assert.equal(
          (await control(fixture, '/api/v1/message/text', sendFailureBody(3))).response.status,
          stop === 'revoke' ? 401 : 409,
        );
      }
      assert.deepEqual(fixture.status().sendFailureProof, {
        acceptedRequests: 2,
        releasedResponses: 1,
        cancelledRequests: 1,
        heldPending: false,
        pendingStep: null,
        nextStep: null,
        halted: true,
      });
    });
  }
});

test('NOTIF-01 isolates two stable chats and six distinct authenticated V3 pushes', async (t) => {
  assert.equal(parseDl01FixtureArgs([]).fixtureSet, 'dl01');
  assert.equal(parseDl01FixtureArgs(['--fixture-set', 'notif01']).fixtureSet, 'notif01');
  const pushes = [];
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif01',
    firebaseProjectId: 'fixture-project',
    now: () => 1_800_000_000_000,
    getAccessToken: async () => ACCESS_TOKEN,
    fetchImpl: async (_url, init) => {
      pushes.push(JSON.parse(init.body).message);
      return { ok: true };
    },
  });
  t.after(() => fixture.close());
  const send = (body) => control(fixture, '/_dl01/v1/notif01/send', body);
  assert.equal((await send({ chat: 'a' })).response.status, 409);
  for (const body of [{}, { chat: 'c' }, { chat: 'a', text: 'override' }]) {
    assert.equal((await send(body)).response.status, 400);
  }
  const unauthorized = splitResponse(
    await rawRequest(fixture.port, '/_dl01/v1/notif01/send', {
      method: 'POST',
      body: JSON.stringify({ chat: 'a' }),
      authorization: 'not-the-credential',
    }),
  );
  assert.equal(unauthorized.status, 401);
  for (const path of ['scenario', 'release-held', 'fcm/send-current']) {
    assert.equal((await control(fixture, `/_dl01/v1/${path}`, {})).response.status, 404);
  }
  assert.equal((await control(fixture, '/api/v1/message/text', {})).response.status, 404);
  const initial = (await control(fixture, '/api/v1/chat/query', { limit: 10 })).json.data.chats;
  assert.equal(initial.length, 2);
  assert.notEqual(initial[0].guid, initial[1].guid);
  assert.notEqual(
    initial[0].participants[0].originalROWID,
    initial[1].participants[0].originalROWID,
  );
  assert.equal(
    initial.every((chat) => chat.lastMessage.isFromMe && !chat.lastMessage.hasAttachments),
    true,
  );
  const page = (await control(fixture, '/api/v1/chat/query', { offset: 1, limit: 1 })).json.data
    .chats;
  assert.deepEqual(page, [initial[1]]);
  const registration = await control(fixture, '/api/v1/devices', {
    name: 'Fixture Android',
    provider: 'fcm',
    token: FCM_TOKEN,
    pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
  });
  assert.equal(registration.response.status, 201);
  for (const chat of ['a', 'b', 'a', 'b', 'a', 'b']) {
    assert.equal((await send({ chat })).response.status, 200);
  }
  assert.equal((await send({ chat: 'a' })).response.status, 409);
  const messages = (await control(fixture, '/api/v1/message/query', { afterRowId: 0, limit: 100 }))
    .json.data.messages;
  assert.equal(messages.length, 8);
  assert.equal(new Set(messages.map((message) => message.guid)).size, 8);
  assert.deepEqual(
    messages.map((message) => message.originalROWID),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(
    messages.every(
      (message, index) => index === 0 || message.dateCreated > messages[index - 1].dateCreated,
    ),
    true,
  );
  assert.equal(pushes.length, 6);
  for (const [index, push] of pushes.entries()) {
    assert.equal(push.token, FCM_TOKEN);
    assert.equal(push.data.encryptionType, 'AEAD_GCM_V3_IDENTITY');
    const message = JSON.parse(decryptV3Frame(push.data.data, PUSH_KEY).plaintext);
    assert.deepEqual(message, messages[index + 2]);
    assert.equal(message.isFromMe, false);
    assert.equal(message.hasAttachments, false);
    assert.deepEqual(message.attachments, []);
    assert.equal(message.chatGuid, initial[index % 2].guid);
  }
  const cursor = (await control(fixture, '/api/v1/message/query', { afterRowId: 6, limit: 1 })).json
    .data.messages;
  assert.deepEqual(cursor, [messages[6]]);
  const timeCursor = (
    await control(fixture, '/api/v1/message/query', { after: messages[6].dateCreated })
  ).json.data.messages;
  assert.deepEqual(timeCursor, [messages[7]]);
  const history = (
    await control(
      fixture,
      `/api/v1/chat/${encodeURIComponent(initial[0].guid)}/message?offset=1&limit=2`,
    )
  ).json.data.messages;
  assert.deepEqual(history, [messages[2], messages[4]]);
  const latest = (await control(fixture, `/api/v1/chat/${encodeURIComponent(initial[1].guid)}`))
    .json.data.chat;
  assert.deepEqual(latest.lastMessage, messages[7]);
  const contacts = (
    await control(fixture, '/api/v1/contact/query', {
      addresses: initial.map((chat) => chat.chatIdentifier),
    })
  ).json.data.contacts;
  assert.equal(contacts.length, 2);
  assert.equal(
    contacts.every((contact) => !contact.hasAvatar),
    true,
  );
  const status = fixture.status();
  assert.equal(status.incomingMessages, 6);
  assert.equal(status.totals.fcmSends, 6);
  assert.equal(status.totals.downloadRequests, 0);
  for (const secret of [
    AUTH_TOKEN,
    FCM_TOKEN,
    PUSH_KEY,
    ACCESS_TOKEN,
    messages[2].text,
    messages[2].guid,
  ]) {
    assert.equal(JSON.stringify(status).includes(secret), false);
  }
  assert.equal(
    (await control(fixture, '/api/v1/device-credentials/revoke-self', {})).response.status,
    200,
  );
  assert.equal(fixture.status().fcm.registrationReady, false);
  assert.equal((await send({ chat: 'a' })).response.status, 409);
});

test('NOTIF-01 allows only fixed A/B grouped withdrawals and canonical retraction', async (t) => {
  const pushes = [];
  let finishWithdrawal;
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif01',
    firebaseProjectId: 'fixture-project',
    getAccessToken: async () => ACCESS_TOKEN,
    fetchImpl: async (_url, init) => {
      const push = JSON.parse(init.body).message;
      pushes.push(push);
      if (push.data.type === 'updated-message' && pushes.length === 3) {
        return new Promise((resolve) => {
          finishWithdrawal = resolve;
        });
      }
      return { ok: true };
    },
  });
  t.after(() => fixture.close());
  const send = (chat) => control(fixture, '/_dl01/v1/notif01/send', { chat });
  const withdraw = (body) => control(fixture, '/_dl01/v1/notif01/withdraw-grouped', body);
  assert.equal((await withdraw({ chat: 'a' })).response.status, 409);
  for (const body of [{}, { chat: 'c' }, { chat: 'a', guid: 'override' }]) {
    assert.equal((await withdraw(body)).response.status, 400);
  }
  await control(fixture, '/api/v1/devices', {
    name: 'Fixture Android',
    provider: 'fcm',
    token: FCM_TOKEN,
    pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
  });
  assert.equal((await send('a')).response.status, 200);
  assert.equal((await withdraw({ chat: 'a' })).response.status, 409);
  assert.equal((await send('b')).response.status, 200);
  assert.equal((await withdraw({ chat: 'b' })).response.status, 409);
  const pending = withdraw({ chat: 'a' });
  await waitForStatus(fixture, () => typeof finishWithdrawal === 'function');
  assert.equal((await withdraw({ chat: 'a' })).response.status, 409);
  assert.equal((await send('a')).response.status, 409);
  finishWithdrawal({ ok: true });
  assert.equal((await pending).response.status, 200);
  assert.equal((await withdraw({ chat: 'a' })).response.status, 409);
  assert.equal((await send('a')).response.status, 409);
  assert.equal((await withdraw({ chat: 'b' })).response.status, 200);
  assert.equal((await withdraw({ chat: 'b' })).response.status, 409);
  const messages = (await control(fixture, '/api/v1/message/query', { limit: 100 })).json.data
    .messages;
  assert.equal(pushes.length, 4);
  for (const [index, push] of pushes.entries()) {
    const decoded = decryptV3Frame(push.data.data, PUSH_KEY);
    assert.ok(decoded.aad.includes(push.data.type));
    const payload = JSON.parse(decoded.plaintext);
    assert.equal(push.data.type, index < 2 ? 'new-message' : 'updated-message');
    const target = messages[(index % 2) + 2];
    if (index < 2) {
      assert.equal(payload.guid, target.guid);
      assert.equal(payload.text, `Notification check ${index + 1}`);
    } else {
      assert.deepEqual(payload, { guid: target.guid, dateRetracted: target.dateRetracted });
      assert.equal(target.text, null);
      assert.ok(target.dateRetracted > target.dateCreated);
    }
  }
  assert.equal(fixture.status().incomingMessages, 2);
  assert.equal(fixture.status().totals.fcmSends, 4);
  await control(fixture, '/api/v1/device-credentials/revoke-self', {});
  assert.equal((await withdraw({ chat: 'a' })).response.status, 409);
});

test('NOTIF-01 refuses concurrent delivery and stops after an uncertain FCM result', async (t) => {
  let finishDelivery;
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif01',
    firebaseProjectId: 'fixture-project',
    getAccessToken: async () => ACCESS_TOKEN,
    fetchImpl: () =>
      new Promise((resolve) => {
        finishDelivery = resolve;
      }),
  });
  t.after(() => fixture.close());
  await control(fixture, '/api/v1/devices', {
    name: 'Fixture Android',
    provider: 'fcm',
    token: FCM_TOKEN,
    pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
  });
  const first = control(fixture, '/_dl01/v1/notif01/send', { chat: 'a' });
  await waitForStatus(fixture, (status) => status.incomingMessages === 1);
  assert.equal(
    (await control(fixture, '/_dl01/v1/notif01/send', { chat: 'b' })).response.status,
    409,
  );
  finishDelivery({ ok: false });
  assert.equal((await first).response.status, 503);
  assert.equal(fixture.status().deliveryHalted, true);
  assert.equal(fixture.status().totals.fcmSends, 0);
  assert.equal(
    (await control(fixture, '/_dl01/v1/notif01/send', { chat: 'b' })).response.status,
    409,
  );
  assert.equal(fixture.status().incomingMessages, 1);
});

test('fixture revocation during OAuth prevents dispatch to a stale enrollment', async (t) => {
  let finishOAuth;
  let dispatches = 0;
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif01',
    firebaseProjectId: 'fixture-project',
    getAccessToken: () =>
      new Promise((resolve) => {
        finishOAuth = resolve;
      }),
    fetchImpl: async () => {
      dispatches += 1;
      return { ok: true };
    },
  });
  t.after(() => fixture.close());
  await control(fixture, '/api/v1/devices', {
    name: 'Fixture Android',
    provider: 'fcm',
    token: FCM_TOKEN,
    pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
  });
  const pending = control(fixture, '/_dl01/v1/notif01/send', { chat: 'a' });
  await waitForStatus(fixture, (status) => status.incomingMessages === 1);
  await control(fixture, '/api/v1/device-credentials/revoke-self', {});
  finishOAuth(ACCESS_TOKEN);
  assert.equal((await pending).response.status, 409);
  assert.equal(dispatches, 0);
  assert.equal(fixture.status().deliveryHalted, true);
});

test('NOTIF-03 fixes a finite burst/withdrawal/late/resource sequence with bounded encrypted frames', async (t) => {
  assert.equal(parseDl01FixtureArgs(['--fixture-set', 'notif03']).fixtureSet, 'notif03');
  const pushes = [];
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    fixtureSet: 'notif03',
    firebaseProjectId: 'fixture-project',
    now: () => 1_800_000_000_000,
    getAccessToken: async () => ACCESS_TOKEN,
    fetchImpl: async (_url, init) => {
      pushes.push(JSON.parse(init.body).message);
      return { ok: true };
    },
  });
  t.after(() => fixture.close());
  const step = (body) => control(fixture, '/_dl01/v1/notif03/step', body);
  assert.equal((await step({ step: 'history-1' })).response.status, 409);
  assert.equal((await step({ step: 'history-1', text: 'override' })).response.status, 400);
  assert.equal(
    (await control(fixture, '/_dl01/v1/notif01/send', { chat: 'a' })).response.status,
    404,
  );
  assert.equal((await control(fixture, '/api/v1/message/text', {})).response.status, 404);
  await control(fixture, '/api/v1/devices', {
    name: 'Fixture Android',
    provider: 'fcm',
    token: FCM_TOKEN,
    pushEncryption: { type: 'AEAD_GCM_V3_IDENTITY', key: PUSH_KEY },
  });
  assert.equal((await step({ step: 'history-7' })).response.status, 409);
  for (const value of NOTIF03_STEPS) {
    const result = await step({ step: value });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.sends, value === 'history-pair' ? 2 : 1);
    assert.equal((await step({ step: value })).response.status, 409);
  }
  const decoded = pushes.map((push) => {
    assert.ok(Buffer.byteLength(push.data.data) <= 4_096);
    assert.ok(
      Object.entries(push.data).reduce(
        (bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value),
        0,
      ) <= 4_096,
    );
    const frame = decryptV3Frame(push.data.data, PUSH_KEY);
    assert.ok(frame.aad.includes(push.data.type));
    return JSON.parse(frame.plaintext);
  });
  assert.deepEqual(
    decoded.slice(0, 7).map((message) => message.text),
    Array.from({ length: 7 }, (_, index) => `History line ${index + 1}`),
  );
  assert.equal(pushes[8].data.type, 'updated-message');
  assert.equal(decoded[8].guid, decoded[3].guid);
  assert.equal(decoded[8].dateRetracted, 1_800_000_000_000);
  assert.equal(decoded[7].dateCreated, decoded[0].dateCreated);
  assert.ok(decoded[7].dateCreated < decoded[1].dateCreated);
  assert.ok(decoded[7].dateCreated > 1_800_000_000_000);
  assert.equal(
    new Set(decoded.filter((_, index) => index !== 8).map((message) => message.guid)).size,
    14,
  );
  assert.ok(decoded.slice(9).every((message) => [...message.text].length === 520));
  const messages = (await control(fixture, '/api/v1/message/query', { afterRowId: 0, limit: 100 }))
    .json.data.messages;
  assert.equal(messages.length, 17);
  assert.equal(messages.find((message) => message.guid === decoded[3].guid).text, null);
  assert.equal(
    messages.find((message) => message.guid === decoded[3].guid).dateRetracted,
    decoded[8].dateRetracted,
  );
  const contacts = (
    await control(fixture, '/api/v1/contact/query', { addresses: ['notif03-c@example.invalid'] })
  ).json.data.contacts;
  assert.equal(contacts[0].hasAvatar, true);
  assert.equal([...contacts[0].displayName].length, 130);
  const avatar = splitResponse(
    await rawRequest(fixture.port, '/api/v1/contact/notif03-contact-3/avatar'),
  );
  assert.equal(avatar.status, 200);
  assert.equal(avatar.body.readUInt32BE(16), 1_024);
  assert.equal(avatar.body.readUInt32BE(20), 1_024);
  const idatOffset = 8 + 12 + 13;
  const idatLength = avatar.body.readUInt32BE(idatOffset);
  assert.equal(
    inflateSync(avatar.body.subarray(idatOffset + 8, idatOffset + 8 + idatLength)).length,
    1_024 * (1 + 1_024 * 4),
  );
  assert.ok(avatar.body.length < 5 * 1024 * 1024);
  assert.equal(
    (await control(fixture, '/api/v1/contact/notif03-contact-1/avatar')).response.status,
    404,
  );
  assert.equal(fixture.status().completedSteps, 14);
  assert.equal(fixture.status().nextStep, null);
  assert.equal(fixture.status().totals.fcmSends, 15);
  assert.equal(fixture.status().incomingMessages, 14);
  assert.equal(fixture.status().avatarRequests, 1);
});

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

test('FEAT-07 PDF fixtures are deterministic, bounded, and structurally distinct', () => {
  const valid = createFeat07Pdf();
  assert.equal(valid.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.equal(valid.includes(Buffer.from('startxref', 'ascii')), true);

  const exact = createExactLengthFeat07Pdf(4_096);
  assert.equal(exact.length, 4_096);
  assert.equal(exact.subarray(0, 8).toString('latin1'), '%PDF-1.4');

  const encrypted = createEncryptedFeat07Pdf('gator');
  assert.equal(encrypted.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.equal(encrypted.includes(Buffer.from('/Encrypt 6 0 R', 'ascii')), true);
  assert.throws(() => createFeat07Pdf('bad\nlabel'), /label is invalid/);
  assert.throws(() => createExactLengthFeat07Pdf(100), /exact PDF byte length/);
});

test('FEAT-07 fixture serves one authenticated paginated synthetic attachment corpus', async (t) => {
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    port: 0,
    fixtureSet: 'feat07',
    feat07VideoBytes: video,
    feat07LargePdfBytes: 4_096,
    now: () => 1_788_912_000_000,
  });
  t.after(() => fixture.close());

  const unauthorized = await fetch(`${fixture.origin}/api/v1/chat/query`, { method: 'POST' });
  assert.equal(unauthorized.status, 401);

  const info = await control(fixture, '/api/v1/server/info');
  assert.equal(info.response.status, 200);
  assert.equal(info.json.data.supports_scoped_device_credentials, false);
  assert.equal(info.json.data.supports_fcm_push_encryption_v3, false);
  assert.equal(info.json.data.rcs, false);

  const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 100 });
  assert.equal(chats.response.status, 200);
  assert.equal(chats.json.data.chats.length, 1);
  const chat = chats.json.data.chats[0];
  assert.equal(chat.displayName, 'FEAT-07 Fixture');
  assert.equal(chat.guid, 'iMessage;-;feat07-fixture@example.invalid');

  const chatPath = `/api/v1/chat/${encodeURIComponent(chat.guid)}/message`;
  const firstPage = await control(fixture, `${chatPath}?offset=0&limit=50`);
  const secondPage = await control(fixture, `${chatPath}?offset=50&limit=50`);
  assert.equal(firstPage.json.data.messages.length, 50);
  assert.equal(secondPage.json.data.messages.length, 5);
  const allMessages = [...firstPage.json.data.messages, ...secondPage.json.data.messages];
  const allAttachments = allMessages.map((message) => message.attachments[0]);
  assert.equal(
    allAttachments.filter((attachment) => attachment.mimeType === 'application/pdf').length,
    51,
  );
  assert.equal(
    allAttachments.filter((attachment) => attachment.mimeType === 'text/vcard').length,
    1,
  );
  assert.equal(
    allAttachments.filter((attachment) => attachment.mimeType === 'image/png').length,
    2,
  );
  assert.equal(
    allAttachments.filter((attachment) => attachment.mimeType === 'video/mp4').length,
    1,
  );
  assert.equal(allAttachments.at(-1).transferName, '52-oldest-page.pdf');
  assert.equal(new Set(allMessages.map((message) => message.guid)).size, 55);

  const oldest = await control(fixture, '/api/v1/message/query', {
    afterRowId: 0,
    limit: 20,
  });
  assert.equal(oldest.json.data.messages.length, 20);
  const cursor = oldest.json.data.messages.at(-1).originalROWID;
  const remaining = await control(fixture, '/api/v1/message/query', {
    afterRowId: cursor,
    limit: 100,
  });
  assert.equal(remaining.json.data.messages.length, 35);
  const globalMessages = [...oldest.json.data.messages, ...remaining.json.data.messages];
  assert.equal(new Set(globalMessages.map((message) => message.guid)).size, 55);
  assert.ok(
    globalMessages.every(
      (message, index, messages) =>
        index === 0 || messages[index - 1].originalROWID < message.originalROWID,
    ),
  );

  const contacts = await control(fixture, '/api/v1/contact/query', {
    addresses: ['feat07-fixture@example.invalid'],
  });
  assert.equal(contacts.json.data.contacts[0].displayName, 'FEAT-07 Fixture');
  assert.equal(contacts.json.data.contacts[0].hasAvatar, false);

  const attachmentByName = new Map(
    allAttachments.map((attachment) => [attachment.transferName, attachment]),
  );
  const download = (name) =>
    fetch(
      `${fixture.origin}/api/v1/attachment/${encodeURIComponent(attachmentByName.get(name).guid)}/download`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );

  const retryFailure = await download('02-retry.pdf');
  assert.equal(retryFailure.status, 503);
  const retrySuccess = await download('02-retry.pdf');
  assert.equal(retrySuccess.status, 200);
  const retryBytes = Buffer.from(await retrySuccess.arrayBuffer());
  assert.equal(retrySuccess.headers.get('content-type'), 'application/pdf');
  assert.equal(Number(retrySuccess.headers.get('content-length')), retryBytes.length);
  assert.equal(retryBytes.length, attachmentByName.get('02-retry.pdf').totalBytes);
  assert.equal(retryBytes.subarray(0, 4).toString('ascii'), '%PDF');

  for (const [name, assertion] of [
    ['01-valid.pdf', (bytes) => assert.equal(bytes.subarray(0, 4).toString('ascii'), '%PDF')],
    [
      '03-contact.vcf',
      (bytes) => {
        const text = bytes.toString('utf8');
        assert.equal(text.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'), true);
        assert.equal(text.includes('\r\nN:Fixture;Gator FEAT-07;;;\r\n'), true);
        assert.equal(text.includes('\r\nFN:Gator FEAT-07 Fixture\r\n'), true);
        assert.equal(text.endsWith('END:VCARD\r\n'), true);
      },
    ],
    [
      '04-encrypted-password-gator.pdf',
      (bytes) => assert.equal(bytes.includes(Buffer.from('/Encrypt 6 0 R')), true),
    ],
    [
      '05-malformed.pdf',
      (bytes) => assert.equal(bytes.includes(Buffer.from('deliberately malformed')), true),
    ],
    ['06-large.pdf', (bytes) => assert.equal(bytes.length, 4_096)],
    ['52-oldest-page.pdf', (bytes) => assert.equal(bytes.subarray(0, 4).toString('ascii'), '%PDF')],
    ['feat07-image-one.png', (bytes) => assert.equal(bytes.length, 68)],
    ['feat07-image-two.png', (bytes) => assert.equal(bytes.length, 128)],
    ['feat07-video.mp4', (bytes) => assert.deepEqual(bytes, video)],
  ]) {
    const response = await download(name);
    assert.equal(response.status, 200, name);
    const attachment = attachmentByName.get(name);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('content-type'), attachment.mimeType, name);
    assert.equal(Number(response.headers.get('content-length')), bytes.length, name);
    assert.equal(bytes.length, attachment.totalBytes, name);
    assertion(bytes);
  }

  const missing = await fetch(`${fixture.origin}/api/v1/attachment/not-present/download`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(missing.status, 404);
  const hiddenDl01Attachment = await fetch(
    `${fixture.origin}/api/v1/attachment/dl01-attachment-1/download`,
    { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  );
  assert.equal(hiddenDl01Attachment.status, 404);
  const hiddenDl01Messages = await control(fixture, '/api/v1/chat/dl01-chat-1/message');
  assert.equal(hiddenDl01Messages.response.status, 404);
  const hiddenDl01Chat = await control(fixture, '/api/v1/chat/dl01-chat-1');
  assert.equal(hiddenDl01Chat.response.status, 404);
  for (const path of ['/scenario', '/release-held', '/fcm/send-current']) {
    const disabled = await control(fixture, `/_dl01/v1${path}`, {});
    assert.equal(disabled.response.status, 404, path);
  }

  const status = await control(fixture, '/_dl01/v1/status');
  assert.equal(status.json.fixtureSet, 'feat07');
  assert.equal(status.json.feat07.messages, 55);
  assert.equal(status.json.feat07.documents, 52);
  assert.equal(status.json.feat07.media, 3);
  assert.equal(
    status.json.feat07.assets.find((asset) => asset.alias === 'document-retry').failures,
    1,
  );
  const publicJson = JSON.stringify(status.json);
  assert.equal(publicJson.includes(AUTH_TOKEN), false);
  assert.equal(publicJson.includes('feat07-attachment-'), false);
  assert.equal(publicJson.includes('.pdf'), false);

  const revoked = await control(fixture, '/api/v1/device-credentials/revoke-self', {});
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.json.data.revoked, true);
  const rejectedAfterRevoke = await control(fixture, '/api/v1/ping');
  assert.equal(rejectedAfterRevoke.response.status, 401);
  const controlAfterRevoke = await control(fixture, '/_dl01/v1/status');
  assert.equal(controlAfterRevoke.response.status, 200);
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
    assert.equal(info.json.data.rcs, false);

    const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 200 });
    assert.equal(chats.json.data.chats.length, 1);
    const chat = chats.json.data.chats[0];
    assert.equal(chat.displayName, 'DL-01 Fixture');
    assert.equal(chat.guid.startsWith('RCS;-;'), false);
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

test('opt-in permission fixture exposes a synthetic RCS chat without changing the default', async (t) => {
  const fixture = await startDl01FixtureServer({
    authToken: AUTH_TOKEN,
    port: 0,
    rcsPermissions: true,
  });
  t.after(() => fixture.close());

  const info = await control(fixture, '/api/v1/server/info');
  const chats = await control(fixture, '/api/v1/chat/query', { offset: 0, limit: 1 });
  assert.equal(info.json.data.rcs, true);
  assert.match(chats.json.data.chats[0].guid, /^RCS;-;dl01-chat-/);
  assert.equal(chats.json.data.chats[0].participants[0].service, 'RCS');
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
      rcsPermissions: false,
      fixtureSet: 'dl01',
      feat07VideoPath: null,
    },
  );
  assert.equal(
    parseDl01DeviceFixtureArgs([
      '--serial',
      'device-1234',
      '--package',
      'com.example.gator',
      '--base-url',
      'http://127.0.0.1:43117',
      '--rcs-permissions',
      'yes',
    ]).rcsPermissions,
    true,
  );
  assert.deepEqual(
    parseDl01DeviceFixtureArgs([
      '--serial',
      'device-1234',
      '--package',
      'com.example.gator',
      '--base-url',
      'http://127.0.0.1:43149',
      '--fixture-set',
      'feat07',
      '--feat07-video',
      '/tmp/feat07.mp4',
    ]),
    {
      serial: 'device-1234',
      packageName: 'com.example.gator',
      base: { origin: 'http://127.0.0.1:43149', port: 43_149 },
      firebaseProjectId: null,
      rcsPermissions: false,
      fixtureSet: 'feat07',
      feat07VideoPath: '/tmp/feat07.mp4',
    },
  );
  assert.throws(
    () =>
      parseDl01DeviceFixtureArgs([
        '--serial',
        'device-1234',
        '--package',
        'com.example.gator',
        '--base-url',
        'http://127.0.0.1:43149',
        '--fixture-set',
        'feat07',
      ]),
    /--feat07-video is required/,
  );
  assert.throws(
    () =>
      parseDl01DeviceFixtureArgs([
        '--serial',
        'device-1234',
        '--package',
        'com.example.gator',
        '--base-url',
        'http://127.0.0.1:43149',
        '--fixture-set',
        'feat07',
        '--feat07-video',
        '/tmp/feat07.mp4',
        '--rcs-permissions',
        'yes',
      ]),
    /does not support FCM or RCS/,
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
