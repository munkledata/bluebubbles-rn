/**
 * Google Messages identifiers are reusable after a phone is paired again. The server therefore
 * scopes every durable RCS identifier to one opaque pairing epoch. These helpers deliberately
 * inspect only that public envelope; the encoded source ids remain opaque to the app.
 */

export const RCS_PROVIDER_EPOCH_PATTERN = /^gpe1_[A-Za-z0-9_-]{43}$/;

export interface RcsProviderServerInfo {
  readonly rcs?: boolean | null;
  readonly supports_rcs_epoch_qualified_ids?: boolean | null;
  readonly rcs_provider_epoch?: string | null;
}

export interface ParsedRcsChatGuid {
  readonly providerEpoch: string;
  readonly encodedConversationId: string;
}

export interface ParsedRcsMessageGuid {
  readonly providerEpoch: string;
  readonly encodedMessageId: string;
}

export interface ParsedRcsAttachmentGuid {
  readonly providerEpoch: string;
  readonly encodedMessageId: string;
  readonly encodedMediaId: string;
}

export type RcsRecordAdmission = 'non-rcs' | 'current' | 'invalid';

/** Minimal wire shapes used by sync/realtime admission without importing the model graph. */
export interface RcsAttachmentRecord {
  readonly guid: string;
  readonly providerEpoch?: string | null;
}

export interface RcsChatRecord {
  readonly guid: string;
  readonly providerEpoch?: string | null;
}

export interface RcsMessageRecord {
  readonly guid: string;
  readonly providerEpoch?: string | null;
  readonly chatGuid?: string | null;
  readonly associatedMessageGuid?: string | null;
  readonly chats?: readonly RcsChatRecord[] | null;
  readonly attachments?: readonly RcsAttachmentRecord[] | null;
}

export function looksLikeRcsChatGuid(value: unknown): value is string {
  return typeof value === 'string' && /^rcs;-;/i.test(value);
}

export function looksLikeRcsMessageGuid(value: unknown): value is string {
  return typeof value === 'string' && /^rcs-/i.test(value);
}

export function looksLikeRcsAttachmentGuid(value: unknown): value is string {
  return typeof value === 'string' && /^rcs-media-/i.test(value);
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Validate an unpadded canonical base64url segment without decoding its private source value. */
export function isCanonicalBase64Url(value: string): boolean {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const finalIndex = BASE64URL_ALPHABET.indexOf(value[value.length - 1]!);
  switch (value.length % 4) {
    case 2:
      return (finalIndex & 0b1111) === 0;
    case 3:
      return (finalIndex & 0b11) === 0;
    default:
      return true;
  }
}

export function isRcsProviderEpoch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    RCS_PROVIDER_EPOCH_PATTERN.test(value) &&
    isCanonicalBase64Url(value.slice('gpe1_'.length))
  );
}

function parseTwoPartIdentity(value: string, prefix: string): [string, string] | null {
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split('.');
  const providerEpoch = parts[0];
  const encodedSourceId = parts[1];
  if (
    parts.length !== 2 ||
    !isRcsProviderEpoch(providerEpoch) ||
    !encodedSourceId ||
    !isCanonicalBase64Url(encodedSourceId)
  ) {
    return null;
  }
  return [providerEpoch, encodedSourceId];
}

export function parseRcsChatGuid(value: string | null | undefined): ParsedRcsChatGuid | null {
  if (!value) return null;
  const parsed = parseTwoPartIdentity(value, 'RCS;-;g1.');
  return parsed
    ? Object.freeze({ providerEpoch: parsed[0], encodedConversationId: parsed[1] })
    : null;
}

export function parseRcsMessageGuid(value: string | null | undefined): ParsedRcsMessageGuid | null {
  if (!value) return null;
  const parsed = parseTwoPartIdentity(value, 'rcs-g1.');
  return parsed ? Object.freeze({ providerEpoch: parsed[0], encodedMessageId: parsed[1] }) : null;
}

export function parseRcsAttachmentGuid(
  value: string | null | undefined,
): ParsedRcsAttachmentGuid | null {
  if (!value?.startsWith('rcs-media-g1.')) return null;
  const parts = value.slice('rcs-media-g1.'.length).split('.');
  const providerEpoch = parts[0];
  const encodedMessageId = parts[1];
  const encodedMediaId = parts[2];
  if (
    parts.length !== 3 ||
    !isRcsProviderEpoch(providerEpoch) ||
    !encodedMessageId ||
    !encodedMediaId ||
    !isCanonicalBase64Url(encodedMessageId) ||
    !isCanonicalBase64Url(encodedMediaId)
  ) {
    return null;
  }
  return Object.freeze({ providerEpoch, encodedMessageId, encodedMediaId });
}

/** A pairing epoch is usable only when the server advertises the complete qualified-id contract. */
export function currentRcsProviderEpoch(
  info: RcsProviderServerInfo | null | undefined,
): string | null {
  return info?.rcs === true &&
    info.supports_rcs_epoch_qualified_ids === true &&
    isRcsProviderEpoch(info.rcs_provider_epoch)
    ? info.rcs_provider_epoch
    : null;
}

