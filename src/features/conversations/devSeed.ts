import { eq } from 'drizzle-orm';
import { Attachment, Chat, Message } from '@core/models';
import { getDatabase } from '@db/database';
import { chats as chatsTable } from '@db/schema';
import {
  applyLocalEdit,
  applyLocalUnsend,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingReaction,
  insertOutgoingText,
  listChatsForInbox,
  reconcileOutgoingSuccess,
  updateAttachmentLocalPath,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { devPush } from '@/services';
import { setAttachmentFetcher } from '@/services/download';
import { devProgressFetcher } from '@/services/download/devFetcher';
import { generateTempGuid } from '@/services/send/sendService';

// Canonical sample blurhash (Woltapp) for the dev attachment fixtures.
const SAMPLE_BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

/**
 * DEV-ONLY fixture seeding for on-device verification of the conversation list.
 * Writes through the real upsert path (the same one sync/socket use), so it
 * exercises the exact reactive-fire path. Never call this in production.
 */

const DAY = 86_400_000;

interface Fixture {
  guid: string;
  title?: string;
  participants: { address: string; displayName: string }[];
  lastText: string;
  fromMe?: boolean;
  ageMs: number;
  pinned?: boolean;
  muted?: boolean;
  read?: boolean;
  rowId: number;
}

function fixtures(_now: number): Fixture[] {
  return [
    {
      guid: 'c-craig',
      participants: [{ address: 'craig@apple.com', displayName: 'Craig Federighi' }],
      lastText: 'The hair looks great today 💇',
      ageMs: 4 * 60_000,
      rowId: 101,
    },
    {
      // Contacts-sync target: display name == the raw number (no contact yet).
      // After "Sync Contacts" matches a device contact, this shows their name/photo.
      guid: 'c-unknown',
      participants: [{ address: '+15558675309', displayName: '+15558675309' }],
      lastText: 'who is this?',
      ageMs: 9 * 60_000,
      rowId: 106,
    },
    {
      guid: 'c-mom',
      participants: [{ address: '+15551234567', displayName: 'Mom' }],
      lastText: 'Call me when you land!',
      ageMs: 35 * 60_000,
      pinned: true,
      rowId: 102,
    },
    {
      guid: 'c-fam',
      title: 'Family 👨‍👩‍👧',
      participants: [
        { address: 'dad@me.com', displayName: 'Dad' },
        { address: 'sis@me.com', displayName: 'Sarah' },
      ],
      lastText: 'Dinner Sunday?',
      ageMs: 2 * 3600_000,
      pinned: true,
      rowId: 103,
    },
    {
      guid: 'c-work',
      title: 'Eng Standup',
      participants: [
        { address: 'lee@work.com', displayName: 'Lee' },
        { address: 'pat@work.com', displayName: 'Pat' },
        { address: 'jo@work.com', displayName: 'Jo' },
      ],
      lastText: 'PR is merged ✅',
      fromMe: true,
      ageMs: 5 * 3600_000,
      muted: true,
      read: true,
      rowId: 104,
    },
    {
      guid: 'c-tim',
      participants: [{ address: 'tim@apple.com', displayName: 'Tim Cook' }],
      lastText: 'Sent you the keynote draft',
      ageMs: 26 * 3600_000,
      rowId: 105,
    },
    {
      guid: 'c-pizza',
      participants: [{ address: '+15559876543', displayName: 'Tony’s Pizza' }],
      lastText: 'Your order is on the way 🍕',
      ageMs: 3 * DAY,
      read: true,
      rowId: 106,
    },
    {
      guid: 'c-alex',
      participants: [{ address: 'alex@x.com', displayName: 'Alex Rivera' }],
      lastText: 'haha that meme 😂',
      fromMe: true,
      ageMs: 6 * DAY,
      read: true,
      rowId: 107,
    },
    {
      guid: 'c-bank',
      participants: [{ address: 'alerts@bank.com', displayName: 'Bank Alerts' }],
      lastText: 'Your statement is ready',
      ageMs: 20 * DAY,
      muted: true,
      read: true,
      rowId: 108,
    },
    {
      guid: 'c-school',
      title: 'Class of ’24',
      participants: [
        { address: 'a@s.com', displayName: 'Ada' },
        { address: 'b@s.com', displayName: 'Bo' },
      ],
      lastText: 'Reunion photos posted',
      ageMs: 400 * DAY,
      read: true,
      rowId: 109,
    },
  ];
}

export async function seedFixtures(): Promise<number> {
  // DEV: real downloads (with progress) of public images, so the ring is visible
  // on-device without a server. Replaces the production expo fetcher.
  setAttachmentFetcher(devProgressFetcher);
  const db = getDatabase();
  const now = Date.now();
  const data = fixtures(now);

  for (const f of data) {
    const handleMap = await upsertHandles(
      db,
      f.participants.map((p) => ({ address: p.address, displayName: p.displayName })),
    );
    const chatMap = await upsertChats(
      db,
      [
        Chat.parse({
          guid: f.guid,
          displayName: f.title ?? null,
          style: f.participants.length > 1 ? 45 : 43,
          isPinned: f.pinned ?? false,
          muteType: f.muted ? 'mute' : null,
          participants: f.participants.map((p) => ({ address: p.address })),
        }),
      ],
      handleMap,
    );
    const chatId = chatMap.get(f.guid)!;
    const msgGuid = `${f.guid}-m`;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: msgGuid,
          text: f.lastText,
          isFromMe: f.fromMe ?? false,
          dateCreated: now - f.ageMs,
          originalROWID: f.rowId,
          handle: f.fromMe ? null : { address: f.participants[0]!.address },
        }),
      ],
      () => chatId,
      handleMap,
    );
    if (f.read) {
      await db
        .update(chatsTable)
        .set({ lastReadMessageGuid: msgGuid })
        .where(eq(chatsTable.guid, f.guid));
    }
  }

  // Give one chat a richer thread so the conversation view shows grouping,
  // a date separator (yesterday vs today), and a trailing outgoing status.
  const craigId = await getChatIdByGuid(db, 'c-craig');
  if (craigId != null) {
    const hm = await upsertHandles(db, [
      { address: 'craig@apple.com', displayName: 'Craig Federighi' },
    ]);
    const thread = [
      { guid: 'cr-1', text: 'Morning! ☀️', fromMe: false, ageMs: 28 * 3600_000, rowId: 201 },
      {
        guid: 'cr-2',
        text: 'You catch the keynote?',
        fromMe: false,
        ageMs: 28 * 3600_000 - 20_000,
        rowId: 202,
      },
      {
        guid: 'cr-3',
        text: 'Yeah, just watched it 🔥',
        fromMe: true,
        ageMs: 27 * 3600_000,
        rowId: 203,
      },
      { guid: 'cr-5', text: 'haha thanks 😄', fromMe: true, ageMs: 2 * 60_000, rowId: 205 },
    ];
    await upsertMessages(
      db,
      thread.map((m) =>
        Message.parse({
          guid: m.guid,
          text: m.text,
          isFromMe: m.fromMe,
          dateCreated: now - m.ageMs,
          originalROWID: m.rowId,
          handle: m.fromMe ? null : { address: 'craig@apple.com' },
        }),
      ),
      () => craigId,
      hm,
    );

    // Phase 7 fixtures: a tapback on "Morning! ☀️" and a threaded reply to "You catch the keynote?".
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'cr-react-1',
          isFromMe: false,
          dateCreated: now - 27 * 3600_000 + 5_000,
          originalROWID: 220,
          handle: { address: 'craig@apple.com' },
          associatedMessageGuid: 'cr-1',
          associatedMessageType: 'love',
        }),
        Message.parse({
          guid: 'cr-reply-1',
          text: 'Yes! Watched it twice',
          isFromMe: true,
          dateCreated: now - 26 * 3600_000,
          originalROWID: 221,
          threadOriginatorGuid: 'cr-2',
        }),
        // URL preview demo (Phase 7b): an OG-rich link renders a card on render.
        Message.parse({
          guid: 'cr-url-1',
          text: 'Project is here: https://github.com/munkledata',
          isFromMe: false,
          dateCreated: now - 25 * 3600_000,
          originalROWID: 222,
          handle: { address: 'craig@apple.com' },
        }),
      ],
      () => craigId,
      hm,
    );

    // Attachment fixtures: a rendered image, a blurhash-only image, a PDF chip.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'cr-img',
          isFromMe: false,
          dateCreated: now - 90_000,
          originalROWID: 206,
          hasAttachments: true,
          handle: { address: 'craig@apple.com' },
          attachments: [
            Attachment.parse({
              guid: 'cr-img-att',
              mimeType: 'image/jpeg',
              transferName: 'keynote.jpg',
              totalBytes: 240_000,
              width: 1200,
              height: 800,
              blurhash: SAMPLE_BLURHASH,
            }),
          ],
        }),
        Message.parse({
          guid: 'cr-blur',
          isFromMe: false,
          dateCreated: now - 80_000,
          originalROWID: 207,
          hasAttachments: true,
          handle: { address: 'craig@apple.com' },
          attachments: [
            Attachment.parse({
              guid: 'cr-blur-att',
              mimeType: 'image/jpeg',
              transferName: 'huge.jpg',
              totalBytes: 9_000_000, // > auto-download cap → stays on the blurhash placeholder
              width: 1000,
              height: 1300,
              blurhash: SAMPLE_BLURHASH,
            }),
          ],
        }),
        Message.parse({
          guid: 'cr-pdf',
          isFromMe: true,
          dateCreated: now - 70_000,
          originalROWID: 208,
          hasAttachments: true,
          attachments: [
            Attachment.parse({
              guid: 'cr-pdf-att',
              mimeType: 'application/pdf',
              transferName: 'Q3-Report.pdf',
              totalBytes: 2_500_000,
            }),
          ],
        }),
        // Auto-download image (no localPath, < 5 MB) → fires the dev fetcher on
        // mount → progress ring → reactive swap to the downloaded file.
        Message.parse({
          guid: 'cr-auto',
          isFromMe: false,
          dateCreated: now - 60_000,
          originalROWID: 209,
          hasAttachments: true,
          handle: { address: 'craig@apple.com' },
          attachments: [
            Attachment.parse({
              guid: 'cr-auto-att',
              mimeType: 'image/jpeg',
              transferName: 'auto.jpg',
              totalBytes: 400_000,
              width: 1200,
              height: 800,
              blurhash: SAMPLE_BLURHASH,
            }),
          ],
        }),
        // Video: blurhash poster + play badge → tap mounts the native player.
        Message.parse({
          guid: 'cr-vid',
          isFromMe: false,
          dateCreated: now - 50_000,
          originalROWID: 210,
          hasAttachments: true,
          handle: { address: 'craig@apple.com' },
          attachments: [
            Attachment.parse({
              guid: 'cr-vid-att',
              mimeType: 'video/mp4',
              transferName: 'sample.mp4',
              totalBytes: 2_000_000,
              width: 1280,
              height: 720,
              blurhash: SAMPLE_BLURHASH,
            }),
          ],
        }),
      ],
      () => craigId,
      hm,
    );
    // DEV: render the first image from a real remote URL (localPath is normally a
    // downloaded file://; for the demo this avoids needing a server).
    await updateAttachmentLocalPath(db, 'cr-img-att', 'https://picsum.photos/seed/bb/1200/800');
    // DEV: a public sample mp4 plays inline via expo-video (HTTPS streams directly).
    await updateAttachmentLocalPath(
      db,
      'cr-vid-att',
      'https://media.w3.org/2010/05/sintel/trailer.mp4',
    );
  }

  return data.length;
}

