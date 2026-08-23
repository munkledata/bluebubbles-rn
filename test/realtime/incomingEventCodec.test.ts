import { createHash } from 'node:crypto';
import { SERVER_EVENTS, type ServerEventName } from '@core/config';
import {
  IncomingEventCodecError,
  canonicalizeIncomingEvent,
  canonicalizeJson,
  encodeIncomingEvent,
  normalizeRealtimeEvent,
  verifyAndParseIncomingEvent,
  type DigestBackend,
  type NormalizedEvent,
} from '@core/realtime';

const digest: DigestBackend = {
  async sha256(input) {
    return new Uint8Array(createHash('sha256').update(input).digest());
  },
};

const RECEIVED_AT = 1_800_000_000_000;

const FIXTURES: Record<ServerEventName, unknown> = {
  'new-message': {
    guid: 'codec-new',
    text: 'hello',
    dateCreated: 1_700_000_000_000,
    chats: [{ guid: 'codec-chat' }],
  },
  'updated-message': {
    guid: 'codec-update',
    dateDelivered: 1_700_000_000_001,
    chats: [{ guid: 'codec-chat' }],
  },
  'message-deleted': {
    guid: 'codec-delete',
    chatGuid: 'codec-chat',
    dateDeleted: 1_700_000_000_002,
  },
  'typing-indicator': { chatGuid: 'codec-chat', display: true },
  'chat-read-status-changed': { chatGuid: 'codec-chat', read: true },
  'group-name-change': { guid: 'codec-group-name', chats: [{ guid: 'codec-chat' }] },
  'participant-added': { guid: 'codec-group-add', chats: [{ guid: 'codec-chat' }] },
  'participant-removed': { guid: 'codec-group-remove', chats: [{ guid: 'codec-chat' }] },
  'participant-left': { guid: 'codec-group-left', chats: [{ guid: 'codec-chat' }] },
  'ft-call-status-changed': { uuid: 'codec-call', status_id: 6 },
  'incoming-facetime': { uuid: 'codec-incoming', status_id: 4, address: '+15551234567' },
  'imessage-aliases-removed': { aliases: ['me@example.com'] },
  'message-send-error': { tempGuid: 'codec-outgoing', error: 22, retryable: true },
  'new-server': { server_address: 'https://rotated.example.com' },
  'rcs-alert': { alertType: 'PHONE_NOT_RESPONDING' },
  'rcs-bridge-down': { title: 'RCS down', body: 'Reconnect', reason: 'AUTH' },
  'test-notification': { title: 'Gator', body: 'Push works' },
};

function normalized(name: ServerEventName, raw: unknown = FIXTURES[name]): NormalizedEvent {
  const event = normalizeRealtimeEvent(name, raw);
  if (!event) throw new Error(`fixture failed to normalize: ${name}`);
  return event;
}

function metadata(source: 'socket' | 'fcm' | 'dev' = 'socket', occurrence = 'connection-1:1') {
  return { source, receivedAt: RECEIVED_AT, transportOccurrenceId: occurrence } as const;
}

describe('incoming event canonical JSON', () => {
  it('sorts object keys recursively, preserves array order and omits undefined object values', () => {
    expect(
      canonicalizeJson({
        z: 1,
        a: { emoji: '🐊', omitted: undefined, b: 2, a: 1 },
        list: [3, 2, 1],
      }),
    ).toBe('{"a":{"a":1,"b":2,"emoji":"🐊"},"list":[3,2,1],"z":1}');
    expect(canonicalizeJson({ list: [1, 2] })).not.toBe(canonicalizeJson({ list: [2, 1] }));
  });

  it.each([
    ['non-finite number', Number.NaN],
    ['undefined root', undefined],
    ['undefined array member', [undefined]],
    ['non-plain object', new Date(0)],
    ['function', () => undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(IncomingEventCodecError);
  });

  it('rejects sparse arrays, accessors and cycles without mutating input', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'not-read',
    });
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => 'not-read',
    });
    accessorArray.length = 1;
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const ordinary = { z: 1, nested: { b: 2, a: 1 } };
    const before = JSON.stringify(ordinary);

    expect(() => canonicalizeJson(sparse)).toThrow(IncomingEventCodecError);
    expect(() => canonicalizeJson(accessor)).toThrow(IncomingEventCodecError);
    expect(() => canonicalizeJson(accessorArray)).toThrow(IncomingEventCodecError);
    expect(() => canonicalizeJson(cyclic)).toThrow(IncomingEventCodecError);
    canonicalizeJson(ordinary);
    expect(JSON.stringify(ordinary)).toBe(before);
  });

  it('preserves an own __proto__ JSON key as data', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    expect(canonicalizeJson(parsed)).toBe('{"__proto__":{"polluted":true},"safe":1}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('bounds canonicalization depth before a transport payload can exhaust the JS stack', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    expect(() => canonicalizeJson(nested)).toThrow(expect.objectContaining({ code: 'work-limit' }));
  });
});

