# Push notification delivery — architecture, the 2026-07-24 outage, and the fixes

Written after diagnosing "I stopped getting push notifications." The root cause was a **silent
total failure of killed-app push** that had been masquerading as flakiness. This document records
the chain, what was actually broken, what changed, and how to diagnose it next time — so nobody
re-derives it.

Spans two repos: this one (the RN app) and `bluebubbles-server` (`packages/bbd`, the Gator daemon).

---

## 1. The delivery chain

Ten links. Any one can break it, and until this work most of them broke it _silently_.

| #   | Link                                                                | Where                                                          |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | An ordinary iMessage/RCS message reaches the server's domain bus    | `packages/bbd/src/serialize/messageFanout.ts`                  |
| 2   | The ordinary fanout calls `pushMessageSink`                         | `packages/bbd/src/backend.ts`                                  |
| 3   | It reads registered devices                                         | `configStore.listDevices()`                                    |
| 4   | A `new-message` body is trimmed under FCM's hard 4096-byte data cap | `packages/bbd/src/serialize/pushPayloadCap.ts`                 |
| 5   | The registry fans out, deduping by send target (token)              | `packages/bbd/src/notifications/NotificationRegistry.ts`       |
| 6   | FCM HTTP v1: mint OAuth, then POST the data message                 | `packages/bbd/src/notifications/FcmProvider.ts`                |
| 7   | Google delivers to the device                                       | —                                                              |
| 8   | The app's background/foreground handler receives it                 | `src/services/notifications/fcmMessaging.ts`                   |
| 9   | Envelope parsed → decrypted → normalized → durably deduped          | `fcmPayload.ts`, `fcmDecrypt.ts`, `incomingEventDispatcher.ts` |
| 10  | DB write (source of truth), then intent → Android notification      | `dbEventSink.ts` → `intents.ts` → `notifeeService.ts`          |

Properties worth knowing:

**App Lock notification policy (2026-10-03 repair; replacement-device proof pending):** new message
and alias notices remain generic whenever App Lock is enabled, including warm unlock and the UI grace
period. Enabling installs a synchronous presentation barrier and waits for a serialized native-only
sweep of displayed notices/private channel labels; cold persisted ON performs the same sweep before
the protected gate succeeds. Verified generic reminder alarms survive. Unsafe legacy alarms are
cancelled before sweeping displayed state. Failure does not claim successful protection and retains
the process-local generic-only barrier. Epoch/account checks contain late native posts. UI grace and
locked V3 durable-admission rules are unchanged. Play v80 does not contain this repair.

The table describes ordinary message fanout. Attempt-aware RCS failures instead enter through
`RcsListener`/`composeRcsOutbound`, then call the same notification registry; only `new-message`
uses `capMessagePushPayload`.

- **Priority is split deliberately.** Among ordinary message-state events, only `new-message` is
  sent at FCM `high` priority. `updated-message` (delivered/read/edit receipts), `message-deleted`,
  and `message-send-error` are silent data-only state corrections sent at `normal`, so they don't
  burn the app's finite high-priority Doze wake quota — once that quota is spent, Android downgrades
  the _real_ message pushes and defers them by minutes. Separate user-requested test and urgent
  server-address/bridge alerts use high priority.
- **The device token is re-registered on EVERY reconnect**, not once (`startRealtime()`). The server
  dedups by token, so it is idempotent. That per-connect retry recovers a registration broken by a
  first-boot failure or server change. The native `onTokenRefresh` callback separately registers a
  rotated FCM token immediately while realtime is active.
- **Dead targets self-prune.** An FCM 404 / Web Push 410 removes the device row via `onDeadDevice`.
- **Socket and FCM share normalization; durable intake deduplicates redeliveries.** Canonical
  occurrence receipts survive process death. A V3 FCM copy is keyed by its push occurrence id, which
  never matches the socket copy's content key, so while the app is open both copies of an event are
  applied. Their effects are idempotent: notifications re-post with `onlyAlertOnce`, the outgoing
  retry ledger ignores a matching duplicate error, and a capped (`textTruncated`) push copy never
  replaces a body the socket copy already stored. A shared key needs a server change. On a server that advertises
  `supports_rcs_send_attempt_ownership`, the exact RCS identity is the complete
  `{tempGuid, attemptGuid, clientAttemptGeneration}` tuple. A partial or malformed tuple is marked
  invalid, fails closed instead of falling back to content matching, and gets a distinct durable
  intake identity so it cannot suppress a later corrected exact event. The in-memory
  `EventRouter.seen` set remains only on the legacy direct `new-message` path.
