# App ↔ Server Parity

_Generated 2026-07-01. Bidirectional API/feature reconciliation between the RN app (`~/github/bluebubbles-rn`) and the Gator server (`~/github/BB/bluebubbles-server`, master). Every mismatch below was grep-confirmed in the opposite repo (no false positives from path-format differences)._

**Directions:**
- **Server → App** = the server exposes it, the app doesn't use it (untapped capability).
- **App → Server** = the app calls/expects it, the server doesn't provide it (would fail, silently no-op, or is already stubbed in-app).

**44 surface items match** on both sides (the core messaging, sync, group management, FaceTime, Find My, stats, and restart/logs flows all line up).

## ✅ Closed (2026-07-01)

The top gaps have since been wired (app-side; the server already emitted these events):

- **`message-send-error`** — the app now subscribes (SERVER_EVENTS), normalizes it (EventRouter → `NormalizedEvent`), and the DB sink flips the referenced message to the error state (`markMessageSendError`) so a server-detected send failure shows the bubble's error badge + retry. Unit-tested.
- **`new-server`** (tunnel-URL rotation) — the app now subscribes and, via `ServerUrlEventSink` → `applyNewServerUrl`, scheme-validates the new URL, persists it to the vault, re-points the session origin (HTTP re-points automatically via the session accessors), and reconnects the socket — instead of silently hitting the stale URL until a manual reconnect.
- **Server Health screen** (Settings › SERVER › "Server Health…", and from Server Management) — surfaces the previously-untapped **remote-readable diagnostics** the server already exposed: Private-API helper connectivity (Messages + FaceTime), Find My key-import status (`get-findmy-keys-status` + `get-env` `findmyNeedsKeys`, explaining empty Find My tabs), push/FCM config (`get-fcm-status`), environment/uptime (`get-env` + `/admin/status`), tunnel + public IP + TLS (`get-zrok-status`/`get-public-ip`/`get-tls-status`), and the server alert log (`get-alerts` + Clear). No server change needed — all channels were already password-accessible.

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
  SERVER_EVENTS → EventRouter → DbEventSink; tombstone column (`date_deleted`) rather than hard
  delete (the server's sync paths keep returning Recently-Deleted rows for ~30 days, so a hard
  delete would resurrect); filtered out of every render/count/search query; the chat's
  denormalized inbox sort key is recomputed on delete. Residual (documented): a delete arriving
  while the app is dead/locked only reconciles via the live event — there is no sync-side signal.
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

## 📱 RCS bridge (Google Messages, server Prompts 5–8; app Prompt 7)

The Gator server's RCS bridge (a `libgm` sidecar) serves RCS chats through the **same frozen v1
endpoints** as iMessage, so the app needs no new sync pipeline — RCS traffic is deliberately
shaped like iMessage traffic. Prompt 7 made the app **accept + render** it; the send path is
Prompt 8.

| Direction | Item | Status |
|---|---|---|
| Server → App | `get-chats` returns RCS chats: guid `RCS;-;<id>`, `style` 45/43, participants `HandleV1{service:"RCS"}` | ✅ App accepts — `service` is an open `z.string()` (`ServiceType`), so RCS never fails the page parse; `KNOWN_SERVICES` now includes `'RCS'`. |
| Server → App | RCS `MessageV1` (`service:"RCS"`, `originalROWID:null`, ms dates, status on `isSent`/`isDelivered`/`isRead`) via `get-chat/:guid/message` + realtime `new-message`/`updated-message` | ✅ Flows through the existing chat-open backfill + `EventRouter` unchanged (no service filter drops it). |
| Server → App | RCS attachment bytes on the **separate** route `GET /api/v1/rcs/attachment/{mediaID}/download` | ✅ App branches on the owning chat's service — `attachmentDownloadUrl(http, guid, service)` builds `/rcs/attachment/…` when `service === 'RCS'`. Service is derived (chat-guid `LIKE 'RCS;-;%'` JOIN) onto `AttachmentRow`. |
| Server → App | `ServerInfoV1.rcs?: boolean` capability flag | ✅ Added to the `ServerInfo` zod model (nullish → older servers omit it, no throw); `sessionAccessors.rcsEnabled()` / `useRcsEnabled()` gate RCS-specific UI. |
| Server → App | `rcs-alert` realtime event (bridge health: `alertType` + message) | ✅ Subscribed (`SERVER_EVENTS`) + zod-normalized in `EventRouter`; `RcsAlertEventSink` maps it to a Server Health RCS row (`rcsHealth.ts`). |
| Server → App | `rcs-bridge-down` high-priority push (`{title, body, reason}`) | ✅ Subscribed + normalized; posts a content-less status notification (`intents.ts` → `notifeeService`), honoring the hide-preview toggle. |
| App UI | RCS bubble colour + badge | ✅ New `rcsBackground` teal token (distinct from iMessage blue + SMS green) across all presets; `MessageBubble` mirrors the SMS-green branch for `senderService === 'RCS'`; a subtle "RCS" `ServiceBadge` pill shows in `ConversationHeader` + `ConversationTile` (keyed off the `RCS;-;` guid). |

