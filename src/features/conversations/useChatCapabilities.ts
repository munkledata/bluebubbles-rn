import { useMemo } from 'react';
import { currentRcsProviderEpoch, isCurrentRcsChatGuid } from '@core/rcs/providerIdentity';
import type { ChatHeaderRow } from '@db/repositories';
import type { ServerCapabilityFlag } from '@/services/capabilityGatedAction';
import { useSendAttachmentTextSupported, useSessionStore } from '@state/sessionStore';
import {
  isProvenIMessageGroupChat,
  isProvenOneToOneIMessageChat,
  participantList,
  type resolveChatService,
} from '@utils';

export interface MentionParticipant {
  address: string;
  label: string;
}

export interface ChatCapabilities {
  /** The server's current RCS provider owns this chat. */
  rcsAvailable: boolean;
  /**
   * New Message can start a chat: the server's current RCS provider, or text-only iMessage new
   * chat. Forward opens New Message, so it follows the inbox's New message button
   * (`ConversationListScreen`); New Message itself enforces each service's file and text limits.
   */
  newChatAvailable: boolean;
  serverInfoLoaded: boolean;
  /** RCS-only interactive features (reactions, typing, voice, attachments) for an RCS chat. */
  rcsInteractiveFeaturesAvailable: boolean;
  /** Send Contact: RCS, or an iMessage one-to-one chat whose server can send contact cards. */
  contactCardAvailable: boolean;
  /** Send Current Location: an iMessage one-to-one chat whose server can send locations. */
  currentLocationAvailable: boolean;
  supportsSendAttachmentText: boolean;
  imessageAttachmentFeaturesAvailable: boolean;
  imessagePdfFeaturesAvailable: boolean;
  imessageScheduledAttachmentsAvailable: boolean;
  imessageCaptionFeaturesAvailable: boolean;
  imessageReactionsAvailable: boolean;
  imessageRepliesAvailable: boolean;
  imessageEditsAvailable: boolean;
  imessageUnsendsAvailable: boolean;
  imessageRemoteDeleteAvailable: boolean;
  imessageEffectsAvailable: boolean;
  imessageFormattedAvailable: boolean;
  imessageMentionsAvailable: boolean;
  /** Group members a mention can name; empty unless every member has a unique, clean address. */
  mentionParticipants: MentionParticipant[];
  imessageVoiceAvailable: boolean;
  typingFeaturesAvailable: boolean;
  voiceFeaturesAvailable: boolean;
  attachmentFeaturesAvailable: boolean;
}

