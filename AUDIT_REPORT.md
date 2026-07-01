# BlueBubbles RN — Audit Report (rebuild vs. Flutter original)

> **STATUS UPDATE (2026-06-30):** Re-verified against the current code — most findings are now
> RESOLVED. The one CRITICAL item (F-1, no compose/new-chat) is fully built (`app/(app)/new-chat.tsx`
> + FAB + `POST /chat/new`); group management (F-2), Find My refresh calls (F-13), the server
> contacts endpoint (F-10), and ESLint-in-CI + Firebase boot guard (CS-1/CS-3/CS-4) are all DONE.
> Still genuinely open: multi-alias send (F-6), server-synced settings backup (F-11),
> sticker-render / video-fullscreen / Android share-intent (F-14), and `allowBackup`/legacy-query
> hygiene (SEC-5/6). Test/file counts below are historical (current: **104 suites / 532 tests**).
> Everything below is the ORIGINAL 2026-06-20 snapshot.

_Generated 2026-06-20 from a 7-agent audit (635k tokens) of the React Native rebuild
(`bluebubbles-rn`, 176 source files / 19 screens / **77 test files, 345 passing**) against the
original Flutter app (`bluebubbles-app`, 323 Dart files). **76 findings: 1 critical, 9 high,**
the rest medium/low/info._

> This report supersedes the stale parts of `GAP_ANALYSIS.md` (which predates the FCM + Phase
> 8/9 work and now contradicts the code — see CS-2). Where they disagree, **trust the code.**

---

## 1. Executive summary

**Security & architecture are a genuine upgrade over the original.** All four documented Flutter
weaknesses are fixed (plaintext credentials → Keystore vault; URL-query auth → `Authorization`
header + socket `auth`; permissive bad-cert acceptance → standard TLS + optional pinning;
`usesCleartextTraffic` true → false). The at-rest posture moved from AES-256-CBC + unsalted-MD5-KDF
to XChaCha20-Poly1305 + Argon2id + full-DB SQLCipher with **crash-safe key rotation**, and the code
quality (strict TS, a genuinely pure `core/` boundary, 345 tests, a CI-enforced redaction logger) is
well above the original.

**The gaps are at the edges, not the center.** The messaging *loop* (send/receive, edit/unsend,
replies, tapbacks, typing, receipts, effects, attachments, search, reminders, redacted mode) is solid
and tested. But there is **no way to start a new conversation** (critical), no audio/voice/document
support, group management has endpoints but no UI, and several features are local re-implementations
of server-backed Flutter ones (scheduled messages, contacts, backup).

**Top priorities:** (P0) ship a compose/new-chat flow; close the link-preview **SSRF**; add a crash
guard around the now-top-level Firebase import; bind the headless-push DB-open to the app-lock.

| Severity | Count | |
|---|---|---|
| 🔴 Critical | 1 | No new-chat creation flow |
| 🟠 High | 9 | compose-adjacent gaps, audio/voice/doc, group UI, send-method, scheduled, app-lock key custody, Firebase boot import |
| 🟡 Medium | ~18 | SSRF, encrypted-FCM drop, server panel, themes, contacts, backup-sync, no-ESLint, EventRouter silent-drop, … |
| ⚪ Low/Info | ~48 | parity polish + verified-fixed + strengths |

---

## 2. Security

