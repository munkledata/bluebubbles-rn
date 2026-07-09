# Remaining work

> **STATUS UPDATE (2026-06-30):** Several items closed since this was written — **settings search,
> download-concurrency config, seeded redacted avatars, and client error-code assignment on send
> failures are now DONE**, and `master` is already pushed and in sync with origin (the "push master"
> item is stale). Still open: scheduled recurrence, server-update install, QR display, and the socket
> `refreshUrl` failover (needs `@react-native-firebase/database` + a `ServerUrlResolver` wire-up);
> credential/native-gated: Sentry, Find My embedded map, Tasker receiver.

_Living checklist of what's NOT yet done, as of 2026-06-21 (after merging the parity Phases 1–3
to master). See [ROADMAP.md](./ROADMAP.md) for the full feature plan and [COMPARISON.md](./COMPARISON.md)
for the RN-vs-Flutter gap analysis._

## 1. On-device / real-server verification (needs a device + a real Gator server)
Most of P0/P1/P2 + the parity phases are unit-tested and pass the gate, but the **dev-session bypass**
(`isDevServer()`) means many flows can only be *fully* exercised against a real server.
- [ ] **Adaptive-from-image theming** — install EAS dev build **`a4bb0781`** (links `react-native-image-colors`),
      run Metro, then chat-settings → "Generate theme from background". Build:
      https://expo.dev/accounts/bluegreengatorapps/projects/bluegreengatorappsmessages/builds/a4bb0781-741b-489d-bb64-0bb22de7890f
- [ ] **Chat background image layering** — confirm the message list stays transparent and bubbles
      stay readable (a scrim/textShadow was added; eyeball it).
- [ ] **Real-server smoke** of send / receive / sync / reactions / scheduled / server-management /
      Find My (the dev session fakes these).
- [ ] Native batches (audio/voice/file from P1) on-device.

## 2. Not yet built — ROADMAP Phase 4 (Settings & polish)
- [ ] Settings search (indexed `SearchableSettingItem`)
- [ ] Scheduled **recurrence UI** (the F-8 `ScheduleSpec` plumbing already exists)
- [ ] Configurable max-concurrent-downloads + image-preview-quality
- [ ] DiceBear-style fake avatars in redacted mode (local/deterministic, not the network service)
- [ ] Server update **install** (we have *check*; add `POST /server/update/install` + a button)
- [ ] QR pairing display in server management

## 3. Known code follow-ups
- [ ] **Socket `refreshUrl` resolver** — the reconnect escalation has a `refreshUrl` hook but it's
      not wired to a real `ServerUrlResolver` (none is instantiated in `src/`; no `fetchFromFirebase`
      impl yet). Escalation currently just reconnects to the same origin with backoff.
      (See project memory `socketio-reconnect-attempts-infinity`.)
- [ ] Errored-send "client error" titles (`errorTitleForCode` 10001–10008) aren't mapped from real
      JS/network errors yet (server codes work; client codes are aspirational).

## 4. Blocked on credentials / server-side setup (can't be done from the app side)
- [ ] 🔴 **Server-side Firebase** (service account + Realtime DB) so the server can SEND pushes — the
      FCM **client** is built, but killed-app push won't work until this is configured. **Biggest
      functional gap.**
- [ ] **Sentry** — needs a DSN.
- [ ] **Find My embedded map** — needs a Google Maps Android API key + `react-native-maps` + a rebuild
      (the `geo:` URL fallback ships today).
- [ ] Exported native **Tasker / automation receiver** (the hardened JS intent-gate is done; the
      native receiver isn't built).

## 5. In-flight / process
- [ ] **API-model sync with the server** — keep the app's zod models (`src/core/models/*`) aligned with
      `~/github/BB/bluebubbles-server` (which carries our server-side changes). Plan in progress.
- [ ] Decide whether to push `master` / open a PR (currently local only).

## 6. Post-audit open items (2026-06-21 security/functional audit)
_Most findings from [SECURITY_FUNCTIONAL_AUDIT_2026-06-21.md](./SECURITY_FUNCTIONAL_AUDIT_2026-06-21.md)
are FIXED and merged. These are the deliberate deferrals + the things static review can't close._

**Deferred — need a decision, not just code:**
- [ ] 🟠 **F10 — Android key custody.** `requireAuthentication` is intentionally OFF on the SQLCipher DB
      key / server password (`src/native/secureVault.ts`) because enabling it forces user-auth on every
      Keystore op and would **break headless-FCM-while-locked decrypt** (the F1 path). Decide: keep the
      current posture (app-lock is a UI/content gate; key released to the app UID without user-presence)
      OR enable real key custody and make headless pushes content-less until unlock. Docs already corrected.
- [x] ✅ **F18 — Server config secrets at rest** (server repo, done 2026-06-22). The 5 cloud creds
      (FCM service-account / OAuth secret / VAPID key / Cloudflare + zrok tokens) now live in the macOS
      Keychain (`VaultedConfigStore` + `MacKeychainSecretStore`), redacted from `config.db`. The server
      `password` intentionally stays (with `chmod 0600`). REMAINING: validate no Keychain ACL prompt on a
      packaged/launchd build; exclude the userData dir from Time Machine/iCloud. See
      `bluebubbles-server/AUDIT_FOLLOWUPS.md`.
- [x] ✅ **LAN-URL bug** (server repo, done 2026-06-22). `getLanIpv4()` was returning a virtual interface
      (`feth* 10.144.47.51`) instead of the real Wi-Fi LAN; now skips virtual interfaces.

**Needs live-host validation (fixed in code, unverifiable from static review):**
- [ ] 🔴 **F3 send-text** — fix renames the body key `message`→`text`; this previously **failed open**
      (blank message sent, no error). Send a real message against a live Gator+macOS host and confirm the
      recipient gets the actual text, not an empty bubble.
- [ ] 🔴 **F1 realtime** — confirm a socket/FCM-pushed message now BOTH persists to the DB AND posts a
      notification on-device (server hydration + app `chatGuid` fallback).
- [ ] 🟡 Helper-sourced live event shapes (typing / read-status / group / facetime) vs the app zod schemas —
      validate against the running Gator helper dylib (not in either repo).

**Recommended — recurrence prevention:**
- [ ] Extend the contract-test gate to (a) feed the **actual outgoing request JSON** through the server's
      zod input schemas and (b) route the **bare live-wire `serializeMessage` shape** (no embedded `chats[]`)
      through `EventRouter→DbEventSink`. Partially seeded by the new tests; make it a standing gate so
      request-body / live-wire drift can't regress invisibly again.
