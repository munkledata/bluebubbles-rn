import { sql } from 'drizzle-orm';
import { Chat } from '@core/models';
import {
  chatHasKnownSender,
  listChatsForInbox,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

describe('unknown senders (contact-match signal)', () => {
  it('flags chats by whether any participant matched a device contact', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [
      { address: 'friend@x.com' },
      { address: '+15550009999' }, // a stranger
    ]);
    await upsertChats(
      db,
      [
        Chat.parse({ guid: 'c-known', participants: [{ address: 'friend@x.com' }] }),
        Chat.parse({ guid: 'c-unknown', participants: [{ address: '+15550009999' }] }),
      ],
      handles,
    );
    // Contact-sync marks the friend's handle as matched (contact_id set).
    await db.run(sql`UPDATE handles SET contact_id = 7 WHERE address = 'friend@x.com'`);

    const rows = await listChatsForInbox(db);
    const byGuid = new Map(rows.map((r) => [r.guid, r.hasKnownSender]));
    expect(byGuid.get('c-known')).toBe(1);
    expect(byGuid.get('c-unknown')).toBe(0);

    expect(await chatHasKnownSender(db, 'c-known')).toBe(true);
    expect(await chatHasKnownSender(db, 'c-unknown')).toBe(false);
    expect(await chatHasKnownSender(db, 'missing')).toBe(false);
  });
});
