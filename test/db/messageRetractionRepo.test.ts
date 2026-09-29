import type Database from 'better-sqlite3';
import { resolveExactMessageTargetPartIndex } from '@core/messages/partIndex';
import { Chat, Message, parseMessagePartTopology } from '@core/models';
import {
  applyLocalUnsend,
  getChatIdByGuid,
  getMessagePreviewByGuid,
  listAttachmentsByMessageIds,
  searchMessages,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase): Promise<{
  chatId: number;
  handles: Map<string, number>;
}> {
  const handles = await upsertHandles(db, [{ address: 'sender@example.com' }]);
  await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'retraction-chat',
        participants: [{ address: 'sender@example.com' }],
      }),
    ],
    handles,
  );
  return { chatId: (await getChatIdByGuid(db, 'retraction-chat'))!, handles };
}

async function put(
  db: AppDatabase,
  chatId: number,
  handles: Map<string, number>,
  value: Record<string, unknown>,
): Promise<void> {
  await upsertMessages(db, [Message.parse(value)], () => chatId, handles);
}

describe('message retraction persistence', () => {
  it('keeps only topology-proven partial content across a later lean attachment upsert', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'partial-message',
      text: 'PRIVATE ORIGINAL BODY',
      subject: 'PRIVATE SUBJECT',
      attributedBody: [{ string: 'PRIVATE ORIGINAL BODY', runs: [] }],
      dateCreated: 10,
      handle: { address: 'sender@example.com' },
      attachments: [
        { guid: 'attachment-retracted', mimeType: 'image/jpeg' },
        { guid: 'attachment-visible', mimeType: 'image/jpeg' },
      ],
    });
    raw
      .prepare("UPDATE messages SET payload_data = 'PRIVATE PAYLOAD' WHERE guid = ?")
      .run('partial-message');

    await put(db, chatId, handles, {
      guid: 'partial-message',
      text: 'surviving words',
      attributedBody: [{ string: 'surviving words', runs: [] }],
      dateCreated: 10,
      dateRetracted: 20,
      messageSummaryInfo: {
        editedParts: {
          '0': [{ date: 1, text: 'PRIVATE ORIGINAL BODY' }],
          '5': [{ date: 2, text: 'surviving words' }],
        },
        retractedParts: [0],
      },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [0, 2, 5],
        currentParts: [
          { index: 2, kind: 'attachment', attachmentGuids: ['attachment-visible'] },
          { index: 5, kind: 'text' },
        ],
        attachmentOwnership: [
          { attachmentGuid: 'attachment-retracted', partIndex: 0 },
          { attachmentGuid: 'attachment-visible', partIndex: 2 },
        ],
      },
      attachments: [
        { guid: 'attachment-retracted', mimeType: 'image/jpeg' },
        { guid: 'attachment-visible', mimeType: 'image/jpeg' },
      ],
    });

    // A later receipt-shaped page tries to restore old text, replace the saved proof, and insert an
    // unowned historical attachment. Durable partial state must keep all three from becoming visible.
    await put(db, chatId, handles, {
      guid: 'partial-message',
      text: 'PRIVATE STALE BODY',
      dateCreated: 10,
      messageSummaryInfo: { editedParts: { '5': [{ date: 3, text: 'stale edit' }] } },
      messagePartTopology: {
        complete: false,
        originalPartIndexes: [],
        currentParts: [],
        attachmentOwnership: [],
      },
      attachments: [{ guid: 'attachment-unowned', mimeType: 'image/jpeg' }],
    });

    const message = raw
      .prepare(
        `SELECT id, text, subject, attributed_body AS attributedBody,
                payload_data AS payloadData, retraction_state AS retractionState,
                message_summary_info AS messageSummaryInfo,
                message_part_topology AS messagePartTopology
           FROM messages WHERE guid = ?`,
      )
      .get('partial-message') as {
      id: number;
      text: string | null;
      subject: string | null;
      attributedBody: string | null;
      payloadData: string | null;
      retractionState: string;
      messageSummaryInfo: string;
      messagePartTopology: string;
    };
    expect(message).toMatchObject({
      text: 'surviving words',
      subject: null,
      payloadData: null,
      retractionState: 'partial',
    });
    expect(message.attributedBody).toBeNull();
    expect(JSON.parse(message.messageSummaryInfo)).toEqual({
      editedParts: { '5': [{ date: 2, text: 'surviving words' }] },
      retractedParts: [0],
    });
    expect(JSON.parse(message.messagePartTopology).complete).toBe(true);

    const attachmentRows = raw
      .prepare(
        `SELECT guid, message_part_index AS messagePartIndex, is_retracted AS isRetracted
           FROM attachments WHERE message_id = ? ORDER BY guid`,
      )
      .all(message.id);
    expect(attachmentRows).toEqual([
      { guid: 'attachment-retracted', messagePartIndex: 0, isRetracted: 1 },
      { guid: 'attachment-unowned', messagePartIndex: null, isRetracted: 1 },
      { guid: 'attachment-visible', messagePartIndex: 2, isRetracted: 0 },
    ]);
    const visible = await listAttachmentsByMessageIds(db, [message.id], undefined, {
      excludeRetractedAttachments: true,
    });
    expect(visible.get(message.id)?.map((attachment) => attachment.guid)).toEqual([
      'attachment-visible',
    ]);

    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'partial-message'),
    ).resolves.toMatchObject({
      text: 'surviving words',
      isFromMe: 0,
    });
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'partial-message', 2),
    ).resolves.toMatchObject({
      text: null,
      hasVisibleAttachments: 1,
    });
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'partial-message', 5),
    ).resolves.toMatchObject({
      text: 'surviving words',
      hasVisibleAttachments: 0,
    });
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'partial-message', null),
    ).resolves.toMatchObject({
      text: null,
      isRetracted: true,
    });
    expect((await searchMessages(db, 'surviving')).map((row) => row.guid)).toEqual([
      'partial-message',
    ]);
    expect(await searchMessages(db, 'PRIVATE')).toEqual([]);
  });

  it('persists exact topology and edit-only history before any retraction', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'ordinary-edited-message',
      text: 'current wording',
      dateCreated: 12,
      dateEdited: 13,
      messageSummaryInfo: {
        editedParts: { '3': [{ date: 11, text: 'prior wording' }] },
      },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [3],
        currentParts: [{ index: 3, kind: 'text' }],
        attachmentOwnership: [],
      },
    });

    const row = raw
      .prepare(
        `SELECT message_summary_info AS messageSummaryInfo,
                message_part_topology AS messagePartTopology
           FROM messages WHERE guid = ?`,
      )
      .get('ordinary-edited-message') as {
      messageSummaryInfo: string;
      messagePartTopology: string;
    };
    expect(JSON.parse(row.messageSummaryInfo)).toEqual({
      editedParts: { '3': [{ date: 11, text: 'prior wording' }] },
    });
    expect(JSON.parse(row.messagePartTopology)).toMatchObject({
      complete: true,
      originalPartIndexes: [3],
      currentParts: [{ index: 3, kind: 'text' }],
    });

    await put(db, chatId, handles, {
      guid: 'ordinary-edited-message',
      text: 'current wording',
      dateCreated: 12,
      messagePartTopology: {
        complete: false,
        originalPartIndexes: [3],
        currentParts: [{ index: 3, kind: 'text' }],
        attachmentOwnership: [],
      },
    });
    const afterLeanUpdate = raw
      .prepare('SELECT message_part_topology AS topology FROM messages WHERE guid = ?')
      .get('ordinary-edited-message') as { topology: string };
    expect(parseMessagePartTopology(afterLeanUpdate.topology)).toMatchObject({
      complete: true,
      originalPartIndexes: [3],
      currentParts: [{ index: 3, kind: 'text' }],
    });

    await put(db, chatId, handles, {
      guid: 'ordinary-edited-message',
      text: 'current wording',
      dateCreated: 12,
      messagePartTopology: {
        complete: true,
        originalPartIndexes: 'malformed-newer-proof',
        currentParts: [],
        attachmentOwnership: [],
      },
    });
    const invalidated = raw
      .prepare('SELECT message_part_topology AS topology FROM messages WHERE guid = ?')
      .get('ordinary-edited-message') as { topology: string };
    const invalidTopology = parseMessagePartTopology(invalidated.topology);
    expect(invalidTopology?.complete).toBe(false);
    expect(
      resolveExactMessageTargetPartIndex({
        attachmentCount: 0,
        hasText: true,
        partCount: 1,
        topology: invalidTopology,
        topologySupported: true,
        visibleAttachmentGuids: [],
      }),
    ).toBeUndefined();
  });

  it('keeps intact exact reply previews scoped to their owned part', async () => {
    const { db } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'ordinary-multipart',
      text: 'caption part',
      dateCreated: 14,
      attachments: [
        {
          guid: 'ordinary-a',
          mimeType: 'image/png',
          emojiImageShortDescription: 'first private description',
        },
        {
          guid: 'ordinary-b',
          mimeType: 'image/png',
          emojiImageShortDescription: 'second private description',
        },
      ],
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [0, 2, 4],
        currentParts: [
          { index: 0, kind: 'text' },
          { index: 2, kind: 'attachment', attachmentGuids: ['ordinary-a'] },
          { index: 4, kind: 'attachment', attachmentGuids: ['ordinary-b'] },
        ],
        attachmentOwnership: [
          { attachmentGuid: 'ordinary-a', partIndex: 2 },
          { attachmentGuid: 'ordinary-b', partIndex: 4 },
        ],
      },
    });

    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'ordinary-multipart', 0),
    ).resolves.toMatchObject({
      text: 'caption part',
      hasVisibleAttachments: 0,
      attachmentDescription: null,
    });
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'ordinary-multipart', 2),
    ).resolves.toMatchObject({
      text: null,
      hasVisibleAttachments: 1,
      attachmentDescription: 'first private description',
    });
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'ordinary-multipart', 4),
    ).resolves.toMatchObject({
      text: null,
      hasVisibleAttachments: 1,
      attachmentDescription: 'second private description',
    });
  });

  it('never lets stale subset evidence reveal a previously retracted part', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'monotonic-partial',
      text: 'safe survivor',
      dateCreated: 20,
      dateRetracted: 22,
      messageSummaryInfo: { retractedParts: [0, 2] },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [0, 2, 5],
        currentParts: [{ index: 5, kind: 'text' }],
        attachmentOwnership: [],
      },
    });

    await put(db, chatId, handles, {
      guid: 'monotonic-partial',
      text: 'PRIVATE STALE SUBSET',
      dateCreated: 20,
      dateRetracted: 22,
      messageSummaryInfo: { retractedParts: [0] },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [0, 2, 5],
        currentParts: [
          { index: 2, kind: 'text' },
          { index: 5, kind: 'text' },
        ],
        attachmentOwnership: [],
      },
    });

    const row = raw
      .prepare(
        `SELECT text, date_retracted AS dateRetracted,
                retraction_state AS retractionState,
                message_summary_info AS messageSummaryInfo
           FROM messages WHERE guid = ?`,
      )
      .get('monotonic-partial') as Record<string, unknown>;
    expect(row).toMatchObject({
      text: 'safe survivor',
      dateRetracted: 22,
      retractionState: 'partial',
    });
    expect(JSON.parse(row.messageSummaryInfo as string).retractedParts).toEqual([0, 2]);
    expect(await searchMessages(db, 'STALE')).toEqual([]);
  });

  it('keeps one optimistic part fence until an exact server echo includes it', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'pending-part',
      text: 'PRIVATE ORIGINAL',
      dateCreated: 30,
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [5, 6],
        currentParts: [
          { index: 5, kind: 'text' },
          { index: 6, kind: 'text' },
        ],
        attachmentOwnership: [],
      },
    });

    await expect(applyLocalUnsend(db, 'pending-part', 31, 5)).resolves.toMatchObject({
      pendingRetractionPartIndex: null,
    });
    await expect(applyLocalUnsend(db, 'pending-part', 32, 6)).resolves.toBeNull();

    await put(db, chatId, handles, {
      guid: 'pending-part',
      text: 'PRIVATE WRONG SURVIVOR',
      dateCreated: 30,
      messageSummaryInfo: { retractedParts: [6] },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [5, 6],
        currentParts: [{ index: 5, kind: 'text' }],
        attachmentOwnership: [],
      },
    });
    expect(
      raw
        .prepare(
          `SELECT retraction_state AS retractionState,
                  pending_retraction_part_index AS pendingPart
             FROM messages WHERE guid = ?`,
        )
        .get('pending-part'),
    ).toEqual({ retractionState: 'unknown', pendingPart: 5 });

    await put(db, chatId, handles, {
      guid: 'pending-part',
      text: 'safe remaining part',
      dateCreated: 30,
      messageSummaryInfo: { retractedParts: [5] },
      messagePartTopology: {
        complete: true,
        originalPartIndexes: [5, 6],
        currentParts: [{ index: 6, kind: 'text' }],
        attachmentOwnership: [],
      },
    });
    expect(
      raw
        .prepare(
          `SELECT text, retraction_state AS retractionState,
                  pending_retraction_part_index AS pendingPart
             FROM messages WHERE guid = ?`,
        )
        .get('pending-part'),
    ).toEqual({ text: 'safe remaining part', retractionState: 'partial', pendingPart: null });
  });

  it('turns date-only uncertainty into a durable fail-closed tombstone', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, handles } = await seedChat(db);
    await put(db, chatId, handles, {
      guid: 'unknown-message',
      text: 'PRIVATE UNKNOWN BODY',
      subject: 'PRIVATE UNKNOWN SUBJECT',
      attributedBody: [{ string: 'PRIVATE UNKNOWN BODY', runs: [] }],
      dateCreated: 11,
      handle: { address: 'sender@example.com' },
      attachments: [{ guid: 'unknown-attachment', mimeType: 'image/jpeg' }],
    });
    raw
      .prepare("UPDATE messages SET payload_data = 'PRIVATE UNKNOWN PAYLOAD' WHERE guid = ?")
      .run('unknown-message');

    await put(db, chatId, handles, {
      guid: 'unknown-message',
      text: 'PRIVATE EVENT COPY',
      dateCreated: 11,
      dateRetracted: 30,
      attachments: [{ guid: 'unknown-attachment', mimeType: 'image/jpeg' }],
    });
    await put(db, chatId, handles, {
      guid: 'unknown-message',
      text: 'PRIVATE STALE RESTORE',
      dateCreated: 11,
      attachments: [{ guid: 'later-unowned-attachment', mimeType: 'image/jpeg' }],
    });

    const row = raw
      .prepare(
        `SELECT id, text, subject, attributed_body AS attributedBody, payload_data AS payloadData,
                retraction_state AS retractionState
           FROM messages WHERE guid = ?`,
      )
      .get('unknown-message') as Record<string, unknown> & { id: number };
    expect(row).toMatchObject({
      text: null,
      subject: null,
      attributedBody: null,
      payloadData: null,
      retractionState: 'unknown',
    });
    expect(
      raw
        .prepare('SELECT guid, is_retracted AS isRetracted FROM attachments WHERE message_id = ?')
        .all(row.id),
    ).toEqual([
      { guid: 'unknown-attachment', isRetracted: 1 },
      { guid: 'later-unowned-attachment', isRetracted: 1 },
    ]);
    await expect(
      getMessagePreviewByGuid(db, 'retraction-chat', 'unknown-message'),
    ).resolves.toMatchObject({
      text: null,
      hasVisibleAttachments: 0,
      isRetracted: true,
    });
    expect(await searchMessages(db, 'PRIVATE')).toEqual([]);
  });
});