### 2.1 ✅ Verified fixed (the original Flutter issues)
| # | Original Flutter weakness | RN status |
|---|---|---|
| S-1 | Credentials in plaintext SharedPreferences | **Fixed** — `ExpoSecureVault` over Keystore-backed expo-secure-store; non-secret prefs in the encrypted SQLCipher `kv` table; no plaintext store exists (`src/native/secureVault.ts`, `src/core/secure/vault.ts`). |
| S-2 | Auth token in the URL query (~20 sites + socket) | **Fixed** — `Authorization: Bearer <pw>` (single injection point) + socket `auth` payload; tests assert `searchParams.has('guid') === false` (`src/core/api/http.ts`, `socketService.ts`). |
| S-3 | `badCertificateCallback` accepted any cert on the host | **Fixed** — no TLS bypass anywhere; standard validation + optional SPKI pinning (`src/native/certPinning.ts`). |
| S-4 | `usesCleartextTraffic="true"` app-wide | **Fixed** — `false` in the release manifest via expo-build-properties; `sanitizeServerAddress` prepends https. |
| S-5 | Exported receiver gated by a plaintext-password `==` compare | **Hardened** — rotating Keystore token + constant-time compare + default-deny allowlist (`src/core/secure/intents.ts`). |
| S-6 | AES-256-CBC + unsalted single-iteration MD5 KDF | **Fixed** — XChaCha20-Poly1305 AEAD + Argon2id, versioned envelope, device-verified (`src/native/crypto.ts`, `src/core/crypto/`). |

### 2.2 ⚠️ Residual / new security findings
| # | Sev | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| SEC-1 | 🟠 High | **App-lock is a JS gate, not OS key custody.** Keystore items use only `keychainAccessible: WHEN_UNLOCKED` (iOS-only / no-op on Android); no `requireAuthentication`, so the SQLCipher key + server password are readable by the app process with no biometric binding. The headless-FCM path opens the DB ignoring lock state. | `src/native/secureVault.ts:10-12`; `src/services/index.ts:136-145` | Set `requireAuthentication: true` on `dbEncryptionKey` (and `serverPassword`) when app-lock is on; gate the headless DB-open on lock. |
| SEC-2 | 🟡 Med | **SSRF in the auto link-preview fetch.** `fetchOgMetadata` GETs the first URL in a *received* message on bubble render, following redirects, with no private-IP/host allowlist — a sender can make the recipient hit `169.254.169.254`, `192.168.x`, `localhost`. | `src/services/urlPreview.ts:79-99`; `useUrlPreview.ts` | Reject loopback/link-local/private hosts before fetch **and after each redirect**; restrict to ports 80/443; stream-cap the body; add an SSRF test. |
| SEC-3 | 🟡 Med | **Encrypted FCM payloads silently dropped.** The FCM parser ignores the `encrypted/partial/encoding` envelope Flutter honors, so an encrypted push fails schema validation and is dropped with no log. | `src/services/notifications/fcmPayload.ts:14-19` | Decode the envelope (decrypt when `encrypted`); at minimum log dropped pushes (see CS-3). |
| SEC-4 | 🟡 Med | **`Authorization: Bearer <pw>` value not redacted** when logged as a raw string (the redactor scrubs the *key* `authorization`, not a bare header value). | `src/core/secure/redact.ts:12-32`; `http.ts:87-96` | Add a `Bearer <token>` value pattern to the redactor. |
| SEC-5 | ⚪ Low | **Legacy `?guid=` query-auth + plaintext-JSON backup import paths remain** (dead in production, but present). | `http.ts:104-110`; `backupService.ts:97-99` | Remove or feature-gate behind an explicit "legacy server" setting. |
| SEC-6 | ⚪ Low | **`allowBackup="true"`** + debug-variant cleartext (hygiene). The PRAGMA-rekey key is string-interpolated (safe today — CSPRNG hex only). | `AndroidManifest.xml:24`; `src/db/key.ts:81` | Set `allowBackup="false"`; pin the hex-only invariant with a comment at the interpolation site. |

---

## 3. Missing features & parity gaps (vs. Flutter)

