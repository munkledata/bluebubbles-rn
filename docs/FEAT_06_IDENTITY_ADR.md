# ADR: Service-scoped conversations with non-owning contact metadata

- **Status:** Accepted — approved by the product owner on 2026-09-26
- **Decision date:** 2026-09-26
- **Owner:** Gator product owner and maintainers
- **Scope:** `FEAT-06` across the Android app, Gator server, and Google Messages RCS sidecar

## Owner boundary

Contact matching must never combine message histories. In particular:

- two phone numbers remain two conversations even when both belong to one contact;
- Google Messages remains separate from Apple Messages, whether Google's current transport is RCS
  or its own SMS fallback;
- the same phone number on different services remains separate when the server supplies separate chats; and
- a shared contact may contribute only non-owning metadata such as a name, photo, search hint, or
  unambiguous known-contact classification.

This decision rejects the historical proposal to fold same-contact iMessage and SMS conversations into one thread.
It also rules out a person-level timeline, person-level unread state, and service fallback that silently changes the
selected conversation.

## Context

This section records the 2026-09-26 audit baseline. Later completion-evidence sections supersede its
implementation-status statements without changing the decision.

At that checkpoint, the app already had useful separation boundaries:

- a chat row is unique by the exact server chat GUID;
- a handle row is unique by exact address plus service;
- RCS chats used the legacy `RCS;-;<conversationID>` form and RCS messages used
  `rcs-<messageID>`; the later provider-epoch slice replaces those app-facing forms with
  epoch-qualified identities; and
- device contacts write display names, photos, and a local contact reference onto handles without owning chat rows.

Those foundations do not yet justify a broader identity feature. The audit found several unsafe inputs and shortcuts:

- the server's existing bulk handle endpoint removes an RCS handle when an Apple handle has the same address;
- the RCS sidecar's participant string may be a display name, formatted number, or opaque participant id, so it is
  not a stable address identity;
- contact matching and legacy/RCS existing-chat lookup use a last-ten-digits phone key;
- ambiguous contacts currently select an arbitrary presentation winner;
- a repeated message GUID can currently move the stored message to another chat; and
- some reply, reaction, sticker, and thread reads trust a referenced message GUID without also proving the owning
  chat.

The app does not currently use the unsafe bulk handle endpoint to combine transcripts. These are nevertheless hard
requirements for any future identity bootstrap and targeted hardening requirements for the existing ingestion/read
paths.

## Decision

### 1. Keep four identities separate

| Identity         | Authoritative key                                                                              | Permitted use                                                                                    | Never permitted                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Conversation     | Current account data realm + provider + required provider epoch + exact source conversation id | Transcript ownership, navigation, read/unread, drafts, mute, pin, deletion, folders, send target | Contact-based grouping or cross-provider aliasing                                            |
| Endpoint         | Explicit provider + transport + complete validated phone/email/opaque endpoint                 | Recipient selection and exact-service lookup                                                     | Last-ten-digits routing or inference from a display name                                     |
| Contact metadata | Device-local contact source plus an unambiguous endpoint match                                 | Name, photo, search hint, user-selected known-contact filtering, and links to separate chats     | Transcript/message ownership, routing, backup matching, deduplication, or send authorization |
| Message          | Owning conversation + exact source message id                                                  | Message/reply/reaction/attachment ownership                                                      | Cross-chat reparenting or content/time-based deduplication                                   |

The current database may retain a globally unique message-GUID column. That storage shortcut is acceptable only when
ingestion enforces immutable chat ownership and provider namespace. It is not permission to move a message between
conversations.

### 2. Preserve every conversation boundary

- Different phone numbers never share transcript or conversation state.
- Google Messages never aliases an Apple Messages chat, including Apple SMS for the same number.
- A Google RCS conversation and a Google SMS conversation on different numbers remain separate; only an unchanged
  Google source conversation id in the same provider epoch can retain one history across a transport fallback.
- Separate iMessage and SMS chat GUIDs remain separate even when their endpoint is equal.
- Separate RCS conversation ids remain separate even when their participants or display names are equal.
- Two group chats with identical participant sets remain separate.
- Identical text, timestamps, attachments, or contact labels do not establish identity.
- If a server repeats the exact same chat within one current account data realm, pagination may deduplicate that exact
  key only.

