# App ↔ Server Parity

_Generated 2026-07-01. Bidirectional API/feature reconciliation between the RN app (`~/github/bluebubbles-rn`) and the Gator server (`~/github/BB/bluebubbles-server`, master). Every mismatch below was grep-confirmed in the opposite repo (no false positives from path-format differences)._

**Directions:**
- **Server → App** = the server exposes it, the app doesn't use it (untapped capability).
- **App → Server** = the app calls/expects it, the server doesn't provide it (would fail, silently no-op, or is already stubbed in-app).

**44 surface items match** on both sides (the core messaging, sync, group management, FaceTime, Find My, stats, and restart/logs flows all line up).

## App → Server (does the app call anything the server can't serve?)

**No user-facing breakage.** 0 broken, 3 harmless/degraded. Every app call resolves to a real server route, except these — all already guarded in-app or dead subscriptions:

| Severity | Capability | Detail |
|---|---|---|
| ⚪ Harmless (CONFIRMED) | realtime event: imessage-aliases-removed (socket-listen + fcm-event + notification intent) | App subscribes to 'imessage-aliases-removed' in SERVER_EVENTS (constants.ts:44, wired via the socket.on loop socketService.ts:168-172), normalizes it in eventRouter.ts:117-121 (passthrough, no zod schema), and has a case in notifications/intents.ts:87. The Gator server NEVER emits it: it is absent from DomainEvents/DOMAIN_EVENT_NAMES (events.ts) and grep across the entire server repo returns 0 hits. The subscription/handler is dead code that will never fire against this server. |
| ⚪ Harmless (CONFIRMED) | http-call: GET /server/update/check (checkUpdate) | App's checkUpdate() in src/core/api/endpoints/server.ts returns Promise.reject(new UnimplementedEndpointError('/server/update/check')) and is never issued to the server; the Gator server registers no such route. Already guarded in-app so it can never 404 the server. |
| ⚪ Harmless (CONFIRMED) | http-call: POST /findmy/friends/refresh with GET fallback | App refreshFriends() POSTs /findmy/friends/refresh then falls back to GET /findmy/friends if empty. The server DOES register /api/v1/findmy/friends/refresh (findmyOperations.ts:31), so this is a MATCH, not a mismatch — listed only to note the app's defensive fallback is unnecessary against Gator. No action. |

## Server → App (capabilities the server has but the app doesn't use)

27 untapped server capabilities. Most are admin/config/diagnostics of low mobile value or local-console-only; the genuinely app-relevant ones are ranked High/Medium.

