# Message-state protocol: data model

How the phone stores the server's deleted/restored verdicts for Apple messages (review M059). The
behaviour, endpoints and repair flows are in [APP_SERVER_PARITY.md](APP_SERVER_PARITY.md); this page
is the data model they rely on. Code: `src/db/repositories/messageState.ts` and
`src/core/models/messageState.ts`.

## Where the state lives

| Store                                          | Holds                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message_server_states` table (migration 0053) | One row per Apple message GUID: its owning chat (`chat_guid`, `NULL` = ownerless), the `provider_epoch` and `ledger_epoch` it came from, that ledger's `sequence`, the `kind` (`deleted` or `restored`) and, for deletions only, `date_deleted`. |
| kv `sync.messageState.imessage`                | The installed authority: provider epoch, ledger epoch, REST cursor, `snapshotSequence` (the floor a repair or checkpoint installed) and the latest applied `sequence`.                                                                           |
| kv `sync.messageState.imessage.pendingRepair`  | Ledgers that unfinished repairs are moving rows into (at most 8). Installing any ledger clears the list.                                                                                                                                         |
| kv `sync.messageState.imessage.audit`          | Progress of the check of messages that were already on the phone when a checkpoint installed.                                                                                                                                                    |
| kv `sync.messageState.imessage.repairBackoff`  | When an automatic repair may run again after a failure, per provider identity.                                                                                                                                                                   |

## Epochs and ordering

- **Provider epoch** identifies one Messages database on the Mac; a new one means a different
  database. **Ledger epoch** identifies one server ledger for that database; a ledger reset keeps the
  provider epoch.
- An event counts only if its provider and ledger epochs equal the installed authority's.
- Within a ledger, events are ordered by `sequence`, a decimal string covering SQLite's signed
  64-bit range (compared by length, then text). An event at or below the authority's
  `snapshotSequence`, or at or below the stored row's sequence in the same ledger, is ignored, so a
  replayed or delayed realtime event never rolls a message back.
- Realtime events order messages but never move the REST cursor; a REST page commits its events and
  its cursor in one transaction.

## What the user sees: projection precedence

A message's `messages.date_deleted` is the latest of:

1. the user's own deletion receipt (`message_deletion_ledger`);
2. a server `deleted` row in a trusted ledger: the installed one, or one an unfinished repair is
   moving rows into;
3. the chat's history-deletion boundary (`chats.history_deleted_at`), for messages created at or
   before it.

A server `restored` row contributes nothing, so it can never undo a local deletion or a chat-history
deletion. Only exact owners are projected: an ownerless row stays quarantined and cannot hide another
chat's message, and an event whose owner conflicts with a locally retained owner (a deletion receipt
or an outgoing alias) is not applied.

## Repairs, checkpoints and interruption

- A **provider repair** reads a server snapshot, moves rows in bounded steps (at most 25 per batch),
  and installs its ledger last. Before its first row moves it records its ledger in `pendingRepair`,
  so rows it already moved stay trusted if it stops part-way (review M053).
- **Snapshot absence** hides a message with a `deleted` row at the snapshot sequence and
  `date_deleted = 0`: a reversible server hide, not a user deletion. A later `restored` event or a
  finished snapshot can reveal it. Messages with a pending send, a reminder, or a send state other
  than `sent` are never hidden this way.
- A **checkpoint install** (fresh installs and automatic repairs on presence servers) installs the
  authority and records messages already on the phone, plus deletions kept from an older ledger, for
  the later presence check. It hides and restores nothing itself.
- A **failed automatic repair** only sets the backoff. Ordinary sync is never blocked by it.
