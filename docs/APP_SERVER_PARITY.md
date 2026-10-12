# App ↔ Server Parity

## Checkpoint setup and server presence checks — 2026-10-11

The provider-scoped crawl in the next section can finish only while the Mac's `chat.db` does not
change. On an active account it failed and, until this change, blocked all ordinary sync. Host-tested
app behavior in `src/services/sync/providerRepair.ts`:

- **A repair never blocks sync.** A failed repair is logged; the chat list, RCS refresh and incremental
  (or first) sync still run, and only a user-started repair reports its failure afterwards. Automatic
  attempts wait 15 minutes, doubling to 24 hours (±20%), per provider identity
  (`sync.messageState.imessage.repairBackoff`).
- **Automatic repairs install from the checkpoint.** Version 2 `begin` returns a self-contained ledger
  checkpoint; the app cancels the lease at once and installs the authority there. The ledger covers
  everything fetched afterwards; messages already on the phone are recorded for a deleted-message
  check (`sync.messageState.imessage.audit`).
- **The check trusts only typed presence answers.** It runs only when the server advertises
  `supports_message_state_presence` (`POST /sync/message-state/presence`, up to 500 GUIDs; the app
  asks for 200). Each answer is `active` in exactly one chat, `absent`, or `ambiguous`, at a ledger
  position no older than the checkpoint. Retained deletions are settled first: restored only when
  `active` in the same chat, and an ownerless one takes the answer's chat only without a conflict.
  Then visible Apple messages are hidden only when `absent`. Proven answers are stamped at the
  answer's position; unproven older-ledger deletions keep their old ledger. Each 25-row batch re-reads
  its plan in its own transaction and writes nothing if anything changed. Any error, including an
  untyped 404 or a mismatched answer, pauses without advancing. An automatic sync checks at most
  2,000 rows or 15 seconds per run.
- **Catch-up.** A restoration already decided by a newer stored transition is not hydrated; a
  conflicting transition at the same position requests a repair instead of failing every later sync.
- **Full Repair.** On a presence server it installs from a fresh checkpoint, re-downloads every Apple
  chat's full history with ordinary reads (RCS keeps its bounded refresh), and runs the check to
  completion. As the crawl did, each page's chat is bound to its messages' ownerless server receipts
  before the page is saved, and any chat that cannot be downloaded fails the repair. A check that does
  not finish is reported as a limited refresh that continues on later syncs. Pages are read by offset,
  so a deletion on the Mac during a chat's download can shift one older message past the next page; a
  later Full Repair reads it. Servers without presence keep the snapshot crawl.
- **Sync bookmark.** A new provider identity means a different Messages database. Setup clears the
  row-id bookmark in its own transaction, incremental sync waits until setup succeeds, and the first
  sync restarts the bookmark at the newest Apple message the server's chat list names before any
  history is fetched, never at this phone's own rows or at RCS rows. Full Repair restarts it the same
  way, but keeps an existing bookmark when the server lists no newest message. A ledger reset on the
  same database, and a bookmark saved before message-state sync existed, keep the bookmark.

Server dependency: the presence route and flag are on server branch `step8/batch-presence`
(`c5fef29d`), not deployed as of this entry. Until then the check stays recorded and Full Repair keeps
the crawl. This is host-test evidence only; it claims no device or packaged-server acceptance.

## Versioned provider recovery — 2026-10-03 candidate

Since 2026-10-11, automatic repairs and Full Repair on presence servers no longer use this crawl; see
the section above.

`POST /sync/message-state` version 1 and provider-scoped `/sync/repair-snapshot` version 2
separate Apple Messages history (including Apple SMS) from RCS. The client accepts the new
protocol only with all advertised capabilities and an explicit provider identity. A complete,
finished Apple snapshot installs its exact signed cursor and sequence in the same local transaction
as the rebuilt message marker. Its full history crawl is independent of the initial-sync message cap.
RCS remains an additive refresh, capped at 100 messages per chat per run; it does not authorize
Apple absence cleanup. A competing local writer invalidates the repair's existing write fence.

Server deletion/restore state has its own table. Local and historical ambiguous deletion receipts,
chat-history deletion boundaries, outgoing ownership, and user-hidden chats retain their protections.
Exact owners retained by local deletion receipts or canonical outgoing aliases remain binding after
message eviction; conflicting server transitions, hydration, and snapshot owner binding are rejected.
Snapshot absence produces a reversible server hide, not a local deletion receipt. A later versioned
restore or successful scoped snapshot can reveal that row. Ordinary delayed message ingestion cannot
clear a current snapshot hide. An absent GUID that the server never recorded in its transition ledger
may therefore require another scoped repair when it reappears.

Realtime sequences order each message but never advance the REST cursor. REST commits each bounded
500-event page and its cursor together. All page events are validated, then only each message's final
state is projected, avoiding intermediate restoration when the same page ends in deletion. Earlier
exact chat ownership is preserved, and conflicting owners invalidate the page before any writes.
Foreground sync drains the captured boundary up to 1,000 pages;
headless recovery retains a five-page and time budget. Reaching either page cap with work remaining
reports incomplete progress and retains the cursor for the next refresh, rather than reporting success.
Exact restored-message hydration uses
`POST /sync/message-state/message`; a missing current message requests another scoped repair without
revealing cached content or advancing that page. Proven ownership and payload may commit before the
page finishes, while transition sequence/kind and the REST cursor remain in its final transaction.
Old provider/ledger state is retired or rebased in
bounded transactions during successful repair. Legacy delete events cannot supersede the new authority.

This section describes the implementation candidate and host-test contract. It does not claim physical
Android process-death, SQLCipher, or packaged-server acceptance.
The development-only database self-tests and native result validators target migration 54; their
historical migration prefixes remain unchanged. Their previous migration-53 pins rejected the newer
test database, but did not affect ordinary production startup.

_Initial baseline generated 2026-07-01 from a bidirectional API/feature reconciliation between the RN app (`~/github/bluebubbles-rn`) and the Gator server (`~/github/BB/bluebubbles-server`, then-current `master`). Later dated annotations record subsequent verification and closure; counts and `CONFIRMED` labels without a newer date describe that original baseline, not a fresh whole-repository scan._

> **Current-client boundary (updated 2026-09-30; `FP-006`):** The current Gator client retires
> broad helper-dependent targeted iMessage actions and FaceTime paths. Advertised or stale broad helper
> flags are normalized to unavailable and cannot restore UI, notification actions, or network calls.
> New chat remains one-to-one: RCS requires its own capability. Text-only iMessage creation
> separately requires `supports_imessage_new_chat`; SMS, groups, and staged files on a new iMessage
> remain unavailable.
> RCS send/contact/media and whole-message reactions remain independent of this retirement.
> An existing iMessage chat can send plain text through AppleScript. In an existing one-to-one
> iMessage chat, `supports_imessage_attachment_upload` permits one JPEG or PNG; PDF also needs
> `supports_imessage_pdf_attachment_upload`, and optional caption text needs
> `supports_imessage_attachment_caption_upload`. That attachment path does not restore the broad
> iMessage combined-send flag and does not authorize any targeted action. A separate
> `supports_imessage_replies` gate permits only one nonblank plain-text reply to exact part zero of
> a stored message in a proven existing one-to-one iMessage chat; uncertain delivery is never replayed.
> Local packaged-Mac and
> physical-Samsung development-client acceptance passed on 2026-09-25 with exactly one Send action
> and no retry. A separate `supports_imessage_reactions` gate
> retains only reviewed classic part-zero reactions. Separate `supports_imessage_edit` and
> `supports_imessage_unsend` gates permit only a nonblank plain-text edit or retraction of exact
> text part zero in that proven one-to-one chat; broad or generic edit/unsend authority remains
> retired. Their app, server, and helper paths are source-complete. The server's dated local-Mac /
> Samsung Play v79 Edit and Unsend checks passed; the newer plain-send identity repair still needs
> its matching Android update and bounded send/reopen/Unsend acceptance under `FEAT-03B`/`POST-01`.
> Read, unread, and ordinary Delete actions are
> device-local. There is no backward-compatibility promise for the retired Flutter client or older
> BlueBubbles server/helper contracts. Dated sections below remain historical
> evidence unless they explicitly say they describe the current client.

> **Status authority (2026-08-08):** This document records protocol evidence and parity decisions; it is not the
> implementation tracker. [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) is authoritative. Under
> `PARITY-01`, every open `PARTIAL`/`CONFIRMED` capability must link to a primary work-plan task or an explicit
> `DEFER`/`DROP` product decision. Per-address contact lookup and RCS send-contact are complete paths; the bulk
> contacts/handles bootstrap listed below is a different, still-unused capability.

**Directions:**

- **Server → App** = the server exposes it, the app doesn't use it (untapped capability).
- **App → Server** = the app calls/expects it, the server doesn't provide it (would fail, silently no-op, or is already stubbed in-app).

**Original 2026-07-01 baseline:** 44 surface items matched on both sides (the core messaging, sync,
group management, FaceTime, Find My, stats, and restart/logs flows all lined up).

## Source-aligned (2026-10-03) — socket authentication recovery

The coordinated server repair rejects namespace authentication before publishing a socket connection or dispatching
application operations. Its Socket.IO `connect_error.data.code` contract is finite:

