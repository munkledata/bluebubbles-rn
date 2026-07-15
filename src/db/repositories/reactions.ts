import { sql } from 'drizzle-orm';
import { parseReactionType, type ReactionKind } from '@core/reactions/reactionType';
import type { AppDatabase } from '../types';

export interface ReactionRow {
  targetGuid: string;
  baseType: ReactionKind;
  /** Glyph of an arbitrary-emoji tapback (baseType 'emoji'); null for classic tapbacks. */
  emoji: string | null;
  isFromMe: number;
  senderName: string | null;
  dateCreated: number | null;
}

/**
 * Reactions grouped by the message guid they target. Add/remove are collapsed:
 * the latest action per (sender, base type) wins, and a trailing removal drops
 * the badge. Mirrors listAttachmentsByMessageIds but keys by target guid (the
 * column carrying the link, indexed by messages_assoc_idx).
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
    assocType: string;
    assocEmoji: string | null;
    isFromMe: number;
    senderName: string | null;
    dateCreated: number | null;
    handleId: number | null;
  }>(sql`
    SELECT m.associated_message_guid AS targetGuid, m.associated_message_type AS assocType,
           m.associated_message_emoji AS assocEmoji,
           m.is_from_me AS isFromMe, m.handle_id AS handleId, m.date_created AS dateCreated,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages m
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.associated_message_guid IN (${inList})
      AND m.associated_message_type IS NOT NULL
    ORDER BY m.date_created ASC, m.id ASC
  `);

  // Collapse per (target, sender, kind[, glyph]): last write wins. Emoji tapbacks key on
  // the glyph too — different emojis from one sender coexist, and a '-emoji' removal only
  // clears its own glyph.
  const latest = new Map<string, { row: ReactionRow; isRemoval: boolean }>();
  for (const r of rows) {
    const parsed = parseReactionType(r.assocType);
    if (!parsed) continue;
    const emoji = parsed.baseType === 'emoji' ? (r.assocEmoji ?? null) : null;
    if (parsed.baseType === 'emoji' && !emoji) continue; // glyph-less emoji row is unrenderable
    const senderKey = r.isFromMe ? 'me' : `h${r.handleId ?? '?'}`;
    const kindKey = emoji ? `emoji::${emoji}` : parsed.baseType;
    latest.set(`${r.targetGuid}::${senderKey}::${kindKey}`, {
      isRemoval: parsed.isRemoval,
      row: {
        targetGuid: r.targetGuid,
        baseType: parsed.baseType,
        emoji,
        isFromMe: r.isFromMe,
        senderName: r.isFromMe ? null : r.senderName,
        dateCreated: r.dateCreated,
      },
    });
  }
  for (const { row, isRemoval } of latest.values()) {
    if (isRemoval) continue;
    const list = out.get(row.targetGuid) ?? [];
    list.push(row);
    out.set(row.targetGuid, list);
  }
  return out;
}
