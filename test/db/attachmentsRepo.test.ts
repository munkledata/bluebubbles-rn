import { Attachment, Chat, Message } from '@core/models';
import {
  getAttachmentByGuid,
  listAttachmentsByMessageIds,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  const chatId = map.get('c1')!;
  const ids = await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm-img',
        dateCreated: 100,
        hasAttachments: true,
        handle: { address: 'a@x.com' },
        attachments: [
          Attachment.parse({
            guid: 'att-1',
            mimeType: 'image/jpeg',
            transferName: 'a.jpg',
            blurhash: 'LEHV6',
          }),
          Attachment.parse({ guid: 'att-2', mimeType: 'application/pdf', transferName: 'b.pdf' }),
        ],
      }),
      Message.parse({
        guid: 'm-text',
        text: 'no attachments',
        dateCreated: 200,
        handle: { address: 'a@x.com' },
      }),
    ],
    () => chatId,
    handles,
  );
  return ids;
}

describe('attachment repositories', () => {
  it('lists attachments grouped by message id (stable order)', async () => {
    const { db } = await createTestDb();
    const ids = await seed(db);
    const imgId = ids.get('m-img')!;
    const textId = ids.get('m-text')!;

    const byMsg = await listAttachmentsByMessageIds(db, [imgId, textId]);
    const atts = byMsg.get(imgId) ?? [];
    expect(atts.map((a) => a.guid)).toEqual(['att-1', 'att-2']);
    expect(atts[0]!.blurhash).toBe('LEHV6');
    expect(atts[0]!.mimeType).toBe('image/jpeg');
    expect(byMsg.has(textId)).toBe(false); // no attachments
  });

  it('returns an empty map for no ids', async () => {
    const { db } = await createTestDb();
    expect((await listAttachmentsByMessageIds(db, [])).size).toBe(0);
  });

  it('getAttachmentByGuid resolves hit/miss', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect((await getAttachmentByGuid(db, 'att-1'))?.transferName).toBe('a.jpg');
    expect(await getAttachmentByGuid(db, 'nope')).toBeNull();
  });

  it('derives service=null for an iMessage chat and "RCS" for an RCS;-; chat', async () => {
    const { db } = await createTestDb();
    const ids = await seed(db); // 'c1' is an ordinary chat guid
    const imgId = ids.get('m-img')!;

    // Ordinary chat → no RCS service tag.
    const imsg = await getAttachmentByGuid(db, 'att-1');
    expect(imsg?.service).toBeNull();
    const byMsg = await listAttachmentsByMessageIds(db, [imgId]);
    expect(byMsg.get(imgId)!.every((a) => a.service === null)).toBe(true);

    // Seed an RCS chat + message + attachment; the derived service must be 'RCS' so the
    // downloader routes bytes to /rcs/attachment/…
    const handles = await upsertHandles(db, [{ address: '+15551230000', service: 'RCS' }]);
    const map = await upsertChats(
      db,
      [Chat.parse({ guid: 'RCS;-;+15551230000', participants: [{ address: '+15551230000' }] })],
      handles,
    );
    const rcsChatId = map.get('RCS;-;+15551230000')!;
    const rcsIds = await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'rcs-m1',
          dateCreated: 300,
          hasAttachments: true,
          handle: { address: '+15551230000' },
          attachments: [
            Attachment.parse({
              guid: 'rcs-media-9',
              mimeType: 'image/jpeg',
              transferName: 'r.jpg',
            }),
          ],
        }),
      ],
      () => rcsChatId,
      handles,
    );
    const rcsMsgId = rcsIds.get('rcs-m1')!;
    expect((await getAttachmentByGuid(db, 'rcs-media-9'))?.service).toBe('RCS');
    const rcsByMsg = await listAttachmentsByMessageIds(db, [rcsMsgId]);
    expect(rcsByMsg.get(rcsMsgId)!.every((a) => a.service === 'RCS')).toBe(true);
  });
});
