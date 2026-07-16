# Old App → RN Feature-Gap Audit (2026-07-15 refresh)

_Fresh multi-agent comparison of the old Flutter app (`~/github/bluebubbles-app`, 534 Dart files) against the **current** React Native rebuild (`~/github/bluebubbles-rn`). Supersedes `OLD_APP_PARITY_AUDIT.md` (2026-07-01), which is stale — many gaps it lists were closed in Waves 1–3 and Phases 7d/8/9._

## How this was produced

19 audit agents (one per functional domain of the old app) each enumerated the old app's
features and grep-verified every claim against the **current** `src/` and `app/`. Every
high-priority "missing" claim then went through a **skeptical verify pass** whose job was to
find the feature actually implemented (renamed/moved/shipped in a later phase). **Zero of the
high-priority gaps were refuted** — every one below is confirmed genuinely absent.

## How to read it

Each gap has a **priority** (user value) and an **applicability**:

- `android` / `cross-platform` — a **genuine gap** worth considering. Counted in totals.
- `desktop-only` / `ios-only` / `na-fork` — does not apply to this Android, iOS-styled Gator
  fork (Material/Samsung skins, Google/Firebase OAuth, Tasker, UnifiedPush, desktop keyboard
  shortcuts, etc.). Excluded from totals.

## Totals

- **217 genuine gaps** — **9 high** (one appears in two domains), **69 medium**, **138 low**
- 19 domains audited; ~2.3M tokens of analysis; 0 agent errors

**Bottom line:** the RN app has strong parity on the daily-use core (inbox, chat, send,
reactions, replies, effects, search, sync, notifications, backup, Find My, scheduling, theming
presets). The genuine gaps cluster in **(a) power-user actions**, **(b) group-chat context**,
**(c) the media viewer**, **(d) settings breadth**, and **(e) Android background reliability**.
Several gaps also make the app **ahead** of the original (encrypted backups, server-side
scheduling with crash recovery, a Server Health screen, custom-emoji tapbacks, battery display
in Find My) — noted inline.

---

## ✅ Completed since this audit (updated 2026-07-16)

Three implementation waves (Batch A/B/C) plus a medium-gap pass have closed **all 9 high-priority
gaps except #6 (Light/Dark — deliberately deferred; staying dark-preset-only for now)** plus ~15
medium gaps. Everything shipped with tests (node + component suites); the new client endpoints
shipped alongside their Gator-server counterparts.

