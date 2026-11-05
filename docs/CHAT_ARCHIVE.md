# Archived chats coming back on a new message

Owner decision 2026-11-05 (upstream BlueBubbles app#1063, #2440). Migration `0060_chat_auto_unarchive`.

## Rule

An archived chat returns to the inbox when a **new message from someone else** arrives, unless that
chat's switch in Details, "Bring back from Archived on new messages" (`chats.auto_unarchive`,
default on), is off. A muted chat comes back but stays muted.

The rule is `unarchiveChatsWithNewMessagesWithinTransaction` (`src/db/repositories/chats.ts`). It runs
once per batch inside `upsertMessagesWithinTransaction`, right after the deleted-chat tombstone check,
and counts a message only if:

- this batch **inserted** it (a re-saved message never counts);
- it isn't yours, a reaction, a group event, deleted or retracted;
- it's newer than `chats.archived_at`.

## `archived_at` is written by triggers

Two triggers from migration 0060 stamp or clear `archived_at`. These are database writes the static
DB-write scanner cannot see at runtime. Their `CREATE TRIGGER` statements are reviewed inventory
entries, and each trigger body runs inside the statement that fired it, so it always joins that
writer's existing transaction.

| Trigger                    | Fires when                                                                    | Writes                              |
| -------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `chats_archived_at_update` | `is_archived` changes: the Archive action, backup restore, or the rule itself | the stamp, or NULL when un-archived |
| `chats_archived_at_insert` | a chat is inserted already archived (for example a sync insert)               | the stamp                           |

The stamp is `MAX(phone clock, chats.latest_message_date)`, so a Mac clock running ahead can't make a
message that was already there count as new. The triggers write only `archived_at`, never
`is_archived`, so they cannot fire each other or themselves.

Sync never rewrites `is_archived` on conflict (it is device-local), so the update trigger doesn't fire
during sync.

## Downgrade

An older app ignores the unknown `0060` row in `_migrations`. Its inserts omit the new columns and get
`auto_unarchive` DEFAULT 1. The triggers keep stamping `archived_at`, which old code never reads.

## Known gap (owner: leave for now)

Backups and Full Repair don't carry `auto_unarchive`, so a restore turns every switch back on.

## Tests

- `test/db/chatAutoUnarchive.test.ts`
- `test/db/migrations/0060_chat_auto_unarchive.test.ts`
