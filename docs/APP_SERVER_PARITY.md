# App ↔ Server Parity

_Initial baseline generated 2026-07-01 from a bidirectional API/feature reconciliation between the RN app (`~/github/bluebubbles-rn`) and the Gator server (`~/github/BB/bluebubbles-server`, then-current `master`). Later dated annotations record subsequent verification and closure; counts and `CONFIRMED` labels without a newer date describe that original baseline, not a fresh whole-repository scan._

> **Status authority (2026-08-08):** This document records protocol evidence and parity decisions; it is not the
> implementation tracker. [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) is authoritative. Under
> `PARITY-01`, every open `PARTIAL`/`CONFIRMED` capability must link to a primary work-plan task or an explicit
> `DEFER`/`DROP` product decision. Per-address contact lookup and send-contact are complete paths; the bulk
> contacts/handles bootstrap listed below is a different, still-unused capability.

**Directions:**

- **Server → App** = the server exposes it, the app doesn't use it (untapped capability).
- **App → Server** = the app calls/expects it, the server doesn't provide it (would fail, silently no-op, or is already stubbed in-app).

**Original 2026-07-01 baseline:** 44 surface items matched on both sides (the core messaging, sync,
group management, FaceTime, Find My, stats, and restart/logs flows all lined up).

## ✅ Closed (2026-07-01)

The top gaps have since been wired app-side against capabilities the server already exposed:

- **`message-send-error`** — the app now subscribes (SERVER_EVENTS), normalizes it (EventRouter → `NormalizedEvent`), and `DbEventSink` routes it through `applyServerSendErrorWithinTransaction` inside the event's existing durable transaction: bubble error badge + retry, attempts-bump when the optimistic queue row still exists, and (2026-07-22) an automatic re-enqueue when the server marks the failure **`retryable: true`** — bbd sets that only for SEND-PHASE RCS bridge failures (nothing reached Google; a re-send can't duplicate), never for delivery-phase `failed` frames. Older servers omit the flag → bubble-only, as before. Unit-tested both sides (`dbEventSink.test.ts` / bbd `attachmentUploadRoutes.test.ts`, `rcsSender.test.ts`); full design in `docs/RCS_SEND_RELIABILITY.md`.
  **Durable fanout caveat (2026-08-05, updated 2026-08-09):** the stock server sends the same serialized real message GUID over socket and FCM, so the app now uses that distinct real GUID as a cross-transport content-identity fallback. This is not a complete per-attempt protocol: current RCS send failures can carry only the reused `tempGuid`, and a later retry intentionally reuses that value. The client already accepts an additive top-level `attemptGuid` and treats it as exact when present. The server still needs to generate one immutable `attemptGuid` per admitted dispatch, reuse it for every copy/redelivery of that attempt, and issue a new value for a genuine retry. Until that server contract and integration evidence exist, temp-only send-error deduplication remains best-effort. The client now moves a cancelled temp message's deletion ledger marker and records every learned temp→real mapping in a bounded encrypted local alias table, so a stale user action can still resolve after message purge/re-ingest. A content-only echo still cannot recover a mapping that was never learned because the temp row was already purged; the same server identity contract is needed to close that residual.
