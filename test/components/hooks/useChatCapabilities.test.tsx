import { ServerInfo } from '@core/models';
import type { ChatHeaderRow } from '@db/repositories';
import { useChatCapabilities } from '@features/conversations/useChatCapabilities';
import { useSessionStore } from '@state/sessionStore';
import { resolveChatService } from '@utils';
import { act, renderHook } from '../support/renderWithTheme';

const ONE_TO_ONE = 'iMessage;-;+15550001111';
const GROUP = 'iMessage;+;chat-1234';
const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.dGhyZWFkLTE`;

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

function serverInfo(fields: Record<string, unknown>): void {
  useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '2.0.15', ...fields }) });
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

describe('useChatCapabilities', () => {
  it('offers advertised iMessage features in a proven one-to-one iMessage chat', async () => {
    serverInfo(EVERY_IMESSAGE_FLAG);

    const caps = await capabilitiesFor(ONE_TO_ONE, header());

    expect(caps).toMatchObject({
      serverInfoLoaded: true,
      imessageAttachmentFeaturesAvailable: true,
      imessagePdfFeaturesAvailable: true,
      imessageScheduledAttachmentsAvailable: true,
      imessageCaptionFeaturesAvailable: true,
      imessageReactionsAvailable: true,
      imessageRepliesAvailable: true,
      imessageEditsAvailable: true,
      imessageUnsendsAvailable: true,
      imessageRemoteDeleteAvailable: true,
      imessageEffectsAvailable: true,
      imessageFormattedAvailable: true,
      imessageVoiceAvailable: true,
      typingFeaturesAvailable: true,
      voiceFeaturesAvailable: true,
      attachmentFeaturesAvailable: true,
      contactCardAvailable: true,
      currentLocationAvailable: true,
      imessageMentionsAvailable: false,
      rcsInteractiveFeaturesAvailable: false,
    });
  });

  it('offers nothing chat-specific while the header belongs to another chat', async () => {
    serverInfo(EVERY_IMESSAGE_FLAG);

    const caps = await capabilitiesFor(ONE_TO_ONE, header({ guid: 'iMessage;-;+15559999999' }));

    expect(caps.imessageRepliesAvailable).toBe(false);
    expect(caps.imessageAttachmentFeaturesAvailable).toBe(false);
    expect(caps.attachmentFeaturesAvailable).toBe(false);
    expect(caps.contactCardAvailable).toBe(false);
    expect(caps.currentLocationAvailable).toBe(false);
  });

  it('turns each feature off when the server stops advertising it', async () => {
    serverInfo({ ...EVERY_IMESSAGE_FLAG, supports_imessage_replies: false });

    const caps = await capabilitiesFor(ONE_TO_ONE, header());

    expect(caps.imessageRepliesAvailable).toBe(false);
    expect(caps.imessageEditsAvailable).toBe(true);
  });

  it('offers effects only when the one-to-one chat has exactly one other participant', async () => {
    serverInfo(EVERY_IMESSAGE_FLAG);

    const caps = await capabilitiesFor(ONE_TO_ONE, header({ participantCount: 2 }));

    expect(caps.imessageEffectsAvailable).toBe(false);
    expect(caps.imessageRepliesAvailable).toBe(true);
  });

  it('offers mentions and Mac remote delete, but not one-to-one features, in a proven group', async () => {
    serverInfo(EVERY_IMESSAGE_FLAG);

    const caps = await capabilitiesFor(GROUP, GROUP_HEADER);

    expect(caps.imessageMentionsAvailable).toBe(true);
    expect(caps.imessageRemoteDeleteAvailable).toBe(true);
    expect(caps.imessageRepliesAvailable).toBe(false);
    expect(caps.mentionParticipants).toEqual([
      { address: 'ann@example.com', label: 'Ann' },
      { address: 'ben@example.com', label: 'Ben' },
    ]);
  });

  it('offers no mention targets when the member list is incomplete or ambiguous', async () => {
    serverInfo(EVERY_IMESSAGE_FLAG);

    const duplicate = await capabilitiesFor(
      GROUP,
      header({ ...GROUP_HEADER, participantAddresses: 'ann@example.com|||ann@example.com' }),
    );
    const missing = await capabilitiesFor(
      GROUP,
      header({ ...GROUP_HEADER, participantAddresses: 'ann@example.com' }),
    );

    expect(duplicate.mentionParticipants).toEqual([]);
    expect(missing.mentionParticipants).toEqual([]);
  });

  it('turns RCS features off as soon as the RCS provider changes while the chat is open', async () => {
    const rcsHeader = header({ guid: RCS_GUID, handleServices: 'RCS' });
    serverInfo({
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: RCS_PROVIDER_EPOCH,
    });
    const { result } = await renderHook(() =>
      useChatCapabilities(RCS_GUID, rcsHeader, resolveChatService(RCS_GUID, 'RCS')),
    );
    expect(result.current).toMatchObject({
      rcsAvailable: true,
      rcsInteractiveFeaturesAvailable: true,
      typingFeaturesAvailable: true,
      voiceFeaturesAvailable: true,
      attachmentFeaturesAvailable: true,
      contactCardAvailable: true,
      currentLocationAvailable: false,
      imessageRepliesAvailable: false,
    });

    await act(async () => {
      serverInfo({ rcs: true, supports_rcs_epoch_qualified_ids: true, rcs_provider_epoch: null });
    });

    expect(result.current.rcsInteractiveFeaturesAvailable).toBe(false);
    expect(result.current.attachmentFeaturesAvailable).toBe(false);
    expect(result.current.contactCardAvailable).toBe(false);
  });
});