- **Attempt-aware RCS send errors use one identity across transports.** Server commit `e55f1210`
  introduced one immutable `attemptGuid` per physical attempt; the 2026-09-07
  `PUSH-RETRY-01` host work binds that id to the app-owned retry generation and reuses the same
  logical DTO across socket, webhook, and FCM before transport-specific serialization/encryption.
  Managed-device FCM
  requires `messages:write`; unmanaged legacy push rows retain the existing compatibility policy.
  A canonical per-device key encrypts the DTO; without one, FCM carries only the event type and
  empty-object metadata. Shared-password compatibility can use the bounded `AEAD_GCM_V2_DEVICE`
  frame; a scoped credential requires `AEAD_GCM_V3_IDENTITY`, which authenticates the exact
  server/principal/device/message/occurrence/time identity and durably claims replay before effects.
  The matching app/server source and host contracts are complete through `PUSH-CRYPTO-01D`.
  End-to-end killed-app delivery against one deployed candidate remains blocked under
  `PUSH-CRYPTO-01E`; legacy temp-only failures remain socket/webhook-only because they cannot be
  deduplicated safely across transports.

---

## 2. What was actually broken

### 2.1 ROOT CAUSE — the FCM background handler was never registered (killed-app push dead)

**Symptom.** Push worked, then stopped, then worked again after opening the app. Server logs showed
nothing. The phone's permissions, notification channel, and battery state were all healthy.

**Evidence.** With the app's process alive but its UI never mounted, a push produced exactly this:

```
D/RNFirebaseMsgReceiver: broadcast received for message
W/ReactNativeJS: No task registered for key ReactNativeFirebaseMessagingHeadlessTask
```

The message reached the device and was dropped there. Server-side, the same push reported
`{total: 2, sent: 2, failed: 0}` — every layer claimed success.

**Cause.** `setBackgroundMessageHandler` (RNFB), `notifee.onBackgroundEvent`, and
`TaskManager.defineTask` each register a _named headless task_ that Android looks up the instant it
wakes the app — with **no render**. All three were registered by side-effect imports at the top of
`app/_layout.tsx`. But `_layout.tsx` is a **route module**: expo-router loads it lazily through its
`require.context`, at render time. A headless wake evaluates the bundle entry and never renders, so
that module was never evaluated and the tasks were never registered.

**Why it looked intermittent.** As long as the process stayed alive from the last time the user
opened the app, the handler _was_ registered and push worked. The moment Android reclaimed the
process — routine, and aggressive on Samsung One UI — every push was dropped until the app was
manually reopened.

**Fix.** A real bundle entry, `index.js`, referenced by `package.json` `main`:

```js
import './src/services/errors/registerReactNativeExceptionPrivacy'; // MUST be the first side effect
import './src/services/logging/registerPersistentLogs'; // persistent ERROR sink
import './src/services/notifications/backgroundEvents'; // notify-kit headless taps
import './src/services/background/registerBackgroundSyncHeadlessTask'; // 'gator-bg-sync' task
import './src/services/notifications/registerFcmBackgroundHandler'; // setBackgroundMessageHandler
import './src/services/download/registerBoundedNativeDownloadCleanup'; // abandoned partials
import 'expo-router/entry'; // MUST be last
```

`index.js` is the only registration owner. A route module such as `app/_layout.tsx` cannot be a
fallback: Android never evaluates routes during a killed-app wake. This also fixed a related error
the same flaw produced at boot:
`Cannot start headless task, CatalystInstance not available` from expo-task-manager.

> This needs a **native rebuild** to take effect — the release bundle is embedded at build time.

### 2.2 The one end-to-end probe could only report false negatives

The server's "Send Test Notification" button sends event type `test-notification`. The app had no
entry for it in `SERVER_EVENTS` and no `normalize()` case, so `EventRouter` hit `default: return
null` and dropped it. The server reported `sent: N, failed: 0` while the phone showed nothing.

The single tool for answering "is push working?" was therefore incapable of ever saying yes. During
this investigation it had to be bypassed entirely (logcat was used instead). A diagnostic that can
only produce false negatives is worse than none — it actively misleads.

**Fix.** `test-notification` is now a fully handled event through all six touch points. It carries no
conversation content, and seeing it _is_ the passing result. It deliberately bypasses the "Message
Notifications" toggle and unknown-sender filter because it is a user-initiated diagnostic rather
than a message.

### 2.3 The server was blind to its own push failures

`NotificationRegistry` logged a delivery failure at `debug` — which the file and console sinks drop
— and `pushMessageSink` discarded the `DeliveryResult[]` entirely. A 100%-failing FCM config (a
revoked service account, a spent quota, an HTTP 403) produced **no visible server log at all**.

**Fix.**

- Delivery failures log at `warn`, naming the device and carrying the provider's error message.
  Dead targets (404/410) stay at `debug` — expected, self-healing via the prune, and otherwise they
  would warn on every message until the prune lands.
- `pushMessageSink` logs the failure _shape_: `2/2 device deliveries failed` means the pipeline is
  down; `1/2` means one phone is gone.
- The typed test-notification operation returns truthful `total`, `sent`, `failed`, and `configured`
  counts. Provider error details stay in the Mac's local server logs rather than crossing the admin
  API boundary.

### 2.4 One channel failure killed message notifications permanently

`ensureChannel()` in `notifeeService.ts` memoized the `createChannel` promise but never cleared it
on rejection — unlike the then-existing FaceTime and Reminder channels, which always had that guard. One transient
failure poisoned the cache for the whole JS context: every later `postNotification` awaited the same
rejected promise and threw, so message notifications stopped until the app restarted.

