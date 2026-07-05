# RCS via Google Messages web-pairing — orchestration plan

**Status: IN PROGRESS. Researched 2026-07-04 against live sources.**
Format: a Context section, then numbered prompts. Each prompt = concrete task (with file
paths) + one rationale sentence (so the implementing agent can adapt when reality differs)
+ a verification step (run X, confirm Y) so failure is caught immediately.

**Progress:**
- ✅ **Prompt 1 (Phase-0 spike) — BUILT & COMPILES.** Lives at
  `~/github/BB/bluebubbles-server/packages/rcs-sidecar/spike/` (throwaway; only added files;
  server-repo WIP untouched). `go build`/`go vet` clean.
- ⏳ **Prompt 1 pairing test — PENDING USER.** The real-world Gaia pairing (cookies + emoji
  tap on the phone) has not been run yet; it gates Prompt 2. Run with `go run .` (NOT
  `go run main.go` — that misses `cookies.go`).
- ⬜ **Prompts 2–10 — NOT STARTED** (audited 2026-07-04: no `packages/bbd/src/rcs`, no
  `rcsEnabled`/`RcsSidecar`/`RcsListener`/`RcsSender` anywhere; `rcs-sidecar/` contains only
  `spike/`).

**Findings locked in from Prompt 1 (feed into later prompts):**
- Pinned **`go.mau.fi/mautrix-gmessages v0.2605.0`** (CalVer 26.05, latest). Local toolchain
  go1.26.4 (arm64). `DoGaiaPairing(ctx, emojiCallback)` confirmed exact.
- **Inbound messages arrive as `*libgm.WrappedMessage` (embeds `*gmproto.Message`), NOT
  `*gmproto.Message`** — mautrix's own `gmtest` example gets this wrong and silently drops
  every message. Prompt 2/5 event handling MUST match `*libgm.WrappedMessage`. Conversation
  events = `*gmproto.Conversation`, typing = `*gmproto.TypingData`, alerts =
  `*gmproto.UserAlertEvent`. `events.ClientReady` is defined but never fires in v0.2605.0 —
  do NOT rely on it for the initial snapshot; call `ListConversations` explicitly instead.
- Cookies set via `authData.SetCookies(map[string]string)` before `NewClient`. Session =
  one JSON `libgm.AuthData` blob; `NewClient(authData)` + `Connect()` resumes with no re-pair.
- Send needs the conversation first: `GetConversation` → `ParticipantID =
  conv.GetDefaultOutgoingID()`, `SIMPayload = conv.GetSimCard().GetSIMData().GetSIMPayload()`,
  a uuid `tmpID`, wrapped in `SendMessageRequest{MessagePayload{...}}`.

---

## Context — the goal and the why

