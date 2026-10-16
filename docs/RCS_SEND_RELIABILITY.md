# RCS send reliability — the retry chain, end to end

_2026-07-22/23 hardening, updated 2026-09-07 for durable active-attempt ownership and transport
binding. Companion
server-side doc: `bluebubbles-server/docs/RCS_RUNBOOK.md`
("Send reliability" section). The incident that drove this: a picture send returned 502 and was
never retried; a text returned 500 and recovered — because texts had automatic retry and
pictures didn't, and the sidecar could self-heal an expired Google token for texts but not for
media uploads._

## The chain

```
Composer → send service → HTTP → [zrok tunnel | Caddy] → bbd (packages/bbd)
        → RcsSender (loopback HTTP) → gator-rcs sidecar (Go, libgm) → Google Messages
```

A send can die at any hop. The design principle after the hardening: **every proven-safe failure
with a retained payload converges to "sent" through a bounded retry ladder or comes to rest as an
error bubble. Manual Try Again reuses the exact durable queue payload when that row still exists.
After an immediate ack has consumed that row, only an attachment whose local file metadata remains
durable can be reconstructed automatically; text/contact sends stop visibly rather than guessing at
an incomplete payload.**

## Layer 1 — the app's outgoing queue (this repo)

Every optimistic send (text / contact / reaction / **attachment**) writes an `outgoing_queue` row
next to its `temp-…` message row. `runOutgoingQueue`
(`src/services/send/outgoingQueueService.ts`) re-sends eligible rows with exponential backoff
(30s → 1h cap, `OUTGOING_MAX_ATTEMPTS = 5`), under an atomic per-row claim
(`claimOutgoingForSendWithinTransaction` in `src/db/repositories/outgoingRetry.ts`) so concurrent
drains never double-send.

- **Capability is known before the optimistic RCS insert.** The server advertises
  `supports_rcs_send_attempt_ownership`. If server info is not cached yet, the app resolves it
  before creating the row instead of silently treating startup's unknown state as legacy. A known
  old server remains generation zero.
- **Capability and credentials stay on one transport.** A foreground send captures the current
  server origin, transport revision, and capability together, then rejects the attempt if that
  session rotates before admission or network dispatch. A background scheduled send keeps the
  exact task-local client paired with the server info fetched through that client. A killed-process
  notification reply builds a fixed client from the still-authorized vault record and never reads
  or publishes the unhydrated foreground session store. This prevents an A → B → A server switch,
  logout, or cold process from mixing one server's feature decision with another server's password.
- **The active owner is durable.** A capable RCS row stores an app-owned generation and a
  pending/settled owner state. Initial send and retry claims return an immutable local token. Retry
  uses a compare-and-swap (CAS: the update succeeds only if the row still has the expected state)
  to advance the generation, preventing two drains from both claiming the next attempt.
- **Attachments re-upload now.** The queue takes an injected `OutgoingQueueIO`
  (`{ upload, fileExists }` — expo implementations in prod, fakes in Node tests) and re-streams
  the file at the attachment row's `localPath` **under the original tempGuid**. A gone file or
  an unknown row kind retires immediately (`retireOutgoing`: attempts→cap, bubble stays errored)
  instead of zombie-looping.
- **Drain triggers:** home mount, the 15-min background task, the chat screen's 20s ticker,
  AppState `active`, and App Lock unlock (`recoverOutgoing`). Frequent drains are cheap: one indexed SELECT when the
  queue is idle; `next_retry_at` gates actual re-sends.