Compounding it, all three `postNotification` call sites were bare `void postNotification(intent)`,
so the throw surfaced only as an unhandled rejection with no attribution.

**Fix.** `ensureChannel` clears its memo on rejection, matching the other two. A new
`postNotificationSafely` wrapper contains failures and emits a development-only `warn`; release
builds suppress free-form non-error logs, while durable deliveries keep their retry/backoff path.
The three near-identical status-notification blocks were folded into one `postStatusNotification`
helper rather than adding a fourth copy.

### 2.5 Not a bug (recorded so it isn't "fixed")

- **Two registered devices.** The server had two FCM rows, "Gator (Android 36)" and "Gator (Android
  37)". These are two _distinct tokens_, i.e. two distinct installs — the phone under test is API 36.
  The registry dedups by token, so this is correct behaviour, not duplicate delivery. Purging would
  have deregistered a live device.
- **`hoistChatGuid`** (`fcmPayload.ts`) folds a top-level envelope `chatGuid` into the body, but the
  Gator server does not send that sibling key. Modern keyed FCM may also carry the separate
  `encrypted` and `encryptionType` routing fields; they do not change this `chatGuid` invariant. The
  helper is harmless and remains as tolerance for other server builds.

### 2.6 Attempt-aware RCS send-error fanout (2026-09-04)

_Historical snapshot: this section records the September 4 boundary. Section 2.8 documents the
host-complete September 7 active-attempt ownership work that supersedes the final two app-side
limits below._

Server commit `e55f1210` closes the source-level identity gap for RCS `message-send-error`. BBD
reserves a UUID for each admitted physical attempt, encodes it with the logical `tempGuid` in the
sidecar's opaque `tmpID`, and recovers that correlation from live status frames under the paired
phone's persisted destination-registration UUID (or the established legacy/QR source-id fallback).
Duplicate requests replay the same attempt; an authoritative failure releases only its exact
generation, even if the original owner settles later, so a genuine retry receives a new id and a
delayed old failure cannot evict it from the server.

Socket, webhook, and attempt-aware FCM receive the same logical DTO before transport-specific
serialization/encryption. Managed-device FCM requires `messages:write`; unmanaged legacy push rows
retain compatibility authorization. With a canonical per-device key the DTO is encrypted; without
one, FCM carries only the type plus `{}` metadata and never exposes temp/chat/attempt ids in
plaintext. The app's `PUSH-CRYPTO-01A` client path now registers a canonical
`AEAD_GCM_V2_DEVICE` key and decrypts that ciphertext; socket/webhook continue to use `attemptGuid`
too. Google must still be shown to echo the encoded `tmpID` for text and media at the supported
length, the phone namespace must be observed on a physical pair, and a connected killed-app FCM
error must converge once on the exact candidate. A
crash after Google accepts the send but before BBD persists the first correlated frame remains
outside the guarantee; after the bounded 90-day/50,000-message correlation retention window, an
exceptionally late status falls back to non-exact socket/webhook delivery instead of risking
incorrect cross-attempt FCM dedup. Two app-side limits remain. Manual Try Again requires an existing
outgoing queue row, so a non-retryable post-ack delivery error cannot create a user-driven attempt B.
Also, `attemptGuid` currently identifies the incoming occurrence but is not stored as the bubble's
active attempt owner: an already-processed A replay is deduplicated, but a first A copy delayed until
after B can still relabel the shared tempGuid. Automatic A → B proof must use a certified
`retryable: true` pre-dispatch error, and the stronger late-first-arrival/manual-retry contract needs
client implementation.

### 2.7 Random-key V2/V3 client foundation and rotation (2026-09-09)

When `/server/info` reports `supports_fcm_device_encryption: true`, registration requests 32 secure
random bytes from Expo Crypto, stores a canonical-origin-bound `pending` record in SecureStore
before POST, sends `{pushEncryption:{type:'AEAD_GCM_V2_DEVICE',key}}`, and activates the record only
after the server returns the exact encryption type and a bounded device id. Registration is FIFO,
so reconnect and token-refresh calls cannot create competing keys; a lost response retries the same
pending key. An absent or cached-false capability is refreshed so a server upgrade can enroll V2.
A server that still reports no encryption support is not registered at all: its plaintext pushes
would carry message content through FCM only to be dropped on arrival. Registration reports
failure instead, so the app shows "Push updates are unavailable" and sync remains the fallback.

Pending and active V2 records accept only canonical standard-base64 V2 frames. The app decrypts
`version(2) | IV(12) | tag(16) | ciphertext` with the stored raw 32-byte key and authenticates the
exact event type as AES-GCM additional data. On the unlocked content path it rejects malformed
state/frame/key/UTF-8, wrong origin, plaintext, V1, and unknown schemes. Password-derived V1 and
plaintext receive support are removed even when no random-key state exists. Enrolled V2 remains a
temporary encrypted compatibility path only before the exclusive **2027-02-01T00:00:00Z** cutoff;
before that cutoff a locked V2 delivery may post one generic notice only after its frame
authenticates, without opening the database, while an absent state posts no notice. After the cutoff
V2 fails closed and sync is the fallback.