**Goal:** full two-way **RCS (plus Google-Messages-held SMS/MMS)** in the BlueBubbles RN app,
by running a **Go sidecar embedding `libgm`** (the reverse-engineered "Messages for Web"
protocol library from [mautrix/gmessages](https://github.com/mautrix/gmessages)) on the Mac
mini next to the Gator server (`~/github/BB/bluebubbles-server`). The sidecar pairs with
Google Messages on the Android phone as a companion device and sees everything the web client
sees — conversation list, history, send, media, reactions, typing, read receipts, **E2EE RCS
included**.

**Why this architecture:** Android offers no public third-party RCS API (platform APIs are
OEM-privileged; Google Messages' relay API is signature-allowlisted; RCS lives in GM's private
DB). The web-pairing protocol is the only functioning path, libgm is its only maintained
implementation (pure Go, no cgo, monthly releases, v26.05 current), and the Gator daemon
(`packages/bbd`) already has every seam this needs: a source-agnostic event bus whose fanout
reaches socket + webhooks + encrypted FCM, a supervised-child-process pattern (`ZrokTunnel`),
a writable Drizzle SQLite + Keychain vault, a unified REST/socket operation model, and a
loopback-only admin UI for the pairing page. RCS chats ride the **frozen v1 API** with minted
`RCS;-;<conversationID>` GUIDs and `service: "RCS"`, so the RN app's existing sync/realtime
pipeline needs almost no new plumbing. Works identically on Intel and Apple Silicon (pure Go;
per-arch binary bundling already exists for zrok).

**Load-bearing facts (verified 2026-07; re-verify pairing status before Prompt 1):**
- **QR pairing is DEAD** (Google removed it ~May 2026; mautrix v26.05 disabled it). Only
  **Gaia pairing** works: cookies (`SID, HSID, SSID, OSID, APISID, SAPISID`, sometimes
  `__Secure-1PSIDTS`) from an incognito login to messages.google.com (DBSC off / use
  Firefox; close window WITHOUT logging out), then a UKEY2 handshake with an
  **emoji-confirmation tap on the phone** (`DoGaiaPairing(ctx, emojiCallback)`). Phone must
  be in Settings → Device pairing → Google Account pairing mode.
- **Session = one JSON `AuthData` blob**; survives restarts; token auto-refreshes; cookies
  replaceable **without re-pairing** (v0.6.0+). Liveness via `NotifyDittoActivity()` ping
  (default 20 min). Phone offline = dead air (`PhoneNotResponding` events, backoff re-ping).
- **API**: `ListConversations`, cursor-paginated `FetchMessages` (history capped at the
  phone's local DB), `SendMessage`, `SendReaction`, `MarkRead`, `SetTyping`,
  `UploadMedia`/`DownloadMedia` (client-side AES-GCM). One event callback: `MessageEvent`,
  `ConversationEvent`, `TypingEvent`, `UserAlertEvent` (`BROWSER_INACTIVE*`,
  `MOBILE_BATTERY_LOW`, `RCS_CONNECTION`…), synthesized `ClientReady`/`PhoneNotResponding`.
- **SMS/MMS route through the bridge too** (GM must be the default SMS app; conversations
  are typed `SMS=1/RCS=2`, messages sms/mms/rcs) — overlap policy with the app's on-device
  Phone SMS section is decided in Prompt 5 (default: carry everything, badge by service;
  the on-device section remains the server-down fallback).
- **AGPL-3.0** (all of mautrix/gmessages incl. libgm): fine for personal use; if ever
  distributed the **sidecar binary** must be AGPL — keep it a separate program behind
  arm's-length IPC; never import it into the Node code.
- Gator server integration seams (from the repo map): `packages/bbd/src/backend.ts`
  (composition root, services array ~line 789, fanout wiring ~line 573),
  `serialize/messageFanout.ts`, `networking/ZrokTunnel.ts` (supervision model),
  `api/Operation.ts` + `api/operations/*.ts`, `data/config-db/tables.ts` + Drizzle store
  patterns, `config/configSchema.ts`, `packages/protocol/src/v1/entities.ts` (frozen DTOs —
  additive only), `packages/ui` (admin SPA, loopback-only, has react-qr-code precedent).

**Repos:** server + sidecar work in `~/github/BB/bluebubbles-server`; app work in
`~/github/bluebubbles-rn`. Deploy target: Mac mini (`maccy@192.168.1.219`, Intel today).

---

## Numbered prompts

### Prompt 1 — Phase-0 spike: pair, listen, send (throwaway Go program)
**Task:** In `~/github/BB/bluebubbles-server/packages/rcs-sidecar/spike/`, create a minimal Go
module (`go.mod`, Go ≥ 1.25, dep `go.mau.fi/mautrix-gmessages` pinned to the latest tag) with
a `main.go` that: loads/saves `session.json` (the libgm `AuthData` blob); when unpaired, reads
pasted cookies from a local file and runs `DoGaiaPairing`, printing the confirmation emoji to
stdout; when paired, `Connect()`s, logs every event via zerolog, prints `ListConversations`,
and accepts a stdin command `send <conversationID> <text>`.
**Rationale:** this de-risks the three things research can't prove — the pairing flow against
Google's *current* servers, this specific Google account (multi-phone accounts hit
`ErrHadMultipleDevices`), and the event stream — so read the pinned libgm source for exact
signatures rather than trusting this doc's API names.
**Verify:** `go build ./...` compiles clean. Then with the user in the loop: pair with real
cookies and confirm the emoji tap completes and `session.json` appears; **restart the binary
and confirm it resumes WITHOUT re-pairing**; text the phone from another number and confirm a
`MessageEvent` logs within seconds; run `send` and confirm the message appears in Google
Messages on the phone.

### Prompt 2 — Productize the sidecar: `gator-rcs` HTTP daemon
**Task:** In `~/github/BB/bluebubbles-server/packages/rcs-sidecar/` (its own Go module,
AGPL-3.0 `LICENSE` + file headers), build the real binary: loopback-only HTTP server (port
from `BBD_RCS_PORT`, bearer secret from `BBD_RCS_SECRET`, session file path from
`BBD_RCS_SESSION_FILE`) exposing `POST /pair/start` (cookie blob), `GET /pair/status`
(state + emoji), `POST /unpair`, `GET /status` (paired/connected/phone-liveness),
`GET /conversations`, `GET /conversations/:id/messages?cursor=`, `POST /send`,
`POST /send-media`, `GET /media/:mediaID?key=` (decrypted bytes via `DownloadMedia`), and
`GET /events` — a long-lived NDJSON stream of normalized events (message, conversation,
typing, alert, ready) with a periodic heartbeat line.
**Rationale:** keep every route a thin, direct mapping onto libgm methods so monthly upstream
bumps stay mechanical, and keep the AGPL boundary clean by making this a standalone program
that shares no code with the Node server.
**Verify:** `go build ./... && go vet ./...` clean. Run it against the spike's `session.json`:
`curl` each endpoint and confirm `/conversations` returns JSON, `/events` emits a line when
you text the phone, and `POST /send` delivers to Google Messages.

### Prompt 3 — bbd supervision: spawn and babysit the sidecar
**Task:** In `~/github/BB/bluebubbles-server/packages/bbd/src/rcs/RcsSidecarService.ts`,
write a lifecycle `Service` modeled directly on `networking/ZrokTunnel.ts`: spawn the binary
(path from `BBD_RCS_BIN` env, per-arch bundle under `appResources/macos/daemons/` like zrok),
generate the per-boot shared secret, health-poll `GET /status`, capped-backoff restart, kill
on `stop()`. Add config keys (`rcsEnabled`, `rcsPingMinutes`) to `config/configSchema.ts`,
and register the service in the `services: [...]` array in `backend.ts` (gated on
`rcsEnabled`).
**Rationale:** `ZrokTunnel` is this codebase's proven child-process pattern and the
`Supervisor` gives ordered start/rollback for free — mirror it rather than inventing
lifecycle handling.
**Verify:** run the bbd package's own typecheck/test scripts (discover them in
`packages/bbd/package.json`) clean; start the daemon locally with `rcsEnabled=true`, confirm
the sidecar spawns and `health()` reports it, kill the sidecar process manually and confirm a
backoff restart log, stop the daemon and confirm the child dies.

### Prompt 4 — Pairing operations + admin UI page
**Task:** Add admin-gated operations (follow `api/operations/adminCommandOperations.ts` or a
new `buildRcsOperations` in `api/operations/`, registered in `backend.ts`): `rcs-pair-start`,
`rcs-pair-status` (returns emoji + state), `rcs-unpair`, `rcs-status` — each proxying the
sidecar. In `packages/ui/src/app/layouts/`, add a "Google Messages (RCS)" page (route in
`app/App.tsx`): cookie/cURL paste box with the incognito/DBSC instructions, live emoji
display while pairing, paired-state + phone-liveness panel, unpair button. Relay sidecar
`UserAlertEvent`s through the daemon's event path (see `forwardHelperEvent` in `backend.ts`)
so they reach socket clients.
**Rationale:** pairing is a local admin action and the static UI is served loopback-only,
which matches the security posture — and the cookie-paste UX is the documented mautrix flow
now that QR is dead.
**Verify:** build `packages/ui` and the daemon; open the dashboard on the Mac and complete a
REAL pairing end-to-end from the page — cookies pasted, emoji displayed, tap on phone,
status flips to paired and survives a daemon restart.

### Prompt 5 — Read path: cache, GUID mapping, fanout
**Task:** In `packages/bbd/src/rcs/`: Drizzle tables (`rcs_conversations`, `rcs_messages`,
`rcs_attachments`, `rcs_cursor`) following the `DrizzleWebhookStore.ts` pattern (own store
class, `data/config-db/tables.ts` additions or a dedicated `rcs.db`); an `RcsListener` that
consumes the sidecar's `/events` stream + `ClientReady` snapshot + cursor-paginated backfill
into the cache; DTO mapping — chat guid `RCS;-;<conversationID>`, message guid
`rcs-<messageID>`, `HandleV1.service = "RCS"`, dates to Unix ms; fanout of
`new-message`/`updated-message` (status updates arrive as message updates) reusing the three
sinks in `serialize/messageFanout.ts` (`emitToAuthed`, webhooks, push with `AEAD_GCM_V1`
encryption) — read that file first and choose: feed chat.db-shaped rows through the existing
`wireMessageFanout`, or add a thin `wireRcsFanout` taking pre-serialized DTOs; whichever
needs fewer lies wins. Add the additive `rcs: boolean` capability to `ServerInfoV1`
(`packages/protocol/src/v1/entities.ts`) and its handler. Default overlap policy: ingest ALL
conversation types (SMS and RCS) — do not filter by `ConversationType`.
**Rationale:** the phone is the real datastore, so a server-side cache is what keeps history
queryable when the phone naps, and reusing the fanout sinks is what makes socket + FCM +
webhooks work with zero new transport code.
**Verify:** bbd typecheck/tests clean; with a paired sidecar running, text the phone and
confirm (a) a row lands in `rcs_messages`, (b) a `new-message` event arrives on a test
socket.io client, and (c) an FCM push fires to a registered device with the encrypted
payload.

### Prompt 6 — Serve reads: v1 endpoints + attachment bytes
**Task:** Extend the read operations in
`packages/bbd/src/api/operations/readOperations.ts` (`get-chats`, `get-chat`,
`get-chat-messages`, `query-messages`, `get-handles`) to include/merge RCS rows from the
cache when the query or guid targets `RCS;-;` (or service `RCS`); add an RCS attachment
route beside `api/attachmentRoutes.ts` that streams bytes via the sidecar's `/media/:id`
with an on-disk cache.
**Rationale:** serving RCS through the frozen v1 endpoints is the whole trick that lets the
RN app's existing sync pipeline work unchanged — a parallel `/api/v1/rcs/*` namespace would
force new client code for no benefit.
**Verify:** `curl` each endpoint with the password header and confirm RCS chats, messages,
and attachment bytes return correctly — AND run the same queries scoped to iMessage chats,
confirming responses are byte-identical to before the change (no regression on the frozen
contract).

### Prompt 7 — RN app: accept and render RCS chats
**Task:** In `~/github/bluebubbles-rn`: allow `service: 'RCS'` end-to-end — zod models and
any repository code that switches on service (grep for `'SMS'` service checks, e.g.
`MessageBubble`'s `senderService` logic in `src/ui/conversations/MessageBubble.tsx`); add
RCS bubble styling + a small "RCS" badge in `ConversationHeader`/`ConversationTile` (reuse
the green SMS token `color.bubble.smsBackground` or add an `rcsBackground` token in
`src/ui/theme/tokens.ts` presets); gate visibility on the `ServerInfoV1.rcs` capability
flag (server-info fetch path in `src/services/`). Events arrive as ordinary `new-message`
via the existing `EventRouter` — confirm no code path drops unknown services. Update
`docs/APP_SERVER_PARITY.md` with the RCS rows (repo convention: app↔server feature parity
and intentional non-alignments are tracked there).
**Rationale:** the server deliberately shapes RCS traffic like iMessage traffic, so app work
is mostly cosmetic — if something deeper breaks (a zod reject, an upsert column), fix at the
model layer per the AGENTS.md migration checklist rather than special-casing the UI.
**Verify:** `npm run typecheck && npm test` clean in the RN repo; on device against the live
server: the RCS conversation appears in the list with the badge, history renders, and a text
sent to the phone appears in the app in realtime (socket) and as an FCM notification with
the app killed.

### Prompt 8 — Send path: text from the app to RCS
**Task:** In `packages/bbd/src/rcs/RcsSender.ts` + the action operations
(`api/operations/actionOperations.ts`): route `send-message`, `mark-chat-read`, and
`start/stop-typing` by GUID prefix — `RCS;-;` goes to the sidecar (`POST /send`,
`MarkRead`, `SetTyping`) instead of `messaging/MessageSender.ts`; honor
`ConversationSendMode` so Google's SMS-fallback behavior is preserved; map send failures
onto the existing error envelope so the app's retry UI works. Also route the `new-chat`
operation: when the requested service is RCS (or the address resolves to an RCS-capable
contact), create the conversation via the sidecar (`GetOrCreateConversation`) and return a
`RCS;-;` chat — so the app can START conversations, not just reply (the RN app's new-chat
screen already has a service toggle to extend).
**Rationale:** routing at the operation layer keeps `MessageSender` and every iMessage code
path untouched — the safest possible seam given both share endpoints.
**Verify:** from the RN app, send a text to an RCS chat and confirm it arrives on the
recipient's phone AS RCS (chat bubble in Google Messages, not green SMS); confirm
delivery/read status flows back into the app as message updates; send an iMessage and
confirm that path is unaffected.

### Prompt 9 — Rich RCS features: media, reactions, typing, receipts
**Task:** Media send: route `send-attachment` (base64 envelope → sidecar `POST /send-media`
→ `UploadMedia` → `MediaContent` in the send request). Reactions: map BlueBubbles tapback
types (`associatedMessageType` in `send-reaction`) ↔ `SendReaction` emoji both directions,
including inbound reaction events → `updated-message`. Typing: inbound `TypingEvent` →
the daemon's existing typing relay → app typing indicator. Read receipts: app's
`mark-chat-read` → `MarkRead`; inbound read events → `updated-message` with `dateRead`.
**Rationale:** each of these is RCS-only in the protocol and independent of the others —
implement and verify them one at a time so a mapping bug in one doesn't block the rest.
**Verify:** pairwise on device for each feature: picture app→phone and phone→app renders
both ends; tapback in the app shows as the right emoji reaction in Google Messages and
vice-versa; typing bubbles show both directions; reading in the app marks read on the
phone.

### Prompt 10 — Ops hardening: re-auth, alerts, upkeep
**Task:** Cookie re-auth: an admin UI flow (same page as Prompt 4) to paste fresh cookies
into a live session WITHOUT re-pairing (libgm v0.6.0+ path). Alerting: persistently surface
`PhoneNotResponding` / `BROWSER_INACTIVE*` / auth-expired states as a server-health event
the RN app's Server Health screen (`app/(app)/server-health.tsx`) displays, plus one push
notification when the bridge goes down. Write `docs/RCS_RUNBOOK.md` in the server repo:
pairing walkthrough, cookie refresh, failure modes, and the monthly
`go get -u go.mau.fi/mautrix-gmessages` bump routine.
**Rationale:** cookie/session expiry and phone-offline are the two known long-run failure
modes — the feature's real quality bar is whether the user finds out from a notification
instead of from missed messages.
**Verify:** put the phone in airplane mode for 10+ minutes → confirm the Server Health
screen shows the phone-offline alert and a push arrives; restore and confirm recovery is
automatic; run the cookie-refresh flow with fresh cookies and confirm the session continues
(events still arriving) with no re-pair.

---

## Appendix — risks & non-goals

| Risk | Mitigation |
|---|---|
| Google shifts the protocol (record: migrations, not kill-switches) | Pin libgm; monthly bump routine (Prompt 10); sidecar isolation means breakage never touches iMessage |
| Cookie/session expiry (the #1 failure mode) | Re-auth without re-pair (Prompt 10); loud alerts |
| Pairing UX friction (incognito + cURL copy + DBSC + emoji) | One-time; admin UI walks through it |
| Phone offline = dead air | Server cache keeps history; alerts + phone-on-charger guidance |
| Multi-phone Google account (`ErrHadMultipleDevices`) | Prompt 1 spike tests the real account first |
| AGPL-3.0 | Sidecar = separate AGPL program, arm's-length IPC; server/app licenses untouched |
| History depth = phone's local DB | Cache accretes forward from pairing day; set expectations |

**Non-goals (v1):** replacing the on-device Phone SMS section (it stays as the server-down
fallback); message-deletion sync (device-local in Google's design); Google Fi; running the
sidecar anywhere but next to bbd.
