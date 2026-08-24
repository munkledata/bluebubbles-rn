# Session-scoped state inventory

- **Owner:** `REL-003A`
- **Host baseline:** 2026-08-24, post-v56 source
- **Release status:** Host inventory complete; Android A→Disconnect→B proof on a future candidate
  containing this post-v56 work remains open.

This is the counting inventory for process-memory state that could otherwise carry server/account A
into account B. It covers `src/state`, shared UI stores, TanStack Query, and mutable module/service
singletons. Immutable constants and component-local values that are destroyed with the connected
route tree are excluded. Their delayed effects are still covered below at the service boundary.

## Session identity contract

Two monotonic identities have different jobs and must not be replaced by an origin comparison:

| Identity | Owner | Rule |
| --- | --- | --- |
| Foreground session epoch | `src/state/sessionStore.ts` | `hydrated`, `connected`, and `reset` mint a new epoch. Work that belongs to a particular foreground session captures it before its first await. Reconnecting to the same URL still produces a different epoch. |
| Account-delivery generation | `src/services/realtime/deliveryCoordinator.ts` | A lease is valid only if it was captured while admission was open and its generation remains current. `pauseRealtimeDeliveries()` closes admission and increments the generation synchronously; `resumeRealtimeDeliveries()` opens only the new account. |

The durable authority is the correlated SecureStore tuple plus the independent revocation marker.
Disconnect closes the in-process generation and writes the marker before calling store/native
observers. Account B is not admitted until the published cleanup succeeds. A timeout or cleanup
failure keeps the marker closed and forces a complete retry.

Use the foreground epoch for a UI/session instance, a delivery lease for work that can cross an
await or enter DB/native code, and the delivery generation in remote query keys. Never use the
server origin as identity: A can disconnect and reconnect to the byte-identical URL.

## Synchronous reset coordinator

`resetSessionScopedState()` retires these surfaces in order. Each adapter is exception-isolated:
one throwing Zustand subscriber is reported, every later adapter still runs, and `forget()` blocks
account B while it completes the rest of the wipe.

| Surface | Private/account value | Retirement owner |
| --- | --- | --- |
| Error-report capture ring/timer | Account diagnostic events | `errorReportSink.resetSession()`; returns the already-entered DB drain |
| Find My store | Devices, people, items, locations, error/loading state | Store reset plus its own generation check |
| Typing store | Chat GUID flags and TTL timers | Store reset clears values and cancels timers |
| Pending notification navigation | Resolved account-local route | `resetPendingNotification()` |
| Auto-download toast batch | Count and destination for old-account media | `resetAutoDownloadToastBatch()` cancels the timer |
| FaceTime store | Call link, chat GUID, caller identity | Store reset increments its generation and clears both overlays |
| RCS health store | Previous server alert and timestamp | Store reset |
| Sync store | Banner state, counts, and server error | Store reset; sync continuations also check epoch/lease |
| Upload store | Chat GUID, filename, and byte progress | Store reset; upload registry cancellation happens first |
| Download store | Attachment GUID status/progress | Store reset; native observer delivery is generation-guarded |
| Dialog store | Private copy and queued callbacks | Store reset clears current dialog and queue |
| Toast store | Private copy and queued toasts | Store reset clears current toast and queue |
| TanStack Query | Server/account responses and local search results | `queryClient.clear()` destroys active entries and cancels their public fetches |

`sessionStore` is intentionally outside that import graph. `runForget()` resets it immediately
after the coordinator so navigation remains derived from session state. Its origin, password,
server info, and errors are cleared, and its epoch increments.

## Account-owned service state retired outside the store coordinator

