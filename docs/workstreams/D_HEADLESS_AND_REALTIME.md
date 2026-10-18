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

Bound each WorkManager wake to one 50-second monotonic work owner, four sync pages, two scheduled
rows, and ten outgoing rows. Reserve a separate absolute 55-second cutoff for final persistent-log
flushing. The owner's abort signal reaches task-local HTTP and retry waits, sync, diagnostics, and
native attachment uploads. An attachment retry keeps its standalone 60-second ceiling but uses only
the smaller remaining callback budget. Expiry returns retryable `Failed` and keeps replacements
fenced until the real prior continuation settles. An uncooperative synchronous/native operation can
still outlive its JavaScript cancellation result, so exact Android evidence remains required.

The same durable bootstrap boundary owns the remaining network effects from a killed-process
notification action. A plain notification reply in an existing iMessage chat uses AppleScript,
while the equivalent plain RCS send and supported whole-message RCS reaction use the independent
RCS transport. Both network paths receive one fixed client, created only after vault, App Lock, and
revocation inspection, and never fall back to foreground-store
credentials. `FP-006` removes iMessage reaction and FaceTime actions entirely. Mark Read and Mark
Unread now change only the device-local marker and never resolve a helper client or send a remote
receipt. Stale persisted feature settings cannot restore any retired effect.

A realtime chat-background event is the explicit exception to callback ownership. Its detached,
account-owned callback carries the originating
account generation, captures a fresh lease when it actually starts, and either pins the exact warm
transport or constructs a guarded client from the authorized durable tuple. This lets the wallpaper
transfer outlive its short queue attempt without adopting a replacement account. The mounted-chat
path also pins its transport, and the synced-background service checks transport currentness before
and after metadata, native file, and database boundaries.

Ingestion attachment auto-download uses that task-local transport too. A fresh FCM process first
joins the ordinary bounded, generation-guarded attachment-cache recovery flight because it did not
run the foreground boot gate; stale or failed recovery keeps persistent downloads closed. The
explicit client applies only to a real server session, while the in-app development fixture retains
its installed synthetic fetcher.

For each background FCM delivery, the app captures an absolute attachment-effect deadline of
`receivedAt + 40 seconds`. After FIFO admission it creates a generation-bound collection.
`DbEventSink` invokes its post-commit hook synchronously, registering an
`auto-download:<messageId>` factory instead of starting native work. Revisions of one message share
the keyed task. Collection close stops admission and runs factories sequentially only after durable
dispatch and notification presentation return. The native callback awaits the result outside the
account-teardown tracking slot. Account invalidation or deadline expiry makes the composed lease
stale, with at most two more seconds allowed for cooperative cleanup.

This is one bounded callback-owned app-cache attempt, not a durable retry. Process death after the
database checkpoint can still lose it. The effect-specific 40-second window covers only the
attachment tail, while an enclosing 50-second FCM lifetime now covers FIFO waiting,
dispatch/presentation, prerequisite recovery, and the effect tail. On expiry it revokes the derived
lease and abort signal before the public callback continues; the real underlying delivery remains
the FIFO fence so later callbacks cannot overlap it. Final persistent-log flushing has a separate absolute
`receivedAt + 55 seconds` cutoff, leaving five seconds before RNFB's 60-second Android task limit.
That barrier adopts pre-existing log operations plus its own queued write, keeps older headless
sessions captured across every retry attempt, revokes their asynchronous mutation authority before
returning at expiry, suppresses detached debounce/retry work, and leaves later independent Clear or
callback owners alone. A synchronous Expo/native call that already started cannot be interrupted,
so native cancellation and complete callback timing still require exact Android evidence. Headless FCM also suppresses the immediate external Photos
call because `expo-media-library` has no abort signal. For an eligible incoming non-sticker image
with a Gallery or Gator Album preference it instead stores one bounded destination-bound receipt
before the private-cache download; committed `localPath` then makes that receipt eligible for a
later active, unlocked, connected foreground drain with existing Photos permission. Policy changes
cancel pending receipts, and claim leases, age, capacity, and attempts bound crash/retry behavior.

