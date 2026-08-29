import { sql } from 'drizzle-orm';
import {
  parseReactionType,
  reactionKindKey,
  type ReactionKind,
} from '@core/reactions/reactionType';
import type { AppDatabase } from '../types';

export interface ReactionRow {
  targetGuid: string;
  /** Exact target part. Repository results always set this; null means the wire identity was absent. */
  targetPart?: number | null;
  baseType: ReactionKind;
  /** Glyph of an arbitrary-emoji tapback (baseType 'emoji'); null for classic tapbacks. */
  emoji: string | null;
  isFromMe: number;
  senderName: string | null;
  dateCreated: number | null;
}

/**
 * Reactions grouped by the aggregate message guid they target. Add/remove is first collapsed by
 * exact (target, part, sender, kind), with unknown part identity kept distinct from part zero. The
 * aggregate UI then keeps only the newest active copy of the same sender/kind across parts while
 * retaining that winning part so a later removal can target it exactly.
 */
export async function listReactionsByMessageGuids(
  db: AppDatabase,
  guids: string[],
): Promise<Map<string, ReactionRow[]>> {
  const out = new Map<string, ReactionRow[]>();
  if (guids.length === 0) return out;
  const inList = sql.join(
    guids.map((g) => sql`${g}`),
    sql`, `,
  );
  const rows = await db.all<{
    targetGuid: string;
    targetPart: number | null;
    assocType: string;
    assocEmoji: string | null;
    isFromMe: number;
    senderName: string | null;
    dateCreated: number | null;
    handleId: number | null;
  }>(sql`
    SELECT m.associated_message_guid AS targetGuid,
           m.associated_message_part AS targetPart,
           m.associated_message_type AS assocType,
           m.associated_message_emoji AS assocEmoji,
           m.is_from_me AS isFromMe, m.handle_id AS handleId, m.date_created AS dateCreated,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages m
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.associated_message_guid IN (${inList})
      AND m.associated_message_type IS NOT NULL
      AND m.date_deleted IS NULL
    ORDER BY m.date_created ASC, m.id ASC
  `);

  // Exact state remains part-scoped: a removal on part 1 must not clear the same sender's reaction
  // on part 0. JSON tuple keys make null (unknown) and zero unambiguously different. Emoji tapbacks
  // include the glyph, so different emojis coexist and '-emoji' clears only its own glyph.
  const latestByPart = new Map<
    string,
    { row: ReactionRow; isRemoval: boolean; sequence: number; visualKey: string }
  >();
  let sequence = 0;
  for (const r of rows) {
    const parsed = parseReactionType(r.assocType);
    if (!parsed) continue;
    const emoji = parsed.baseType === 'emoji' ? (r.assocEmoji ?? null) : null;
    if (parsed.baseType === 'emoji' && !emoji) continue; // glyph-less emoji row is unrenderable
    const senderKey = r.isFromMe ? 'me' : `h${r.handleId ?? '?'}`;
    const kindKey = reactionKindKey(parsed.baseType, emoji);
    const visualKey = JSON.stringify([r.targetGuid, senderKey, kindKey]);
    latestByPart.set(JSON.stringify([r.targetGuid, r.targetPart, senderKey, kindKey]), {
      isRemoval: parsed.isRemoval,
      sequence,
      visualKey,
      row: {
        targetGuid: r.targetGuid,
        targetPart: r.targetPart,
        baseType: parsed.baseType,
        emoji,
        isFromMe: r.isFromMe,
        senderName: r.isFromMe ? null : r.senderName,
        dateCreated: r.dateCreated,
      },
    });
    sequence += 1;
  }

  // One aggregate bubble cannot draw per-part badges. Among still-active exact-part reactions,
  // visually retain the newest copy for each target/sender/kind. Keeping its targetPart makes the
  // later action layer able to remove the same part instead of falling back to zero.
  const visuallyLatest = new Map<string, { row: ReactionRow; sequence: number }>();
  for (const { row, isRemoval, sequence: rowSequence, visualKey } of latestByPart.values()) {
    if (isRemoval) continue;
    const current = visuallyLatest.get(visualKey);
    if (!current || rowSequence > current.sequence) {
      visuallyLatest.set(visualKey, { row, sequence: rowSequence });
    }
  }

  const visible = [...visuallyLatest.values()].sort((a, b) => a.sequence - b.sequence);
  for (const { row } of visible) {
    const list = out.get(row.targetGuid) ?? [];
    list.push(row);
    out.set(row.targetGuid, list);
  }
  return out;
}
