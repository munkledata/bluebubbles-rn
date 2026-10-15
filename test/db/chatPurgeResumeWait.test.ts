/**
 * A restore waits for interrupted-purge resumes, because a resume deletes every row under the chat's
 * history boundary, which is where the restore's downloaded history lands (review of M061).
 */
import { Chat, Message } from '@core/models';
import {
  resumeChatPurges,
  upsertChats,
  upsertHandles,
  upsertMessages,
  waitForChatPurgeResumes,
} from '@db/repositories';
import { holdRollingBackDbNeighbour } from '../support/dbOwnershipProof';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;-;+15550000061';

it('reports a resume as running until its purge has finished', async () => {
  const { db, raw } = await createTestDb();
  try {
    const handles = await upsertHandles(db, [{ address: '+15550000061' }]);
    const chats = await upsertChats(
      db,
      [Chat.parse({ guid: CHAT_GUID, participants: [{ address: '+15550000061' }] })],
      handles,
    );
    await upsertMessages(
      db,
      [Message.parse({ guid: 'old-row', text: 'before the delete', dateCreated: 10 })],
      () => chats.get(CHAT_GUID),
      handles,
    );
    // A delete interrupted mid-purge: the boundary is recorded, the old row is still there.
    raw.prepare('UPDATE chats SET history_deleted_at = 100 WHERE guid = ?').run(CHAT_GUID);

    const neighbour = holdRollingBackDbNeighbour(db, () => undefined);
    await neighbour.entered;
    const resuming = resumeChatPurges(db);
    let idle = false;
    const waiting = waitForChatPurgeResumes().then(() => {
      idle = true;
    });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(idle).toBe(false);

    await neighbour.cleanup();
    await resuming;
    await waiting;
    expect(idle).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    await expect(waitForChatPurgeResumes()).resolves.toBeUndefined();
  } finally {
    raw.close();
  }
});