| Priority | Capability | Detail |
|---|---|---|
| 🔴 High (CONFIRMED) | admin-channel: set-config (adminOnly, local-only) | POST /admin/command {channel:'set-config'} — full config write (password, tokens, server address, TLS mode). App never calls it (grep 0 hits). High user value for an in-app server-settings screen, but gated to x-bbd-local-auth so remote App calls get 403 — surfacing needs local console. |
| 🔴 High (CONFIRMED) | admin-channel: get-config | POST /admin/command {channel:'get-config'} — read config (secrets stripped, snake_cased), NOT admin-only, remote-readable. App has zero hits. Would power a read-only server-settings/status view in-app. |
| 🔴 High (CONFIRMED) | socket-emit: message-send-error | Server forwards the helper's message-send-error (outgoing message failed in Messages). App's SERVER_EVENTS list does NOT include it (0 hits) — the app never surfaces send failures pushed from the server; it relies solely on its own optimistic-send/retry queue. Real user-facing gap: a server-detected send failure is invisible in-app. |
| 🟡 Medium (CONFIRMED) | admin-channel: get-fcm-status / set-fcm-server / clear-fcm / set-fcm-oauth-client / start-firebase-setup / get-firebase-setup-status | FCM/Firebase provisioning + status channels. App never reads even get-fcm-status (0 hits). get-fcm-status is read-only/remote-readable and could confirm push is configured before the app relies on FCM delivery; the write/setup ones are admin-only local-console. |
| 🟡 Medium (CONFIRMED) | admin-channel: get-private-api-status / get-private-api-requirements / reinject-helper | Read Messages+FaceTime helper connected/enabled flags + requirements checklist; reinject-helper relaunches the apps (admin-only). App references reinject-helper only in a code comment, never invokes any (0 real hits). get-private-api-status would let the app gate effects/edit/unsend/reactions UI on actual helper connectivity instead of just serverInfo.private_api. |
| 🟡 Medium (CONFIRMED) | admin-channel: check-permissions / get-current-permissions / contact-permission-status / request-contact-permission | macOS permission status + contact-permission request. App has 0 hits. Useful for an onboarding/diagnostics screen to tell the user the server is missing Full Disk / Contacts access. |
| 🟡 Medium (CONFIRMED) | admin-channel: get-alerts / clear-alerts / mark-alerts-as-read | In-memory server alert log (read + clear/mark-read, all NOT admin-only, remote-invokable). App has 0 hits. Could surface server-side warnings (helper crashes, auth failures) in the app. |
| 🟡 Medium (CONFIRMED) | admin-channel: get-env | POST /admin/command {channel:'get-env'} — version/platform/node/findmyNeedsKeys/isMinMonterey. Read-only, remote-readable. App has 0 hits; findmyNeedsKeys would let the app tell the user Find My decryption keys aren't imported before showing empty FindMy tabs. |
| 🟡 Medium (CONFIRMED) | admin-channel: Find My key mgmt — get-findmy-keys-status / import-findmy-keys | get-findmy-keys-status (read, remote) + import-findmy-keys (admin-only write). App has 0 hits. get-findmy-keys-status pairs with get-env findmyNeedsKeys to explain empty FindMy device/item lists. |
| 🟡 Medium (CONFIRMED) | admin-channel: device management — get-devices / purge-devices | get-devices (read registered push devices, remote-readable) + purge-devices (destructive, admin-only). App registers via POST /devices but never lists or purges (0 hits). get-devices could show the user which devices are receiving push. |
| 🟡 Medium (CONFIRMED) | REST: GET /api/v1/devices (list-devices) + DELETE /api/v1/devices/:id (remove-device) | Dedicated REST device list/remove. App only POSTs /devices to register (grep: POST only, no GET/DELETE). Same use case as get-devices/purge-devices admin channels — manage this device's push registration / clean up stale tokens. |
| 🟡 Medium (CONFIRMED) | REST: GET /api/v1/contact (get-contacts, all address-book contacts) | Returns the full server address book. App only calls POST /contact/query (by-address lookup), never the bulk GET (0 hits for GET /contact). Could seed a server-side contact directory instead of per-address queries. |
| 🟡 Medium (CONFIRMED) | REST: POST /api/v1/handle/query (get-handles) | Paginated list of all handles/addresses. App has 0 hits for /handle/query. Could bootstrap the handle table on first sync rather than deriving handles from messages. |
| 🟡 Medium (CONFIRMED) | socket-emit: group-icon-changed / group-icon-removed | Server forwards helper group-icon add/change/remove events. App SERVER_EVENTS omits both (0 hits), so a group photo change won't refresh the app's group avatar in realtime (only on next full resync). |
| 🟡 Medium (CONFIRMED) | socket-emit: new-server | emitToAuthed('new-server', url) when the zrok tunnel URL changes. App does not listen (0 hits, not in SERVER_EVENTS). The app would keep using a stale URL after the tunnel rotates until manual reconnect. |
| ⚪ Low (CONFIRMED) | REST + admin-channel: webhooks (create/list/delete + get-webhooks/create-webhook/delete-webhook/update-webhook) | POST/GET/DELETE /api/v1/webhook and the 4 webhook admin channels. App has ZERO webhook references anywhere. Entirely untapped; low direct value to a mobile client (webhooks are server-to-server integrations). |
| ⚪ Low (CONFIRMED) | admin-channel stats: get-group-message-counts / get-best-friend / get-chat-image? already used; unused = get-group-message-counts, get-best-friend | App consumes 8 count channels (message/chat/handle/attachment/image/video/location) but NOT get-group-message-counts or get-best-friend. Both read-only/remote-readable. Fun 'stats' screen material. |
| ⚪ Low (CONFIRMED) | admin-channel: zrok tunnel — get-zrok-status / set-zrok-token / start-zrok / disable-zrok / register-zrok-email | Zero-config tunnel management. get-zrok-status is read-only/remote-readable (running/url/available); the rest are admin-only local. App has 0 hits. get-zrok-status could show the app the current public URL / tunnel health. |
| ⚪ Low (CONFIRMED) | admin-channel: TLS/ACME — get-tls-status / enable-tls / disable-tls / issue-letsencrypt | TLS status (read, remote) + enable/disable/issue-cert (admin-only). App has 0 hits. Low mobile value beyond a read-only 'connection is TLS' indicator via get-tls-status. |
| ⚪ Low (CONFIRMED) | admin-channel: Web Push — get-vapid-public-key / generate-vapid-keys / set-webpush-subject / disable-webpush | VAPID/Web Push config. App is FCM-only and has 0 hits. Irrelevant to an Android/FCM RN client. |
| ⚪ Low (CONFIRMED) | REST: GET /api/v1/config (get-config REST) | Auth-required sanitized server config over REST (distinct from the admin-channel get-config). App uses /server/info but never GET /config (0 hits). Exposes settings like private_api/tutorial state the app currently can't read over REST. |
| ⚪ Low (CONFIRMED) | REST: POST /api/v1/admin/config (admin-update-config) + GET /api/v1/admin/status | Dedicated admin config-write + status (version, uptimeMs) REST ops (separate from /admin/command). App has 0 hits for /admin/config or /admin/status. admin/status uptime could feed a server-health indicator. |
| ⚪ Low (CONFIRMED) | admin-channel: Cloudflare DDNS — cloudflare-ddns-sync-now / get-public-ip / save-lan-url | DDNS sync (admin), get-public-ip (read, remote), save-lan-url (admin). App has 0 hits. get-public-ip could help the app suggest an external server address. |
| ⚪ Low (CONFIRMED) | admin-channel: toggle-tutorial | Admin-only tutorial flag toggle (routes through set-config). App has 0 hits. Negligible mobile value. |
| ⚪ Low (CONFIRMED) | socket-emit: config-update | Server broadcasts a config snapshot to the authed room on settings/TLS/tunnel changes. App never listens (0 hits). Would let the app react to a live server-address (new-server) or settings change without reconnecting. |
| ⚪ Low (CONFIRMED) | socket-emit: scheduled-message-update | Server emits null signal when a scheduled message is created/updated/deleted (client should refetch). App does not listen (0 hits); its scheduled-message list won't live-update from server-side changes made elsewhere. |
| ⚪ Low (CONFIRMED) | socket-emit: firebase-setup-status | Server emits Firebase/OAuth provisioning progress to the authed room. App does not listen (0 hits). Only relevant if the app drove Firebase setup, which it does not. |

