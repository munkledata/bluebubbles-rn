import { Chat, Message } from '@core/models';
import {
  searchChatGuidsByMessage,
  searchMessagesEnriched,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

/** Two chats: "Mom" (a@b.com) with a birthday message, and "Work" (c@d.com) unrelated. */
async function seed(db: AppDatabase): Promise<void> {
  const hm = await upsertHandles(db, [
    { address: 'a@b.com', displayName: 'Mom' },
    { address: 'c@d.com', displayName: 'Boss' },
  ]);
  const map = await upsertChats(
    db,
    [
      Chat.parse({ guid: 'c-mom', displayName: 'Mom', participants: [{ address: 'a@b.com' }] }),
      Chat.parse({ guid: 'c-work', displayName: 'Work', participants: [{ address: 'c@d.com' }] }),
    ],
    hm,
  );
  await upsertMessages(
    db,
    [
      // An edited/SMS-style message: empty text column, body only in attributedBody.
      Message.parse({
        guid: 'm-bday',
        text: '',
        attributedBody: [{ string: 'see you at the birthday party', runs: [] }],
        dateCreated: 100,
        handle: { address: 'a@b.com' },
      }),
    ],
    () => map.get('c-mom')!,
    hm,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm-work',
        text: 'quarterly report due friday',
        dateCreated: 200,
        handle: { address: 'c@d.com' },
      }),
    ],
    () => map.get('c-work')!,
    hm,
  );
}

describe('edited/SMS text is searchable (derived from attributedBody)', () => {
  it('full-text search finds a message whose body lives only in attributedBody', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const results = await searchMessagesEnriched(db, 'birthday');
    expect(results).toHaveLength(1);
    expect(results[0]!.guid).toBe('m-bday');
    expect(results[0]!.text).toContain('birthday'); // text column was populated from attributedBody
  });
});

describe('search result snippet (shows WHY a result matched)', () => {
  it('returns a snippet centered on the match, containing the matched term', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const [hit] = await searchMessagesEnriched(db, 'birthday');
    expect(hit).toBeDefined();
    // The matched word is present in the snippet (the raw text START might not be, for a long
    // message) — the UI bolds the query terms in JS.
    expect(hit!.snippet).toContain('birthday');
  });
});

describe('searchChatGuidsByMessage (inbox top-bar message-content match)', () => {
  it('returns chats whose message content matches, incl. derived edited/SMS text', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const guids = await searchChatGuidsByMessage(db, 'birthday');
    expect(guids).toContain('c-mom');
    expect(guids).not.toContain('c-work');
  });

  it('is empty for a blank/too-short query', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await searchChatGuidsByMessage(db, '')).toEqual([]);
  });
});

describe('message hit carries chat fields for resolveTitle (no raw chat-guid titles)', () => {
  it('returns custom/display name, identifier, style + participant names for the hit chat', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const [hit] = await searchMessagesEnriched(db, 'birthday');
    expect(hit).toBeDefined();
    // The fields resolveTitle needs are present so a group never renders as a raw chat-guid.
    expect(hit).toHaveProperty('chatCustomName');
    expect(hit).toHaveProperty('chatStyle');
    expect(hit!.chatParticipantNames).toContain('Mom');
  });
});
