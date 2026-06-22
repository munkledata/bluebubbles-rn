# Security & Functional Audit — BlueBubbles RN app ↔ Gator server

**Date:** 2026-06-21
**Scope:** `bluebubbles-rn` (React Native / Expo SDK 56 client) and `BB/bluebubbles-server` ("Gator", Node/Electron server, logic in `packages/bbd`)
**Method:** Multi-agent review across 9 dimensions (auth, injection, crypto/keys, network/SSRF, secrets/logging, wire-contract, realtime, app smells, server smells). **Every finding was independently re-checked by an adversarial verifier** that read both sides of the wire. 50 findings survived verification; 1 was refuted.

---

## Bottom line

The two are **more broken functionally than they are insecure.** As shipped, the app and Gator do **not** work together for several core messaging flows — most importantly, **real-time message delivery and push notifications are silently dropped** (only periodic sync works). Security is reasonable for a self-hosted single-user bridge — injection, SQLi, path-traversal, CORS, and client URL handling are genuinely well-hardened — with a handful of sharp edges.

**Overall risk: elevated**, driven mainly by the functional breakage.

**Root cause that recurs:** the existing "wire-contract gate" only validates *response envelopes* and *hydrated read shapes*, so request-body shapes and live socket/FCM shapes regress invisibly — the "jest-green hides device divergence" seam.

---

## Findings index

| # | Sev | Area | Finding |
|---|-----|------|---------|
| F1 | 🔴 CRIT | functional | Live socket/FCM messages carry no chat association → every realtime message + push silently dropped |
| F2 | 🔴 CRIT | functional | `send-reaction` field-name mismatch → every tapback 400s |
| F3 | 🟠 HIGH | functional | `send-text` body key `message` vs server `text` → **blank message sent (fails open)** |
| F4 | 🟠 HIGH | functional | `edit-message` omits `chatGuid`/`editedText` → 400, silent revert |
| F5 | 🟠 HIGH | functional | `unsend-message` omits `chatGuid` → 400 |
| F6 | 🟠 HIGH | functional | `send-attachment` multipart vs server JSON-base64 (no multipart parser) → fails |
| F7 | 🟠 HIGH | functional | EventRouter dedup keyed on `type:guid` drops live edits/receipts/unsends |
| F8 | 🟠 HIGH | security | Brute-force lockout bypassed on attachment route + socket handshake |
| F9 | 🟠 HIGH | security | Admin config-write paths return AND broadcast every server secret in plaintext |
| F10 | 🟠 HIGH | security | `SecureVault` `WHEN_UNLOCKED` is an iOS no-op on Android-only app (no user-auth binding) |
| F11 | 🟠 HIGH | server | Scheduler can double-send a real iMessage (no atomic claim) |
| F12 | 🟡 MED | functional | `ping` parsed as string, server returns `{pong:true}` → always "unreachable" |
| F13 | 🟡 MED | functional | Typing: event-name + payload-key mismatch → typing never relayed |
| F14 | 🟡 MED | functional | Server-management endpoints (restart/logs/stats/update) have no routes → 404 |
| F15 | 🟡 MED | security | No authorization tier — shared sync password = full server admin |
| F16 | 🟡 MED | security | WebPush endpoint SSRF (no allow-list, unlike webhook path) |
| F17 | 🟡 MED | security | zrok tunnel re-exposes admin SPA + defeats `isLoopback(request.ip)` guard |
| F18 | 🟡 MED | security | Config DB stores all credentials plaintext, protected only by `chmod 0600` |
| F19 | 🟡 MED | server | No `unhandledRejection` handler + fire-and-forget ingestion → daemon can crash |
| F20 | 🟢 LOW | functional | FindMy `refreshDevices` POSTs a non-existent route |
| F21 | 🟢 LOW | functional | `Chat.style` strict `z.union([43,45])` fails whole page parse on other values |
| F22 | 🟢 LOW | security | Headless FCM lock gate fails **open** on a vault read error (content leak) |
| F23 | 🟢 LOW | security | Attachment streamer follows symlinks (containment on lexical path, not realpath) |
| F24 | 🟢 LOW | security | Cleartext `http://` not enforced; `isCleartext` is dead code (OS-mitigated; UX/dead-code) |
| F25 | 🟢 LOW | quality | Log-redaction URL key set narrower than structured key set |
| F26 | 🟢 LOW | quality | Server logger has no redaction layer (fragile invariant) |
| F27 | 🟢 LOW | quality | RateLimiter map grows unbounded for one-off failures |
| F28 | 🟢 LOW | quality | Home-screen stats run full-table scans synchronously on the event loop |
| F29 | 🟢 LOW | quality | osascript fallback doesn't handle a stdin write error |
| F30 | 🟢 LOW | quality | Background-sync task swallows all errors with no log |
| F31 | 🟢 LOW | quality | Cross-transport dedup (socket+FCM) is a no-op (separate router instances) |
| F32 | 🟢 LOW | docs | AGENTS.md `db.run`-throws and `WHEN_UNLOCKED` claims are inaccurate |