/** DEV: optimistically send an image (rendered from a remote URL, reconciled locally). */
export async function devSendFakeImage(chatGuid: string): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const tempGuid = generateTempGuid();
  const now = Date.now();
  await insertOutgoingAttachment(db, {
    tempGuid,
    attachmentGuid: `${tempGuid}-att`,
    chatId,
    chatGuid,
    localPath: `https://picsum.photos/seed/${tempGuid}/800/600`,
    mimeType: 'image/jpeg',
    transferName: 'photo.jpg',
    totalBytes: 180_000,
    width: 800,
    height: 600,
    now,
  });
  setTimeout(() => {
    void reconcileOutgoingSuccess(db, tempGuid, {
      guid: `real-${tempGuid}`,
      dateCreated: now,
      dateDelivered: Date.now(),
    });
  }, 700);
}

/**
 * DEV: optimistic send with a simulated server round-trip (no real server).
 * Inserts the temp message (`sending`), then reconciles to `sent` after a delay
 * — so the bubble visibly flips from Sending… to Delivered on-device.
 */
export async function devSendFake(
  chatGuid: string,
  text: string,
  effectId?: string,
): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const tempGuid = generateTempGuid();
  const now = Date.now();
  await insertOutgoingText(db, { tempGuid, chatId, chatGuid, text, now, effectId });
  setTimeout(() => {
    void reconcileOutgoingSuccess(db, tempGuid, {
      guid: `real-${tempGuid}`,
      dateCreated: now,
      dateDelivered: Date.now(),
    });
  }, 700);
}

