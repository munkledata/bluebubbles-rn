import { Attachment, Chat, Message, ServerInfo } from '@core/models';
import { classifyRcsEventAdmission } from '@core/rcs';
import {
  classifyRcsMessageRecord,
  currentRcsProviderEpoch,
  isCurrentRcsAttachmentGuid,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
  parseRcsAttachmentGuid,
  parseRcsChatGuid,
  parseRcsMessageGuid,
} from '@core/rcs/providerIdentity';

const EPOCH_A = `gpe1_${'A'.repeat(43)}`;
const EPOCH_B = `gpe1_${'B'.repeat(42)}A`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const CHAT_A = `RCS;-;g1.${EPOCH_A}.${encoded('conversation-a')}`;
const MESSAGE_A = `rcs-g1.${EPOCH_A}.${encoded('message-a')}`;
const CHAT_B = `RCS;-;g1.${EPOCH_B}.${encoded('conversation-a')}`;
const MESSAGE_B = `rcs-g1.${EPOCH_B}.${encoded('message-a')}`;
const ATTACHMENT_A = `rcs-media-g1.${EPOCH_A}.${encoded('message-a')}.${encoded('media-a')}`;

describe('Google provider-scoped RCS identities', () => {
  const info = ServerInfo.parse({
    version: '2.0.0',
    rcs: true,
    supports_rcs_epoch_qualified_ids: true,
    rcs_provider_epoch: EPOCH_A,
  });

  it('parses the three qualified wire identifiers without decoding their source ids', () => {
    expect(parseRcsChatGuid(CHAT_A)).toEqual({
      providerEpoch: EPOCH_A,
      encodedConversationId: encoded('conversation-a'),
    });
    expect(parseRcsMessageGuid(MESSAGE_A)).toEqual({
      providerEpoch: EPOCH_A,
      encodedMessageId: encoded('message-a'),
    });
    expect(parseRcsAttachmentGuid(ATTACHMENT_A)).toEqual({
      providerEpoch: EPOCH_A,
      encodedMessageId: encoded('message-a'),
      encodedMediaId: encoded('media-a'),
    });
  });

  it('keeps legacy, malformed, and different-pairing ids out of the mutation boundary', () => {
    expect(parseRcsChatGuid('RCS;-;legacy-conversation')).toBeNull();
    expect(parseRcsMessageGuid('rcs-legacy-message')).toBeNull();
    expect(parseRcsAttachmentGuid('rcs-media-legacy')).toBeNull();
    expect(parseRcsChatGuid(`RCS;-;g1.${EPOCH_A}.not=cano`)).toBeNull();

    expect(currentRcsProviderEpoch(info)).toBe(EPOCH_A);
    expect(isCurrentRcsChatGuid(info, CHAT_A)).toBe(true);
    expect(isCurrentRcsMessageGuid(info, MESSAGE_A)).toBe(true);
    expect(isCurrentRcsAttachmentGuid(info, ATTACHMENT_A)).toBe(true);
    expect(isCurrentRcsChatGuid(info, `RCS;-;g1.${EPOCH_B}.${encoded('conversation-a')}`)).toBe(
      false,
    );
    expect(isCurrentRcsChatGuid({ ...info, supports_rcs_epoch_qualified_ids: false }, CHAT_A)).toBe(
      false,
    );
  });

  it('preserves the optional epoch on parsed chat, message, and attachment DTOs', () => {
    expect(Chat.parse({ guid: CHAT_A, providerEpoch: EPOCH_A }).providerEpoch).toBe(EPOCH_A);
    expect(Message.parse({ guid: MESSAGE_A, providerEpoch: EPOCH_A }).providerEpoch).toBe(EPOCH_A);
    expect(Attachment.parse({ guid: ATTACHMENT_A, providerEpoch: EPOCH_A }).providerEpoch).toBe(
      EPOCH_A,
    );
  });

  it('admits only exact current owners and defers RCS events while provider info is unavailable', () => {
    const currentMessage = Message.parse({
      guid: MESSAGE_A,
      providerEpoch: EPOCH_A,
      chatGuid: CHAT_A,
      chats: [{ guid: CHAT_A, providerEpoch: EPOCH_A }],
    });
    const staleMessage = Message.parse({
      guid: MESSAGE_B,
      providerEpoch: EPOCH_B,
      chatGuid: CHAT_B,
      chats: [{ guid: CHAT_B, providerEpoch: EPOCH_B }],
    });

    expect(classifyRcsMessageRecord(info, currentMessage, CHAT_A)).toBe('current');
    expect(classifyRcsMessageRecord(info, currentMessage, CHAT_B)).toBe('invalid');
    expect(
      classifyRcsMessageRecord(info, {
        ...currentMessage,
        associatedMessageGuid: MESSAGE_B,
      }),
    ).toBe('invalid');
    expect(
      classifyRcsEventAdmission(undefined, { type: 'new-message', message: currentMessage }),
    ).toBe('unavailable');
    expect(classifyRcsEventAdmission(info, { type: 'new-message', message: currentMessage })).toBe(
      'current',
    );
    expect(classifyRcsEventAdmission(info, { type: 'new-message', message: staleMessage })).toBe(
      'stale',
    );
    expect(
      classifyRcsEventAdmission(info, {
        type: 'typing-indicator',
        payload: { guid: CHAT_A, chatGuid: `${CHAT_A}-different`, display: true },
      }),
    ).toBe('stale');
    expect(
      classifyRcsEventAdmission(info, {
        type: 'rcs-alert',
        payload: { alertType: 'PHONE_NOT_RESPONDING' },
      }),
    ).toBe('stale');
    expect(
      classifyRcsEventAdmission(info, {
        type: 'rcs-bridge-down',
        payload: { providerEpoch: EPOCH_A, reason: 'offline' },
      }),
    ).toBe('current');
  });
});
