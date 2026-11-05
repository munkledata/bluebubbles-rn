import { ServerInfo } from '@core/models';
import type { ChatHeaderRow } from '@db/repositories';
import { useChatCapabilities } from '@features/conversations/useChatCapabilities';
import { useSessionStore } from '@state/sessionStore';
import { resolveChatService } from '@utils';
import { act, renderHook } from '../support/renderWithTheme';

const ONE_TO_ONE = 'iMessage;-;+15550001111';
const GROUP = 'iMessage;+;chat-1234';
const ANY_GROUP = 'any;+;chat-1234';

const EVERY_IMESSAGE_FLAG = {
  supports_imessage_attachment_upload: true,
  supports_imessage_attachment_caption_upload: true,
  supports_imessage_pdf_attachment_upload: true,
  supports_imessage_reactions: true,
  supports_imessage_replies: true,
  supports_imessage_edit: true,
  supports_imessage_unsend: true,
  supports_imessage_remote_delete: true,
  supports_imessage_effects: true,
  supports_imessage_mentions: true,
  supports_imessage_formatted_messages: true,
  supports_imessage_typing: true,
  supports_imessage_voice_upload: true,
  supports_imessage_scheduled_attachment: true,
  supports_send_contact: true,
  supports_imessage_location: true,
};

async function serverInfo(fields: Record<string, unknown>): Promise<void> {
  // Hooks rendered earlier in the same test are still mounted, so publish inside act.
  await act(async () => {
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '2.0.15', ...fields }) });
  });
}

function header(overrides: Partial<ChatHeaderRow> = {}): ChatHeaderRow {
  return {
    id: 1,
    guid: ONE_TO_ONE,
    chatIdentifier: null,
    displayName: null,
    customName: null,
    customColor: null,
    muteType: null,
    style: 45,
    participantCount: 1,
    participantNames: '["Ann"]',
    participantAvatars: null,
    participantAddresses: '+15550001111',
    handleServices: 'iMessage',
    ...overrides,
  };
}

const GROUP_HEADER = header({
  guid: GROUP,
  style: 43,
  participantCount: 2,
  participantNames: '["Ann","Ben"]',
  participantAddresses: 'ann@example.com|||ben@example.com',
  handleServices: 'iMessage,iMessage',
});

async function capabilitiesFor(guid: string, row: ChatHeaderRow | null) {
  const { result } = await renderHook(() =>
    useChatCapabilities(guid, row, resolveChatService(guid, row?.handleServices)),
  );
  return result.current;
}

afterEach(() => {
  useSessionStore.setState({ serverInfo: null });
});

const RESTORED_ON = {
  supports_imessage_group_reactions: true,
  supports_imessage_emoji_reactions: true,
  supports_imessage_part_reactions: true,
  supports_imessage_group_replies: true,
  supports_imessage_part_replies: true,
  supports_imessage_group_edit: true,
  supports_imessage_group_unsend: true,
  supports_imessage_group_effects: true,
  supports_imessage_group_read_state: true,
  supports_imessage_group_contact: true,
  supports_imessage_group_location: true,
  supports_imessage_attachments_v2: true,
  supports_imessage_group_attachment_upload: true,
  supports_imessage_subject: true,
};

const ANY_GROUP_HEADER = { ...GROUP_HEADER, guid: ANY_GROUP };

/** The restored group features this app can send: tapbacks, replies, edits and unsends. */
const PART_ONE_KEYS = [
  'imessageReactionsAvailable',
  'imessageEmojiReactionsAvailable',
  'imessagePartReactionsAvailable',
  'imessageRepliesAvailable',
  'imessagePartRepliesAvailable',
  'imessageEditsAvailable',
  'imessageUnsendsAvailable',
] as const;

/** Group features whose restored switches the app ignores, because it cannot send them yet. */
const NOT_YET_SENDABLE_KEYS = [
  'imessageEffectsAvailable',
  'contactCardAvailable',
  'currentLocationAvailable',
] as const;

const GROUP_RESTORED_KEYS = [...PART_ONE_KEYS, ...NOT_YET_SENDABLE_KEYS] as const;

