# React Patterns Audit — 2026-07-16

A five-lens review of the Gator RN codebase (state/context, hooks & effects, rendering/list performance,
duplication & modularity, dependencies), produced by a 40-agent workflow: 5 parallel dimension reviewers
→ dedup (39 raw → 34) → **adversarial verification of every finding against the actual code** (33 survived:
29 confirmed as written, 4 confirmed-with-corrections; 1 refuted and excluded).

Statuses below reflect the completed 2026-07-16 fix pass. "Decision" means the right action was to
deliberately not change code; "Deferred" items have a stated gate or follow-up.

## Dimension assessments

### State & context

State management in this app is in very good health overall. Zustand usage is disciplined: of ~60 hook call sites, all but one use narrow primitive selectors ((s) => s.enabled, (s) => s.status[att.guid]), so there is no selector-returns-fresh-object churn and no setState-during-render anywhere; non-React code (services, HTTP auth hooks, event sinks) consistently uses getState()/subscribe instead of hooks, and the kv-backed stores all follow the documented guarded hydrate pattern (try/catch at root layout, re-hydrate at home mount) — themeStore's hydrated-true-on-failure deviation is deliberate and correct, since ThemeProvider gates first paint on it. Context usage is also clean: ThemeProvider memoizes its value and subscribes via three atomic selectors, and store/context division of labor (DB as source of truth, presentation-only downloadStore, ephemeral typing/sync/faceTime stores) matches the documented architecture. The two real problems are (1) a structural remount bug in ChatThemeProvider — it branches between a Fragment and a Provider on the async-arriving chat-theme tokens, exactly the element-type-branching gotcha the repo's own AGENTS.md warns wipes composer drafts and scroll — and (2) @tanstack/react-query being effectively dead weight: one call site (a local-DB FTS search), while the server-status fetching it was installed for is hand-rolled across ~15 useState hooks in two screens plus a zustand store.

### Hooks & effects

