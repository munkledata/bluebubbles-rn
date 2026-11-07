import type { ServerInfo } from './serverInfo';

/**
 * FP-006 restored iMessage features. A newer Gator server advertises each one with its own
 * optional `supports_imessage_*` switch, all false by default; an older server sends none of them.
 * Every rule below mirrors the server's own gate (bbd `IMessageRestoredFeatures.ts` and the
 * per-command `…FeaturesFor` helpers), so the app only offers a request the server will route to
 * the restored helper command instead of refusing it.
 *
 * When a switch is absent or false the app keeps today's behaviour exactly: the reviewed
 * one-to-one, classic, part-zero paths and their refusals.
 */
export const IMESSAGE_RESTORED_FEATURES = [
  'supports_imessage_group_reactions',
  'supports_imessage_emoji_reactions',
  'supports_imessage_part_reactions',
  'supports_imessage_group_replies',
  'supports_imessage_part_replies',
  'supports_imessage_group_edit',
  'supports_imessage_group_unsend',
  'supports_imessage_group_effects',
  'supports_imessage_group_read_state',
  'supports_imessage_group_contact',
  'supports_imessage_group_location',
  'supports_imessage_attachments_v2',
  'supports_imessage_group_attachment_upload',
  'supports_imessage_subject',
  'supports_imessage_group_name_clear',
  'supports_imessage_group_create',
] as const;

export type IMessageRestoredFeature = (typeof IMESSAGE_RESTORED_FEATURES)[number];

/** The server's own addressing rule: `iMessage;-;X`, `any;-;X`, `iMessage;+;X` or `any;+;X`. */
const RESTORED_CHAT_GUID = /^(iMessage|any);([+-]);(.+)$/su;

export type RestoredChatKind = 'group' | 'direct';

/** Which shape of iMessage chat a guid addresses, or undefined for SMS, RCS or anything else. */
export function restoredChatKind(
  chatGuid: string | null | undefined,
): RestoredChatKind | undefined {
  if (typeof chatGuid !== 'string' || chatGuid.trim() !== chatGuid) return undefined;
  const match = RESTORED_CHAT_GUID.exec(chatGuid);
  if (!match || !match[3]) return undefined;
  return match[2] === '+' ? 'group' : 'direct';
}

/** True only when every listed switch is explicitly true (and at least one is listed). */
export function restoredFeaturesEnabled(
  info: ServerInfo | null | undefined,
  features: readonly IMessageRestoredFeature[],
): boolean {
  return features.length > 0 && features.every((feature) => info?.[feature] === true);
}

function isEmojiReaction(reaction: string): boolean {
  return reaction === 'emoji' || reaction === '-emoji';
}

/**
 * The switches one tapback needs: group, emoji and/or part > 0. Empty means the reviewed
 * one-to-one, classic, part-zero command covers it (bbd `tapbackFeaturesFor`).
 */
export function restoredTapbackFeatures(input: {
  chatGuid: string;
  reaction: string;
  partIndex: number;
}): IMessageRestoredFeature[] {
  const features: IMessageRestoredFeature[] = [];
  if (restoredChatKind(input.chatGuid) === 'group') {
    features.push('supports_imessage_group_reactions');
  }
  if (isEmojiReaction(input.reaction)) features.push('supports_imessage_emoji_reactions');
  if (input.partIndex > 0) features.push('supports_imessage_part_reactions');
  return features;
}

/** The switches one reply needs: group and/or part > 0 (bbd `partReplyFeaturesFor`). */
export function restoredReplyFeatures(input: {
  chatGuid: string;
  partIndex: number;
}): IMessageRestoredFeature[] {
  const features: IMessageRestoredFeature[] = [];
  if (restoredChatKind(input.chatGuid) === 'group')
    features.push('supports_imessage_group_replies');
  if (input.partIndex > 0) features.push('supports_imessage_part_replies');
  return features;
}

/** The switches a multi-file upload needs (bbd `attachmentsFeaturesFor`): groups need both. */
export function restoredAttachmentsFeatures(chatGuid: string): IMessageRestoredFeature[] {
  const kind = restoredChatKind(chatGuid);
  if (kind === undefined) return [];
  return kind === 'group'
    ? ['supports_imessage_attachments_v2', 'supports_imessage_group_attachment_upload']
    : ['supports_imessage_attachments_v2'];
}

/** A restored tapback the server will route to its FP-006 command right now. */
export function canSendRestoredIMessageTapback(
  info: ServerInfo | null | undefined,
  input: { chatGuid: string; reaction: string; partIndex: number },
): boolean {
  return (
    restoredChatKind(input.chatGuid) !== undefined &&
    restoredFeaturesEnabled(info, restoredTapbackFeatures(input))
  );
}