describe('useChatCapabilities FP-006 restored flags', () => {
  it('keeps every group feature off in a group when the restored flags are absent', async () => {
    await serverInfo(EVERY_IMESSAGE_FLAG);
    for (const [guid, row] of [
      [GROUP, GROUP_HEADER],
      [ANY_GROUP, ANY_GROUP_HEADER],
    ] as const) {
      const caps = await capabilitiesFor(guid, row);
      for (const key of GROUP_RESTORED_KEYS) expect([key, caps[key]]).toEqual([key, false]);
      // The reviewed group features are unchanged: mentions need iMessage;+; exactly.
      expect(caps.imessageMentionsAvailable).toBe(guid === GROUP);
    }
  });

  it('opens only the sendable group features in an iMessage;+; and any;+; group with every flag on', async () => {
    await serverInfo(RESTORED_ON);
    for (const [guid, row] of [
      [GROUP, GROUP_HEADER],
      [ANY_GROUP, ANY_GROUP_HEADER],
    ] as const) {
      const caps = await capabilitiesFor(guid, row);
      for (const key of PART_ONE_KEYS) expect([key, caps[key]]).toEqual([key, true]);
      // Advertised but not yet sendable by this app: never offered.
      for (const key of NOT_YET_SENDABLE_KEYS) expect([key, caps[key]]).toEqual([key, false]);
      // Mentions keep their own switch, which is off here (useChatCapabilitiesGroupCommands.test).
      expect(caps.imessageMentionsAvailable).toBe(false);
    }
  });

  it('opens one sendable group feature per flag and nothing for the other restored flags', async () => {
    const pairs: [keyof typeof RESTORED_ON, (typeof GROUP_RESTORED_KEYS)[number][]][] = [
      ['supports_imessage_group_reactions', ['imessageReactionsAvailable']],
      ['supports_imessage_group_replies', ['imessageRepliesAvailable']],
      ['supports_imessage_group_edit', ['imessageEditsAvailable']],
      ['supports_imessage_group_unsend', ['imessageUnsendsAvailable']],
      ['supports_imessage_group_effects', []],
      ['supports_imessage_group_read_state', []],
      ['supports_imessage_group_contact', []],
      ['supports_imessage_group_location', []],
      ['supports_imessage_attachments_v2', []],
      ['supports_imessage_group_attachment_upload', []],
      ['supports_imessage_subject', []],
    ];
    for (const [flag, keys] of pairs) {
      await serverInfo({ [flag]: true });
      const caps = await capabilitiesFor(ANY_GROUP, ANY_GROUP_HEADER);
      const on = GROUP_RESTORED_KEYS.filter((candidate) => caps[candidate]);
      expect([flag, on]).toEqual([flag, keys]);
    }
  });

  it('opens restored file sends (part 2): one-to-one with the v2 switch, groups with both', async () => {
    const keys = [
      'imessageRestoredAttachmentsAvailable',
      'imessageAttachmentFeaturesAvailable',
      'attachmentFeaturesAvailable',
      'imessageCaptionFeaturesAvailable',
    ] as const;
    const cases: [Record<string, boolean>, string, ChatHeaderRow, boolean][] = [
      [{ supports_imessage_attachments_v2: true }, ONE_TO_ONE, header(), true],
      [{ supports_imessage_attachments_v2: true }, ANY_GROUP, ANY_GROUP_HEADER, false],
      [{ supports_imessage_group_attachment_upload: true }, ANY_GROUP, ANY_GROUP_HEADER, false],
      [
        { supports_imessage_attachments_v2: true, supports_imessage_group_attachment_upload: true },
        ANY_GROUP,
        ANY_GROUP_HEADER,
        true,
      ],
      [
        { supports_imessage_attachments_v2: true, supports_imessage_group_attachment_upload: true },
        ANY_GROUP,
        { ...ANY_GROUP_HEADER, handleServices: 'iMessage,SMS' },
        false,
      ],
    ];
    for (const [flags, guid, row, expected] of cases) {
      await serverInfo(flags);
      const caps = await capabilitiesFor(guid, row);
      for (const key of keys)
        expect([flags, guid, key, caps[key]]).toEqual([flags, guid, key, expected]);
      // The narrow route and scheduled files keep their own reviewed switches.
      expect(caps.imessageNarrowAttachmentsAvailable).toBe(false);
      expect(caps.imessageScheduledAttachmentsAvailable).toBe(false);
    }
  });

  it('leaves one-to-one features on their reviewed flags when every restored flag is on', async () => {
    await serverInfo(RESTORED_ON);
    const caps = await capabilitiesFor(ONE_TO_ONE, header());
    for (const key of GROUP_RESTORED_KEYS) expect([key, caps[key]]).toEqual([key, false]);
  });

  it('never proves an any;+; group whose members are not all iMessage', async () => {
    await serverInfo(RESTORED_ON);
    const smsGroup = { ...ANY_GROUP_HEADER, handleServices: 'iMessage,SMS' };
    const caps = await capabilitiesFor(ANY_GROUP, smsGroup);
    for (const key of GROUP_RESTORED_KEYS) expect([key, caps[key]]).toEqual([key, false]);
  });

  it('adds emoji and part tapbacks and part replies one-to-one only on top of the reviewed flags', async () => {
    await serverInfo({
      supports_imessage_emoji_reactions: true,
      supports_imessage_part_reactions: true,
      supports_imessage_part_replies: true,
    });
    let caps = await capabilitiesFor(ONE_TO_ONE, header());
    expect(caps.imessageEmojiReactionsAvailable).toBe(false);
    expect(caps.imessagePartRepliesAvailable).toBe(false);
    await serverInfo({
      supports_imessage_reactions: true,
      supports_imessage_replies: true,
      supports_imessage_emoji_reactions: true,
      supports_imessage_part_reactions: true,
      supports_imessage_part_replies: true,
    });
    caps = await capabilitiesFor(ONE_TO_ONE, header());
    expect(caps.imessageEmojiReactionsAvailable).toBe(true);
    expect(caps.imessagePartReactionsAvailable).toBe(true);
    expect(caps.imessagePartRepliesAvailable).toBe(true);
  });
});