| # | Sev | Gap | Evidence |
|---|---|---|---|
| F-1 | 🔴 **Critical** | **No new-chat / compose flow at all** — no compose FAB, no contact/handle picker, no `POST /chat/new`, no iMessage-vs-SMS selection. You cannot start a conversation. | `chats.ts` (no `/chat/new`); `home.tsx` (no compose); Flutter `chat_creator.dart` |
| F-2 | 🟠 High | **Group management is endpoint-only** — `updateParticipant`/`renameChat` exist but have zero call sites; only *Leave* is wired in chat-settings. | `chats.ts:42,54`; `chat-settings/[guid].tsx` |
| F-3 | 🟠 High | **No audio playback** — audio attachments (incl. voice memos) fall to a plain FileChip; no player/waveform/scrubber. No `expo-audio` in deps. | `AttachmentView.tsx:31` |
| F-4 | 🟠 High | **No voice-memo recording** — composer has no mic/record affordance. | `Composer.tsx` |
| F-5 | 🟠 High | **No document/any-MIME picker** — picker is images-only (the send pipeline is already MIME-agnostic). | `chat/[guid].tsx:223-228` |
| F-6 | 🟠 High | **No multi-account/alias send** — no way to choose the sending handle; `imessage-aliases-removed` is parsed then dropped. | `sendService.ts`; `dbEventSink.ts:70-72` |
| F-7 | 🟠 High | **Send method hardcoded `private-api`** — no `apple-script` fallback, so on a server without the private API every send fails instead of degrading. No SMS-vs-iMessage send choice. | `messages.ts:46` |
| F-8 | 🟠 High | **Scheduled messages are local-only, no recurrence** — fired by an on-device worker, not the server `/scheduled` API; a sleeping phone sends late/never. | `scheduleService.ts:20-27` |
| F-9 | 🟡 Med | **No server-management panel** (restart server/iMessage/PrivateAPI, manual sync, logs, update check, QR sync, custom headers, multi-URL failover). Only Disconnect + read-only About. | `settings.tsx:215-239`; `server.ts` |
| F-10 | 🟡 Med | **Contacts sync is device-only** — no server/iCloud contact fetch. | `contactsService.ts:18-47` |
| F-11 | 🟡 Med | **Backup is local-file only** — no server-synced settings/theme backup. | `backupService.ts` |
| F-12 | 🟡 Med | **Themes: 4 fixed presets** — no in-app custom-theme creation/editing UI (DB layer + import exist), no Material You/Monet. | `tokens.ts`; `settings.tsx:101-123` |
| F-13 | 🟡 Med | **Find My: no embedded map** (geo: URL fallback); the refresh-location endpoints are implemented but never called. | `findmy.tsx:9-12`; `findmyStore.ts:90-108` |
| F-14 | 🟡 Med | **No sticker rendering** (DB flag stored but never read by any UI); **fullscreen viewer is image-only** (videos never open fullscreen); **no Android share-intent** receiver. | `attachment.ts:16`; `media/[guid].tsx:59-66` |
| F-15 | ⚪ Low | Smart replies are a regex rule-engine (not ML Kit); no cross-chat notification group; binary mute (vs Flutter's 4 mute modes) + no custom avatar; subject stored but never rendered; live-photo motion not played (badge only); attributed text = mentions/attachments only (no bold/italic); reply = quote+jump (no thread view); no GIF picker; downloads have progress+retry but no HTTP-range resume. | various |

---

## 4. Code smells & tech debt

| # | Sev | Smell | Evidence | Fix |
|---|---|---|---|---|
| CS-1 | 🟠 High | **Lazy-native-import discipline broken for Firebase.** AGENTS.md forbids top-level native imports on the startup path, yet `app/_layout.tsx` statically imports `startFcm`, whose module calls `messaging().setBackgroundMessageHandler` at eval — **no try/catch**, so a misconfigured Firebase project crashes boot. | `app/_layout.tsx:13,44`; `fcmMessaging.ts:1,27` | Wrap firebase access in try/catch → degrade to socket-only; isolate the unavoidable top-level handler. |
| CS-2 | 🟡 Med | **`GAP_ANALYSIS.md` is stale and now contradicts the code** (says FCM disabled / firebase absent; reality: enabled + wired + `google-services.json` present). | `GAP_ANALYSIS.md` §1 | Refresh or retire it; point to this report. |
| CS-3 | 🟡 Med | **EventRouter silently discards every unrecognized/invalid event** — no logging at all, so dropped pushes/socket events are invisible. | `eventRouter.ts:45-51,68-106` | Log (redacted) the event name + reason on the default/failed-validation path. |
| CS-4 | 🟡 Med | **9 `eslint-disable` directives but ESLint is not installed or run in CI** — `react-hooks/exhaustive-deps` bugs go uncaught; UI/hooks have essentially no automated test coverage. | no eslint in `package.json`/CI | Add ESLint (react-hooks) + a CI lint step; add RN Testing Library coverage for hooks/screens. |
| CS-5 | 🟡 Med | **`dev.local` dev session bypasses the entire production send/reply/react path** — a jest-green-hides-device-bug seam (like the crypto-AAD bug that was caught). | `chat/[guid].tsx:74,…` | Add a thin integration test or a staging path that exercises real services. |
| CS-6 | ⚪ Low | `repositories.ts` is a **1596-line / 70-export god-module**; `isDev()` copy-pasted in 5+ files; `connectToServer`'s rich failure-kind enum is discarded by callers; migrations hardcode `applied_at=0`. | `repositories.ts`; `findmyStore.ts:82` et al. | Split repositories by domain; extract a shared `isDev()`; surface the failure kind. |

### Genuine strengths (for balance)
A React-free, node-importable `src/core/` boundary; TS `strict` + `noUncheckedIndexedAccess` + only
6 `as unknown` / 1 `any` / 0 `@ts-ignore` in the tree; offline-first DB-as-source-of-truth; a single
zod-validated `HttpClient`; a CI-grep-enforced redacting logger; a crypto **contract test** that
round-trips the real wiring (and already caught the AAD jest-vs-device divergence); crash-safe DB-key
rotation; fully parameterized SQL with FTS input tokenized (no injection).

---

## 5. Inert until a native rebuild / credential (not bugs — pending activation)
FCM push (enabled + wired; needs the firebase native build + server-side Firebase) · TLS cert pinning
(coded, no pins/TOFU) · the hardened automation-intent gate (JS core done; **exported native receiver
not built**) · Find My embedded map (needs a Google **Maps** API key + `react-native-maps`) · Sentry
(needs a DSN). Tracked in `RELEASE_CHECKLIST.md` + project memory.

---

## 6. Prioritized recommendations

**P0 — usability & security blockers**
1. **F-1 Compose/new-chat flow** — contact/handle picker + `POST /chat/new` + iMessage/SMS toggle. Without it the app can't start a conversation.
2. **SEC-2 Link-preview SSRF** — host/redirect allowlist + port restriction + streamed size cap.
3. **CS-1 Firebase boot guard** — try/catch around the top-level firebase access.
4. **SEC-1 App-lock key custody** — `requireAuthentication` on the DB key + gate the headless DB-open on lock.

**P1 — high-value parity & robustness**
5. F-3/F-4/F-5 audio playback + voice recording + document picker (one native-rebuild batch).
6. F-2 group-management UI (rename + add/remove). F-7 send-method fallback. F-6 alias send.
7. SEC-3 encrypted-FCM handling + CS-3 EventRouter logging + SEC-4 Authorization redaction.

**P2 — parity polish & hygiene**
8. F-8 server-side scheduled API + recurrence; F-9 server-management panel; F-12 custom-theme UI; F-13 Find My map.
9. CS-4 ESLint + CI lint; CS-6 split `repositories.ts`; CS-2 refresh/retire `GAP_ANALYSIS.md`.

---
_Method: parallel auditors over both repos, each citing RN `file:line` and the Flutter counterpart;
findings verified against the code before assertion. Full structured output in the session transcript._