---

## 1. Functional — the app and server disagree on the wire

### F1 🔴 Real-time delivery & push are silently dropped
`server/packages/bbd/src/serialize/messageFanout.ts:22-30`, `data/imessage/MessageReader.ts:84-101` · app `src/services/realtime/dbEventSink.ts:41-55`, `src/db/repositories/messages.ts:24-27`, `src/services/notifications/intents.ts:19-20`

The server's **live** fanout serializes the raw `chat.db` row with **no chat association** (`MessageReader.readSince` selects only `message`-table columns; `serializeMessage` only emits `chats[]`/`handle` when given hydrated `extra`, which the live path doesn't pass). The app routes a message to its conversation **only** via `message.chats?.[0]?.guid`; with no chat, `upsertMessages` filters the row out (never written to DB) and `buildMessageIntents` returns `[]` (no notification). The killed-app FCM wake hits the same drop. The **sync** path hydrates chats, so messages only appear on the next periodic/reconnect sync.

**Fix:** hydrate chat (+ sender handle) into the live fanout exactly like the sync path, and/or emit a top-level `chatGuid`; add an app-side fallback so a chats-less message isn't discarded.

### F2 🔴 / F3–F6 🟠 Send-path wire mismatches
- **F2 send-reaction** (`src/core/api/endpoints/messages.ts:123-133`): app sends `selectedMessageGuid`/`reaction`; server requires `chatGuid`/`messageGuid`/`reactionType` → 400 on every tapback.
- **F3 send-text** (`messages.ts:68-80`): app sends body key `message`; server reads `text` (`.optional()`) → validation passes, server sends `input.text ?? ''` → **blank message delivered, no error.** Most dangerous because it fails open.
- **F4 edit-message** (`messages.ts:148-156`): omits required `chatGuid`, sends `editedMessage` not `editedText` → 400, optimistic edit reverted.
- **F5 unsend-message**: omits required `chatGuid` → 400.
- **F6 send-attachment** (`src/core/api/endpoints/attachments.ts:25-37`): app sends `multipart/form-data`; server only accepts JSON `{name, data: base64}` and registers no multipart parser → 415/400.

**Fix:** align each request body to the server zod schema; plumb `chatGuid` through edit/unsend; encode attachments as base64 JSON. Verify F3 on a live host (silent).