/** A restored reply the server will route to its FP-006 command right now. */
export function canSendRestoredIMessageReply(
  info: ServerInfo | null | undefined,
  input: { chatGuid: string; partIndex: number },
): boolean {
  return (
    restoredChatKind(input.chatGuid) !== undefined &&
    restoredFeaturesEnabled(info, restoredReplyFeatures(input))
  );
}

/** A multi-file upload the server will accept for this chat right now. */
export function canSendRestoredIMessageAttachments(
  info: ServerInfo | null | undefined,
  chatGuid: string,
): boolean {
  return restoredFeaturesEnabled(info, restoredAttachmentsFeatures(chatGuid));
}

/** A group-only restored command (edit, unsend, effect, read state, contact, location). */
export function canUseRestoredIMessageGroupFeature(
  info: ServerInfo | null | undefined,
  chatGuid: string,
  feature:
    | 'supports_imessage_group_edit'
    | 'supports_imessage_group_unsend'
    | 'supports_imessage_group_effects'
    | 'supports_imessage_group_read_state'
    | 'supports_imessage_group_contact'
    | 'supports_imessage_group_location',
): boolean {
  return restoredChatKind(chatGuid) === 'group' && info?.[feature] === true;
}

/** A subject line on `/message/text`, one-to-one or group. */
export function canSendRestoredIMessageSubject(
  info: ServerInfo | null | undefined,
  chatGuid: string,
): boolean {
  return restoredChatKind(chatGuid) !== undefined && info?.supports_imessage_subject === true;
}

/** Caps of the restored multi-file route (bbd `restoredAttachmentTypes.ts`, helper validation). */
export const IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES = 10;
/** The caps a server enforces when it does not advertise its own (every server before the fields). */
export const IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const IMESSAGE_RESTORED_ATTACHMENT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** The app's own ceiling, whatever a server advertises (owner decision, 2026-11-07: 1000 MB). */
export const IMESSAGE_RESTORED_ATTACHMENT_CEILING_BYTES = 1000 * 1024 * 1024;

/** The restored route's size caps for one send. */
export interface RestoredAttachmentCaps {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

/** What a server without the advertised caps enforces. */
export const LEGACY_RESTORED_ATTACHMENT_CAPS: RestoredAttachmentCaps = {
  maxFileBytes: IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES,
  maxTotalBytes: IMESSAGE_RESTORED_ATTACHMENT_MAX_TOTAL_BYTES,
};

/**
 * The loosest caps any server could have. Only for checks that run before the server's caps are
 * known; the send path checks again with {@link restoredAttachmentCaps} once they are.
 */
export const CEILING_RESTORED_ATTACHMENT_CAPS: RestoredAttachmentCaps = {
  maxFileBytes: IMESSAGE_RESTORED_ATTACHMENT_CEILING_BYTES,
  maxTotalBytes: IMESSAGE_RESTORED_ATTACHMENT_CEILING_BYTES,
};

/**
 * The caps this server enforces: its advertised `imessage_restored_attachment_max_file_bytes` and
 * `_max_total_bytes`, each clamped to the app's 1000 MB ceiling. A server that advertises neither
 * enforces the old 100 / 200 MiB, so the app never lets through a file the server would refuse.
 */
export function restoredAttachmentCaps(
  info: ServerInfo | null | undefined,
): RestoredAttachmentCaps {
  const clamp = (value: number | null | undefined, fallback: number): number =>
    value == null ? fallback : Math.min(value, IMESSAGE_RESTORED_ATTACHMENT_CEILING_BYTES);
  const maxFileBytes = clamp(
    info?.imessage_restored_attachment_max_file_bytes,
    IMESSAGE_RESTORED_ATTACHMENT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = clamp(
    info?.imessage_restored_attachment_max_total_bytes,
    IMESSAGE_RESTORED_ATTACHMENT_MAX_TOTAL_BYTES,
  );
  return { maxFileBytes, maxTotalBytes };
}
/** A txt/csv must be wholly valid UTF-8 and at most 1 MiB. */
export const IMESSAGE_RESTORED_TEXT_FILE_MAX_BYTES = 1024 * 1024;
/** Subject: one nonblank line of at most 1 KiB UTF-8 with no control characters. */
export const IMESSAGE_RESTORED_SUBJECT_MAX_UTF8_BYTES = 1024;

/** The lowercase extensions the restored route allows (the server re-checks the leading bytes). */
const RESTORED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'heic',
  'heif',
  'mov',
  'mp4',
  'm4v',
  'm4a',
  'mp3',
  'aac',
  'wav',
  'caf',
  'pdf',
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'pages',
  'numbers',
  'key',
  'doc',
  'xls',
  'ppt',
  'rtf',
  'txt',
  'csv',
]);