## Bottom line

- **App → Server: clean.** The app never calls anything the server can't handle — nothing would 404 a user. The only drift is the app being wired for the `imessage-aliases-removed` realtime event that this server never emits (dead listener; the *server* is what's missing the emission), plus an already-stubbed `checkUpdate`.
- **Server → App: large untapped surface.** The app uses the core data/action APIs fully but ignores most of the server's admin/config/diagnostics + several realtime events. The highest-value gaps to wire into the app:
  1. **`message-send-error`** socket event — the server pushes outgoing-send failures the app currently ignores (a failed send only surfaces via the app's own retry queue).
  2. **Realtime `group-icon-changed` / `group-icon-removed` / `new-server` / `scheduled-message-update`** — the app misses live group-avatar changes, tunnel-URL rotation, and externally-changed scheduled messages until a resync.
  3. **Diagnostics reads** (`get-private-api-status`, `get-env`→`findmyNeedsKeys`, `get-findmy-keys-status`, `get-fcm-status`, `get-alerts`, `get-config`) — would power an in-app Server Health / Settings screen and explain empty Find My tabs / disabled effects.
- **Not worth wiring** (low mobile value / local-console-only): webhooks, zrok/TLS/VAPID/Cloudflare management, `set-config` writes (all admin-only, 403 to remote clients).