An Apple service transition reported under one unchanged, authoritative server chat GUID is not a client-created
merge. The client retains the exact chat owner and message-level service evidence. It must not use that exception to
join another GUID or any RCS conversation.

Provider and transport are different facts. `apple_messages` and `google_messages` are provider namespaces;
`imessage`, `sms`, `mms`, `rcs`, and `unknown` are transports. A Google conversation may fall back from RCS to SMS
without becoming an Apple SMS conversation or changing its Google conversation identity.

A provider epoch is mandatory whenever a provider can reuse its source ids. Google Messages has that property after
a phone re-pair, so every valid persisted Google conversation/message identity includes a nonempty opaque epoch.
Apple chat GUIDs remain scoped by the current account data realm; no separate Apple epoch is currently exposed. A
missing required epoch is an invalid identity, not a legacy match opportunity.

### 3. Normalize only within a declared purpose

- **Routing and existing-chat selection:** phone numbers require a complete canonical number, preferably E.164 with
  explicit region evidence. If the app cannot prove the canonical value, it keeps the exact raw endpoint and does not
  offer an inferred existing chat. Short codes and alphanumeric senders are exact-only.
- **Email presentation:** trimming and case folding may find a presentation candidate. It does not join two chat
  GUIDs.
- **Legacy last-ten-digits matching:** remains presentation-only until replaced. It must not select a conversation,
  target a send, resolve backup identity, or establish a known sender when multiple contacts collide.
- **RCS:** the opaque conversation id and provider epoch own the conversation. A current sidecar participant string is
  presentation only. A future identity endpoint must carry raw participant id, canonical number when genuinely
  available, and display name as separate fields.

Ambiguity fails closed. When two contacts claim one normalized endpoint, when a country/region is unknown, or when a
service is missing, Gator leaves the endpoint unlinked for identity purposes instead of choosing a winner.

### 4. Never merge or split automatically

There is no automatic transcript merge, contact-driven split, or cross-provider service fallback. Linking or
unlinking a device contact changes contact metadata only. A unique link may inform the existing user-selected
known/unknown filter; it cannot change the conversation key. Number reassignment may update the current label/photo
but cannot rewrite the chat or message owner.

A future user-facing contact details page may list multiple independent conversation shortcuts. Each shortcut must
navigate with its exact chat GUID and retain its own unread count, draft, actions, and send transport.

### 5. Keep backup matching conversation-scoped

Backups may transfer local customization to one unique replacement chat only when service, direct/group kind, stable
server identifier, and exact participant evidence satisfy the versioned backup rule. This transfers settings, not
messages or contact identity.

- Contact source ids, names, photos, and a person graph are device-local and are not portable identity.
- RCS identity must include the account/provider epoch before it can survive a sidecar re-pair. The public
  `RCS;-;<conversationID>` value alone is not sufficient because sidecar ids can reset.
- Multiple possible targets, mixed services, missing epoch evidence, and conflicting source rows are skipped and
  reported rather than guessed.

### 6. Keep pagination stable and service-complete

Identity reads page conversations, not people. Page boundaries cannot fold rows by contact or normalized address.
Every page merge is keyed by the exact conversation key, with a stable total order, an account/session fence, and one
opaque source-snapshot/data-generation token. A changed token, provider epoch, or unavailable continuation restarts
the read from a new snapshot; it never appends two source generations.

The current `POST /api/v1/handle/query` response is not an approved FEAT-06 bootstrap source because it deduplicates
RCS and Apple handles by address and its RCS address may be presentation text. The unpaginated bulk `GET /api/v1/contact`
is likewise not adopted by the Android app because it exposes the complete Mac address book without a selected,
bounded need.

If a future product journey truly needs bootstrap data, it requires an additive capability and versioned route that:

1. preserves service variants rather than deduplicating by address;
2. exposes provider and current transport separately;
3. exposes RCS participant id, canonical number, and display name separately;
4. scopes RCS ids to a provider epoch;
5. uses bounded keyset pagination with a deterministic tie-break;
6. binds every page to the same account/session generation and opaque source-snapshot token;
7. restarts rather than appending when that token or provider epoch changes; and
8. publishes nothing from an incomplete or cancelled scan.