/** The file's lowercase extension when the restored route allows it, else undefined. */
export function restoredAttachmentExtension(name: string): string | undefined {
  if (name.length === 0 || name.startsWith('.')) return undefined;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return RESTORED_ATTACHMENT_EXTENSIONS.has(extension) ? extension : undefined;
}

export type RestoredAttachmentRefusal =
  | 'none'
  | 'too-many'
  | 'type'
  | 'empty'
  | 'file-too-large'
  | 'total-too-large'
  | 'text-file-too-large'
  | 'duplicate-name';

/**
 * Check one picked batch against the restored route's caps before any byte is read: 1–10 files,
 * each an allowlisted extension, each 1 byte to the per-file cap (txt/csv at most 1 MiB), within
 * the total cap, and no two files with the same name ignoring case (the server refuses duplicates).
 * The caps default to what a server without advertised caps enforces.
 */
export function restoredAttachmentBatchRefusal(
  files: readonly { name: string; size: number }[],
  caps: RestoredAttachmentCaps = LEGACY_RESTORED_ATTACHMENT_CAPS,
): RestoredAttachmentRefusal | null {
  if (files.length === 0) return 'none';
  if (files.length > IMESSAGE_RESTORED_ATTACHMENT_MAX_FILES) return 'too-many';
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    const extension = restoredAttachmentExtension(file.name);
    if (extension === undefined) return 'type';
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'empty';
    if (file.size > caps.maxFileBytes) return 'file-too-large';
    if (
      (extension === 'txt' || extension === 'csv') &&
      file.size > IMESSAGE_RESTORED_TEXT_FILE_MAX_BYTES
    ) {
      return 'text-file-too-large';
    }
    const key = file.name.toLowerCase();
    if (names.has(key)) return 'duplicate-name';
    names.add(key);
    total += file.size;
    if (total > caps.maxTotalBytes) return 'total-too-large';
  }
  return null;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A lone UTF-16 surrogate cannot round-trip through UTF-8; the server refuses it. */
function hasLoneSurrogate(value: string): boolean {
  // With the `u` flag a valid pair is one code point above U+FFFF, so only a lone half matches.
  return /[\uD800-\uDFFF]/u.test(value);
}

/** The server's subject rule: nonblank, one line, no controls, no U+FFFC, at most 1 KiB UTF-8. */
export function isValidRestoredSubject(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f￼]/u.test(value) &&
    !hasLoneSurrogate(value) &&
    utf8ByteLength(value) <= IMESSAGE_RESTORED_SUBJECT_MAX_UTF8_BYTES
  );
}

/** The server's longest restored caption or message text (bbd `IMESSAGE_RESTORED_TEXT_MAX_UTF8_BYTES`). */
export const IMESSAGE_RESTORED_TEXT_MAX_UTF8_BYTES = 64 * 1024;

/**
 * The server's caption rule for a restored upload: nonblank, no control characters except tab and
 * newline, no U+FFFC, at most 64 KiB UTF-8 (bbd `isValidRestoredText`).
 */
export function isValidRestoredText(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f￼]/u.test(value) &&
    !hasLoneSurrogate(value) &&
    utf8ByteLength(value) <= IMESSAGE_RESTORED_TEXT_MAX_UTF8_BYTES
  );
}

/** One file the restored route accepts when sent on its own: an allowlisted name within its caps. */
export function isRestoredAttachmentFile(
  file: { name: string; size: number },
  caps: RestoredAttachmentCaps = LEGACY_RESTORED_ATTACHMENT_CAPS,
): boolean {
  return (
    typeof file.name === 'string' &&
    restoredAttachmentBatchRefusal([{ name: file.name, size: file.size }], caps) === null
  );
}

/**
 * Whether the server's reviewed group commands (rename, photo, add/remove member, leave) accept a
 * native `any;+;` group right now. bbd has no separate flag: it accepts that prefix exactly when its
 * FP-006 gate is open (listed helper, owner setting on, helper connected), and it reports every
 * restored switch from that same gate, so any restored switch being on means the gate is open.
 */
export function restoredGroupCommandsAcceptAnyPrefix(info: ServerInfo | null | undefined): boolean {
  return IMESSAGE_RESTORED_FEATURES.some((feature) => info?.[feature] === true);
}
