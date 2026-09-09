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
2. `FEAT-03B` preserves bounded `partCount`, normalized exact part topology, attachment ownership,
   and associated-message part identity through live ingestion, sync, persistence, and retry. Migration
   `0047_message_retraction_topology` stores that durable evidence. Parse exactly one outer `p:<n>/`
   or `bp:<n>/` prefix and preserve a normalized received reply/reaction part. Complete topology is
   authoritative; malformed or incomplete topology fails closed, and only a proven older server may
   use the narrow legacy part-zero compatibility rule. Replies, reactions, edits, unsend, supported
   iMessage contact-card replies, local scheduling, optimistic rows, and retry payloads carry the resolved target. A
   shared classifier uses complete topology to preserve only proven surviving text and attachments across
   bubbles, inbox/search, notifications, and attachment-cache ownership. RCS reactions may use part
   zero only for a proven whole `rcs-*` message; that exception must not enable RCS reply threading,
   edits, or unsend.
3. `FEAT-03C` sends one attachment plus its text only behind the matching chat-service capability,
   with one logical optimistic/retry identity and truthful disablement on older servers. RCS and
   iMessage capabilities remain independent: support for one service must never be inferred for the
   other, and authored text/attachment/reply state stays in the composer until durable queue admission.

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
3. `FEAT-05C` adds server-assisted global-inbox search only behind an explicit capability. The
   server returns one fixed newest-50 page of nondeleted, nonretracted, non-overlay iMessage/SMS
   text with stable message and chat GUIDs; partial chat.db schemas fail closed. The app shows its
   encrypted local results first, persists valid Mac hits before navigation, rereads them through
   local visibility rules, and merges by message GUID with the local row winning and a deterministic
   newest-first order. Network failure and older servers remain local-only. Account retirement must
   abort pending work and immediately conceal settled results. Visible copy must distinguish local,
   searching, combined, and unavailable states and clarify that Mac search covers iMessage/SMS while
   locally stored RCS matches may still appear. Device sign-off must cover a Mac-only hit, duplicate
   identity, result navigation, offline/old-server fallback, account replacement, and latency against
   a realistically large Messages database.

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

The selected first-release surface is the first-run setup journey under `app/(setup)`. Keep English as
the required source catalog and access it through the typed boundary in `src/utils/i18n.ts`. A contributor
adds or changes the English key in the same change as its screen, formats numbers separately, and never
passes names, message bodies, server errors, URLs, credentials, or other runtime data through a pseudo-text
transform. Technical tokens may use an explicitly reviewed non-transforming catalog entry when altering the
token would make a test unsafe or misleading.

Catalog keys are stable identifiers once released. Rename or delete one only with every call site in the same
change; backports add keys rather than repurposing an existing key with unrelated meaning. A future translated
catalog must declare its supported locale and plural behavior alongside the English key set, and CI must reject
missing or extra keys before that locale is advertised. Until then, unsupported locales deliberately use English
text with locale-aware number formatting.

`en-XA` provides deterministic accenting plus at least 30% proportional expansion of each nonempty catalog literal;
`ar-XB` provides mirrored catalog text plus an RTL direction signal. These are development audit tools, not advertised
translations. Each converted screen must be checked for pseudo text without transforming runtime values; the
release-level task additionally requires native RTL layout, long-string/dynamic-font review, and screen-reader proof
on Android.

`FEAT-08A` extracts the Syncing screen's prose and fixes its English `1 chat` / `1 message` grammar. `FEAT-08B`
extracts Manual Connection's fixed prose while keeping its URL/scheme tokens, typed credentials, and live session
error outside pseudo transformation. `FEAT-08C` extracts the Connect choice screen and preserves both accessible
navigation actions. Manual and Connect interpolate a reviewed exact `Gator Server` value while transforming only the
surrounding pseudo sentence. `FEAT-08D` extracts normal and DEV-only Welcome copy, with the Gator brand kept exact when
its surrounding recovery sentence is pseudo-localized. `FEAT-08E` extracts Permissions route copy and adds fail-closed
placeholder formatting: pseudo-locales transform only literal catalog segments while app-name and locale-formatted
count replacements remain exact. `FEAT-08F` extracts Scan's route-owned copy while treating raw QR credentials plus
session errors as untransformed data. Its parser now emits one of four typed codes plus a fixed non-presentational
message; Scan maps those codes exhaustively and never reads parser prose or passes raw QR data into formatting. Its
paired builder also emits a typed fixed error rather than English presentation prose. All six routes are host-green
foundations. `FEAT-08G` extracts the shared Contacts rationale/recovery/settings helper used by setup, Settings, and
Send Contact; each operation resolves one current locale while preserving its session fences. `FEAT-08H` makes
`en-XA` a meaningful deterministic long-string stress tool and applies the resolved direction to the safe-area app
root once per mount, covering route and non-route content without persistent `I18nManager` mutation. Exact Android
Hermes pseudo-locale activation, native-stack/camera/modal/TextInput RTL behavior, maximum-font-scale layout, and
TalkBack reading order remain device-only evidence and keep the parent open.