Older servers fail closed by withholding the new capability. Existing v1 routes remain legacy/admin compatibility
surfaces and do not gain identity authority.

### 7. Limit contact data and bulk work

The current address-targeted avatar lookup remains the selected server contact behavior: it asks only about a bounded
set of endpoints already present in the encrypted local database and accepts a bounded response. A full server contact
download is not required for FEAT-06.

Any future endpoint inventory requires `messages:read` authority. Resolving those endpoints against contact records
requires separate `personal-data:read` authority; a response that combines both datasets requires both. A request
returns only bounded per-input matches and the minimum approved fields, never unmatched contacts or a whole address
book. Logs, metrics, traces, and safe-error metadata contain no contact name, endpoint, raw participant id, contact id,
or response payload.

Native device-contact refresh should eventually become page/cursor based. The last complete generation stays
authoritative until a complete replacement is ready; cancellation or account retirement discards the incomplete
generation. Handle matching is keyset-paged, and avatar backfill needs a rotating cursor or bounded negative cache so
permanently missing early avatars cannot starve later rows.

## Required hardening before an identity implementation

The ADR is a design decision, not proof that every existing path already complies. Before any schema or UI identity
feature begins, focused implementation slices must:

1. reject or quarantine message- and attachment-GUID ownership conflicts instead of reparenting across chats;
2. require the expected owning chat for reply, reaction, sticker, and thread lookups;
3. replace suffix-only RCS existing-chat selection with complete, proven endpoint identity or exact-only fallback;
4. make ambiguous contact metadata fail closed to unlinked/unknown rather than selecting the last row; and
5. preserve the RCS provider epoch anywhere an id may outlive a sidecar pairing; and
6. if the product adopts an identity bootstrap, implement snapshot-bound pagination and the separate
   authorization/data-minimization rules above.

These changes should be independently reviewed because they touch ingestion ownership, privacy, and persisted data.
They do not require or authorize transcript merging.

## Implementation follow-up

The accepted research decision is complete. Production hardening remains a sequence of separately verified slices:

| Slice                                                    | Status                                                                | Evidence                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable message and attachment GUID ownership          | Done at focused host boundary; independent review GO                  | Migration 0050 plus ownership, retry, deletion, alias, and notification regressions; details below                                            |
| Chat-scoped reply, reaction, sticker, and thread lookup  | Done at focused host boundary; independent review GO                  | Required chat owner at every target/read boundary plus cross-chat repository and stale-UI regressions                                         |
| Complete RCS existing-chat targeting                     | Done at focused host boundary; independent review GO                  | Cached participant text cannot route; Google-owned find/create remains authoritative                                                          |
| Ambiguity-safe contact metadata                          | Done at focused host boundary; independent review GO                  | Stable-source grouping, fail-closed unlinking, and compare-and-swap avatar revalidation                                                       |
| Persisted Google provider epoch                          | Done at focused cross-repository host boundary; independent review GO | Pairing-derived opaque epoch; epoch-qualified identities; fail-closed read, effect, ingress, sync, backup, and cursor ownership; no migration |
| Snapshot-bound, separately authorized identity bootstrap | Conditional; not adopted                                              | Required only if the product adopts the versioned bootstrap contract above                                                                    |

### Immutable-ownership completion evidence

Migration `0050_message_identity_owner_scope` adds exact chat ownership to deletion-ledger and
temp-to-canonical alias records. Provable legacy rows are backfilled; unprovable rows remain
NULL-scoped quarantines that cannot claim a message. Message and attachment GUIDs no longer move
between chats, every alias consumer requires its scoped chat, and deletion/notification/group
effects fail closed on an ownership mismatch. Confirmed exact and legacy sends preserve foreign
canonical rows, aliases, and ledgers while settling only an independently proven source, so an
identity conflict cannot poison-retry a durable event or POST the physical send twice. Sticky
server errors retain their retry state.

The final focused milestone passed **10 suites / 222 tests**, TypeScript, all **50** sequential
migrations plus **5/5** migration-guard tests, and the **11/11** semantic identity contract. An
independent high-risk review returned **GO**. The repository-wide DB inventory is not claimed by
this slice: reconciliation currently fails closed on an unrelated `app/_layout.tsx` context drift,
and the broader architecture command also reports pre-existing scheduled-send fingerprint/contract
drift. Those shared-tree gates must be reconciled by their owning workstreams before a repository
release gate can be green.