**High-priority shortlist — 8 of 9 done** (#6 intentionally skipped):

1. ✅ **Group / chat-event system messages** — `itemType`/`groupActionType` columns, `src/utils/groupEvent.ts`, centered event-line renderer in `MessageRow`.
2. ✅ **Scroll-back pagination** — `onLoadOlder` in `MessageList` + chat screen (loads older windows).
3. ✅ **Delete a delivered message locally** — Delete action in `MessageActionsOverlay` (`canDelete`).
4. ✅ **Pinch-to-zoom in the photo viewer** — `src/ui/attachments/ZoomableImage.tsx`.
5. ✅ **Swipe carousel with "N of M" counter** — paged `FlatList` in `app/(app)/media/[guid].tsx`.
6. ⏭️ **Light / Dark / System theme mode** — DEFERRED by choice (dark presets only).
7. ✅ **Restore a backup from a file** — document picker wired into `backup.tsx`.
8. ✅ **"Start Chats Using" alias selector** — `src/core/api/endpoints/icloud.ts` + `app/(app)/account.tsx`.
9. ✅ **Disable Battery Optimizations** — `src/services/battery.ts` + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission + Settings prompt.

**Cross-cutting themes closed:**

- ✅ **@mention composing** (autocomplete + attributedBody spans) — `src/utils/mentions.ts`, `Composer`.
- ✅ **Subject-line field** + Send Subject Lines toggle — `Composer` + `featureSettingsStore`.
- ✅ **Set / remove group photo** — `src/services/chat/groupIcon.ts` + chat-settings (server: `update-group-photo`).
- ✅ **App-side logging** — in-memory ring buffer behind the redacting logger + viewer/filter/share/clear (`app/(app)/logs.tsx`, `MemorySink`).

**Medium gaps closed (Batch C + medium pass):**

- ✅ Swipe-to-reply gesture · ✅ swipe-to-reveal per-message timestamps · ✅ jump-to-oldest-unread chip
- ✅ Scheduled **sent/failed history** (a failed scheduled send no longer vanishes silently)
- ✅ Image-gallery **grid collapse** · ✅ **reply-thread view** · ✅ **multi-select** mode
- ✅ **Per-chat drafts** (persist/restore) · ✅ **Unknown Senders** filter + notification suppression
- ✅ **Per-recipient iMessage availability** (chip color + auto-SMS) — server: `handle/availability`
- ✅ **Per-chat Android notification channel** — `notifeeService`

**Correctness follow-up (2026-07-16):** an adversarial multi-agent review of the above diff found 7
confirmed bugs — all fixed with regression tests: inbox-vs-chat unread count divergence on retracted
messages, composer draft loss on multi-select + on editing, a stray gallery-cell corner, and the
new-chat auto-SMS clobbering a manual service choice / getting stuck on SMS.

**Still open:** roughly **54 medium + 138 low** gaps in the per-domain detail below are untouched.
The biggest still-open MEDIUM clusters worth a next pass: media-viewer **redownload-on-demand**,
**contact card / add-to-contacts**, new-chat **address validation + E.164 normalization**, **granular
redacted sub-toggles**, **recurring** scheduled messages, **reaction/keyword notification** controls,
and the Find My **"you are here"** current-location marker.

> These features still need the server changes deployed and **on-device verification** of the native
> paths (swipe gestures, notification channels, battery-optimization intent, alias endpoints).

---

## 🔴 The high-priority shortlist (fix these first)

> **Status (2026-07-16): 8 of these 9 are now shipped — see the Completed section above. Only #6
> (Light/Dark) remains, and it's deliberately deferred.**

These are the 9 distinct high-value gaps, in plain terms.

1. **Group-chat system messages are dropped entirely.** _(chat-view + sweep)_
   iMessage group threads contain event lines like "X named the conversation", "X added Y",
   "X left", "X changed the group photo", "X started a FaceTime call". The RN app has **no
   concept** of these — the `messages` table has no `itemType`/`groupActionType` columns, nothing
   ingests them, and nothing renders a centered event line. Group threads silently lose all
   membership/rename context. _Frequent, visible, and a daily annoyance for anyone in groups._

2. **You can't scroll back through history.** _(chat-view)_
   The chat opens a fixed 250-message window (`useMessages limit=250`) and `MessageList` has no
   load-older handler. Scrolling up past the initial window just stops — older history is
   unreachable except by jumping to a search hit. The old app paginates infinitely.

3. **No way to delete a delivered message locally.** _(message-actions)_
   The long-press menu only offers "Cancel Sending"/"Remove" for a still-sending or failed
   message. There's no Delete for an already-sent/received message, even though
   `deleteMessageByGuid()` exists in the DB layer (only called internally for cleanup).

4. **Pinch-to-zoom is broken on Android in the photo viewer.** _(media-viewer)_
   The viewer zooms via a `ScrollView` with `maximumZoomScale`/`minimumZoomScale` — props that
   are **iOS-only and ignored on Android**. Since Gator is Android-only and no gesture/zoom
   library is installed, fullscreen photos can't be zoomed at all.

5. **No swipe-carousel between photos.** _(media-viewer)_
   The viewer loads exactly one attachment by guid — no pager, no "3 of 12" counter. To see the
   next photo you must back out and tap the next thumbnail. The old viewer is a swipeable
   `PageView` over every image in the chat.

6. **No Light / Dark / System theme mode.** _(theming)_
   Only dark presets are enabled (`PRESET_ORDER = ['oled-dark','gator']`). Light themes
   (`iosLightTheme`, `brightWhite`, `nord`) exist in code but are excluded, and there's no
   OS-scheme following. A `ThemePreference = ThemeMode|'system'` type is exported but unused.
   Surprising omission for an iOS-styled client.

7. **You can't restore a backup from a file.** _(backup)_
   Restore is **paste-only** — you paste the raw backup text into a `TextInput`. But export
   produces an encrypted `.gatorbackup` file shared via the OS sheet, so restoring means opening
   the file elsewhere, copying the whole ciphertext, and pasting it. `expo-document-picker` is
   installed but wired only to chat attachments. The export→restore round-trip is effectively
   one-way. _Lowest-effort high-value fix: wire the document picker into `backup.tsx`._

8. **No "Start Chats Using" alias selector.** _(profile-misc)_
   For an Apple ID with multiple aliases (a phone + several emails), the old app lets you pick
   which alias new chats are sent from (`setAccountAlias`). RN has no iCloud API endpoint module
   at all, so you can't view or change your outgoing sender identity.

9. **No "Disable Battery Optimizations" prompt.** _(onboarding + profile-misc)_
   The old app has an Android tile/onboarding page to exempt the app from Doze so background FCM
   delivery is reliable. RN never surfaces it and doesn't even declare the permission — a real
   reliability risk for a push-notification app.

---

## Cross-cutting themes

A few gaps recur across many domains — closing one plumbing piece fixes several rows:

- **@mention composing.** RN parses/renders *received* mentions but can't *author* one (no `@`
  autocomplete, no attributedBody encoder, no mention field on send). Appears in composer,
  core-services, and sweep.