Scoped sessions require identity-bound V3. A versioned active key rotates after 30 days, with a
bounded timer covering a continuously connected process. The candidate key, stable rotation UUID,
previous version, and request times are stored before POST, so a lost response retries exactly.
During a server-acknowledged overlap the candidate/current key is tried first and the immediately
previous key only until the earlier of the server deadline and the local crash-safe deadline.
Before any acknowledgement the server may never have received the candidate, so the previous key
stays accepted for at most one 30-day rotation interval from the first attempt (review M097); a
retry cannot extend that bound, and each V3 payload's signed expiry still rejects old captures. An
aged idempotent acknowledgement promotes the current key without reviving an expired predecessor.
After realtime work drains, Disconnect replaces any present key record with a retained keyless
`revoked` tombstone; a failed or timed-out retirement keeps the next connection blocked, and a
capable reconnect creates a fresh key.

V2 authenticates no stable server/account/device/message identity or issued time beyond the event
type, and it supplies no cryptographic replay id or durable replay window. V3 authenticates the exact
stable binding, event/message relation, occurrence id, issued time, and expiry before deriving a
scoped durable replay key. Unlocked delivery reaches the normal encrypted incoming-event queue;
locked delivery posts a generic notice only after a new durable admission, so a duplicate cannot
re-alert after restart. Scoped Disconnect invokes the server's exact-device revocation operation and
retains retry custody on failure. Ordinary same-key registration refresh preserves durable rotation
metadata without returning a false rotation acknowledgement; an exact lost-response retry returns
the original paired rotation id/expiry without extending the predecessor overlap.

This is source and host-test evidence only. Android Expo Crypto/SecureStore behavior, process-death
access, Firebase delivery, locked/headless behavior, and matching server deployment still require
physical-device proof under `PUSH-CRYPTO-01E`; the primary parent remains open for that boundary.
Registration sends its key through `HttpClient`; only HTTPS hides it from a local network observer,
so owner-approved cleartext connections do not support a strong push-confidentiality claim.

### 2.8 Durable RCS active-attempt ownership (PUSH-RETRY-01, 2026-09-07)

The server now advertises `supports_rcs_send_attempt_ownership`. Before creating an optimistic RCS
message, the app resolves an unknown capability through `/server/info`; it no longer mistakes the
short startup window before server info arrives for a known legacy server. A completed response
that omits the flag is still handled as legacy generation zero.

For a capable server, each optimistic message stores a durable app-owned generation plus whether
its physical owner is still pending. A retry claim uses an atomic compare-and-swap (CAS: update only
if the row still has the state just read) to advance that generation, so two concurrent drains
cannot both become the next attempt. The request sends `tempGuid` and `clientAttemptGeneration`;
the server assigns `attemptGuid`. A normal-send acknowledgement keeps the logical tempGuid in its
existing `guid` field and adds the attempt fields; an RCS new-chat result returns the named
`{tempGuid, attemptGuid, clientAttemptGeneration}` tuple. The background RCS delivery-error adapter
also forwards the generation instead of dropping it.

Acknowledgements, exact `new-message` successes, and `message-send-error` events all reconcile
against the durable owner. A delayed result from attempt A cannot overwrite settled retry B. If the
server idempotently replays A while the app is processing a newer local retry token, the app installs
A's physical `attemptGuid` under that current local generation rather than rolling the durable
generation backward. If the bounded temp-guid alias has already been pruned, an error may recover
the bubble only when its active `attemptGuid` identifies exactly one message; zero or multiple
matches fail closed.

Malformed or one-sided correlation fields never enter the legacy content matcher. They are stored
with an invalid-correlation marker and use a different durable event identity from a later complete
tuple, allowing the corrected event to be processed safely. Queue-less automatic reconstruction is
also deliberately narrow: only an attachment with its retained local file metadata can be rebuilt.
Text and contact sends remain visibly failed when their queue row is gone because their exact payload
kind and metadata are not yet durable enough for a faithful resend.

Focused host tests and TypeScript checks pass in both the app and server repositories. This is not a
release or deployment claim: matching builds, killed/background-app delivery, the paired-phone
Google correlation behavior, and the exact delayed-A/retry-B device matrix still need device
evidence. Queue-less text/contact automatic replay remains intentionally unavailable until payload
kind and all resend metadata are retained durably.

The FaceTime comparison above is historical root-cause evidence; `FP-006` subsequently removed the
FaceTime channel and actions from the current client.

### 2.9 Current killed-process notification actions use durable credentials (updated 2026-09-16)

Android may invoke a plain Reply or Mark as read in a fresh JavaScript process whose foreground
Zustand session still contains its empty defaults. A supported whole-message RCS Love action may
also use the independent RCS transport. Every remaining network action resolves one explicit
transport: a warm action pins the connected client's origin and monotonic transport revision, while
a cold action re-runs the same vault, App Lock, and revocation inspection used by background sync
and builds one immutable task-local client. Cold results never hydrate or publish the foreground
store.

