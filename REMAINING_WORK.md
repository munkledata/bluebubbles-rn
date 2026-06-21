# Remaining work

_Living checklist of what's NOT yet done, as of 2026-06-21 (after merging the parity Phases 1–3
to master). See [ROADMAP.md](./ROADMAP.md) for the full feature plan and [COMPARISON.md](./COMPARISON.md)
for the RN-vs-Flutter gap analysis._

## 1. On-device / real-server verification (needs a device + a real BlueBubbles server)
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
