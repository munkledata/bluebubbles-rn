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

/**
 * The associated-message type of a STICKER — an image the sender slapped onto one of your
 * messages. Apple codes 1000 (legacy) and 2007 both serialize to this one string on the server
 * side, with `-sticker` as the removal form.
 *
 * A sticker is an "associated message" like a tapback, but it is NOT a reaction: it has no glyph,
 * no label and nothing for `ReactionCluster` to draw, so {@link parseReactionType} deliberately
 * returns null for it. Keep it that way — teaching the reaction parser about stickers immediately
 * puts a blank badge into the reaction cluster and the reaction-details sheet.
 */
export const STICKER_ASSOCIATED_TYPE = 'sticker';

/** True for a sticker's associated-message type (either direction). */
export function isStickerType(t: string | null | undefined): boolean {
  if (!t) return false;
  return (t.startsWith('-') ? t.slice(1) : t) === STICKER_ASSOCIATED_TYPE;
}

/**
 * Associated-message types the UI draws as an OVERLAY on the target bubble rather than as a
 * message of its own: the six tapbacks, the arbitrary-emoji tapback, stickers, and each of their
 * `-` removal forms.
 *
 * This is the predicate the chat-thread queries exclude on. It exists because the old blanket
 * `associated_message_type IS NULL` filter was doing two jobs with one test: it correctly hid
 * reactions, and it silently swallowed stickers — and would swallow any future associated type
 * too, including the raw numeric Apple codes the server emits for anything its map doesn't know.
 * Anything NOT in this set now falls through and renders as an ordinary message, which is the
 * safe direction to fail.
 */
export function isOverlayAssociatedType(t: string | null | undefined): boolean {
  if (!t) return false;
  const base = t.startsWith('-') ? t.slice(1) : t;
  return base === 'emoji' || base === STICKER_ASSOCIATED_TYPE || BASE_SET.has(base);
}

/**
 * Normalize an `associatedMessageGuid` to the BARE target-message guid.
 *
 * Apple/BlueBubbles stores a reaction's linkage with a part prefix — `p:0/<guid>` (text part) or
 * `bp:0/<guid>` (attachment part) — while the target message's OWN `guid` has no prefix. Left raw,
 * the reaction never matches its target (`WHERE associated_message_guid IN (<bare guids>)`), so
 * OTHER people's reactions store fine but attach to nothing and never render. Strip the prefix on
 * the way in — everything after the last `/`; a guid with no `/` is returned unchanged. Mirrors the
 * Flutter reference (`message.dart`: `.replaceAll("bp:", "").split("/").last`). Reaction guids carry
 * exactly one `/` and message guids never contain one, so "after the last `/`" is safe.
 */
export function stripAssociatedGuidPrefix(guid: string): string {
  const slash = guid.lastIndexOf('/');
  return slash >= 0 ? guid.slice(slash + 1) : guid;
}

/** The wire string sent to remove an existing reaction of this type/kind. */
export function removalType(base: ReactionKind): string {
  return `-${base}`;
}