### F7 🟠 EventRouter dedup drops live updates
`src/core/realtime/eventRouter.ts:64-76` — dedup key `type:guid` with no state component; only the first `updated-message` per guid reaches the sink, so read receipts/edits/unsends/tier-flips are dropped. **Fix:** restrict dedup to `new-message` (the DB upsert's `COALESCE` is idempotent), or fold `dateEdited/dateRetracted/dateRead/dateDelivered` into the key.

### F12–F14, F20–F21 — smaller contract breaks
- **F12 ping** (`src/core/api/endpoints/server.ts:6-8`): `z.string()` vs `{pong:true}` → Server-Management screen always "unreachable."
- **F13 typing** (`src/services/index.ts:348-350`): `started-typing`/`stopped-typing` + `{chatGuid}` vs server `start-typing`/`stop-typing` + `{guid}`.
- **F14 server-management** routes (restart/logs/statistics/update/imessage-restart) don't exist → 404; the screen mislabels it as a connection error.
- **F20 FindMy** `refreshDevices` POSTs `/findmy/devices/refresh` (only `friends/refresh` exists).
- **F21 Chat.style** strict `z.union([43,45])` fails the whole page parse on a non-standard value.

---

## 2. Security

### 🟠 HIGH
- **F8 Rate-limit bypass** — `server/.../attachmentRoutes.ts:21-27`, `socketAdapter.ts:55-69`. The `RateLimiter` only guards the REST op path; the attachment route is an unthrottled 401-vs-404 password oracle on the public `0.0.0.0` TLS listener, and the socket handshake offers free retries via reconnect. **Fix:** route all three surfaces through one rate-limited helper; uniform 404 on the attachment route.
- **F9 Admin config-write leaks all secrets** — `server/.../adminCommandOperations.ts:88-101`, `adminOperations.ts:32-37`. `sanitizeConfig` is applied to reads but skipped on writes; `set-config` returns and **broadcasts to `AUTHED_ROOM`** the FCM private key, Cloudflare/zrok tokens, OAuth secret, VAPID key. **Fix:** sanitize both write paths before return + broadcast.
- **F10 SecureVault iOS no-op on Android** — `src/native/secureVault.ts:10-12`. `keychainAccessible: WHEN_UNLOCKED` is ignored on Android; `requireAuthentication` is never set, so the SQLCipher key has no user-presence binding. *(Secrets are still AES-256-GCM at rest via a Keystore/TEE key, so a passive image yields ciphertext; the gap is root/UID-level access. Reasonable as Medium–High.)* **Fix:** see §4 note — enabling `requireAuthentication` breaks headless push, so this is a deliberate decision, not a blind toggle; at minimum correct the docs.
- **F11 Scheduler double-send** — `server/.../scheduled/Scheduler.ts:34-59`. No atomic claim; a send slower than the 15s tick gets re-sent (un-undoable duplicate iMessage). **Fix:** `UPDATE … SET status='sending' WHERE id=? AND status='pending'` claim + startup reset.

### 🟡 MEDIUM
- **F15 No authz tier** — the shared sync password every phone holds *is* full server admin. Structural enabler behind F9/F16. **Fix:** gate destructive admin channels behind the local-trust token or a separate admin credential.
- **F16 WebPush SSRF** *(gated behind `webpush.enabled`+VAPID)* — `server/.../webpush/WebPushSender.ts:51`. Endpoint validated only as `z.string().url()`, then POSTed with no host allow-list (the webhook path has `isPublicHttpUrl`; webpush doesn't). **Fix:** reuse `isPublicHttpUrl` at registration + dispatch.
- **F17 zrok exposes admin UI / defeats loopback guard** — `server/.../backend.ts:267-283`. The tunnel forwards public traffic to the loopback listener (which serves the admin SPA + `/oauth/callback`), and `request.ip` is `127.0.0.1` for same-host tunnel traffic so `isLoopback` is bypassed. **Fix:** point tunnels at a `withUi:false` API-only listener; never use `request.ip` as a trust boundary behind a same-host proxy.
- **F18 Config DB plaintext** — `server/.../config-db/DrizzleConfigStore.ts`. All creds plaintext, protected only by `chmod 0600`. **Fix:** move long-lived cloud creds into the macOS Keychain (larger follow-up); document backup exclusion.
- **F19 Daemon crash on transient error** — no `unhandledRejection` handler + fire-and-forget ingestion calls; a transient `chat.db`/disk error on the per-message path can crash the daemon. **Fix:** non-exiting global handler + `.catch` on each ingestion site.

### 🟢 LOW
- **F22 Headless FCM lock gate fails open** — `src/services/notifications/fcmMessaging.ts:40-55`; a vault read throw delivers full content on a locked device. **Fix:** treat the catch as locked.
- **F23 Symlink-follow in attachment streamer** — `realpathSync` + re-assert containment.
- **F24 Cleartext `http://` not enforced** — `isCleartext` is dead code; an `http://` origin is accepted. *Android `usesCleartextTraffic=false` blocks it at the OS layer, so this is primarily dead-code + bad error UX, not a live credential leak.* **Fix:** wire `isCleartext` into connect/QR; correct the misleading comment.
- **F25 Redaction key-set asymmetry** — URL redaction strips fewer keys than structured redaction; latent. **Fix:** share one key list.
- **F26 Server logger no redaction layer** — relies on callers never passing secrets.

---

## 3. Robustness / code smells
- **F27** RateLimiter map grows unbounded — prune entries below threshold.
- **F28** Home-screen stats run full-table scans synchronously on the event loop.
- **F29** osascript fallback doesn't handle a stdin write error (EPIPE).
- **F30** Background-sync task swallows all errors with no log.
- **F31** Cross-transport dedup is a no-op (socket and FCM use separate router instances / `seen` sets).
- **F32** AGENTS.md `db.run`-throws gotcha is wrong for the raw-SQL path; `WHEN_UNLOCKED` claim is inaccurate — correct both.

---

## 4. What's genuinely solid (verified clean)
This is a deliberately *hardened* fork. Verified correct:
- **No command/script injection** — `execFile("osascript", ["-", ...args])` + positional argv + JSON-over-UDS.
- **No SQL injection** — all readers parameterized; identifiers from allow-lists; chat.db read-only.
- **Attachment path-traversal blocked** — resolve-then-containment; URL `:guid` is only a bound SQL param.
- **Private-API helper** — 0600 UDS, constant-time secret + version handshake, bounded framing.
- **Client URL/scheme handling** — FaceTime whitelist, URL-preview SSRF guard with per-redirect revalidation, default-deny `safeOpenUrl`.
- **No permissive CORS**; tight CSP on served HTML.
- **App backup can't leak secrets**; **app log redaction** scrubs Bearer/password/token before all sinks.
- **Auth integration** — single injection point, constant-time `safeEqual`, socket/REST parity, validate-before-persist.
- App **concurrency** (claim/lease), React-free `core/`, and memo/list patterns reviewed clean.

> **Note on F10 (`requireAuthentication`):** enabling Android `requireAuthentication` on the DB key would require user auth for *every* Keystore op, which **breaks the headless-FCM-while-locked decrypt path** (the very thing F1 fixes). This is a product tradeoff, not a blind toggle. The conservative fix applied here corrects the inaccurate docs and documents the decision; enabling key-custody is left for an explicit product decision.

---

## 5. Prioritized plan
1. **Fix live realtime fanout** (F1) — restores incoming messages + push.
2. **Align write-op request bodies** (F2–F6) — restores send/react/edit/unsend/attachment. Verify send-text on a live host.
3. **Stop deduping `updated-message`** (F7).
4. **Sanitize admin config-write paths** (F9).
5. **Centralize the three password surfaces** (F8).
6. **Add an admin privilege tier** (F15).
7. **Tunnel → API-only listener; stop trusting `request.ip`** (F17).
8. **Android `requireAuthentication` decision** (F10).
9. **Server `unhandledRejection` + `.catch`** (F19).
10. **Atomic claim in the scheduler** (F11).
11. Cheap hardening: WebPush `isPublicHttpUrl` (F16); wire `isCleartext` (F24); align redaction (F25); + the LOW items.

**Recurrence prevention:** extend the contract-test gate to feed the *actual outgoing request JSON* through the server's zod input schemas, and to route the *bare live-wire `serializeMessage` shape* through `EventRouter→DbEventSink`.

---

## 6. Coverage gaps (need live-host validation)
- Send-text empty-body (F3) fails silently — must be confirmed on a live Gator + macOS host.
- The macOS BlueBubbles-helper dylib isn't in this repo — helper-sourced live event shapes (typing/read-status/group/facetime) need on-device validation.
- WebPush SSRF exploitability/gating and the cross-transport dedup double-alert want one device check each.
- DNS-rebinding residual on webhook/WebPush isn't catchable from JS.
- The `db.run`-on-device claim and crypto/SQLCipher self-tests want one empirical device check before rewriting project memory.

---

## 7. Status after the 2026-06-21 fix pass

All findings F1–F32 were addressed and merged to `master` in both repos. Verification at merge time:
**app** `tsc --noEmit` clean + 96 suites / 487 tests; **server** `tsc --noEmit` clean + 249 tests
(both with new tests covering the live-fanout hydration, send-path bodies, rate-limit oracle removal,
scheduler claim, and WebPush SSRF guard).

**Deferred / decision items (tracked in [REMAINING_WORK.md](./REMAINING_WORK.md) §6 and the server's `AUDIT_FOLLOWUPS.md`):**
- **F10 — Android `requireAuthentication`:** intentionally left OFF (would break headless-FCM-while-locked
  decrypt = the F1 path). Docs corrected; needs a product decision on key custody vs. push.
- **F18 — server config secrets → macOS Keychain:** ✅ **DONE (2026-06-22).** The 5 cloud credentials now
  live in the macOS Keychain (`VaultedConfigStore` + `MacKeychainSecretStore`), redacted from `config.db`
  with verify-before-redact + VACUUM purge; the server `password` stays with `chmod 0600`. Verified by 265
  tests, an adversarial review, and an end-to-end proof against the live DB. Remaining: validate no Keychain
  ACL prompt on a packaged/launchd build (5s timeout already prevents a boot hang). See
  `bluebubbles-server/AUDIT_FOLLOWUPS.md`.

**Must be confirmed on a live Gator + macOS host (static review can't):** F3 send-text (fails open → verify
real text arrives), F1 realtime (message persists AND notifies on device), F17 tunnel (admin SPA/oauth NOT
reachable through a real zrok tunnel), F19 (daemon survives a transient chat.db error).
