# RN rewrite vs. the upstream Flutter `development`

> **STATUS UPDATE (2026-06-30):** Many gaps flagged below are now CLOSED — socket backoff +
> reconnect escalation, incremental per-page sync, reactive group membership, conversation-details
> media/links/docs sections, per-chat Theme Studio + adaptive-from-image, notification reactions,
> mid-queue cancellation, friendly error titles, and the "Delivered Quietly" tier all shipped.
> Closed on 2026-06-30: settings search, download-concurrency config, and seeded redacted avatars.
> Still open (lower-priority parity): multi-image gallery, scheduled recurrence, server-update
> install, QR display. Package names + line counts below are stale. The table below is the ORIGINAL
> 2026-06-21 comparison.

_Compiled 2026-06-21 by a parallel multi-agent comparison (6 subsystem reviewers reading both
repos), then synthesized and spot-checked by hand. Companion to [AUDIT_REPORT.md](./AUDIT_REPORT.md)
and [ROADMAP.md](./ROADMAP.md)._

## Context that reframes everything

The upstream Flutter `development` branch is **704 commits / 85 feature-commits ahead** of the
`master` that this RN rewrite (and every prior audit/gap doc) was measured against. A large fraction
of those 85 are **desktop / Linux / Material / Samsung** work that is **irrelevant** to our
Android-only, iOS-visual-skin target. Everything below is filtered to what actually matters for us.

Target reminder: **Android only, iOS skin only**, offline-first DB-as-source-of-truth, security-hardened.

---

## 1. Surprising findings (read these first)

- **Arbitrary emoji reactions (iOS-17 style) — neither app ships it.** Flutter committed it
  (`d38058cc4`), then **reverted it** (`78b021875`), with no reland in current `development`. So this
  marquee iMessage feature is a gap for *both* of us; they tried and backed out. De-prioritize
  accordingly.
- **Flutter has a QR-code pairing generator** in server management (`connection_panel_helpers.dart`);
  we deferred QR entirely.
- **Flutter churned hard on the camera** (camerawesome → plain intents → a custom full-screen review
  screen with pinch/double-tap zoom). The native camera UX was clearly a pain point.
- **The "great tuple migration"** (`be3d39fb3`) refactored 46 files just to drop `Tuple2` for named
  records — pure type-safety hygiene. We were born typed (TS strict), so we skip that debt entirely.
- **Flutter surfaces 8–10 server connection metrics** (API, Socket, Private API, Helper Bundle,
  Firebase DB, iCloud, Proxy, latency, time-sync); our new panel shows ~6.
- **One reviewer mis-stated our DB as "unencrypted SQLite"** — we use **SQLCipher** (encrypted). We
  are *not* behind on at-rest encryption; arguably ahead given header-auth + redaction.

---

## 2. Feature gaps that matter (prioritized for our target)

| Gap | Our status | Flutter evidence | Why it matters |
|---|---|---|---|
| **Socket backoff + URL-refresh escalation** | missing | `socket_service.dart` (382 lines): tiered retry → URL refresh; ours is 65 lines, delegates to socket.io | Robustness on flaky tunnels (ngrok/zrok) |
| **Per-page incremental sync events** | missing | `incrementalSyncPageComplete` emitted per chat | Progressive UI hydration vs. all-or-nothing |
| **Reactive group membership + handle state** | partial | `ParticipantsList` streams `ChatState.participants`; `HandleService` Rx | Instant add/remove; ours needs manual `refreshMembers()` |
| **Contact-link-on-ingestion + nickname priority** | partial | new handles auto-link a device contact during sync; nickname > displayName | Better names without a manual contact sync |
| **Multi-image gallery** | missing | `message_image_gallery.dart` fan-out card | Cleaner multi-image messages |
| **Conversation-details media/links/docs sections** | missing | details page aggregates attachments by type | Standard iMessage detail UX |
| **Scheduled *recurring* messages** | missing | `create_scheduled_panel.dart` recurrence UI | Our F-8 plumbing supports it; UI not built |
| **Per-chat theme studio + adaptive-from-background** | missing | `theme_studio_panel.dart`, `generateAdaptiveThemesFromImage()` | Flagship iOS-skin personalization (see ROADMAP) |
| **Settings search** | missing | `SearchableSettingItem` indexing + breadcrumbs | Discoverability as settings grow |
| **Delivered-indicator tiers** | partial | `delivered_indicator.dart`: Delivered Quietly / Did Not Notify | iMessage fidelity (DND Macs) |
| **Like/love from notification** | missing | Android action → `POST /message/react` | React without opening the app |
| **Mid-queue message cancellation** | partial | `OutgoingMsgHandler.cancelMessage()` | Cancel a queued (not-yet-sent) message |
| **Error codes → friendly titles** | partial | `ClientMessageError` enum → friendly title | "Network Timeout" vs "Error -1" |
| **Configurable max concurrent downloads / preview quality** | missing | settings sliders | Power-user control |
| **DiceBear fake avatars in redacted mode** | missing | redacted-mode avatar generation | Privacy polish |
| **Server update *install*** (we have *check*) | partial | `POST /server/update/install` | One-tap server upgrade |