Durable incoming-event prerequisite recovery now has its own bounded task-local runner rather than
calling foreground `startSync`/`ensureChatSynced`. Missing chat/read/group prerequisites use an
authorized transport, targeted chat recovery where an identity exists, and account/deletion caps
otherwise. The incoming-event drain signals only after the row's exact five-second dependency
deferral commits; the FCM callback owns that already-running clock, the repair, and one bounded
retry. Account invalidation or App Lock aborts the repair and prevents a stale write.

Do not infer that the host proof completes the parent. Exact killed-process Android execution,
50/55-second timing, offline retry, and cancellation/no-stuck behavior remain open in the
authoritative plan.

<a id="rel-006"></a>

## `REL-006` — coherent HTTP identity across retries

Treat origin, query parameters, Bearer credentials, and headers as one logical-request
identity. Before retrying, re-read the complete live configuration and proceed only when it is still
identical. If any part changed, retire the old request without sending revoked credentials or mixing
new credentials with old-account work.

Writes remain non-retrying by default. A new logical request captures the complete replacement
identity rather than inheriting pieces from a previous attempt.

Native URL/header consumers must carry the pinned client's currentness into their own continuation
guard. A coherent snapshot prevents mixed credentials, but only the currentness guard prevents a
retired snapshot from starting or publishing after an approved same-account origin rotation.

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
encoder and `EventRouter` path. A locked, authenticated V2 delivery before its exclusive
2027-02-01 cutoff retains the generic-notice/no-DB exception; absent/V1/plaintext/invalid input posts
nothing. Authenticated, active-bound V3 may enqueue only its canonical envelope into SQLCipher,
without reading, claiming, routing, or applying queued content until unlock; later sync remains the
fallback.

The queue permits at most 1 MiB per payload, 500 pending rows, and 16 MiB of pending payloads. One
claim is token/version-fenced, covers at most 25 rows and 2 MiB, and leases them for 120 seconds. Five
claimed attempts back off for 30, 60, 120, 240, and 480 seconds. Terminal payloads are scrubbed;
bounded receipts remain for seven days and at most 2,000 rows.

Separate authoritative database application from presentation. The domain transaction checkpoints
`db_applied_at`; a later notification attempt reads current database truth rather than replaying stale
preview content. Newer message edits or deletions may converge before an older failed presentation,
but the presentation waits for all newer domain work. Missing prerequisites request bounded
task-local recovery and remain retryable. A successful dependency deferral starts its exact
five-second due clock immediately; an active FCM callback owns the bounded repair plus one retry
instead of returning while foreground-only sync runs detached. Deletion cancels any corresponding
Android notification.

Account-generation and App Lock checks surround intake, claim, handler work, and the final commit.
For servers that advertise `supports_rcs_send_attempt_ownership`, resolve that capability before
inserting an optimistic RCS row; unknown must not silently become legacy mode. Give every physical
send a complete `{tempGuid, attemptGuid, clientAttemptGeneration}` identity and reuse it across the
HTTP acknowledgement, socket, eligible FCM, webhook, and send-error copies. Partial or malformed
correlation fails closed rather than falling back to content matching.

Migration `0046_message_send_attempt_owner` durably records the monotonic client generation,
pending state, and active attempt on the optimistic message. A retry claims its next generation with
a compare-and-swap guard, so a delayed settlement from A cannot change B's owner. Exact
acknowledgement, live-message, and error reconciliation update only the matching owner; duplicate
delivery is idempotent. If the bounded temp-to-real alias has already been pruned, an exact
active-attempt lookup may recover the owner only when one row matches; missing or ambiguous matches
remain no-ops. A recovered attachment rearm restores the bounded alias transactionally before its
queue row is rebuilt, so the next claim finds the canonical owner and advances its generation. The
server must carry `clientAttemptGeneration` through listener, composition, and fanout boundaries; an
RCS new-chat acknowledgement also returns its `tempGuid` so it does not drop the logical side of the
tuple. Its 65,536-entry client-send ledger exceeds the full 50,000-message correlation bound while
leaving headroom for ordinary sends and fail-closed unknown outcomes; scheduled sends remain in a
separate bounded ledger.

