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

const GROUP_RESTORED_KEYS = [
  'imessageReactionsAvailable',
  'imessageEmojiReactionsAvailable',
  'imessagePartReactionsAvailable',
  'imessageRepliesAvailable',
  'imessagePartRepliesAvailable',
  'imessageEditsAvailable',
  'imessageUnsendsAvailable',
  'imessageEffectsAvailable',
  'contactCardAvailable',
  'currentLocationAvailable',
  'imessageMultiAttachmentAvailable',
  'imessageSubjectAvailable',
] as const;

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

  it('opens each group feature in an iMessage;+; and any;+; group when its flag is on', async () => {
    await serverInfo(RESTORED_ON);
    for (const [guid, row] of [
      [GROUP, GROUP_HEADER],
      [ANY_GROUP, ANY_GROUP_HEADER],
    ] as const) {
      const caps = await capabilitiesFor(guid, row);
      for (const key of GROUP_RESTORED_KEYS) expect([key, caps[key]]).toEqual([key, true]);
      // Mentions and remote delete keep their reviewed iMessage;+; proof.
      expect(caps.imessageMentionsAvailable).toBe(false);
    }
  });

  it('opens one group feature per flag', async () => {
    const pairs: [keyof typeof RESTORED_ON, (typeof GROUP_RESTORED_KEYS)[number]][] = [
      ['supports_imessage_group_reactions', 'imessageReactionsAvailable'],
      ['supports_imessage_group_replies', 'imessageRepliesAvailable'],
      ['supports_imessage_group_edit', 'imessageEditsAvailable'],
      ['supports_imessage_group_unsend', 'imessageUnsendsAvailable'],
      ['supports_imessage_group_effects', 'imessageEffectsAvailable'],
      ['supports_imessage_group_contact', 'contactCardAvailable'],
      ['supports_imessage_group_location', 'currentLocationAvailable'],
      ['supports_imessage_subject', 'imessageSubjectAvailable'],
    ];
    for (const [flag, key] of pairs) {
      await serverInfo({ [flag]: true });
      const caps = await capabilitiesFor(ANY_GROUP, ANY_GROUP_HEADER);
      const on = GROUP_RESTORED_KEYS.filter((candidate) => caps[candidate]);
      expect([flag, on]).toEqual([flag, [key]]);
    }
  });

  it('needs both attachment flags in a group and only v2 one-to-one', async () => {
    await serverInfo({ supports_imessage_attachments_v2: true });
    expect(
      (await capabilitiesFor(ANY_GROUP, ANY_GROUP_HEADER)).imessageMultiAttachmentAvailable,
    ).toBe(false);
    expect((await capabilitiesFor(ONE_TO_ONE, header())).imessageMultiAttachmentAvailable).toBe(
      true,
    );
    await serverInfo({ supports_imessage_group_attachment_upload: true });
    expect(
      (await capabilitiesFor(ANY_GROUP, ANY_GROUP_HEADER)).imessageMultiAttachmentAvailable,
    ).toBe(false);
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