| Service surface | Mutable state | Boundary that prevents A→B reuse |
| --- | --- | --- |
| `bootstrap.ts` | Connect/forget single-flight slots, epochs, and late-operation quarantines | Transition coordinator state contains no rendered account payload; B joins or fails closed behind every prior cleanup |
| Realtime delivery coordinator | Admitted work and generation-invalidation listeners | Admission closes synchronously; listeners retire; admitted commits drain before the wipe |
| `realtimeControl.ts` and `SocketService` | Socket, router/sink/runtime, pending recovery keys, retry timers/error throttle, credential/header snapshot | `setSocket(null)` disposes the runtime/router/sink; terminal socket disconnect retires native closures and scrubs the retained origin/password/options; same-session escalation retains only the current snapshot; recovery keys include generation |
| Server-rotation coordinator | Pending/in-progress candidate URL and approval state | Subscribes to generation invalidation and retires synchronously on Disconnect |
| FCM intake | FIFO admission tail and occurrence sequence | Every callback reserves a tracked delivery lease before its first await; the durable session/marker gate is re-read headlessly |
| Sync control | Foreground/background/auxiliary flights and resume throttle | Main slot is session-epoch keyed; all writer slots are drained; every phase checks epoch plus account lease |
| Contacts sync | Permission/contact promise coalescer | Slot is generation keyed; each account DB statement and shortcut refresh uses the captured lease |
| Upload control | FIFO gate and registered native cancel handles | Handles register before the first await; Disconnect cancels all; enclosing account work remains tracked |
| Download services | Generation/GUID flights, RCS retry timers, active bounded native transfers | Flights and retry keys include generation; invalidation cancels timers; native transfers are cancelled/drained; final commits re-check the lease |
| Attachment-cache recovery/coordinator | Recovery queue/readiness, reservations, retirements, protections | Readiness is invalidated before reset; DB/native work carries account scope; paths include generation; stale commits fail closed |
| Synced backgrounds | Per-chat queue, quota timer, revision/work counters | Requests and commits carry a lease; destinations include generation; late files are deleted rather than published |
| Scheduled/edit/send queues | DB/generation recovery slots and per-message mutation tails | Persistent claims are account scoped; UI mutations capture a lease; teardown drains admitted send work |
| Error-report upload/purge | Abort controller, upload/purge flights, consent generations | Disconnect retires the sink; generation invalidation aborts transport; DB work is guarded and drained |
| Notifications | Serialized native-operation tail and displayed account notifications | Operations remain ordered; Disconnect clears displayed notifications before B and blocks B if native cleanup is unconfirmed |
| Notification route slot | One pending navigation payload | Cleared by the synchronous coordinator; schema-2 routes resolve through the current DB |
| Reachability watcher | Interval, in-flight probes, and last reachability bit | Stop increments a watch generation as well as clearing the interval; late A promise continuations cannot change B's bit or invoke either callback |
| Search-text backfill/database control | DB-open flight and generation-keyed backfill flights | The DB connection is process-global; account backfill writes carry a delivery lease; the DB contents are wiped and residue-checked |
| Diagnostic logs | Memory ring, persistent initialization, disk file | Capture ring resets early; memory and disk logs clear last; B remains blocked on unconfirmed disk cleanup |

The process-global DB handle, native module installations, boot coordinator, and worker registrations
are retained intentionally. They are infrastructure, not account payload. Work started through them
still has to acquire the current durable/session authority shown above.

## Deliberately retained device-global state

| Surface | Why it survives Disconnect |
| --- | --- |
| Feature settings and error-reporting consent | User/device choices stored in the encrypted preference table; guarded hydration prevents an old run from publishing late |
| Sync settings | User-selected initial-history cap, not server data |
| Theme/custom-theme store | User-created device appearance; no server response is stored here. Its asynchronous reload helper has no production account-transition caller; any future account-derived use must add an epoch check |
| App Lock store | Device policy and current lock gate |
| Share-intent store | Device-originated handoff must survive the unauthenticated gate until a recipient is chosen; public ACTION_SEND intake remains disabled |
| Notification channel promises/app avatar | Android application configuration, not message/account content |
| URL-preview request dedupe | Public URL-to-public-metadata promise only; it carries no Gator credentials and the production preview hook is read-only under `NET-00` |
| Global error-handler/logger installation flags | One-time process wiring; account log payloads are reset/cleared separately |
| Reduced-motion listener set | Android accessibility preference observers only |

## Query inventory

- Server Management, Server Health, and iMessage Account queries include the account-delivery
  generation in their keys and reject stale results before publishing or mutating the cache.
- Chat search reads the local encrypted DB and uses a term-only key. Disconnect destroys its Query
  entry. The focused same-key A→B regression proves a non-abortable A query settling after B cannot
  replace B's value.
- Find My does not use TanStack Query; its store owns an independent reset generation, including the
  case where a new B refresh finishes before A's old promise.

## Verification and remaining boundary

Focused host evidence is in `test/services/sessionScopedState.test.ts`,
`test/services/forget.test.ts`, `test/services/reachability.test.ts`, and
`test/realtime/socketAuth.test.ts`, with supporting same-origin epoch, realtime-generation,
reconnect-escalation, transfer, contacts, sync, notification, and background-work suites in their
owning test files. The 2026-08-24 post-v56 focused gate passed 5 suites/107 tests, TypeScript,
targeted lint/format, and the 1,301-entry DB-write inventory guard. This proof is compositional; it
does not replace the end-to-end device journey below.

Host tests do not prove React Navigation/native windows, Android process reuse, SecureStore,
filesystem, notification tray, or native transfer behavior. The synthetic account-A → explicit
Disconnect → account-B journey in `docs/DEVICE_VERIFICATION_CHECKLIST.md` remains open by owner
choice and must use a future Android candidate containing this post-v56 work; therefore parent
`REL-003` remains `IN_PROGRESS`.