export function isCurrentRcsChatGuid(
  info: RcsProviderServerInfo | null | undefined,
  chatGuid: string | null | undefined,
): boolean {
  const currentEpoch = currentRcsProviderEpoch(info);
  return currentEpoch !== null && parseRcsChatGuid(chatGuid)?.providerEpoch === currentEpoch;
}

export function isCurrentRcsMessageGuid(
  info: RcsProviderServerInfo | null | undefined,
  messageGuid: string | null | undefined,
): boolean {
  const currentEpoch = currentRcsProviderEpoch(info);
  return currentEpoch !== null && parseRcsMessageGuid(messageGuid)?.providerEpoch === currentEpoch;
}

export function isCurrentRcsAttachmentGuid(
  info: RcsProviderServerInfo | null | undefined,
  attachmentGuid: string | null | undefined,
): boolean {
  const currentEpoch = currentRcsProviderEpoch(info);
  return (
    currentEpoch !== null && parseRcsAttachmentGuid(attachmentGuid)?.providerEpoch === currentEpoch
  );
}

function agreesWithEpoch(value: string | null | undefined, epoch: string): boolean {
  return value == null || value === epoch;
}

/**
 * Admit ordinary Apple records unchanged, but require every RCS-looking chat identity to be a
 * qualified id for the server's exact current pairing epoch. Legacy and old-epoch rows are still
 * valid local history; this helper is only for deciding whether a newly received row may mutate
 * local state.
 */
export function classifyRcsChatRecord(
  info: RcsProviderServerInfo | null | undefined,
  chat: RcsChatRecord,
): RcsRecordAdmission {
  const looksRcs = looksLikeRcsChatGuid(chat.guid) || chat.providerEpoch != null;
  if (!looksRcs) return 'non-rcs';
  const epoch = currentRcsProviderEpoch(info);
  const parsed = parseRcsChatGuid(chat.guid);
  return epoch != null &&
    parsed?.providerEpoch === epoch &&
    agreesWithEpoch(chat.providerEpoch, epoch)
    ? 'current'
    : 'invalid';
}

export function classifyRcsAttachmentRecord(
  info: RcsProviderServerInfo | null | undefined,
  attachment: RcsAttachmentRecord,
  expectedEncodedMessageId?: string,
): RcsRecordAdmission {
  const looksRcs = looksLikeRcsAttachmentGuid(attachment.guid) || attachment.providerEpoch != null;
  if (!looksRcs) return 'non-rcs';
  const epoch = currentRcsProviderEpoch(info);
  const parsed = parseRcsAttachmentGuid(attachment.guid);
  return epoch != null &&
    parsed?.providerEpoch === epoch &&
    agreesWithEpoch(attachment.providerEpoch, epoch) &&
    (expectedEncodedMessageId == null || parsed.encodedMessageId === expectedEncodedMessageId)
    ? 'current'
    : 'invalid';
}

/**
 * Validate the complete RCS identity envelope carried by one message. When an expected owner is
 * supplied (chat-page sync or a resolved live owner), it must be the exact current chat. Without
 * one, a lean live update may be provisionally admitted by its message id and is rechecked by the
 * DB sink after resolving its local owner.
 */
export function classifyRcsMessageRecord(
  info: RcsProviderServerInfo | null | undefined,
  message: RcsMessageRecord,
  expectedChatGuid?: string | null,
): RcsRecordAdmission {
  const chatRecords = message.chats ?? [];
  const chatAdmissions = chatRecords.map((chat) => classifyRcsChatRecord(info, chat));
  const attachmentAdmissions = (message.attachments ?? []).map((attachment) =>
    classifyRcsAttachmentRecord(info, attachment),
  );
  const looksRcs =
    looksLikeRcsMessageGuid(message.guid) ||
    message.providerEpoch != null ||
    looksLikeRcsChatGuid(message.chatGuid) ||
    looksLikeRcsMessageGuid(message.associatedMessageGuid) ||
    looksLikeRcsChatGuid(expectedChatGuid) ||
    chatAdmissions.some((admission) => admission !== 'non-rcs') ||
    attachmentAdmissions.some((admission) => admission !== 'non-rcs');
  if (!looksRcs) return 'non-rcs';

  const epoch = currentRcsProviderEpoch(info);
  const parsedMessage = parseRcsMessageGuid(message.guid);
  if (
    epoch == null ||
    parsedMessage?.providerEpoch !== epoch ||
    !agreesWithEpoch(message.providerEpoch, epoch)
  ) {
    return 'invalid';
  }
  if (
    looksLikeRcsMessageGuid(message.associatedMessageGuid) &&
    !isCurrentRcsMessageGuid(info, message.associatedMessageGuid)
  ) {
    return 'invalid';
  }

  const owners = [
    expectedChatGuid,
    message.chatGuid,
    ...chatRecords.map((chat) => chat.guid),
  ].filter((guid): guid is string => typeof guid === 'string' && guid.length > 0);
  if (
    new Set(owners).size > 1 ||
    owners.some((guid) => !isCurrentRcsChatGuid(info, guid)) ||
    chatAdmissions.some((admission) => admission !== 'current')
  ) {
    return 'invalid';
  }

  for (const attachment of message.attachments ?? []) {
    if (
      classifyRcsAttachmentRecord(info, attachment, parsedMessage.encodedMessageId) !== 'current'
    ) {
      return 'invalid';
    }
  }
  return 'current';
}