Reply retains its existing authored-copy rule: the tray stays until the optimistic message and
outgoing queue row commit. An existing iMessage chat sends that plain text with AppleScript; an RCS
chat uses its separately advertised transport. A supported RCS Love action uses the same fixed
client, while its database settlement keeps the separate account/revocation guard so a later tunnel
rotation becomes an ordinary durable retry instead of stranding a sending row. iMessage Love,
FaceTime Answer/link creation, and every other helper-dependent action are absent. Mark as read
commits the local marker first. Only when the saved Send Read Receipts setting is on does it then
resolve the same explicit transport for the receipt: an RCS chat must still belong to the current
pairing, and an iMessage chat needs the server's own read-state capability. A killed process has no
hydrated session, so it takes that capability from the server's answer to its task-local request
(review M199). Stale feature settings cannot restore remote read-state effects.

The notification may expose Love from a cold process when both route identities are canonical
(`RCS;-;…` chat and `rcs-…` message); it does not depend on the empty foreground Zustand cache.
Pressing Love still performs the task-local server-info lookup above before any send is admitted.

The earlier 2-service-suite / 65-test result proves the 2026-09-07 credential-composition work only;
it does not prove the later retirement. Current `FP-006` verification must instead show that stale
iMessage helper and FaceTime actions fail before network work while the retained plain-send, local
read-state, and RCS boundaries still behave as documented. Host checks do not prove Android
SecureStore access, native action delivery, tray timing, or process-death behavior.

### 2.10 Killed-process wallpaper events retain account and transport identity (2026-09-07)

A background-changed group event is durably applied before its optional synced-wallpaper refresh.
That refresh may outlive the individual queue attempt, but it must not lose the account that emitted
the event. The sink therefore forwards only the originating account-generation number. The detached
entry point captures a fresh lease for that same generation and either pins the warm connected
client or re-authorizes a fixed vault client through App Lock and the durable revocation marker.

The wallpaper service checks both account authority and HTTP transport currentness around metadata,
native download, and database publication. This matters for an approved tunnel change: account
ownership remains valid, while the old origin/header snapshot must stop. Chat-open wallpaper refresh
uses the same pinned-client rule. A killed process never hydrates foreground Zustand merely to make
this feature work.

Host checks cover both warm/cold selection and the rotation fence. Android FCM/SecureStore startup,
native cancellation, and actual wallpaper rendering still require the exact-candidate device run.
The attachment auto-download caller is covered in the next section; task-local prerequisite
recovery is covered in section 2.12.

### 2.11 Killed-process attachment auto-download owns one bounded app-cache attempt (2026-09-07)

The post-commit message hook carries the originating account generation into the same warm-pinned
or cold durable transport resolver as synced wallpapers. It passes that task-local client and lease
through the complete download, never relies on the empty foreground HTTP singleton in a fresh FCM
process, and treats a transport/account change as stale before native transfer or DB settlement.

A killed-process runtime also skips foreground attachment-cache startup recovery. Before reserving a
persistent destination, the detached entry point therefore joins or starts the existing bounded,
generation-guarded recovery flight. Only a `ready` result under the same current lease opens the
download; stale or failed recovery remains a best-effort no-op. The development fixture still uses
its installed synthetic fetcher instead of attempting a real request to its placeholder origin.

For a background FCM delivery, an absolute attachment-effect deadline is captured at
`receivedAt + 40 seconds`. After FIFO admission, a generation-bound collector accepts the
post-commit `auto-download:<messageId>` factory synchronously. Repeated revisions share one keyed
task. Collection close stops admission and starts the factories sequentially only after durable
dispatch and notification presentation finish. The native callback awaits this tail outside the
account-teardown slot. Deadline or account invalidation revokes the composed transport/download
lease, with at most two seconds of cooperative cleanup grace.

Focused host checks cover recovery-before-download, stale/failure refusal, task-client propagation,
queued ordering, revision deduplication, sequential execution, deadline/account revocation, and the
native-callback wait. This closes the former detached app-cache source-lifetime gap, but is bounded
best effort rather than a durable retry: process death after the DB checkpoint may still skip or
interrupt the copy. The 40-second deadline covers only the attachment-effect tail, not FIFO wait or
dispatch/presentation by itself. An enclosing 50-second FCM callback lifetime covers FIFO wait,
dispatch/presentation, prerequisite recovery, and the effect tail. Expiry revokes its composed
lease and abort signal before the public callback continues, while the real underlying delivery
remains the FIFO fence so a fresh callback cannot overlap it. Final persistent-log flushing uses a separate callback-entry
`receivedAt + 55 seconds` cutoff, leaving five seconds before RNFB's 60-second Android task limit.
It adopts the older serialized log work and its own queued write, retains ownership across every
attempt in an older overlapping headless retry session, revokes asynchronous file-mutation authority
before expiry returns, and suppresses later debounce/retry work. A synchronous Expo/native call that
already began cannot be interrupted, so native cancellation and complete callback timing remain
exact-Android proof requirements rather than host claims.