- **`new-server`** (tunnel-URL rotation) — the post-v56 RT-01A host flow now intercepts every instruction before database access. Invalid and downgrade attempts fail closed; an eligible foreign origin is held only in process memory and requires a foreground, unlocked approval modal, a freshly entered password, and separate cleartext consent when applicable. The candidate is validated before an exclusive, session-guarded credential commit and socket replacement. Exact Android traffic-capture and SecureStore interruption proof remains open, so this does not apply to frozen v56.
- **Server Health screen** (Settings › SERVER › "Server Health…", and from Server Management) — surfaces the previously-untapped **remote-readable diagnostics** the server already exposed: Private-API helper connectivity (Messages + FaceTime), Find My key-import status (`get-findmy-keys-status` + `get-env` `findmyNeedsKeys`, explaining empty Find My tabs), push/FCM config (`get-fcm-status`), environment/uptime (`get-env` + `/admin/status`), tunnel + public IP + TLS (`get-zrok-status`/`get-public-ip`/`get-tls-status`), and the server alert log (`get-alerts` + Clear). No server change needed — all channels were already password-accessible. **DEPLOYMENT CAVEAT (2026-07-23):** a reverse proxy in front of the server must pass `POST /api/v1/admin/command` + `GET /api/v1/admin/status` through — prod Caddy's blanket `/api/v1/admin/*` 404 hardening silently killed BOTH this screen and Server Management's statistics (all their reads ride the dispatcher); fixed with a narrow path+method allow (admin-only writes stay blocked at the proxy AND token-gated server-side). The app now remaps a dispatcher-route 404 to `UnimplementedEndpointError`, so the screens say "unsupported/blocked" instead of blaming the connection (`adminCommand`/`adminStatus` in `endpoints/server.ts`).

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
  See the partial-closure section below for the remaining timestamp-cursor limits.
- **Read-state (`lastReadMessageTimestamp`)** — Mac-side read markers reconcile into the app's
  guid-based marker at chat ingestion (monotonic, idempotent, batched); unread counts self-correct.

## ✅ Closed (2026-07-17) — send a contact card (`send-contact`)

The server's `send-contact` action (`POST /api/v1/message/contact`, advertised via
`supports_send_contact` in `/server/info`) is now consumed app-side:

- The client sends STRUCTURED fields (`firstName`/`lastName`/`organization`/`phones[]`/`emails[]`);
  the SERVER assembles the vCard 3.0 and ships it as an attachment through the same pipeline as
  `send-attachment` (so the ack is the same `{ guid? }` and the live `new-message` echo carries the
  real `.vcf`). The app already RENDERS received vCards (`parseVCard`); this closes the send side.
- Capability-gated: the composer's attachment tray shows a **Contact** button only when
  `serverInfo.supports_send_contact` is true (`useSendContactSupported`), so it never offers a send
  an older server can't fulfil. The native contact picker (`presentContactPickerAsync`) maps the
  chosen contact to the structured fields (photo intentionally omitted — the server vCard omits
  PHOTO too).
- Optimistic send: an outgoing bubble shows the contact's display name until the server echo swaps
  in the rendered card; a failure flips it to the retryable error state (mirrors `sendTextMessage`).
  See `sendContactService.ts` + `sendContact` (`endpoints/messages.ts`).

## ✅ Closed (2026-07-18) — iMessage account (`icloud/account`)

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

## ✅ Closed (2026-07-20) — rich-link previews (`payloadData`)