- **Subject line.** The HTTP layer accepts `subject`, but no composer field, no setting, and the
  send service never passes it. Appears in composer, private-api, sweep.
- **Set/remove group photo.** RN renders a participant collage (intentional) but has no
  `setIcon`/`removeIcon` endpoint, so you can't *set* a group photo. chat-details + core-services.
- **Save "original" / download-on-demand.** Save works only if the file is already downloaded;
  no re-download, no save of originals (HEIC/live photos). message-actions + media-viewer.
- **Contact card / add-to-contacts.** No view-contact or add-to-contacts anywhere; the contacts
  service only syncs. chat-details + profile.
- **App-side logging.** RN's logger is logcat-only — no file, viewer, filter, export, or clear.
  ("View Server Logs" is the *server's* logs, a different thing.) profile-misc.

---

## Per-domain detail

Legend: **[H]** high, **[M]** medium, **[L]** low (title only). "Partial" = RN has it but
incompletely. Intentional non-alignments and `na-fork` items are omitted here (see agent notes).

### Inbox / conversation list
_Already at parity: mark read/unread (sheet + swipe), mark-all-read, swipe actions, "You:"
preview, compact tiles, redacted masking, service badge (an addition)._

- **[M] Long-press peek preview** — old iOS long-press shows a blurred backdrop + scaled live
  preview of the chat's recent messages with a floating action menu. RN shows a plain action
  sheet (same 5 actions, no preview).
- **[M] Unknown Senders filter + separate list** — old app mutes non-contact senders and routes
  them to a dedicated list. RN has no unknown-sender concept.
- **[M] Advanced search filters** — old search has date/chat/sender/from-me chips + count badge.
  RN search is plain full-text.
- **[M] "Search Mac" server-side search scope** — old app can search the server for un-synced
  messages. RN search is local-FTS only.
- **[M] Unread + mute indicators on pinned tiles** — old pinned avatars show an unread dot + mute
  badge. RN `PinnedGrid` shows avatar + name only.
- **[L]** Delivery/read status on tiles · error label on tile · typing indicator on tile · draft
  indicator on tile · sync spinner in header · camera FAB · profile menu entry · Find My from
  inbox · chat-list appearance settings · unarchive-on-new-message · filtered chat list ·
  secondary-tap context menu.

### Chat view — message list, bubbles, receipts, gestures
_Already at parity: reactive bottom-anchored list, receipts, date separators, reactions, reply
quote + jump, effects, typing bubble, smart replies, search-jump, error-retry, custom-emoji
tapbacks._

- **[H] Group / chat-event system messages** — see shortlist #1.
- **[H] Scroll-back pagination** — see shortlist #2.
- **[M] Reply-thread view** — old app's "N replies" property opens a popup of all replies. RN
  shows a single quote + jump, no thread view or count.
- **[M] Swipe-to-reply gesture** — old app swipes a bubble to set it as reply target. RN's
  `SwipeableRow` is wired only to inbox tiles, not message rows.
- **[M] Swipe-to-reveal per-message timestamps** — old app drags the list left to reveal each
  message's time. RN shows only the aggregate status line.
- **[M] Jump-to-oldest-unread chip** — old app offers a chip to scroll to the first unread. RN
  stores `lastReadMessageGuid` but never surfaces it.
- **[M] Image-gallery grid collapse** — old app collapses consecutive photos into one grid
  bubble. RN stacks them vertically.
- **[M] Delete a confirmed message locally** — see shortlist #3.
- **[M] Per-message Info / details popup** — no per-message metadata view (compounds the missing
  timestamp reveal).
- **[M] Multi-select mode** — no bulk-select of messages.
- **[M] Recipient Focus/DND "notifications silenced" banner** — RN never fetches focus state.
- **[L]** View edit history · send-effect replay label · sender actions (open DM/create contact) ·
  reaction details (who reacted) · bookmark · extended attachment actions · interactive-app
  balloon fallback · send/insert animation.
- **Partials:** receipt line is hidden when "Show Delivery Timestamps" is off (old app keeps the
  label, toggle only adds the time); intra-day time separators missing (RN needs a *different
  day* AND >30min, old app shows a separator on any >30min gap); **reactions don't show on
  attachment-only messages** (nested in the text branch — react to a photo and no badge appears —
  arguably a bug); forward is text-only; no reply-thread connector lines.

### Composer, attachment tray, camera, audio
_Already at parity: multiline field, dynamic send/mic, send-with-return, effect picker on
long-press-send, reply/edit compose, staged-attachment strip, camera photo, recent-media tray,
document picker, local schedule, typing debounce, voice-memo send._

- **[M] Per-chat drafts not persisted** — text + staged attachments live in local `useState`,
  thrown away on unmount. Back out of a half-typed message and it's gone.
- **[M] @mention autocomplete + compose** — see cross-cutting themes.
- **[M] Subject-line compose field** — see cross-cutting themes.
- **[M] Record NEW video with the camera** — the Camera button captures stills only
  (`launchCameraAsync` with no `mediaTypes`).
- **[M] Keyboard content-insertion (Gboard GIF/sticker)** — RN's plain `TextInput` doesn't forward
  the Android `commitContent` API, so a Gboard GIF can't be inserted (this is the *primary*
  Android GIF path).