### Chat-scoped related-message completion evidence

Every exact message-action target now requires its owning chat, and canonical/alias resolution
constrains that owner inside the database query. Reply previews and notification action layouts
filter by the exact chat. Reaction and sticker reads require both the child row and its live target
to share that chat. Thread reads likewise require a live originator in the requested chat and return
only rows owned by it.

The conversation hook passes the requested chat through every related-message lookup. `ThreadSheet`
keys its read result, opening lifetime, and retained row callbacks by the exact
`[chatGuid, originatorGuid]` pair, so a delayed read from one service/chat cannot render or act after
the same originator string is opened under another chat.

Independent focused verification under the pinned Node 24.19 runtime passed **8 Node suites / 119
tests** and **2 component suites / 31 tests**, for **10 suites / 150 tests** total. TypeScript,
targeted formatting, and scoped diff hygiene also pass. The relevant message-target DB-write paths
remain coordinated and have no nested coordinator. This slice does not claim the repository-wide DB
inventory: the shared moving tree still has unrelated callback-certificate drift, including an
`app/_layout.tsx` reconciliation failure owned outside FEAT-06.

### RCS existing-chat targeting completion evidence

The app no longer uses a cached RCS participant string to select or offer an existing Google
conversation. `NewChatScreen` skips the local shortcut for RCS, and the repository lookup itself
returns `null` for explicit RCS callers. This is intentionally stricter than exact string matching:
the sidecar may put a display name, formatted number, or opaque participant id in the presentation
field, and the public chat contract does not carry canonical-number provenance.

At this slice's 2026-09-26 checkpoint, RCS creation and sending remained available. Start submitted
the entered address to the authenticated server, which passed that complete value directly to Google
Messages' `GetOrCreateConversation`, sent through the returned opaque conversation id, and returned
the then-current unqualified `RCS;-;<conversationID>` GUID. No server change was needed for that
local-targeting slice. Provider epoch remained open at this checkpoint; the later Google
provider-epoch completion section records the epoch-qualified replacement and closure.

Focused verification passed the **20/20** chat/contact repository suite, the **42/42** New Chat
component suite, and the one directly affected deleted-chat assertion. Strict TypeScript, targeted
formatting, diff hygiene, and the FEAT-06 semantic fixture pass. Independent review returned
**GO**. The relevant New Chat write paths remain coordinated; the unrelated repository-wide DB
inventory drift recorded above is not claimed by this slice.

### Ambiguity-safe contact-metadata completion evidence

Automatic contact presentation now uses type-scoped phone and email keys only after rejecting an
empty normalized value. Rows with the same nonempty device-contact source id are one owner and the
newest generation supplies that owner's complete endpoint set. Two distinct stable source ids, or
any claimant without a stable source id, block automatic association. Exception (2026-10-12, review
item 486): device-contact claimants whose names are equal after trimming, collapsing spaces and
ignoring case are duplicate cards for one person and count as one claimant; the card with a photo
wins. Different names stay blocked. A previously linked handle
that becomes ambiguous is restored to its server/raw presentation and has its avatar and
`contact_id` cleared, so it no longer passes known-contact filtering. The native-contact mapper no
longer manufactures a position-based id when Android omits or blanks the immutable contact id; it
passes an unusable empty owner through to this fail-closed boundary.

The local write rechecks both the selected immutable contact row and the contact-table high-water
mark inside its short transaction. A second claimant inserted after the index read therefore
cancels the stale unique match. Ambiguity cleanup likewise requires its immutable witness rows to
still exist, so evidence from a neighboring rolled-back transaction cannot clear a valid link.

The authenticated server-avatar path applies the same distinct-contact-id rule before considering
whether a claimant has a photo. One photographed contact plus one photo-less contact is still
ambiguous; repeated rows for the same stable server contact remain one claimant. Revalidation can
replace or clear only the exact app-owned avatar path it read. A concurrently installed device
photo wins the compare-and-swap and is never selected for cleanup. The server already returns all
matching contact records with stable ids, so no server production change was required. A missing
or whitespace-only server contact id is also unusable and cannot select an avatar.