Attempt-aware FCM acceptance depends on the coordinated `PUSH-CRYPTO-01` client migration. The
server deliberately sends payload data only when a canonical per-device V2 key is enrolled;
otherwise FCM receives routing type plus empty-object metadata. Socket/webhook attempt identity can
be implemented and verified independently, but it does not prove the killed-app FCM branch. The
host/source implementation and focused checks now cover durable active-attempt ownership, but the
authoritative work plan keeps the parent open until the same app and server sources are deployed and
a real phone proves A → B ordering across HTTP, socket, and FCM, including killed-process and server
restart boundaries. A queue-less post-ack retry also remains intentionally narrow: only a local
attachment can reconstruct its exact payload. Contact cards, mention metadata, and other
non-attachment payloads fail closed rather than being guessed from a lossy message row.

<a id="delete-sync-01"></a>

## `DELETE-SYNC-01` — lossless missed-deletion catch-up

Retain the frozen timestamp and v1 keyset protocols for compatibility, and negotiate the v2 durable
observation protocol with additive `ledger=1`. Old servers ignore the field. New servers rescan the
recoverable deletion source before every page, append newly observed exact identities to an
owner-only monotonic ledger, and page by observation sequence under a database epoch. A deletion
revealed later with an older timestamp or lower source row ID must receive a new sequence rather than
fall behind an already-issued cursor. The background database watcher writes the same exact
full-source snapshot before realtime fanout or deletion-cursor advance so an event observed while
clients are offline survives removal from Apple's temporary source.

Apply each deletion page and its next cursor in one account-guarded transaction. Retrying a page must
remain idempotent, and account revocation must prevent an old cursor commit. Until an unambiguous
continuation contract is available, a full page that cannot advance the timestamp watermark stops
fail-closed instead of silently skipping tied rows.

As of 2026-09-15, the server and app implement the frozen composite v1 continuation plus the additive
v2 durable observation ledger, `hasMore`, zero-origin initialization, legacy fallback, and atomic
page/state commit. Host tests prove late older-timestamp/lower-row observations, restart and epoch
recovery (including startup rotation before background refill can reuse restored sequences),
request-local rejection of forged-ahead cursors, background persistence before fanout, v1-to-v2
transition, v2-to-old-server downgrade recovery, pagination, rollback, and old-server fallback. The
response contract is host-green: the server owns canonical v1 and v2 continued-response fixtures,
and app contract tests consume byte-identical copies pinned to matching SHA-256 digests. A stable
repair-snapshot lease now fences the complete first-sync history boundary before absence-based
settlement. Both physical-device branches pass under the
[`DELETE-SYNC-01` device runbook](../DELETE_SYNC_DEVICE_RUNBOOK.md): stopped-process/reconnect and
App-Lock/unlock, each followed by a second restart with no resurrection or duplicate notification.
Each daemon start deliberately rotates the process epoch and therefore causes a conservative
retained-history replay on the next sync. The append-only ledger retains GUID/timestamp metadata,
but no message body or attachment content, in owner-only `config.db` without a TTL; the owner deferred
safe pruning until durable per-client acknowledgement/full-resync semantics exist. For older
timestamp-only servers, an
over-500 soft-boundary tie remains intentionally fail-closed; v1 is tie-safe for a stable result set,
while v2 also closes late-behind-cursor discovery for observed rows.

The owner also deferred three non-blocking product/protocol designs: the general mutable-message
reader's rare global timestamp-max loss window, false-positive-safe whole-chat/hard-delete detection,
and true recovered-message resurrection. Current deletion handling remains fail-closed: retained
tombstones win until a future protocol carries an explicit restore signal.

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

