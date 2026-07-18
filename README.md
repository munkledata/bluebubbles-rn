# Gator RN

A ground-up **React Native + TypeScript** rebuild of the iMessage client
(originally Flutter/Dart). Android-only, iOS-styled UI, with the architectural and
security weaknesses of the original addressed from day one.

> Status: **Phase 9 — polish & release-readiness (in progress).** Builds on Phases 0–8. A multi-agent
> a11y/perf/resilience audit (34 findings) drove a focused pass: **CI** (`.github/workflows/ci.yml` runs
> typecheck + `prettier --check` + jest on push/PR, Node from `.nvmrc`); **`eas.json`** build profiles
> (dev / preview / production — internal APK / store AAB); a root **`ErrorBoundary`** mounted above the
> providers so a render throw shows a recoverable fallback instead of a white screen; an **accessibility
> sweep** (roles + labels on every icon button — send/attach/schedule/back/settings/search/reaction/
> close, the mute + suggested-replies switches, conversation tiles announce sender·unread·preview,
> avatars marked decorative); a **performance pass** — `React.memo` on `ConversationTile`, `MessageRow`,
> `MessageBubble`, `Avatar`, with the list callbacks made stable (`useCallback` for retry/long-press/
> open-chat) so the memos actually hold (rows no longer re-render on every composer/reply/selection state
> change — only on a real message change); and **resilience** (chat screen distinguishes a load *error*
> from *empty*, home catch-up + scheduled-delete failures no longer crash/silently fail). **260 unit
> tests** at the time of this snapshot (the suite has since grown — ~251 test files as of 2026-07-17)
> + typecheck + prettier all green. On-device (dev fixtures): boots through the error boundary,
> inbox + chat render, long-press → react → the tapback persists, send → optimistic bubble → the
> memoized list updates → a failed send surfaces "Not Delivered" + retry. Infra-blocked (need user
> credentials): EAS build/submit (Expo account), Sentry (DSN). (The embedded Find My map has since
> shipped keylessly — a Leaflet/OpenStreetMap WebView, `src/ui/findmy/FindMyMap.tsx` — so it is no
> longer Maps-API-key-blocked.) See `AGENTS.md` for gotchas.
>
> Status (prior): **Phase 8 — advanced features (message effects, FaceTime, Find My) complete & verified
> on-device.** Builds on Phases 0–7. Adds: **message effects** —
> incoming iMessage send-effects rendered with RN's built-in `Animated` (no Reanimated/Skia): bubble
> effects (slam/loud/gentle animate the bubble on arrival, invisible-ink hides the text behind a
> tap-to-reveal overlay) and full-screen effects (confetti/balloons/fireworks/… as JS particles driven
> by one native-driver `Animated` value, floating non-interactively over the chat and auto-dismissing);
> a pure `expressiveSendStyleId → effect` mapper (the 12 exact iMessage ids). **FaceTime** — an
> `incoming-facetime` / `ft-call-status-changed` event raises a Notifee call notification (Answer /
> Decline); Answer asks the server (`POST /facetime/answer/{uuid}`) for the FaceTime link and opens it
> with `expo-linking` (the link is scheme-validated; the caller honors the hide-preview toggle). **Find
> My** — a Devices/People screen (battery, last address, "Open in Maps" via a `geo:` URL) backed by the
> server endpoints, dev fixtures standing in for a real iCloud-connected Mac. All JS-only — **no native
> rebuild** (the `USE_FULL_SCREEN_INTENT` permission added to `app.config` applies on the next build;
> reminders/effects/Find My needed none). An adversarial multi-agent review then fixed four
> ship-blockers: the server-supplied FaceTime link is scheme-checked before `openURL`, the FaceTime
> caller is redacted under hide-preview, the screen-effect overlay no longer blocks chat touches, and
> `USE_FULL_SCREEN_INTENT` was declared; plus animation-cleanup on unmount and a back-to-back-effect
> race. A follow-up pass then added **sending effects** (pick a bubble/screen effect when composing),
> **revert-on-contact-delete** (a handle reverts to its server name when its device contact is removed),
> and lifted the per-chat message subscription to a single source; UnifiedPush was dropped. **260 unit
> tests** (the effect mapper, FaceTime intent mapping incl. status 4/6, Find My normalizers) against
> better-sqlite3; typecheck + expo-doctor (21/21) pass. On-device: a slam/invisible-ink bubble + a
> confetti/balloons shower play in a chat; an incoming-FaceTime notification answers; Find My lists
> devices + people. Server-only (not emulator-verifiable): a real FaceTime link + live Find My data.
> Tracked follow-ups: an embedded Find My map (since DONE — shipped as a Leaflet/OpenStreetMap
> WebView in `src/ui/findmy/FindMyMap.tsx`; needed NO `react-native-maps`, Google Maps API key, or
> rebuild). See `AGENTS.md` for gotchas.
>
> Status (prior): **Phase 7d — the remaining Phase-7 features (per-chat customization, backup/restore,
> reminders, rich-text mentions, suggested replies) complete & verified on-device.** Builds on
> Phases 0–7c. Adds: **per-chat customization** (tap the conversation header → set a custom name,
> a bubble accent color, or mute; local-only, kept out of `upsertChats`' conflict set so a server
> re-sync can't clobber it — migration `0005` adds `chats.custom_name`/`custom_color`); **backup &
> restore** (Settings → Backup exports your theme + settings + per-chat customizations as a JSON file
> via the share sheet and restores from pasted JSON; secrets are filtered out by construction —
> credentials live in the Keystore vault, never the export); **message reminders** ("Remind Me Later"
> on a long-pressed message → a Notifee inexact timestamp trigger that deep-links back; migration
> `0006` adds a `reminders` table; a Reminders screen lists/reschedules/cancels them); **rich-text
> mentions** (a pure parser turns a message's `attributedBody` into styled runs — @mentions in the
> accent color, with gap-filling so no text is ever dropped; scope-cut to mentions+links because
> the upstream format carries no bold/italic data); and **suggested replies** (rule-based chips above the
> composer when the last message is inbound, gated by a Settings toggle, behind a swappable
> `SmartReplyProvider` so on-device ML Kit can drop in later). All JS-only — **no native rebuild**
> (the two migrations run automatically). An adversarial multi-agent review then hardened the set:
> the rich-text parser now gap-fills uncovered text; every reminder call site surfaces failures
> (which caught the real bug — a current-minute pick is already past once seconds elapse, so the
> picker now clamps to a strictly-future timestamp Notifee accepts); `rescheduleReminder` schedules
> before cancelling (no orphaned rows); the backup cache file is deleted after sharing and the
> secret-key filter catches camelCase `*Key`. **243 unit tests** (the parser incl. gap-fill, the
> chat-customization repo incl. no-clobber + photo-only, the backup round-trip incl. the secret-export
> guard, the reminders state machine incl. reschedule-failure-intact, the rule-reply engine) against
> better-sqlite3; typecheck + expo-doctor (21/21) pass. On-device: a chat shows a custom name + green
> bubbles + mute; a backup shares `gator-backup.json`; a reminder persists to its list; and
> tapping a suggested-reply chip sends it. Tracked follow-ups: lift the duplicate per-chat message
> subscription, reverting a handle to its server name when a device contact is deleted, and an ML Kit
> smart-reply provider (no Expo-compatible native module exists today). See `AGENTS.md` for gotchas.
>
> Status (prior): **Phase 7c — contacts sync & scheduled messages complete & verified on-device.**
> Builds on Phases 0–7b. Adds **contacts sync** (Settings → Sync Contacts reads the device address
> book via `expo-contacts/legacy`, matches each handle by phone last-10-digits / lowercased email,
> and writes the contact's name + photo onto the matched handle; the contact name beats the
> server-supplied name and a later server re-sync won't clobber it — guarded by a `contact_id` flag;
> names/avatars then flow everywhere through the existing `COALESCE(display_name, address)` +
> reactive `handles` watch, so a raw number turns into a name app-wide), and **scheduled messages**
> (a 🗓️ button in the composer opens the native date+time picker; the message is stored `pending` in
> a `scheduled_messages` table and listed on a new Scheduled screen — reachable from a 🗓️ in the
> conversation header — with a Cancel action; an on-launch + 20-second foreground tick sends anything
> due through the normal send path, marks it `sent`, and leaves it `pending` to retry if the send
> throws). One additive migration (`0003`: `handles.avatar` + `handles.contact_id`) runs
> automatically (plus `0004`, an `attempts` counter — see below). **Native rebuild required** — adds
> `expo-contacts` + `@react-native-community/datetimepicker` and the `READ_CONTACTS` permission. An
> adversarial multi-agent review of the diff then hardened the scheduled-send loop into a proper
> state machine: an **atomic claim** (`pending → sending` via `UPDATE … WHERE status='pending'`) so a
> slow send or the dual home/chat tickers can't double-send a message, an **attempts cap** that
> retires a permanently-failing row (e.g. its chat was deleted) to `error` instead of retrying every
> tick forever, **startup recovery** of rows interrupted mid-send, and end-to-end **reply threading**
> for scheduled replies; plus a contact-matcher fix (a photo-only contact now applies its avatar
> without blanking the server name) and deterministically-ordered participant name/avatar concat.
> **205 unit tests** (the migrations, phone/email match keys, the contacts matcher incl. precedence +
> no-clobber + photo-only, the scheduled state machine incl. the claim lock + attempts cap + reply
> round-trip) against better-sqlite3; typecheck + expo-doctor (21/21) pass. On-device: syncing turned
> a seeded raw number into "Jenny Tutone" across the inbox + chat header, and a message scheduled for
> a near-future minute appeared on the Scheduled list and fired at its time (re-verified after the
> hardening). Tracked follow-ups: reverting a handle to its server name when a device contact is
> deleted (needs a separate server-name column), reminders, attributed/rich text, smart replies,
> backup/restore. See `AGENTS.md` for the gotchas resolved across phases.

## Why this exists

The Flutter app stored credentials in plaintext, passed the auth token in URL query
strings, accepted any self-signed cert matching the host, used AES-CBC with an MD5 KDF
and no authentication, and kept an unencrypted local database. This rebuild fixes each of
these (see [Security](#security)) while keeping the iOS look and feel.

## Architecture

Offline-first, **DB-as-source-of-truth**: the network writes into an encrypted local
SQLite store; the UI observes the DB via reactive queries. The same write path is used by
the headless FCM handler, so background and foreground updates are identical.

```
app/        expo-router screens (added Phase 1+)
src/
  core/     REACT-FREE pure TS SDK — api, realtime, sync, crypto, secure, config, models
  db/       Drizzle schema + migrations (op-sqlite + SQLCipher)
  services/ composition root — HTTP/socket/FCM clients, send, download, backup, notifications, bootstrap
  state/    Zustand stores + TanStack Query (added with screens)
  features/ feature modules wiring core + ui together
  ui/       iOS design system: tokens, ThemeProvider, primitives
  native/   thin wrappers over native modules (crypto, secure store, fcm, biometrics)
  utils/    pure helpers (bytes/base64, version compare)
test/       Jest tests — `node` project (core/db/services, `.test.ts`) + `components` project (jest-expo RN tests under `test/components`, `.test.tsx`)
```

`core/` imports no React/React Native, so it runs in Node (tests) and the headless FCM
handler, and could be extracted into a standalone `@gator/sdk`.

| Concern | Choice |
|---|---|
| Runtime/build | Expo (Dev Client) + EAS |
| Server cache | TanStack Query |
| Client/UI state | Zustand |
| Local DB | op-sqlite + SQLCipher + Drizzle ORM |
| REST | ky + zod validation |
| Realtime | socket.io-client + FCM (one `EventRouter`) |
| Push | @react-native-firebase/messaging + react-native-notify-kit |
| Crypto | react-native-libsodium (XChaCha20-Poly1305 + Argon2id) |
| Secure storage | expo-secure-store (Android Keystore) |

## Getting started

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest (node + component test projects)
```

The `core/` layer and its tests run in plain Node — **no Android SDK, Java, or device
needed**. Building/running the actual app requires the Android toolchain (or EAS Cloud):

```bash
# Requires Android SDK + JDK, or use EAS Build instead.
npx expo run:android        # local native build
# or
eas build -p android --profile development
```

## Security

| Original weakness | Fix in this rebuild |
|---|---|
| Credentials in plaintext SharedPreferences | `SecureVault` over expo-secure-store (Keystore) |
| Auth token in URL query string | `Authorization` header / socket `auth` payload (single injection point in `HttpClient`) |
| Any matching-host self-signed cert accepted | TLS-first + SPKI pinning (TOFU for self-signed); no blanket acceptance |
| AES-CBC + MD5 KDF, no authentication | XChaCha20-Poly1305 AEAD + Argon2id, versioned envelope (`SecretBox`) |
| Unencrypted local DB | SQLCipher full-DB encryption; key in the vault |
| FCM tokens / `guid` leaked to logs | `RedactingLogger` scrubs secrets before any sink |

The header-auth and AEAD-payload changes require a matching **Gator Server** version
(we control the server); setup gates on `MIN_SERVER_VERSION`.

## Docs

- [`docs/SPIKES.md`](docs/SPIKES.md) — the four Phase-0 de-risking spikes (need a device/EAS)
- [`docs/PHASE-DEPENDENCIES.md`](docs/PHASE-DEPENDENCIES.md) — native libraries to add per phase
- Full rebuild plan: `~/.claude/plans/i-ve-changed-to-the-robust-pine.md`