Headless delivery deliberately skips the immediate `expo-media-library` call because the Photos
operation has no cancellation signal. For an eligible incoming non-sticker image with a saved
Gallery or Gator Album preference, it now commits a bounded destination-bound receipt before
allowing the private-cache download. Once `localPath` commits, an active, unlocked, connected
foreground session with already-granted Photos permission can claim and fulfill that receipt. A
setting change or disabled auto-download cancels pending work; permission checks never open a
passive prompt. A process stop after MediaStore saves the copy but before receipt completion can
cause a later duplicate attempt, so claims, age, capacity, and attempts are bounded. The app-cache
effect itself remains best effort: death before its DB/file commit can still leave the receipt
without an eligible source until maintenance expires it. The exact-candidate receipt/restart proof
and native hostile-server, process-death, cleanup, quota, and DB/file device matrix completed under
`DL-01` on Play v75. The remaining killed-process callback and incoming-retry device boundaries stay
open under `REL-001` and `PUSH-RETRY-01`.

### 2.12 Killed-FCM prerequisite recovery owns its bounded retry (2026-09-07)

A durable message/read/group event can arrive before its local chat or message prerequisite. Those
expected failures now inherit the dependency-pending marker, so the repository refunds the claim
attempt and commits the documented five-second retry instead of using the ordinary 30-second error
backoff. The drain emits a synchronous signal only after that settlement succeeds. This also covers
wait-only RCS attempt-owner ordering, which needs a retry but no network repair.

During an FCM delivery, the composition root collects the exact task-local recovery jobs and starts
the due clock from that DB signal, not after the whole drain flight. Chat recovery is capped at eight
seconds to preserve the 15-second read-status lifetime; account/deletion recovery is capped at 20
seconds. Recovery and the due clock run concurrently, followed by one 20-second bounded drain retry.
The runner uses the authorized warm/cold transport, serializes with other sync owners, and supplies
account/transport/App-Lock guards to every network and DB continuation. Generation retirement and a
warm App Lock transition abort immediately.

Host tests prove targeted ordering/caps, timeout and invalidation, App-Lock refusal, true dependency
deferral, wait-only retry, both recovery/due completion orders, and generation cancellation. This
closes the prerequisite-recovery source lifetime only. Exact Android killed-process execution and
matching app/server deployment evidence remain open under `REL-001` and `PUSH-RETRY-01`; section
2.11 closes the app-cache effect-tail and Gallery/Album receipt source gaps. `DL-01` is complete
under Play v75; the remaining matching-candidate killed-process execution and device proof are
owned by `REL-001` and `PUSH-RETRY-01`.

### 2.13 Killed-process RCS pushes confirm the current pairing (2026-10-10)

Every RCS-looking realtime event (RCS message/chat ids, send errors, read status, `rcs-alert`,
`rcs-bridge-down`) is admitted only against the server's current Google pairing epoch. That epoch
used to come only from foreground session state, which a killed-process FCM wake never hydrates, so
the event was persisted, deferred on every retry, and stayed queued without a notification until the
user opened Gator.

An unlocked FCM callback whose event needs that authority, and that finds no foreground server info,
now fetches `/server/info` once through the authorized warm/cold transport (sections 2.10–2.12)
before it queues the event. The fetch has a five-second deadline and stops at once when the callback
is cancelled or the account generation retires (Disconnect). The result is lent to the sink chain
only while that same callback is current and is released when its dispatch, including the
dependency retry, settles. Live foreground state always wins over the loan. A response with no
current pairing (the server reports `rcs_provider_epoch: null` while it re-establishes its RCS link)
is never lent, because it would make every RCS event look stale and drop it. A failed, slow, or
pairing-less fetch leaves the event queued exactly as before. FCM callbacks are serialized by
`fcmAdmissionTail`, so the short wait before persistence cannot reorder deliveries. The locked V3
enqueue path keeps its own fetch.

RCS photo auto-download, including the Gallery/Album receipt, starts only after the push's loan is
released. Since 2026-10-14 the post-store hook remembers the pairing the message was stored under,
and the adopted background download keeps using it while no live server info exists: missing info
means unknown, not changed. Live info that shows a different pairing still ends the download for
good, as a re-pair does in the foreground. The background download carries its own pairing check
(`AttachmentDownloadOwner`), because the downloader otherwise asks the foreground session, which a
killed process never fills. It also fails quietly: a failed or cut-off background attempt removes
the photo's in-memory download entry instead of marking it failed, so a chat opened later in the
same process fetches the photo by itself instead of showing Retry. It never clears an entry after
Disconnect, and it never takes a photo over from an RCS retry the user already started, because
taking over would cancel that retry and leave nobody to report its result. The killed-process path
still stores only the app-cache copy plus the Gallery/Album receipt, which the next unlocked
foreground activation fulfills.

Known limits of the photo download: if authority becomes unknown between the message commit and
the post-store hook, the hook is skipped and the retried row replays without it, so that photo gets
no background download or Gallery/Album receipt (the open app's own socket copy of the event
normally covers it). A download waiting in the queue can also miss a different pairing that was
visible only during another push's short loan; the server still refuses media from a pairing that
is no longer current.