Since review M089 (2026-10-18) every entry names its chat and ordering turns are per chat: queued
sends to one chat always start in order, the window applies per chat, and the 32-job cap stays
shared. `LOGICAL_SEND_MAX_ACTIVE_CHATS` bounds how many chats may send at once and is **1**, which
is the single global FIFO described above. Raise it (to 3) only after the device step in
`docs/DEVICE_VERIFICATION_CHECKLIST.md` shows the Mac's AppleScript and RCS paths accept
simultaneous sends to different chats; if that check fails, leave it at 1. Two queue tests pin the
shipped value on purpose, so raising it also means updating them.

Manual Retry, the automatic retry of failed sends (the outgoing queue), scheduled sends and
new-chat creation never take a turn, before or after M089, so they can overlap a queued send to
the same chat.

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

Post a fixed app-authored `Message status needs review` / `Open Gator to review.` notice only after the encrypted database records an
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

Treat this as one coordinated app/server protocol. Give each device a random 256-bit key. AEAD
associated data authenticates protocol version, event/message type, server/account/device identity,
cryptographic occurrence id, optional message id with explicit presence, issue time, and expiry.

Claim replay ids transactionally before effects, retain them within a bounded persistent window,
rotate or revoke keys on disconnect, and reject legacy downgrade after an account/device migrates.
Cross-account, cross-device, wrong-key, modified-metadata, replayed, and downgraded envelopes must
all fail closed.

The implementation and acceptance sequence remains these ordered children:

1. **`PUSH-CRYPTO-01A` — current-server V2 interoperability:** retain the existing
   per-device random key, strict frame parsing, origin-bound local lifecycle, and post-migration
   downgrade containment. This is a compatibility baseline, not the final authenticated envelope.
2. **`PUSH-CRYPTO-01B` — shared identity and envelope contract:** use one canonical strictly ordered
   tagged-byte encoding and byte-identical cross-language fixtures for protocol version, event type,
   stable server-installation identity, durable account/principal identity, exact push-device
   identity, cryptographic occurrence id, optional message id with an explicit presence marker,
   issued time, and expiry. Enforce authoritative producers, length and lifetime bounds, canonical
   UUID/text encoding, exact field count/order, no trailing bytes, and per-field tamper rejection. A
   URL origin is not server identity; the server acknowledgement explicitly binds its durable scoped
   principal and push-device identities.
3. **`PUSH-CRYPTO-01C` — transactional replay admission:** after authenticating the complete binding,
   message relation, and time window, derive the occurrence key from the exact
   server/principal/device/occurrence tuple. Persist it before any notification or event effect, in
   the same transaction as durable admission. Enforce uniqueness across that authenticated scope,
   survive process death, and retain a bounded window that cannot evict an unexpired occurrence.
   Duplicate, conflicting, expired, future-dated, capacity-rejected, and malformed occurrences fail
   closed without producing an effect; locked delivery posts a generic notice only after a new
   durable admission.
4. **`PUSH-CRYPTO-01D` — coordinated key rotation, revocation, and migration:** negotiate V3 and
   versioned rotation on both app and server. Persist each candidate, prior version, stable rotation
   id, binding, and local time anchors before network commit; a retry after a lost response must
   receive the exact durable acknowledgement. Rotate active keys on a bounded schedule, prefer the
   current key, and accept only its immediate predecessor until the earlier app/server exclusive
   deadline. An ordinary same-key refresh without rotation metadata preserves durable rotation state
   but is not a rotation acknowledgement. Revoke the exact scoped device on disconnect, retain retry
   custody if cleanup fails, isolate other devices, and permanently reject explicit, omitted-key, or
   capability downgrade after versioned activation.
5. **`PUSH-CRYPTO-01E` — deployed-device proof:** run the shared vectors plus exact Android/Firebase,
   SecureStore/process-death, killed-app, replay-after-restart, cross-account, and cross-device
   evidence against one identified app/server candidate.

V2 remains a time-bounded shared-password compatibility path and never substitutes for V3 on a
scoped credential. Do not make a one-sided identity, envelope, acknowledgement, rotation, overlap,
or revocation change: accepting either runtime's old form as fallback would restore the downgrade.
The authoritative work plan alone records which child gates have passed and which exact deployed
candidate evidence remains.