/** DEV: optimistic tapback (pass '-love' to remove), reconciled locally. */
export async function devSendFakeReaction(
  chatGuid: string,
  targetGuid: string,
  reaction: string,
  emoji?: string,
): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const tempGuid = generateTempGuid();
  const now = Date.now();
  await insertOutgoingReaction(db, { tempGuid, chatId, chatGuid, targetGuid, reaction, emoji, now });
  setTimeout(() => {
    void reconcileOutgoingSuccess(db, tempGuid, {
      guid: `real-${tempGuid}`,
      dateCreated: now,
      dateDelivered: null,
    });
  }, 600);
}

/** DEV: locally edit a message's text (no server) so the bubble shows it + "Edited". */
export async function devEditFake(messageGuid: string, newText: string): Promise<void> {
  await applyLocalEdit(getDatabase(), messageGuid, newText, Date.now());
}

/** DEV: locally retract a message (no server) so the bubble becomes the tombstone. */
export async function devUnsendFake(messageGuid: string): Promise<void> {
  await applyLocalUnsend(getDatabase(), messageGuid, Date.now());
}

/** DEV: optimistic threaded reply (renders its quote), reconciled locally. */
export async function devSendFakeReply(
  chatGuid: string,
  text: string,
  replyToGuid: string,
  effectId?: string,
): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const tempGuid = generateTempGuid();
  const now = Date.now();
  await insertOutgoingText(db, {
    tempGuid,
    chatId,
    chatGuid,
    text,
    now,
    selectedMessageGuid: replyToGuid,
    threadOriginatorGuid: replyToGuid,
    effectId,
  });
  setTimeout(() => {
    void reconcileOutgoingSuccess(db, tempGuid, {
      guid: `real-${tempGuid}`,
      dateCreated: now,
      dateDelivered: Date.now(),
    });
  }, 700);
}

