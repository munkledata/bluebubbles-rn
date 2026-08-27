# Workstream D — cold/headless and realtime reliability

> **Document role:** This file owns stable implementation design, rationale, child-slice structure,
> and sequencing for Workstream D. It never owns task status, dates, assignees, blockers, or
> completion evidence. Status remains only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

## Reliability sequence

Build the cold-process foundation before layering durable delivery and user-visible effects:

1. Make headless bootstrap independent of mounted React state and keep HTTP retries tied to one
   coherent identity.
2. Replace foreground fire-and-forget boot with one explicit, recoverable state machine.
3. Make database initialization retry-safe before adding durable event claims.
4. Persist incoming events before effects, then add lossless catch-up, scheduled work, and bounded
   send ordering.
5. Add authenticated push envelopes only through a coordinated app/server protocol migration.

This sequence prevents a queue, retry, or notification feature from depending on credentials or
database state that exists only in a warm UI process.

<a id="rel-001"></a>

## `REL-001` — real headless session bootstrap

A fresh Android process must read durable address, credentials, App Lock policy, and revocation state
from secure storage before opening the encrypted database. It then applies the configured network
policy and constructs task-local sync, scheduling, outgoing, and diagnostic services without React
or pre-hydrated Zustand state.

Separate the pure orchestration body from WorkManager registration so outcome classification is
deterministic: missing credentials are an intentional no-op, completed work succeeds, and transient
bootstrap or work failure requests retry. Register the headless entry from `index.js`; a route module
is not a killed-process entry point.

Bound each wake to four sync pages, ten scheduled rows, and ten outgoing rows. An attachment retry
uses one 60-second JavaScript deadline spanning lookup, file stat, upload preflight, FIFO admission,
native transfer, and HTTP response. This is not a promise that the whole wake or an uncooperative
native operation terminates at that instant; claim and outcome commits remain outside the transfer
deadline.

<a id="rel-006"></a>

## `REL-006` — coherent HTTP identity across retries

Treat origin, query parameters, optional legacy query credential, and headers as one logical-request
identity. Before retrying, re-read the complete live configuration and proceed only when it is still
identical. If any part changed, retire the old request without sending revoked credentials or mixing
new credentials with old-account work.

Writes remain non-retrying by default. A new logical request captures the complete replacement
identity rather than inheriting pieces from a previous attempt.

<a id="rel-007"></a>

## `REL-007` — explicit foreground boot state machine

Implement foreground boot in independently reviewable slices:

1. `REL-007A` defines the platform-independent reducer and its loading, success, failure, and retry
   transitions.
2. `REL-007B1` supplies the additive single-flight coordinator foundation.
3. `REL-007B2` connects the production singleton, durable-session handoff, stage adapters,
   deadlines, reverse-order cleanup, and real failure classification.
4. `REL-007C` presents deterministic loading, locked, setup, retryable, fatal, and connected UI.

Required stages run in the order `lock → session → database → settings → activate`. Classify
each stage as fatal/fail-closed, retryable, degraded-but-usable, or best-effort diagnostic. Revocation
must stop stale stage settlements and prevent old-account settings from publishing. A first database
open that never settles is restart-required because its singleton promise cannot be safely replaced;
an ordinary settled open failure may be retried after cleanup.

Notification, FCM, background-task, and realtime activation failures may degrade a usable encrypted
inbox rather than unnecessarily brick it. Foreground UI reads App Lock before database open or key
release, while explicitly registered headless handlers remain the documented exception. Certificate
pinning is not a boot stage.

<a id="rel-009a"></a>

## `REL-009A` — retry-safe database initialization cleanup

Do not publish raw or Drizzle database singletons until key validation, pragmas, and migrations all
succeed. A wrong-key, open, or migration failure closes the unusable native handle, clears partial
singletons, preserves the original error, and permits a later correct open.

This cleanup boundary must precede boot retry and durable-queue work; otherwise one failed cold open
can poison every later foreground or headless attempt.

<a id="push-retry-01"></a>

## `PUSH-RETRY-01` — durable incoming-event recovery

Implement the delivery path in four slices:

1. `PUSH-RETRY-01A` adds the encrypted queue migration and guarded repository.
2. `PUSH-RETRY-01B` makes schema-validated canonical-envelope persistence happen before any effect.
3. `PUSH-RETRY-01C` adds leased at-least-once drain, shared idempotency, bounded retry, poison
   handling, cleanup, and diagnostics.
4. `PUSH-RETRY-01D` exercises the two process-death windows: after persistence but before claim, and
   after claim but before settlement.

Persist only canonical envelopes—never a native transport object, ciphertext frame, or
caller-supplied digest. Socket, eligible unlocked FCM, and development injection share the same
encoder and `EventRouter` path. Locked FCM retains the deliberate generic-notice, no-protected-DB
exception; later sync recovers content after unlock.

The queue permits at most 1 MiB per payload, 500 pending rows, and 16 MiB of pending payloads. One
claim is token/version-fenced, covers at most 25 rows and 2 MiB, and leases them for 120 seconds. Five
claimed attempts back off for 30, 60, 120, 240, and 480 seconds. Terminal payloads are scrubbed;
bounded receipts remain for seven days and at most 2,000 rows.

Separate authoritative database application from presentation. The domain transaction checkpoints
`db_applied_at`; a later notification attempt reads current database truth rather than replaying stale
preview content. Newer message edits or deletions may converge before an older failed presentation,
but the presentation waits for all newer domain work. Missing prerequisites request bounded recovery
and remain retryable. Deletion cancels any corresponding Android notification.