- **The ack-swallow fix (was a live duplicate-text bug):** the app-facing RCS ack returns the
  client's logical tempGuid in `guid`. A capable ack also returns `attemptGuid` and
  `clientAttemptGeneration`; the app reconciles it under the immutable local request token. BBD
  separately sends an opaque encoding of the exact tuple to the sidecar; the app never receives
  that wire value as its ack. The sticky-error guard refuses to touch an `'error'` row (protection
  against a failure event racing the SAME attempt's ack).
  A queue retry's row is always `'error'`, so a retry's SUCCESS was swallowed: bubble stayed
  errored, the queue row survived un-bumped, and the message re-sent on every later drain.
  `resend()` now flips the row `'error' → 'sending'` first (`markOutgoingSending`), scoping the
  sticky guard back to its original race.
- **Failed-but-delivered self-heal:** both content reconcilers (`reconcileEchoByContent`, live;
  `reconcileOutgoingAttachmentByContent`, sync) now also match `'error'` rows — when a send
  failed client-side (502 mid-response) but actually went through, its fanout echo promotes the
  errored bubble in place and clears the queue row (stopping the ladder) instead of inserting a
  duplicate bubble.

## Layer 2 — server-pushed failures (`message-send-error`)

RCS media sends use an **immediate-ack** contract: bbd acks `{ guid: tempGuid }` instantly,
relays to Google in the background, and reports a send-phase failure asynchronously as
`message-send-error`. The ack marks the bubble sent and deletes the queue row — so an async
failure needs its own path back into the ladder:

- On a capable server, the ack, exact success echo, and send error carry
  `{tempGuid, attemptGuid, clientAttemptGeneration}`. Normal-send acknowledgements retain the
  existing `guid: tempGuid` slot plus the attempt fields; RCS new-chat results name all three tuple
  fields. The app installs the physical attempt id under the request's local generation token. This
  matters when the server replays an older retained physical attempt: the replayed `attemptGuid`
  becomes the owner of the current local retry without rolling its durable generation backward.
- `applyServerSendError` (`src/db/repositories/outgoingRetry.ts`) routes every
  `message-send-error`: queue row still present → bump attempts + reschedule backoff; queue row gone
  AND the event carries **`retryable: true`** → rebuild only when the message still has an attachment
  with retained local file metadata (attempts=1, so it skips the grace window). Text and contact
  rows remain visibly failed because their exact kind, mentions, reply context, or contact-card
  metadata cannot be faithfully recovered from the bubble alone.
- **`retryable` semantics (server-set):** for pushed RCS failures, true ONLY for a proven
  pre-dispatch refusal: loopback `ECONNREFUSED` or lifecycle rejection before fetch. Timeouts,
  resets, sidecar HTTP errors, post-dispatch shutdown, and delivery-phase `failed` frames may follow
  dispatch and stay non-retryable. A sidecar-readiness preflight can still return a synchronous
  retryable 503 before dispatch. Older servers that omit the flag keep the app's prior bubble-only
  behavior.
- **Exact ownership fences delayed events.** A result for attempt A can change the bubble only while
  A is pending for that local generation or is the settled active owner. Once retry B owns the row,
  A is stale. If the tempGuid alias has been pruned, the app falls back to `attemptGuid` only when it
  identifies exactly one active owner; ambiguity fails closed. Partial/malformed tuples are marked
  invalid, never content-matched, and receive a distinct durable intake identity so they do not
  suppress a later corrected tuple.
- **Cycle cap:** each attachment ack deletes the queue row, so a permanently failing send could loop
  ack → async-fail → rebuild forever. An in-memory bounded counter caps safe attachment
  re-enqueues at **2 cycles per tempGuid per app session**; after that the bubble remains errored.
- **Current post-ack retry limit:** queue-less text/contact automatic replay and queue-less manual
  Try Again remain unavailable until payload kind and complete resend metadata are durably retained.
  A non-retryable post-ack failure also remains an error bubble because dispatch may already have
  occurred. This is intentional duplicate protection, not an unfinished blind retry.

## Layer 3 — duplicate-safety (server idempotency)

Queue retries reuse the original tempGuid on purpose. BBD's owner-only `IdempotencyCache`, keyed by
that logical id plus the request fingerprint, durably reserves work before dispatch. In-flight,
crash-interrupted, and ambiguous records do **not** expire; only a confirmed result receives a
bounded replay TTL. Ordinary confirmed sends retain the 15-minute default; attempt-aware RCS sends
retain their result for the same 90-day horizon as the correlation cache. The shared client-send
ledger holds 65,536 entries—above the correlation cache's entire 50,000-message supported set, with
headroom for short-lived ordinary sends and operator-reviewed unknown outcomes. A duplicate therefore
reuses the same execution and server-owned UUID `attemptGuid`, or receives
`idempotency_outcome_unknown` rather than risking a second physical send.

BBD encodes `{tempGuid, attemptGuid, clientAttemptGeneration}` in the sidecar's opaque v2 `tmpID`.
Legacy correlation remains readable for older clients. The first valid echoed
correlation is stored against the exact physical-phone namespace plus real message id, so later
status-only frames and a BBD restart retain the same attempt. An authoritative delivery failure
releases only that idempotency generation, including when it arrives before the owner promise
settles. A retry may then reuse the logical tempGuid while receiving a new physical attemptGuid;
a delayed failure from the old attempt cannot evict the new server reservation. When a durable
queue row exists, manual `retry()` deliberately reuses that original tempGuid and exact queue
payload. It never mints a replacement id or reconstructs a queue-less send from the visible bubble.

The server publishes the capability in `/server/info`, validates the bounded client generation,
and round-trips attempt ownership in normal RCS acknowledgements and RCS new-chat results. This
makes the HTTP response, live success, socket/webhook event, and encrypted FCM event describe the
same physical attempt without exposing the sidecar's opaque wire id as an app-facing identifier.

The phone/message correlation cache is separately bounded to 90 days and 50,000 messages. An
exceptionally late status after pruning falls back to a non-exact socket/webhook event; it is not
sent through FCM. A crash after Google accepts the send but before BBD persists the first correlated
frame remains unresolved because the sidecar has no durable outbound spool containing the real
message id.

## Layer 4 — bbd → sidecar (server repo)

- `RcsSender` calls carry real timeouts (5 min sends / 12 min media / 60s aux — generous, above
  the sidecar's own internal retry budget, because aborting a still-succeeding send manufactures
  the orphaned-success duplicate the timeout exists to prevent) and wrap transport failures into
  typed errors: `sidecar_unreachable` (503) / `timeout` (504) instead of a bare "fetch failed".
- A down/restarting sidecar child fails **fast** with `503 { type: "bridge_unavailable",
retryable: true }` (pre-flight `rcsReady` on every RCS send path) — the app's HTTP layer
  treats any 5xx as retryable, so the ladder just works, but logs are now diagnosable.
- RCS media over Google's ~100 MB limit → **413 `media_too_large`, retryable:false**, rejected
  BEFORE the whole-file base64 read (also an OOM guard — the multipart cap is 2 GiB, sized for
  iMessage).
- Attempt-aware `message-send-error` reuses one logical DTO across authenticated socket, webhook,
  and FCM before transport-specific serialization/encryption. Managed-device FCM requires
  `messages:write`; unmanaged legacy push rows retain compatibility authorization. With a canonical
  per-device key the DTO is encrypted; without one, FCM carries only the event type and `{}` data,
  never temp/chat/attempt ids in plaintext. `PUSH-CRYPTO-01A` gives the app a host-green current-server
  `AEAD_GCM_V2_DEVICE` enrollment/decryption path, so attempt-aware FCM is eligible for device testing.
  Matching app/server deployment, killed-app delivery, and the broader replay/identity protocol remain
  open under `PUSH-CRYPTO-01`. It stays normal priority. Legacy temp-only errors remain socket/webhook-only
  because the app cannot safely deduplicate them across transports.
- The background `RcsListener` delivery-error adapter forwards `clientAttemptGeneration` together
  with temp/chat/error/attempt identity. The composition boundary no longer drops the generation
  before the shared socket/webhook/FCM fanout.

## Layer 5 — the sidecar (Go, `packages/rcs-sidecar`)

- **Media auth-retry parity (the root cause):** libgm's media upload returns UNTYPED
  `"unexpected status code 401"` strings, invisible to `isAuthError` — so an expired-token
  picture send never triggered the automatic token-refresh-and-retry that texts got.
  `classifyUploadError` re-tags status-carrying upload failures (`httpStatusError`), and
  `withReauthRetry` now heals media exactly like text.
- **Pre-flight reconnect:** send-class ops (`Send`/`SendMedia`/`SendReaction`/
  `GetOrCreateConversation`) check the long-poll before the first attempt; an observed-dead
  connection kicks the debounced reconnect + settle instead of hanging 30s into a
  non-retryable `errRPCTimeout`.
- `/send-media` gets its own 160 MiB JSON body cap (base64 of 100 MB + overhead); every other
  route keeps 64 MiB.

## Failure-mode matrix (what the user sees)

| Failure                                            | Before                                                  | After                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Transport 5xx on a picture upload                  | Error bubble forever (queue skipped attachments)        | Auto-retried ≤5× with backoff; converges to sent or rests as error + manual retry                    |
| Expired Google token during media upload           | 502, never retried (sidecar blind to media 401s)        | Sidecar refreshes token + retries in-place; send succeeds                                            |
| Bridge long-poll dead, token valid                 | 30s hang → 502, not retried                             | Pre-flight reconnect; fast self-heal                                                                 |
| Sidecar process restarting                         | Opaque ECONNREFUSED 500                                 | Fast 503 `bridge_unavailable` (retryable)                                                            |
| Failed client-side but actually delivered          | Duplicate bubble + retry ladder kept firing (dup sends) | Echo promotes the errored bubble; ladder stops                                                       |
| Queue retry succeeded (RCS ack)                    | **Swallowed** → duplicate re-sends every drain          | Reconciles to sent, queue cleared                                                                    |
| Async failure after the immediate ack              | Manual retry only                                       | Retained attachment auto-rebuilt when `retryable:true` (≤2 cycles); text/contact stay visibly failed |
| Media > 100 MB                                     | Buffered, then opaque 400/500 deep in the chain         | Immediate 413, no retry burn                                                                         |
| Ack lost but server delivered, app retries         | Potential duplicate picture                             | Durable reservation replays the same attempt; ambiguous records do not expire                        |
| Failure A arrives after retry B owns the bubble    | Delayed A could relabel B                               | Durable generation + active attempt reject A as stale, even on its first arrival                     |
| Partial/malformed modern correlation arrives first | Could fall through to heuristic matching or hide repair | Fails closed under its own durable identity; a corrected exact tuple can still run                   |
| RCS send starts before server info is cached       | Unknown capability became a permanent legacy send       | Capability resolves before optimistic insert; known old servers alone use generation zero            |

## Tests that lock this

- `test/services/outgoingQueueService.test.ts` — attachment resend (success/failure/file-gone/
  unknown-kind), the ack-swallow regression, `applyServerSendError` (bump / bubble-only / safe
  queue-less attachment rebuild / contact fail-closed / cycle cap / reaction exclusion)
- `test/db/outgoingBranches.test.ts` — queue-less text fail-closed and transactional re-enqueue
  behavior
- `test/db/rcsAttemptOwnership.test.ts` — retry compare-and-swap ownership, delayed A versus B,
  durable older-attempt replay under the current local token, partial modern ack rejection,
  generation-zero legacy behavior, and alias-prune recovery by one exact active owner
- `test/contract/wireContract.test.ts` and incoming-event codec/sink suites — complete tuple parsing,
  invalid-correlation marking, distinct durable identity, exact success/error reconciliation, and
  process-death-safe replay behavior
- `test/services/echoReconcile.test.ts`, `test/services/sendAttachmentService.test.ts` —
  errored-row promotion on the live + sync reconcile paths
- `test/services/dbEventSink.test.ts` — the `retryable` wire flag re-arms the queue
- `test/services/sendRetryGuard.test.ts` — queue-less manual retry refuses without changing the bubble
- Server: `packages/bbd/test/{attachmentUploadRoutes,rcsSender,idempotencyCache,rcsAttemptCorrelation,rcsCacheStore,rcsListener,rcsOutbound,execute}.test.ts`
  (durable replay, immutable attempt identity, phone/re-pair isolation, exact-generation release,
  the same logical DTO at each composition sink, 503/413, and retryable classification/propagation);
  `composeBackendBackgroundRuntime.test.ts` locks delivery-error generation forwarding, while the
  action/OpenAPI contracts lock the normal-send and RCS new-chat ownership results;
  sidecar: `packages/rcs-sidecar/bridge_test.go` (media-401 classification, media reauth-retry
  regression, pre-flight reconnect)

The focused host suites and TypeScript checks pass in both repositories as of 2026-09-07. They prove
the deterministic ownership transitions, not Google delivery or Android process behavior.

## Device verification (jest can't drive these)

1. Stop the server → send a picture → error bubble → start the server → picture auto-sends
   within ~30 s (chat-ticker drain), exactly one bubble, exactly one copy at the recipient.
2. Same with a text (regression: the bubble must flip to sent — not stay errored — and never
   re-send on later drains).
3. Kill the `gator-rcs` process mid-session → next send shows the fast failure, supervisor
   relaunches, ladder delivers on a later attempt.
4. On a paired physical phone, prove Google echoes the encoded `tmpID` for text and media at the
   supported length and that the persisted destination-registration UUID remains the correlation
   namespace across restart.
5. With matching current app/server source builds installed, begin a staged RCS attachment send
   while the app is alive. Use a deterministic staged loopback fault seam: let readiness,
   admission, and media preparation pass; hold the sidecar fetch pending until the immediate ack
   returns; then background the app and kill it with `am kill` (not force-stop). Release the held
   fetch as a classified `ECONNREFUSED`, proving the sidecar never accepted attempt A. A text/new-chat
   failure, bridge-down preflight, or lifecycle stop that wins before the ack does not exercise this
   event. Prove A's `retryable: true` FCM error converges exactly once with its socket copy and the
   app automatically re-enqueues the retained attachment.
6. Restore the bridge and let that ladder create attempt B under the same logical tempGuid. Use
   bounded owner-only evidence to prove B's attempt id differs from A, then replay an
   already-processed copy of A through the other authorized transport and verify it cannot alter B.
   Then repeat with A's first-ever event held until after B settles; it must also be rejected as
   stale. Do not substitute a delivery-phase failure here: only a certified pre-dispatch retryable
   attachment failure retains enough evidence for safe automatic reconstruction.

## Compatibility / rollout

The capability and attempt fields are additive. A known old server omits
`supports_rcs_send_attempt_ownership`, so the app retains generation-zero legacy handling; an old
app can ignore the added response/event fields and still interpret 503/413 as ordinary 5xx/4xx
statuses. A capable server that returns only part of the promised tuple fails closed on the current
app rather than being silently downgraded.

The current-server FCM branch is host-consumable after `PUSH-CRYPTO-01A`: the app enrolls an optional
per-device `AEAD_GCM_V2_DEVICE` key and rejects post-migration downgrade. The parent
`PUSH-CRYPTO-01` still owns authenticated identity metadata, persistent replay defense,
server-coordinated revocation/migration, and exact-device proof. The original sidecar hardening was
hot-swapped onto prod 2026-07-22 (runbook procedure; backup
`gator-rcs.bak-pre-rcs-hardening-0722`). Immutable attempt identity began at server commit
`e55f1210`; durable app ownership is source/host-green as of 2026-09-07. Neither statement claims
that release v59 or any other release contains this work, nor that it is deployed or device-proven.
Queue-less text/contact automatic replay remains intentionally unavailable until payload kind and
all resend metadata are retained durably.