| Code                | Current client behavior                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_REQUIRED`     | Error state; no automatic retry in this socket lifecycle. Explicit manual Retry creates a new lifecycle.                                                                              |
| `AUTH_UNAVAILABLE`  | Retry the same trusted origin and credential snapshot after a capped, jittered 1–60 second exponential delay.                                                                         |
| `AUTH_RATE_LIMITED` | Wait a conservative 60 seconds before automatic retry. The current server sends `retryAfterMs: 60000`; this client pins that agreed floor and does not parse arbitrary future delays. |

Unknown inactive-namespace failures stop automatic retries. Human-readable messages are not parsed for control
flow. Transport errors for which `socket.active` remains true retain Socket.IO's own retry path. A namespace
rejection makes it false and requires the app-level retry path above. Timer identity, socket lifecycle, and account
lease checks prevent duplicate or stale callbacks from reopening a replaced account or shortening a rate-limit wait.

The client sends no application operation automatically on its first socket connection. Handshake authentication
continues to use `auth.password` for shared passwords or `auth.token` for scoped device credentials, never query
parameters. Ordinary HTTP onboarding and socket verification are separate operations; successful HTTP onboarding
does not itself prove a live socket connection.

Client source/focused checks pass (3 socket suites / 46 tests), and the coordinating server session reports passing
real-listener wire tests. Paired app/server device evidence remains pending in the
[October 3 remediation report](./REVIEW_REMEDIATION_2026-10-03.md). This is not a release or device acceptance claim.

## 🟡 Source-aligned (2026-09-07) — atomic full-repair snapshot (`RECOVERY-01`)

The app and Gator server now share a version-1 repair lease around one all-history crawl. The server
ties the lease to one authenticated owner and process, samples the same long-lived Apple `chat.db`
connection plus configuration authority, and requires the token on chat, chat-message, and
deleted-message pages. Each successful page echoes the exact token after validation; the app pins
one transport identity and rejects any missing or different echo before the server's one-shot finish
can authorize local absence reconciliation. Server restart, process/worker/origin rotation, source
change, expiry, unavailable `chat.db`, and RCS-enabled reads all fail closed.

The client also fences every participating local database owner from exposure capture through the
final marker commit. Existing tombstone, draft, outgoing, reminder, customization, and late-row
protections remain, and local RCS rows are excluded from absence pruning. An older server receives
one additive refresh with no prune or marker replacement and is labeled limited instead of claiming
a complete repair. This is host/source alignment only; the authoritative work plan keeps
`RECOVERY-01` open for a matching packaged deployment and real Mac/Android cancellation,
session-switch, RCS-refusal, and final database comparison evidence.

## 🟡 Source-aligned with dated local-Mac / Samsung proof (updated 2026-09-30) — multipart topology and combined sends (`FEAT-03`)

The app and Gator server now share a bounded normalized per-part topology and exact received-message
reply/reaction part identity. Migration `0047_message_retraction_topology` persists the topology and
attachment ownership needed to resolve actions. Complete topology is authoritative; malformed or partial
topology fails closed, while an explicitly older server can retain the narrow legacy compatibility path.
The shared retraction classifier preserves proven surviving text and attachments consistently across the
bubble, inbox, search, notification, and attachment-cache surfaces instead of treating every partial unsend
as an empty message.

Incoming topology remains useful for truthful rendering and retraction-survivor classification, but
the current client does not expose or transmit broad helper-dependent iMessage edit/unsend,
contact-card reply, or targeted schedule actions. Plain text in an existing iMessage chat
uses AppleScript without a message target. A separate `supports_imessage_attachment_upload`
capability permits one JPEG or PNG (up to 10 MiB) in an existing one-to-one iMessage chat. PDF
also requires `supports_imessage_pdf_attachment_upload`; optional nonblank caption text (up to
65,536 UTF-8 bytes) requires `supports_imessage_attachment_caption_upload`. The broad
`supports_imessage_text_with_attachment` flag remains false; this upload does not enable
reply targeting, groups, or other attachment types. A distinct `supports_imessage_replies` gate
admits only nonblank plain text to exact part zero of a stored message in a proven existing
one-to-one chat, with no retry after an uncertain handoff. New iMessage chat is a separate, text-only
`supports_imessage_new_chat` capability, not implied by the attachment flags. Google Messages
reactions may
target a proven `rcs-*` message as the whole message at part zero; that exception does not enable RCS
reply threading. Separately, `supports_imessage_reactions` permits only the reviewed classic
part-zero reaction path in a proven one-to-one iMessage chat. Separately gated
`supports_imessage_edit` and `supports_imessage_unsend` paths permit only a nonblank plain-text edit
or retraction of exact text part zero in that same proven chat. Each uses one non-retried request,
requires exact acknowledgement, and preserves an uncertain outcome rather than replaying it.
The dedicated formatted-message contract is also source-aligned: the app calls authenticated
`POST /api/v1/message/formatted` only under `supports_imessage_formatted_messages`, for one proven
existing one-to-one iMessage chat and 1–64 exact selected ranges using only bold, italic, underline,
and strikethrough. The helper action originated in isolated commit `33c3d9c...` and canonical local
commit `844219d...`; it is now retained in the signed, repository-admitted `49514a1...` helper.
The active Gator server source enables its dedicated gate only with artifact admission and live
helper authentication. The earlier disabled-gate / `6ac7253...` checkpoint is superseded. Server
`POST-01` records an outbound four-style message with helper `859636d...`, followed by a canonical
serialization fix and a fresh Mac-originated Samsung rendering pass without an optimistic draft.
These are dated native/device results, not a new-artifact or clean-release acceptance claim.
The generic attributed-body sender remains retired. RCS text plus
one attachment travels under `supports_rcs_text_with_attachment` as
one logical optimistic/retry identity and older servers fail closed. RCS capability is independent
of every retired iMessage helper flag.

Focused host suites exercise the app and server contracts, including capability fallback, received
topology/survivor presentation, broad-retirement negative boundaries, the narrow edit/unsend seams,
and whole-message RCS reactions.
On 2026-09-20, a local Samsung dev client sent exactly one 1,667-byte PDF with its caption as the
same iMessage: the Mac Messages database recorded the exact caption and one PDF on ROWID 76267;
delivery completed without a duplicate. This is local dev-client proof of the narrow iMessage path,
not Play-release or packaged-candidate proof. The matching staged server and packaged Android
candidate still need to prove the supported RCS cross-repository path; the server's latest receipt
reports degraded RCS readiness, so ping/helper health alone does not authorize that lane. Narrow
Edit passed with helper `859636d...`; narrow Unsend and cold reopen passed with `c4741a5...` and the
server correction package built at `2026-09-29T21:28:26Z`. A separate ordinary-phone-send defect
stranded a temporary bubble when AppleScript acknowledged no canonical GUID. The current dirty
app/server source and admitted `49514a1...` helper repair this through separately gated
`supports_imessage_plain_text` / `POST /api/v1/message/imessage-text`, requiring exact
`{guid,tempGuid,viaPrivateApi:true}` acknowledgement and certified not-dispatched retry authority;
unknown outcomes cannot fall back or replay. The matching Android build and phone acceptance remain
owner-deferred. Existing stranded copies are not guessed away by body/time matching.

`FEAT-03` remains **IN_PROGRESS**. The authoritative
[prepared handoff](./WORK_PLAN_2026-08-03.md#feat-03--multipart-and-unsupported-message-correctness)
binds the active server checkout, app/server/helper versions, existing freeze failures, and the
small next batch: plain send/reopen with a timely **unedited** target Unsend, one formatted send,
and one RCS combined-send retry/live/sync check. No historical pass is silently rebound to the
newer helper or a replacement Android candidate.

## 🟡 Source-aligned (updated 2026-09-26) — foreground Current Location send (`FEAT-05A`)

The server advertises `supports_imessage_location` only for its dedicated private operation. The app
exposes Send Current Location only in a proven existing one-to-one iMessage chat with that exact live
capability, confirms first, and then acquires one foreground fix. Find My is unrelated: it renders
coordinates already supplied by the server and never invokes the phone-location adapter.

Foreground ownership is explicit rather than inferred from the screen remaining mounted. The app
subscribes to Android app-state changes before the first native permission/location await, immediately
rechecks the state to close the registration race, and aborts acquisition if the app becomes inactive or
backgrounded. That listener, plus the account- and capability-cancellation listeners, is released as soon
as acquisition settles and before the durable queue/network phase begins. A coordinate that was already
admitted therefore retains the existing bounded retry contract; a background transition while native
acquisition is still pending creates no optimistic row and sends no request.

The authenticated `POST /api/v1/message/location` request carries exactly `chatGuid`, `latitude`,
`longitude`, and the stable `tempGuid`. The server builds the Apple location card and must acknowledge
one real bounded GUID with `viaPrivateApi: true`; malformed or outcome-unknown acknowledgements are
terminal so automatic or manual retry cannot duplicate a possibly delivered card. Ordinary temporary
failures retain the exact coordinate and original idempotency key in the encrypted outgoing queue and
may replay them for less than 15 minutes. Retry never reacquires the phone's location; expired,
malformed, unsupported-target, or capability-disabled rows make no request.

This is source/host alignment, not packaged or end-to-end release evidence. A matching deployed
server/helper and exact Android candidate must still prove one-card delivery, duplicate containment,
approximate/precise foreground permission behavior, every no-send outcome, background containment,
process-death replay, exact expiry, encrypted-at-rest storage, capability removal, and truthful
terminal-error presentation. The authoritative work plan keeps `FEAT-05A` and parent `FEAT-05` open.

## 🟡 Source-aligned (updated 2026-09-26) — capability-gated global message search (`FEAT-05C`)

The server and app now share an additive, fail-closed search contract. The authenticated
`POST /api/v1/message/search/bounded` route accepts normalized text only, returns at most the newest
50 live iMessage/SMS rows with mandatory chat routing and nullable handle hydration, and excludes
reaction/sticker overlays, retracted rows, Recently Deleted rows, empty GUIDs, and unroutable rows.
`/server/info` emits `supports_message_search` only when the live chat.db schema proves every column
and join needed by that contract. The older `/message/search` route is unchanged for deployed clients.

The Mac-side reader also handles the two Messages storage cases that otherwise produce incorrect search
results. When the ordinary text column is empty or non-text, a bounded serializer-equivalent scalar may
extract the attributed-body text; a nonempty ordinary text value always wins. A second bounded scalar
parses `message_summary_info` and excludes partial or complete retractions, including rows whose legacy
`date_retracted` value is still zero. Missing schema support, scalar-registration failure, malformed data,
or oversized input fails closed by withholding the capability or excluding the row.

The app calls the new route only when that capability is explicitly true. It shows local encrypted-DB
matches first, fetches outside the database writer lock, persists each valid first-chat result before
navigation, rereads local deletion/visibility rules, and merges by message GUID with local data winning
and deterministic newest-first ordering. Older servers and network failures remain local-only; account
retirement aborts the request and immediately conceals the entire unified result surface. Before a Mac
hit enters a bounded transaction, endpoint-impossible nested collections are removed; the UI receives
only a match-centered 240-code-point snippet while the encrypted DB retains the full body. The inbox
labels whether message search is local, still searching the Mac, combined, or unavailable, and
explicitly excludes RCS from only the Mac scope because locally stored RCS matches may still appear.

This closes source-level app/server parity, not release evidence. A fresh local staging package contains
the route, capability, and both bounded scalars, but it has not replaced the installed Mac server. The new
server and app builds must still be deployed together and exercised on Android against a realistic Mac
Messages database. `WORK_PLAN_2026-08-03.md` remains authoritative for that device and release tail.

## ✅ Closed (2026-07-01)

The top gaps have since been wired app-side against capabilities the server already exposed:

- **`message-send-error`** — the app now subscribes (SERVER_EVENTS), normalizes it (EventRouter → `NormalizedEvent`), and `DbEventSink` routes it through `applyServerSendErrorWithinTransaction` inside the event's existing durable transaction: bubble error badge, attempts-bump when the optimistic queue row still exists, and an automatic re-enqueue only when the server marks the failure **`retryable: true`**. Manual retry remains available only when an exact queue payload exists. For pushed RCS failures, bbd now sets `retryable` only for a proven pre-dispatch refusal: loopback `ECONNREFUSED` or lifecycle rejection before fetch. Timeouts, resets, sidecar HTTP failures, post-dispatch shutdown, and delivery-phase `failed` frames whose dispatch outcome may be ambiguous remain non-retryable. Older servers omit the flag → bubble-only, as before. Unit-tested both sides (`dbEventSink.test.ts` / bbd `attachmentUploadRoutes.test.ts`, `rcsSender.test.ts`); full design in `docs/RCS_SEND_RELIABILITY.md`.
  **Durable fanout update (2026-09-04; current-server client path host-green, end-to-end FCM device proof open):** server commit `e55f1210` now gives each admitted physical RCS attempt one immutable UUID `attemptGuid`, combines it with the logical `tempGuid` in an opaque sidecar `tmpID`, and retains the echoed correlation by exact physical-phone namespace plus message id. Duplicate requests retain the same attempt id; an exact delivery failure releases only that generation so a genuine retry gets a new id and a delayed old failure cannot evict it from the server. One logical DTO is reused across authenticated socket, webhook, and attempt-aware FCM before transport-specific serialization/encryption. Managed-device FCM requires `messages:write`; unmanaged legacy push rows retain the existing shared-password compatibility policy. A canonical per-device key encrypts the DTO; without one, FCM receives only the event type plus empty-object metadata, never temp/chat/attempt ids in plaintext. `PUSH-CRYPTO-01A` now gives the app a host-green current-server `AEAD_GCM_V2_DEVICE` enrollment/decryption path, so this attempt payload is eligible for device testing. Matching deployment, killed-app convergence, and the broader authenticated identity/replay protocol remain open under the parent `PUSH-CRYPTO-01`. Legacy temp-only failures remain socket/webhook-only. Host coverage proves the server composition contract, restart recovery, re-pair isolation, release races, authorization, and logical fanout equality. A paired phone and matching release still need to prove Google text/media echo at the supported `tmpID` length, destination-registration identity, and the documented crash-before-first-frame boundary. Two client tails remain: a queue-less post-ack delivery error cannot be manually retried, and a first old-attempt event delayed until after a newer attempt is not fenced against that bubble because the app does not persist current-attempt ownership. Automatic A → B evidence must use a certified pre-dispatch `retryable: true` failure, and only a replay of an already-processed A is currently deduplicated. The client continues to move a cancelled temp message's deletion-ledger marker and records every learned temp→real mapping in a bounded encrypted local alias table, so stale user actions can resolve after purge/re-ingest. A content-only echo cannot reconstruct a mapping that was never learned; the server attempt id makes failure copies exact but does not invent that missing temp→real mapping.
  **Active-attempt ownership update (2026-09-07; host/source verified, device proof open):** this supersedes the delayed-A ownership limitation immediately above. A modern RCS send resolves the server capability before inserting its optimistic row and enables ownership only when `supports_rcs_send_attempt_ownership` is explicitly true. The app then correlates each physical send with the complete `{tempGuid, attemptGuid, clientAttemptGeneration}` tuple. Migration `0046_message_send_attempt_owner` durably stores the monotonic generation, pending state, and active attempt; retries use a compare-and-swap guard (the update succeeds only while the expected owner is still current). HTTP acknowledgements, live echoes, and send-error events reconcile only against that exact owner. Partial or malformed correlation fails closed, an old attempt cannot overwrite a newer one, and idempotent replay remains safe even after the bounded temp-to-real alias is pruned because one unambiguous active-attempt match can recover its owner. The server forwards `clientAttemptGeneration` through listener, composition, and fanout boundaries, and an RCS new-chat acknowledgement now also returns its `tempGuid`. Focused app/server host checks cover those paths, but this is not a shipped or release claim. `PUSH-RETRY-01` remains open until a matching deployed server and real phone prove the A → B races across HTTP, socket, and FCM, including killed-process/restart boundaries. One deliberate limitation also remains: after acknowledgement removes the exact queue payload, a queue-less retry can be reconstructed only for a message with a local attachment. Contact cards, mention metadata, and other non-attachment payloads are not recreated from the lossy message row; they fail closed and require a fresh user send.
- **`new-server`** (tunnel-URL rotation) — the post-v56 RT-01A flow now intercepts every instruction before database access. Invalid and downgrade attempts fail closed; an eligible foreign origin is held only in process memory and requires a foreground, unlocked approval modal, a freshly entered password, and separate cleartext consent when applicable. The candidate is validated before an exclusive, session-guarded credential commit and socket replacement. Exact Play v63 passed cleartext rejection/approval and persistence, late-result discard, interrupted-SecureStore fail-safe recovery, and Android-trusted HTTPS downgrade rejection. The exact device evidence is in [`RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md); none of it applies to frozen v56. Since 2026-10-12 (review items 800/808), a same-account change saves only the address in one atomic SecureStore write instead of the new-account `writing` barrier, so an interruption boots the old or the new complete session rather than the residual-account wipe. Settings → Change Server Address… offers a typed address through the same approval flow, the password field allows autofill, and a backdrop tap no longer cancels. Before saving, the new address must report the same Messages-database identity (`imessage_provider_epoch`) as the current server, so a different Mac that accepts the same password is refused; a typed change is offered only when the current server reports that identity. A paired (scoped-credential) device still proves the shared password to its current server, so it can change address only while that server is reachable. If the address write is interrupted the session stays bootable, but the V3 push-key record can still keep the old origin until re-registration, as before. The interrupted-SecureStore device proof above predates this and must be re-run (device checklist `REVIEW-800`).
- **Server Health screen** (Settings › SERVER › "Server Health…", and from Server Management) — surfaces password-authenticated, remote-readable diagnostics for Find My key state, FCM, environment, uptime, proxy/TLS state, public IP, and alerts. Its legacy Private API rows disclose that the broad Messages and FaceTime transports are retired; separately capability-gated narrow features are reported and exposed at their own product surfaces. These rows are not controls or helper-status network reads. **Contract correction (2026-09-17):** current servers are read through the typed `/server/environment`, `/notifications/fcm/status`, `/tls/status`, `/alerts`, `/admin/findmy/keys/status`, `/admin/network/public-ip`, and `/admin/status` routes. Statistics use `/statistics/snapshot`. A typed-route 404 is final and never falls back to the retired dispatcher; helper-status, zrok-specific presentation, and remote restart/log controls are unsupported. Proxy identity now comes from `/server/info`. The current public Caddy policy still blocks the two typed `/admin` reads (Find My keys and public IP), and its backend is older than these routes. Deploy the current server first, then allow only those two exact authenticated GET paths before the `/api/v1/admin/*` 404 rule—never the wildcard. All non-admin typed reads already pass through the proxy.
  Current typed responses are validated against strict schemas. A malformed HTTP 200 fails closed;
  404, authentication, transport, and validation failures are not masked by another request.
  Remote Mac server-log viewing/export is permanently unsupported. **Settings → App Logs** contains
  only the phone's bounded client diagnostics; inspect Mac server logs in the local desktop dashboard.
  Broad Private API transports are presented as retired without requesting helper status; narrow
  features remain controlled by their live capability flags. The detailed RCS status route is
  local-admin-only; the phone uses the `/server/info` capability plus the latest live `rcs-alert`.
  The empty-body `/rcs/reauth-now` action accepts only the strict applied-or-staged result and sends
  no phone-held Google credential.