Account-generation and App Lock checks surround intake, claim, handler work, and the final commit.
Every physical send attempt needs one immutable, non-empty `attemptGuid` reused across socket, FCM,
and webhook copies so temp-only or RCS send errors can be deduplicated without conflating a later
retry.

<a id="delete-sync-01"></a>

## `DELETE-SYNC-01` — lossless missed-deletion catch-up

Replace a timestamp-only deletion watermark with an opaque continuation token or a composite
`(dateDeleted, stableId)` cursor. The initial deletion cursor must describe the same consistent
snapshot as history sync, or history must explicitly exclude or mark deletions within that snapshot.

Apply each deletion page and its next cursor in one account-guarded transaction. Retrying a page must
remain idempotent, and account revocation must prevent an old cursor commit. Until an unambiguous
continuation contract is available, a full page that cannot advance the timestamp watermark stops
fail-closed instead of silently skipping tied rows.

<a id="sched-01"></a>

## `SCHED-01` — scheduled work outside mounted screens

Authenticated background bootstrap, not a home or chat timer, drains due local schedules. Each
runner first joins one bounded recovery barrier for the current database/account generation, filters
eligible work before a two-row handoff cap, and atomically claims the still-current due row. An edit
between discovery and claim therefore cannot send stale text, a future occurrence, or server-owned
work.

Commit the scheduled transition, outgoing queue row, optimistic message, and chat bump together
before HTTP begins, then re-check account authority at the network boundary. One four-minute elapsed
admission budget spans bootstrap sync, scheduled handoff, outgoing retry, and diagnostics. It refuses
new commits after expiry but is not a hard cancellation promise for a bounded operation or database
wait already in progress.

Product copy must describe local scheduling as best effort and distinguish server-owned scheduling
from Android-owned delivery. Sleep, battery policy, connectivity, and Mac/server availability can
delay delivery; exact timing must not be promised.

<a id="life-01"></a>

## `LIFE-01` — focus-aware Find My polling

Gate the Find My 60-second interval on both screen focus and active AppState. Stop periodic requests
while hidden or backgrounded, refresh immediately when visible again, and prevent duplicate timers.
This one timer does not justify a new general lifecycle abstraction.

<a id="send-01"></a>

## `SEND-01` — ordered sends, bounded failure detail, and private failure notices

Implement send reliability in three child slices:

1. `SEND-01A` supplies a bounded, account-generation-scoped logical-send FIFO.
2. `SEND-01B` persists and safely displays bounded server failure detail.
3. `SEND-01C` posts a privacy-safe local failure notice only when the failed send is not already
   visible in the active chat.

### `SEND-01A` — logical-send FIFO

Existing-chat text, reply, reaction, contact-card, image-batch, notification-reply, and notification
reaction entry points share one process-wide FIFO. Snapshot input before waiting, track active work
until real settlement, and cancel queued closures after account-generation revocation. The queue
holds at most 32 jobs and refuses the newest before database, native, or network work begins.

One multi-image action remains one logical turn while its sibling uploads may run concurrently.
Combined attachment-plus-text submission is all-or-none and preserves the draft and staged files on
refusal, stale ownership, or edit. Initial chat creation is the sole exception because it has no
existing chat GUID until its atomic create/deduplicate/first-message operation settles.

A 20-second FIFO window is an explicit ordering-degradation boundary, not cancellation: a successor
may start while the original remains tracked to settlement. Keep this window shorter than the
outgoing-recovery grace so the recovery worker does not mistake a still-owned send for abandonment.

### `SEND-01B` — bounded failure detail

Only opted-in text, contact, reaction, and native attachment-upload paths may capture nested
`error.message` detail. Read at most 4 KiB for two seconds; malformed, oversized, stalled, or non-JSON
responses keep the generic status-classified error.

The shared projector rejects stack-like or oversized input; strips controls, bidirectional tricks,
full URLs, identities, labeled secrets, and private paths; and emits at most 240 code points and
512 UTF-8 bytes. Project realtime detail before durable ingress. Store the same bounds in the
nullable message field, preserve useful detail through duplicate fanout, and clear it on every
retry-success or echo reconciliation path. Raw detail must never enter logs, notifications, or retry
decisions.

### `SEND-01C` — failed-send notification

Post a fixed app-authored `Message not sent` notice only after the encrypted database records an
undeleted outgoing failure. Native state contains only an opaque local route key and stable local
message id—never message text, contact data, server detail, or raw GUIDs. The body tap opens the chat;
inline actions remain unavailable, and App Lock substitutes the existing generic locked notice.

Direct sends, queue retries, terminal retirement, and durable realtime failures converge on the same
database-truth check. Success or echo reconciliation withdraws the notice only when the row is no
longer failed, while a committed failed-bubble tombstone withdraws it by retained local id. Publish
active-chat state only for a focused, foreground, unlocked route; bind it to a revocable token and
clear it during account teardown.

<a id="push-crypto-01"></a>

## `PUSH-CRYPTO-01` — versioned authenticated push and replay defense

Introduce this only as a coordinated app/server protocol migration. Give each device a random
256-bit key. AEAD associated data authenticates protocol version, event/message type,
server/account/device identity, message id, and timestamp.

Claim replay ids transactionally before effects, retain them within a bounded persistent window,
rotate or revoke keys on disconnect, and reject legacy downgrade after an account/device migrates.
Cross-account, cross-device, wrong-key, modified-metadata, replayed, and downgraded envelopes must
all fail closed.