**Intentional non-alignments (RCS):**
- **RCS is deliberately NOT in `query-messages`** (server-side) — the incremental sync stays
  iMessage-only to protect the ROWID cursor. RCS chats hydrate via `get-chats` + the
  chat-messages endpoint and stay live via realtime events, so the app must **not** expect RCS
  to arrive through the incremental path. No app change needed (the app already backfills on
  chat-open); noted so a future sync refactor doesn't "fix" the missing RCS rows there.
- **Send: WORKS for existing RCS chats (this note was stale — re-verified 2026-07-17).** The
  server now routes `send-message`/`send-attachment`/`mark-chat-read`/typing by the `RCS;-;`
  guid prefix (`routesToRcs`, `actionOperations.ts`), the app's ack reconcile handles the RCS
  tempGuid-echo contract (`sendOutcome.ts`), and outgoing bubbles render teal (`MessageBubble`
  threads the chat's service via `chatService`). **The one remaining gap:** the new-chat screen's
  service toggle offers only iMessage | SMS — it never passes `service:'RCS'`, though `createChat`
  and the server's `new-chat` RCS branch (sidecar get-or-create) both support it.

## ⚠️ Intentionally NOT aligned (documented, no action)

These are genuine divergences, each for a concrete reason — not oversights:

- **`imessage-aliases-removed`** — the app is fully wired to handle it (listener + notification), but the **Gator server has no detection source** for Apple-ID alias deregistration (not even declared in `DomainEvents`; 0 hits server-wide). The app handler is harmless + forward-compatible with an upstream server that does emit it; adding a fake server emission with no real source would be misleading. Left as app-ready.
- **`scheduled-message-update`** — the server emits this for **server-side** scheduled messages; the RN app implements scheduling **locally** (device-side `runDueScheduled`/`scheduled_messages` table), so the server event doesn't map to the app's model. Architectural difference, not a gap.
- **`group-icon-changed` / `group-icon-removed`** — the app renders group avatars as **participant collages** (`GroupAvatar`) and does not display a server-supplied custom group photo, so there's nothing to refresh. Wiring it would be a no-op until group-photo display is added. Deferred with the (still-open) group-photo feature.
- **The remaining admin / config surface** (set-config/get-config writes, TLS/zrok/VAPID/Cloudflare **management**, webhooks, FCM **setup**, device purge) — still untapped by design: either **local-console-only** (403 to remote app clients) or **low mobile value**. The read-only **diagnostics** subset (private-API/keys/push/env/tunnel/TLS/alerts) is now surfaced by the **Server Health screen** (see Closed above). What remains are the *write*/management ops, which belong on the trusted local server console, not a remote app.

## App → Server (does the app call anything the server can't serve?)

**No user-facing breakage.** 0 broken, 3 harmless/degraded. Every app call resolves to a real server route, except these — all already guarded in-app or dead subscriptions:

| Severity | Capability | Detail |
|---|---|---|
| ⚪ Harmless (CONFIRMED) | realtime event: imessage-aliases-removed (socket-listen + fcm-event + notification intent) | App subscribes to 'imessage-aliases-removed' in SERVER_EVENTS (constants.ts:44, wired via the socket.on loop socketService.ts:168-172), normalizes it in eventRouter.ts:117-121 (passthrough, no zod schema), and has a case in notifications/intents.ts:87. The Gator server NEVER emits it: it is absent from DomainEvents/DOMAIN_EVENT_NAMES (events.ts) and grep across the entire server repo returns 0 hits. The subscription/handler is dead code that will never fire against this server. |
| ⚪ Harmless (CONFIRMED) | http-call: GET /server/update/check (checkUpdate) | App's checkUpdate() in src/core/api/endpoints/server.ts returns Promise.reject(new UnimplementedEndpointError('/server/update/check')) and is never issued to the server; the Gator server registers no such route. Already guarded in-app so it can never 404 the server. |
| ⚪ Harmless (CONFIRMED) | http-call: POST /findmy/friends/refresh with GET fallback | App refreshFriends() POSTs /findmy/friends/refresh then falls back to GET /findmy/friends if empty. The server DOES register /api/v1/findmy/friends/refresh (findmyOperations.ts:31), so this is a MATCH, not a mismatch — listed only to note the app's defensive fallback is unnecessary against Gator. No action. |

## Server → App (capabilities the server has but the app doesn't use)

27 untapped server capabilities *(snapshot from 2026-07-01; rows since wired are marked ✅ CLOSED in place — see the ✅ Closed sections above for the current truth)*. Most are admin/config/diagnostics of low mobile value or local-console-only; the genuinely app-relevant ones are ranked High/Medium.

| Priority | Capability | Detail |
|---|---|---|
| 🔴 High (CONFIRMED) | admin-channel: set-config (adminOnly, local-only) | POST /admin/command {channel:'set-config'} — full config write (password, tokens, server address, TLS mode). App never calls it (grep 0 hits). High user value for an in-app server-settings screen, but gated to x-bbd-local-auth so remote App calls get 403 — surfacing needs local console. |
| ✅ CLOSED 2026-07-01 (was 🔴 High — read via Server Health, see *✅ Closed* above) | admin-channel: get-config | POST /admin/command {channel:'get-config'} — read config (secrets stripped, snake_cased), NOT admin-only, remote-readable. App has zero hits. Would power a read-only server-settings/status view in-app. |
| ✅ CLOSED 2026-07-01 (was 🔴 High — see *✅ Closed* above) | socket-emit: message-send-error | *(Stale snapshot below — now wired via SERVER_EVENTS → EventRouter → `markMessageSendError`.)* Server forwards the helper's message-send-error (outgoing message failed in Messages). App's SERVER_EVENTS list does NOT include it (0 hits) — the app never surfaces send failures pushed from the server; it relies solely on its own optimistic-send/retry queue. Real user-facing gap: a server-detected send failure is invisible in-app. |
| ✅ get-fcm-status CLOSED 2026-07-01 (Server Health; write/setup channels still untapped — was 🟡 Medium) | admin-channel: get-fcm-status / set-fcm-server / clear-fcm / set-fcm-oauth-client / start-firebase-setup / get-firebase-setup-status | FCM/Firebase provisioning + status channels. App never reads even get-fcm-status (0 hits). get-fcm-status is read-only/remote-readable and could confirm push is configured before the app relies on FCM delivery; the write/setup ones are admin-only local-console. |
| ✅ get-private-api-status CLOSED 2026-07-01 (Server Health; reinject-helper still untapped — was 🟡 Medium) | admin-channel: get-private-api-status / get-private-api-requirements / reinject-helper | Read Messages+FaceTime helper connected/enabled flags + requirements checklist; reinject-helper relaunches the apps (admin-only). App references reinject-helper only in a code comment, never invokes any (0 real hits). get-private-api-status would let the app gate effects/edit/unsend/reactions UI on actual helper connectivity instead of just serverInfo.private_api. |
| 🟡 Medium (CONFIRMED) | admin-channel: check-permissions / get-current-permissions / contact-permission-status / request-contact-permission | macOS permission status + contact-permission request. App has 0 hits. Useful for an onboarding/diagnostics screen to tell the user the server is missing Full Disk / Contacts access. |
| ✅ CLOSED 2026-07-01 (get-alerts + Clear via Server Health — was 🟡 Medium) | admin-channel: get-alerts / clear-alerts / mark-alerts-as-read | In-memory server alert log (read + clear/mark-read, all NOT admin-only, remote-invokable). App has 0 hits. Could surface server-side warnings (helper crashes, auth failures) in the app. |
| ✅ CLOSED 2026-07-01 (Server Health — was 🟡 Medium) | admin-channel: get-env | POST /admin/command {channel:'get-env'} — version/platform/node/findmyNeedsKeys/isMinMonterey. Read-only, remote-readable. App has 0 hits; findmyNeedsKeys would let the app tell the user Find My decryption keys aren't imported before showing empty FindMy tabs. |
| ✅ get-findmy-keys-status CLOSED 2026-07-01 (Server Health; import-findmy-keys still untapped — was 🟡 Medium) | admin-channel: Find My key mgmt — get-findmy-keys-status / import-findmy-keys | get-findmy-keys-status (read, remote) + import-findmy-keys (admin-only write). App has 0 hits. get-findmy-keys-status pairs with get-env findmyNeedsKeys to explain empty FindMy device/item lists. |
| 🟡 Medium (CONFIRMED) | admin-channel: device management — get-devices / purge-devices | get-devices (read registered push devices, remote-readable) + purge-devices (destructive, admin-only). App registers via POST /devices but never lists or purges (0 hits). get-devices could show the user which devices are receiving push. |
| 🟡 Medium (CONFIRMED) | REST: GET /api/v1/devices (list-devices) + DELETE /api/v1/devices/:id (remove-device) | Dedicated REST device list/remove. App only POSTs /devices to register (grep: POST only, no GET/DELETE). Same use case as get-devices/purge-devices admin channels — manage this device's push registration / clean up stale tokens. |
| 🟡 Medium (CONFIRMED) | REST: GET /api/v1/contact (get-contacts, all address-book contacts) | Returns the full server address book. App only calls POST /contact/query (by-address lookup), never the bulk GET (0 hits for GET /contact). Could seed a server-side contact directory instead of per-address queries. |
| 🟡 Medium (CONFIRMED) | REST: POST /api/v1/handle/query (get-handles) | Paginated list of all handles/addresses. App has 0 hits for /handle/query. Could bootstrap the handle table on first sync rather than deriving handles from messages. |
| 🟡 Medium (CONFIRMED) | socket-emit: group-icon-changed / group-icon-removed | Server forwards helper group-icon add/change/remove events. App SERVER_EVENTS omits both (0 hits), so a group photo change won't refresh the app's group avatar in realtime (only on next full resync). |
| ✅ CLOSED 2026-07-01 (was 🟡 Medium — see *✅ Closed* above) | socket-emit: new-server | *(Stale snapshot below — now wired via `ServerUrlEventSink` → `applyNewServerUrl`.)* emitToAuthed('new-server', url) when the zrok tunnel URL changes. App does not listen (0 hits, not in SERVER_EVENTS). The app would keep using a stale URL after the tunnel rotates until manual reconnect. |
| ⚪ Low (CONFIRMED) | REST + admin-channel: webhooks (create/list/delete + get-webhooks/create-webhook/delete-webhook/update-webhook) | POST/GET/DELETE /api/v1/webhook and the 4 webhook admin channels. App has ZERO webhook references anywhere. Entirely untapped; low direct value to a mobile client (webhooks are server-to-server integrations). |
| ⚪ Low (CONFIRMED) | admin-channel stats: get-group-message-counts / get-best-friend / get-chat-image? already used; unused = get-group-message-counts, get-best-friend | App consumes 8 count channels (message/chat/handle/attachment/image/video/location) but NOT get-group-message-counts or get-best-friend. Both read-only/remote-readable. Fun 'stats' screen material. |
| ✅ get-zrok-status CLOSED 2026-07-01 (Server Health; mgmt channels still untapped — was ⚪ Low) | admin-channel: zrok tunnel — get-zrok-status / set-zrok-token / start-zrok / disable-zrok / register-zrok-email | Zero-config tunnel management. get-zrok-status is read-only/remote-readable (running/url/available); the rest are admin-only local. App has 0 hits. get-zrok-status could show the app the current public URL / tunnel health. |
| ✅ get-tls-status CLOSED 2026-07-01 (Server Health; enable/disable/issue still untapped — was ⚪ Low) | admin-channel: TLS/ACME — get-tls-status / enable-tls / disable-tls / issue-letsencrypt | TLS status (read, remote) + enable/disable/issue-cert (admin-only). App has 0 hits. Low mobile value beyond a read-only 'connection is TLS' indicator via get-tls-status. |
| ⚪ Low (CONFIRMED) | admin-channel: Web Push — get-vapid-public-key / generate-vapid-keys / set-webpush-subject / disable-webpush | VAPID/Web Push config. App is FCM-only and has 0 hits. Irrelevant to an Android/FCM RN client. |
| ⚪ Low (CONFIRMED) | REST: GET /api/v1/config (get-config REST) | Auth-required sanitized server config over REST (distinct from the admin-channel get-config). App uses /server/info but never GET /config (0 hits). Exposes settings like private_api/tutorial state the app currently can't read over REST. |
| ✅ GET /admin/status CLOSED 2026-07-01 (Server Health; admin config-write still untapped — was ⚪ Low) | REST: POST /api/v1/admin/config (admin-update-config) + GET /api/v1/admin/status | Dedicated admin config-write + status (version, uptimeMs) REST ops (separate from /admin/command). App has 0 hits for /admin/config or /admin/status. admin/status uptime could feed a server-health indicator. |
| ✅ get-public-ip CLOSED 2026-07-01 (Server Health; DDNS mgmt still untapped — was ⚪ Low) | admin-channel: Cloudflare DDNS — cloudflare-ddns-sync-now / get-public-ip / save-lan-url | DDNS sync (admin), get-public-ip (read, remote), save-lan-url (admin). App has 0 hits. get-public-ip could help the app suggest an external server address. |
| ⚪ Low (CONFIRMED) | admin-channel: toggle-tutorial | Admin-only tutorial flag toggle (routes through set-config). App has 0 hits. Negligible mobile value. |
| ⚪ Low (CONFIRMED) | socket-emit: config-update | Server broadcasts a config snapshot to the authed room on settings/TLS/tunnel changes. App never listens (0 hits). Would let the app react to a live server-address (new-server) or settings change without reconnecting. |
| ⚪ Low (CONFIRMED) | socket-emit: scheduled-message-update | Server emits null signal when a scheduled message is created/updated/deleted (client should refetch). App does not listen (0 hits); its scheduled-message list won't live-update from server-side changes made elsewhere. |
| ⚪ Low (CONFIRMED) | socket-emit: firebase-setup-status | Server emits Firebase/OAuth provisioning progress to the authed room. App does not listen (0 hits). Only relevant if the app drove Firebase setup, which it does not. |

## Bottom line

- **App → Server: clean.** The app never calls anything the server can't handle — nothing would 404 a user. The only drift is the app being wired for the `imessage-aliases-removed` realtime event that this server never emits (dead listener; the *server* is what's missing the emission), plus an already-stubbed `checkUpdate`.
- **Server → App: mostly wired now.** The app uses the core data/action APIs fully, and the previously-untapped realtime + diagnostics surface has largely been closed (see the *✅ Closed (2026-07-01)* section above): `message-send-error`, `new-server` (tunnel-URL rotation), and the admin/diagnostics reads (`get-private-api-status`, `get-env`→`findmyNeedsKeys`, `get-findmy-keys-status`, `get-fcm-status`, `get-alerts`, `get-config`) are now handled — the diagnostics reads are surfaced by the in-app **Server Health** screen. The only realtime events still unwired are the **intentional non-alignments** below, not gaps:
  1. **`group-icon-changed` / `group-icon-removed`** — the app renders participant-collage group avatars, so there's no server group photo to refresh (deferred with the group-photo feature).
  2. **`scheduled-message-update`** — the app schedules sends **locally**, so the server-side scheduled-message signal doesn't map to its model.
- **Not worth wiring** (low mobile value / local-console-only): webhooks, zrok/TLS/VAPID/Cloudflare management, `set-config` writes (all admin-only, 403 to remote clients).
