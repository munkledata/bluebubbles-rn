# Workstream E — session isolation, connection state, and notifications

> **Document role:** This file owns stable implementation design and sequencing for Workstream E.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="rel-003"></a>

## `REL-003` — one session-scoped reset boundary

Centralize reset behavior for every process-memory value derived from the connected account. This
includes TanStack Query data, Find My and RCS state, typing state, FaceTime state, realtime router and
deduplication state, and active upload/download state. Keep genuinely device-global preferences out
of this reset boundary.

Implement the boundary in this order:

1. `REL-003A` inventories account-scoped memory and defines the session identity/epoch contract used
   by reset adapters.
2. `REL-008` exposes the realtime reset adapter before the coordinator imports or registers it.
3. `REL-003B` installs the remaining adapters and the single reset coordinator.
4. `REL-005A` establishes the teardown barrier that prevents active work from racing the reset.
5. `REL-003C` proves an A → Disconnect → B transition across the complete inventory.

Reset adapters should be exception-isolated so one cleanup failure cannot prevent unrelated state
from being retired. Disconnect must revoke the old session before observers or asynchronous work can
publish again. Navigation remains derived from session state rather than being driven directly by a
service.

<a id="rel-008"></a>

## `REL-008` — session-safe realtime ownership

After the base realtime lifecycle and session identity contract exist, bind each router,
deduplication cache, and injected sink to one session generation. Replacing a session retires those
objects and clears any credential or header snapshot they retain.

Every dispatch source must be explicit: FCM uses `fcm`, while development push and development typing
use `dev`. URL-change handling must await its injected effect so ordering remains visible to the
caller. Preserve the rule that a failed sink releases its deduplication claim, allowing a legitimate
redelivery instead of suppressing it permanently.

`REL-008` lands before `REL-003B`; the reset coordinator consumes the adapter exposed here and must not
create a circular dependency back into realtime composition.

<a id="rel-004"></a>

## `REL-004` — reject results owned by a retired session

Implement late-result protection in three slices:

1. `REL-004A` carries session identity in remote query keys and establishes the reusable token/epoch
   checks.
2. `REL-004B` applies those checks to server, store, and presentation results.
3. `REL-004C` applies them to transfers, realtime work, background work, and native effects.

Capture the owning session before starting server-info reads, Find My work, background work, URL
rotation, uploads, sharing, saving, opening, or any other long operation. Check that ownership again
before publishing UI/store state, writing the database, presenting a native effect, or changing a
credential. Account-scoped work must be tracked before its first asynchronous boundary so Disconnect
cannot miss it.

This work follows `REL-003B`: a late-result check needs the same identity and revocation contract as
the reset coordinator.

<a id="rel-005a"></a>

## `REL-005A` — bounded session teardown barrier

The teardown barrier covers active text sends, uploads, retries, diagnostic uploads, remote queries,
background recovery, and timers. Its fixed order is:

1. revoke the old session and stop authorizing new work;
2. prevent new account-scoped operations from registering;
3. cancel and await already tracked work, subject to a bounded deadline;
4. clear query caches and transient process state;
5. invoke the separately owned persistent wipe; and
6. return only after the barrier's obligations have settled.

Operations that outlive the deadline remain unable to publish because their session generation has
already been revoked. Native transfer handles must remain trackable until their exact terminal
promise settles so a later cleanup pass can retry cancellation. A send already accepted by the
server is outside the client's cancellation guarantee.

Keep persistent database, file, log, and system-owned wipe logic in `REL-005B`; this slice coordinates
with that owner without absorbing it. `REL-005A` follows `REL-003B` and `REL-004`, and its cross-account
proof is required before `REL-003C` can close the parent reset work.

<a id="conn-01"></a>

## `CONN-01` — truthful transport health

Authentication answers whether credentials are configured; it does not prove that the server is
reachable. Maintain a separate, generation-fenced transport state machine with
`idle`, `connecting`, `connected`, `reconnecting`, `offline`, and `error` states.

Socket lifecycle, serialized HTTP reachability, and native network signals feed that state machine.
Retired callbacks cannot publish into a later lifecycle. Present degraded health consistently in a
compact global surface and Settings, and route Retry through the realtime owner so it reuses the
approved transport, fences the old socket, and starts an immediate probe without touching the
database. Full-screen overlays must remain visually above the global health surface.

<a id="notif-01"></a>

## `NOTIF-01` — suppress redundant active-chat alerts

Use a plain, headless-safe process owner to identify the exact chat that is focused while the app is
foregrounded and unlocked. Navigation focus and `AppState` update the owner; stale blur, account
reset, or route callbacks must not clear or republish a newer claim.

Immediately before native presentation, suppress sound, vibration, and heads-up behavior only for
that exact visible chat. Preserve normal delivery for another chat, background and killed-process
execution, and App Lock's generic path. Gate live read markers by the same route-focus rule so a
mounted chat hidden beneath another route cannot mark new content as read. Any optional in-chat sound
policy remains explicit and separate from system-notification suppression.

<a id="notif-02"></a>

## `NOTIF-02` — preserve notification privacy without configurable redaction

Normal message and reminder notifications use the detailed policy, with Android controlling
lock-screen presentation. Keep App Lock's generic new-delivery path independent of the removed
Redacted Mode setting.

Retain schema-2 opaque routes, cleanup of legacy raw GUID/payload/channel data, account-owned queue
and drain guards, and generic repair for a missing durable reminder trigger. Maintenance may preserve
or repair an already generic notice, but it must not rewrite a current detailed notice merely because
startup ran. Inspection or cleanup uncertainty fails closed rather than exposing legacy data.

<a id="notif-03"></a>

## `NOTIF-03` — bounded per-message notification history

Implement message history in four slices:

1. `NOTIF-03A` defines the pure bounded merge model and opaque local identifiers.
2. `NOTIF-03B` serializes each native read–merge–post operation.
3. `NOTIF-03C` withdraws or replaces only the affected message line and handles legacy history.
4. `NOTIF-03D` proves concurrent delivery and withdrawal behavior on Android.

Keep only a small ordered history for each chat and apply the active notification privacy policy to
every line. Concurrent deliveries must not lose entries. Delete, retract, or failed-send withdrawal
removes only the matching line; a read event may still cancel the whole chat notification. Malformed
native history fails closed, and a failed replacement must not leave retracted text visible. A late
delivery that has already fallen outside the bounded history must not re-alert unchanged content.

## Workstream sequencing

Session identity and reset ownership come first: `REL-003A` → `REL-008` → `REL-003B` → `REL-004` →
`REL-005A` → `REL-003C`. Transport presentation consumes those ownership rules but does not replace
them. Notification slices reuse the same account, lifecycle, and headless boundaries; persistent
database/file/log/system wipe ownership remains in `REL-005B` rather than moving into this workstream.
