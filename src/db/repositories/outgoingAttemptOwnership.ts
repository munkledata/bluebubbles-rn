import { eq, sql } from 'drizzle-orm';
import { messageGuidAliases } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';

/** Newest stale-action mappings retained; older queue-owned mappings remain pinned in addition. */
export const MESSAGE_GUID_ALIAS_LIMIT = 4096;
/** Largest generation accepted by the JSON/wire contract and SQLite ownership fence. */
export const MAX_SEND_ATTEMPT_OWNER_GENERATION = 2_147_483_647;

/** Local compare-and-set token captured by exactly one physical send request. */
export interface SendAttemptOwnerToken {
  readonly generation: number;
}

/** One client temp GUID was observed mapping to two different server identities. */
export class MessageGuidAliasConflictError extends Error {
  override readonly name = 'MessageGuidAliasConflictError';

  constructor() {
    // Fixed copy only: GUIDs are account data and must not leak through diagnostics.
    super('message GUID alias conflicts with an existing canonical identity');
  }
}

/**
 * Record one learned temp → real identity while an owning promotion transaction is open.
 *
 * Re-observing the same mapping refreshes its recency. A different canonical identity for an
 * existing alias is ambiguous and fails closed instead of letting a stale destructive action hit
 * the wrong message. The id-ordered prune normally retains exactly the newest cap, plus any older
 * mapping still required to resolve a durable outgoing-queue row.
 */
export async function recordMessageGuidAliasWithinTransaction(
  context: DbTransactionContext,
  aliasGuid: string,
  canonicalGuid: string,
  chatGuid: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const existing = await db.all<{ canonicalGuid: string; chatGuid: string | null }>(sql`
      SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${aliasGuid}
       LIMIT 1
    `);
    const previous = existing[0]?.canonicalGuid;
    const previousChatGuid = existing[0]?.chatGuid;
    if (
      previous != null &&
      (previous !== canonicalGuid || (previousChatGuid != null && previousChatGuid !== chatGuid))
    ) {
      throw new MessageGuidAliasConflictError();
    }
    if (previous != null) {
      await db.delete(messageGuidAliases).where(eq(messageGuidAliases.aliasGuid, aliasGuid));
    }
    await db.insert(messageGuidAliases).values({ aliasGuid, canonicalGuid, chatGuid });
    await db.run(sql`
      DELETE FROM message_guid_aliases AS candidate
       WHERE candidate.id IN (
         SELECT id
           FROM message_guid_aliases
          ORDER BY id DESC
          LIMIT -1 OFFSET ${MESSAGE_GUID_ALIAS_LIMIT}
       )
         AND NOT EXISTS (
           SELECT 1
             FROM outgoing_queue q
            WHERE q.temp_guid = candidate.alias_guid
         )
    `);
  });
}