A row admitted under the loan can lose authority mid-event when the loan is released while another
delivery flight is still processing it (the app was opened during that push). Since 2026-10-14
`RcsProviderEpochEventSink` hands such a durable row back for the ordinary dependency retry instead
of reporting it processed, because unknown authority is not proof the event is stale; a changed
pairing still drops the event. The replay skips a database phase that already committed, and a
repeated message post replaces its notification line without alerting again.

Host tests cover the loan reaching both admission layers, Apple and warm pushes fetching nothing,
fetch failure, the deadline, callback and Disconnect cancellation, a pairing-less response,
foreground precedence, a foreground launch mid-push, the dependency retry, release on failure, the
background photo download keeping its stored pairing until live info shows another one, and quiet
background failure. The incoming-ingress certificate pins the loan around the unchanged dispatch
body and the post-store download hook. Exact Android killed-process execution remains device-only
evidence.

---

## 3. How to diagnose push next time

Work the chain from the middle out; each step tells you which side you're on.

1. **Is the server sending?** On the Mac, open the local Gator dashboard, go to **Devices**, and
   choose **Send Test Notification**. The dashboard calls the typed local-only
   `POST /api/v1/devices/test-notification` operation and shows the sent/failed counts.
   `sent: N, failed: 0` means links 1–6 are healthy. If a delivery fails, inspect the Mac's local
   server logs for the provider error that identifies the failed link.

   Do not call the retired `/api/v1/admin/command` dispatcher or scrape a local-admin credential
   from process arguments. Current builds intentionally keep the local dashboard capability out of
   command-line arguments and environment variables.

2. **Are the right devices registered?** Review the list on the same **Devices** page. It uses the
   typed `GET /api/v1/devices` operation. Check `lastActiveAt` and confirm that the registered token
   count matches the number of real installs.

3. **Did it reach the phone?** This is the step that found the bug:

   ```bash
   adb logcat -c
   # fire the push
   adb logcat -d | grep -E 'RNFirebaseMsgReceiver|No task registered|HeadlessTask'
   ```

   `broadcast received for message` with **no** following warning = delivered and handled.

4. **Is the device even allowed to show it?**
   ```bash
   adb shell dumpsys package <pkg> | grep POST_NOTIFICATIONS   # granted=true
   adb shell am get-standby-bucket <pkg>                       # 5=exempt … 45=restricted
   adb shell dumpsys deviceidle whitelist | grep <pkg>         # battery exemption
   adb shell dumpsys notification | grep -A3 <pkg>             # channel importance, mDeleted
   ```

### The `am kill` vs `am force-stop` trap

Use **`adb shell am kill <pkg>`** to simulate the OS reclaiming the process. Do **not** use
`am force-stop`: it puts the app in Android's "stopped" state, where the OS cancels _all_ broadcasts
until a manual launch (`logcat` shows `broadcast intent callback: result=CANCELLED`). The bug then
looks unreproducible. This cost real time during the investigation.

---

## 3a. Follow-up, 2026-07-26 — the second round

Push was still missing "at times", on a **second device** (Pixel 10 Pro XL, Android 17 / API 37;
the first investigation was driven entirely against a Galaxy S25 Ultra on Android 16). Findings:

**The §2.1 fix works.** The S25 now logs `RNFirebaseMsgReceiver: broadcast received` with **no**
`No task registered` — the original signature is gone.