Focused verification passed **6 Node suites / 101 tests**, strict TypeScript, the **11/11** semantic
identity fixture, targeted formatting, and scoped diff hygiene; independent review returned
**GO**. Every DB-write finding touched by this slice is coordinated with no nested coordinator. The
repository-wide fast DB-write gate is not claimed: the shared moving tree still contains unrelated
callback-certificate and ingress-proof drift owned by other active workstreams. This slice changes
presentation metadata only; it does not merge conversations, alter routing or transcripts, or
establish canonical RCS participant identity. It did not itself close provider-epoch ownership; that
separate requirement is closed only by the later Google provider-epoch slice.
The existing bounded first-64 server-avatar revalidation can still starve later candidates;
rotating-cursor or negative-cache work remains a separate follow-up.

### Google provider-epoch completion evidence

The fifth hardening slice completed on 2026-09-27. The sidecar derives one opaque `gpe1_...`
provider epoch from libgm's persisted raw `PairingID`. It survives restart and cookie
re-authentication, rotates on a successful re-pair, and is never replaced by physical-phone
identity. BBD exposes `supports_rcs_epoch_qualified_ids` and the current `rcs_provider_epoch`, emits
epoch-qualified chat, message, and media identifiers, serves only the current namespace, and sends
exactly one matching `X-Gator-Provider-Epoch` header on every provider-id effect. Accepted
prior-epoch effects drain before pairing authority can be replaced.

The app carries that authority through server information and provider-qualified identities.
Legacy or stale local history cannot regain network or effect authority. Realtime and REST
ingestion, sync and deletion cursors, backup transfer, media fetch, sends, alias-aware local actions,
reminders, scheduled actions, and downstream effects all fail closed unless their exact owner
remains current. This slice changed wire identity and admission only; it added no database migration.
Migration `0050_message_identity_owner_scope` remains evidence for the earlier immutable-ownership
slice, not this provider-epoch slice.

Independent server review reported **690 focused TypeScript tests** and the targeted Go
provider-epoch set green. Frozen app verification passed **16 suites / 314 tests**, including the
**11/11** semantic identity fixture; the separate hostile-ingress fixture-source guard passed
**1/1**, strict TypeScript passed under the pinned runtime, and independent review returned **GO**.
The repository-wide full DB scanner passed **75/110** checks and remains red on large pre-existing
shared-tree inventory and callback-certificate drift. This slice therefore does not claim a green
global DB-write gate.

This is source and host evidence only. It does not prove a successful live Google pair or re-pair, a
real sidecar/phone exchange, or physical-device app behavior. Snapshot-bound, separately authorized
identity bootstrap remains conditional on product adoption and is not adopted.

## Adversarial fixtures

[`FEAT_06_IDENTITY_FIXTURES.json`](./fixtures/FEAT_06_IDENTITY_FIXTURES.json) records the required positive,
separation, rejection, backup, pagination, contact-ambiguity, and RCS-epoch cases. The fixture is a contract for future
implementation tests; it is not a claim that every hardening case already passes production code. The permanent
semantic guard is `node --test scripts/feat06-identity-fixtures.test.mjs` from the repository root.

## Consequences

- The proposed "unified" feature becomes service-aware contact metadata, not a unified timeline.
- The existing separate inbox rows and service badges remain the product behavior.
- Sharing a name/photo across handles is useful but deliberately weaker than conversation identity.
- The legacy bulk handle/contact routes do not block current use because the Android app does not adopt them for
  identity bootstrap.
- Accepting the research decision did not by itself authorize a migration or prove the hardening list; the later
  completion-evidence sections record the five independently implemented slices.

## Audited source boundaries

Client boundaries include `src/db/schema.ts`, `src/db/repositories/handles.ts`,
`src/db/repositories/chatQueries.ts`, `src/db/repositories/contacts.ts`,
`src/db/repositories/messages.ts`, `src/db/repositories/attachments.ts`,
`src/db/repositories/backup.ts`, and the associated DB/service tests.

Server boundaries include `packages/bbd/src/api/operations/readOperations.ts`,
`packages/bbd/src/contacts/ContactsService.ts`, `packages/bbd/src/rcs/rcsMapping.ts`,
`packages/bbd/src/rcs/RcsCacheStore.ts`, and `packages/rcs-sidecar/normalize.go` in the sibling server repository.
