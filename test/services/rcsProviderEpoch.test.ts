import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat, ServerInfo } from '@core/models';
import {
  captureSessionRcsCapabilityLease,
  fixedRcsCapabilitySource,
} from '@/services/send/rcsAttemptCapability';
import { sendTextMessage } from '@/services/send/sendService';
import { upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useSessionStore } from '@state/sessionStore';
import { createTestDb } from '../support/testDb';

const EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const chatGuid = (epoch: string): string => `RCS;-;g1.${epoch}.${encoded('conversation-a')}`;
const messageGuid = (epoch: string): string => `rcs-g1.${epoch}.${encoded('message-a')}`;

function info(epoch: string) {
  return ServerInfo.parse({
    version: '2.0.0',
    rcs: true,
    supports_rcs_epoch_qualified_ids: true,
    rcs_provider_epoch: epoch,
  });
}

function fakeHttp(post: jest.Mock): HttpClient {
  let client!: HttpClient;
  client = {
    post,
    pinTransport: () => client,
    isTransportCurrent: () => true,
    assertTransportCurrent: () => undefined,
  } as unknown as HttpClient;
  return client;
}

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const participants = [{ address: '+15550000001', service: 'RCS' }];
  const handles = await upsertHandles(db, participants);
  await upsertChats(db, [Chat.parse({ guid, participants })], handles);
}

function count(raw: Database.Database, table: 'messages' | 'outgoing_queue'): number {
  return (raw.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value;
}

describe('RCS provider-epoch mutation admission', () => {
  it('sends only through the current qualified chat and rejects legacy/stale ids before DB or HTTP', async () => {
    const { db, raw } = await createTestDb();
    const currentGuid = chatGuid(EPOCH_A);
    const staleGuid = chatGuid(EPOCH_B);
    await seedChat(db, currentGuid);
    await seedChat(db, staleGuid);
    await seedChat(db, 'RCS;-;legacy-conversation');

    const post = jest.fn(async () => ({
      guid: messageGuid(EPOCH_A),
      dateCreated: 1_000,
      dateDelivered: null,
    }));
    const source = fixedRcsCapabilitySource(info(EPOCH_A));

    await sendTextMessage(
      db,
      fakeHttp(post),
      { chatGuid: currentGuid, text: 'current' },
      1_000,
      undefined,
      undefined,
      undefined,
      source,
    );
    expect(post).toHaveBeenCalledTimes(1);

    for (const guid of [staleGuid, 'RCS;-;legacy-conversation']) {
      await expect(
        sendTextMessage(
          db,
          fakeHttp(post),
          { chatGuid: guid, text: 'must stay local' },
          1_001,
          undefined,
          undefined,
          undefined,
          source,
        ),
      ).rejects.toThrow('previous Google pairing');
    }

    expect(post).toHaveBeenCalledTimes(1);
    expect(count(raw, 'messages')).toBe(1);
    expect(count(raw, 'outgoing_queue')).toBe(0);
  });

  it('invalidates an in-flight capability lease when the pairing epoch rotates', () => {
    const previous = useSessionStore.getState();
    try {
      useSessionStore.getState().connected('https://server.test', 'password', info(EPOCH_A));
      const lease = captureSessionRcsCapabilityLease();
      if (!lease) throw new Error('expected a connected capability lease');

      expect(
        useSessionStore
          .getState()
          .setServerInfoForTransport(lease.origin, lease.revision, info(EPOCH_B)),
      ).toBe(true);
      expect(lease.isCurrent()).toBe(false);
    } finally {
      useSessionStore.setState(previous);
    }
  });
});
