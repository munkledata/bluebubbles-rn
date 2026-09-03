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

The first slice uses one choice per axis: all/unread; all/known/unknown; all/direct/group;
all/unmuted/muted; and all/iMessage/SMS/RCS. Apply persists one versioned account-local selection;
Cancel writes nothing, and Reset clears the draft before Apply. Known means at least one participant
matches a device contact, group/direct follows the authoritative chat style with participant-count
fallback, muted means the existing exact `mute_type = 'mute'` state, and service matches the same
GUID/participant-service resolver used by conversation tiles. Every predicate must constrain pinned
and unpinned identities before the page limit. Filters affect only the main inbox, not unified search
or the fixed Archived/Unknown Senders routes. The older Filter Unknown Senders preference keeps its
separate notification policy and temporarily locks this sheet to known senders. Applying while locked
clears the hidden FEAT-01 sender choice to All; Cancel preserves it. Hide manual pin reordering whenever
these filters can conceal an intermediate pin.

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

Deliver this as three independent slices:

1. `FEAT-03A` preserves a bounded Messages extension identifier and replaces only otherwise blank
   balloons with fixed local labels across bubbles, replies, threads, notifications, and inbox
   previews. Text, subjects, ordinary attachments, and actually rendered URL cards take precedence.
   Raw bundle identifiers are never displayed or opened, and extension payload attachments remain
   hidden even when a lean notification omitted their hidden flag.
2. `FEAT-03B` preserves bounded `partCount` and associated-message part identity through live
   ingestion, sync, persistence, and retry. Parse exactly one outer `p:<n>/` or `bp:<n>/` prefix;
   strip the helper's legacy `bp:<guid>` attachment wrapper while keeping its part unknown; unknown
   identity stays distinct from the real part zero. For an aggregate bubble, resolve the
   common attachment-caption text part from the visible attachment count only when `partCount`
   proves that index exists; otherwise retain the legacy part-zero fallback. Replies, reactions,
   edits, unsend, local scheduling, and retry payloads carry that resolved part. Reaction removal
   prefers the part stored on the user's active reaction, and aggregate display keeps the newest
   same-sender/kind reaction without discarding its removal target. Until the server exposes stable
   normalized per-part topology and incoming reply-part identity, this remains a compatibility path
   rather than proof of every Apple multipart layout. Unsend requests target the resolved part, but
   local presentation intentionally keeps the existing aggregate tombstone: partial visual
   preservation also affects inbox eligibility, search, notifications, and attachment-cache
   ownership, so it needs one later shared classifier backed by live topology evidence.
3. `FEAT-03C` adds text-plus-attachment sending only behind an explicit negotiated capability with
   one logical optimistic/retry identity and truthful disablement on older servers.

<a id="feat-04"></a>

## `FEAT-04` — custom folders and groups

Provide CRUD, stable ordering, add-then-prune membership replacement, unread policy, backup, privacy,
and disconnect behavior. Membership and order must survive restart, resync, and restore without an
observable empty intermediate state.

<a id="feat-05"></a>

## `FEAT-05` — isolated messaging additions

Implement these as three independent slices:

1. `FEAT-05A` is blocked until a negotiated server transport can actually send the location
   attachment. The current server intentionally rejects iMessage attachment upload after retirement
   of the Private API helper, and its supported AppleScript fallback sends text only. Until that
   capability exists, expose no Location action and add no location permission or dependency. Once
   available, current-location sending must use an explicit foreground permission and one bounded,
   user-initiated location attachment, with truthful denial/cancellation/error states and no
   background location collection.
2. `FEAT-05B` groups only current, owned, ordinary Android message children under one fixed group.
   Two distinct valid chats first create one fixed, generic, non-alerting summary with the
   count-neutral body `New messages`; it alerts through its children only and opens the inbox without
   storing a chat/message identifier or opening the encrypted DB. Once created, retain the summary
   through a one-child tail and cancel it only when successful native enumeration proves the fixed
   group contains no raw child, because Android cascades summary cancellation to every grouped
   child. Any raw same-group child, including one rejected by strict ownership/schema parsing,
   therefore blocks cancellation; repair an existing stale or malformed fixed summary in place.
   Exclude locked/status, reminder, FaceTime, failed-send, RCS, test, alias, foreign, duplicate, and
   malformed notices from valid-child counting. Reconcile through the existing native-operation
   queue after posting, withdrawal, read/cancel, native child removal, startup inspection, and warm
   unlock. Never rewrite a detailed child from a cached native snapshot; pre-feature children adopt
   grouping only when a fresh message naturally replaces their stable id. While App Lock is
   effective or its persisted state is unknown, inspect/rebuild nothing and repair after unlock.
   Enumeration failure performs no group mutation: preserve children and summary and leave durable
   delivery able to retry.
3. `FEAT-05C` adds server-assisted search only behind an explicit capability, merges it with local
   results under one bounded identity/order contract, and labels the searched scope truthfully.

Each slice needs its own capability or permission boundary, error path, disablement boundary, and
device sign-off; never bundle them into one release. Fresh camera-video capture is deliberately out
of scope by owner decision: keep the existing Camera action photo-only without changing
gallery-video selection, sending, receiving, or playback.

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
3. `FEAT-07C` is **DONE as a product/architecture decision**: Gator will not add an embedded PDF
   renderer, WebView/PDF.js bridge, or remote conversion service. An explicit tap keeps using the
   existing bounded local download and Android external-viewer boundary; a fast no-viewer rejection
   falls back to the system share sheet, followed by visible no-handler feedback when neither path
   is available.

Reuse the existing safe URI, transfer, and external-open boundaries.

The accepted `FEAT-07C` boundary is:

- **Privacy and trust:** Gator does not parse attacker-controlled PDF bytes. It grants a selected or
  default viewer temporary read-only access to one exact FileProvider URI; on fallback, the chosen
  share target receives equivalent read access. Either third-party app can then read, copy, cache,
  or upload the plaintext document; Gator's App Lock, Secure Screen, and Recents policy no longer
  control presentation in that app.
- **Offline behavior:** Once the file is downloaded, Gator needs no network service to hand it off,
  but offline viewing works only when an installed viewer itself works offline. The share sheet is
  not an offline-viewing guarantee.
- **Large files:** The existing manual download streams to app-private storage with the current
  512 MiB and 15-minute hard limits. New manual downloads exceeding either bound are rejected; the
  external viewer owns rendering memory and performance for files that reach handoff.
- **Malformed or encrypted files:** Gator makes no validity or password-support claim and cannot
  reliably observe a parse failure after another app accepts the intent. The selected viewer owns
  rejection, password UI, and any document-specific recovery.
- **Accessibility and package surface:** Gator adds no parser dependency, native configuration,
  license surface, or renderer-specific UI. Gator remains responsible for its download/open action
  and system handoff; document-reading semantics, zoom, reflow, and TalkBack quality depend on the
  installed viewer.

This decision closes no Android release checkbox. Exact-candidate FileProvider/ACTION_VIEW behavior,
offline opening, cache-loss re-download, natural no-viewer fallback, large/encrypted/malformed files,
URI-grant behavior, dynamic font, and TalkBack focus/announcement remain device evidence under the
parent `FEAT-07` task.

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