---

## 3. Architectural improvements they have that we lack

- **Reactive granular state** — GetX `Rx` on handles/participants/delivery flags rebuilds widgets on a
  single field change. Our DB-as-source reactivity is coarser (table-level re-query). For *group
  membership* and *delivery state* specifically, theirs is more responsive.
- **Isolate-based sync** — incremental sync runs on a separate Dart isolate. Our op-sqlite writes are
  already off the JS thread (close), but they also emit per-page UI events from it.
- **Linearized startup** — `StartupTasks` with explicit dependency ordering + `GetIt.isReady()` gates,
  vs our mostly fire-and-forget `boot()`.
- **Socket exception throttling** — suppress repeated socket errors by `(host, code, message)`
  signature within a 1-min window; we log every error.
- **Service-layer abstraction** — their settings/server logic lives in dedicated services; ours mixes
  API calls into screens.
- **Theme studio staged-vs-applied state + live preview card** — `ThemeStudioController` separates the
  edited draft from the applied theme and renders a mock-bubble preview; our editor shows hex fields
  only.

> ⚠️ **Caveat on per-chat theming:** Flutter's adaptive themes lean on **Material You / Material Color
> Utilities**, which is **Android-Material-skin only** — it does *not* serve the iOS skin we kept. The
> iOS-relevant slice is the **WYSIWYG studio + live preview** and **full light+dark per-chat theming**.
> The color-from-image *pipeline* is reusable for us (see ROADMAP) even though their Material You
> *rendering* is not.

---

## 4. Where our rewrite is genuinely better

- **Security posture is ahead across the board** — header auth (not `?guid=` in the URL),
  **SQLCipher-encrypted DB**, **Zod runtime validation** on all network data, and a **centralized
  redacting logger**. Flutter still puts the password in the query string and has no upstream scrubber.
- **DB-persisted retry with backoff that survives restart** — our `outgoing_queue` stores attempts +
  backoff timestamps (max 5, up to 1h). Flutter's in-memory `Completer` race is elegant but doesn't
  persist across a kill.
- **Pure-data TypeScript theme tokens** — usable in tests and non-React contexts (notification
  styling). Flutter's themes are framework-bound.
- **Pure, node-testable orchestration** — send/edit/unsend/reaction services have zero RN imports →
  CI-verifiable; their equivalents are UI-coupled.
- **Cleaner concurrency** — download acquire/release semaphore + per-GUID in-flight dedup is simpler to
  reason about than their queue-map.
- **Radically less complexity by design** — dropping Material/Samsung skins removed an entire axis of
  `if (skin)` branching. Socket 65 lines vs 382; theme editor ~300 lines vs 17+ files.
- **More sophisticated Android notifications** — Notifee MESSAGING style with inline reply,
  mark-as-read, and avatar threading.

---

## 5. Recommended shortlist (highest ROI)

1. Socket backoff + reconnect escalation
2. Reactive group membership in chat-settings (replace `refreshMembers()` with a reactive query)
3. Per-page incremental-sync events
4. Conversation-details media/links/docs sections
5. **Per-chat theme studio + adaptive-from-background** (flagship)
6. Scheduled-recurrence UI (plumbing already exists)
7. Delivered-quietly / did-not-notify flags

**De-prioritized:** arbitrary emoji reactions (neither app ships it), Material-You theming (doesn't
serve the iOS skin), isolate-based sync (op-sqlite already threads writes), the tuple migration (N/A
for TS). Full phased plan in [ROADMAP.md](./ROADMAP.md).