**Ruled out on the Pixel, with evidence:** token registration (its row is current, re-registers on
launch, token unchanged, FCM returns `failed: 0` — a dead token would 404 and auto-prune); app
version (0.1.33 vc46, _newer_ than the S25's vc44); OS restrictions (`POST_NOTIFICATIONS` granted,
standby bucket 5, battery-exempt, Data Saver off, `RUN_ANY_IN_BACKGROUND: allow`, not dozing);
app-side errors (the development build's App Logs showed no `[fcm]`/`[notify]` failures); and the
server (every send `sent: 2, failed: 0`).

**The Pixel's chain does work.** Killed its process (`am kill-all`, 0 processes), fired a push, and
Android logged `Start proc … for broadcast {ReactNativeFirebaseMessagingReceiver}` followed by the
notification posting. Killed → woken → shown.

**But it is genuinely intermittent.** Two _identical_ killed-process tests a minute apart: the first
never started the process and posted nothing; the second worked. Same device, same push, same state.
Root cause of that last hop is **NOT yet established** — do not assume it is.

Two theories were falsified along the way and are recorded so they aren't retried: a locked-device
Keystore failure aborting `dispatchRealtimeEvent` at `ensureDatabase()` (dead — unlocking changed
nothing), and the Pixel running an older build (dead — it is newer).

**What was added:** a receipt breadcrumb in `deliverRespectingLock`, the single entry point both the
headless background handler and foreground `onMessage` share. Until then a dropped push and a
silently-handled one were indistinguishable: both simply absent (an `updated-message` receipt posts
no notification by design). It is now the finite diagnostic event `fcm.push_received`
(`src/services/notifications/fcmMessaging.ts`, defined in `src/core/secure/errorDiagnostic.ts`) with
two fields: the event name, mapped to a known server event or `unknown`, and `source` (`background`
or `foreground`). Never the body, which carries message text. Unlike free-form lines, which
`LOG-01B` drops in release builds, this finite event is kept in release: it appears in Settings → App
Logs and the persistent log (on the console only in development), so a candidate investigation can
compare it with the server's sends.

Also of note: measurement artifacts cost real time here. `RNFirebaseMsgReceiver` was briefly believed
not to be emitted (it is — the capture window was wrong), and `dumpsys notification` counts are
useless for repeat tests because the test notification uses a FIXED id and updates in place — read
its `when=` epoch field instead.

## 4. The lesson

Every layer reported success while the outcome was wrong: the server said `sent: 2, failed: 0`,
Google delivered, the phone's permissions were perfect, and the app's own logs were empty. The only
evidence was a single `W/` line in logcat.

When a chain of systems all claim success but the result is missing, the failure is in a **handoff
nobody logs**. Instrument the seams, not the components — which is what §2.3 and §2.4 are.

Related: `AGENTS.md` ("Every headless registration must be imported from `index.js`") and
`docs/APP_SERVER_PARITY.md`.

## 5. Native notification package ownership

`src/services/notifications/nativeNotificationAdapter.ts` is the only production module allowed to import
`react-native-notify-kit` (currently pinned to `10.4.8`). It owns the small native surface Gator uses: channel and
permission calls, display/trigger/cancel operations, foreground/background event registration, and the cold-start
notification lookup. `notifeeService.ts` continues to own Gator's domain policy and serialized mutation queue; UI,
features, and headless handlers consume the owned adapter instead of the package singleton. The ESLint boundary covers
the package root and every subpath across `index.js`, `app/`, and `src/`, including static, dynamic, and CommonJS
imports.

Keep `index.js` importing `backgroundEvents` before `expo-router/entry`. Passing registration through the adapter does
not make route-time registration safe: the background callback must still reach notify-kit during bundle-entry
evaluation.

**Body-tap occurrence ownership (2026-09-30 source fix):** the pinned
`patches/react-native-notify-kit+10.4.8.patch` mints one `pressOccurrenceId` at native body-press
receipt, outside `notification.data`. A process UUID plus atomic increasing sequence is shared by
the PRESS event and sticky initial event; Kotlin explicitly forwards it to foreground/headless
JavaScript. The Activity-intent fallback stays tokenless. A second real press on an identical
notice gets a new sequence, not a permanently suppressed chat/payload identity.
`pendingNav` reserves before background route lookup and before the foreground task is queued.
Initial, pending and foreground paths share one leased navigation claim, reject delayed consumed
copies, and let a newer press fence an older held lookup. A failed current lookup remains retryable.
Disconnect drops data/claims while retaining the known retired sequence floor. Tracking is
constant-sized and no identity is logged or persisted. Malformed/tokenless handoffs fail closed;
this source therefore requires a clean native replacement build containing the saved patch.
Focused host/source-contract checks do not prove Android bridging or fix the installed Play v79;
the exact cold-tap/Back/Home/launcher-resume device check remains under `FEAT-05B`.

Before a notify-kit upgrade, verify all of the following against the pinned Expo/RN versions and an Android build:

- maintained release/security posture, license continuity, React Native New Architecture support, and no unresolved
  upstream regression affecting APIs Gator uses;
- permission state/request behavior and app/per-chat channel creation, deletion, and settings handoff;
- foreground action/body events, background/headless actions, killed-start `getInitialNotification`, and pending-tap
  navigation after App Lock;
- displayed/trigger/all/targeted cancellation truth, trigger scheduling, messaging-style rendering,
  absence of FaceTime call channels/actions, and continued absence of `USE_FULL_SCREEN_INTENT`.

Replace the package behind the adapter when it becomes incompatible with the pinned Expo/RN toolchain, loses a safe
maintained release path, develops an unresolved security/licensing problem, or cannot meet the lifecycle/cancellation
matrix above. Host mocks and the import boundary prove ownership, not Android delivery or cancellation timing; those
remain exact-device evidence.

## 6. Bounded per-chat message history

Ordinary message notifications use one Android `MessagingStyle` notice per chat. The notification mutation queue owns
the complete native read-merge-post operation, so concurrent deliveries cannot overwrite one another. A pure merge
keeps the newest six lines, replaces duplicate local message ids deterministically, and ignores a delayed delivery
that has already fallen outside the retained window instead of alerting again.

The schema-2 native payload stores only the parallel opaque local SQLite message ids. Server message GUIDs, chat GUIDs,
addresses, and sender handles do not enter that routing data. Existing native history is adopted only when its owner,
schema, chat id, line count, local-id list, and `MessagingStyle` shape all validate exactly; malformed state is never
merged.

Delete and retraction events resolve the target to its local id and rebuild the notice without only that line. A read
event still clears the whole chat. If Android cannot enumerate safe history, the adapter cancels the chat notice; if
Android rejects a withdrawal rebuild, it cancels the original notice before reporting the failure so withdrawn text
is not knowingly left visible. These are host-verified contracts. Foreground/background/killed-process ordering and
rendering still require the `NOTIF-03D` Android candidate matrix.