- **[L]** `:shortcode:` emoji autocomplete · send location · handwritten/digital-touch · keyword→
  effect mapping · incognito keyboard · auto-open keyboard on chat open.
- **Partials:** voice recorder is minimal (no waveform, no review-before-send, sends as generic
  `audio/mp4` not `isAudioMessage:true` so it's not a native voice note); picker lacks the richer
  quick-action column + size guard; **effects can't ride an attachment-only message**; replying
  with just a photo drops the reply threading.

### Message long-press action menu
_Already at parity: React (classic + arbitrary emoji), Reply, Copy, Forward, Save, Remind Me
Later, Edit, Unsend, Cancel Sending._

- **[H] Delete message (local)** — see shortlist #3.
- **[M] Select multiple** — no bulk message selection.
- **[M] Share via system share sheet** — Copy/Forward/Save exist but no Share from a message.
- **[M] View thread** — thread data exists (`threadOriginatorGuid`) but no thread-chain viewer.
- **[L]** Bookmark · Message Info · Open DM (group member) · Start Conversation (group member) ·
  Create Contact · Save Original · Save Live Photo · Re-download attachment.
- **Partials:** Forward is text-only (can't carry attachments; button hidden unless `hasText`);
  Save works only if already downloaded and only to the photo gallery (no documents); menu order
  is fixed (old app is reorderable/hideable via a setting).

### Conversation details / chat settings
_Already at parity: rename, add/remove/leave, mute (honored), custom name/color/background,
shared media, links, redacted masking; RN adds a per-chat bubble accent + adaptive-theme-from-
background the old app lacks._

- **[M] Per-chat Android notification channel** — old app deep-links to the OS per-conversation
  channel (custom sound/importance/vibration). RN has only an in-app mute switch + 3 global
  channels.
- **[M] Set/change chat avatar (group photo + local custom avatar)** — no avatar block at all; no
  `setIcon`/`removeIcon`.
- **[M] Contact card — view/add contact + DM contact info** — no view-contact or add-to-contacts.
- **[L]** Multi-select shared media + bulk save · per-chat private-API overrides · per-chat sync
  range · locations section · voice-call/mail quick-actions · view bookmarks · clear/download
  transcript · lock chat name/icon.
- **Partials:** participant list is a flat name+remove row (old app has avatars, addresses,
  tap-to-contact, per-participant call/mail buttons, collapse); add-participant is a raw text
  field (no contact picker); shared media is a strip not a grid; pin/archive not surfaced in
  details; rename split into local vs server with no unified method dialog.

### New chat creator, contact/handle selectors
_Already at parity (stale-audit HIGHs closed): removable recipient chips that append on tap,
existing-chat detection + "Open it" banner, forward-text-into-new-chat._

- **[M] Per-recipient iMessage availability (chip color + auto SMS switch)** — RN never queries
  availability; all chips one color, user must guess iMessage vs SMS.
- **[M] Address validation (isEmail/isPhoneNumber)** — RN accepts any string as a recipient chip
  ("asdf" becomes a recipient); failure surfaces later as a generic error.
- **[M] E.164 phone normalization** — RN passes typed text verbatim into `createChat`, creating
  potentially malformed handles.
- **[M] Existing chats in search results (Conversations section)** — can't pick an existing
  conversation from the creator (esp. useful for groups).
- **[M] Redacted-mode masking of contact suggestions** — the suggestion list shows raw names/
  numbers even in redacted mode (a leak on this one screen).
- **[L]** Richer suggestion rows (avatar/type/dedup) · validated "Send to <address>" fallback ·
  create progress/error dialog · pre-selected recipients (share deep-link) · autofocus · auto-add
  sole match on submit · empty-state · nickname search · attachment-forward · chat/handle selector
  for search filters.
- **Partials:** existing-chat *detected* but no inline continue (old app embeds the live thread);
  service selection manual-only; contact search thinner (no avatars/formatting/dedup); chips
  single-styled (no service color).

### Fullscreen media viewer
_Already at parity: fullscreen video (expo-video), save-to-Photos, share, blurhash, close._

- **[H] Pinch-to-zoom broken on Android** — see shortlist #4.
- **[H] Swipe carousel (N of M)** — see shortlist #5.
- **[M] Redownload/refresh + download-on-demand in the viewer** — RN only renders when
  `localPath` exists; an undownloaded/corrupt attachment opened from the media grid shows a black
  screen with no retry.
- **[L]** Metadata dialog · video mute toggle + "start muted" · tap-to-toggle chrome · Live Photo
  playback · HEIC/TIFF conversion · reply-to-attachment · HDR→SDR tone-mapping.
- **Partials:** video playback lacks in-viewer mute + custom auto-hide overlay + seamless
  controller reuse; Save/Share hard-disabled when not yet downloaded (no download-then-save
  fallback); zoom inferior even on iOS.

### Find My
_Already at parity (stale-audit's biggest gap closed): interactive OSM/Leaflet map with markers,
zoom/pan, tap-to-focus, popups; 3 tabs; refresh + pull-to-refresh; open-in-Maps; redacted masking
of names + locations + popup; battery display (an enhancement — old app never shows battery)._

- **[M] Current-location marker (own GPS + heading + auto-center)** — RN requests no location
  permission and never plots "you are here".
- **[M] "Last updated <date>" on person rows/popups** — parsed into the model but never rendered.
- **[L]** Location status (Live/Legacy/Shallow) + locating spinner · raw-data debug dialog ·
  distinct marker iconography/avatars.
- **Partials:** live updates via 60s polling not socket push (documented as intentional — Gator's
  Find My backend is a read-only cache with no push events); popups are name-only; no
  "without location" grouped sections.
- _Note: "play sound" and "mark as lost" are **not** old-app features — no endpoints exist — so
  they aren't gaps._

### Setup / onboarding
_Already at parity: QR scan, manual URL+password, sanitize/401/unreachable/version handling,
auto full-sync with per-chat cap + backfill, insecure-http acknowledgement (an improvement)._

- **[M] Permissions request page (Contacts + Notifications)** — RN requests these implicitly/
  lazily with no status UI, re-grant, or "open Settings" recovery.
- **[M] Battery-optimization exemption page** — see shortlist #9.
- **[L]** Sync-time filter · skip-empty-chats · save-sync-log + live log · sync % + progress bar ·
  confetti on complete · restore-during-setup · server-setup help page · custom headers · password
  show/hide.
- **Partials:** messages-per-chat cap present but relocated to Settings (stepper vs slider, not
  shown during onboarding); welcome page static (no animation/mockup); sync feedback shows counts
  not %/log; manual entry omits autofill hints + the "X of 7"/Back/Next chrome.

### Settings root + Chat List panel + Conversation panel
_Already at parity: show delivery timestamps, send-with-return, suggested replies, dense tiles,
working settings search (section-level)._

- **[M] Message status indicators on chat tiles** — no last-outgoing delivery/read state on tiles.
- **[M] Filter Unknown Senders (separate list + notification suppression)** — absent.
- **[M] Unarchive chats on new message** — the realtime sink never clears `is_archived` on an
  inbound message.
- **[M] Store Last Read / scroll back to last unread** — tracked for badge count only; chat always
  renders from the bottom.
- **[L]** Send/receive sounds + volume · keyboard-gesture settings · avatars in DMs · chat name as
  placeholder · replies-to-previous · message-options-order · hide dividers · pin-grid config ·
  pinned-order panel · sync indicator · filtered chat list · double-tap-for-details · camera on
  chat list · hide names in reaction details.
- **Partials:** settings search is section-level (old app is per-item with breadcrumb deep-jump);
  smart replies lack interactive-content detection; scroll-to-bottom-on-send has no toggle.

### Attachment + Notification settings panels
_Already at parity: auto-download, only-on-Wi-Fi (enforced), per-chat mute (honored), message-
notifications toggle, hide-preview redaction._

- **[M] Auto-save attachments** — no auto-export of incoming media to the gallery.
- **[M] Notify for Reactions toggle** — no reaction-notification control.
- **[M] Text Detection mute (global + per-chat)** — no keyword/whitelist muting.
- **[M] Per-chat Temporary Mute (until date/time)** — mute is binary; no timed mute.
- **[M] Per-chat Mute Individuals (group)** — no per-participant mute.
- **[M] Video mute behavior (preview/fullscreen)** — videos always play with audio; no setting.
- **[L]** Dedicated Notification panel (Global vs Chat tabs) · notify on sync complete · suppress
  foreground notifications · image preview quality · custom save location / ask-where.
- **Partials:** quick-reaction from notifications is hardcoded "♥ Love" (old app: toggle +
  LOVE/LIKE picker); redaction is broader/less granular than "hide message text"; parallel
  downloads capped 1–6 vs 1–10; per-chat mute has no `muteType` variants.

### Private API + Redacted mode + Notification providers
_Already at parity: private-API master toggle + typing + read receipts (all gate real behavior);
edit/unsend/reactions/effects/replies; redacted mode masks across the whole app + headless
notifications. Firebase/UnifiedPush/Tasker/keep-alive all correctly na-fork (Gator ships its own
FCM)._

- **[M] Send Subject Lines (toggle + field)** — see cross-cutting themes.
- **[M] Manual Mark Read mode** — RN always auto-marks read on open; no way to read without
  sending a receipt.
- **[M] Granular redacted sub-toggles** — old app has 4 independent toggles (hide content /
  attachments / contact info / fake avatars); RN is all-or-nothing.
- **[L]** Double-tap quick-tapback · generate fake avatars · redacted live-preview + private-API
  setup guidance.
- **Partials:** no "Private API Send / Attachment Send" toggle (hardcoded fast path with
  server-side AppleScript fallback); **mark-unread is local-only, not synced to the Mac** (read is
  synced); redaction uses literal "Message"/"Contact" placeholders vs lorem-ipsum/fake-names.

### Theming / appearance / theme studio
_Already at parity: preset-driven theming, 13-color ThemeStudio with live preview + light/dark
toggle, Custom Themes CRUD, per-chat theme override, adaptive-theme-from-image (per-chat)._

- **[H] Light / Dark / System app-theme mode** — see shortlist #6.
- **[M] Text size / typography scaling** — sizes are hard-coded; ThemeStudio has no text controls,
  so no accessibility text-scaling.
- **[M] Custom avatar image per chat (with crop)** — no way to override a chat's avatar image.
- **[M] Generate GLOBAL theme from seed color / image** — the generator is wired only into the
  per-chat screen, not the global editor.
- **[L]** Font-family picker · custom avatar colors · colorful bubbles · colorful avatars · avatar
  scale · export/import theme JSON · gradient background · iOS emoji font · colors-from-media ·
  refresh-rate selector.
- **Partials:** color editor edits fewer tokens and applies immediately (old app groups colors as
  base+on-color pairs with staged apply/discard); background set has no crop UI; only 2 dark
  presets enabled (light presets exist in code); create seeds only from active theme (no clone).

### Server management / connection / stats / health
_Already **ahead**: RN adds a dedicated Server Health screen (private-API helper connectivity,
Find My key status, FCM config, zrok tunnel/IP/TLS, uptime, alert log, RCS-bridge health) the old
app lacks. Parity on version/macOS/proxy info, latency, restart iMessage/services/server, view
logs, sync, full server-side stats._

- **[M] Configure Custom Headers** — plumbed into `HttpClient` but never provided (no editor);
  matters for reverse-proxy/basic-auth fronting.
- **[L]** iCloud account row · time-sync drift row · manual-sync "how far back" picker · stats
  local-DB source toggle.
- **Partials:** connection status is a one-time mount ping (not a live multi-signal socket grid);
  no manual re-check on the main STATUS panel (Health screen has refresh); server logs are
  viewable/copyable but not exported as a `.log` file; no auto-sync-contacts on/off toggle; server
  URL opens Share instead of copy.
- _`na-fork`: check-for-updates (documented stub), Firebase/OAuth pairing, LAN direct connect._

### Backup & restore
_Already **ahead**: encrypted-by-default (XChaCha20-Poly1305 + Argon2id) vs old plaintext; also
backs up per-chat customizations. Settings + theme backup/restore both present (bundled)._

- **[H] Restore from a file (document picker)** — see shortlist #7.
- **[L]** Name/describe a backup · view raw backup JSON · confirm-before-overwrite.
- **Partials:** one combined file vs independent settings/theme artifacts (can't restore
  themes-only); share-sheet delivery only (no fixed Downloads copy); encrypted-only in the UI
  (plaintext functions exist but unwired).
- _`na-fork`: cloud/server backup — the Gator server registers no `/backup/theme` or
  `/backup/settings` routes (verified against the server repo), so a client would be dead code._

### Scheduled messages + reminders
_Already **ahead**: server-side scheduling (fires while the phone sleeps) with atomic claim,
backoff retry, and crash recovery; local fallback; doze-friendly inexact alarms (no
SCHEDULE_EXACT_ALARM needed)._

- **[M] Recurring scheduled messages** — no recurring concept (stub `schedule` column unused).
- **[M] Completed/sent/error history** — the list filters to `status='pending'`, so a scheduled
  message **vanishes the moment it sends or fails** — no feedback on a failed scheduled send (the
  highest real-world confusion risk here).
- **[M] Reminder preset picker (1h/3h/6h/1d/1w/1mo)** — RN uses a raw date→time spinner; "remind
  me in 1 hour" requires manually dialing an absolute time. Affects create + reschedule.
- **[L]** Standalone scheduled-create screen with chat picker + FAB · overview/stats header.
- **Partials:** scheduled rows don't show the target chat (you can't tell which chat a queued
  message goes to); edit covers text/time only (not chat or recurrence); reminder rows don't show
  the chat/sender label.

### Profile / About / Logging / Troubleshoot
- **[H] "Start Chats Using" alias selector** — see shortlist #8.
- **[H] Disable Battery Optimizations** — see shortlist #9.
- **[M] iMessage Profile: iCloud account info panel** — account name/Apple ID, iMessage/SMS
  status, vetted aliases. No equivalent.
- **[M] iMessage profile name + avatar edit** — no self-identity setting.
- **[M] App log persistence + in-app viewer** — logs are logcat-only (no file/viewer/filter).
- **[M] Download/Share app logs** — no app-log export (the standard bug-report attachment).
- **[M] Security Level "Locked and secured"** — RN's App Lock is cold-boot only; no foreground
  re-auth, app-switcher hiding, or screenshot blocking.
- **[M] Send Delay (cancelable undo-send)** — no configurable pre-send delay/undo.
- **[L]** Sharable contact card · log-level selector · live-logging console · clear logs ·
  incognito keyboard · app version/version-code display · licenses · changelog · API timeout ·
  cancel-queued-on-failure · replace emoticons with emoji · 24h time toggle · high-performance
  mode · upside-down rotation · scroll-speed · max group-avatar count.
- **Partials:** App Lock covers only the base level; About panel is server-info, not app-about;
  delete-a-chat lacks the handle-purge debug framing; 12/24h honored via locale but no toggle;
  logs are server-only.

### Core backend parity — sync, realtime, send/edit/unsend, contacts
_Realtime event coverage is **at full parity or better**: `EventRouter` handles every event the
old `ActionHandler` switch does, plus Gator-only events (message-send-error, new-server,
rcs-alert, rcs-bridge-down). Send/edit/unsend/react solid (incl. custom-emoji tapbacks);
optimistic queue with atomic claim + backoff; sync (full + incremental + backfill) complete._

- **[M] Send @mentions in groups** — see cross-cutting themes.
- **[M] Set/remove custom group chat photo** — no `setIcon`/`removeIcon` endpoints.
- **[M] Auto-detect iMessage vs SMS availability** — no availability query; manual toggle only.
- **[L]** Recipient Focus/DND indicator · "Notify Anyway" for quiet messages · Live Photo motion ·
  embedded interactive media · compose subject · create contact on server · lock-the-Mac admin.
- **Partials:** **mark-unread doesn't sync to the Mac** (read does); **text + attachment sent as
  separate messages** not one multipart bubble (no photo-with-caption); group avatar is a collage
  not the real iMessage group photo (intentional).

### Completeness sweep (areas the other domains might miss)
- **[H] Group-event / tombstone system messages** — same as chat-view #1 (counted once).
- **[M] Big / jumbo emoji rendering** — an emoji-only message renders at ~3× with no bubble in the
  old app; RN renders it as a normal bubble.
- **[M] GIF (Tenor) picker in composer** — no GIF search/picker (needs a Tenor API key to enable).
- **[M] Send current location** — RN receives/renders location but can't send one (no
  expo-location).
- **[M] Android SEND / SEND_MULTIPLE share-target** — the app never appears in Android's share
  sheet (no `intentFilters`; needs expo-share-intent + prebuild).
- **[M] @mention autocomplete in composer** — same theme as above.
- **[L]** Subject line · Focus/DND banner + Notify Anyway · emoji-picker button.
- **Partials:** stickers render as inline images but no peel-and-place overlay on the target
  bubble; notification quick-reply is **present** (checked, not a gap).
- _Checked and **not** gaps (old app lacks them too): home-screen widget, alternate app icons,
  launcher quick-actions, Live Text/OCR, in-app browser, contact-card sending._