## ✅ Closed (2026-07-17) — chat.db schema-gap features

The server's SCHEMA_GAPS_PLAN.md features (shipped server-side 2026-07-16, additive v1 wire
fields + one new event) are now fully consumed app-side. All seven, each unit-tested and
adversarially reviewed (per-chat/message details in the wave commits `75cfb25..d70958a`):

- **Unsend (`dateRetracted`)** — was already rendered as a tombstone; the last gap (withdrawing
  the delivered notification on unsend) is now wired via an `updated-message` cancel intent.
  v1 constraint: notifications are keyed per-chat, so the whole chat's notification is withdrawn.
- **`isScheduled` (Apple Send Later)** — persisted + badged. Per the server contract the badge is
  gated `isScheduled && !isSent` (the server emits `isScheduled` on `schedule_type=2` regardless
  of sent state); `isSent` is now modeled/persisted for this.
- **Genmoji (`emojiImage*`)** — persisted through the attachment chain; description used as
  accessibility alt text + notification/preview fallback (never under redaction); renders
  inline emoji-sized (gallery `cellSize` still wins in multi-attachment grids).
- **Edit history (`messageSummaryInfo`)** — persisted (JSON column, COALESCE-preserved) and
  surfaced via a long-press "View Edit History" sheet (revisions + removed parts; redaction-safe).
