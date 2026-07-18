# Parity Roadmap — closing the gap with Flutter `development`

> **STATUS UPDATE (2026-06-30):** Phases 1–3 are largely delivered (socket backoff, list throttle,
> reactive membership, per-page sync, contact-link, media sections, delivered tiers, mid-queue
> cancel, friendly error titles, notification reactions, Theme Studio + per-chat + adaptive). The
> Phase-4 tail was partly closed on 2026-06-30 — settings search, download-concurrency config, and
> seeded redacted avatars are now DONE. Still open: scheduled recurrence, server-update install, QR
> display, and the socket `refreshUrl`→`ServerUrlResolver` failover (still unwired).

_Created 2026-06-21. Companion to [COMPARISON.md](./COMPARISON.md). Selects the upstream features that
genuinely benefit **this** app (Android-only, iOS skin, offline-first DB-as-source, security-hardened)
and lays out a concrete RN implementation path. Effort: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ 3–5 days._

## Selection principles

We do **not** blindly port Flutter. We take what fits our architecture and target:

- **Robustness first** — the gaps that affect reliability on real servers/tunnels.
- **Reactivity over polling** — lean into our DB-as-source model; replace manual refreshes with
  reactive queries (our analog of their GetX `Rx`).
- **iOS-skin personalization** — the per-chat theme studio + adaptive themes (explicitly requested).
- **Keep our wins** — don't regress the security posture, pure-data tokens, or node-testable services.

### Explicitly de-scoped (and why)

| Upstream feature | Why we skip it |
|---|---|
| Arbitrary emoji reactions | Flutter committed then **reverted** it; neither app ships it. Revisit only if upstream relands. |
| Material You / 9-variant presets | Material-skin only — does **not** serve the iOS skin we kept. (We reuse the color *pipeline*, not the rendering.) |
| Isolate-based sync | op-sqlite already runs writes off the JS thread via JSI; we only need the *per-page event*, not isolates. |
| The "tuple migration" | N/A — we're TS-strict from day one. |
| Tri-platform settings/scheduler panels | We have one skin; the platform-variant machinery is pure overhead for us. |
| Desktop/Linux/camerawesome work | Out of target. |

---

## Phase 1 — Robustness & reactivity (highest ROI, ~no native deps)

### 1.1 Socket backoff + reconnect escalation — **M**
- **Why:** our `src/services/realtime/socketService.ts` (65 lines at the time; now ~302 lines with
  the backoff/escalation DONE) delegated everything to socket.io
  defaults; flaky ngrok/zrok tunnels dropped us with no escalation.
- **Do:** add tiered reconnection — socket.io quick retries → on exhaust, a capped exponential backoff
  that also triggers a **server-URL refresh** (we already have Firebase URL discovery in
  `core/config`). Mirror Flutter `socket_service.dart`'s ladder.
- **Files:** `src/services/realtime/socketService.ts`, `src/core/config/serverDiscovery*`.
- **Tests:** unit-test the backoff schedule (pure function) like the outgoing-queue backoff.

### 1.2 Socket exception throttling — **S**
- **Why:** we log every socket error; a disconnected tunnel spams the log.
- **Do:** suppress repeats by `(host, code, message)` signature within a 60s window (a tiny Map in the
  socket service). Pairs with 1.1.

### 1.3 Reactive group membership — **S**
- **Why:** `app/(app)/chat-settings/[guid].tsx` calls `refreshMembers()` manually after add/remove; a
  background sync that changes membership doesn't update the list.
- **Do:** replace the manual `members` state with `useReactiveQuery(() => getChatParticipants(db, guid),
  ['chat_handles','handles','chats'], [guid])` — our existing reactive-query hook. This is the RN analog
  of Flutter's `ChatState.participants` stream and removes the post-mutation refresh dance entirely.
- **Files:** `chat-settings/[guid].tsx`.

### 1.4 Per-page incremental-sync events — **M**
- **Why:** `incrementalSync` yields nothing until the whole loop finishes; the UI can't hydrate
  progressively.
