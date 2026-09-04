# RCS send reliability — the retry chain, end to end

*2026-07-22/23 hardening, updated 2026-09-04 for immutable attempt identity. Companion server-side
doc: `bluebubbles-server/docs/RCS_RUNBOOK.md`
("Send reliability" section). The incident that drove this: a picture send returned 502 and was
never retried; a text returned 500 and recovered — because texts had automatic retry and
pictures didn't, and the sidecar could self-heal an expired Google token for texts but not for
media uploads.*

## The chain

```
Composer → send service → HTTP → [zrok tunnel | Caddy] → bbd (packages/bbd)
        → RcsSender (loopback HTTP) → gator-rcs sidecar (Go, libgm) → Google Messages
```

A send can die at any hop. The design principle after the hardening: **every proven-safe failure
with a retained payload converges to "sent" through a bounded retry ladder or comes to rest as an
error bubble. Manual Try Again reuses the exact durable queue payload when that row still exists;
ambiguous and post-ack failures without a queue stop instead of pretending a safe reconstruction or
duplicate-free resend is possible.**

## Layer 1 — the app's outgoing queue (this repo)

Every optimistic send (text / reaction / **attachment**) writes an `outgoing_queue` row next to
its `temp-…` message row. `runOutgoingQueue` (`src/services/send/outgoingQueueService.ts`)
re-sends eligible rows with exponential backoff (30s → 1h cap, `OUTGOING_MAX_ATTEMPTS = 5`),
under an atomic per-row claim (`claimOutgoing`) so concurrent drains never double-send.

- **Attachments re-upload now.** The queue takes an injected `OutgoingQueueIO`
  (`{ upload, fileExists }` — expo implementations in prod, fakes in Node tests) and re-streams
  the file at the attachment row's `localPath` **under the original tempGuid**. A gone file or
  an unknown row kind retires immediately (`retireOutgoing`: attempts→cap, bubble stays errored)
  instead of zombie-looping.
- **Drain triggers:** home mount, the 15-min background task, the chat screen's 20s ticker, and
  AppState `active` (`recoverOutgoing`). Frequent drains are cheap: one indexed SELECT when the
  queue is idle; `next_retry_at` gates actual re-sends.
