/**
 * Tapback / reaction types. A reaction is an "associated message" whose
 * `associatedMessageType` is one of these base strings (or the same prefixed
 * with `-` to remove it). React-free so Node tests import it directly.
 */
export const REACTION_BASE_TYPES = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question',
] as const;
export type ReactionBaseType = (typeof REACTION_BASE_TYPES)[number];

/**
 * A reaction's kind: one of the six classic tapbacks, or 'emoji' — an arbitrary-emoji
 * tapback (iOS 18 / macOS 15). For 'emoji' the glyph travels SEPARATELY (the server's
 * `associatedMessageEmoji` field / the app's `associated_message_emoji` column); the
 * associated-message type string is just the selector `emoji` / `-emoji`.
 */
export type ReactionKind = ReactionBaseType | 'emoji';

export interface ReactionMeta {
  baseType: ReactionBaseType;
  emoji: string;
  label: string;
}

const META: Record<ReactionBaseType, ReactionMeta> = {
  love: { baseType: 'love', emoji: '❤️', label: 'Heart' },
  like: { baseType: 'like', emoji: '👍', label: 'Like' },
  dislike: { baseType: 'dislike', emoji: '👎', label: 'Dislike' },
  laugh: { baseType: 'laugh', emoji: '😂', label: 'Laugh' },
  emphasize: { baseType: 'emphasize', emoji: '‼️', label: 'Emphasize' },
  question: { baseType: 'question', emoji: '❓', label: 'Question' },
};

/** iOS picker order: heart, like, dislike, laugh, emphasize, question. */
export const PICKER_ORDER = REACTION_BASE_TYPES;

const BASE_SET: ReadonlySet<string> = new Set(REACTION_BASE_TYPES);

/**
 * Parse an associated_message_type into kind + isRemoval (handles `-love` and the
 * arbitrary-emoji selector `emoji`/`-emoji`); null if not a reaction.
 */
export function parseReactionType(
  t: string | null | undefined,
): { baseType: ReactionKind; isRemoval: boolean } | null {
  if (!t) return null;
  const isRemoval = t.startsWith('-');
  const base = isRemoval ? t.slice(1) : t;
  if (base === 'emoji') return { baseType: 'emoji', isRemoval };
  return BASE_SET.has(base) ? { baseType: base as ReactionBaseType, isRemoval } : null;
}

export function reactionMeta(base: ReactionBaseType): ReactionMeta {
  return META[base];
}

/** The wire string sent to remove an existing reaction of this type/kind. */
export function removalType(base: ReactionKind): string {
  return `-${base}`;
}