function useServerSupports(flag: ServerCapabilityFlag): boolean {
  return useSessionStore((s) => s.serverInfo?.[flag] === true);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * What the open chat can do right now: which composer, message-action and attachment features the
 * chat screen offers.
 *
 * A server flag alone is not enough for an iMessage feature. The chat's own header, loaded for this
 * exact chat, must also prove an iMessage chat of the right shape: one-to-one for most features, a
 * group for mentions, either for Mac remote delete. RCS features need the server's current RCS
 * provider to own this chat. Every value follows the live session and header, so a capability lost
 * while the chat is open turns its feature off at the next render.
 */
export function useChatCapabilities(
  guid: string,
  header: ChatHeaderRow | null | undefined,
  chatService: ReturnType<typeof resolveChatService>,
): ChatCapabilities {
  const rcsAvailable = useSessionStore((s) => isCurrentRcsChatGuid(s.serverInfo, guid));
  const newChatAvailable = useSessionStore(
    (s) =>
      currentRcsProviderEpoch(s.serverInfo) !== null ||
      s.serverInfo?.supports_imessage_new_chat === true,
  );
  const serverInfoLoaded = useSessionStore((s) => s.serverInfo != null);
  const attachmentSupported = useServerSupports('supports_imessage_attachment_upload');
  const pdfSupported = useServerSupports('supports_imessage_pdf_attachment_upload');
  const reactionSupported = useServerSupports('supports_imessage_reactions');
  const replySupported = useServerSupports('supports_imessage_replies');
  const editSupported = useServerSupports('supports_imessage_edit');
  const unsendSupported = useServerSupports('supports_imessage_unsend');
  const remoteDeleteSupported = useServerSupports('supports_imessage_remote_delete');
  const effectsSupported = useServerSupports('supports_imessage_effects');
  const mentionsSupported = useServerSupports('supports_imessage_mentions');
  const formattedSupported = useServerSupports('supports_imessage_formatted_messages');
  const typingSupported = useServerSupports('supports_imessage_typing');
  const voiceSupported = useServerSupports('supports_imessage_voice_upload');
  const scheduledAttachmentSupported = useServerSupports('supports_imessage_scheduled_attachment');
  const contactSupported = useServerSupports('supports_send_contact');
  const locationSupported = useServerSupports('supports_imessage_location');
  const supportsSendAttachmentText = useSendAttachmentTextSupported(chatService);

  // The header must be this chat's own row, so a recycled screen never borrows another chat's proof.
  const exactIMessageHeader = chatService === 'iMessage' && header?.guid === guid;
  const oneToOne = exactIMessageHeader && isProvenOneToOneIMessageChat(header);
  const group = exactIMessageHeader && isProvenIMessageGroupChat(header);
  const rcsInteractiveFeaturesAvailable = rcsAvailable && chatService === 'RCS';

  const imessageAttachmentFeaturesAvailable = attachmentSupported && oneToOne;
  const imessageMentionsAvailable = mentionsSupported && group;
  const mentionParticipants = useMemo((): MentionParticipant[] => {
    if (!imessageMentionsAvailable || !header) return [];
    const names = participantList(header.participantNames);
    const addresses = (header.participantAddresses ?? '').split('|||');
    if (addresses.length !== header.participantCount || names.length !== header.participantCount) {
      return [];
    }
    const participants = addresses.map((address, index) => {
      const rawName = names[index]?.trim() ?? '';
      const label = rawName && !CONTROL_CHARACTERS.test(rawName) ? rawName : address;
      return { address, label };
    });
    const hasUniqueAddresses =
      new Set(participants.map((participant) => participant.address)).size === participants.length;
    return hasUniqueAddresses &&
      participants.every(
        (participant) =>
          participant.address.length > 0 &&
          participant.address === participant.address.trim() &&
          !CONTROL_CHARACTERS.test(participant.address) &&
          participant.label.length > 0,
      )
      ? participants
      : [];
  }, [header, imessageMentionsAvailable]);
  const imessageVoiceAvailable = voiceSupported && oneToOne;

  return {
    rcsAvailable,
    newChatAvailable,
    serverInfoLoaded,
    rcsInteractiveFeaturesAvailable,
    contactCardAvailable: rcsInteractiveFeaturesAvailable || (contactSupported && oneToOne),
    currentLocationAvailable: locationSupported && oneToOne,
    supportsSendAttachmentText,
    imessageAttachmentFeaturesAvailable,
    imessagePdfFeaturesAvailable: imessageAttachmentFeaturesAvailable && pdfSupported,
    imessageScheduledAttachmentsAvailable:
      imessageAttachmentFeaturesAvailable && scheduledAttachmentSupported,
    imessageCaptionFeaturesAvailable:
      imessageAttachmentFeaturesAvailable && supportsSendAttachmentText,
    imessageReactionsAvailable: reactionSupported && oneToOne,
    imessageRepliesAvailable: replySupported && oneToOne,
    imessageEditsAvailable: editSupported && oneToOne,
    imessageUnsendsAvailable: unsendSupported && oneToOne,
    imessageRemoteDeleteAvailable: remoteDeleteSupported && (oneToOne || group),
    imessageEffectsAvailable: effectsSupported && oneToOne && header?.participantCount === 1,
    imessageFormattedAvailable: formattedSupported && oneToOne,
    imessageMentionsAvailable,
    mentionParticipants,
    imessageVoiceAvailable,
    typingFeaturesAvailable: rcsInteractiveFeaturesAvailable || (typingSupported && oneToOne),
    voiceFeaturesAvailable: rcsInteractiveFeaturesAvailable || imessageVoiceAvailable,
    attachmentFeaturesAvailable:
      rcsInteractiveFeaturesAvailable || imessageAttachmentFeaturesAvailable,
  };
}