- **The ack-swallow fix (was a live duplicate-text bug):** the app-facing RCS ack returns the
  client's logical tempGuid, which reconciles through `markOutgoingSentNoGuid`. BBD separately sends
  the encoded `{tempGuid, attemptGuid}` correlation to the sidecar; the app never receives that
  opaque value as its send ack. The sticky-error guard refuses to touch an `'error'` row (protection
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

- `applyServerSendError` (`src/db/repositories/outgoingRetry.ts`) routes every `message-send-error`:
  queue row still present → bump attempts + reschedule backoff; queue row gone AND the event
  carries **`retryable: true`** → `reEnqueueOutgoingFromMessage` rebuilds a fresh queue row from
  the message/attachment tables (attempts=1, so it skips the grace window). Either way the
  bubble shows the error until a retry succeeds.
- **`retryable` semantics (server-set):** for pushed RCS failures, true ONLY for a proven
  pre-dispatch refusal: loopback `ECONNREFUSED` or lifecycle rejection before fetch. Timeouts,
  resets, sidecar HTTP errors, post-dispatch shutdown, and delivery-phase `failed` frames may follow
  dispatch and stay non-retryable. A sidecar-readiness preflight can still return a synchronous
  retryable 503 before dispatch. Older servers that omit the flag keep the app's prior bubble-only
  behavior.
- **Cycle cap:** each ack resets all durable state (queue row deleted, `error` cleared), so a
  permanently-failing send could loop ack → async-fail → re-enqueue forever. An in-memory,
  bounded counter caps automatic re-enqueues at **2 cycles per tempGuid per app session**; after
  that the bubble remains errored with no queue row and the current Try Again action reports that
  it cannot resend.
- **Current post-ack retry limit:** a non-retryable delivery failure also arrives after the ack has
  consumed the queue row. The app marks the exact bubble errored, but Try Again intentionally
  refuses to rebuild an incomplete payload. Therefore a user-driven attempt B is not yet available
  for that branch. The current automatic A → B proof must use a server-certified pre-dispatch
  failure with `retryable: true`; a broader manual post-ack retry needs a separately reviewed
  durable-payload/protocol design.

## Layer 3 — duplicate-safety (server idempotency)

Queue retries reuse the original tempGuid on purpose. BBD's owner-only `IdempotencyCache`, keyed by
that logical id plus the request fingerprint, durably reserves work before dispatch. In-flight,
crash-interrupted, and ambiguous records do **not** expire; only a confirmed result receives a
15-minute replay TTL. A duplicate therefore reuses the same execution and server-owned UUID
`attemptGuid`, or receives `idempotency_outcome_unknown` rather than risking a second physical send.

BBD encodes `{tempGuid, attemptGuid}` in the sidecar's opaque `tmpID`. The first valid echoed
correlation is stored against the exact physical-phone namespace plus real message id, so later
status-only frames and a BBD restart retain the same attempt. An authoritative delivery failure
releases only that idempotency generation, including when it arrives before the owner promise
settles. A retry may then reuse the logical tempGuid while receiving a new physical attemptGuid;
a delayed failure from the old attempt cannot evict the new server reservation. When a durable
queue row exists, manual `retry()` deliberately reuses that original tempGuid and exact queue
payload. It never mints a replacement id or reconstructs a queue-less send from the visible bubble.

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
  never temp/chat/attempt ids in plaintext. The current app does not enroll or decrypt the server's
  `AEAD_GCM_V2_DEVICE` scheme, so attempt-aware FCM is blocked on `PUSH-CRYPTO-01`; the logical DTO is
  currently consumable over socket/webhook only. It stays normal priority. Legacy temp-only errors
  also remain socket/webhook-only because the app cannot safely deduplicate them across transports.

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

| Failure | Before | After |
|---|---|---|
| Transport 5xx on a picture upload | Error bubble forever (queue skipped attachments) | Auto-retried ≤5× with backoff; converges to sent or rests as error + manual retry |
| Expired Google token during media upload | 502, never retried (sidecar blind to media 401s) | Sidecar refreshes token + retries in-place; send succeeds |
| Bridge long-poll dead, token valid | 30s hang → 502, not retried | Pre-flight reconnect; fast self-heal |
| Sidecar process restarting | Opaque ECONNREFUSED 500 | Fast 503 `bridge_unavailable` (retryable) |
| Failed client-side but actually delivered | Duplicate bubble + retry ladder kept firing (dup sends) | Echo promotes the errored bubble; ladder stops |
| Queue retry succeeded (RCS ack) | **Swallowed** → duplicate re-sends every drain | Reconciles to sent, queue cleared |
| Async failure after the immediate ack | Manual retry only | Auto re-enqueued when server says `retryable:true` (≤2 cycles); otherwise queue-less Try Again remains unavailable |
| Media > 100 MB | Buffered, then opaque 400/500 deep in the chain | Immediate 413, no retry burn |
| Ack lost but server delivered, app retries | Potential duplicate picture | Durable reservation replays the same attempt; ambiguous records do not expire |
| Already-processed failure A is replayed after retry B | Replay could relabel B | Exact occurrence receipt deduplicates the replay; a first-delayed A still needs active-attempt ownership |

## Tests that lock this

- `test/services/outgoingQueueService.test.ts` — attachment resend (success/failure/file-gone/
  unknown-kind), the ack-swallow regression, `applyServerSendError` (bump / bubble-only /
  retryable re-enqueue attachment+text / cycle cap / reaction exclusion)
- `test/services/echoReconcile.test.ts`, `test/services/sendAttachmentService.test.ts` —
  errored-row promotion on the live + sync reconcile paths
- `test/services/dbEventSink.test.ts` — the `retryable` wire flag re-arms the queue
- `test/services/sendRetryGuard.test.ts` — queue-less manual retry refuses without changing the bubble
- Server: `packages/bbd/test/{attachmentUploadRoutes,rcsSender,idempotencyCache,rcsAttemptCorrelation,rcsCacheStore,rcsListener,rcsOutbound,execute}.test.ts`
  (durable replay, immutable attempt identity, phone/re-pair isolation, exact-generation release,
  the same logical DTO at each composition sink, 503/413, and retryable classification/propagation);
  sidecar: `packages/rcs-sidecar/bridge_test.go` (media-401 classification, media reauth-retry
  regression, pre-flight reconnect)

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
5. **After `PUSH-CRYPTO-01` adds client V2 key enrollment/decryption**, begin a staged RCS attachment
   send while the app is alive. Use a deterministic staged loopback fault seam: let readiness,
   admission, and media preparation pass; hold the sidecar fetch pending until the immediate ack
   returns; then background the app and kill it with `am kill` (not force-stop). Release the held
   fetch as a classified `ECONNREFUSED`, proving the sidecar never accepted attempt A. A text/new-chat
   failure, bridge-down preflight, or lifecycle stop that wins before the ack does not exercise this
   event. Prove A's `retryable: true` FCM error converges exactly once with its socket copy and the
   app automatically re-enqueues the retained attachment.
6. Restore the bridge and let that ladder create attempt B under the same logical tempGuid. Use
   bounded owner-only evidence to prove B's attempt id differs from A, then replay an
   **already-processed** copy of A through the other authorized transport and verify it cannot alter
   B. A first-ever A event delayed until after B is not yet fenced by app-side attempt ownership.
   Do not substitute a delivery-phase failure here: after its immediate ack consumed the queue,
   current Try Again is unavailable.

## Compatibility / rollout

The attempt fields are additive: an old server omits `attemptGuid`, leaving bubble-only/best-effort
dedup, while an old/current app can ignore new socket fields and still interpret 503/413 as ordinary
5xx/4xx statuses. The FCM branch is not independently consumable yet: the server uses optional
per-device `AEAD_GCM_V2_DEVICE` and metadata-only fallback, while the current app enrolls no V2 key
and skips that scheme. `PUSH-CRYPTO-01` must coordinate that migration. The original sidecar
hardening was hot-swapped onto prod 2026-07-22 (runbook procedure; backup
`gator-rcs.bak-pre-rcs-hardening-0722`). Immutable attempt identity is source/host-green at server
commit `e55f1210`; it is not claimed deployed or device-proven here.