Received links previously rendered blank cards: the app re-fetched every URL itself with a
bot-looking User-Agent (blocked by X/Instagram/Amazon/news CDNs), while Apple's OWN pre-fetched
preview (the LPLinkMetadata the sender's device embedded in `payload_data`) was read from chat.db
by the server but never emitted, and never stored by the app.

- **Server** (`packages/bbd`): `parsePayloadData` (`data/imessage/payloadData.ts`) decodes the
  NSKeyedArchiver blob (bplist → UID-walk, modeled on the Flutter client's `extractUIDs`) into a
  flat `{urlData: [{url, originalUrl, title, summary, siteName, itemType, imageUrl, iconUrl,
videoUrl}]}`. `serializeMessage` emits it presence-driven, double-gated (URL balloon bundle id +
  decodable data; placeholder RichLinks → omitted). Additive `MessageV1.payloadData` on the
  protocol; REST + socket + FCM all carry it (single serializer). NO capability flag — additive,
  use-if-present (precedent: `messageSummaryInfo`/`isScheduled`). Validated against 578 real
  chat.db blobs (512 decode, 66 are placeholders).
- **App** (`bluebubbles-rn`): `payload_data` JSON TEXT column (migration `0027`, COALESCE-preserved
  like `messageSummaryInfo`); zod `PayloadData` with `.catch(undefined)`; `MessageBubble` renders
  the card straight from it (image/icon URLs re-checked with `isSafePreviewUrl`) and passes
  `useUrlPreview(null)` so payload-backed messages NEVER fetch. Fallback (no payload: old rows,
  placeholders, old servers) = the client OG fetch, hardened 2026-07-20: real Safari UA, 512KB
  pre-reject → 5MB DoS guard only, transient failures (403/429/timeout) no longer negative-cached.
- **Postscript (0.1.28, 2026-07-21)**: preview IMAGES had never rendered on-device regardless of the
  metadata source — a card-layout circularity resolved the image to width 0 (looked like a
  network/library bug for a whole evening; see the AGENTS.md UI gotcha). `UrlPreviewCard` now uses a
  fixed `width:'78%'`, verified rendering on-device. Preview cards are feature-complete end to end.

## ⚠️ Partial (2026-08-06) — missed-deletion catch-up sync (R1)

**Authoritative task:** [`DELETE-SYNC-01`](./WORK_PLAN_2026-08-03.md).
The client containment below is implemented; the two final server-protocol bullets keep that task blocked.

The one documented residual from the schema-gap wave: a `message-deleted` event arriving while the
app was DEAD or APP-LOCKED was LOST (the locked FCM path never touches the DB), so the deleted
message lingered locally forever — there was no sync-side signal to reconcile against. That
dead/locked transport gap is closed on both sides:

- **Server** (`packages/bbd`, shipped 2026-07-23): `GET /api/v1/message/deleted?after=<unixMs>`
  (auth, standard v1 envelope) returns `{ deleted: MessageDeletedV1[] }` — the SAME
  `{ guid, chatGuid, dateDeleted }` DTO as the realtime `message-deleted` event — oldest-first,
  page capped at 500 rows. `after` is a Unix-ms watermark (fractional ms floored server-side, so
  rows sharing the watermark's exact ms may RE-EMIT — application must be idempotent). Advertised
  via the existing `supports_message_deleted` capability.
- **App** (`bluebubbles-rn`): `syncDeletedMessages` (`src/services/sync/engine.ts`) runs on every
  boot/reconnect sync (`runSync` in `syncControl.ts`, after the chat/message sync), gated on
  `sessionAccessors.messageDeletedSupported()`. It pages the endpoint from the persisted
  `sync.deletionsSyncedAt` watermark (kv table — no new migration) and applies each row through the
  public guarded `markMessageDeleted` transaction owner. It shares the live event's underlying
  transaction-only tombstone primitive and is idempotent, so re-emitted rows are no-ops. FIRST
  supported run seeds the watermark to `Date.now()` WITHOUT fetching to avoid an
  unbounded replay of deletions for rows this install never stored. This is containment, not a
  consistent snapshot: normal history sync runs first and can ingest a row the server already
  considers deleted. Null `dateDeleted` rows are tombstoned (now() fallback) but never advance the
  watermark; the page loop is bounded (max 5 pages per sync) and stops when a full page can't
  advance the watermark. Engine-level tests in
  `test/services/deletionSync.test.ts` (capability gate, first-run seed / no history replay,
  watermark advance, idempotent re-run, null dateDeleted, strict response validation, paging +
  bounded loop).

The app-side watermark seed/read, each tombstone, and each watermark advance now also own short
account-guarded transactions, so a neighbouring rollback or Disconnect cannot create a false
committed cursor. The app-side ordering and protocol defects are closed:

- Migration `0033_message_deletion_ledger` backfills existing tombstones and retains the greatest
  deletion time per GUID without a message foreign key. `markMessageDeleted` records the marker even
  when the row is absent; `upsertMessages` applies it in the initial INSERT. Durable realtime delivery
  checkpoints that marker atomically instead of retrying/recovering an already-applied deletion.
- The REST schema rejects malformed timestamps and more than 500 rows. Before any page write, the
  engine rejects an invalid GUID/non-finite timestamp, a timestamp below the requested watermark, or
  decreasing order; equal timestamps remain valid. It never sorts or slices a bad response. A full
  page containing a null timestamp is applied but cannot move the cursor, and ingestion auto-download
  excludes attachments whose owner is already tombstoned.

Two server-protocol residuals keep this section partial rather than fully closed:

- A timestamp-only cursor cannot losslessly continue when a full 500-row page can share/floor to one
  cursor millisecond and those ties re-emit; exactly 500 tied rows can already starve newer rows. The
  durable fix is a server continuation token or composite `(dateDeleted, stableId)` cursor; a full
  ambiguous page currently stops safely rather than skipping rows.
- First supported run still seeds from device `Date.now()`. A clock-ahead device, an existing
  installation gaining the capability, or even a fresh install whose normal history sync just
  ingested an already-deleted row can seed past relevant deletion knowledge. A server-issued initial
  cursor must be tied to a consistent history snapshot (or history must exclude/mark deleted rows)
  to remove that race.

## 📱 RCS bridge (Google Messages)

The Gator server's RCS bridge (a `libgm` sidecar) serves RCS chats through the **same frozen v1
endpoints** as iMessage, so the app needs no new sync pipeline — RCS traffic is deliberately
shaped like iMessage traffic. The app now accepts, renders, sends, and creates capability-gated
one-to-one RCS conversations.

| Direction    | Item                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server → App | `get-chats` returns RCS chats: guid `RCS;-;<id>`, `style` 45/43, participants `HandleV1{service:"RCS"}`                                                                              | ✅ App accepts — `service` is an open `z.string()` (`ServiceType`), so RCS never fails the page parse; `KNOWN_SERVICES` now includes `'RCS'`.                                                                                                                                                    |
| Server → App | RCS `MessageV1` (`service:"RCS"`, `originalROWID:null`, ms dates, status on `isSent`/`isDelivered`/`isRead`) via `get-chat/:guid/message` + realtime `new-message`/`updated-message` | ✅ Flows through the existing chat-open backfill + `EventRouter` unchanged (no service filter drops it).                                                                                                                                                                                         |
| Server → App | RCS attachment bytes on the **separate** route `GET /api/v1/rcs/attachment/{mediaID}/download`                                                                                       | ✅ App branches on the owning chat's service — `attachmentDownloadUrl(http, guid, service)` builds `/rcs/attachment/…` when `service === 'RCS'`. Service is derived (chat-guid `LIKE 'RCS;-;%'` JOIN) onto `AttachmentRow`.                                                                      |
| Server → App | `ServerInfoV1.rcs?: boolean` capability flag                                                                                                                                         | ✅ Added to the `ServerInfo` zod model (nullish → older servers omit it, no throw); `sessionAccessors.rcsEnabled()` / `useRcsEnabled()` gate RCS-specific UI.                                                                                                                                    |
| Server → App | `rcs-alert` realtime event (bridge health: `alertType` + message)                                                                                                                    | ✅ Subscribed (`SERVER_EVENTS`) + zod-normalized in `EventRouter`; `RcsAlertEventSink` maps it to a Server Health RCS row (`rcsHealth.ts`).                                                                                                                                                      |
| Server → App | `rcs-bridge-down` high-priority push (`{title, body, reason}`)                                                                                                                       | ✅ Subscribed + normalized; posts a content-less status notification (`intents.ts` → `notifeeService`), honoring the hide-preview toggle.                                                                                                                                                        |
| App UI       | RCS bubble colour + badge                                                                                                                                                            | ✅ New `rcsBackground` teal token (distinct from iMessage blue + SMS green) across all presets; `MessageBubble` mirrors the SMS-green branch for `senderService === 'RCS'`; a subtle "RCS" `ServiceBadge` pill shows in `ConversationHeader` + `ConversationTile` (keyed off the `RCS;-;` guid). |
| App → Server | Create a new RCS conversation                                                                                                                                                        | ✅ `new-chat` offers RCS only when `ServerInfoV1.rcs` is enabled, passes `service: 'RCS'` to the existing create endpoint, and rejects multiple recipients because the server's RCS branch is one-to-one.                                                                                        |

**Intentional non-alignments (RCS):**

- **RCS is deliberately NOT in `query-messages`** (server-side) — the incremental sync stays
  iMessage-only to protect the ROWID cursor. RCS chats hydrate via `get-chats` + the
  chat-messages endpoint and stay live via realtime events, so the app must **not** expect RCS
  to arrive through the incremental path. No app change needed (the app already backfills on
  chat-open); noted so a future sync refactor doesn't "fix" the missing RCS rows there.

## ⚠️ Intentionally NOT aligned (documented, no action)

These are genuine divergences, each for a concrete reason — not oversights:

- **`imessage-aliases-removed`** — the app is fully wired to handle it (listener + notification), but the **Gator server has no detection source** for Apple-ID alias deregistration (not even declared in `DomainEvents`; 0 hits server-wide). The app handler is harmless + forward-compatible with an upstream server that does emit it; adding a fake server emission with no real source would be misleading. Left as app-ready.
- **`scheduled-message-update`** — the app now prefers server-side scheduling for eligible one-shot messages and uses local rows for replies, recurrence, offline, and older-server fallback. The signal is still unwired, so a server-side change made elsewhere does not live-refresh the app's hybrid schedule list. Track that explicit parity decision under `PARITY-01` rather than calling the whole model local-only.
- **`group-icon-changed` / `group-icon-removed`** — the app renders group avatars as **participant collages** (`GroupAvatar`) and does not display a server-supplied custom group photo, so there's nothing to refresh. Wiring it would be a no-op until group-photo display is added. Deferred with the (still-open) group-photo feature.
- **The remaining admin / config surface** (set-config/get-config writes, TLS/zrok/VAPID/Cloudflare **management**, webhooks, FCM **setup**, device purge) — still untapped by design: either **local-console-only** (403 to remote app clients) or **low mobile value**. The read-only **diagnostics** subset (private-API/keys/push/env/tunnel/TLS/alerts) is now surfaced by the **Server Health screen** (see Closed above). What remains are the _write_/management ops, which belong on the trusted local server console, not a remote app.

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
| ✅ get-private-api-status CLOSED 2026-07-01 (Server Health; reinject-helper still untapped — was 🟡 Medium)    | admin-channel: get-private-api-status / get-private-api-requirements / reinject-helper                                                             | Read Messages+FaceTime helper connected/enabled flags + requirements checklist; reinject-helper relaunches the apps (admin-only). App references reinject-helper only in a code comment, never invokes any (0 real hits). get-private-api-status would let the app gate effects/edit/unsend/reactions UI on actual helper connectivity instead of just serverInfo.private_api.                                       |
| 🟡 Medium (CONFIRMED)                                                                                          | admin-channel: check-permissions / get-current-permissions / contact-permission-status / request-contact-permission                                | macOS permission status + contact-permission request. App has 0 hits. Useful for an onboarding/diagnostics screen to tell the user the server is missing Full Disk / Contacts access.                                                                                                                                                                                                                                |
| ✅ CLOSED 2026-07-01 (get-alerts + Clear via Server Health — was 🟡 Medium)                                    | admin-channel: get-alerts / clear-alerts / mark-alerts-as-read                                                                                     | In-memory server alert log (read + clear/mark-read, all NOT admin-only, remote-invokable). App has 0 hits. Could surface server-side warnings (helper crashes, auth failures) in the app.                                                                                                                                                                                                                            |
| ✅ CLOSED 2026-07-01 (Server Health — was 🟡 Medium)                                                           | admin-channel: get-env                                                                                                                             | POST /admin/command {channel:'get-env'} — version/platform/node/findmyNeedsKeys/isMinMonterey. Read-only, remote-readable. App has 0 hits; findmyNeedsKeys would let the app tell the user Find My decryption keys aren't imported before showing empty FindMy tabs.                                                                                                                                                 |
| ✅ get-findmy-keys-status CLOSED 2026-07-01 (Server Health; import-findmy-keys still untapped — was 🟡 Medium) | admin-channel: Find My key mgmt — get-findmy-keys-status / import-findmy-keys                                                                      | get-findmy-keys-status (read, remote) + import-findmy-keys (admin-only write). App has 0 hits. get-findmy-keys-status pairs with get-env findmyNeedsKeys to explain empty FindMy device/item lists.                                                                                                                                                                                                                  |
| 🟡 Medium (CONFIRMED)                                                                                          | admin-channel: device management — get-devices / purge-devices                                                                                     | get-devices (read registered push devices, remote-readable) + purge-devices (destructive, admin-only). App registers via POST /devices but never lists or purges (0 hits). get-devices could show the user which devices are receiving push.                                                                                                                                                                         |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: GET /api/v1/devices (list-devices) + DELETE /api/v1/devices/:id (remove-device)                                                              | Dedicated REST device list/remove. App only POSTs /devices to register (grep: POST only, no GET/DELETE). Same use case as get-devices/purge-devices admin channels — manage this device's push registration / clean up stale tokens.                                                                                                                                                                                 |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: GET /api/v1/contact (get-contacts, all address-book contacts)                                                                                | Returns the full server address book. App only calls POST /contact/query (by-address lookup), never the bulk GET (0 hits for GET /contact). Could seed a server-side contact directory instead of per-address queries.                                                                                                                                                                                               |
| 🟡 Medium (CONFIRMED)                                                                                          | REST: POST /api/v1/handle/query (get-handles)                                                                                                      | Paginated list of all handles/addresses. App has 0 hits for /handle/query. Could bootstrap the handle table on first sync rather than deriving handles from messages.                                                                                                                                                                                                                                                |
| 🟡 Medium (CONFIRMED)                                                                                          | socket-emit: group-icon-changed / group-icon-removed                                                                                               | Server forwards helper group-icon add/change/remove events. App SERVER_EVENTS omits both (0 hits), so a group photo change won't refresh the app's group avatar in realtime (only on next full resync).                                                                                                                                                                                                              |
| 🟡 Host flow complete; device proof open (`RT-01A`)                                                            | socket-emit: new-server                                                                                                                            | The event is intercepted before SQLite. Invalid/downgrade attempts are rejected; a live foreign-origin proposal requires foreground approval, a fresh password, and explicit cleartext consent when applicable. Candidate validation precedes an exclusive, epoch-guarded vault commit and socket replacement. Exact Android network and SecureStore interruption proof remains.                                     |
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

- **App → Server: clean.** The app never calls anything the server can't handle — nothing would 404 a user. The only drift is the app being wired for the `imessage-aliases-removed` realtime event that this server never emits (dead listener; the _server_ is what's missing the emission), plus an already-stubbed `checkUpdate`.
- **Server → App: mostly wired now.** The app uses the core data/action APIs fully, and the previously-untapped realtime + diagnostics surface has largely been closed (see the _✅ Closed (2026-07-01)_ section above): `message-send-error` and the admin/diagnostics reads (`get-private-api-status`, `get-env`→`findmyNeedsKeys`, `get-findmy-keys-status`, `get-fcm-status`, `get-alerts`, `get-config`) are handled — the diagnostics reads are surfaced by the in-app **Server Health** screen. The post-v56 `new-server` approval/reconfirmation flow is implemented and remains quarantined from SQLite; exact Android network and SecureStore interruption proof is still open. The app-relevant message/chat event differences intentionally left unresolved are:
  1. **`group-icon-changed` / `group-icon-removed`** — the app renders participant-collage group avatars, so there's no server group photo to refresh (deferred with the group-photo feature).
  2. **`scheduled-message-update`** — the hybrid server/local schedule list does not yet consume this server refresh signal; `PARITY-01` owns the implement/defer decision.
- The historical table also retains lower-value unwired signals such as `config-update` and
  `firebase-setup-status`; they are not silently reclassified as wired by the summary above.
- **Not worth wiring** (low mobile value / local-console-only): webhooks, zrok/TLS/VAPID/Cloudflare management, `set-config` writes (all admin-only, 403 to remote clients).