- **Reply threads and received screen effects** — at this 2026-07-17 closure, these were read-only
  presentation features. The later `FP-006` retirement did not remove "View Thread", edit history,
  or playback of an expressive effect already present on an incoming message. **Later current
  exception (2026-09-25):** as documented in the current-client boundary
  above, the separately gated client may originate only a narrow plain-text, exact-part-zero reply
  in a proven one-to-one iMessage chat. Richer reply/effect sending remains retired; the narrow
  slice passed the local packaged-Mac/physical-Samsung development-client acceptance recorded above.
- **Group events** — `itemType 6` relabeled SharePlay (was mislabeled FaceTime), background
  changed/removed (`gAT 4/6`) render properly, and a bg-change ingestion side-effect sink
  refetches the chat wallpaper (`ensureSyncedBackground`) without requiring a chat re-open.
- **Deletions (`message-deleted` + `supports_message_deleted`)** — new event wired through
  SERVER_EVENTS → EventRouter → DbEventSink → `markMessageDeletedWithinTransaction` inside the
  event's existing durable transaction; tombstone column (`date_deleted`) rather than hard
  delete (the server's sync paths keep returning Recently-Deleted rows for ~30 days, so a hard
  delete would resurrect); filtered out of every render/count/search query; the chat's
  denormalized inbox sort key is recomputed on delete. The dead/locked delivery gap was closed on
  2026-07-23 by `GET /api/v1/message/deleted` plus app catch-up. Migration 0033 now keeps a durable
  GUID deletion ledger, so delete-before-message ordering is safe: later ingestion is born hidden.
  See the [completed closure section](#missed-deletion-catch-up-sync-r1) below for the verified
  boundary and owner-deferred limitations.
- **Read-state (`lastReadMessageTimestamp`)** — Mac-side read markers reconcile into the app's
  guid-based marker at chat ingestion (monotonic, idempotent, batched); unread counts self-correct.

## ✅ Current RCS path; historical iMessage path retired (updated 2026-09-16) — send a contact card (`send-contact`)

The server's retained `send-contact` action (`POST /api/v1/message/contact`) is consumed only for a
canonical RCS chat with the live RCS bridge enabled. The matching server now reports the historical
`supports_send_contact` field as false even though its RCS contact action remains available, so the
client accepts that field for compatibility but does not use it as an authorization gate. iMessage
contact sending and contact-card replies depended on the retired helper and now fail before database
or network work:

- The client sends STRUCTURED fields (`firstName`/`lastName`/`organization`/`phones[]`/`emails[]`);
  the SERVER assembles the vCard 3.0 and ships it as an attachment through the same pipeline as
  `send-attachment` (so the ack is the same `{ guid? }` and the live `new-message` echo carries the
  real `.vcf`). The app already RENDERS received vCards (`parseVCard`); this closes the send side.
- Capability-gated: the composer's attachment tray shows a **Contact** button only for a canonical
  RCS chat while `serverInfo.rcs` is true. The native contact picker
  (`presentContactPickerAsync`) maps the chosen contact to the structured fields (photo
  intentionally omitted — the server vCard omits PHOTO too).
- Optimistic send: an outgoing bubble shows the contact's display name until the server echo swaps
  in the rendered card; a failure flips it to the retryable error state (mirrors `sendTextMessage`).
  See `sendContactService.ts` + `sendContact` (`endpoints/messages.ts`).

## Narrow iMessage edit and unsend (`FEAT-03B` app source; `POST-01` live acceptance, 2026-09-28)

The current app exposes Edit and Unsend only for an eligible, exact text part zero in a proven
existing one-to-one iMessage chat and only while the matching `supports_imessage_edit` or
`supports_imessage_unsend` capability is current. The authenticated endpoints are
`POST /api/v1/message/{guid}/edit` and `POST /api/v1/message/{guid}/unsend`; both carry the owning
chat GUID and literal `partIndex: 0`. Edit additionally carries one bounded nonblank plain-text
replacement. Neither request retries automatically. The client accepts only the exact target GUID
acknowledgement, preserves optimistic state safely, and presents a lost or ambiguous response as
outcome-unknown instead of risking a duplicate mutation.

The app, server, and helper paths are source-complete. This is a narrow exception, not restoration
of broad Private API authority: RCS, groups, ambiguous/multipart targets, rich edits, and generic
helper flags cannot enter these paths. App ownership and remaining status sit under the narrow
`FEAT-03B` child in the remediation plan. The server's dated `POST-01` records now include local
packaged-Mac / Samsung Play v79 Edit acceptance with helper `859636d...`, and scoped Unsend /
cold-reopen acceptance with `c4741a5...` and the server-only correction at
`2026-09-29T21:28:26Z`. The exact Mac retracted-part marker `[0]` and one surviving phone tombstone
prove that Unsend; physical deletion or a nonzero `dateRetracted` is not required on that host.
The newer `49514a1...` helper's ordinary-send identity repair and matching Android update still need
their bounded phone send/reopen/Unsend check. This does not repeat already-passed Edit wholesale or
claim clean-release acceptance. Use a fresh **unedited** target for Unsend; the helper rejects an
edited part.

## Whole-message deletion from Mac (`FEAT-03B` app source; `POST-01` activation, 2026-09-28)

The current app has a separate **Delete from Mac** action for a stable, non-retracted message in a
proven existing iMessage one-to-one or group chat. It appears only while
`supports_imessage_remote_delete` is live. It does not replace phone-local **Delete** and it is not
recipient-facing **Unsend**. The confirmation says the whole message will be removed from Messages
on the Mac, warns that Messages in iCloud may propagate the deletion to other Apple devices, and
states that the action does not unsend for anyone else.

The client sends one non-retrying `POST /api/v1/message/{guid}/remote-delete` with body exactly
`{chatGuid}` and accepts only exact `{deleted:true,guid}` confirmation for the selected message. A
definite refusal or uncertain outcome leaves the phone row visible; only exact confirmation writes
the phone's local deletion tombstone. Individual-part and whole-chat remote deletion are not
exposed. The matching helper, server, and app source passed 182 helper checks, 50 server/protocol
checks, 71 app service/UI checks, and their TypeScript checks. The earlier disabled-gate / missing
artifact checkpoint is superseded: server `POST-01` records one exact synthetic whole-message
deletion and cold-reopen phone disappearance with the admitted `859636d...` helper and Samsung
Play v79. The newer admitted `49514a1...` helper retains this separately gated command, but the
dated pass is not new-artifact or clean-release proof. Remote deletion is not part of the next
bounded FEAT-03 batch, and no additional deletion was performed in this reconciliation.

## Read-only iMessage account status (POST-01, 2026-09-20)

The current app shows Settings → iMessage Account only when the current server advertises
`supports_imessage_account_status`. It reads `GET /api/v1/imessage/account/status` through the
authenticated HTTP client and displays Apple ID, account name, active alias, and alias lists.
Account-generation and server-transport fences hide stale identity results. A separate, confirmed
send-from-alias choice is staged behind `supports_imessage_alias_change`; that server source gate
is still off and the installed app remains read-only. The legacy `supports_icloud_account` flag,
`GET /icloud/account`, and its alias-changing POST remain disabled; neither narrow route restores
broad Private API authority.

## Outgoing iMessage typing (POST-01, local gate live 2026-09-20)

The composer can emit start/stop typing and show incoming typing only for a proven existing
one-to-one iMessage chat when `supports_imessage_typing` is live. The server accepts only a
validated, scoped native typing event. The exact helper is signed, pinned, and installed in the
verified local package, and this narrow gate is on; a real start/stop and incoming-display check
still needs a safe test chat. iMessage read/unread actions are
a separate privacy-sensitive slice. Stale `private_api` does not enable any of these controls.

## iMessage voice note (POST-01, local gate live 2026-09-20)

The existing recorder can offer one M4A voice note in a proven existing one-to-one iMessage
chat when `supports_imessage_voice_upload` is live. It checks the local file size (10 MiB max)
before queueing, sends explicit `uploadKind=imessage_voice`, and retains the recording if queue
admission fails. The server and helper have a separate bounded voice-mode path. Its narrow gate
is on in the verified local package; the Samsung shows the recorder, and one canceled recording's
actual M4A `mp42` header passed the helper's file-type rule. No live send or playback has been
accepted. It does not enable contact
cards, audio calls, FaceTime, or the broad Private API.

## ⏹️ Historical closure, superseded by `FP-006` (2026-09-16) — iMessage account (`icloud/account`)

The implementation record below is retained as history. The current client removed that old endpoint
wrapper, capability hook, and alias UI. Stale `supports_icloud_account` or Private API fields do
not reactivate them; the separately gated account status and staged alias choice above are the
current account surface.

Was an **App → Server** gap: the app called `GET /api/v1/icloud/account` (+ the alias POST), which
the Gator daemon never implemented → 404 → the screen always errored. Now wired on BOTH sides
(server-TS only — the injected helper already had the actions; no dylib rebuild):

- **Server** (`packages/bbd`): `MessageSender.getAccountInfo()`/`setActiveAlias()` dispatch the
  helper actions `get-account-info`/`modify-active-alias`; a new `buildIcloudOperations({ sender })`
  group exposes `GET /api/v1/icloud/account` + `POST /api/v1/icloud/account/alias` (both auth). The
  GET **normalizes the helper's snake_case dict → the app's camelCase `AccountInfo`** (apple_id→appleId,
  account_name→displayName, active_alias→activeAlias, `vetted_aliases:[{Alias}]`→`vettedAliases: string[]`)
  — a raw passthrough would parse as 200-but-all-null. The POST validates the alias is Apple-vetted
  before switching. Registered in `backend.ts`; unit-tested (`icloudOperations.test.ts`, FakeTransport).
- **Capability**: `supports_icloud_account` added to `ServerInfoV1` / `/server/info`, emitted as
  `enablePrivateApi` (the endpoints require the helper). Static `true` would lie on Private-API-off
  servers, where the route would 500.
- **App**: `serverInfo.supports_icloud_account` + `useIcloudAccountSupported()` gate the Settings
  "iMessage Account" row; `account.tsx` keeps its 404→`UnimplementedEndpointError` fallback for a deep
  link / stale serverInfo. Unit-tested (accessor + hook).
- **Divergence from the earlier plan doc:** `MessageSender` lives at `packages/bbd/src/messaging/`
  (not `api/services/`), and bbd's transport nests the payload ONE level (`res.data`), not the legacy
  server's `res.data.data`. See `docs/IMESSAGE_ACCOUNT_PLAN.md` (status: implemented).

## ✅ Closed (2026-07-19) — client error-report upload (`error-reports`)

A NEW capability on BOTH sides (a lightweight self-hosted crash reporter): the app captures every
error, batch-uploads them, and the server fingerprints (categorizes) + writes them to disk.

- **App** (`bluebubbles-rn`): `ErrorReportSink` captures `error`-level lines (uncaught JS via a chained
  `ErrorUtils.setGlobalHandler`, unhandled rejections via `HermesInternal.enablePromiseRejectionTracker`,
  the React `ErrorBoundary`, and every `logger.error`) into the `error_reports` table (migration `0025`) —
  a lease/backoff/attempt-cap queue cloned from `outgoing_queue`. Before any sink, ERROR input is rebuilt as
  one of 19 finite events with event-owned typed fields and an opaque `at gator.site.<token>` grouping frame;
  raw Error messages, filenames, function names, and stacks do not persist or upload. The chained RN handler
  receives the same safe shape rather than the
  original Error. `runErrorReportQueue` batch-`POST`s to `/api/v1/error-reports` (`retry:false`), deletes only
  after a full acknowledgement, and retries the whole batch on partial/failure. `flushErrorReports` runs on
  AppState active/background, connected mount, and the bg task. Versioned client consent defaults OFF; the
  operator's server ingestion switch also defaults OFF.
- **Server** (`packages/bbd`): `buildErrorReportOperations` exposes `POST /api/v1/error-reports` (auth);
  `ErrorReportStore` computes a deterministic fingerprint (sha1 over normalized message + top stack frame +
  tag + level, `errors/fingerprint.ts`) and appends `<userData>/error-reports/categories/<fp>.jsonl` + an
  atomic `index.json` rollup. No LLM/AI — pure rule-based grouping.
- **Capability**: `supports_error_log_upload` added to `ServerInfoV1` / `/server/info`, emitted as the
  `errorLogIngestionEnabled` config (default OFF — opt-in on the RECEIVING side, like `persistLogs`). The
  app only uploads once the operator turns ingestion on; the handler also re-checks the flag and answers
  `{ ingested:0, disabled:true }` (defense-in-depth against a stale capability).
- Unit-tested both sides: strict ERROR projection, the `error_reports` repo (atomic claim/backoff/cap), the
  upload orchestration (batch/delete/retry/no-double-upload/partial/disabled), the sink (level filter,
  re-entrancy guard, buffer→drain), migration `0025`; server fingerprint determinism, `ErrorReportStore` disk layout,
  the operation (401/enabled/disabled/400), and the server-info capability. Device-only: the global handlers
  firing + the real upload/disk write.

## ✅ Closed (2026-07-20) — server-supplied rich-link metadata (`payloadData`)

Received links previously rendered blank cards: the app re-fetched every URL itself with a
bot-looking User-Agent (blocked by X/Instagram/Amazon/news CDNs), while Apple's OWN pre-fetched
preview (the LPLinkMetadata the sender's device embedded in `payload_data`) was read from chat.db
by the server but never emitted, and never stored by the app.

- **Server** (`packages/bbd`): `parsePayloadData` (`data/imessage/payloadData.ts`) decodes the
  NSKeyedArchiver blob (bplist → UID-walk, modeled on the Flutter client's `extractUIDs`) into a
  flat `{urlData: [{url, originalUrl, title, summary, siteName, itemType, imageUrl, iconUrl,
videoUrl}]}`. `serializeMessage` emits it presence-driven, double-gated (URL balloon bundle id +
  decodable data; placeholder RichLinks → omitted). Additive `MessageV1.payloadData` on the
  protocol; REST and socket carry it through the single serializer. FCM carries it only for a
  compatible client with an enrolled V2 key; otherwise current server source emits metadata-only
  push and the app converges through REST/socket/sync. NO capability flag — additive, use-if-present
  (precedent: `messageSummaryInfo`/`isScheduled`). Validated against 578 real
  chat.db blobs (512 decode, 66 are placeholders).
- **App** (`bluebubbles-rn`): `payload_data` remains a COALESCE-preserved JSON TEXT column with a
  tolerant zod `PayloadData` boundary. `MessageBubble` renders server text metadata directly without
  contacting the link host. When `payloadData` is absent, the app may read an exact-key legacy
  `url_previews` row. App commit `40b907d` removed the dormant client OG fetch/parser; completed
  `NET-01` adds a separate capability-gated request to the authenticated Gator server, with no
  direct-client fallback or remote-image URL mount.
- **Historical postscript (0.1.28, 2026-07-21; superseded by `NET-00` containment):** A fixed
  `width:'78%'` resolved the then-mounted preview image's zero-width layout cycle and was verified on
  device. The fixed width remains the stable card layout; current automatic artwork arrives only as
  a validated data image through the completed `NET-01` server proxy.

## ✅ Complete (2026-09-13) — automatic rich-link retrieval (`NET-01`)

Automatic previews are being restored through the authenticated Gator server rather than by making
arbitrary web requests from the phone. A capable server advertises
`supports_url_preview_proxy: true` from `GET /api/v1/server/info` and serves
`POST /api/v1/url-preview` to authenticated clients with `messages:read`. The request is a single
validated HTTP(S) URL. The response contains bounded title, description, site name, final URL, and
an optional validated JPEG/PNG data URI; it never gives the app a remote image URL to mount.

The app automatically asks that endpoint for links in messages, displays the hostname from the
message as the immutable destination label, and keeps a bounded positive/negative cache in the
encrypted database. Older servers remain compatible: without the capability, the app uses only an
already-safe, unexpired cached or sender-supplied text preview. App commit `4b89431` and server
commit `76097f75` complete the host implementation, and independent safety reviews are green.
Google Play `0.1.46` / version code `63` then passed the controlled 20-case Android matrix, native
JPEG/PNG rendering, exact-original tap, app-UID destination observation, and cleanup. The exact
artifact/server identities, outcomes, and measurement limits are recorded in
[`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md).

<a id="missed-deletion-catch-up-sync-r1"></a>

## ✅ Complete (updated 2026-09-15) — missed-deletion catch-up sync (R1)

**Authoritative task:** [`DELETE-SYNC-01`](./WORK_PLAN_2026-08-03.md). Frozen legacy/v1
continuation, additive v2 durable-ledger continuation, atomic app adoption, stable initial-repair
boundary, and two digest-locked cross-repository response fixtures are implemented. Both exact-device
branches passed; owner-approved residuals are recorded below.

A `message-deleted` event arriving while the app was dead or app-locked used to be lost because the
legacy locked FCM path did not durably admit it. Authenticated, active-bound V3 can now enqueue only
the canonical event into SQLCipher while locked; it does not read/decrypt, claim, route, or apply that
row until unlock. Boot/reconnect catch-up still closes the legacy and refused/expired transport gap:

- **Server** (`bluebubbles-server`): legacy `GET /api/v1/message/deleted?after=<unixMs>` retains
  `{ deleted }`, and existing `continuation=1`/`v1.*` callers keep the frozen v1 keyset behavior.
  New callers add `ledger=1`; old servers ignore that unknown query field, while new servers return a
  `v2.*` continuation backed by an append-only observation ledger in owner-only `config.db`. Before
  realtime fanout/cursor advance, background database reconciliation writes one exact full-source
  snapshot to that shared ledger. Each v2 request repeats the exact rescan as recovery, records new
  identities with a monotonic sequence, and then pages by sequence. A deletion seen while every app
  is offline, or exposed late with an older timestamp/lower source row ID, therefore receives a new
  durable sequence instead of falling behind the client cursor. Every new/reset v2 stream replays
  retained history from sequence zero because the server has no trusted per-client delivery record.
  The v2 token also carries a process epoch. The server rotates it synchronously once at daemon
  startup, before routes or background observation can run, so a cursor from an earlier process
  cannot validate against sequence numbers refilled after a database restore. A same-process cursor
  ahead of the durable head resets only that requesting stream and never rotates shared state. The
  continued response remains
  `{ deleted: MessageDeletedV1[], cursor, hasMore }`, is hard-capped at 500, and a failed exact scan
  returns an error without advancing a checkpoint.
- **App** (`bluebubbles-rn`): `syncDeletedMessages` in `src/services/sync/deletionSync.ts` runs after
  chat/message history on every supported boot/reconnect sync and now sends the additive `ledger=1`
  negotiation field. It stores versioned JSON in the existing account-scoped
  `sync.deletionsSyncedAt` key: opaque cursor plus numeric old-server fallback, or legacy fallback
  alone. Missing, malformed, and old bare-timestamp state starts from zero instead of device
  `Date.now()`. A legacy state that first encounters a cursor protocol discards that non-zero probe
  and restarts once from zero so timestamp ties cannot be stranded. Returned `v2.*` pages use ledger
  sequence as their progress order, so older or decreasing deletion timestamps are accepted without
  lowering the numeric fallback. Legacy and v1 pages retain their strict timestamp/key ordering.
  Older servers ignore `ledger=1` and keep using the frozen v1 or timestamp behavior. If a server is
  downgraded after the app stored a `v2.*` cursor, one narrowly gated HTTP-400 recovery retries once
  from zero; the old cursor remains durable until replay and replacement state commit atomically.

The app validates the complete response before writing. Each page's durable deletion-ledger markers,
message tombstones, chat-sort repair, and next versioned state commit in one account-guarded
transaction. A row failure, state-write failure, process crash, or Disconnect therefore cannot split
tombstones from the cursor; retry remains idempotent. Cursor paging follows `hasMore`, persists empty
and terminal cursors, and rejects a repeated non-terminal cursor before any page write. The legacy
fallback keeps its safe-stop behavior for an ambiguous full timestamp page. Migration
`0033_message_deletion_ledger` continues to make unknown GUIDs authoritative for later history
backfill. Focused Node tests cover the strict legacy/continued wire shapes, zero-origin clock-ahead
upgrade, cursor ties/pages, legacy-to-cursor upgrade, rollback/retry, ownership revocation, malformed
pages, and idempotency.

Initial repair now begins one server snapshot lease, binds every required current-message and
deletion page to that source version, and accepts absence-based settlement only after stable finish.
A source change invalidates the crawl instead of letting a fresh install, capability upgrade, or
clock-ahead device reconcile from a torn history boundary. Durable deletion pages still commit
page-plus-cursor atomically as they arrive; stable finish gates absence decisions rather than those
authoritative tombstones.

Contract drift is guarded by canonical v1 and v2 continued-response fixtures owned by the server and
byte-identical app copies pinned to their respective SHA-256 digests. Both runtime contract tests
consume those frozen bytes. Because the repositories clone and test independently, these are
digest-locked synchronized copies rather than physical shared files; updates require coordinated
commits.

Exact-device closure used the nondebuggable Play-delivered `0.1.49` / code `66` artifact whose source
contains the stable snapshot implementation. On a physical Android 16 Samsung device, the
stopped-process/reconnect branch removed the deleted reply, withdrew only its notification
contribution, and did not resurrect it after a second stop/relaunch. The separate App-Lock branch
kept protected content unavailable until owner authentication, removed the deleted reply after
unlock, and kept it absent through another complete stop/relaunch and unlock. The sanitized artifact,
source, server, structural-database, notification, cleanup, and privacy record is in
[`DELETE_SYNC_DEVICE_RUNBOOK.md`](./DELETE_SYNC_DEVICE_RUNBOOK.md).

Accepted residuals:

- Every daemon restart deliberately gives v2 a new process epoch, so the next sync conservatively
  replays retained ledger history. App-side deletion markers are idempotent, but this trades restart
  efficiency for a simple restore-safe guarantee until a future cursor can prove ledger-prefix
  identity.
- Lossless indefinite-offline catch-up requires retaining observation metadata without time-based
  pruning. The ledger stores message GUID, nullable chat GUID, exact deletion time, observation time,
  and canonical identity in the existing owner-only `config.db`; it stores no message body or
  attachment content. This metadata remains until that database is explicitly reset/uninstalled.
  Safe pruning would require durable per-client acknowledgements and is not part of v2.
- Older timestamp-only servers retain their inherent tie limitation: a soft boundary tie can exceed
  500 rows, which the app rejects at parsing rather than advancing from ambiguous state. The v1 path
  is tie-safe for a stable result set, while v2 also closes late-behind-cursor discovery for rows the
  server observes.
- The owner deferred the general mutable-message reader's rare global timestamp-max loss window,
  whole-chat/hard-delete inference, and true recovered-message resurrection. Current deletion
  behavior is fail-closed: an existing tombstone wins unless a future protocol supplies an explicit
  restore signal. These are post-remediation designs, not unrecorded completion gaps.

## 📱 RCS bridge (Google Messages)

The Gator server's RCS bridge (a `libgm` sidecar) serves RCS chats through the **same frozen v1
endpoints** as iMessage, so the app needs no new sync pipeline — RCS traffic is deliberately
shaped like iMessage traffic. The app now accepts, renders, sends, and creates capability-gated
one-to-one RCS conversations.

| Direction    | Item                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server → App | `get-chats` returns RCS chats: guid `RCS;-;<id>`, `style` 45/43, participants `HandleV1{service:"RCS"}`                                                                              | ✅ App accepts — `service` is an open `z.string()` (`ServiceType`), so RCS never fails the page parse; `KNOWN_SERVICES` now includes `'RCS'`.                                                                                                                                                                                                   |
| Server → App | RCS `MessageV1` (`service:"RCS"`, `originalROWID:null`, ms dates, status on `isSent`/`isDelivered`/`isRead`) via `get-chat/:guid/message` + realtime `new-message`/`updated-message` | ✅ Flows through the existing chat-open backfill + `EventRouter` unchanged (no service filter drops it).                                                                                                                                                                                                                                        |
| Server → App | RCS attachment bytes on the **separate** route `GET /api/v1/rcs/attachment/{mediaID}/download`                                                                                       | ✅ App branches on the owning chat's service — `attachmentDownloadUrl(http, guid, service)` builds `/rcs/attachment/…` when `service === 'RCS'`. Service is derived (chat-guid `LIKE 'RCS;-;%'` JOIN) onto `AttachmentRow`.                                                                                                                     |
| Server → App | `ServerInfoV1.rcs?: boolean` capability flag                                                                                                                                         | ✅ Added to the `ServerInfo` zod model (nullish → older servers omit it, no throw); `sessionAccessors.rcsEnabled()` / `useRcsEnabled()` gate RCS-specific UI.                                                                                                                                                                                   |
| Server → App | `rcs-alert` realtime event (bridge health: `alertType` + message)                                                                                                                    | ✅ Subscribed (`SERVER_EVENTS`) + zod-normalized in `EventRouter`; `RcsAlertEventSink` maps it to a Server Health RCS row (`rcsHealth.ts`).                                                                                                                                                                                                     |
| Server → App | `rcs-bridge-down` high-priority push (`{title, body, reason}`)                                                                                                                       | ✅ Subscribed + normalized; posts a content-less status notification (`intents.ts` → `notifeeService`), honoring the hide-preview toggle.                                                                                                                                                                                                       |
| App UI       | RCS bubble colour + badge                                                                                                                                                            | ✅ New `rcsBackground` teal token (distinct from iMessage blue + SMS green) across all presets; `MessageBubble` mirrors the SMS-green branch for `senderService === 'RCS'`; a subtle "RCS" `ServiceBadge` pill shows in `ConversationHeader` + `ConversationTile` (keyed off the `RCS;-;` guid).                                                |
| App → Server | Create a new RCS conversation                                                                                                                                                        | ✅ `new-chat` offers RCS only when `ServerInfoV1.rcs` is enabled, requires the server's non-empty initial text before enabling Start, passes `service: 'RCS'` to the create endpoint, and rejects multiple recipients because the server's RCS branch is one-to-one. Staged attachments send only after that text creates or resolves the chat. |
| App → Server | Create a new iMessage conversation                                                                                                                                                   | 🟡 Separately gated by `supports_imessage_new_chat`: one E.164 number or email, non-empty text, and a stable retry ID. SMS/group creation and staged files remain unavailable. Host/source proof exists; a current packaged Android candidate has not proved it.                                                                                |

**Intentional non-alignments (RCS):**

- **RCS is deliberately NOT in `query-messages`** (server-side) — the incremental sync stays
  iMessage-only to protect the ROWID cursor. RCS chats hydrate via `get-chats` + the
  chat-messages endpoint and stay live via realtime events, so the app must **not** expect RCS
  to arrive through the incremental path. No app change needed (the app already backfills on
  chat-open); noted so a future sync refactor doesn't "fix" the missing RCS rows there.

## ⚠️ Historical intentional non-alignment context

These are genuine divergences, each for a concrete reason — not oversights. The historical explanations below
remain useful context, but the `PARITY-01` register that follows is the current disposition authority:

- **`imessage-aliases-removed`** — the app is fully wired to handle it (listener + notification), but the **Gator server has no detection source** for Apple-ID alias deregistration (not even declared in `DomainEvents`; 0 hits server-wide). The app handler is harmless + forward-compatible with an upstream server that does emit it; adding a fake server emission with no real source would be misleading. Left as app-ready.
- **`scheduled-message-update`** — the app now prefers server-side scheduling for eligible
  non-RCS untargeted one-shot messages and uses local rows for RCS, recurrence, offline, and
  older-server fallback. RCS stays local because the server scheduler currently fires through
  AppleScript rather than the RCS gateway. Legacy targeted/reply schedules are retired rather than
  sent. The signal is still unwired, so a server-side change made elsewhere does not live-refresh
  the app's hybrid schedule list. Track that explicit parity decision under `PARITY-01` rather than
  calling the whole model local-only.
- **`group-icon-changed` / `group-icon-removed`** — the app renders group avatars as **participant collages** (`GroupAvatar`) and does not display a server-supplied custom group photo, so there's nothing to refresh. Wiring it would be a no-op until group-photo display is added. Deferred with the (still-open) group-photo feature.
- **The remaining admin / config surface** (set-config/get-config writes, TLS/zrok/VAPID/Cloudflare **management**, webhooks, FCM **setup**, device purge) — still untapped by design: either **local-console-only** (403 to remote app clients) or **low mobile value**. The selected read-only diagnostics subset (keys, push, environment, proxy/TLS, public IP, and alerts) is surfaced by the **Server Health screen** (see Closed above); only the broad legacy Private API transports appear there as fixed retired disclosures. What remains are the _write_/management ops, which belong on the trusted local server console, not a remote app.

### `PARITY-01` authoritative disposition register — approved 2026-08-27

This register originally accounted for all **18** open records. `DELETE-SYNC-01` closed its former
`PARTIAL` record on 2026-09-15; the 17 historical `CONFIRMED` records below retain their approved
dispositions. Two records remain assigned to existing primary tasks. The project owner approved the
other 15 dispositions as written on 2026-08-27: seven `DEFER` and eight `DROP`. These are
Android-client scope decisions; `DROP` does not remove the corresponding server behavior. The
historical directional tables remain protocol evidence and do not override this register.

| Open record/capability                         | Approved disposition | Reason / authoritative owner                                                                                                                  |
| ---------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed-deletion catch-up sync                  | DONE 2026-09-15      | `DELETE-SYNC-01` closed the durable observation, stable first-sync boundary, and both exact-device branches.                                  |
| `imessage-aliases-removed`                     | DEFER                | Keep the harmless app handler, but do not invent a server event until the server has a real alias-deregistration source.                      |
| Stubbed `GET /server/update/check`             | DROP                 | The app fails closed without issuing the nonexistent request; release/update truth is owned by the release workflow.                          |
| Admin `set-config`                             | DROP                 | Full server configuration writes require local admin authentication and belong in the trusted server console.                                 |
| macOS permission status and prompts            | DEFER                | A future Server Health slice must separate safe status reads from prompt-causing actions on the Mac.                                          |
| Admin `get-devices` / `purge-devices`          | DEFER                | Revisit with push-device administration; prefer least-destructive per-device removal and exclude admin-wide purge unless separately approved. |
| REST list/remove device                        | DEFER                | Revisit with the same push-device administration slice; keep per-device ownership and stale-token behavior explicit.                          |
| Bulk `GET /contact`                            | TASK                 | `FEAT-06` owns identity/privacy research; this is distinct from completed per-address lookup and contact-card sending.                        |
| Bulk `POST /handle/query`                      | TASK                 | `FEAT-06` owns bounded bootstrap and identity research before any sync/schema work.                                                           |
| `group-icon-changed` / `group-icon-removed`    | DEFER                | Participant collages are the selected product today; open a group-photo feature task before wiring refresh events.                            |
| Webhook REST/admin operations                  | DROP                 | Webhooks are server-to-server integration management, not Android client parity.                                                              |
| `get-group-message-counts` / `get-best-friend` | DROP                 | Novelty statistics do not justify remediation scope or a new mobile surface.                                                                  |
| VAPID/Web Push administration                  | DROP                 | This Android client uses FCM; Web Push provisioning is outside its platform scope.                                                            |
| REST `GET /config`                             | DROP                 | Existing Server Health diagnostics already expose the useful sanitized status without adding a duplicate config surface.                      |
| `toggle-tutorial`                              | DROP                 | This local admin preference has no mobile parity requirement.                                                                                 |
| `config-update`                                | DEFER                | Reconsider only with an accepted live-config feature; `RT-01A` remains the sole owner of server-origin rotation.                              |
| `scheduled-message-update`                     | DEFER                | Reopen when cross-device live refresh is required for the current hybrid server/local scheduling model.                                       |
| `firebase-setup-status`                        | DROP                 | The app does not drive Firebase provisioning, so provisioning-progress events have no consumer journey.                                       |

Residual management operations embedded in rows whose read-only portions are already closed are also approved
**DROP** for mobile parity: FCM setup/clear/OAuth, helper reinjection, Find My key import, zrok/TLS/ACME/Cloudflare
management, REST admin config writes, and admin-wide device purge. They remain local-console responsibilities.

## App → Server (does the app call anything the server can't serve?)

**No user-facing breakage.** The original audit surfaced three candidates: two harmless/degraded
divergences that are guarded in-app or dead subscriptions, plus one defensive fallback that was
reverified as a match rather than a mismatch.

| Severity                | Capability                                                                                 | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⚪ Harmless (CONFIRMED) | realtime event: imessage-aliases-removed (socket-listen + fcm-event + notification intent) | App subscribes to 'imessage-aliases-removed' in SERVER_EVENTS (constants.ts:44, wired via the socket.on loop socketService.ts:168-172), normalizes it in eventRouter.ts:117-121 (passthrough, no zod schema), and has a case in notifications/intents.ts:87. The Gator server NEVER emits it: it is absent from DomainEvents/DOMAIN_EVENT_NAMES (events.ts) and grep across the entire server repo returns 0 hits. The subscription/handler is dead code that will never fire against this server. |
| ⚪ Harmless (CONFIRMED) | http-call: GET /server/update/check (checkUpdate)                                          | App's checkUpdate() in src/core/api/endpoints/server.ts returns Promise.reject(new UnimplementedEndpointError('/server/update/check')) and is never issued to the server; the Gator server registers no such route. Already guarded in-app so it can never 404 the server.                                                                                                                                                                                                                         |
| ✅ Match (reverified)   | http-call: POST /findmy/friends/refresh with GET fallback                                  | App refreshFriends() POSTs /findmy/friends/refresh then falls back to GET /findmy/friends if empty. The server DOES register /api/v1/findmy/friends/refresh (findmyOperations.ts:31), so this is a MATCH, not a mismatch — listed only to note the app's defensive fallback is unnecessary against Gator. No action.                                                                                                                                                                               |

## Server → App (capabilities the server has but the app doesn't use)

The original 2026-07-01 baseline listed 27 untapped server capabilities. Rows since wired remain
marked ✅ CLOSED in place as history; do not treat 27 as the current open count. See the ✅ Closed
sections above for current annotations. Most remaining rows are admin/config capabilities of low
mobile value or local-console-only; the genuinely app-relevant ones are ranked High/Medium.

| Priority                                                                                                       | Capability                                                                                                                                         | Detail                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 High (CONFIRMED)                                                                                            | admin-channel: set-config (adminOnly, local-only)                                                                                                  | POST /admin/command {channel:'set-config'} — full config write (password, tokens, server address, TLS mode). App never calls it (grep 0 hits). High user value for an in-app server-settings screen, but gated to x-bbd-local-auth so remote App calls get 403 — surfacing needs local console.                                                                                                                      |
| ✅ CLOSED 2026-07-01 (was 🔴 High — read via Server Health, see _✅ Closed_ above)                             | admin-channel: get-config                                                                                                                          | POST /admin/command {channel:'get-config'} — read config (secrets stripped, snake_cased), NOT admin-only, remote-readable. App has zero hits. Would power a read-only server-settings/status view in-app.                                                                                                                                                                                                            |
| ✅ CLOSED 2026-07-01 (was 🔴 High — see _✅ Closed_ above)                                                     | socket-emit: message-send-error                                                                                                                    | _(Historical snapshot below — now wired via SERVER_EVENTS → EventRouter → `DbEventSink` → `applyServerSendErrorWithinTransaction`.)_ Server forwards the helper's message-send-error (outgoing message failed in Messages). App's SERVER_EVENTS list did not include it in the original baseline — the app never surfaced send failures pushed from the server and relied solely on its optimistic-send/retry queue. |
| ✅ get-fcm-status CLOSED 2026-07-01 (Server Health; write/setup channels still untapped — was 🟡 Medium)       | admin-channel: get-fcm-status / set-fcm-server / clear-fcm / set-fcm-oauth-client / start-firebase-setup / get-firebase-setup-status               | FCM/Firebase provisioning + status channels. App never reads even get-fcm-status (0 hits). get-fcm-status is read-only/remote-readable and could confirm push is configured before the app relies on FCM delivery; the write/setup ones are admin-only local-console.                                                                                                                                                |
| ⏹️ RETIRED 2026-09-16 (historically read by Server Health)                                                     | admin-channel: get-private-api-status / get-private-api-requirements / reinject-helper                                                             | Historical server operations remain server-local context. The current client exposes no reinjection control, and these legacy reads can never authorize UI or network work. Separately advertised `supports_imessage_edit` and `supports_imessage_unsend` flags may gate only the narrow exact-part-zero paths documented above; they do not revive this retired admin/Private API surface.                          |
| 🟡 Medium (CONFIRMED)                                                                                          | admin-channel: check-permissions / get-current-permissions / contact-permission-status / request-contact-permission                                | macOS permission status + contact-permission request. App has 0 hits. Useful for an onboarding/diagnostics screen to tell the user the server is missing Full Disk / Contacts access.                                                                                                                                                                                                                                |
| ✅ CLOSED 2026-07-01 (get-alerts + Clear via Server Health — was 🟡 Medium)                                    | admin-channel: get-alerts / clear-alerts / mark-alerts-as-read                                                                                     | In-memory server alert log (read + clear/mark-read, all NOT admin-only, remote-invokable). App has 0 hits. Could surface server-side warnings (helper crashes, auth failures) in the app.                                                                                                                                                                                                                            |
| ✅ CLOSED 2026-07-01 (Server Health — was 🟡 Medium)                                                           | admin-channel: get-env                                                                                                                             | POST /admin/command {channel:'get-env'} — version/platform/node/findmyNeedsKeys/isMinMonterey. Read-only, remote-readable. App has 0 hits; findmyNeedsKeys would let the app tell the user Find My decryption keys aren't imported before showing empty FindMy tabs.                                                                                                                                                 |
| ✅ get-findmy-keys-status CLOSED 2026-07-01 (Server Health; import-findmy-keys still untapped — was 🟡 Medium) | admin-channel: Find My key mgmt — get-findmy-keys-status / import-findmy-keys                                                                      | get-findmy-keys-status (read, remote) + import-findmy-keys (admin-only write). App has 0 hits. get-findmy-keys-status pairs with get-env findmyNeedsKeys to explain empty FindMy device/item lists.                                                                                                                                                                                                                  |
| 🟡 Medium (CONFIRMED)                                                                                          | admin-channel: device management — get-devices / purge-devices                                                                                     | get-devices (read registered push devices, remote-readable) + purge-devices (destructive, admin-only). App registers via POST /devices but never lists or purges (0 hits). get-devices could show the user which devices are receiving push.                                                                                                                                                                         |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: GET /api/v1/devices (list-devices) + DELETE /api/v1/devices/:id (remove-device)                                                              | Dedicated REST device list/remove. App only POSTs /devices to register (grep: POST only, no GET/DELETE). Same use case as get-devices/purge-devices admin channels — manage this device's push registration / clean up stale tokens.                                                                                                                                                                                 |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: GET /api/v1/contact (get-contacts, all address-book contacts)                                                                                | Returns the full server address book. App only calls POST /contact/query (by-address lookup), never the bulk GET (0 hits for GET /contact). Could seed a server-side contact directory instead of per-address queries.                                                                                                                                                                                               |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: POST /api/v1/handle/query (get-handles)                                                                                                      | Paginated list of all handles/addresses. App has 0 hits for /handle/query. Could bootstrap the handle table on first sync rather than deriving handles from messages.                                                                                                                                                                                                                                                |
| 🟡 Medium (CONFIRMED)                                                                                          | socket-emit: group-icon-changed / group-icon-removed                                                                                               | Server forwards helper group-icon add/change/remove events. App SERVER_EVENTS omits both (0 hits), so a group photo change won't refresh the app's group avatar in realtime (only on next full resync).                                                                                                                                                                                                              |
| ✅ CLOSED 2026-09-13 (`RT-01A`)                                                                                | socket-emit: new-server                                                                                                                            | The event is intercepted before SQLite. Exact Play v63 proved rejected-origin zero contact, approved-origin persistence, foreground/fresh-password/cleartext consent, late-result discard, interrupted-SecureStore fail-safe recovery, and Android-trusted HTTPS downgrade rejection. Evidence: [`RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md).                                |
| ⚪ Low (CONFIRMED)                                                                                             | REST + admin-channel: webhooks (create/list/delete + get-webhooks/create-webhook/delete-webhook/update-webhook)                                    | POST/GET/DELETE /api/v1/webhook and the 4 webhook admin channels. App has ZERO webhook references anywhere. Entirely untapped; low direct value to a mobile client (webhooks are server-to-server integrations).                                                                                                                                                                                                     |
| ⚪ Low (CONFIRMED)                                                                                             | admin-channel stats: get-group-message-counts / get-best-friend / get-chat-image? already used; unused = get-group-message-counts, get-best-friend | App consumes 8 count channels (message/chat/handle/attachment/image/video/location) but NOT get-group-message-counts or get-best-friend. Both read-only/remote-readable. Fun 'stats' screen material.                                                                                                                                                                                                                |
| ✅ get-zrok-status CLOSED 2026-07-01 (Server Health; mgmt channels still untapped — was ⚪ Low)                | admin-channel: zrok tunnel — get-zrok-status / set-zrok-token / start-zrok / disable-zrok / register-zrok-email                                    | Zero-config tunnel management. get-zrok-status is read-only/remote-readable (running/url/available); the rest are admin-only local. App has 0 hits. get-zrok-status could show the app the current public URL / tunnel health.                                                                                                                                                                                       |
| ✅ get-tls-status CLOSED 2026-07-01 (Server Health; enable/disable/issue still untapped — was ⚪ Low)          | admin-channel: TLS/ACME — get-tls-status / enable-tls / disable-tls / issue-letsencrypt                                                            | TLS status (read, remote) + enable/disable/issue-cert (admin-only). App has 0 hits. Low mobile value beyond a read-only 'connection is TLS' indicator via get-tls-status.                                                                                                                                                                                                                                            |
| ⚪ Low (CONFIRMED)                                                                                             | admin-channel: Web Push — get-vapid-public-key / generate-vapid-keys / set-webpush-subject / disable-webpush                                       | VAPID/Web Push config. App is FCM-only and has 0 hits. Irrelevant to an Android/FCM RN client.                                                                                                                                                                                                                                                                                                                       |
| ⚪ Low (CONFIRMED)                                                                                             | REST: GET /api/v1/config (get-config REST)                                                                                                         | Auth-required sanitized server config over REST (distinct from the admin-channel get-config). App uses /server/info but never GET /config (0 hits). Exposes settings like private_api/tutorial state the app currently can't read over REST.                                                                                                                                                                         |
| ✅ GET /admin/status CLOSED 2026-07-01 (Server Health; admin config-write still untapped — was ⚪ Low)         | REST: POST /api/v1/admin/config (admin-update-config) + GET /api/v1/admin/status                                                                   | Dedicated admin config-write + status (version, uptimeMs) REST ops (separate from /admin/command). App has 0 hits for /admin/config or /admin/status. admin/status uptime could feed a server-health indicator.                                                                                                                                                                                                      |
| ✅ get-public-ip CLOSED 2026-07-01 (Server Health; DDNS mgmt still untapped — was ⚪ Low)                      | admin-channel: Cloudflare DDNS — cloudflare-ddns-sync-now / get-public-ip / save-lan-url                                                           | DDNS sync (admin), get-public-ip (read, remote), save-lan-url (admin). App has 0 hits. get-public-ip could help the app suggest an external server address.                                                                                                                                                                                                                                                          |
| ⚪ Low (CONFIRMED)                                                                                             | admin-channel: toggle-tutorial                                                                                                                     | Admin-only tutorial flag toggle (routes through set-config). App has 0 hits. Negligible mobile value.                                                                                                                                                                                                                                                                                                                |
| ⚪ Low (CONFIRMED)                                                                                             | socket-emit: config-update                                                                                                                         | Server broadcasts a config snapshot to the authed room on settings/TLS/tunnel changes. App never listens (0 hits). Would let the app react to a live server-address (new-server) or settings change without reconnecting.                                                                                                                                                                                            |
| ⚪ Low (CONFIRMED)                                                                                             | socket-emit: scheduled-message-update                                                                                                              | Server emits null signal when a scheduled message is created/updated/deleted (client should refetch). App does not listen (0 hits); its scheduled-message list won't live-update from server-side changes made elsewhere.                                                                                                                                                                                            |
| ⚪ Low (CONFIRMED)                                                                                             | socket-emit: firebase-setup-status                                                                                                                 | Server emits Firebase/OAuth provisioning progress to the authed room. App does not listen (0 hits). Only relevant if the app drove Firebase setup, which it does not.                                                                                                                                                                                                                                                |

## Bottom line

- **App → Server has no user-facing breakage.** The only drift is a harmless listener for an event this server
  cannot emit and a fail-closed update-check stub; their approved dispositions are explicit above.
- **Server → App uses the core data/action APIs and the selected diagnostic reads.** The remaining open
  capabilities are all accounted for in the `PARITY-01` register rather than being informally called wired,
  deferred, or unworthy here.
- The post-v56 `new-server` approval/reconfirmation flow is implemented, quarantined from SQLite,
  and exact Play v63 Android network/SecureStore-interval proof is complete under `RT-01A`.
- The 15 `DEFER`/`DROP` decisions are final for the current remediation scope. Changing one requires a new explicit
  product-owner decision and, for deferred features, selection of the owning implementation task.
