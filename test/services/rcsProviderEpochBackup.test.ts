import { Chat } from '@core/models';
import { setChatCustomization, upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { buildBackup, restoreBackup } from '@/services/backup/backup';
import { createTestDb } from '../support/testDb';

const EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const SOURCE_ID = Buffer.from('conversation-a', 'utf8').toString('base64url');
const chatGuid = (epoch: string): string => `RCS;-;g1.${epoch}.${SOURCE_ID}`;
const PARTICIPANTS = [{ address: '+15550000001', service: 'RCS' }];

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, PARTICIPANTS);
  await upsertChats(
    db,
    [
      Chat.parse({
        guid,
        chatIdentifier: 'stable-conversation-a',
        style: 45,
        participants: PARTICIPANTS,
      }),
    ],
    handles,
  );
}

describe('RCS provider-epoch backup identity', () => {
  it('exports exact scope and restores customization only into the same Google pairing', async () => {
    const source = await createTestDb();
    await seedChat(source.db, chatGuid(EPOCH_A));
    await setChatCustomization(source.db, chatGuid(EPOCH_A), { customName: 'Scoped name' });

    const backup = await buildBackup(source.db, { exportedAt: 1 });
    expect(backup.chatCustomizations).toHaveLength(1);
    expect(backup.chatCustomizations[0]?.identity).toMatchObject({
      service: 'RCS',
      providerEpoch: EPOCH_A,
      providerSourceId: SOURCE_ID,
    });

    const exact = await createTestDb();
    await seedChat(exact.db, chatGuid(EPOCH_A));
    await expect(restoreBackup(exact.db, backup)).resolves.toMatchObject({
      chatCustomizations: 1,
      chatCustomizationsSkipped: 0,
    });
    expect(
      exact.raw.prepare('SELECT custom_name FROM chats WHERE guid = ?').get(chatGuid(EPOCH_A)),
    ).toEqual({ custom_name: 'Scoped name' });

    const rePaired = await createTestDb();
    await seedChat(rePaired.db, chatGuid(EPOCH_B));
    await expect(restoreBackup(rePaired.db, backup)).resolves.toMatchObject({
      chatCustomizations: 0,
      chatCustomizationsSkipped: 1,
    });
    expect(
      rePaired.raw.prepare('SELECT custom_name FROM chats WHERE guid = ?').get(chatGuid(EPOCH_B)),
    ).toEqual({ custom_name: null });
  });

  it('retains legacy RCS rows locally without exporting them as portable restore identities', async () => {
    const source = await createTestDb();
    const legacyGuid = 'RCS;-;legacy-conversation-a';
    await seedChat(source.db, legacyGuid);
    await setChatCustomization(source.db, legacyGuid, { customName: 'Legacy local history' });

    const backup = await buildBackup(source.db, { exportedAt: 1 });

    expect(backup.chatCustomizations).toEqual([]);
    expect(
      source.raw.prepare('SELECT custom_name FROM chats WHERE guid = ?').get(legacyGuid),
    ).toEqual({ custom_name: 'Legacy local history' });
  });
});