- **Do:** after each page persists, bump a `syncStore` progress tick / emit a lightweight event so the
  inbox can re-query mid-sync (the DB write already triggers reactive queries — mainly surface progress
  + ensure we don't batch the whole sync into one transaction).
- **Files:** `src/core/sync/incrementalSync*`, `src/state/syncStore.ts`.

### 1.5 Contact-link-on-ingestion + nickname priority — **M**
- **Why:** Flutter links new handles to a device contact during sync and prefers a nickname over the
  display name; we match contacts more lazily.
- **Do:** in `upsertHandles`/the sync path, opportunistically match a new handle against the contacts
  table (we already have `contactMatch`), and make name resolution prefer `customName`/nickname →
  contact name → handle. Honors redacted mode.
- **Files:** `src/db/repositories/handles.ts`, `src/db/repositories/contacts.ts`, name-resolution helpers.

---

## Phase 2 — Conversation & messaging UX

### 2.1 Conversation-details media/links/docs sections — **M**
- **Do:** add a "Photos / Links / Documents" section to `chat-settings/[guid].tsx` querying attachments
  by MIME for the chat (a new `listChatAttachmentsByKind` repo fn). Tap → existing media viewer.

### 2.2 Delivered-indicator tiers (Delivered Quietly / Did Not Notify) — **S/M**
- **Why:** real iMessage states (DND Macs); we only do Sending→Sent→Delivered→Read.
- **Do:** surface `didNotifyRecipient` / `wasDeliveredQuietly` from the message payload in
  `src/utils/messageStatus.ts` + the bubble status row.

### 2.3 Mid-queue message cancellation — **S**
- **Do:** a "Cancel" affordance on a still-`pending` outgoing row → delete from `outgoing_queue` + the
  optimistic message before it sends. We already have the queue; add the user-facing API.

### 2.4 Error codes → friendly titles — **S**
- **Do:** map the stored numeric send-error code to a friendly title (port Flutter's `ClientMessageError`
  table) in `messageStatus.ts`; show it in the error bubble + retry sheet.

### 2.5 Like/love a message from the notification — **M** _(native: Notifee actions already linked; Notifee has since become `react-native-notify-kit` — same API)_
- **Do:** add reaction actions to the Notifee message notification (`notifeeService.ts`) + handle them in
  `actions.ts` → `sendReaction`. No new native module (Notifee is already built).

---

## Phase 3 — 🎨 Per-chat Theme Studio + Adaptive-from-Background (flagship)

The marquee personalization feature. Built in three layers; the first two have **no native deps**, the
adaptive pipeline needs **one native rebuild**.

### 3.1 Generalize the editor into a reusable Theme Studio (+ live preview) — **M**
- Refactor `app/(app)/themes.tsx`'s editor into a reusable `src/ui/theme/ThemeStudio.tsx` that takes an
  `onApply(tokens: ThemeTokens) => void` callback (mirrors Flutter's `ThemeStudioPanelConfig`):
  - `onApply` set → save to a **chat** (per-chat mode).
  - `onApply` omitted → save to the global `themeStore` (today's behavior).
- Add a **live preview card** (`ThemePreviewCard.tsx`): renders a mock sent + received bubble + the
  background, re-rendering as the draft tokens change (reuse our `Bubble` components). This is the one
  thing Flutter's studio has that ours lacks.
- Keep the staged-vs-applied split we already have (the `Draft` pattern) — it matches Flutter's
  `appliedLightName` vs `lightTheme` separation.

### 3.2 Per-chat theme storage + scoped provider + background render — **M**
- **Schema migration:** add `theme_tokens TEXT NULL` and `background_uri TEXT NULL` to the `chats`
  table (sits alongside the existing `custom_color`/`custom_name` customization columns). New repo
  helpers `setChatTheme(db, guid, tokens, backgroundUri)` / clear.
- **`ChatThemeProvider`:** wrap the conversation screen (`app/(app)/chat/[guid].tsx`) in a nested
  `ThemeContext.Provider` that, when the chat has `theme_tokens`, overrides the global theme for that
  subtree — so `useTheme()` inside the conversation returns the chat theme. Falls back to global. This
  is the clean RN analog of Flutter's chat-scoped `ThemeStudioPanelConfig.onApply`.
- **Background:** render `background_uri` behind the inverted `FlashList` (an absolute `expo-image`
  `<Image>` with the message list transparent on top). Adaptive tokens guarantee bubble contrast.
- **Entry point:** a "Chat Theme…" row in `chat-settings/[guid].tsx` opening `ThemeStudio` in per-chat
  mode (this *replaces* today's single `custom_color` swatch with full theming, keeping the swatch as a
  quick option).

### 3.3 Adaptive-themes-from-background pipeline — **M** _(native rebuild)_
The reusable part of Flutter's `generateAdaptiveThemesFromImage()` — the color *pipeline* (not the
Material You *rendering*):

1. **Pick** a background image — `expo-image-picker` (already installed).
2. **Crop** (optional) — `expo-image-manipulator` _(native — needs rebuild)_.
3. **Extract a seed color** — `react-native-image-colors` _(native — Android Palette API, needs
   rebuild)_; take the dominant/vibrant swatch.
4. **Generate a tonal palette** — `@material/material-color-utilities` _(**pure JS, no rebuild** — the
   official MCU port)_: `themeFromSourceColor(argbFromHex(seed))` → light + dark schemes.
5. **Map MCU scheme → our `ThemeTokens`** (a pure function `src/ui/theme/adaptiveFromImage.ts`, fully
   unit-testable):
   - `tint = primary`, `bubble.senderBackground = primary`, `senderText = onPrimary`
   - `background = surface`, `secondaryBackground = surfaceContainer/surfaceVariant`
   - `bubble.receivedBackgroundTop/Bottom = surfaceContainerHigh / surfaceVariant`, `receivedText =
     onSurface`
   - `label = onSurface`, `secondaryLabel = onSurfaceVariant`, `separator = outlineVariant`,
     `destructive = error`, `smsBackground = tertiary`
   - MCU tones are contrast-correct by construction (no manual WCAG math needed).
6. **Persist** the generated tokens + `background_uri` to the chat (3.2) and apply via `ChatThemeProvider`.
7. **Offer both** a generated theme and a "tweak in the studio" handoff (the generated tokens seed the
   studio draft).

> **Native-rebuild note:** `react-native-image-colors` + `expo-image-manipulator` autolink and need an
> EAS dev build — **batch them with any other native items** (per `RELEASE_CHECKLIST.md` /
> project-memory `native-rebuild-batch`). `@material/material-color-utilities` is pure JS and ships via
> Metro immediately. The pure mapping function (step 5) is testable in Node before the rebuild lands.

**Why this fits RN well:** the token system is already pure data, so a generated `ThemeTokens` drops
straight into `ChatThemeProvider`, the studio, *and* notification styling — no framework coupling. MCU
has a first-class JS port, so we get Flutter's exact algorithm without Material-skin baggage.

---

## Phase 4 — Settings & polish

| Item | Effort | Notes |
|---|---|---|
| **Settings search** | M | Wrap settings rows in a `SearchableSettingItem` registry (title + tags); a search field filters. Useful as settings grow with the above. |
| **Scheduled-recurrence UI** | S/M | One-shot plumbing exists (`ScheduleArgs` / `ScheduledRow`; the local `runDueScheduled` pipeline). Recurrence is NOT modeled yet — the REST surface has no recurrence field. Model it, then add a "Repeat" picker to the schedule sheet. |
| **Configurable max-concurrent-downloads + image-preview-quality** | S | Settings → wire to the download semaphore limit + the preview resize quality. |
| **DiceBear fake avatars in redacted mode** | S | Generate a deterministic local avatar per handle when redacted (a seeded SVG/emoji — avoid the network DiceBear call for privacy). |
| **Server update *check* + *install*** | S | Both unimplemented on the Gator fork — `checkUpdate` currently rejects with `UnimplementedEndpointError('/server/update/check')` and isn't surfaced. Implement `GET /server/update/check` + `POST /server/update/install` in `server.ts` + a button in the server-management panel. |
| **QR pairing display** | S/M | Render a connection QR in server-management (we deferred this). |

---

## Suggested sequencing

1. **Phase 1** (robustness/reactivity) — cheapest, biggest reliability win, no rebuild.
2. **Phase 3.1 + 3.2** (theme studio + per-chat scoping + background) — no native deps; ships on Metro.
3. **One native rebuild batch:** Phase 3.3 (`react-native-image-colors`, `expo-image-manipulator`) +
   any Phase 4 native bits.
4. **Phase 2 + Phase 4** UX polish, interleaved.

Each item lands behind the existing quality gate (tsc · ESLint · Prettier · Jest · the console/dev.local
CI guards) with tests for the pure pieces (backoff schedule, MCU→tokens mapping, error-code titles).