Hooks and effects discipline in this codebase is unusually strong. Nearly every async effect carries an alive/cancelled guard (draft load in chat/[guid].tsx:274-286, useSearch, useChatMatches, ThreadSheet, AttachmentTray, ContactCard/LocationCard, media/[guid].tsx), every interval/keyboard/AppState listener I found is cleaned up, the documented Animated-cleanup convention (return () => anim.stop()) is followed at all four sites that start animations in recycling lists (BubbleEffectView, TypingBubble, ScreenEffectOverlay, InvisibleInk), and the documented memo-with-stable-callbacks pattern is correctly implemented end-to-end (chat screen useCallbacks -> MessageList -> MessageRow binding, inbox -> ConversationTile). Infrastructure hooks are exemplary: useReactiveQuery reads the query through a ref so callers need no useMemo, debounces, and cleans up both the timer and the subscription; usePullToRefresh deliberately stabilizes onRefresh and the returned element with a comment explaining the FlashList failure mode it prevents. Guard-heavy native code (VoiceRecorder re-checking liveness after every await, VideoPlayer's try/catch pause) shows the on-device gotchas were internalized. The one real defect found is ChatThemeProvider branching its root element type (Fragment vs Provider) on an async-loading flag - the exact remount trap the project's own AGENTS.md documents for the wallpaper flag - which remounts the whole conversation subtree when a per-chat theme loads or is toggled; everything else is low-severity polish (unswept highlight timers, a latent stale closure in SwipeableRow's once-created PanResponder, a mount-once ref guard that contradicts its own [guid] dependency).

### Rendering & list performance

Rendering and list performance in this codebase is in good shape overall, and the documented patterns are real, not aspirational. The memo-with-stable-callbacks pattern is correctly implemented at the list level: MessageList passes stable useCallback handlers (handleRetry, jumpToReply) and item-taking callbacks bound inside the memoized MessageRow; the chat screen's onLongPressMessage/onSwipeReply/onToggleSelect use useCallback with a messagesRef to keep deps empty; the inbox passes stable openChat/onLongPress to the memoized ConversationTile. FlashList v2 idioms are right everywhere (stable guid keyExtractors, no estimatedItemSize, maintainVisibleContentPosition with startRenderingFromBottom, ref-guarded onStartReached pagination, and a usePullToRefresh hook explicitly engineered so an inline refresh callback cannot destabilize the RefreshControl element). Animated values are consistently created in useRef with unmount cleanup (MessageSwipeWrapper, SwipeableRow, TypingBubble, BubbleEffectView), PanResponders are created once and read fresh callbacks through refs, store subscriptions in rows are narrow selectors (per-guid download status, single boolean flags), StyleSheet.create is used throughout with only small theme-colored dynamic objects, and message grouping is done via O(1) older/newer neighbor comparisons instead of an O(n) bucketing pass. The main structural weakness is that the reactive-query layer rebuilds every row object on every DB flush, so the row memos only shield against screen-state changes, not data ticks — a churn the team has already been bitten by once (the attachment re-download storm) — plus a handful of closure/inline-component slips (inert MessageBubble memo, un-memoized attributedBody parsing, inline ItemSeparatorComponent) that are each cheap to fix.

### Duplication & modularity

The lower layers of this app are genuinely well-modularized: src/db/repositories has a single shared MESSAGE_ROW_SELECT + queryMessageRows helper so message queries can't drift, a _shared.ts for dedupe/chunk/FTS helpers, and exactly one upsert per entity; src/core/api funnels every endpoint through one HttpClient with per-endpoint zod schemas; the send services are thin per-kind orchestrators over shared repository reconcile helpers; and UI primitives (Screen, Icon, ConversationTile, ChatActionsSheet, dialogStore, pickReminderTime reusing pickFutureDateTime) are actually reused by screens. The weakness is concentrated in app/(app)/: the ~17 screens each re-roll the same iOS-settings scaffolding — the back-button header exists in 16 copies across two drifted layout variants, the section/row/group kit is re-implemented per screen with three incompatible local InfoRow components (two with inverted label/value colors), and two screens (archived, unknown-senders) are ~90% byte-identical twins. Several smaller duplications have already produced observable drift: the send-failure logging differs across the four copies of the reconcile block, and the "is this a local file" predicate has two different definitions between the chat long-press menu and the media viewer. Overall verdict: healthy modular core, but the screen layer needs a small shared settings-UI kit (ScreenHeader, Section, SettingsRow variants) before more settings-style screens land — the copy-paste pattern is compounding.

### Dependencies

Dependency hygiene in this project is genuinely good: every one of the ~45 production dependencies is verifiably used (I greped src/ and app/ — the suspicious-looking ones like react-native-webview, expo-camera, expo-web-browser, socket.io-client, and react-native-image-colors all have real import sites; expo-system-ui backs userInterfaceStyle in app.config.ts, expo-linking is a required expo-router peer, and the deferred native modules jail-monkey/ssl-pinning/intent-launcher are lazy-imported exactly as AGENTS.md documents). The version pins that npm-outdated flags as stale (flash-list 2.0.2, webview 13.16.1, datetimepicker 9.1.0, screens 4.25.2) exactly match Expo SDK 56's bundledNativeModules.json — they are correct-as-pinned, not neglected, and jest 29/TypeScript 6 are correctly held back by jest-expo 56 and ts-jest. Two real issues stand out: drizzle-orm 0.36.4 carries a high-severity SQL-injection advisory (CVE-2026-39356, fixed in 0.45.2 — not exploitable in this codebase today since all identifiers are static, and I verified the 0.45.2 op-sqlite driver still expects the legacy interface the drizzleAdapter Proxy provides, so the bump is cheap), and @notifee/react-native was archived by Invertase in April 2026, which makes the notification stack a planning item before any SDK 57 move. Staying on SDK 56 for now is a defensible, documented choice (Expo supports the last three SDKs); the right move is one batched SDK 57 upgrade later, sequenced after a notifee-successor decision. Everything else is low-stakes housekeeping (dev tools sitting in dependencies, pending in-range patch updates).

## Findings

**33 verified findings** — 4 high, 12 medium, 17 low.

### High severity

#### 1. iOS-settings section/row UI re-implemented per screen; three incompatible local InfoRow components and one verbatim Section copy

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/settings.tsx:848, app/(app)/account.tsx:160, app/(app)/server-management.tsx:365, app/(app)/server-health.tsx:356, app/(app)/chat-settings/[guid].tsx:751, app/(app)/backup.tsx:212
- **Verification:** confirmed

**What:** The grouped-rows settings UI (section label + rounded group + hairline-divided rows) is rebuilt from raw Views in at least six screens. Concrete copies: (1) `function Section` in server-management.tsx:365-382 and server-health.tsx:356-373 is byte-identical, as is their `InfoRow` (server-management.tsx:384-401 vs server-health.tsx:375-392) and most of their styles blocks (433-458 vs 394-419). (2) Three INCOMPATIBLE `InfoRow`s exist: settings.tsx:848-874 takes `value`+`top` (top border opt-in, label=theme label, value=secondaryLabel); account.tsx:160-187 takes `value`+`last` (bottom border opt-out) with the COLORS INVERTED (label=secondaryLabel, value=label); server-*.tsx takes `children` with an always-on top border. (3) The row/group/sectionLabel styles have already drifted: row paddingVertical is 14 (settings.tsx:898-904), 13 (server-management.tsx:448-456), and 10 (chat-settings/[guid].tsx:775-781); sectionLabel marginLeft is 12 (settings.tsx:896) vs 30 (server-management.tsx:446). (4) Inside settings.tsx alone, the `borderTopColor/borderTopWidth` divider object is restated inline ~15 times (e.g. 253-260, 269-277, 281-289, 293-301), and the +/- stepper widget is duplicated in-file (Downloads stepper 580-621 vs Sync stepper 639-680). All components also take `theme` as a prop instead of calling useTheme().

**Recommendation:** Create a settings kit in src/ui/primitives (e.g. SettingsSection, SettingsRow, SwitchRow, NavRow, InfoRow, Stepper) that call useTheme() internally and own the divider logic (first-child no border). Port settings.tsx first (it would shrink by several hundred lines), then account/server-management/server-health/chat-settings/backup. Estimated shared abstraction: ~120 lines replacing ~600+ lines of per-screen scaffolding.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 2. drizzle-orm 0.36.4 has a high-severity SQL-injection advisory; fix (0.45.2) keeps the op-sqlite adapter hack intact

- **Dimension:** Dependencies
- **Where:** package.json:30, src/db/database.ts:43
- **Verification:** confirmed

**What:** npm audit flags drizzle-orm <=0.45.1 as HIGH: CVE-2026-39356 / GHSA-gpj5-g38j-94v9 — embedded quote characters in SQL identifiers are not escaped by escapeName(), so attacker-controlled input reaching sql.identifier() or .as() can break out of the quoted identifier (advisory: https://github.com/advisories/GHSA-gpj5-g38j-94v9). I verified this codebase is NOT currently exploitable: zero uses of sql.identifier( or .as( in src/, and all raw sql`` templates use static identifiers with bound parameters. AGENTS.md pins drizzle around the op-sqlite v17 adapter (the drizzleAdapter Proxy at src/db/database.ts:43-68 that fakes executeAsync/executeRawAsync/rows._array). I downloaded drizzle-orm@0.45.2 and inspected its op-sqlite/session.cjs: it STILL calls executeAsync (1x), executeRawAsync (1x), and rows._array (2x) — the exact legacy interface the Proxy provides — so upgrading does not break or obsolete the adapter.

**Recommendation:** Bump drizzle-orm ^0.36.4 -> ^0.45.2, then run `npm run typecheck` and `npm test` (both jest projects). The 0.37–0.45 changelogs are mostly Postgres/MySQL-facing; the SQLite query-builder surface this app uses is small and the node-suite repository tests will catch regressions. Even though the CVE isn't reachable today, a future dynamic ORDER BY or alias would walk straight into it — take the cheap fix.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 3. @notifee/react-native was archived by Invertase (April 2026) — the notification stack sits on an unmaintained package

- **Dimension:** Dependencies
- **Where:** package.json:22, src/services/notifications/notifeeService.ts:1
- **Verification:** confirmed

**What:** Invertase archived github.com/invertase/notifee on 2026-04-07; the last release is the exact 9.1.8 this app pins (December 2024). The app's notification core is built on it: notifeeService (MessagingStyle, channels), FaceTime full-screen-intent call notifications, and reminder TimestampTriggers — plus a page of hard-won Notifee gotchas in AGENTS.md. The package.json already excludes notifee from expo doctor's directory check (package.json:104), so the team knows it's off-registry, but archival means no fixes for future RN/Android API changes. Invertase's archived README points to expo-notifications (which lacks foreground-service and some rich-Android features this app uses, e.g. full-screen intents) or the community drop-in fork react-native-notify-kit (launched April 2026, TurboModules/new-arch: https://github.com/marcocrupi/react-native-notify-kit).

**Recommendation:** No action needed on SDK 56 — 9.1.8 works today. But treat a notifee successor as a GATE for the SDK 57 / RN 0.86 upgrade: evaluate react-native-notify-kit as the drop-in path (vet its maturity first — it is only a few months old) vs. expo-notifications (check whether full-screen intent + trigger alarms + MessagingStyle are covered before choosing it). Do the swap in its own verified step, not inside the SDK bump.

**Status:** Deferred — planning gate before the SDK 57 upgrade: evaluate react-native-notify-kit vs expo-notifications (must cover full-screen intents, timestamp triggers, MessagingStyle) in its own verified step. **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

#### 4. ChatThemeProvider branches Fragment vs Provider on an async flag, remounting the entire chat screen when a per-chat theme loads or changes

- **Dimension:** State & context
- **Where:** src/ui/theme/ChatThemeProvider.tsx:65, app/(app)/chat/[guid].tsx:107
- **Verification:** confirmed

**What:** ChatThemeProvider renders `if (!chatTokens) return <>{children}</>; return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;` (lines 65-66). chatTokens comes from useReactiveQuery, whose data is ALWAYS null on first render (src/db/useReactiveQuery.ts initializes `{ data: null, isLoading: true }` and fills it in an async effect). So for any chat with a stored theme, the first commit renders a Fragment and the async resolve flips the root element type to ThemeContext.Provider — React reconciles by element type, unmounts the old subtree, and remounts ChatScreenInner (all of app/(app)/chat/[guid].tsx: message window `limit`, replyTo, editing, selected, composer draft, scroll position, markRead ref). The same remount fires in reverse when a theme is applied or cleared from chat-settings/ThemeStudio (applyChatTheme at chat-settings/[guid].tsx:153-156, clearChatTheme:207-214) while the chat sits behind it in the expo-router stack. This is precisely the element-type-branching gotcha AGENTS.md documents for the wallpaper flag ('branching element types on the flag remounts the whole subtree, wiping the composer draft/staged attachments/scroll position') — fixed there, but left structural here. The `value` memo on line 62 already computes `chatTokens ?? globalTheme`, so the early return buys nothing.

**Recommendation:** Delete the `if (!chatTokens) return <>{children}</>;` early return and always render `<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>`. The memoized value already falls back to globalTheme, so unthemed chats behave identically while keeping one stable element type (no remount).

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

### Medium severity

#### 5. The '‹ Back' screen header is copy-pasted into 16 screens, in two already-drifted layout variants

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/settings.tsx:144, app/(app)/server-management.tsx:178, app/(app)/facetime.tsx:57, app/(app)/logs.tsx:60, app/(app)/new-chat.tsx:168, app/(app)/themes.tsx:95
- **Verification:** adjusted

**What:** Confirmed as written: 17 copy-pasted header blocks (16 screens + server-management's logs Modal) in two drifted layout variants — variant A optically centers the title (back/spacer width 70, flex centered title) on 8 screens; variant B uses space-between with unfixed back width and a 50px right slot (facetime.tsx inlines the 50px View literally) on 5 screens, leaving those titles slightly off-center; logs.tsx is a hybrid. A ScreenHeader primitive does not yet exist in src/ui/primitives. Severity is medium, not high: the duplication is real and the drift user-visible, but the impact is cosmetic (few-pixel title misalignment) and maintenance-cost only.

**Recommendation:** Add a `ScreenHeader({ title, right?, onBack? })` primitive to src/ui/primitives that owns the insets padding, separator, back button, and title centering, then replace the 17 copies. ~40 lines replacing ~300, and the centering behavior becomes consistent.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 6. archived.tsx and unknown-senders.tsx are ~90% identical twin screens, with the ChatActionTarget mapping copy-pasted a third time

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/archived.tsx:12, app/(app)/unknown-senders.tsx:15, src/ui/conversations/ConversationListScreen.tsx:66
- **Verification:** confirmed

**What:** The two screens are line-for-line the same component: same imports, same `openChat` useCallback, same `onLongPress` mapping, same header, same FlashList with ConversationTile/ItemSeparator/ChatActionsSheet, and byte-identical styles blocks (archived.tsx:73-88 vs unknown-senders.tsx:79-94). The ONLY differences are the filter predicate (archived.tsx:17 `(data ?? []).filter((r) => r.isArchived)` vs unknown-senders.tsx:20-23 `filter((r) => r.hasKnownSender !== 1 && !r.isArchived)`), the title string, and the empty-state copy. Additionally the 10-line `InboxRow → ChatActionTarget` mapping (`{ guid, title: resolveTitle(row), isPinned: !!row.isPinned, isArchived: !!row.isArchived, muted: row.muteType === 'mute', unread: (row.unreadCount ?? 0) > 0 }`) is copy-pasted in three places: ConversationListScreen.tsx:67-74, archived.tsx:25-32, unknown-senders.tsx:31-38 — a new sheet field (e.g. a future 'hasKnownSender' action) must be added in three spots or the sheets silently diverge.

**Recommendation:** Extract a `FilteredChatListScreen({ title, emptyText, filter, includeArchived? })` component in src/ui/conversations and reduce both routes to ~10-line wrappers. Export a `toChatActionTarget(row: InboxRow)` helper from ChatActionsSheet.tsx and use it in all three call sites.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 7. Optimistic-send reconcile/error block duplicated 4x across the send layer, and the failure logging has already drifted

- **Dimension:** Duplication & modularity
- **Where:** src/services/send/sendService.ts:98, src/services/send/sendAttachmentService.ts:87, src/services/send/sendReactionService.ts:62, src/services/send/outgoingQueueService.ts:63
- **Verification:** confirmed

**What:** The exact same post-POST sequence — `if (server.guid) { await reconcileOutgoingSuccess(db, tempGuid, { guid: server.guid, dateCreated: now, dateDelivered: null }); } else { await markOutgoingSentNoGuid(db, tempGuid); }` plus the catch `const code = sendErrorCode(e instanceof ApiError ? (e.status ?? null) : null); await reconcileOutgoingError(db, tempGuid, code)` — appears verbatim in sendService.ts:98-120, sendAttachmentService.ts:87-100, sendReactionService.ts:62-74, and outgoingQueueService.ts:63-77. Drift is already visible in the catch blocks: sendService.ts:112-118 logs a rich diagnostic (error code + HTTP status + server message, added specifically so RCS auth-expiry failures are diagnosable), sendAttachmentService.ts:97 logs only the bare message with no code/status, and sendReactionService.ts:71-73 and outgoingQueueService.ts:73-76 log nothing at all — so a failed reaction or a failed queue retry is still the 'silent errored bubble' the sendService comment says was fixed. The surrounding preamble (getChatIdByGuid + throw 'unknown chat' + generateTempGuid) is also repeated in all three UI-facing senders.

**Recommendation:** Add a shared helper in src/services/send (e.g. `reconcileSendOutcome(db, tempGuid, ack, now)` and `handleSendFailure(db, tempGuid, e, now, logTag)`) of ~20 lines, with the rich logging from sendService in the failure path, and call it from all four sites. The layer stays Node-testable and every send kind gets the diagnostic logging.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 8. Contact-suggestion search effect + suggestion list UI duplicated between new-chat and the FaceTime dialer

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/new-chat.tsx:78, app/(app)/facetime.tsx:24
- **Verification:** adjusted

**What:** new-chat and the FaceTime dialer duplicate the contact-suggestion machinery: a structurally identical debounce-less search effect (active flag, searchContactAddresses(getDatabase(), q, 30), catch → setSuggestions([]), cleanup) at new-chat.tsx:85-99 vs facetime.tsx:24-37 (new-chat additionally filters out already-chosen recipients), a nearly verbatim suggestion-list JSX block at new-chat.tsx:329-348 vs facetime.tsx:124-143 (only the onPress differs: add chip vs set recipient), and byte-identical suggestions/suggestion/suggestionName/suggestionAddr styles (new-chat.tsx:394-397 vs facetime.tsx:173-176). The toLine/toLabel/toInput input-row styles, however, are NOT duplicates — they intentionally differ (flex-start + marginTop + flexGrow/minWidth for the chip token field vs center + flex:1 for the single input) and should stay per-screen. Any fix to the search effect or suggestion list (avatars, debouncing) must currently be made twice; a useContactSearch(query) hook plus a ContactSuggestionList component (with the chosen-recipient filter applied by the caller) would deduplicate it.

**Recommendation:** Extract a `useContactSearch(query)` hook (src/features/contacts) plus a `<ContactSuggestionList suggestions onPick />` component in src/ui, and use them from both screens.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 9. Oversized multi-job screens: chat/[guid].tsx (904 lines), settings.tsx (911), chat-settings/[guid].tsx (809); services/index.ts at 636

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/chat/[guid].tsx:298, app/(app)/settings.tsx:34, app/(app)/chat-settings/[guid].tsx:76, src/services/index.ts:53
- **Verification:** confirmed

**What:** Four files exceed the 600-line mark while doing several jobs. chat/[guid].tsx (904) hosts, besides the (documented, intentional) wallpaper-chrome layout: ~15 message-action handlers (onLongPressMessage:298-328, bulk copy/delete:352-382, unsend:401-415, cancel:417-435, share:468-489, delete:494-505, forward:509-512, save:516-544, remind-later:546-567), multi-select mode state, the scheduled-message ticker (214-235), draft persistence (272-294), and file picking (572-591) — the action handlers alone are ~300 lines that don't depend on the screen's layout. settings.tsx (911) inlines every section's UI plus the search-keyword matching. chat-settings/[guid].tsx (809) combines chat customization, group management, theme/background generation, and the shared-media browser (MediaSections/MediaThumb, 587-749, which could live in src/ui). src/services/index.ts (636) is the composition root but also carries boot orchestration, app-lock, cert pinning, sync coalescing (365-460), realtime lifecycle (462-546), and one-off app services (markRead, sendTyping, createNewChat) in one module.

**Recommendation:** Extract a `useMessageActions(guid, selected, …)` hook (src/features/conversations) for the chat screen's action handlers, move MediaSections/MediaThumb into src/ui/conversations, and let the settings kit shrink settings.tsx. For services/index.ts, split sync control and realtime lifecycle into src/services/syncControl.ts and src/services/realtimeControl.ts, keeping index.ts as the wiring-only composition root.

**Status:** Partial this pass — extract useMessageActions from the chat screen and move MediaSections/MediaThumb into src/ui; the services/index.ts split is deferred (composition root / boot path — only verifiable on device). **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

#### 10. Expo SDK 57 is out; staying on SDK 56 is currently correct — plan one batched upgrade later

- **Dimension:** Dependencies
- **Where:** package.json:33, app.config.ts:51
- **Verification:** confirmed

**What:** npm-outdated shows expo 57.0.6 / react-native 0.86.0 as latest while the app pins expo ~56.0.12 / RN 0.85.3 — a deliberate choice per AGENTS.md. Important context: the native deps npm-outdated calls stale are NOT stale — @shopify/flash-list 2.0.2, react-native-webview 13.16.1, @react-native-community/datetimepicker 9.1.0, react-native-screens 4.25.2, react-native-safe-area-context 5.7.0 all exactly match SDK 56's bundledNativeModules.json (verified locally), and bumping them independently would break the SDK contract. Likewise expo-share-intent 7.0.0 is the correct major for SDK 56 (its compat table maps v8.x to SDK 57 — do not bump it now). SDK 57 changes little for this app (RN 0.85->0.86; React stays 19.2), and Expo supports the three most recent SDKs, so 56 has runway.

**Recommendation:** Stay on SDK 56 now. When upgrading, do ONE batched pass: expo 57 (`npx expo install --fix` handles the bundled pins) + expo-share-intent 8.x + @react-native-firebase 25 (its messaging permission-API deprecation is the only breaking change relevant here) + jest-expo/babel-preset-expo/eslint-config-expo 57 — sequenced AFTER the notifee-successor decision, followed by a clean native rebuild and the on-device spike checks in docs/SPIKES.md.

**Status:** Decision — stay on SDK 56 for now; do one batched upgrade later (expo 57 + expo-share-intent 8 + RN-Firebase 25 + jest-expo/babel-preset/eslint-config 57), sequenced after the Notifee-successor decision, followed by a clean native rebuild. **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

#### 11. zod v4 is a meaningful runtime/tooling win and the migration cost here is measurably small

- **Dimension:** Dependencies
- **Where:** package.json:73, src/core/models/attachment.ts:24
- **Verification:** confirmed

**What:** zod 3.25.76 is installed; latest is 4.4.3. This app zod-parses every API response, model, and realtime/FCM payload (21 importing files), including the hot message-sync path, and zod v4 is substantially faster at parse time, lighter in the bundle, and much cheaper for tsc. I greped for v4-breaking APIs: exactly ONE hard break — `z.record(z.unknown())` at src/core/models/attachment.ts:24 (v4 requires the two-arg form; server.ts:66 already uses it) — plus ~30 `.passthrough()` sites (deprecated in v4 but still functional; mechanical rename to `.loose()`/z.looseObject later). No `.errors`, errorMap, invalid_type_error/required_error, or `.email()/.url()` string-method usage found.

**Recommendation:** Low-risk, incremental path: the currently-installed zod 3.25.x already ships the `zod/v4` subpath, so you can switch imports file-by-file (`import { z } from 'zod/v4'`) and run the test suite between steps, before ever bumping the package to 4.x. Fix the one z.record() site first.

**Status:** Partial this pass — fix the one breaking z.record() site now; the full zod/v4 subpath migration is deferred to its own verified pass (21 importing files). **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

#### 12. Inline component types recreated per render: ItemSeparatorComponent in three inbox-style screens and EffectPicker's nested Chip — separators unmount/remount on every re-render

- **Dimension:** Rendering & list performance
- **Where:** src/ui/conversations/ConversationListScreen.tsx:289, app/(app)/archived.tsx:56, app/(app)/unknown-senders.tsx:62, src/ui/conversations/effects/EffectPicker.tsx:28
- **Verification:** confirmed

**What:** All three inbox-style screens pass `ItemSeparatorComponent={() => (<View style={[styles.separator, { backgroundColor: theme.color.separator }]} />)}`. ItemSeparatorComponent is a component TYPE, not an element: a fresh arrow function each render is a different type to the reconciler, so React unmounts and remounts every rendered separator view instead of updating it. In ConversationListScreen this happens on every useChats reactive tick (any incoming message anywhere) and on every keyboardDidShow/Hide toggle (the kbVisible state at line 46-54 re-renders the screen) — native view destroy/create work that is strictly worse than a re-render, multiplied by the number of visible rows. This is the one place the codebase's otherwise disciplined "stable identity for list props" rule (cf. the memoized refreshControl in usePullToRefresh, the memoized `rows` fallback at line 39) was missed. Same anti-pattern in EffectPicker.tsx:28, which defines `const Chip = ({id,label}) => ...` inside the component body — any state inside Chip would be wiped per render; here it costs remounts of each chip on re-render. All are stateless leaf views so this is churn, not breakage.

**Recommendation:** Hoist the separator to a module-scope component that reads the theme itself — e.g. `function InboxSeparator() { const theme = useTheme(); return <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />; }` — and pass `ItemSeparatorComponent={InboxSeparator}` in all three screens. Move Chip to module scope taking theme/pick as props.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 13. Reactive-query identity churn defeats MessageRow/ConversationTile memo on every DB flush

- **Dimension:** Rendering & list performance
- **Where:** src/features/conversations/useMessages.ts:75, src/features/conversations/useChats.ts:12, src/db/useReactiveQuery.ts:69, src/ui/attachments/ImageAttachment.tsx:50
- **Verification:** confirmed

**What:** useMessages returns `msgs.map((m) => ({ ...m, attachments…, reactions…, replyPreview… }))` — a fresh object per message on every re-query — and useReactiveQuery re-fires on ANY write to the watched tables at table granularity (TABLES = ['messages','handles','attachments'] in useMessages.ts:19; fireOn per-table in useReactiveQuery.ts:72). So an incoming message in a DIFFERENT chat, a delivery-status update, or a localPath write re-renders every visible MessageRow (its `msg` prop fails React.memo's shallow compare) and every visible ConversationTile in the inbox (same churn via useChats). The memo shield therefore only covers screen-local state changes, not data ticks. The codebase already documents a real bug caused by exactly this churn: ImageAttachment.tsx:50-52 — "the whole `att`, which useMessages rebuilds as a fresh object on every reactive flush (that identity churn is what caused the re-download storm)". Cost per tick is bounded (FlashList mounts ~15-25 rows; 24ms debounce) but each row re-render includes attributedBody JSON.parse, regex linkify, and swipe-wrapper interpolations — and sync backfills produce long bursts of ticks.

**Recommendation:** Preserve referential identity across re-queries: keep a ref-cached Map<guid, EnrichedMessage> inside useMessages (and the equivalent in useChats) and return the previous object when the row's content is unchanged (compare a cheap fingerprint — e.g. the raw row's mutable columns: dateEdited/dateRetracted/sendState/error/localPath/reaction count — before allocating a new object). Unchanged rows then keep their identity and the existing React.memo on MessageRow/ConversationTile starts doing its job on data ticks, not just UI-state changes.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 14. MessageBubble's React.memo is inert — MessageRow hands it fresh closures every render

- **Dimension:** Rendering & list performance
- **Where:** src/ui/conversations/MessageRow.tsx:147, src/ui/conversations/MessageBubble.tsx:52
- **Verification:** confirmed

**What:** MessageBubble is memoized with the justification "it does heavy work: attachments, reactions, URL preview, run rendering" (MessageBubble.tsx:51), but MessageRow creates new arrow functions on every one of its own renders: `onRetry={onRetry ? () => onRetry(msg) : undefined}`, `onLongPress={onLongPress ? () => onLongPress(msg) : undefined}`, `onJumpToReply={onJumpToReply && originator ? () => onJumpToReply(originator) : undefined}` (lines 147-149), plus `onReply={onSwipeReply ? () => onSwipeReply(msg) : undefined}` to MessageSwipeWrapper (line 173). Any MessageRow re-render whose cause does NOT touch the bubble — entering/exiting multi-select (the `selecting` prop flips for every row, app/(app)/chat/[guid].tsx:339 + MessageList.tsx:213), the highlight flash, an isLastOutgoing change, an older/newer neighbor change — still re-renders every affected MessageBubble, re-running parseAttributedRuns (JSON.parse), firstUrl regex, and linkify. The documented pattern (bind the item inside the memoized row) was applied one level up but not carried through to the row→bubble boundary, so the second memo gate never engages.

**Recommendation:** Wrap the three bubble bindings in useCallback inside MessageRow (e.g. `const retryBound = useCallback(() => onRetry?.(msg), [onRetry, msg])`) so MessageBubble's memo holds whenever msg and the outer handlers are unchanged — consistent with the pattern already documented for the list→row boundary. (Note this only pays off fully once row-object identity is preserved across ticks — see the identity-churn finding.)

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 15. attributedBody is JSON-parsed on every MessageBubble render — no useMemo

- **Dimension:** Rendering & list performance
- **Where:** src/ui/conversations/MessageBubble.tsx:92, src/core/richtext/parser.ts:40
- **Verification:** confirmed

**What:** `const runs = parseAttributedRuns(msg.attributedBody, msg.text)` (MessageBubble.tsx:92) executes JSON.parse plus run/gap reconstruction (parser.ts:40-76) on every bubble render, and the derived chain — bodyTextOf, firstUrl regex (line 98), the urlOnly replace/regex (lines 105-110), isBigEmoji (line 117) — re-runs with it. Because MessageBubble re-renders on every reactive flush (fresh `msg` identity) and on every MessageRow re-render (fresh closures), every visible bubble re-parses its attributedBody on every DB write burst — e.g. during a chat backfill sync or a rapid delivery-status cascade. This is the one expensive computation in the hot render path that has no memoization at all, in a codebase that otherwise memoizes carefully (rows reverse, lastOutgoingId reduce, contentStyle are all useMemo'd in MessageList).

**Recommendation:** Memoize on the underlying strings, which stay stable even when the object identity churns: `const runs = useMemo(() => parseAttributedRuns(msg.attributedBody, msg.text), [msg.attributedBody, msg.text])`, and fold bodyText/previewUrl/bigEmoji into the same or dependent useMemos. Because the keys are primitives, this fix works today, independent of the identity-churn fix.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 16. @tanstack/react-query is installed and provided app-wide but has exactly one consumer — a local-DB query — while server fetching is hand-rolled three different ways

- **Dimension:** State & context
- **Where:** src/state/queryClient.ts:8, src/features/conversations/useChatSearch.ts:13, app/_layout.tsx:58, app/(app)/server-health.tsx:53, app/(app)/server-management.tsx:38, app/(app)/account.tsx:26, src/state/findmyStore.ts:107
- **Verification:** confirmed

**What:** queryClient.ts's docblock claims Query handles 'server-cache data (chats, messages, contacts, server info)', and QueryClientProvider wraps the whole app (app/_layout.tsx:58). In reality the only useQuery in the codebase is useChatSearch — which queries the LOCAL encrypted DB's FTS index (`queryFn: () => searchMessages(getDatabase(), trimmed)`), not the server, so retry:1/staleTime:30s semantics buy nothing and can even serve 30s-stale search results after new messages arrive. Meanwhile the actual server-cache fetching react-query exists for is hand-rolled several ways: server-health.tsx holds 12 useState hooks fed by a Promise.allSettled of 10 endpoint calls in a useEffect (lines 53-108); server-management.tsx runs THREE separate `let alive = true` effects (46-66 ping/latency, 71-87 stats, 92-103 server-info) each with its own alive-flag/cleanup boilerplate into 5 useState hooks; account.tsx:22-38 builds a manual 'loading'|'ready'|'error' status machine around getAccountInfo; and findmyStore is a zustand store reimplementing loading/refreshing/error request state around findMyApi calls. Grep shows 8 hand-rolled alive-flag effects total (new-chat.tsx:56, server-management.tsx:47/72/93, chat/[guid].tsx:275, media/[guid].tsx:52, ThreadSheet.tsx:34, useSmartReplies.ts:24). None of this is broken, but the app carries competing patterns for async server reads plus a dependency that is ~99% dead weight, and the queryClient docblock is factually wrong about what it manages.

**Recommendation:** Pick a direction: either (a) migrate the read-only server-status fetching (server-health, server-management stats/latency, account, findmyStore's load/refresh) to useQuery/useQueries so loading/error/refresh state stops being hand-rolled, or (b) drop @tanstack/react-query entirely, inline useChatSearch as a debounced useEffect (or add a tiny shared useAsyncData(fn, deps) hook that owns the alive-flag pattern once), and remove the provider. Either way, correct the queryClient.ts docblock to describe what it actually owns.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

### Low severity

#### 17. Attachment share/save logic duplicated between the chat long-press menu and the media viewer, with a drifted local-file predicate

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/chat/[guid].tsx:468, app/(app)/media/[guid].tsx:26
- **Verification:** adjusted

**What:** Two screens duplicate attachment share/save logic: chat/[guid].tsx onShareSelected (475-496) and onSaveSelected (523-551) vs media/[guid].tsx onShare (85-93) and onSave (95-104), with textually drifted local-file predicates (media/[guid].tsx:27-29 accepts only 'file://'; chat/[guid].tsx:480,536 also accept a bare '/'). The drift is latent, not behavioral: all production localPath writers (expoFetcher/devFetcher return expo-file-system File.uri, sendAttachmentService stores 'file://' picker URIs, devSeed stores an excluded 'https://' URL) emit 'file://' URIs, so the bare-'/' branch is dead code and both predicates currently agree on every real attachment. This is a maintainability/duplication concern — a future writer storing a bare path would silently behave differently per screen — not a present user-visible bug.

**Recommendation:** Add `isLocalFileUri(path)` to src/utils and `shareAttachment(localPath, mimeType)` / `saveAttachmentsToPhotos(paths)` helpers (e.g. src/services/media.ts), then use them from both screens so the predicate and the permission/error handling live once.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 18. reminders.tsx and scheduled.tsx share a byte-identical styles block and near-identical list-row scaffold

- **Dimension:** Duplication & modularity
- **Where:** app/(app)/reminders.tsx:86, app/(app)/scheduled.tsx:155
- **Verification:** confirmed

**What:** The two 'text + timestamp + right action' list screens duplicate their entire StyleSheet (reminders.tsx:86-111 vs scheduled.tsx:155-181: header/back/title/spacer/row/rowText/text/when/cancel/cancelText/empty all have identical values; scheduled adds only sectionLabel) and the row structure (Pressable rowText with numberOfLines={2} title + `when` line + trailing destructive Pressable: reminders.tsx:63-77 vs scheduled.tsx:94-143). The behaviors differ (reschedule-vs-edit, delete-vs-cancel/clear), so a full screen merge isn't warranted, but the presentation layer is pure copy-paste — a font/padding tweak must be made twice and the two screens will drift visually.

**Recommendation:** Extract a small `ActionListRow({ title, subtitle, subtitleColor?, onPress, action: { label, color, onPress } })` component (and lean on the shared ScreenHeader). Both screens keep their own data/handlers and lose their duplicated styles.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 19. Keyboard-visibility effect duplicated between the inbox and the chat screen

- **Dimension:** Duplication & modularity
- **Where:** src/ui/conversations/ConversationListScreen.tsx:46, app/(app)/chat/[guid].tsx:594
- **Verification:** confirmed

**What:** The identical `kbVisible` state + `Keyboard.addListener('keyboardDidShow'/'keyboardDidHide')` effect appears in ConversationListScreen.tsx:46-54 and chat/[guid].tsx:595-603; the chat copy's comment even says 'Same fix as the inbox', acknowledging the copy-paste. This guards a subtle Android edge-to-edge KeyboardAvoidingView bug, so a future fix (e.g. also listening to keyboardWillShow, or handling a race) has to be discovered and applied twice.

**Recommendation:** Extract a `useKeyboardVisible(): boolean` hook (e.g. src/ui/hooks/useKeyboardVisible.ts or src/features), documented with the edge-to-edge rationale, and use it in both screens.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 20. Chat screen's mark-read effect is mount-once (ref-guarded) despite a [guid] dependency, so a reused screen would never mark the new chat read or sync it

- **Dimension:** Hooks & effects
- **Where:** app/(app)/chat/[guid].tsx:181
- **Verification:** confirmed

**What:** The effect body starts with `if (markedRef.current || !guid) return; markedRef.current = true;` (lines 182-183) and the ref is never reset, yet the effect declares `[guid]` deps (line 206). If the mounted screen instance ever receives a different guid param (expo-router param change without remount), the ENTIRE body - markRead, clearChatNotification, ensureChatSynced, ensureSyncedBackground, first-unread capture - silently skips for the new chat. The codebase itself treats screen reuse as plausible: useNewScreenEffect.ts:25-27 defensively resets its ref on chatGuid change with the comment 'reset the ref so a reused screen can't suppress effects'. The mark-read effect lacks the same reset, an internal inconsistency.

**Recommendation:** Reset the guard per guid, mirroring useNewScreenEffect: add `useEffect(() => { markedRef.current = false; }, [guid]);` before this effect, or replace the ref guard entirely (the [guid]-keyed effect already runs exactly once per guid on its own).

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 21. MessageList highlight timers are never cleared on unmount and the 450ms focus-scroll setTimeout is untracked

- **Dimension:** Hooks & effects
- **Where:** src/ui/conversations/MessageList.tsx:128, src/ui/conversations/MessageList.tsx:148, src/ui/conversations/MessageList.tsx:149
- **Verification:** confirmed

**What:** `highlightTimer.current = setTimeout(() => setHighlightGuid(null), 1600)` (jumpToReply, line 128) and `...3000` (focus effect, line 148) are cleared only when superseded by another highlight - no effect cleanup clears them on unmount, so leaving the chat mid-highlight fires setHighlightGuid(null) on an unmounted component (a silent no-op in React 19, but a leaked timer). The anonymous `setTimeout(() => { listRef.current?.scrollToIndex(...) }, 450)` on lines 149-155 is not stored at all, so it can neither be cancelled by the cleanup nor by a newer focus target; it survives unmount (saved only by the `?.` on the nulled ref).

**Recommendation:** Add an unmount effect: `useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);` and store the 450ms scroll timeout in a ref cleared the same way (or move it into the focus effect's cleanup).

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 22. SwipeableRow's once-created PanResponder closes over leftW/rightW from the first render (latent stale closure)

- **Dimension:** Hooks & effects
- **Where:** src/ui/conversations/SwipeableRow.tsx:58
- **Verification:** confirmed

**What:** `const responder = useRef(PanResponder.create({...})).current` creates the responder once, and its onPanResponderMove/onPanResponderRelease closures capture `leftW`/`rightW` (lines 44-45, derived from the left/right props) from the initial render: `next = Math.max(-rightW, Math.min(leftW, next))` (line 68) and `snap(-rightW)` (line 73). In a recycling FlashList the same instance is reused for different rows, so if action counts ever differ per row the clamp/snap widths are wrong. Today ConversationTile always passes 1 left + 3 right actions (ConversationTile.tsx:90-122), so it is benign - but the sibling component solved this exact problem correctly: MessageSwipeWrapper.tsx:35-36 routes the changing prop through `onReplyRef` with the comment 'the responder is created once; ref the latest onReply... isn't stale inside it'.

**Recommendation:** Mirror MessageSwipeWrapper: keep `const widthsRef = useRef({leftW, rightW}); widthsRef.current = {leftW, rightW};` and read widthsRef.current inside the responder callbacks, so the clamp can never desync if actions become conditional.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 23. new-chat availability-probe effect discards in-flight probes and re-issues them on every recipient change (O(N^2) probes), and the existing-chat effect has no rejection handler

- **Dimension:** Hooks & effects
- **Where:** app/(app)/new-chat.tsx:55, app/(app)/new-chat.tsx:101
- **Verification:** confirmed

**What:** The probe effect (lines 55-71) loops recipients and fires checkIMessageAvailability for each address with `availability[r.address] === undefined`, guarded by a per-effect `alive` flag. Because the effect re-runs on every `recipients` change and its cleanup sets alive=false, adding recipient B while A's probe is still in flight discards A's result (component still mounted) and the new run re-probes A - adding N recipients quickly issues up to N(N+1)/2 network probes, and a slow probe's answer is thrown away rather than applied. Separately, the exact-participants lookup (lines 101-109) is `void findChatByParticipantAddresses(...).then((g) => {...})` with no .catch - a DB rejection surfaces as an unhandled promise rejection.

**Recommendation:** Track probes in a ref (e.g. `const probed = useRef(new Set<string>())`) so cleanup does not orphan in-flight results and each address is probed once per screen; apply results directly (setAvailability is safe post-unmount in React 19). Add `.catch(() => { if (active) setExistingGuid(null); })` to the existing-chat lookup.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 24. scheduled-edit load effect has no error path, leaving the screen permanently blank if the read rejects

- **Dimension:** Hooks & effects
- **Where:** app/(app)/scheduled-edit/[id].tsx:24
- **Verification:** confirmed

**What:** `useEffect(() => { void (async () => { const row = await getScheduledById(getDatabase(), schedId); ... setLoaded(true); })(); }, [schedId]);` - if getScheduledById (or getDatabase) throws, the rejection is unhandled and `setLoaded(true)` never runs, so the body content (gated on `loaded`, line 74) never renders: the user gets a header with an empty screen and no message. There is also no alive guard, though setState-after-unmount is a harmless no-op on React 19.

**Recommendation:** Wrap the body in try/catch (or add .catch) that still calls setLoaded(true) and surfaces a showDialog/inline error, matching the pattern used in ThreadSheet and AttachmentTray.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 25. Build/test tooling sits in "dependencies" instead of "devDependencies"

- **Dimension:** Dependencies
- **Where:** package.json:29, package.json:31, package.json:32, package.json:62
- **Verification:** confirmed

**What:** eslint (^9.39.4, line 31), eslint-config-expo (~56.0.4, line 32), jest-expo (~56.0.5, line 62), and babel-preset-expo (~56.0.0, line 29) are in "dependencies". For an Expo/RN app this has ZERO bundle impact — Metro only bundles what source imports, and EAS installs devDependencies anyway — so this is purely hygiene: `npm audit --omit=dev` and dependency-tree tooling misclassify them, and the manifest misstates what the app needs at runtime. Likely a side-effect of `npx expo install` defaulting to dependencies.

**Recommendation:** Move all four to devDependencies (a pure package.json edit + `npm install` to refresh the lockfile). Keep the same version ranges — babel-preset-expo and jest-expo must stay on the 56.x line while on SDK 56.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 26. A batch of trivial in-range updates is pending (expo patches, op-sqlite 17.1.2, prettier, react-query)

- **Dimension:** Dependencies
- **Where:** package.json:23, package.json:33
- **Verification:** confirmed

**What:** npm-outdated's "wanted" column shows the lockfile is holding back in-range fixes: expo 56.0.12->56.0.16, expo-router 56.2.11->56.2.15, expo-background-task/build-properties/constants/contacts/image-picker/linking/media-library/sharing/task-manager patch bumps, @op-engineering/op-sqlite 17.0.0->17.1.2, @tanstack/react-query 5.101.0->5.101.2, prettier 3.8.4->3.9.5, eslint 9.39.4->9.39.5. All are semver-compatible bug-fix releases within the SDK 56 line.

**Recommendation:** Run `npx expo install --fix` for the expo-* packages and `npm update` for the rest, then typecheck + jest. Caveat from AGENTS.md: the op-sqlite bump touches native code compiled with the sqlcipher/fts5 flags, so follow it with a clean native rebuild (`rm -rf android && expo run:android`) before trusting on-device behavior.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 27. react-native-image-colors drags moderate npm-audit advisories via its web-only fallback (node-vibrant/jimp/file-type)

- **Dimension:** Dependencies
- **Where:** package.json:66, src/services/backgrounds/luminance.ts:16
- **Verification:** adjusted

**What:** npm audit confirms moderate advisories in the react-native-image-colors chain (node-vibrant -> @vibrant/image-node -> @jimp/custom -> @jimp/core -> file-type 13.0.0-21.3.0, GHSA-5v7r-6r5c-r473 ASF infinite-loop DoS). This chain lives only in the package's web platform file (module.web.ts); Android uses the native androidx.palette module, the app is Android-only, and both call sites are lazy await import() (luminance.ts:16, adaptiveFromImage.ts:274) — no runtime exposure. 2.6.0 is the latest release (the audit 'fix' downgrades to 2.4.0). The js-yaml, uuid/xcode, and @expo/config-plugins advisories are build-time CLI tooling. CORRECTION: the audit also reports a HIGH advisory in drizzle-orm <0.45.2 (GHSA-gpj5-g38j-94v9, SQL injection via improperly escaped identifiers); drizzle-orm 0.36.4 is a runtime dependency (src/db/database.ts) and is NOT covered by the 'accept as audit noise' disposition — it needs separate triage (upgrade path blocked by the custom op-sqlite v17 drizzleAdapter documented in AGENTS.md, so assess exploitability of dynamic identifiers in the app's queries before forcing 0.45.2).

**Recommendation:** Accept as audit noise, or if a clean `npm audit` matters for CI, add an npm `overrides` entry forcing a patched file-type in the node-vibrant subtree. Do not replace the package over this.

**Status:** Decision — accepted as audit noise: the advisory chain lives in the package’s web-only fallback and this is an Android-only app; no code change. **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

#### 28. One open chat holds 4-5 duplicate reactive subscriptions to the same chats/handles queries (chat-theme row subscribed twice, chat header twice)

- **Dimension:** Rendering & list performance
- **Where:** app/(app)/chat/[guid].tsx:122, src/ui/conversations/ConversationHeader.tsx:35, src/ui/theme/ChatThemeProvider.tsx:20
- **Verification:** confirmed

**What:** The chat screen comments "ONE message subscription for the whole screen" and enforces it for messages, but the chat-row metadata is subscribed redundantly: ChatScreenInner calls useChatHeader(guid) (chat/[guid].tsx:122) and ConversationHeader independently calls useChatHeader(chatGuid) again (ConversationHeader.tsx:35) — two identical reactive queries on ['chats','chat_handles','handles']. Additionally the chat-theme row is subscribed twice: ChatThemeProvider's useChatTheme (via line 60) and the screen's useChatBackgroundUri at chat/[guid].tsx:123 each open their own useReactiveQuery running getChatTheme — two reactiveExecute sentinel subscriptions and two identical single-row queries re-run on every chats-table write (which happens on every incoming message, for last-message/unread updates) for every mounted chat screen in the stack. Cost per query is small (debounced 24ms, single-row) so this is waste rather than jank, but it doubles-to-quintuples per-tick query work for the busiest table, and the provider already fetches the exact row the background hook needs.

**Recommendation:** Pass the already-loaded `header.data` down to ConversationHeader as a prop (it is rendered by the same component that owns the subscription), and have ChatThemeProvider own the single useChatTheme subscription, exposing the chat-theme row / backgroundUri (and backgroundIsLight) through its own small context; keep useChatBackgroundUri's signature but implement it as a useContext read.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 29. SearchResultsView passes a non-stable openChat to the memoized ConversationTile

- **Dimension:** Rendering & list performance
- **Where:** src/ui/conversations/SearchResultsView.tsx:46, src/ui/conversations/SearchResultsView.tsx:90
- **Verification:** confirmed

**What:** `const openChat = (guid: string): void => { router.push(...) }` (line 46) is recreated on every render and passed as `onPress` to up to 50 memoized ConversationTiles in the list header (line 90). ConversationTile's memo — whose whole documented purpose is "the inbox FlashList passes a stable onPress" (ConversationTile.tsx:41) — is defeated here on every keystroke and every reactive results update. Impact is muted because each keystroke also produces fresh `row` objects from useChatMatches, but the search header is the only ConversationTile call site in the app that breaks the tile's stable-callback contract.

**Recommendation:** Wrap openChat (and openMessage) in useCallback([router]) exactly as ConversationListScreen.tsx:57 already does. One-line change; restores the tile memo for reactive re-fires where the chat rows are unchanged.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 30. Every visible MessageBubble opens a url_previews reactive subscription, URL or not

- **Dimension:** Rendering & list performance
- **Where:** src/ui/conversations/MessageBubble.tsx:103, src/features/conversations/useUrlPreview.ts:27, src/db/useReactiveQuery.ts:69
- **Verification:** confirmed

**What:** MessageBubble calls `useUrlPreview(previewUrl)` unconditionally to keep hook order (line 103, previewUrl is null for most messages), and useReactiveQuery always registers a reactiveExecute subscription on the url_previews table (useReactiveQuery.ts:69-74) regardless of the null url. Result: every mounted bubble (~15-25 in a chat) holds a native reactive subscription plus a sentinel `SELECT 1`, and every url_previews write (each new link preview fetched) schedules the debounce timer and re-runs the query callback for all of them — including bubbles with no URL at all, which just return null again.

**Recommendation:** Add an `enabled` (or null-tables) parameter to useReactiveQuery that skips the reactiveExecute registration while still keeping hook order legal, and have useUrlPreview pass `enabled: url != null`. The initial exec can also early-return without touching the DB when disabled.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 31. Composer subtree re-renders on every message tick because the chat screen passes only inline handlers

- **Dimension:** Rendering & list performance
- **Where:** app/(app)/chat/[guid].tsx:243, app/(app)/chat/[guid].tsx:693, src/ui/conversations/Composer.tsx:77
- **Verification:** confirmed

**What:** ChatScreenInner re-renders on every reactive message flush (any watched-table write), every typing-store flip, and every keyboard show/hide — and each time rebuilds the entire bottom stack: `onSend` (line 243) and `onSchedule` (line 237) are plain functions, and Composer receives fresh closures for onSendAttachments (line 693), onCancelReply (696), onCancelEdit (698), and onTyping (700). Composer (542 lines: text input, mention autocomplete, attachment tray, effect picker) is not memoized, so it fully re-renders per tick even though its own state (text, pending attachments, tray) is correctly local. Nothing is functionally wrong — no memo is being defeated because none exists — but the busiest screen re-renders its heaviest non-list component on every DB write it doesn't care about.

**Recommendation:** If profiling shows composer re-renders mattering on target hardware: wrap Composer in React.memo and stabilize its function props with useCallback in ChatScreenInner (guid is the only real dependency for most of them). Otherwise leave as-is — the current cost is one bounded subtree render per debounced tick.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 32. findmy.tsx subscribes to the whole FindMy store without a selector — the only deviation from the app's selector convention

- **Dimension:** State & context
- **Where:** app/(app)/findmy.tsx:30
- **Verification:** confirmed

**What:** `const { devices, friends, items, loading, refreshing, error, load, refresh } = useFindMyStore();` subscribes to every store change. Today the impact is nil because this screen renders every field and the store is only mutated by this screen's own load/refresh, but it is the single no-selector zustand call in the codebase (verified by grep across src/ and app/), so it silently breaks the otherwise-uniform 'atomic selector' convention and will start over-rendering (map, list, and all) the moment anyone adds a field or a background writer to the store.

**Recommendation:** Split into per-field selectors like every other call site (`const devices = useFindMyStore((s) => s.devices);` etc.), or if the wholesale grab is deliberate for an all-consuming screen, add a comment saying so to stop the pattern spreading.

**Status:** ✅ Fixed in the 2026-07-16 fix pass (see "Fix pass results" below).

#### 33. Download settings are split across two stores, and six kv-backed stores duplicate identical hydrate/persist boilerplate wired by two hand-maintained lists

- **Dimension:** State & context
- **Where:** src/state/downloadSettingsStore.ts:30, src/state/featureSettingsStore.ts:31, app/_layout.tsx:37, app/(app)/home.tsx:41
- **Verification:** confirmed

**What:** The attachment-download feature is governed by settings in two different stores: autoDownloadAttachments/autoDownloadOnWifiOnly live in featureSettingsStore (kv keys 'attachments.autoDownload'/'attachments.autoDownloadWifiOnly', lines 31-32) while the concurrency cap lives in downloadSettingsStore ('downloads.maxConcurrent') — ImageAttachment.tsx must import from featureSettingsStore for toggles while the semaphore is fed by downloadSettingsStore. The split exists only because featureSettingsStore's FLAGS machinery is boolean-typed. Separately, six stores (smartReply, redactedMode, downloadSettings, featureSettings, syncSettings, theme) each hand-roll the same hydrate-with-try/catch + optimistic-set + best-effort kvSet pattern, and each must be listed BY HAND in two hydrate call sites: app/_layout.tsx:37-45 (pre-DB, guarded) and app/(app)/home.tsx:41-49 (post-DB re-hydrate). A future settings store that gets added to only one list will silently either never hydrate pre-connect or lose its persisted value on restart — the exact bug class the themeStore comment in home.tsx:46-48 describes having already hit once.

**Recommendation:** Extract a small createKvBackedStore(defaults, keys) factory (or at minimum a shared hydrateAll() registry array called from both _layout.tsx and home.tsx) so new settings stores get hydration wiring by construction; consider generalizing featureSettingsStore's FLAGS table to non-boolean values so maxConcurrent and messagesPerChat can fold in, leaving downloadSettingsStore's semaphore push as a subscribe side-effect.

**Status:** Partial this pass — extract the shared hydration registry so the two hand-maintained lists collapse to one; merging the two stores / generalizing FLAGS is deferred (persisted-key migration risk). **→ ✅ Completed in the 2026-07-16 remainder pass (see "Remainder pass results" below).**

## Refuted during verification (excluded)

- ky 2.0 major exists but its breaking changes land exactly on APIs http.ts relies on — stay on v1 — verifier found ky 2.0’s breaking changes land on APIs `src/core/api/http.ts` relies on; staying on v1 is correct.

## Fix pass results (2026-07-16)

Applied the same day by a 7-wave agent workflow (waves sequenced so no two agents edited the
same file), followed by a three-lens adversarial review of the finished diff.

**Final gate (all passing):**
- `npm run typecheck` — clean
- `npm test` — 241 suites / 1,610 tests, 0 failures (both jest projects)
- `npm run coverage:ui` — 76.3% statements over src/ui (floor 70%; was 66.4% mid-pass before the new primitive tests)
- `npm run lint` — 0 errors (15 pre-existing warnings)
- `npm audit --omit=dev` — the drizzle-orm HIGH advisory (GHSA-gpj5-g38j-94v9) is gone; 0 high/critical remain

**Highlights:**
- New shared primitives: `ScreenHeader`, `SettingsSection`, `SettingsRow` family (InfoRow/SwitchRow/NavRow/CheckRow/StepperRow/NoteRow), `ActionListRow`, `FilteredChatListScreen`, `ContactSuggestionList`, `MediaSections`, `useKeyboardVisible`, `useContactSearch`, `useMessageActions`, `createRowIdentityCache`, `sendOutcome` helpers, `src/services/media.ts`.
- `settings.tsx` shrank 911 → 446 lines; ~16 screens now share one header; archived/unknown-senders are ~15-line wrappers.
- Every fix that could regress silently got a regression test (ChatThemeProvider no-remount, row identity across reactive flushes, stable Composer callbacks, mark-read on screen reuse, queue resend subject/mentions round-trip).

**Adversarial review outcome:** 8 advisories, 0 must-fix regressions, 0 missing fixes. Four were
fixed immediately after the review:
1. Crash-recovery queue resend now forwards the subject line and @mention spans (payload persists mentions too).
2. The server-management reachability probe uses `staleTime: 0` so every visit re-probes instead of showing a cached answer.
3. `useReactiveQuery` now sets `isLoading: true` when a disabled query is later enabled (latent trap for future consumers).
4. The row-identity caches use a lazy `useState` initializer instead of re-invoking the factory every render.

Four were accepted as-is: dev-seeded `https://` attachments no longer render in the fullscreen media
viewer (dev-only; production writers all emit `file://`); react-query's 30s staleTime means stats/info
served from cache on a quick remount (manual Refresh always hits the network); the jest
"worker failed to exit gracefully" warning (pre-existing jest-expo Animated-mock noise per AGENTS.md);
`useChatBackgroundUri`/`useChatBackgroundIsLight` are now provider-coupled (documented in their docstring).

**⚠️ Before the next on-device build:** op-sqlite 17.0.0 → 17.1.2 and the expo-* patch bumps touch
native code — do a clean native rebuild (`rm -rf android && expo run:android`, or a fresh EAS build)
before trusting device behavior.

## Remaining work — not done in the first pass (ALL COMPLETED later the same day — see "Remainder pass results" below)

Everything below was deliberately left out of the automated fix pass, each for a stated reason.
Suggested order:

### 1. zod v4 migration (finding: "zod v4 is a meaningful win") — low risk, do anytime
Done already: the one hard-breaking `z.record()` call site was fixed (two-arg form, works on v3 today).
Remaining: switch the 21 importing files to `import { z } from 'zod/v4'` (the installed zod 3.25.x
already ships that subpath) in small batches with the test suite run between batches; rename the ~30
deprecated `.passthrough()` sites to `.loose()`; then bump the package to 4.x as the final step.
Payoff: faster parse on the hot message-sync path, lighter bundle, cheaper typechecking.

### 2. Notifee successor decision (finding: "@notifee/react-native archived") — planning item, gates #3
No code was changed and none is urgently needed: notifee 9.1.8 works today on SDK 56. Before the SDK 57
upgrade, evaluate:
- **react-native-notify-kit** — the community drop-in fork (API-compatible, new-arch); young (launched
  April 2026), so vet its maturity/issue tracker first.
- **expo-notifications** — first-party and long-lived, but must be verified to cover what this app uses
  BEFORE choosing it: full-screen-intent call notifications (FaceTime), timestamp-trigger alarms
  (reminders), and MessagingStyle. If any is missing, the fork (or staying put) wins.
Do the swap as its own verified step with on-device testing — never inside the SDK upgrade.

### 3. Expo SDK 57 batched upgrade (finding: "Expo SDK 57 is out") — after #2
Deliberately staying on SDK 56 (supported — Expo maintains the last three SDKs; AGENTS.md targets 56).
When ready, do ONE batched pass: expo 57 via `npx expo install --fix` (repins all bundled native
modules), expo-share-intent 8.x, @react-native-firebase 25 (messaging permission-API deprecation is
the only breaking change relevant here), jest-expo / babel-preset-expo / eslint-config-expo 57.
Follow with a clean native rebuild and the on-device spike checklist (docs/SPIKES.md).

### 4. services/index.ts split (finding: "oversized multi-job files") — needs a device-testing window
The other parts of that finding were done (useMessageActions extracted, MediaSections moved,
settings.tsx halved). The composition root itself (636 lines) was NOT split: it is the boot path,
and a mistake there only surfaces on device — an automated pass can't verify it. When splitting,
move sync control and realtime lifecycle into e.g. src/services/syncControl.ts /
src/services/realtimeControl.ts and keep index.ts wiring-only.

### 5. Settings-store consolidation (finding: "download settings split across two stores") — optional
The shared hydration registry landed (one list instead of two). Folding downloadSettingsStore into
featureSettingsStore (generalizing its boolean FLAGS table to numeric values) was deferred: it changes
persisted kv usage for a small payoff.

### 6. Housekeeping (optional)
- `npm audit` still shows 21 moderates from the `@expo/cli`/config-plugins chain (build-time only,
  resolves with SDK 57) and the react-native-image-colors web-only chain (unreachable on Android).
  If a clean audit ever matters for CI, add an npm `overrides` entry forcing a patched `file-type`.
- The jest "worker failed to exit gracefully" warning is the documented jest-expo Animated-mock noise;
  a one-off `npx jest --detectOpenHandles` run can confirm nothing new is leaking.
- ky stays on v1 permanently unless http.ts is reworked — the v2 upgrade was evaluated and refuted
  (its breaking changes land exactly on the APIs http.ts relies on).

## Remainder pass results (2026-07-16, second pass)

All six deferred items were completed by an orchestrated 6-phase run (one Opus subagent per phase,
each phase gated on a green tree; three-lens adversarial review at the end).

**What landed:**
1. **zod v4** — all 24 importing files moved to the permanent `zod/v4` subpath; zero `.passthrough()`
   (all → `.loose()`) and zero `z.ZodTypeAny` remain; package bumped to **zod 4.4.3**.
2. **Notifee → react-native-notify-kit 10.4.8** — drop-in swap in 6 files; the obsolete
   `extraMavenRepos` workaround deleted (notify-kit compiles its native core from source);
   `POST_NOTIFICATIONS` added explicitly to `app.config.ts` (notify-kit does not auto-merge it);
   jest mock remapped; AGENTS.md gotchas rewritten.
3. **Expo SDK 57 / RN 0.86** — full repin via `expo install --fix`; jest-expo/babel-preset-expo/
   eslint-config-expo on the 57 line; **expo-share-intent 8.0.1**; **@react-native-firebase 25.1.0**
   with `fcmMessaging.ts` migrated to the modular API (background handler still module-top-level;
   the redundant deprecated `requestPermission()` call deleted). No component-test fallout.
4. **Store merge** — `downloadSettingsStore` folded into `featureSettingsStore` via a typed
   VALUE_SETTINGS map; the `downloads.maxConcurrent` kv key is byte-identical (persisted values survive).
5. **services/index.ts split** — 636-line composition root split into 8 leaf modules
   (certPins, clients, databaseControl, chatActions, lock, syncControl, realtimeControl, bootstrap);
   `index.ts` is now a pure re-export barrel with an identical public surface, so all ~28 importers
   are untouched; socket state moved behind `getSocket`/`setSocket` accessors.
6. **Housekeeping** — scoped npm overrides (`file-type ^21.3.1` under react-native-image-colors,
   `uuid ^11.1.1` under xcode): **`npm audit` now reports 0 vulnerabilities**; `--detectOpenHandles`
   found zero leaked handles; `docs/DEVICE_VERIFICATION_CHECKLIST.md` written; AGENTS.md staleness pass done.

**Final gate (all passing):** typecheck clean · 240 suites / 1,611 tests · lint 0 errors
(13 pre-existing warnings from eslint-config-expo 57's new react-hooks rules — cleanup candidate) ·
UI coverage 77.7% statements (floor 70%) · npm audit 0 vulnerabilities.

**Adversarial review:** 2 advisory notes, 0 must-fix, 0 missing steps — (a) a benign
bootstrap↔lock circular import in the new services modules, (b) an intentional historical
notifee mention left in AGENTS.md.

**⚠️ REQUIRED before trusting device behavior:** a clean native rebuild
(`rm -rf android && npx expo run:android`, or a fresh EAS build) — RN 0.86, notify-kit,
RNFB 25, and every repinned native module only take effect after it. Then work through
`docs/DEVICE_VERIFICATION_CHECKLIST.md` (notifications, FaceTime full-screen, reminders,
killed-app FCM, app lock, share intent, SDK 57 smoke items).
