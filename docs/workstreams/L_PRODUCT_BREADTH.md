# Workstream L — product breadth after reliability

> **Document role:** This file owns stable implementation design and sequencing for Workstream L.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker. These are
> independently selected backlog items, not permission to start one broad feature wave.

<a id="feat-01"></a>

## `FEAT-01` — persisted inbox filters

Support unread, group/direct, muted, service, and known/unknown dimensions as optional predicates in
the paged database query. Persist the selected filter intentionally and leave the shared visibility,
tombstone, unread-floor, preview, and page-completeness rules unchanged.

<a id="feat-02"></a>

## `FEAT-02` — in-chat search and safe entities

Deliver this as two independent slices:

1. `FEAT-02A` searches every qualifying message already stored in the encrypted local database for
   the open chat. Use newest-first keyset pages, a fixed per-search row-id fence, exact message
   identity for navigation, and the message renderer's overlay/deletion/retraction policy. Search
   mode preserves the mounted composer, disables conflicting message actions, and highlights each
   selected result. Closing search returns to the live newest window before restoring the composer.
   It does not claim to find history that still exists only on the Mac/server.
2. `FEAT-02B` extends entity detection only through conservative parsing and explicit scheme/action
   allowlists so a false positive cannot invoke an unsafe target. The bounded pure parser recognizes
   only validated explicit `http(s)` URLs, strongly formatted phone numbers, and real calendar dates
   with a four-digit year. Bare domains/digit runs, extensions, slash/relative dates, email,
   addresses, tracking numbers, flight numbers, and ML extraction remain deliberately inert. Web
   targets are revalidated before the existing scheme guard; phone actions construct only canonical
   `tel:`/`sms:` targets; dates open a fixed Android all-day calendar draft that the user must save.
   Copy is the only other entity action. No peer-controlled value can choose a scheme, intent action,
   calendar URI, or calendar metadata field.

<a id="feat-03"></a>

## `FEAT-03` — multipart and unsupported messages

Preserve and resolve message-part identity for replies, reactions, edits, unsend, live ingestion,
sync, and retry reconciliation. Unsupported interactive balloons render a safe inspectable fallback
instead of a blank bubble; text-plus-attachment sending remains capability-gated.

<a id="feat-04"></a>

## `FEAT-04` — custom folders and groups

Provide CRUD, stable ordering, add-then-prune membership replacement, unread policy, backup, privacy,
and disconnect behavior. Membership and order must survive restart, resync, and restore without an
observable empty intermediate state.

<a id="feat-05"></a>

## `FEAT-05` — isolated messaging additions

Treat send-location, camera video, notification grouping beyond owned history, and server-assisted
search as separate child tasks. Each selected slice needs its own capability gate, optimistic/error
path, disablement boundary, and device sign-off; never bundle them into one release.

<a id="feat-06"></a>

## `FEAT-06` — unified service/contact identity research

Define when iMessage, SMS, and RCS handles represent one person without merging distinct conversations
or breaking server GUID identity. Resolve normalization, ambiguity, split/merge, backup, privacy,
pagination, and bounded bulk contact/handle bootstrap in an approved cross-repository ADR before any
schema or UI implementation.

<a id="feat-07"></a>

## `FEAT-07` — shared documents and media viewers

Implement as three independent slices:

1. `FEAT-07A` provides a bounded, privacy-safe shared-documents explorer with explicit download/open
   state.
2. `FEAT-07B` adds fullscreen media secondary actions after a visible on-demand download.
3. `FEAT-07C` makes a separate in-app PDF-viewer decision based on privacy, offline behavior, package
   surface, malformed/large files, and accessibility.

Reuse the existing safe URI, transfer, and external-open boundaries.

<a id="alias-send-01"></a>

## `ALIAS-SEND-01` — per-send alias selection

Define and capability-negotiate the server/helper request field and allowed-alias validation first.
Only then expose a Composer choice that belongs to one logical send and survives retry/reconcile; keep
it separate from the account-wide active-alias setting. Unsupported servers show no inert control.

<a id="feat-08"></a>

## `FEAT-08` — internationalization foundation

Extract the selected user-facing strings, use locale-aware dates, numbers, and plurals, define a
translation/versioning workflow, and audit RTL, long strings, layout, and screen-reader output before
claiming multilingual support.