let injectCounter = 0;

/**
 * DEV: inject a fresh inbound message as if a push arrived. Routes through the
 * real pipeline (DevPushTransport → EventRouter → DB sink + Notifee), so this one
 * button exercises receive → DB → notification (with Reply/Mark-read). The chat
 * payload echoes the existing row's fields so the upsert preserves name/pins.
 */
export async function injectMessage(): Promise<void> {
  const db = getDatabase();
  const inbox = await listChatsForInbox(db, { includeArchived: true });
  const target = inbox[0];
  if (!target) return;
  injectCounter += 1;
  await devPush.inject('new-message', {
    guid: `inject-${injectCounter}-${target.guid}`,
    text: `Live update #${injectCounter} ⚡`,
    isFromMe: false,
    dateCreated: Date.now(),
    originalROWID: 100_000 + injectCounter,
    handle: { address: 'live@x.com', displayName: 'Live Sender' },
    chats: [
      {
        guid: target.guid,
        chatIdentifier: target.chatIdentifier,
        displayName: target.displayName,
        style: target.style,
        isArchived: !!target.isArchived,
        isPinned: !!target.isPinned,
        muteType: target.muteType,
      },
    ],
  });
}

let ftCounter = 0;

/** DEV: simulate an incoming FaceTime (ft-call-status-changed, status_id 4). */
export async function devInjectIncomingFaceTime(): Promise<void> {
  ftCounter += 1;
  await devPush.inject('ft-call-status-changed', {
    uuid: `dev-ft-${ftCounter}`,
    status_id: 4,
    address: 'Mom (dev)',
    is_audio: false,
    handle: { address: '+15558675309' },
  });
}

// Cycle through bubble + screen effects so repeated dev taps demo each one.
const EFFECT_CYCLE = [
  'com.apple.MobileSMS.expressivesend.impact', // slam
  'com.apple.MobileSMS.expressivesend.loud',
  'com.apple.MobileSMS.expressivesend.gentle',
  'com.apple.MobileSMS.expressivesend.invisibleink',
  'com.apple.messages.effect.CKConfettiEffect',
  'com.apple.messages.effect.CKHappyBirthdayEffect', // balloons
  'com.apple.messages.effect.CKFireworksEffect',
];
let effectIdx = 0;

/**
 * DEV: inject an inbound message carrying the next send-effect into a specific
 * chat (cycles through bubble + screen effects). Injecting into the OPEN chat lets
 * both the bubble animation and the full-screen overlay play in place.
 */
export async function devInjectEffect(chatGuid: string): Promise<void> {
  const db = getDatabase();
  const inbox = await listChatsForInbox(db, { includeArchived: true });
  const target = inbox.find((c) => c.guid === chatGuid) ?? inbox[0];
  if (!target) return;
  const effectId = EFFECT_CYCLE[effectIdx % EFFECT_CYCLE.length]!;
  effectIdx += 1;
  injectCounter += 1;
  await devPush.inject('new-message', {
    guid: `fx-${injectCounter}-${target.guid}`,
    text: effectId.split('.').pop() ?? 'effect',
    isFromMe: false,
    dateCreated: Date.now(),
    originalROWID: 100_000 + injectCounter,
    expressiveSendStyleId: effectId,
    handle: { address: 'live@x.com', displayName: 'Live Sender' },
    chats: [
      {
        guid: target.guid,
        chatIdentifier: target.chatIdentifier,
        displayName: target.displayName,
        style: target.style,
        isArchived: !!target.isArchived,
        isPinned: !!target.isPinned,
        muteType: target.muteType,
      },
    ],
  });
}
