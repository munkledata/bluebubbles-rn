# RCS send reliability — the retry chain, end to end

*2026-07-22/23 hardening. Companion server-side doc: `bluebubbles-server/docs/RCS_RUNBOOK.md`
("Send reliability" section). The incident that drove this: a picture send returned 502 and was
never retried; a text returned 500 and recovered — because texts had automatic retry and
pictures didn't, and the sidecar could self-heal an expired Google token for texts but not for
media uploads.*

## The chain

```
Composer → send service → HTTP → [zrok tunnel | Caddy] → bbd (packages/bbd)
        → RcsSender (loopback HTTP) → gator-rcs sidecar (Go, libgm) → Google Messages
```

A send can die at any hop. The design principle after the hardening: **every failure either
converges to "sent" via a bounded automatic retry ladder, or comes to rest as an error bubble
with a working manual retry — and no path can deliver the same message twice.**

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
- **The ack-swallow fix (was a live duplicate-text bug):** an RCS ack echoes the client's own
  tempGuid, which reconciles through `markOutgoingSentNoGuid` — whose sticky-error guard refuses
  to touch an `'error'` row (protection against a failure event racing the SAME attempt's ack).
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

- `applyServerSendError` (`src/db/repositories/outgoing.ts`) routes every `message-send-error`:
  queue row still present → bump attempts + reschedule backoff; queue row gone AND the event
  carries **`retryable: true`** → `reEnqueueOutgoingFromMessage` rebuilds a fresh queue row from
  the message/attachment tables (attempts=1, so it skips the grace window). Either way the
  bubble shows the error until a retry succeeds.
- **`retryable` semantics (server-set):** true ONLY for send-phase transport/bridge failures —
  sidecar unreachable/restarting, timeouts, sidecar 5xx — where **nothing reached Google**, so a
  re-send cannot duplicate. Delivery-phase `failed` frames (Google accepted, then delivery
  failed) and 4xx rejections stay non-retryable. Older servers never send the flag → the app
  behaves exactly as before (bubble-only).
- **Cycle cap:** each ack resets all durable state (queue row deleted, `error` cleared), so a
  permanently-failing send could loop ack → async-fail → re-enqueue forever. An in-memory,
  bounded counter caps automatic re-enqueues at **2 cycles per tempGuid per app session**; after
  that it's manual-retry only.

## Layer 3 — duplicate-safety (server idempotency)

Queue retries reuse the original tempGuid on purpose: bbd's `IdempotencyCache` (keyed by
tempGuid, **10-min TTL** ≥ the app's full backoff ladder) replays the first ack for a retry
whose original attempt actually succeeded but lost its response — covering **both** the text op
and the multipart upload route. When a backgrounded RCS send fails, bbd **evicts** the cached
synthetic ack before emitting `message-send-error`, so a retry re-dispatches instead of
replaying a lie. Manual retry (`retry()`) deliberately mints a NEW tempGuid — it deletes the old
row first, so the old key must not absorb the new send.

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
| Async failure after the immediate ack | Manual retry only | Auto re-enqueued when server says `retryable:true` (≤2 cycles) |
| Media > 100 MB | Buffered, then opaque 400/500 deep in the chain | Immediate 413, no retry burn |
| Ack lost but server delivered, app retries | Potential duplicate picture | Idempotent replay by tempGuid (10-min TTL) |

## Tests that lock this

- `test/services/outgoingQueueService.test.ts` — attachment resend (success/failure/file-gone/
  unknown-kind), the ack-swallow regression, `applyServerSendError` (bump / bubble-only /
  retryable re-enqueue attachment+text / cycle cap / reaction exclusion)
- `test/services/echoReconcile.test.ts`, `test/services/sendAttachmentService.test.ts` —
  errored-row promotion on the live + sync reconcile paths
- `test/services/dbEventSink.test.ts` — the `retryable` wire flag re-arms the queue
- `test/services/sendRetryGuard.test.ts` — manual retry with no content is a safe no-op
- Server: `packages/bbd/test/{attachmentUploadRoutes,rcsSender,idempotencyCache,execute}.test.ts`
  (idempotent upload replay, evict-on-failure, 503/413, retryable classification/propagation);
  sidecar: `packages/rcs-sidecar/bridge_test.go` (media-401 classification, media reauth-retry
  regression, pre-flight reconnect)

## Device verification (jest can't drive these)

1. Stop the server → send a picture → error bubble → start the server → picture auto-sends
   within ~30 s (chat-ticker drain), exactly one bubble, exactly one copy at the recipient.
2. Same with a text (regression: the bubble must flip to sent — not stay errored — and never
   re-send on later drains).
3. Kill the `gator-rcs` process mid-session → next send shows the fast failure, supervisor
   relaunches, ladder delivers on a later attempt.

## Compatibility / rollout

App and server halves are independently shippable: old server + new app → the flag is simply
absent (bubble-only, as before); new server + old app → `retryable` is ignored, 503/413 are
still 5xx/4xx to the old client. The sidecar hardening was hot-swapped onto prod 2026-07-22
(runbook procedure; backup `gator-rcs.bak-pre-rcs-hardening-0722`).