describe('incoming event envelope codec', () => {
  it('covers every advertised event with a bounded envelope that verifies and round-trips', async () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...SERVER_EVENTS].sort());

    for (const name of SERVER_EVENTS) {
      const event = normalized(name);
      const encoded = await encodeIncomingEvent(event, metadata(), digest);
      expect(encoded.envelope.eventName).toBe(name);
      expect(encoded.envelope.schemaVersion).toBe(1);
      expect(encoded.envelope.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(encoded.envelope.eventKey.length).toBeLessThanOrEqual(256);
      expect(encoded.envelope.orderingKey.length).toBeLessThanOrEqual(256);
      expect(encoded.envelope.expiresAt).toBeGreaterThan(RECEIVED_AT);
      expect(encoded.envelope.expiresAt - RECEIVED_AT).toBeLessThanOrEqual(24 * 60 * 60_000);
      expect(
        await verifyAndParseIncomingEvent(
          {
            schemaVersion: encoded.envelope.schemaVersion,
            eventName: encoded.envelope.eventName,
            payload: encoded.envelope.payload,
            payloadDigest: encoded.envelope.payloadDigest,
          },
          digest,
        ),
      ).toEqual(event);
    }
  });

  it('hashes the exact canonical UTF-8 payload and keeps raw identifiers out of receipt keys', async () => {
    const event = normalized('new-message');
    const encoded = await encodeIncomingEvent(event, metadata(), digest);
    const expected = createHash('sha256').update(encoded.envelope.payload).digest('hex');

    expect(encoded.envelope.payloadDigest).toBe(expected);
    expect(encoded.envelope.eventKey).not.toContain('codec-new');
    expect(encoded.envelope.orderingKey).not.toContain('codec-chat');
  });

  it('does not let transport source alter payload digest, event identity, or ordering', async () => {
    const event = normalized('new-message');
    const socket = await encodeIncomingEvent(event, metadata('socket', 'socket-copy'), digest);
    const fcm = await encodeIncomingEvent(event, metadata('fcm', 'fcm-copy'), digest);

    expect(fcm.envelope.payloadDigest).toBe(socket.envelope.payloadDigest);
    expect(fcm.envelope.eventKey).toBe(socket.envelope.eventKey);
    expect(fcm.envelope.orderingKey).toBe(socket.envelope.orderingKey);
    expect(fcm.envelope.source).toBe('fcm');
  });

  it('gives capped and full copies of one ordinary message one key but distinct payload digests', async () => {
    const full = normalized('new-message', {
      guid: 'same-guid',
      text: 'the complete long body',
      chats: [{ guid: 'same-chat' }],
    });
    const capped = normalized('new-message', {
      guid: 'same-guid',
      text: 'the complete…',
      textTruncated: true,
      chats: [{ guid: 'same-chat' }],
    });
    const a = await encodeIncomingEvent(full, metadata('socket', 'sock:1'), digest);
    const b = await encodeIncomingEvent(capped, metadata('fcm', 'fcm:1'), digest);

    expect(b.envelope.eventKey).toBe(a.envelope.eventKey);
    expect(b.envelope.payloadDigest).not.toBe(a.envelope.payloadDigest);
    expect(b.conflictRecovery).toEqual({ kind: 'sync-chat', chatGuid: 'same-chat' });
  });

  it.each([
    [
      'ordinary new message',
      'new-message' as const,
      {
        guid: 'serializer-new',
        originalROWID: 101,
        text: 'same body',
        dateCreated: 1_700_000_000_010,
        handleId: 7,
        handle: { originalROWID: 7, address: '+15551234567', service: 'iMessage' },
        attributedBody: [{ string: 'same body', runs: [] }],
        wasDeliveredQuietly: false,
        didNotifyRecipient: true,
        attachments: [
          {
            originalROWID: 201,
            guid: 'serializer-attachment',
            mimeType: 'image/jpeg',
            transferName: 'photo.jpg',
            totalBytes: 42,
            width: 10,
            height: 20,
            isSticker: false,
            hideAttachment: false,
          },
        ],
        chats: [
          {
            originalROWID: 301,
            guid: 'serializer-chat',
            chatIdentifier: '+15551234567',
            style: 45,
            isArchived: false,
          },
        ],
      },
      {
        guid: 'serializer-new',
        originalROWID: 101,
        text: 'same body',
        dateCreated: 1_700_000_000_010,
        handleId: 7,
        handle: { originalROWID: 7, address: '+15551234567', service: 'iMessage' },
        attributedBody: null,
        attachments: [
          {
            originalROWID: 201,
            guid: 'serializer-attachment',
            mimeType: 'image/jpeg',
            transferName: 'photo.jpg',
            totalBytes: 42,
            width: 10,
            height: 20,
          },
        ],
        chats: [
          {
            originalROWID: 301,
            guid: 'serializer-chat',
            chatIdentifier: '+15551234567',
            style: 45,
            isArchived: false,
          },
        ],
      },
    ],
    [
      'message update',
      'updated-message' as const,
      {
        guid: 'serializer-update',
        originalROWID: 102,
        text: 'delivered body',
        dateCreated: 1_700_000_000_020,
        dateDelivered: 1_700_000_000_021,
        attributedBody: [{ string: 'delivered body', runs: [] }],
        messageSummaryInfo: { editedParts: { '0': [] }, retractedParts: [] },
        payloadData: { urlData: [{ url: 'https://example.com', title: 'Example' }] },
        wasDeliveredQuietly: false,
        didNotifyRecipient: true,
        chats: [{ guid: 'serializer-chat', chatIdentifier: '+15551234567', style: 45 }],
      },
      {
        guid: 'serializer-update',
        originalROWID: 102,
        text: 'delivered body',
        dateCreated: 1_700_000_000_020,
        dateDelivered: 1_700_000_000_021,
        attributedBody: null,
        messageSummaryInfo: null,
        payloadData: null,
      },
    ],
    [
      'reaction delta',
      'new-message' as const,
      {
        guid: 'serializer-reaction',
        originalROWID: 103,
        dateCreated: 1_700_000_000_030,
        associatedMessageGuid: 'p:0/serializer-target',
        associatedMessageType: 'love',
        handleId: 7,
        handle: {
          originalROWID: 7,
          address: '+15551234567',
          service: 'iMessage',
          country: 'US',
          uncanonicalizedId: '(555) 123-4567',
        },
        attributedBody: [{ string: '', runs: [] }],
        wasDeliveredQuietly: false,
        chats: [{ guid: 'serializer-chat', chatIdentifier: '+15551234567', style: 45 }],
      },
      {
        guid: 'serializer-reaction',
        originalROWID: 103,
        dateCreated: 1_700_000_000_030,
        associatedMessageGuid: 'serializer-target',
        associatedMessageType: 'love',
        handleId: 7,
        handle: { originalROWID: 7, address: '+15551234567', service: 'iMessage' },
        attributedBody: null,
        chats: [{ guid: 'serializer-chat', chatIdentifier: '+15551234567', style: 45 }],
      },
    ],
  ])(
    'deduplicates the real rich-socket and lean-FCM %s serializers semantically',
    async (_label, eventName, richRaw, leanRaw) => {
      const socket = await encodeIncomingEvent(
        normalized(eventName, richRaw),
        metadata('socket', 'socket-serializer-copy'),
        digest,
      );
      const fcm = await encodeIncomingEvent(
        normalized(eventName, leanRaw),
        metadata('fcm', 'fcm-serializer-copy'),
        digest,
      );

      expect(fcm.envelope.payloadDigest).not.toBe(socket.envelope.payloadDigest);
      expect(fcm.envelope.eventKey).toBe(socket.envelope.eventKey);
      expect(fcm.envelope.orderingKey).toBe(socket.envelope.orderingKey);
    },
  );

  it('keeps message revisions distinct while serializing them behind one ordering key', async () => {
    const delivered = normalized('updated-message', {
      guid: 'revision-guid',
      dateDelivered: 10,
      chats: [{ guid: 'revision-chat' }],
    });
    const read = normalized('updated-message', {
      guid: 'revision-guid',
      dateDelivered: 10,
      dateRead: 20,
      chats: [{ guid: 'revision-chat' }],
    });
    const a = await encodeIncomingEvent(delivered, metadata(), digest);
    const b = await encodeIncomingEvent(read, metadata(), digest);

    expect(b.envelope.eventKey).not.toBe(a.envelope.eventKey);
    expect(b.envelope.orderingKey).toBe(a.envelope.orderingKey);
    expect(a.identityQuality).toBe('content-revision');
  });

  it("accepts the server's lean FCM updated-message shape without chats", async () => {
    const leanUpdate = normalized('updated-message', {
      guid: 'fcm-lean-update',
      dateDelivered: 20,
    });

    const encoded = await encodeIncomingEvent(
      leanUpdate,
      metadata('fcm', 'provider-message-id'),
      digest,
    );

    expect(encoded.envelope.eventName).toBe('updated-message');
    expect(encoded.conflictRecovery).toEqual({ kind: 'sync-account' });
    expect(encoded.envelope.orderingKey).toMatch(/^io1:message:/);
  });

  it('orders a chat-rich new message and chat-less deletion behind the same message key', async () => {
    const created = await encodeIncomingEvent(
      normalized('new-message', {
        guid: 'one-message-lifecycle',
        text: 'hello',
        chats: [{ guid: 'lifecycle-chat' }],
      }),
      metadata('socket', 'socket-create'),
      digest,
    );
    const deleted = await encodeIncomingEvent(
      normalized('message-deleted', {
        guid: 'one-message-lifecycle',
        dateDeleted: 1_700_000_000_040,
      }),
      metadata('fcm', 'fcm-delete'),
      digest,
    );

    expect(deleted.envelope.orderingKey).toBe(created.envelope.orderingKey);
  });

  it('does not mistake RCS reaction add/remove/re-add deltas that reuse a guid for duplicates', async () => {
    const reaction = (type: string, dateCreated: number) =>
      normalized('new-message', {
        guid: 'reused-reaction-guid',
        dateCreated,
        associatedMessageGuid: 'target-guid',
        associatedMessageType: type,
        chats: [{ guid: 'reaction-chat' }],
      });
    const add = await encodeIncomingEvent(reaction('love', 10), metadata(), digest);
    const remove = await encodeIncomingEvent(reaction('-love', 20), metadata(), digest);
    const readd = await encodeIncomingEvent(reaction('love', 30), metadata(), digest);
    const addAgain = await encodeIncomingEvent(reaction('love', 10), metadata('fcm'), digest);

    expect(
      new Set([add.envelope.eventKey, remove.envelope.eventKey, readd.envelope.eventKey]).size,
    ).toBe(3);
    expect(remove.envelope.orderingKey).toBe(add.envelope.orderingKey);
    expect(readd.envelope.orderingKey).toBe(add.envelope.orderingKey);
    expect(addAgain.envelope.eventKey).toBe(add.envelope.eventKey);
  });

  it('uses transport occurrence ids for recurring id-less events and server ids when available', async () => {
    const event = normalized('test-notification');
    const first = await encodeIncomingEvent(event, metadata('fcm', 'fcm-message-1'), digest);
    const retry = await encodeIncomingEvent(event, metadata('fcm', 'fcm-message-1'), digest);
    const secondClick = await encodeIncomingEvent(event, metadata('fcm', 'fcm-message-2'), digest);
    const serverSocket = await encodeIncomingEvent(
      event,
      { ...metadata('socket', 'socket-copy'), serverEventId: 'shared-event-1' },
      digest,
    );
    const serverFcm = await encodeIncomingEvent(
      event,
      { ...metadata('fcm', 'fcm-copy'), serverEventId: 'shared-event-1' },
      digest,
    );

    expect(retry.envelope.eventKey).toBe(first.envelope.eventKey);
    expect(secondClick.envelope.eventKey).not.toBe(first.envelope.eventKey);
    expect(serverFcm.envelope.eventKey).toBe(serverSocket.envelope.eventKey);
    expect(serverFcm.identityQuality).toBe('exact');
  });

  it('deduplicates socket/FCM send-error copies by a real attempt guid, never by tempGuid alone', async () => {
    const attemptOne = normalized('message-send-error', {
      guid: 'real-send-attempt-1',
      tempGuid: 'temp-send-error',
      error: 22,
      retryable: true,
    });
    const attemptTwo = normalized('message-send-error', {
      guid: 'real-send-attempt-2',
      tempGuid: 'temp-send-error',
      error: 22,
      retryable: true,
    });
    const tempOnly = normalized('message-send-error', {
      guid: 'temp-send-error',
      tempGuid: 'temp-send-error',
      error: 22,
      retryable: true,
    });
    const explicitAttempt = normalized('message-send-error', {
      attemptGuid: 'server-attempt-1',
      guid: 'temp-send-error',
      tempGuid: 'temp-send-error',
      error: 22,
      retryable: true,
    });
    const explicitLaterAttempt = normalized('message-send-error', {
      attemptGuid: 'server-attempt-2',
      guid: 'temp-send-error',
      tempGuid: 'temp-send-error',
      error: 22,
      retryable: true,
    });
    const socket = await encodeIncomingEvent(
      attemptOne,
      metadata('socket', 'socket:error'),
      digest,
    );
    const fcm = await encodeIncomingEvent(attemptOne, metadata('fcm', 'fcm:error'), digest);
    const later = await encodeIncomingEvent(attemptTwo, metadata('socket', 'socket:later'), digest);
    const tempSocket = await encodeIncomingEvent(
      tempOnly,
      metadata('socket', 'socket:temp-only'),
      digest,
    );
    const tempFcm = await encodeIncomingEvent(tempOnly, metadata('fcm', 'fcm:temp-only'), digest);
    const explicitSocket = await encodeIncomingEvent(
      explicitAttempt,
      metadata('socket', 'socket:explicit'),
      digest,
    );
    const explicitFcm = await encodeIncomingEvent(
      explicitAttempt,
      metadata('fcm', 'fcm:explicit'),
      digest,
    );
    const explicitLater = await encodeIncomingEvent(
      explicitLaterAttempt,
      metadata('socket', 'socket:explicit-later'),
      digest,
    );

    expect(fcm.envelope.eventKey).toBe(socket.envelope.eventKey);
    expect(later.envelope.eventKey).not.toBe(socket.envelope.eventKey);
    expect(tempFcm.envelope.eventKey).not.toBe(tempSocket.envelope.eventKey);
    expect(explicitFcm.envelope.eventKey).toBe(explicitSocket.envelope.eventKey);
    expect(explicitSocket.identityQuality).toBe('exact');
    expect(explicitLater.envelope.eventKey).not.toBe(explicitSocket.envelope.eventKey);
  });

  it('keeps equal transport-local occurrence spellings in separate source namespaces', async () => {
    const event = normalized('test-notification');
    const socket = await encodeIncomingEvent(event, metadata('socket', 'same-local-id'), digest);
    const fcm = await encodeIncomingEvent(event, metadata('fcm', 'same-local-id'), digest);
    expect(fcm.envelope.eventKey).not.toBe(socket.envelope.eventKey);
  });

  it('fails closed when an id-less recurring event has no occurrence identity', async () => {
    await expect(
      encodeIncomingEvent(
        normalized('typing-indicator'),
        { source: 'socket', receivedAt: RECEIVED_AT },
        digest,
      ),
    ).rejects.toMatchObject({ code: 'missing-occurrence-id' });
  });

  it('rejects wrong-size digest output and invalid intake timestamps', async () => {
    const wrongSize: DigestBackend = { sha256: async () => new Uint8Array(31) };
    await expect(
      encodeIncomingEvent(normalized('new-message'), metadata(), wrongSize),
    ).rejects.toMatchObject({ code: 'digest-failure' });
    await expect(
      encodeIncomingEvent(
        normalized('new-message'),
        { ...metadata(), receivedAt: Number.NaN },
        digest,
      ),
    ).rejects.toMatchObject({ code: 'invalid-metadata' });
  });

  it('snapshots mutable input before the first asynchronous digest yields', async () => {
    let release!: () => void;
    let calls = 0;
    const gatedDigest: DigestBackend = {
      async sha256(input) {
        if (calls++ === 0) await new Promise<void>((resolve) => (release = resolve));
        return digest.sha256(input);
      },
    };
    const raw = {
      guid: 'snapshot-guid',
      text: 'before',
      chats: [{ guid: 'snapshot-chat' }],
    };
    const event = normalized('new-message', raw);
    if (event.type !== 'new-message') throw new Error('expected new-message fixture');
    const pending = encodeIncomingEvent(event, metadata(), gatedDigest);
    await Promise.resolve();
    event.message.text = 'after';
    event.message.chats = [{ guid: 'different-chat' }];
    release();
    const encoded = await pending;

    expect(encoded.envelope.payload).toContain('before');
    expect(encoded.envelope.payload).not.toContain('after');
    const original = await encodeIncomingEvent(normalized('new-message', raw), metadata(), digest);
    expect(encoded.envelope.eventKey).toBe(original.envelope.eventKey);
    expect(encoded.envelope.orderingKey).toBe(original.envelope.orderingKey);
  });

  it('detects payload tampering, unsupported versions and non-canonical stored JSON', async () => {
    const encoded = await encodeIncomingEvent(normalized('new-message'), metadata(), digest);
    const stored = {
      schemaVersion: encoded.envelope.schemaVersion,
      eventName: encoded.envelope.eventName,
      payload: encoded.envelope.payload,
      payloadDigest: encoded.envelope.payloadDigest,
    };
    await expect(
      verifyAndParseIncomingEvent({ ...stored, payload: `${stored.payload} ` }, digest),
    ).rejects.toMatchObject({ code: 'digest-mismatch' });
    await expect(
      verifyAndParseIncomingEvent({ ...stored, schemaVersion: 2 }, digest),
    ).rejects.toMatchObject({ code: 'unsupported-version' });

    const nonCanonical = '{"text":"hi","guid":"noncanonical"}';
    const nonCanonicalDigest = createHash('sha256').update(nonCanonical).digest('hex');
    await expect(
      verifyAndParseIncomingEvent(
        {
          schemaVersion: 1,
          eventName: 'new-message',
          payload: nonCanonical,
          payloadDigest: nonCanonicalDigest,
        },
        digest,
      ),
    ).rejects.toMatchObject({ code: 'non-canonical-payload' });
  });

  it('canonicalizes FCM JSON text and socket objects through the same schema boundary', () => {
    const raw = { guid: 'same-wire', text: 'hello', chats: [{ guid: 'same-chat' }] };
    const socket = normalizeRealtimeEvent('new-message', raw);
    const fcm = normalizeRealtimeEvent('new-message', JSON.stringify(raw));
    expect(socket).not.toBeNull();
    expect(fcm).not.toBeNull();
    expect(canonicalizeIncomingEvent(fcm!).payload).toBe(
      canonicalizeIncomingEvent(socket!).payload,
    );
  });

  it('ignores a redundant FCM-hoisted chatGuid when chats[0] already carries the same identity', async () => {
    const socket = normalized('new-message', {
      guid: 'redundant-chat-guid',
      text: 'same semantic payload',
      chats: [{ guid: 'same-chat' }],
    });
    const fcm = normalized('new-message', {
      guid: 'redundant-chat-guid',
      text: 'same semantic payload',
      chats: [{ guid: 'same-chat' }],
      chatGuid: 'same-chat',
    });

    const socketEncoded = await encodeIncomingEvent(socket, metadata('socket'), digest);
    const fcmEncoded = await encodeIncomingEvent(fcm, metadata('fcm'), digest);

    expect(fcmEncoded.envelope.payloadDigest).toBe(socketEncoded.envelope.payloadDigest);
    expect(fcmEncoded.envelope.eventKey).toBe(socketEncoded.envelope.eventKey);
    expect(fcmEncoded.envelope.orderingKey).toBe(socketEncoded.envelope.orderingKey);
  });
});

describe('realtime validation prerequisites', () => {
  it('rejects primitive aliases and guid-less send errors', () => {
    expect(normalizeRealtimeEvent('imessage-aliases-removed', 'bad')).toBeNull();
    expect(normalizeRealtimeEvent('message-send-error', { error: 22 })).toBeNull();
    expect(
      normalizeRealtimeEvent('message-send-error', {
        attemptGuid: '',
        tempGuid: 'temp-valid-lookup',
        error: 22,
      }),
    ).toBeNull();
  });

  it('accepts legacy FaceTime field names and Gator FCM server_address', () => {
    const facetime = normalizeRealtimeEvent('ft-call-status-changed', {
      call_uuid: 'legacy-call',
      call_status: 6,
      is_sending_audio: true,
    });
    expect(facetime?.type).toBe('ft-call-status-changed');
    if (facetime?.type === 'ft-call-status-changed') {
      expect(facetime.payload).toMatchObject({
        uuid: 'legacy-call',
        status_id: 6,
        is_audio: true,
      });
    }
    expect(
      normalizeRealtimeEvent('new-server', {
        server_address: 'https://rotated.example.com',
      }),
    ).toEqual({ type: 'new-server', url: 'https://rotated.example.com' });
  });
});
