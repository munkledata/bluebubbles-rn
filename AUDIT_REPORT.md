# Gator RN — Audit Report (rebuild vs. Flutter original)

> **STATUS UPDATE (2026-07-17):** The tables below are a FROZEN 2026-06-20 snapshot — do not read
> them as current status. Since then: **F-2 (group add/remove/rename UI, `chat-settings/[guid].tsx`),
> F-3 (audio playback — `AudioAttachment.tsx` + expo-audio), F-4 (voice recording —
> `VoiceRecorder.tsx`), F-5 (document picker — expo-document-picker), and the Android share-intent
> part of F-14 (expo-share-intent 8) are DONE in code**; **SEC-2's SSRF guard shipped**
> (`src/services/urlPreview.ts` `isPrivateHost` rejects loopback/link-local/private/metadata hosts).
> One table claim no longer holds: **S-4** — the app now deliberately sets
> `usesCleartextTraffic: true` (`app.config.ts`) so a direct-LAN `http://` server is reachable,
> gated by an app-layer default-deny "Allow insecure connection" toggle in `connect()`; the
> "false in the release manifest" statement is obsolete (the protection moved from the manifest to
> the connect gate). **SEC-6 is now closed:** `allowBackup` is false and the Android artifact guard
> enforces it in generated manifests. The app is now on Expo SDK 57 / RN 0.86.
>
> **STATUS UPDATE (2026-08-04):** The dormant, partial certificate-pinning implementation was
> removed. Current HTTPS connections use ordinary Android/OS certificate validation; Gator neither
> bypasses certificate errors nor performs application-level pinning. Historical pinning claims in
> this frozen snapshot are superseded by this update and `docs/WORK_PLAN_2026-08-03.md`.
>
> A clean local release-variant smoke AAB passes the packaged backup/permission/share-containment
> guard. It uses the CI Firebase fixture and Android debug signing, so it is compile/static-artifact evidence—not
> a production candidate or proof of production signing, Firebase, Play, hosted CI, or device behavior.
>
> The July claim that Android ACTION_SEND/Direct Share was done is also superseded: IPC-01 found that
> `expo-share-intent@8.0.1` can read/copy provider data natively before JavaScript can enforce a
> bound. The package, inbound filters/provider, and Direct Share publication are removed from the
> current source/build graph. ACTION_SEND/Direct Share into Gator remains deliberately disabled until an
> owned native intake proves actual byte/count/time limits and cleanup; foreground composer paste
> is a separate bounded receive-content path. See `docs/SHARE_INTENT_RELIABILITY.md`.

> **STATUS UPDATE (2026-08-05):** The current working tree passes two independent settled full test
> runs at **363 suites / 3,396 tests each**, plus typecheck, zero-warning lint, formatting, architecture,
> migration, secret-hygiene, workflow, package, and Android-artifact checks. A corrected isolated native
> snapshot compiled all three owned Android modules and produced a debug APK plus a release-variant AAB;
> the packaged guard, merged-manifest checks, and DEX-marker inspection pass. The AAB still uses the CI
> Firebase fixture and Android debug signing, so this is strong local compile/containment evidence—not a
> Play-ready candidate or device-behavior proof. The exact evidence and remaining gaps are recorded in the
> implementation plan.

> **STATUS UPDATE (2026-08-08):** That checkpoint's complete host gate passed **390 suites / 4,032 tests**, plus
> typecheck, zero-warning lint, formatting, architecture (**5 tests / 65 core files**), migration (**34 sequential
> migrations / 5 tests**), workflow (**20 tests**), diagnostic (**30 tests**), DB-write inventory, secret-hygiene,
> and Android-artifact checks. This remains host/local-artifact evidence, not exact-candidate or physical-device
> sign-off. The authoritative current task counts and blockers are in the work plan.

> **STATUS UPDATE (2026-08-13):** The current functional host gate, run alone, passes **399 suites / 4,340 tests / 0 snapshots**
> under `--silent` in **105.641s**. This is functional evidence, not a warning-free full-run claim. Full TypeScript,
> targeted lint, configured formatting, architecture (**30 tests / 65 core files**) plus all three scheduled guards
> (**1/1 each**), migration guard (**38 sequential migrations / 5 tests**), scanner **35/35**, and diff checks pass. The
> exact inventory has **1,078 entries / 585 proved (491 coordinated + 94 temporal) / 493 unproven / 0 structural errors /
> 0 nested coordinators / 0
> membership errors**.
> Scheduled claim/recovery, the schedule→outgoing handoff, and learned temp→real deletion identity are host-green,
> including both internal-release upgrade repairs. This is not op-sqlite/SQLCipher process-kill, exact-candidate, or
> physical-device sign-off.
> `TEST-01` remains open because full/stressed Account and Server Health runs can emit nondeterministic TanStack Query
> React `act(...)` warnings even though all assertions pass; the report does not claim warning-free Jest output.
> `DB-02A` remains **IN_PROGRESS**.
>
> **STATUS UPDATE (2026-08-14):** The latest complete noninteractive CI-mode functional gate passes **400 suites /
> 4,355 tests / 0 snapshots** in **89.289s**. TypeScript, configured formatting, architecture **30/30** with its live
> **65-core-file** boundary and three scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, scanner
> **48/48**, and diff checks pass. ESLint reports **0 errors** and four pre-existing `import/first` warnings. The exact
> inventory remains **1,083 entries / 593 proved (499 coordinated + 94 temporal) / 490 unproven / 0 structural errors /
> 0 nested coordinators / 0 membership errors**. The tracked attachment-cache recovery/planning and sync/realtime-scope
> children described below are host-green; this is functional evidence, not warning-free Jest, exact op-sqlite/SQLCipher,
> process-kill, exact-candidate, or physical-device sign-off. `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.
>
> **STATUS UPDATE (2026-08-15):** The latest complete single-run noninteractive CI-mode functional gate passes **400
> suites / 4,359 tests / 0 snapshots** in **141.095s**. The focused attachment-cache matrix passes **8 / 175 / 0** in
> **12.886s**. TypeScript, zero-error ESLint, configured formatting, architecture **30/30** with its live
> **65-core-file** boundary and three scheduled guards (**1/1 each**), migrations **5/5** across 38 migrations at head
> `0038`, scanner **48/48**, and diff checks pass. The exact inventory is **1,085 entries / 595 proved (501 coordinated +
> 94 temporal) / 490 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**; reconciliation
> reports **0 line shifts / 0 rekeys / 0 additions**. The tracked attachment-cache due-list/recheck child described below
> is host-green; this remains functional evidence, not exact op-sqlite/SQLCipher, process-kill, exact-candidate, or
> physical-device sign-off. `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.
>
> **STATUS UPDATE (2026-08-15):** The authoritative managed full functional gate exits **0** with **400 suites / 4,359
> tests / 0 snapshots** in **799.937s**; the focused attachment-cache matrix passes **8 / 175 / 0** in **13.362s**. One
> unchanged `chatScreenReadMarker` suite took **735.137s** during a host stall but passed. An earlier detached process lost
> its aggregate output and is inconclusive, so it is not counted; no Jest process remains active. TypeScript, zero-error
> ESLint, configured formatting, architecture **30/30** with its live **65-core-file** boundary and three scheduled guards
> (**1/1 each**), migrations **5/5** across 38 migrations at head `0038`, scanner **48/48**, and diff checks pass. The
> exact inventory is **1,089 entries / 622 proved (528 coordinated + 94 temporal) / 467 unproven / 0 structural errors /
> 0 nested coordinators / 0 membership errors**; reconciliation reports **0 line shifts / 0 rekeys / 0 additions**. The
> attachment-cache compatibility-retirement child described below is host-green; this remains functional evidence, not
> exact op-sqlite/SQLCipher, process-kill, exact-candidate, or physical-device sign-off. `DB-02A` remains **IN_PROGRESS**,
> and `TEST-01` remains open.
>
> **STATUS UPDATE (2026-08-15):** The latest complete functional gate exits **0** with **400 suites / 4,363 tests / 0
> snapshots** in **80.454s**; the focused database-ownership matrix passes **4 / 103 / 0** in **5.143s**. TypeScript,
> zero-error ESLint, configured formatting, architecture **30/30** in **6.945s** with its live **65-core-file** boundary
> and three scheduled guards (**1/1 each**), migrations **5/5** across 38 migrations at head `0038`, scanner **48/48** in
> **8.562s**, and diff checks pass. The exact inventory remains **1,089 entries** and is now **628 proved (528 coordinated
> and 100 temporal) / 461 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**; reconciliation
> reports **0 line shifts / 0 rekeys / 0 additions**. No Jest process remains active. The throwaway rekey-self-test child
> described below is host-green; this remains filename/options/order/cleanup evidence, not native SQLCipher, filesystem,
> process-kill, exact-candidate, or physical-device sign-off. `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.
>
> **STATUS UPDATE (2026-08-15):** The authenticated runtime transaction-context child is host-green. A forgeable
> type-only prototype was abandoned and reverted; the retained implementation uses a frozen opaque context backed by a
> private `WeakMap`, synchronous join registration, close-on-owner-settlement, all-settle before commit/rollback, and a
> latched rollback when code attempts a late join. The scanner recognizes only an exact imported, inline, awaited or
> returned `runInTransactionContext` callback and does not invent a separate write finding for the guard.
>
> Exactly **25 transaction-only owners / 52 findings** were migrated. Manual AST review found all promoted paths awaited
> or returned across **112 reviewed calls**, with **0 database/context escapes** and **0 nested coordinator paths**.
> Scanner tests pass **52/52** in **6.38s**; the combined focused matrix passes **29 suites / 523 tests**. A first full
> run reached **399/400 suites and 4,367/4,369 tests** before two `markUnread` tests exhausted a test-only 20-microtask
> wait; isolation reproduced the harness issue, its bounded fail-safe was corrected, and the final full gate exits **0**
> with **400 suites / 4,369 tests / 0 snapshots** in **62.069s**. TypeScript, zero-error ESLint, configured formatting,
> architecture and scheduled guards, migrations, inventory report, reconciliation, and nested-coordinator checks pass.
>
> The exact inventory remains **1,089 entries** and is now **680 proved (580 coordinated + 100 temporal) / 409 unproven /
> 0 structural errors / 0 nested coordinators / 0 membership errors**. Durable incoming-event records `e5c8469dbfa3`
> and `1939ccb043fe` remain unproven. A generic finding ID does not encode removal of an outer `await`, so the exact 52
> retain their manual AST audit; this is not generic future-proofing, device/SQLCipher/process-kill, exact-candidate, or
> absolute callback-bound evidence. Child `DB-02A-RUNTIME-TRANSACTION-CONTEXT-JOIN` is **DONE**; parent `DB-02A`, the
> remaining 409 findings, `DB-02B`, `DB-02C`, device evidence, and `TEST-01` remain open.
>
> **PRIV-03AB UPDATE (2026-08-09):** New Chat now fails closed at the host/accessibility/form boundary while privacy
> is enabled or unhydrated and after original-account invalidation. Unfinished work is preserved in JavaScript for
> confirmed opt-out; retained callbacks/results and stale-account/share-handoff adoption are fenced; and a fully
> successful create plus optional attachment send that loses its privacy grant consumes the submitted form and aggregate
> pins. Its focused route suite passes **45/45 tests** (**16 new over the 29-test baseline**). Raw drafts, recipients,
> staged metadata/file names, contact-search results, and handoff/stat work may remain or continue in JavaScript; admitted
> work is not recalled; consumed pins invalidated after adoption rely on route unmount; create-success followed by
> `sendImages` failure retains retry/idempotency ambiguity; and IME/native, TalkBack, screenshot/Recents, and device proof
> remain open. This is not a no-fetch/no-memory claim, does not describe an attachment-filename host leak, and does not
> close active-chat Composer/draft surfaces or the parent `PRIV-03` item.
>
> **PRIV-03AC UPDATE (2026-08-09):** Message-search hits now treat unhydrated Redacted Mode as hidden, mounting generic
> `Contact`/`Message` copy instead of raw titles, snippets, or nested highlight fragments and revealing them only after
> hydration confirms privacy is off. The focused suite passes **14/14 tests** (**1 new over the 13-test baseline**). Exact
> timestamps/navigation remain available; search hooks still hold raw query/result rows in JavaScript and the parent search
> input can still mount typed query text. This is not no-fetch/no-memory/full-search-input or downstream Composer
> containment; `TEST-01` warning debt and parent `PRIV-03` remain open.
>
> **PRIV-03AD / DEC-10 UPDATE (2026-08-09):** The owner chose to remove user-configurable Redacted Mode. Normal
> notifications remain detailed and Android controls lock-screen presentation. Independent protections remain: App Lock
> still posts a generic **new-delivery** notice; pairing QR requires an explicit lifecycle-bound reveal; log redaction,
> account leases, and stale-result guards stay in place. Removal phase 1 decouples connected-startup legacy raw payload/
> GUID-derived channel cleanup and generic missing-reminder repair from the setting, with native-queue serialization,
> original-account ownership, and DB commit guards for reminder-id and legacy FaceTime-route handoffs. Its focused gate
> passes **8 suites / 227 tests** warning-free. Existing generic/sanitized notices and repaired reminders remain generic;
> App Lock does not retroactively scrub a detailed notice or trigger Android already owns; failed maintenance retries on
> the next connected boot run; and the configurable mode remains live until later phases. `PRIV-03` is therefore
> **IN_PROGRESS for safe removal, not dropped**; `PRIV-03A..AC` remain historical implementation evidence. At this
> phase-1 checkpoint, the measured full gate passed **396 suites / 4,306 tests**.
>
> **PRIV-03AE / DEC-10 UPDATE (2026-08-09):** Removal phase 2A deletes only Redacted Mode store subscriptions and
> masking from `ContactSuggestionList`, `SearchResultsView`, and `ReplyQuote`. Exact ordinary names/addresses,
> search titles/snippets/highlighting and encoded navigation, reply sender/text/attachment fallback, accessibility,
> selection, and press behavior remain covered; no independent account/source/native/log boundary was removed. The
> focused gate passes **3 suites / 21 tests** twice without warnings. At this phase-2A checkpoint, the measured full gate
> passed **396 suites / 4,299 tests**; the seven-test decrease from phase 1 is the intentional deletion of obsolete
> mode-only cases, not a suite or
> ordinary-behavior regression. These three leaves add no DB-write finding. The setting, persisted value, store,
> coordinator, parent containment, and other mode-specific UI branches remain live.
>
> **PRIV-03AF / DEC-10 UPDATE (2026-08-09):** Removal phase 2B deletes only Redacted Mode identity/title/avatar/
> group-event and swipe-reply substitutions from `PinnedGrid` and `MessageRow`. Exact resolved pinned titles,
> single/group photos, sender/event text, avatar URIs, GUID/row/message callback payloads, unread visual/accessibility
> semantics, non-identifying positional unread IDs, memoized bindings, selection controls, and `MessageBubble` ownership
> remain covered. The focused gate passes **4 suites / 16 tests** warning-free. At this phase-2B checkpoint, the measured
> full gate passed **396 suites / 4,293 tests**; the six-test decrease from phase 2A is the intentional deletion of
> obsolete mode-only cases, not a suite
> or ordinary-behavior regression. These leaves add no DB-write finding. Setting/store/coordinator, `MessageBubble`, and
> other mode-specific UI branches remain live; known Account/Server Health `act(...)` warnings stay open under `TEST-01`.
>
> **PRIV-03AG / DEC-10 UPDATE (2026-08-09):** Removal phase 2C deletes only Redacted Mode selectors, subscriptions,
> close-dedupe refs/effects, hidden returns, and no-op masking from `ReactionDetailsSheet`, `EditHistorySheet`, and
> `MessageDetailsSheet`. Exact reaction names/glyphs, edit revisions/dates/removals, sender/service/delivery rows and
> fallbacks, null/empty behavior, Modal hardware-Back and real-backdrop parent clearing, inner-tap swallowing, and fresh
> reopen remain covered; no account/source/native/log boundary existed in these prop-driven read-only leaves. The focused
> gate passes **3 suites / 17 tests** twice warning-free. At this phase-2C checkpoint, the measured full gate passed
> **396 suites / 4,280 tests**; the 13-test decrease from phase 2B reflects removal of 15 obsolete mode-only cases plus two
> added ordinary Reaction modal
> cases, not a suite or behavior regression. These leaves add no DB-write finding. Setting/store/coordinator and other
> mode-specific UI branches remain live; the known Server Health `act(...)` warning stays open under `TEST-01`.
>
> **PRIV-03AH / DEC-10 UPDATE (2026-08-09):** Removal phase 2D deletes only the Redacted store subscription and
> generic caller-name substitution from `IncomingFaceTimeOverlay`. Exact caller/audio-video rendering remains, while the
> independent store-generation/reset boundary, active-call takeover, captured UUID, live-current call lookup, same-UUID
> updated-object forwarding, retained-callback rejection, fresh-current controls, and generic action accessibility labels
> remain mutation-pinned. Its focused suite passes **10/10 tests** repeatedly warning-free. At this phase-2D checkpoint,
> the full gate passed
> **396 suites / 4,276 tests**; the four-test decrease from phase 2C is exactly the deletion of obsolete mode-only cases,
> not a suite or action-guard regression. This leaf adds no DB-write finding. Setting/store/coordinator and other
> mode-specific UI branches remain live; the known Server Health `act(...)` warning stays open under `TEST-01`.
>
> **PRIV-03AI / DEC-10 UPDATE (2026-08-09):** Removal phase 2E deletes only the Redacted store subscription and
> photo/video/link masking from `MediaSections`. Exact media GUID callbacks and sources, video blurhash posters,
> document/link rendering, `safeOpenUrl`, managed cache-path protection/refusal/release, and remote-source bypass remain
> covered. Its focused gate passes **2 suites / 17 tests** repeatedly without Jest warnings; targeted ESLint exits with
> zero errors and three established test-mock/import warnings. At this phase-2E checkpoint, the full gate passed
> **396 suites / 4,275 tests**;
> the one-test decrease from phase 2D is two obsolete mode-only cases removed plus one ordinary remote-source regression
> added. This leaf adds no DB-write finding. Setting/store/coordinator and other mode-specific UI branches remain live;
> the known Server Health `act(...)` warning stays open under `TEST-01`.
>
> **PRIV-03AJ / DEC-10 UPDATE (2026-08-09):** Removal phase 2F deletes `PairingQr`'s Redacted store dependency but
> retains its independent default-hidden explicit-reveal boundary. Skeptical review first found that a retained
> same-payload Reveal callback could re-admit after blur or background; the final opaque grant binds exact payload identity
> plus a synchronous, committed lifecycle revocation generation. Old configured callbacks are inert after route blur,
> non-active AppState, or payload replacement; fresh controls reveal the exact current payload; listener cleanup, null
> state, whole-host-tree credential absence, and no logging path remain covered. Its focused suite passes **7/7 tests**
> repeatedly without warnings. At this phase-2F checkpoint, the full gate passed **396 suites / 4,273 tests**; the two-test decrease from phase
> 2E is three obsolete mode-only cases removed plus one stronger lifecycle/credential regression added. This leaf adds no
> DB-write finding. Setting/store/coordinator and other mode-specific UI branches remain live; known Account/Server Health
> `act(...)` warnings stay open under `TEST-01`.
>
> **PRIV-03AK / DEC-10 UPDATE (2026-08-09):** Removal phase 2G deletes only mode-specific title/identity/avatar/
> Details substitutions from `ChatActionsSheet` and `ConversationHeader`. Chat actions retain their captured original-
> account lease, stale Pin/Mute/Archive rejection, admitted-write drain, exact GUID/toggle behavior, lease-bearing Mark
> actions, and generic delayed Delete confirmation. The header retains address validation/formatting, participant dedupe,
> service badges, encoded Details navigation, Back/FaceTime/Scheduled actions, and exact ordinary identity/avatar/
> accessibility output. Its focused gate passes **2 suites / 37 tests** repeatedly without warnings. At this phase-2G
> checkpoint, the full gate passed **396 suites / 4,264 tests**; the nine-test decrease from phase 2F is 12 obsolete mode-only cases removed plus three
> stronger ordinary/account regressions added. Three existing ChatActions DB-inventory line fields were refreshed without
> changing their unproven dispositions; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**.
> Setting/store/coordinator and other mode-specific UI branches remain live; the known Server Health `act(...)` warning
> stays open under `TEST-01`.
>
> **PRIV-03AL / DEC-10 UPDATE (2026-08-09):** Removal phase 2H deletes only `ConversationTile`'s Redacted store
> dependency and title/preview/avatar substitutions. Exact 1:1 and A/A/B-deduplicated group identity, previews,
> accessibility copy, avatar photos, date/service/unread/mute metadata, press/long-press, and memoization remain. Mark
> Read/Unread and delayed Delete retain the row-instance original-account lease; Mute/Archive retain account-scoped local
> mutation guards; and repeated Delete prompts remain generic while forwarding the exact GUID and same lease. Its direct
> suite passes **22/22 tests** and the retained shared Redacted suite passes **11/11 tests**, together **2 suites / 33
> tests** repeatedly without warnings. Direct arithmetic is **22 - 4 obsolete mode cases + 4 stronger ordinary/account
> cases = 22**; deleting exactly one obsolete shared masking case moves the measured full gate from the phase-2G
> **4,264-test** checkpoint to **396 suites / 4,263 tests**. Two existing ConversationTile DB-inventory line fields were
> refreshed without changing their unproven dispositions; totals remain **1,053 / 492 proved / 561 unproven / 0
> structural / 0 nested**. Setting/store/coordinator and other mode-specific runtime branches remain live; established
> Account/Server Health `act(...)` warnings stay open under `TEST-01`.
>
> **PRIV-03AM / DEC-10 UPDATE (2026-08-09):** Removal phase 2I deletes only `AccountScreen`'s Redacted store
> dependency and privacy placeholder, restoring its existing loading, unsupported, error, account-identity, and alias-
> picker states. The query remains keyed by its captured account generation; delayed old-account GET success/error remain
> discarded; and alias selection retains its original lease, tracked POST drain, guarded cache/dialog/finally publication,
> vetted-alias admission, failure cleanup/retry, and Back behavior. Its focused suite passes **13/13 tests** repeatedly
> without warnings. Exact arithmetic is **15 - 3 obsolete mode cases + 1 Back regression = 13**, moving the measured full
> gate from the phase-2H **4,263-test** checkpoint to **396 suites / 4,261 tests**. This batch adds or shifts no DB-write
> finding; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**. Setting/store/coordinator and
> other mode-specific runtime consumers remain live; the established Server Health `act(...)` warning stays open under
> `TEST-01`.
>
> **PRIV-03AN / DEC-10 UPDATE (2026-08-09):** Removal phase 2J deletes only `ScheduledScreen`'s Redacted store
> dependency and title/accessibility/editor-navigation substitutions. Exact pending/history bodies, exact editor IDs,
> reactive pending/sent/error/legacy-uncertain status, date/recurrence labels, empty state, and Back remain. Mount sync and
> Cancel retain the captured original-account lease; Clear retains tracked Disconnect drain, exact DB/id forwarding,
> current fixed-copy error publication, and stale-account suppression. Its direct suite passes **12/12 tests** and the
> unchanged service account-scope suite passes **7/7 tests**, together **2 suites / 19 tests** repeatedly without warnings.
> Direct arithmetic is **15 - 6 obsolete mode cases + 3 action/ownership regressions = 12**, moving the measured full gate
> from the phase-2I **4,261-test** checkpoint to **396 suites / 4,258 tests**. One existing ScheduledScreen DB-inventory
> callback entry was remapped to its new stable ID/symbol/line without changing its unproven disposition; totals remain
> **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**. Setting/store/coordinator and other mode-specific
> runtime consumers remain live. This full run emitted no `act(...)` warning, but intermittent Account/Server Health debt
> remains open under `TEST-01`.
>
> **PRIV-03AO / DEC-10 UPDATE (2026-08-09):** Removal phase 2K deletes only `RemindersScreen`'s Redacted store
> dependency, privacy-revocation epoch/subscription, and title/accessibility/disabled substitutions. Exact previews,
> times, accessibility names, second-row Reschedule/Delete bindings, picker cancellation, and Back remain. Both actions
> retain the same mounted original-account lease; Reschedule checks it before and after the native picker and passes it
> into `rescheduleReminder`, while Cancel passes it into `cancelReminder`. Retained stale callbacks, delayed picker
> success/rejection, and already-admitted service failures cannot act or publish dialogs after account replacement;
> current picker/Cancel failures retain fixed generic copy. The direct suite passes **10/10 tests**, the unchanged
> reminder-service suite passes **19/19**, and the unchanged picker suite passes **3/3**, together **3 suites / 32 tests**
> repeatedly without warnings. Direct arithmetic is **12 - 6 obsolete mode cases + 4 stronger ordinary/account cases =
> 10**, moving the measured full gate from the phase-2J **4,258-test** checkpoint to **396 suites / 4,256 tests**. This
> batch adds or shifts no DB-write finding; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**.
> Setting/store/coordinator and other mode-specific runtime consumers remain live. This full run emitted no `act(...)`
> warning, but intermittent Account/Server Health debt remains open under `TEST-01`.
>
> **PRIV-03AP / DEC-10 UPDATE (2026-08-09):** Removal phase 2L deletes only `ScheduledEditScreen`'s Redacted store
> dependency, privacy-revocation epoch/subscription, privacy-only keyboard dismissal, callback privacy checks, and hidden
> editor branch. Loading still targets the exact route ID (42 in the focused fixture) and current database; ordinary
> body/date/recurrence/accessibility/Back and the current fixed load error remain. One mounted original-account lease
> fences delayed load success/error/finally, picker admission/results/errors, and Save admission/completion/errors. Save
> still forwards trimmed text, exact
> date, recurrence, and that lease. Current picker/Save failures retain fixed copy; failed Save does not navigate and keeps
> the form, while stale picker and already-admitted Save success/error publish no late date, Back, or dialog. The direct
> suite passes **16/16 tests** and the unchanged scheduled account-scope suite passes **7/7**, together **2 suites / 23
> tests** repeatedly without warnings. Eight obsolete mode cases were removed and 11 stronger ordinary/account/picker
> cases were added: **13 - 8 + 11 = 16**, moving the measured full gate from the phase-2K **4,256-test** checkpoint to
> **396 suites / 4,259 tests**. This batch adds or shifts no DB-write finding; totals remain **1,053 / 492 proved / 561
> unproven / 0 structural / 0 nested**. Setting/store/coordinator and other mode-specific runtime consumers remain live.
> The established Server Health `act(...)` warning appeared in this full run and remains open under `TEST-01`.
>
> **PRIV-03AQ / DEC-10 UPDATE (2026-08-09):** Removal phase 2M deletes only `ChatScreen`'s Redacted store dependency
> and mode-specific wallpaper masking. Exact wallpaper URI, header/upload/composer translucency, `MessageList` background
> state and both insets, and both top/bottom overlay styles now render normally. Reactive URI-to-null-to-new-URI changes
> retain the same list/composer instances and exact long-press/send callback identities. The mounted original-account
> lease still hides stale-account wallpaper and resets every chrome consumer on the next screen render. The direct suite
> passes **41/41 tests**; four unchanged supporting suites pass **43/43**, together **5 suites / 84 tests** repeatedly
> without warnings. Direct arithmetic is **43 - 3 obsolete mode cases + 1 stronger continuity case = 41**, moving the
> measured full gate from the phase-2L **4,259-test** checkpoint to **396 suites / 4,257 tests**. Three existing
> `ChatScreen` DB-inventory line fields were mechanically refreshed without changing their stable IDs, metadata, or
> unproven dispositions; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**. Setting/store/
> coordinator and other mode-specific runtime consumers remain live. The established Server Health `act(...)` warning
> appeared in this full run and remains open under `TEST-01`.
>
> **PRIV-03AR / DEC-10 UPDATE (2026-08-09):** Removal phase 2N deletes only `FindMyScreen`'s Redacted store
> dependency and mode-specific identity/location/map masking. Exact device/item/friend names, addresses/fallbacks, finite
> battery values, finite-coordinate markers, source-namespaced `d:`/`i:`/`p:` focus IDs, and explicit encoded `geo:`
> actions through `safeOpenUrl` now render or route normally. The real `FindMyMap` remains a disabled, no-WebView panel
> whose host tree exposes no marker identity or coordinates under `WEB-02`; route load/polling/refresh/Back wiring and
> store-generation reset ownership remain covered. The shared direct suite passes **12/12 tests**; five unchanged
> supporting suites pass **28/28**, together **6 suites / 40 tests** repeatedly without warnings. Direct arithmetic is
> **11 - 4 obsolete Find My mode cases + 5 stronger ordinary/routing cases = 12**, moving the measured full gate from the
> phase-2M **4,257-test** checkpoint to **396 suites / 4,258 tests**. This batch adds or shifts no DB-write finding; totals
> remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**. Unused `FindMyMapHidden`, setting/store/
> coordinator, and other mode-specific runtime consumers remain cleanup/open work. The established Server Health
> `act(...)` warning appeared in this full run and remains open under `TEST-01`.
>
> **PRIV-03AS / DEC-10 UPDATE (2026-08-09):** Removal phase 2O deletes only `ThreadSheet`'s Redacted store
> dependency, privacy generation/subscription, and mode-triggered parent close. Ordinary exact thread rows,
> sender/body/attachment/time/accessibility output, reply counts, fallbacks, backdrop/null behavior, and exact GUID/date
> jump remain. A generic controlled-open lifetime revokes retained native row callbacks and delayed read results across
> A→null→same-A reopen, direct A→B replacement, row/backdrop/Modal close, and account invalidation. The original account
> lease, account-close dedupe, tracked DB read/drain, and exact originator/result/action checks remain mutation-pinned. The
> direct suite passes **18/18 tests** and the unchanged message-repository suite passes **32/32**, together **2 suites / 50
> tests** repeatedly without warnings. Direct arithmetic is **24 - 8 obsolete mode cases + 2 stronger open-lifetime/error
> cases = 18**, moving the measured full gate from the phase-2N **4,258-test** checkpoint to **396 suites / 4,252 tests**.
> This batch adds or shifts no DB-write finding; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0
> nested**. The admitted uncapped thread SELECT still drains rather than cancels and may delay Disconnect; arbitrary
> same-account unmount, exact native Modal/hardware-Back timing, setting/store/coordinator, and other mode-specific runtime
> consumers remain open. This full run was quiet, but the intermittent Account/Server Health `act(...)` warning debt
> remains open under `TEST-01`.
>
> **PRIV-03AT / DEC-10 UPDATE (2026-08-09):** Removal phase 2P deletes only `LocationCard`'s Redacted store
> dependency and mode-specific filename/coordinate/action masking. Exact ordinary filename and finite-coordinate output,
> map actions, and manual downloads remain, while a generic committed source lifetime, exact `{guid, localPath}` tuple,
> original-account lease, and account-invalidation subscription fence initial-stale mounts, recycled A→B→A rows, bounded
> parse success/error publication, retained configured callbacks, and download ownership. Its direct suite passes **24/24
> tests** and three unchanged vlocation/privacy/download-account suites pass **35/35**, together **4 suites / 59 tests**
> repeatedly without warnings. Direct arithmetic is **29 - 10 obsolete mode cases + 5 stronger source/account/action
> cases = 24**, moving the measured full gate from the phase-2O **4,252-test** checkpoint to **396 suites / 4,247 tests**.
> Review retracted a proposed A→B→A parse-settlement test because effect cleanup would make it vacuous; the retained
> configured-press case isolates the lifetime, while parse lifetime remains source-audited defense in depth. Scanner
> validation caught and recovered an initial context-mismatched inventory edit before the two LocationCard line fields
> were refreshed to 149 and 187 without changing their unproven dispositions; totals remain **1,053 / 492 proved / 561
> unproven / 0 structural / 0 nested**. Arbitrary same-account unmount, already-admitted native map/download work, the
> parent mode gate, setting/store/coordinator, and other mode-specific runtime consumers remain open. The Server Health
> `act(...)` warning appeared in this full run and remains open under `TEST-01`.
>
> **PRIV-03AU / DEC-10 UPDATE (2026-08-09):** Removal phase 2Q deletes only `ContactCard`'s Redacted store
> dependency and mode-specific vCard identity/action masking. Ordinary exact filename, parsed name, phone/email, initials,
> accessibility, native-open, and manual-download behavior remain. A generic ref-plus-committed source lifetime, exact
> `{guid, localPath}` tuple, original-account lease, and account-invalidation subscription fence initial-stale mounts,
> recycled A→B→A rows, bounded parse success/error publication, retained open/download callbacks, native-open token
> ownership, and missing-file re-download. Its direct suite passes **35/35 tests** and four unchanged vCard/open-file/
> download-account/privacy suites pass **48/48**, together **5 suites / 83 tests** repeatedly without warnings. Direct
> arithmetic is **46 - 12 obsolete mode cases + 1 initial-stale case = 35**, moving the measured full gate from the
> phase-2P **4,247-test** checkpoint to **396 suites / 4,236 tests**. Four existing ContactCard inventory line fields moved
> **158→156, 178→176, 184→182, and 221→222** without changing their unproven dispositions; totals remain **1,053 / 492
> proved / 561 unproven / 0 structural / 0 nested**. Arbitrary same-account unmount, an already-admitted Android open that
> cannot be recalled, the parent `MessageBubble` mode gate, setting/store/coordinator, and other mode-specific runtime
> consumers remain open. Intermittent Account/Server Health `act(...)` warning debt remains open under `TEST-01`; this
> report does not claim warning-free full-suite output.
>
> **PRIV-03AV / DEC-10 UPDATE (2026-08-09):** Removal phase 2R deletes only the fullscreen Media Viewer's Redacted store
> dependency, privacy epoch/subscription, and mode-specific hidden subtree. Ordinary exact image/video URI, blurhash,
> counter, Close, Share, Save, zoom, and carousel behavior remain. The original-account lease, tracked exact-route DB read
> and native actions, synchronous route/account/mount/Close revocation, alive cleanup, exact visible-attachment/gallery
> ownership, route-tagged load state, keyed and clamped no-fallback carousel, per-page callback/zoom lifetime, local-path
> validation, cache protection/refusal/release, protect-before-player ordering, and independent non-reentrant Share/Save
> tokens retain fixed-copy current failure/retry behavior plus stale success/error/finally suppression. The direct suite passes **34/34 tests**
> and the unchanged cache-protection and media-service suites pass **33/33**, together **3 suites / 67 tests** repeatedly
> without warnings. Direct arithmetic is **24 - 8 obsolete mode cases + 18 stronger route/page/account/cache/action cases
> = 34**, moving the measured full gate from the phase-2Q **4,236-test** checkpoint to **396 suites / 4,246 tests**. No
> DB-write finding was added or shifted; totals remain **1,053 / 492 proved / 561 unproven / 0 structural / 0 nested**.
> React Native Testing Library cannot directly prove the native composite FlatList's physical keyed remount; exact
> replacement index/counter/actions are host-proved while key/remount and token-specific `finally` ownership remain source-
> audited. Delayed route-query coverage also shares effect-local alive cleanup and does not mutation-isolate the numeric
> route lifetime. An admitted uncapped attachment SELECT still drains rather than cancels; admitted native Share/Save and
> already-open OS surfaces cannot be recalled; operation pin/re-stat refusal can yield a fixed generic failure; ordinary
> raw media remains in DB/JavaScript; and exact device carousel/player timing plus the remaining mode runtime stay open.
> The measured full gate passed, but intermittent Account/Server Health `act(...)` warning debt remains open under
> `TEST-01`; this report does not claim warning-free full-suite output.
>
> **PRIV-03AW / DEC-10 UPDATE (2026-08-09):** Removal phase 2S deletes only `ServerManagementScreen`'s Redacted store
> dependency and mode-specific status/statistics/origin/sync/action/log masking. Ordinary exact server identity, status,
> statistics, origin sharing, synchronization copy, actions, and deliberately opened logs remain. The `ping`/`stats`/
> `info` queries keep one captured account generation in their cache keys and discard delayed old-account success or
> rejection; generation invalidation reactively removes mounted old-account status, QR, and log hosts. Share, Sync,
> Health, Pairing, log, and restart callbacks retain the original-account lease. Restart/log work retains tracked
> Disconnect drain, stale success/error/dialog suppression, fixed current failure copy, and retry/finally release.
> `PairingQr` continues to host and encode no credential before explicit Reveal and retains exact-payload plus blur/
> AppState revocation. The direct suite passes **23/23 tests** and the unchanged Pairing QR/server-endpoint suites pass
> **25/25**, together **3 suites / 48 tests** repeatedly without warnings. Direct arithmetic is **25 - 7 obsolete mode
> cases + 5 stronger account/query/action cases = 23**, moving the measured full gate from the phase-2R **4,246-test**
> checkpoint to **396 suites / 4,244 tests**. No DB-write finding was added or shifted; totals remain **1,053 / 492 proved
> / 561 unproven / 0 structural / 0 nested**. Admitted network/native work drains rather than cancels, an already-open OS
> Share sheet cannot be recalled, arbitrary same-account unmount/global-callback lifetime is not fenced, and the password-
> bearing setup payload exists in JavaScript before deliberate Reveal while remaining outside the host/QR boundary.
> Ordinary detailed server data/logs, exact device lifecycle behavior, and the remaining mode runtime stay open. The
> established Server Health `act(...)` warning appeared in the measured full run and remains open under `TEST-01`; this
> report does not claim warning-free full-suite output.
>
> **PRIV-03AX / DEC-10 UPDATE (2026-08-09):** Removal phase 2T deletes only `MessageBubble`'s Redacted store dependency
> and mode-specific content/child/action masking. Ordinary exact body, attributed URL, subject, tombstone sender, reply,
> payload card, attachment/gallery, sticker, reaction, big emoji, accessibility, and actions remain. Exact cached-URL
> adoption prevents retained URL-A metadata from rendering for URL B, while deferred old-query success/rejection cannot
> replace or blank fresh B output. Text-only/no-network preview containment, `safeOpenUrl`, hidden plugin-attachment
> filtering, attachment-child native/cache ownership, and exact nested Reply/Reaction, configured long-press, Retry, and
> link/card callbacks remain covered. Direct arithmetic is **55 - 14 obsolete mode cases + 3 stronger URL-source cases =
> 44**. Four obsolete shared MessageBubble/ReplyQuote masking cases were also removed while all eight ordinary
> ConversationTile/MessageBubble/ReplyQuote/Find My controls and the intentional single NUL delimiter remain. The combined
> focused gate passes **8 suites / 88 tests** warning-free; targeted ESLint exits with zero errors and seven established
> mock-factory warnings. This moves the measured full gate from the phase-2S **4,244-test** checkpoint to **396 suites /
> 4,229 tests**. No DB-write finding was added or shifted; totals remain **1,053 / 492 proved / 561 unproven / 0 structural /
> 0 nested**. Arbitrary retained Pressability/inline callbacks after same-account recycling or unmount remain unfenced;
> attachment children own their native/cache/download lifecycles; URL-preview reads remain account-neutral exact-key cache
> reads; exact device long-press/FlashList behavior and remaining mode runtime stay open. The established Server Health
> `act(...)` warning appeared in the measured full run and remains open under `TEST-01`; this report does not claim warning-
> free full-suite output.
>
> **PRIV-03AY / DEC-10 UPDATE (2026-08-09):** Removal phase 2U deletes only `ServerHealthScreen`'s Redacted store
> dependency, privacy-revocation epoch/subscription, and hidden diagnostics/action branch. Ordinary exact diagnostics,
> alerts, RCS state, accessibility, Back, Refresh, Clear Alerts, and RCS reconnect remain. A captured original-account
> lease drives monotonic exact-generation retirement; the stale route mounts only Back plus fixed generic account-changed
> copy. All ten reads retain exact generation-scoped keys and guarded success/error adoption. Refresh retains its lease;
> Clear and RCS retain tracked Disconnect drain, stale success/rejection/cache/toast/refetch suppression, fixed current
> errors, current retry/finally release, retained-A rejection, and fresh-B exact actions. Direct arithmetic is **19 - 7
> obsolete mode cases + 6 stronger ordinary/account cases = 18**; the unchanged 20-case RCS-health suite yields **2
> suites / 38 tests**, moving the measured full gate from the phase-2T **4,229-test** checkpoint to **396 suites / 4,228
> tests**. The measured full run was quiet, but an independent post-freeze focused run reproduced the established
> intermittent TanStack Query React `act(...)` warning, so `TEST-01` remains open and this report does not claim
> categorically warning-free Jest output. No DB-write finding was added or shifted; totals remain **1,053 / 492 proved /
> 561 unproven / 0 structural / 0 nested**. Raw values may remain in generation-scoped query caches outside the host tree;
> arbitrary same-account unmount/retained callbacks have no generic mount lifetime; admitted Clear/RCS work drains rather
> than cancels; and the remaining mode runtime stays open.
>
> **PRIV-03AZ / DEC-10 UPDATE (2026-08-09):** Removal phase 2V deletes only `NewChatScreen`'s Redacted store dependency,
> privacy epoch/subscription, and mode-specific form masking/completion branches. Ordinary exact drafts, recipients,
> contact suggestions, staged URIs, transport, existing-chat shortcut, accessibility, and form actions remain. One
> captured original-account lease drives monotonic exact-generation retirement; the stale route mounts only Back plus
> fixed generic account-changed copy, and observable retained Open/Start actions plus every form setter recheck the live
> lease. Existing-
> chat results retain exact `recipientKey` adoption and effect cleanup, including immediate A→B shielding and
> A→empty→same-A stale success/rejection coverage. Availability remains deliberately address-keyed and original-lease-
> published. Share clearing and forward-handoff consumption remain current-account-admitted; protected pins release only
> after full create plus optional attachment-send success or unmount. Start retains the original lease through create,
> send, navigation, errors, and `finally`, with stale publication suppression and fixed current failure copy/retry. Direct
> arithmetic is **45 - 15 obsolete mode cases + 11 stronger ordinary/account/source cases = 41**; five unchanged companion
> suites add 35 tests, yielding **6 suites / 76 tests** warning-free and moving the measured full gate from the phase-2U
> **4,228-test** checkpoint to **396 suites / 4,224 tests**. Cross-instance availability/result publication and local-only
> setters are integration/source-audited rather than mutation-isolated. Two existing New Chat inventory records retain
> stable IDs and metadata with line-only remaps **410→346** and **458→389**; totals remain **1,053 / 492 proved / 561
> unproven / 0 structural / 0 nested**. Arbitrary same-account unmount/pre-rerender form callbacks lack a generic lifetime;
> contact search, late local state, and admitted create/send work may continue off-host; incomplete retired sends may hold
> pins until unmount; create-success/attachment-send-failure retains retry/idempotency ambiguity; and the remaining mode
> runtime stays open. `TEST-01` remains open, so the measured full run is not described as warning-free.

> **PRIV-03BA / DEC-10 UPDATE (2026-08-10):** Removal phase 2W deletes only Chat Settings' and `MediaSections`'
> Redacted store dependencies and mode-specific masking. Ordinary exact conversation identity, media/link rows,
> customization, group actions, notification settings, and picker flows remain. An outer captured account lease drives
> monotonic exact-generation retirement plus a fixed Back-only stale tree; a GUID-keyed inner screen owns an opaque mount
> lifetime so prior reactive data, editor state, and retained A callbacks cannot cross A→B→A replacement. Every callback,
> result, dialog, and `finally` path rechecks the exact GUID, lifetime, lease, and mounted owner. One non-reentrant outer
> token serializes all three pickers; current failures retain fixed copy and retry, while stale picker, exact-chat write,
> group-action, and notification-setting success/rejection cannot publish late UI. `MediaSections` retains `safeOpenUrl`
> as its default while Chat Settings supplies a guarded link callback; notification settings receive exact source-account
> context. Direct arithmetic is **11 - 3 obsolete mode cases + 24 stronger cases = 32** for Chat Settings and **12 + 1
> owner/default-link case = 13** for `MediaSections`; five unchanged companion suites add 44 tests, yielding **7 suites /
> 89 tests** warning-free. The owned-test arithmetic is a net **+22**, moving the measured full gate from the phase-2V
> **4,224-test** checkpoint to all **396/396 suites and 4,246/4,246 tests**, zero snapshots, passing under `--silent` in
> **56.041s**. Because `--silent` suppresses warning output, this is not warning-free evidence; `TEST-01` remains open.
> Full TypeScript, configured formatting, and diff checks pass;
> targeted ESLint has zero errors plus three established `MediaSections` test warnings. Thirteen exact Chat Settings
> inventory records were reconciled—eight line-only and five stable-ID/symbol/line replacements—with all evidence and
> dispositions preserved. The scanner suite passes **35/35**; live totals are **1,053 / 492 proved (400 coordinated + 92
> temporal) / 561 unproven / 0 structural /
> 0 nested**. Exact-chat writes drain after admission with late UI fenced; already-admitted native picker, external-link,
> or system-settings work cannot be recalled. A keyed-source picker already in flight drops later picker taps until
> settlement and requires a fresh tap; a hung picker blocks those actions until settlement or owner unmount. Token-specific
> release ownership remains source-audited because serialization makes a concurrent newer token unreachable. Sequential
> self-transacting background/theme/reset writes remain non-atomic; local preference writes remain best-effort; and exact
> native unmount/timing plus the remaining setting/store/coordinator/mode graph stay open.

> **PRIV-03BB / DEC-10 UPDATE (2026-08-10):** Removal phase 2X deletes only `SettingsScreen`'s Redacted store selector,
> toggle/persistence wiring, search vocabulary, and About masking. Ordinary settings and search, exact installed app
> identity, exact current-account server origin/version/macOS/Private API details, and the iMessage Account route remain.
> A captured account lease plus monotonic exact-generation retirement removes old server identity and the account route
> from the same mounted screen without an incidental store rerender; initial-stale and fresh-account mounts are covered.
> App Lock's biometric gate, truthful storage/screenshot limits, and generic locked-delivery behavior; explicit versioned
> error-report consent and sanitized-report wording; guarded Disconnect, tracked key rotation, lease-bearing Contacts
> sync, and Storage & File Privacy remain independent. Retained account-A consent confirmation is inert while fresh-account
> consent persists normally. Direct arithmetic is **28 - 4 obsolete mode cases + 2 stronger account-lifetime cases =
> 26**; the focused route suite passes **1 suite / 26 tests** warning-free. The measured full gate moves from the phase-2W
> **4,246-test** checkpoint to all **396/396 suites and 4,244/4,244 tests**, zero snapshots, passing under `--silent` in
> **57.637s**. Silence suppresses warning output, so this is not warning-free evidence; `TEST-01` remains open. Full
> TypeScript, targeted ESLint, configured formatting, and diff checks pass. The two existing Settings inventory entries
> keep their stable IDs, metadata, and unproven dispositions with line-only remaps **142→150** for `forget` and **167→175**
> for `rotateDatabaseKey`; scanner **35/35** and live totals remain **1,053 / 492 proved (400 coordinated + 92 temporal) /
> 561 unproven / 0 structural / 0 nested**. The process-wide serialized feature-store consent tail remains unleased, so
> an already-queued consent write can reach a later current database; this pre-existing ownership gap remains separate
> follow-up work. Arbitrary same-account route-unmount callbacks and already-admitted Disconnect/contact/rekey or native
> biometric/system-settings work cannot be recalled. The remaining store/coordinator/mode graph stays open.

> **PRIV-03BC / DEC-10 UPDATE (2026-08-10):** Removal phase 2Y deletes only the root layout's Redacted store
> subscription, notification-privacy coordinator, and obsolete rollback/failure-dialog plumbing. The foreground boot
> coordinator, fail-closed loading/App Lock presentation, cold/warm unlock, exact-run retry, degraded issue toasts, and
> connected notification-maintenance entry remain. The mount effect admits `startForegroundBoot` without repeating it on
> an ordinary rerender; coordinator companions retain process single-flight and lock semantics.
> `prepareNotificationPresentationState` runs only for connected-ready state and at most once per exact run; loading,
> locked, setup, and failed states do not admit it. A rejection is securely logged without a toast or protected-tree
> failure, is not retried in the same run, and retries on a fresh run. Fresh same-run snapshot objects mutation-pin the
> per-run guard. The direct route suite remains **12/12 tests** because the obsolete wiring had no behavioral test rows;
> four unchanged boot/lock/notification companions bring the focused gate to **5 suites / 106 tests** warning-free. The
> measured full gate remains all **396/396 suites and 4,244/4,244 tests**, zero snapshots, passing under `--silent` in
> **58.004s**. Silence suppresses warning output, so this is not warning-free evidence; `TEST-01` remains open. Full
> TypeScript, targeted ESLint, configured formatting, and diff checks pass. The existing `startForegroundBoot` inventory
> record keeps its metadata and unproven disposition while adopting the current callback stable ID/symbol at line **74**;
> `completeUnlock` keeps its stable ID with line-only remap **156→120**. Scanner **35/35** and live totals remain **1,053 /
> 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural / 0 nested**. Notification maintenance already
> admitted for a run drains rather than being recalled; exact process/StrictMode/native boot timing remains device/
> integration evidence. Bootstrap, realtime-control, store, notification-preview, standalone coordinator, and the other
> mode-specific graph remain open.

> **PRIV-03BD / DEC-10 UPDATE (2026-08-10):** Removal phase 2Z deletes the uncalled
> `privacyModeCoordinator` production module and its four-case direct test after a complete production/test/config scan
> proved zero remaining import, symbol, or filename residue. Root foreground boot and connected per-run notification
> maintenance, App Lock and generic locked delivery, `notifeeService`, and the still-live headless
> `notificationPrivacyGate` remain unchanged. The preserved boot/lock/notification gate passes **6 suites / 111 tests**
> warning-free. Removing exactly one obsolete suite and four tests moves the measured full gate from phase 2Y's **396
> suites / 4,244 tests** to all **395/395 suites and 4,240/4,240 tests**, zero snapshots, passing under `--silent` in
> **57.506s**. Silence suppresses warning output, so this is not warning-free evidence; `TEST-01` remains open. Full
> TypeScript, targeted ESLint, configured formatting, and diff checks pass. Both deleted files were pre-existing untracked
> worktree files, so Git records no deletion and cannot restore their contents from HEAD. No DB-write finding or inventory
> record changes: scanner **35/35** and live totals remain **1,053 / 492 proved (400 coordinated + 92 temporal) / 561
> unproven / 0 structural / 0 nested**. The deleted coordinator has zero residue, but bootstrap, realtime-control, the
> Redacted store, notification-preview state, headless privacy gate, Notifee mode branches/tests, and other runtime/UI
> consumers remain open.

> **PRIV-03BE / DEC-10 UPDATE (2026-08-10):** Removal phase 2AA removes only bootstrap's
> `notificationPreviewState` import/helper and its three mode-preview seed calls from foreground activation,
> `hydrateSession`, and explicit Connect. The guarded hydration registry still completes critical Feature/Sync settings
> before realtime delivery resumes; it also still hydrates/requires the legacy Redacted store until later removal. Durable
> session/vault and DB checks, original-account delivery leases, cache recovery, connected-session publication,
> sync/realtime startup, and Disconnect/forget ordering remain unchanged. Removing one pure mode-seeding test moves the
> direct suite from **84 to 83 tests**; unchanged foreground-boot and hydration-registry companions bring the focused gate
> to **3 suites / 97 tests** warning-free. The measured full gate keeps all **395/395 suites** and moves from phase 2Z's
> **4,240 tests** to **4,239/4,239 tests**, zero snapshots, passing under `--silent` in **59.867s**. Silence suppresses
> warning output, so this is not warning-free evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint,
> configured formatting, and diff checks pass. Exactly 21 existing bootstrap inventory records retain their stable IDs,
> symbols, metadata, evidence, and unproven dispositions with line-only remaps. Scanner **35/35** and live totals remain
> **1,053 / 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural / 0 nested**. At that checkpoint,
> realtime-control, the Redacted/hydration stores, notification-preview state, headless privacy gate, Notifee mode
> branches/tests, and other runtime consumers remained open.
>
> **PRIV-03BF / DEC-10 UPDATE (2026-08-10):** Removal phase 2AB removes only realtime-control's Redacted store
> hydration, notification-preview seeding, and mode-specific presentation gate from the post-DB notification path.
> Durable message delivery still hydrates fail-closed feature consent after admission and rejects for queue retry when
> settings remain unavailable; FaceTime bypasses message-only consent/filtering, while message notification enablement,
> unknown-sender filtering/fail-open lookup rejection, and stale delivery-context checks remain. The real
> `NotifyingEventSink` companion remains DB-first, and App Lock still rejects private intake before DB access while
> Notifee retains generic locked delivery. Skeptical review found and fixed a broad catch that could immediately attempt a
> durable native notification twice after a known-sender post rejected: the exact error now propagates after one attempt
> to the queue retry owner. Ten mutation-sensitive notifier cases move the startup suite from **13 to 23 tests**; with
> unchanged 30-case server-URL/App-Lock and 26-case real notification-intent companions, the focused gate passes **3
> suites / 79 tests** warning-free. The measured full gate keeps **395/395 suites** and moves from phase 2AA's **4,239
> tests** to **4,249/4,249 tests**, zero snapshots, passing under `--silent` in **80.693s**. Silence suppresses warning
> output, so this is not warning-free evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint, configured
> formatting, and diff checks pass. Sixteen existing realtime-control inventory records retain stable IDs, symbols,
> metadata, evidence, and unproven dispositions with line-only remaps. Scanner **35/35** and live totals remain **1,053 /
> 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural / 0 nested**. At that checkpoint, the Redacted
> store/hydration registry, notification-preview state, headless privacy gate, Notifee mode branches/tests, and other
> runtime consumers remained open.
>
> **PRIV-03BG / DEC-10 UPDATE (2026-08-10):** Removal phase 2AC permanently deletes the now-uncalled
> `notificationPrivacyGate` production module and its five-case direct suite after phase 2AB removed its final production
> purpose. Current production/test/config scans find zero filename or symbol residue. Root foreground boot and connected
> notification maintenance, App Lock's pre-DB and generic locked-delivery boundaries, Notifee presentation, realtime
> feature-consent/durable-retry/FaceTime/unknown-sender/stale-context behavior, and real DB-first notification derivation
> remain in the preserved **8-suite / 185-test** warning-free gate. Removing exactly one obsolete suite/five tests moves
> the measured full gate from phase 2AB's **395 suites / 4,249 tests** to **394/394 suites / 4,244/4,244 tests**, zero
> snapshots, passing under `--silent` in **56.361s**. Silence suppresses warning output, so this is not warning-free
> evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Both
> deleted files were untracked and absent from HEAD, so Git records no deletion and cannot reconstruct or restore their
> contents; current absence, zero references, and preserved behavior are verified separately. No DB-write finding or
> inventory entry changes: scanner **35/35** and live totals remain **1,053 / 492 proved (400 coordinated + 92 temporal) /
> 561 unproven / 0 structural / 0 nested**. The Redacted store/hydration registry, notification-preview state, Notifee
> mode branches/tests, and other runtime consumers remain open.
>
> **PRIV-03BH / DEC-10 UPDATE (2026-08-10):** Removal phase 2AD removes Notifee's mode-specific preview branches and
> permanently deletes the untracked `notificationPreviewState` module. Per the owner decision, ordinary message, alias,
> FaceTime, test, and reminder notifications retain their detailed presentation while Android controls lock-screen
> visibility. App Lock still emits its fixed generic new-delivery notice and does not retroactively scrub Android
> notifications or reminders already posted. Legacy raw payload/channel and route-ID migration, missing-reminder repair,
> unsafe reminder-ID refusal, the serialized native-operation queue, original-account and DB commit guards, exact
> FaceTime-route deletion, and failure-tolerant teardown remain mutation-pinned. The direct Notifee suite moves from
> **69 to 64 tests** (**69−15+10=64**, net **−5**), and the focused gate passes **7 suites / 148 tests** warning-free.
> The measured full gate moves from phase 2AC's **394 suites / 4,244 tests** to **394/394 suites / 4,239/4,239 tests**,
> zero snapshots, passing under `--silent` in **83.435s**. Silence suppresses warning output, so this is not warning-free
> evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Four
> obsolete mode-only inventory edges were removed; four retained Notifee entries were rekeyed and sixteen received
> line-only remaps without changing evidence or dispositions. Scanner **35/35** and live totals are **1,049 / 492 proved
> (400 coordinated + 92 temporal) / 557 unproven / 0 structural / 0 nested**. The deleted preview-state file was untracked
> and absent from HEAD, so Git records no deletion and cannot reconstruct it. The Redacted store/hydration registry and
> other runtime consumers remain open; `src/services/notifications/intents.ts` and
> `test/realtime/notificationIntent.test.ts` retain stale mode-preview wording for later cleanup.
>
> **PRIV-03BI / DEC-10 UPDATE (2026-08-10):** Removal phase 2AE removes the Redacted store from the shared hydration
> registry and from critical-readiness admission. The registry is now exactly Theme, Feature, and Sync; Feature and Sync
> remain required before account activation, while Theme's real DB-unavailable path opens first paint on the safe default
> and is retried at Home. One shared ownership guard reaches all three stores, an already-retired run starts no read,
> unexpected registered-store rejection propagates to the existing fail-closed boot boundary, and Home hydrates each
> store once inside its original-account teardown barrier. Its captured guard remains false across an A→paused→B cycle.
> Adding one rejection-propagation case moves the focused gate to **5 suites / 128 tests** warning-free and the measured
> full gate from phase 2AD's **394 suites / 4,239 tests** to **394/394 suites / 4,240/4,240 tests**, zero snapshots,
> passing under `--silent` in **56.506s**. Silence suppresses warning output, so this is not warning-free evidence;
> `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Scanner **35/35**
> and live totals remain **1,049 / 492 proved (400 coordinated + 92 temporal) / 557 unproven / 0 structural / 0 nested**
> with no inventory change. The unused `redactedModeStore`, its focused/reset/commit-guard tests, the persisted
> `privacy.redactedMode` backup allowlist/fixtures, and stale intent wording remain for later removal.
>
> **PRIV-03BJ / DEC-10 UPDATE (2026-08-10):** Removal phase 2AF removes only obsolete Redacted setup and
> durable-preference assertions from MessageList and session-scoped-state tests. Ordinary list rendering and leased
> retry/discard, every account-owned reset, async query/Find My disowning, and durable Feature/Sync/Theme/App Lock/share
> survival remain. Its direct **2-suite / 20-test** and broader **9-suite / 131-test** gates pass warning-free; targeted
> ESLint has zero errors and six established MessageList CommonJS mock warnings. Phase 2AG then deletes the tracked,
> runtime-uncalled `redactedModeStore`. The owned suites move from **9−3=6** and **4−2=2** tests; the preserved
> Sync/Feature/Theme/registry/Home/boot gate passes **7 suites / 89 tests** warning-free. Removing those five obsolete
> cases moves the measured full gate from phase 2AE's **394 suites / 4,240 tests** to **394/394 suites / 4,235/4,235
> tests**, zero snapshots, passing under `--silent` in **59.467s**. Silence suppresses warning output, so this is not
> warning-free evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, architecture,
> and diff checks pass. The tracked source deletion is recoverable from HEAD. Its one unproven `kvSet` inventory edge was
> removed; scanner **35/35** and live totals are **1,048 / 492 proved (400 coordinated + 92 temporal) / 556 unproven / 0
> structural / 0 nested**. The ignored persisted `privacy.redactedMode` row, backup allowlist/compatibility and migration
> fixtures, dead `FindMyMapHidden`, and stale Redacted comments remain explicitly open.
>
> **PRIV-03BK / DEC-10 UPDATE (2026-08-10):** Removal phase 2AH removes `privacy.redactedMode` from the symmetric
> backup KV allowlist. New exports omit an old live row, and a forged older encrypted backup cannot reintroduce the
> retired key while supported settings still restore under the existing account, queue, and transaction ownership. Its
> focused gate passes **3 suites / 61 tests** warning-free. Phase 2AI appends exact-key migration
> `0037_purge_legacy_redacted_mode_setting`. The initial two-file candidate correctly failed `check:migrations` because
> it lacked the required allocation; the bounded scope expanded to add the exact prepared `0037` registry entry with
> truthful schema/cache N/A evidence. The upgrade test observes the target deleted before a forced migration-record
> insertion failure, proves rollback restores it and leaves `0037` unrecorded, then proves exact-key retry and an
> idempotent rerun while unrelated and same-prefix KV rows survive. Its focused gate passes **5 suites / 9 tests**
> warning-free, and the migration guard passes **37 sequential migrations / 5 tests**. Adding the upgrade suite/case
> moves the measured full gate from phase 2AG's historical **394 suites / 4,235 tests** to **395/395 suites /
> 4,236/4,236 tests**, zero snapshots, passing under `--silent` in **82.117s**. Silence suppresses warning output, so
> this is not warning-free evidence; `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting,
> migration, architecture, and diff checks pass. The startup delete adds one reviewed temporal inventory edge; scanner
> **35/35** and live totals are **1,049 / 493 proved (400 coordinated + 93 temporal) / 556 unproven / 0 structural / 0
> nested**. Dead mode-only helpers/test artifacts, `FindMyMapHidden`, and stale notification/state/Find My comments
> remain open.
>
> **PRIV-03BL / DEC-10 FINAL UPDATE (2026-08-10):** User-configurable Redacted Mode is permanently removed and no
> future support is planned. Phases 2AJ–2AL reduced the old privacy utility to finite-coordinate validation, removed its
> obsolete masking APIs/tests, and renamed the coordinate-only module and test to `src/utils/location.ts` and
> `test/utils/locationPoint.test.ts` without a shim. Phase 2AM
> deleted the uncalled `FindMyMapHidden` while preserving the live `WEB-02` disabled-map placeholder. Phase 2AN removed
> Avatar/GroupAvatar seed APIs and seed-only cases while preserving ordinary photo, initials, color, decorative-
> accessibility, URI, and layout behavior. Phases 2AO–2AT corrected stale source/test/`AGENTS.md` contracts, including
> bootstrap's settings-store wording, without executable changes. The NUL-bearing
> `test/components/redaction.test.tsx` filename remains deliberately untouched and documented; its eight tests cover
> ordinary behavior and do not expose a mode API. Removing 13 obsolete coordinate/masking/seed cases moves the historical
> `PRIV-03BK` checkpoint from **395 suites / 4,236 tests** to **395 suites / 4,223 tests**, with the suite count unchanged.
> Only intentional exact legacy-key migration/backup negatives and
> independent secure log/error redaction remain. Ordinary notifications are detailed; App Lock's fixed generic delivery,
> Pairing QR's explicit reveal/revocation, and account/source ownership guards remain intact. The final security/retirement
> gate passes **11 suites / 211 tests** warning-free. Two pinned `--silent` full runs pass **395 suites / 4,223 tests / 0
> snapshots** in **206.655s** and **189.899s**; these are not warning-free full-run claims, and `TEST-01` remains open.
> Architecture passes **30/30 tests** across **65** platform-free core files, migration allocation passes **37 sequential
> migrations / 5 guard tests**, and scanner **35/35** reports **1,049 entries / 493 proved (400 coordinated + 93 temporal)
> / 556 unproven / 0 structural errors / 0 nested coordinators**.
>
> **DB-02A-DEVSEED UPDATE (2026-08-10):** The reachable DEV fixture no longer performs its read-marker update as a
> raw Drizzle write that could join an unrelated transaction. `seedFixtures` now awaits the public
> `setLastReadMessageGuid` owner, which serializes the write and clears `markedUnreadAt`. Its real-DB rolling-neighbour
> test partial-mocks the earlier handle/chat/message upserts and proves exact held state—five message upserts, pending
> seed, and `phantom` / `777`—then exact post-rollback completion—ten upserts and `c-work-m` / `null`. The focused gate
> passes **4 suites / 52 tests** warning-free. The pinned full gate passes **396 suites / 4,224 tests / 0 snapshots**
> under `--silent` in **63.784s**; this is functional evidence, not a warning-free full-run claim, and `TEST-01`
> remains open. TypeScript, targeted ESLint, configured Prettier, architecture (**30 tests / 65 core files**), scanner
> **35/35**, and diff checks pass. Inventory reconciliation replaces the old raw Drizzle stable ID with a new unresolved
> `setLastReadMessageGuid` call plus 20 exact line remaps. Totals remain **1,049 entries / 493 proved (400 coordinated +
> 93 temporal) / 556 unproven / 0 structural errors / 0 nested coordinators**. That unchanged classification is an
> honest scanner limitation: the tested runtime bystander defect is fixed, but the scanner does not infer the public
> helper's transitive ownership at this caller, so the replacement remains `unproven` and `DB-02A` remains
> **IN_PROGRESS**.
>
> **DB-02A-CONSENT UPDATE (2026-08-11):** Error-report consent now captures the exact database and original-account
> predicate before entering its serialized persistence tail. The tail owns one explicit `withDbTransaction` and uses
> `kvSetWithinTransaction`; choice-generation and account-lease checks fence admission, `BEGIN`, `COMMIT`, and state
> publication. Stale or superseded work resolves quietly. A still-current database failure restores the previous
> confirmed choice, rejects to fixed raw-free Settings copy, and releases the tail for retry. Device-global carryover
> and the legacy `1` migration policy remain `PRIV-02` work. The mutation-sensitive related gate passes **5 suites / 92
> tests** warning-free. The first full attempt exposed a stale `errorReportQueueService` test caller as **TS2554** after
> **395 suites passed / 1 suite failed to compile / 4,206 tests ran**; adding its required lease/database context fixed
> the harness. The final pinned gate passes **396 suites / 4,229 tests / 0 snapshots** under `--silent` in **69.125s**;
> this is not a warning-free claim, and `TEST-01` remains open. Full TypeScript, ESLint with zero allowed warnings,
> configured formatting, architecture (**30 tests / 65 core files**), scanner **35/35**, and diff checks pass. Inventory
> reconciliation removes the old unresolved consent ID, adds three coordinated findings, rekeys three unrelated
> Feature-store entries, and remaps Settings lines **150→151** and **175→176**. Live totals are **1,051 entries / 496
> proved (403 coordinated + 93 temporal) / 555 unproven / 0 structural errors / 0 nested coordinators**. Parent
> `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-DUPMARK UPDATE (2026-08-11):** No production code changed. Two mutation-sensitive incremental-sync rows
> prove that an all-duplicate page's cursor marker claims its own queue slot, stays pending behind a rolling-back
> neighbour, commits the exact marker afterward, and rejects original-account retirement that occurs after the
> post-fetch check and queue claim but before `BEGIN`. The direct sync suite moves **21→23 tests**; focused **3 suites /
> 38 tests** and broader **5 suites / 58 tests** pass warning-free. The first pinned full attempt reported **395 passing
> / 1 failing suite** and **4,229 passing / 2 failing tests of 4,231**. Both consent triggers actually rejected and
> rolled back; the failure was cross-Jest-realm native `SqliteError` identity under `.toThrow`. Exactly those two
> matchers now compare the structural `CONSENT_WRITE_RAW_CANARY` message, and a forced Sync-first `--no-cache` gate
> passes **2 suites / 55 tests**. The final pinned gate passes **396 suites / 4,231 tests / 0 snapshots** under `--silent`
> in **60.129s**; this is not a warning-free claim, and `TEST-01` remains open. Scanner **35/35** classifies exactly the
> line-746 transaction opener, callback edge, and inner `setSyncMarker` call as coordinated. The raw transaction-neutral
> `setSyncMarker` definition remains unproven. Live totals are **1,051 entries / 499 proved (406 coordinated + 93
> temporal) / 552 unproven / 0 structural errors / 0 nested coordinators**. Parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-INCOMING-ENQUEUE UPDATE (2026-08-11):** No production code changed. Frozen `incomingEvents.ts` is
> SHA-256 `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`; its direct test is
> `4514750c6e3383b2a894d69ed4c8d0d1ebec7c27d4fb4640a566eded1059a728`. Three mutation-sensitive real-DB
> rows prove that public intake waits behind a rolling-back neighbour, maintenance and insertion share one rollback
> boundary, and delayed driver maintenance remains awaited before fresh insertion or result publication. The exact
> gate passes **2 suites / 35 tests** warning-free, and the broader gate passes **4 suites / 70 tests** twice in
> isolation. A first concurrently launched broader run exited **139** and is retained as a failed resource-contended
> attempt, not behavior evidence. The pinned full gate passes **396 suites / 4,234 tests / 0 snapshots** under `--silent`
> in **59.003s**; this is not a warning-free claim, and `TEST-01` remains open. Scanner **35/35** classifies exactly
> `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent:mutator-call:c0d9b9793987`,
> `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent:mutator-call:c42331949358`,
> `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent.<callback:0dc6976e8d>:mutator-call:6ac9cadde422`, and
> `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent.<callback:0dc6976e8d>:mutator-call:b1927935b4b6`
> under the public `enqueueIncomingEvent` owner. Live totals are **1,051 entries / 503 proved (410 coordinated + 93
> temporal) / 548 unproven / 0 structural errors / 0 nested coordinators**. Parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-SYNC-SETTING UPDATE (2026-08-11):** Only `syncSettingsStore` changed. Its device-global
> Messages-per-Chat preference remains optimistic and best-effort, but now captures the current database synchronously
> and exposes one awaited `withDbTransaction`/`kvSetWithinTransaction` owner. No account lease or Settings-route change
> was added. Frozen source SHA-256 is `bab140d9771e58683b1dbe67f71fbd6c542d2c72cc130259e4cfbb5532a93ffe`;
> the test is `c34a985e63034b5e8d72cf5a8c178b27a7f8ef75bf2e25110df7d370bab2b53c`. Real-DB tests prove optimistic
> pending state behind a rolling-back neighbour, invocation-time A-database capture across a mocked B pointer without
> touching B, forced persistence rollback, retained session state, queue release, and exact retry. The focused gate
> passes **3 suites / 18 tests** warning-free and the broader hydration/session/forget gate passes **7 suites / 132
> tests** warning-free. The pinned full gate passes **396 suites / 4,236 tests / 0 snapshots** under `--silent` in
> **64.451s**; this is not a warning-free claim, and `TEST-01` remains open. Scanner **35/35** replaces stale suffix
> `1506af5c53f5` with coordinated suffixes `b22e0563db36`, `c7fd9d1633dc`, and `8b9c82a51e41`. Live totals are
> **1,053 entries / 506 proved (413 coordinated + 93 temporal) / 547 unproven / 0 structural errors / 0 nested
> coordinators**. Parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-DELETION-CURSOR UPDATE (2026-08-11):** No production code changed. Frozen source SHA-256 is
> `fde2ade26d5f0c85c9d7722913de5d13785b8127123c6205f7643c73cef91a01`; the direct test is
> `0eb4e1cbf99089ed1fade2750343188a3ad1129cc007178bbf1ddfdf37278097`. Post-tombstone current/revoked
> rows prove the cursor transaction queues behind a rolling-back neighbour, preserves the committed deletion marker,
> then either commits the current cursor or rejects the queued old-account cursor through its commit guard. A forced
> cursor-KV failure preserves the old cursor and releases retry; a delayed exact inner-KV spy proves the transaction
> awaits its asynchronous body before COMMIT. The harness bounds its start poll to 20 event-loop turns and always
> releases/restores the spy. The direct **1-suite / 23-test** gate passes warning-free; the related deletionSync,
> syncEngine, syncEngineBranches, and withDbTransaction gate passes **4 suites / 61 tests** warning-free twice. The
> pinned full gate passes **396 suites / 4,240 tests / 0 snapshots** under `--silent` in **62.792s**; this is not a
> warning-free claim, and `TEST-01` remains open. TypeScript, lint, Prettier, diff, and scanner **35/35** checks pass.
> Exactly `src/services/sync/engine.ts#syncDeletedMessages:mutator-call:268dc408452b`,
> `src/services/sync/engine.ts#syncDeletedMessages:mutator-call:55b8cf67e19e`, and
> `src/services/sync/engine.ts#syncDeletedMessages.<callback:a3920be9f6>:mutator-call:2849306a1437` are coordinated
> under `syncDeletedMessages`; the line-612 public `markMessageDeleted` call remains unproven. Live totals are **1,053
> entries / 509 proved (416 coordinated + 93 temporal) / 544 unproven / 0 structural errors / 0 nested coordinators**.
> Parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-INCOMING-TERMINAL UPDATE (2026-08-11):** No production code changed. Frozen source SHA-256 is
> `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`; the direct test is
> `a2ecad7ec41c5f8d50b1c410eda254ee717b80830b7600c32da6894d76270af0`. Six current/revoked
> rolling-neighbour cases cover `completeIncomingEvent`, `poisonIncomingEvent`, and transient `failIncomingEvent`;
> three trim-trigger cases prove terminal update/deletion rollback and same-claim retry; three delayed-driver cases
> prove every terminal trim remains awaited through COMMIT with bounded, unconditional harness cleanup. The first direct
> run passed **35/38** because Drizzle wrapped the native canary; the exact `cause.message` matcher corrected it. Final
> direct **1 suite / 38 tests** and broad incoming-events/drain/dispatcher/transaction **4 suites / 75 tests** pass
> warning-free. A first broad typo named a nonexistent realtime test path and honestly ran only **3/58**.
>
> Scanner **35/35** coordinates exactly these nine entries: for `completeIncomingEvent`,
> `src/db/repositories/incomingEvents.ts#completeIncomingEvent:mutator-call:f8dbb1b68a3e`,
> `src/db/repositories/incomingEvents.ts#completeIncomingEvent:mutator-call:fbcef33c7882`, and
> `src/db/repositories/incomingEvents.ts#completeIncomingEvent.<callback:c9dba59803>:mutator-call:248e5efeb753`; for
> `poisonIncomingEvent`, `src/db/repositories/incomingEvents.ts#poisonIncomingEvent:mutator-call:ee08448c1362`,
> `src/db/repositories/incomingEvents.ts#poisonIncomingEvent:mutator-call:c14392ef2a42`, and
> `src/db/repositories/incomingEvents.ts#poisonIncomingEvent.<callback:68e99382e0>:mutator-call:1d7236fb432e`; for
> `failIncomingEvent`, `src/db/repositories/incomingEvents.ts#failIncomingEvent:mutator-call:c793ae3d6e57`,
> `src/db/repositories/incomingEvents.ts#failIncomingEvent:mutator-call:362131213111`, and
> `src/db/repositories/incomingEvents.ts#failIncomingEvent.<callback:d2a018fef9>:mutator-call:5a438c9ce541`. A generic
> first patch temporarily touched an unrelated attachment opener; exact-ID audit restored it before final validation.
> Live totals are **1,053 entries / 518 proved (425 coordinated + 93 temporal) / 535 unproven / 0 structural errors / 0
> nested coordinators**. Raw terminal updates already coordinated before this child; the private neutral trim definition,
> drain callers, and DB-applied transaction primitive remain outside it. Parent `DB-02A` remains **IN_PROGRESS**.
>
> **TEST-01-INBOX-RAF UPDATE (2026-08-11):** The first post-terminal full attempt passed the terminal suite but reported
> **395 passing / 1 failing suite** and **4,251 passing / 1 failing test of 4,252** in **61.571s**: Conversation List
> line 792 expected one immediate return scroll and received two. Filtered stress reproduced **3 failures in 8 runs**.
> The RN Jest preset maps RAF to `setTimeout(0)`, allowing the deliberate corrective frame to race awaited `act()`.
> Production remains unchanged at SHA-256 `a01842b00b983d692c7f14c455d99ec176465a45510c9f5a7864270b65f27629`;
> only `test/components/conversations/conversationListScreen.test.tsx` changed, at
> `9c2210bb49dd740f1f8415b6452e9a0d69b259f7f6e8d4a3f0fa2e558e78d1fc`. The harness now captures frames,
> observes the immediate scroll, explicitly flushes the corrective frame, and proves drag suppression. Post-fix evidence
> is **8/8** filtered repetitions, direct **32/32**, and **2 suites / 36 tests** with the Message List focus companion;
> TypeScript, Prettier, and diff checks pass, with targeted lint at **0 errors / 11 established Jest-mock warnings**. The
> final full gate passes **396 suites / 4,252 tests / 0 snapshots** under `--silent` in **61.716s**. This is not a
> warning-free claim. Child `TEST-01-INBOX-RAF` is **DONE**; primary `TEST-01` remains open for Account/Server Health
> TanStack Query `act(...)` warnings and the UI coverage threshold.
>
> **DB-02A-INCOMING-CLAIM UPDATE (2026-08-11):** No production code changed. Frozen source SHA-256 is
> `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`; the direct test is
> `2994dd6e03aae9253694705d81062eb8dfe313b5c586715f3b8fe607f0790600`. Current and queued-revoked
> rolling-neighbour rows prove claim queue ownership, unchanged attempt/lease state after guard rejection, and fresh
> retry. An exact lease-UPDATE trigger proves maintenance terminalization, stale-receipt trimming, and claim acquisition
> roll back together before same-request retry. A sequential delayed-driver row first holds the semantic terminalization
> write and then the exact claim `UPDATE ... RETURNING`; bounded 20-turn polls and unconditional dual release, drain,
> and driver restoration prove both lifetimes remain inside the transaction without leaking a failing mutation. The
> first direct run passed **41/42** warning-free: the only mismatch expected stale `terminalAt` **0** rather than the
> seeded **499999**, and the sole correction named and asserted exact `staleTerminalAt`. Final direct **1 suite / 42
> tests** and broad incoming-events/drain/dispatcher/transaction **4 suites / 79 tests** (**42 + 11 + 17 + 9**) pass
> warning-free. TypeScript, lint, Prettier, and diff checks pass. The pinned full gate passes **396 suites / 4,256 tests
> / 0 snapshots** under `--silent` in **61.501s**; this is not a warning-free claim, and `TEST-01` remains open. Scanner
> **35/35** coordinates exactly `be1a887c88a0`, `4b006e047c1e`, and `563137048706` under `claimIncomingEvents`.
> Already-coordinated raw UPDATE `2b18a1aa5bcb`, the drain caller, private maintenance bodies, public maintenance
> owner, and DEV-only enqueue-and-claim entries remain unchanged. Live totals are **1,053 entries / 521 proved (428
> coordinated + 93 temporal) / 532 unproven / 0 structural errors / 0 nested coordinators**. Child
> `DB-02A-INCOMING-CLAIM` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-MANUAL-RETRY UPDATE (2026-08-11):** Manual “Try Again” had a concrete duplicate-send race: it captured a
> numeric `Date.now()` before the global database mutex, so a wait of at least the 120-second lease could commit an
> already-expired lease and let the automatic drain overlap. `claimFailedOutgoingForRetry` now accepts
> `clock: () => number = Date.now`, invokes it exactly once as its owned callback starts, and production passes
> `Date.now`; account guards are unchanged. Frozen outgoing/send/test SHA-256 values are
> `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5`,
> `13adf7fa10c550d026ecbe26afda8bcc2d88713ab82dbf5e70f612cd7f2984d5`, and
> `7b4de47eda3894c864dac2038eef2bfe0306e3e6957d04638da18c94bdb6c8f0`. The unchanged-test gate first had **3
> passing suites / 1 compile-failing suite** and **46 runnable tests passing**; `TS2345` identified numeric clocks at
> `outgoingUserActions` lines 205 and 234. The first saved direct matrix passed **21/21** without behavioral correction;
> only mechanical Prettier followed. Final direct **1/21** and broad outgoing-user-actions/outgoing-queue/send-retry/
> transaction **4 suites / 67 tests** pass warning-free. The matrix proves a T0→T1 post-lock lease and actual automatic
> claim false at T1 and expiry-minus-one but true exactly at expiry, queued revocation/fresh retry, exact rearm-trigger
> rollback/retry, and delayed final-driver lifetime with bounded cleanup. TypeScript, lint, Prettier, and diff checks
> pass. The pinned full gate passes **396 suites / 4,260 tests / 0 snapshots** under `--silent` in **246.999s**; the
> slow run stayed active without timeout, this is not a warning-free claim, and `TEST-01` remains open.
>
> Scanner **35/35** rekeys opener `5b0b42b8fd0b`→`325097db272e` and adopted callback `5cfe652b15e2`→
> `a706d4ac651f` (callback target `e9bfabd7cd`→`685deb4951`) as coordinated under
> `claimFailedOutgoingForRetry`. Service caller `dd42c57d0295`→`7d5ba2e65922` (enclosing callback
> `b6bf2c4f14`→`7c4158bf3d`) remains unresolved/unproven. Exactly 47 retained lines move by one; raw SQL IDs
> `581ca0d744d7` and `cdb4aa217454` remain coordinated. Live totals are **1,053 entries / 523 proved (430
> coordinated + 93 temporal) / 530 unproven / 0 structural errors / 0 nested coordinators**. Child
> `DB-02A-MANUAL-RETRY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-NO-GUID UPDATE (2026-08-11):** No production code changed. Frozen `outgoing.ts` remains SHA-256
> `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5`; frozen `outgoingBranches` is
> `b14f8c8617ab0404c6863fde0378f06432a908bb5e83e91f8fde1f5353721d54`. The first saved direct matrix passed
> **36/36** without a behavioral correction; only mechanical Prettier followed. Final direct **1/36** and exact related
> **6 suites / 92 tests** pass warning-free; TypeScript, lint, Prettier, and diff checks pass.
>
> A current NULL-state rolling-neighbour row proves queue isolation before promotion/deletion; a queued revoked guard
> preserves message and ladder before fresh retry. An exact queue-DELETE trigger proves the promoted UPDATE and delete
> roll back atomically before retry. The orphan branch's typed `db.delete` proxy selects the exact `outgoingQueue` table
> by identity, gates its `.where(...).then` lifetime without an ordinal, and uses bounded polling plus unconditional
> release/drain/restore. Existing sticky-error, orphan, and cancelled-send tombstone branches remain. The pinned full
> gate passes **396 suites / 4,264 tests / 0 snapshots** under `--silent` in **62.247s**; this is not a warning-free
> claim, and `TEST-01` remains open.
>
> Scanner **35/35** coordinates only callback `21d3f3a56e51` and opener `56ce496904c4` under
> `markOutgoingSentNoGuid`. Raw UPDATE `bd931e16d6fe` and deletes `4cd4d05885ce` / `:2` retain their coordinated
> evidence; callers `9593aa17c736` and `7d4ffb0ff6ea` remain unresolved/unproven. Live totals are **1,053 entries /
> 525 proved (432 coordinated + 93 temporal) / 528 unproven / 0 structural errors / 0 nested coordinators**.
> Non-unique/unindexed `outgoing_queue.temp_guid` remains a schema residual, so no absolute hard-row-bound claim is
> made. Child `DB-02A-NO-GUID` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.
>
> **DB-02A-ATTACHMENT-INSERT UPDATE (2026-08-11):** A skeptical source audit found a real inbox-order regression:
> `insertOutgoingAttachment` unconditionally wrote `args.now` to `latest_message_date`, so a queued attachment older
> than a newer committed chat date could move that chat backward. The one-production-file fix changes source prefix
> `b19867e2` to SHA-256 `70908bf68d68c3e61b3e53b227caac652a119c3f5c046f6ed28cde6c82a8c1bb` and writes the
> NULL-safe maximum inside the existing transaction. The inserted message's own `dateCreated` remains the original
> `args.now`; the fix changes only the denormalized chat sort key.
>
> Frozen `attachmentsBranches` SHA-256 is
> `1ade99575ffe746b6a2fcb8852a3ee29aa42e9e514b3f937ff684e6f9dc447c5`. The first saved three-case matrix passed
> direct **18/18**. Skeptical mutation review then found that all three current dates were non-NULL, so deleting only
> `COALESCE` from the fix would survive while a first attachment left `latest_message_date` NULL. One in-place
> correction starts the final-update failure row from NULL, proves the trigger rollback preserves NULL, and proves
> same-input retry initializes exact `args.now`. Final direct **1 suite / 18 tests** and related **5 suites / 54
> tests** pass warning-free; TypeScript, lint, Prettier, and diff checks pass. The matrix also proves a committing
> newer-date neighbour preserves exact message/attachment/queue/chat state, a final chat-UPDATE failure rolls all
> inserts back before retry, and exact-table message→attachment→queue→chat driver promises execute in order. Its
> 20-turn start polls, no-later-stage assertions, unconditional releases/drains, and nested spy restoration keep
> failing lifetime mutations bounded.
>
> Scanner **35/35** rekeys transaction opener `d3ae4f593073`→`4dd6251e013d`, adopted callback `5dce26a2d13d`→
> `dd5c38e6102a`, and already-coordinated chat update `d76c724fb6cf`→`b3bfd51dc502`; message, attachment, and queue
> insert IDs `200458432e22`, `a7d927dc8dcd`, and `ee86ffa4fe9d` remain stable. Exact line-only remaps are
> `cdd120954cda` **500→505**, `3aa7e5bcb44c` and
> `ad8e3c536a11` **532→537**, and `babf28515e2e` **533→538**. Foreground and DEV caller edges remain
> unresolved/unproven, but both capture the exact A database inside admitted work, which account teardown drains
> before wiping A; this is not a narrow A→B write defect. Long-transfer drain latency, logical
> path/name/MIME/payload byte lengths that lack schema caps, and the adjacent unconditional text/contact timestamp
> writers remain separate residuals. The pinned full gate passes **396 suites / 4,267 tests / 0 snapshots** under
> `--silent` in **238.705s**; this is functional evidence, not a warning-free full-run claim, and `TEST-01` remains
> open. Live totals are **1,053
> entries / 527 proved (434 coordinated + 93 temporal) / 526 unproven / 0 structural errors / 0 nested coordinators /
> 0 membership errors**. Child `DB-02A-ATTACHMENT-INSERT` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-OUTGOING-DATES UPDATE (2026-08-11):** The text and contact optimistic writers shared the attachment
> path's real inbox-order regression: each unconditionally assigned its captured `args.now` after entering the DB
> queue, so an older send could move a chat behind newer committed activity. The one-production-file fix changes
> `outgoing.ts` SHA-256 from `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5` to
> `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e` and makes both projections
> `MAX(args.now, COALESCE(chats.latest_message_date, args.now))`. Message `dateCreated`, APIs, callers, existing
> transaction ownership, and account-drain behavior are unchanged.
>
> Frozen `outgoingBranches` SHA-256 is
> `f63f6a81bef6267c72dc989c518dfadf0b7a412895794db53e5b15ed16a72e65`. The first saved five-case expansion
> passed direct **41/41** without behavioral correction; only mechanical Prettier followed. Final direct **1 suite /
> 41 tests** and exact related **6 suites / 92 tests** pass warning-free, with TypeScript, lint, Prettier, and diff
> checks green. Parameterized text/contact lifecycle rows independently prove NULL initialization, lower-date
> advancement, and preservation behind a committing newer neighbour. Two final-chat trigger rows prove the preceding
> queue/message inserts roll back before exact retry. The contact-only delayed-driver row intercepts the exact
> queue→message→chat table thenables, proves each await holds the transaction and blocks later stages, and uses bounded
> 20-turn polling, unconditional release/drain, and nested spy restoration.
>
> Scanner **35/35** replaces unresolved text update `299c124b87a4` with `7d8ea8995411`, which remains unproven;
> coordinates contact opener `73e7d6d7db86`→`9007b0c2c63b` and callback `c70f215977f1`→`92c88f78cf3d`; and
> preserves coordinated contact-update metadata through `b288290fa098`→`531c582192c5`. Exactly **63** retained
> findings receive line-only remaps. The first combined inventory patch was rejected atomically by overlapping hunk
> context, so no partial edit landed; split stable-ID-bound batches succeeded. Caller edges and the exported
> transaction-only text primitive remain unresolved/unproven. Long admitted-work drain latency and uncapped logical
> payload strings/contact array counts remain explicit residuals. The pinned full gate passes **396 suites / 4,272
> tests / 0 snapshots** under `--silent` in **232.787s**; this is functional evidence, not a warning-free full-run
> claim, and `TEST-01` remains open. Live totals are **1,053 entries / 529 proved (436 coordinated + 93 temporal) / 524
> unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**. Child
> `DB-02A-OUTGOING-DATES` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-INCOMING-CLAIM-CLOCK UPDATE (2026-08-11):** The normal production incoming claim path had a concrete
> stale-lease race: `IncomingEventDrain` sampled `now` before the claim waited for the process-wide DB mutex, so a
> wait of at least the 120-second lease could commit an already-expired claim and allow duplicate event processing or
> downstream side effects. `incomingEvents.ts` changes SHA-256
> `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`→
> `da3a8a3ccefd390f220427dede1acb2785ea7fc6bbc01d821b4db86f18a3a208`; `incomingEventDrain.ts` changes
> prefix `0db9e3c`→SHA-256 `7631bd533ba3ee86d3018b4b31377af3582dc130767f489b445064dd206b81ab`.
> The claim now invokes a clock callback exactly once as the transaction callback's first statement and reuses that
> post-lock value for maintenance, eligibility, and lease expiry; the drain passes `this.now`. Lease-token and limit
> validation remain ahead of queue admission. The DEV-only atomic enqueue-and-claim helper remains numeric and is an
> explicit follow-up outside this normal-production slice.
>
> The unchanged-test gate first reported `TS2353` at `incomingEvents.test.ts:125` (`'now' does not exist`), while the
> other three suites ran **37 passing tests**. All **31** pre-existing normal test callers were migrated. Frozen test
> SHA-256 is `da082366e9e572bb31bb3b01f30862cccb66a7d6cc42576643576abf084aa6e4`; its first saved direct suite
> passed **43/43** without behavioral correction. A remaining style warning was corrected only by targeted Prettier.
> Final direct **1 suite / 43 tests**, exact incoming-events/drain **2 suites / 54 tests**, and broad incoming-events/
> drain/dispatcher **3 suites / 71 tests** pass warning-free; TypeScript, lint, Prettier, and diff checks pass. The
> queued T0→T1 test proves the clock is not called while a rolling-back neighbour owns the mutex, then pins the full
> post-lock lease, exclusivity through boundary-minus-one, exact-boundary reclaim, and unconditional cleanup. Invalid
> limit coverage separately proves prevalidation does not invoke the clock.
>
> Scanner **35/35** rekeys coordinated claim callback `4b006e047c1e`→`86f06ad89cf5`, opener
> `be1a887c88a0`→`cdfba391a5f5`, maintenance edge `563137048706`→`1d2e16d25d67`, and raw UPDATE
> `2b18a1aa5bcb`→`2238677decf4`. Drain caller `eb422d5557eb`→`45ee0a84041c` remains unresolved/unproven;
> **16** downstream lines move and DEV IDs remain untouched. The applicable live `--report` gate has **0 structural,
> nested, or membership errors**; `--check` intentionally rejects the inventory's unproven records. Live totals are
> unchanged at **1,053 entries / 529 proved (436 coordinated + 93 temporal) / 524 unproven**. The pinned full gate
> passes **396 suites / 4,273 tests / 0 snapshots** under `--silent` in **246.149s**; this is functional evidence, not
> a warning-free full-run claim. Child `DB-02A-INCOMING-CLAIM-CLOCK` is **DONE**; parent `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-DEV-CLAIM-CLOCK UPDATE (2026-08-11):** The DEV-only process-death proof seam had the same stale-clock
> class as normal claiming. Its pre-queue `options.now` remains validation-only, and prepared state contains only
> payload bytes and schema version. Once its transaction owns the mutex, `clock()` is sampled exactly once as the
> callback's first statement; fresh time controls maintenance, expiry poisoning, terminal time, claim predicates,
> and lease expiry. Thus an event that expires while queued becomes a payload-cleared poison receipt, while a live
> event receives its full post-lock lease. Normal intake and claim paths are unchanged. Frozen production SHA-256
> values are `be0de7f569e2622c918e309120907552a9c489e2c754ab208f07bc870757755e` for `incomingEvents.ts` and
> `ad310194f5a612b9c890a5578206a5c3a8ef512e4c95417744f85fc153e93e15` for the dispatcher, which passes
> both its validation sample and `this.now` callback.
>
> With the source change and old tests, `incomingEvents.test.ts` compile-failed only four `TS2345` callers missing
> `clock`, while dispatcher plus drain ran **28 passing tests**. The first saved test then failed only `TS2304` because
> its existing result type was not imported; after that import, behavioral direct **44/44** passed. Frozen test
> SHA-256 is `df1aac610f1508f5e88102dbf66e9fd37388e6f1bed0e876f3a7b12e4a508f78`. Final direct **1 suite / 44
> tests**, exact incoming-events/dispatcher **2 suites / 61 tests**, and broad incoming-events/dispatcher/drain **3
> suites / 72 tests** pass warning-free; TypeScript, lint, Prettier, and diff checks pass. The two-event T0→T1 row
> queues an expiring event first and a live event second behind a rolling-back neighbour, then proves fresh-time
> expiry poison and stale-receipt pruning, a full live lease, competitor exclusion through boundary-minus-one, exact
> version-2 reclaim at the boundary, and unconditional drainage.
>
> Scanner **35/35** coordinates exactly helper opener `652d7f3eeb1f`, adopted callback `cb87d6e06595`, maintenance
> edge `f3ff85da8756`, and enqueue-body edge `d2a399dbd4a6`. Raw UPDATE `5f3d3d7c5a4e` preserves coordinated
> metadata; dispatcher caller `098d325c57da` remains unresolved/unproven. Six rekeys plus **28** line-only remaps
> produce **1,053 entries / 533 proved (440 coordinated + 93 temporal) / 520 unproven / 0 structural errors / 0
> nested coordinators / 0 membership errors**. The pinned full gate passes **396 suites / 4,274 tests / 0 snapshots**
> under `--silent` in **256.953s**; this is functional evidence, not a warning-free full-run claim. Child
> `DB-02A-DEV-CLAIM-CLOCK` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-OUTGOING-SUCCESS UPDATE (2026-08-11):** Normal real-GUID acknowledgement already owns its promotion,
> alias/ledger handover, and queue deletion in one guarded transaction; this checkpoint changes no production code.
> Frozen `outgoing.ts` SHA-256 is
> `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e`. The pre-edit baseline stopped on a
> count contradiction: direct **41/41** passed, but the exact related command was **6 suites / 97 tests**, not the
> stale expected **92**; the post-change target was corrected to **6/100** before editing. Frozen
> `outgoingBranches.test.ts` SHA-256 is
> `c00bdf013f7e98a1970e58bccc89a897705796f753201aad1de9deb309b40eb6`. Its first saved direct **44/44** passed
> without behavioral correction, followed only by mechanical Prettier. Final direct **1 suite / 44 tests** and exact
> related **6 suites / 100 tests** pass warning-free; TypeScript, lint, Prettier, and diff checks pass.
>
> A current acknowledgement waits behind a rolling-back neighbour before committing its exact handover. The revoked
> companion retires the already-queued guard, proves message/alias/ledger/queue state unchanged, and fresh-retries
> after release. The final case gates the exact `outgoingQueue` table-identity `.where().then` lifetime while the
> transaction is open and earlier promotion is visible, then releases into an exact DELETE trigger failure. The
> helper rejects, all earlier state rolls back, and the same acknowledgement succeeds after trigger removal; bounded
> polling and unconditional gate/drain/spy/trigger cleanup contain failure paths.
>
> Scanner **35/35** coordinates only callback `4093050f0f88` and opener `4184edf8f1d4` under owner
> `reconcileOutgoingSuccess`. Self-GUID delegation `9593aa17c736` and DEV/send-outcome callers `e5846ec828a7` /
> `c4f357471236` remain unresolved/unproven; inner coordinated records are unchanged. The initial read-only exact-ID
> audit script used the wrong inventory top-level key and failed before evaluating a record or changing a file; its
> corrected audit passed. Live totals are **1,053 entries / 535 proved (442 coordinated + 93 temporal) / 518 unproven
> / 0 structural errors / 0 nested coordinators / 0 membership errors**. The pinned full gate passes **396 suites /
> 4,277 tests / 0 snapshots** under `--silent` in **62.578s** (Jest printed `estimated 246 s`); this is functional
> evidence, not a warning-free full-run claim. Child `DB-02A-OUTGOING-SUCCESS` is **DONE**; parent `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-TEMP-TARGET-ACTIONS UPDATE (2026-08-11):** A source audit found that ChatScreen offered reactions plus
> long-press and swipe replies for local-only `temp-*` identities. The reaction endpoint requires a server GUID,
> replies forward `selectedMessageGuid`, and promotion/retry does not rewrite already-dependent target references;
> an action could therefore fail at the server or remain attached to an identity the target later left behind.
>
> Containment now spans all three presentation/dispatch layers. `useMessageActions` rejects temp selections before
> live or DEV reaction dispatch, long-press reply state, and swipe reply state. Frozen source/test SHA-256 values are
> `0655b88c4c13ecc5c474d6196a46e82ca178eaff23f6f7f781c70c5d9e58c1ae` and
> `44167d2ec72657ec1d3517a847ffc1fda710217a795b8b2faaf90cf5bc797f7d`; direct **1/5** and exact **2/46** pass
> warning-free. `MessageActionsOverlay` hides its entire picker, arbitrary-emoji input, and Reply for temp messages
> in fallback and anchored layouts while preserving Cancel/Remove and the other locally valid actions. Frozen
> source/test SHA-256 values are `b46def0ac6a015ff60a9fb1d2f4ce6db19976b1d4c8db2c5d0e0501e29ff00cb` and
> `a7d8fef939482b470b21932ef5203fd28ab1fbbc9876774d49de14996b9a473a`; direct **1/40** and related **4/93** pass
> warning-free. Its same-GUID/same-anchor state-switch test keeps the reset effect from masking a leaked open emoji
> input. `MessageRow` omits the right-swipe binding and glyph for every `temp-*` identity, including one already
> marked `sent`, while confirmed rows and group events retain their behavior. Frozen source/test SHA-256 values are
> `9ec3aea8217b5b7c82f51dcd453da49309db1f71b540a3665b0f1b48fd282017` and
> `a3e5824935d43d1d4e58a084170cc369ffffdeb109d096a7b36db3442cf6f9db`; direct **1/5** and related **5/94** pass
> warning-free.
>
> Hook and row checks were green on their first saves. Overlay source and test behavior also passed first; each then
> failed only its targeted Prettier check, and formatter-only layout produced the frozen files with no behavioral or
> harness correction. Full TypeScript, targeted lint, Prettier, and diff checks pass. Scanner **35/35** and live
> `--report` stay unchanged at **1,053 entries / 535 proved (442 coordinated + 93 temporal) / 518 unproven / 0
> structural errors / 0 nested coordinators / 0 membership errors**. The UI files produce no scanner members, so no
> inventory edit was made; reaction opener `53cbac0fda45` and callback `93316102c235` remain explicitly unproven for
> the later DB-owner slice. The pinned full gate passes **396 suites / 4,282 tests / 0 snapshots** under `--silent` in
> **65.276s**; this is functional evidence, not a warning-free full-run claim.
>
> Already-queued stale temp-target rows are not rewritten or recovered. Dead and uncapped `selectedMessageText`,
> arbitrary-emoji bounds, and transaction-owner proof for the reaction writer remain open. Child
> `DB-02A-TEMP-TARGET-ACTIONS` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-DISCARD-OUTGOING UPDATE (2026-08-11):** `discardOutgoingMessage` already owns its optimistic-message
> tombstone, retry-ladder deletion, durable deletion ledger, and chat-date recompute in one transaction; this
> checkpoint changes no production code. Frozen `outgoing.ts` SHA-256 is
> `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e`. Baselines were direct **44/44** and
> focused **3 suites / 71 tests**. Frozen `outgoingBranches.test.ts` SHA-256 is
> `0b1dc5d5034be3ca40d4f370d7ca4a862f6d07e82c884262306d37f613bb8967`; its first saved direct **46/46** passed
> without behavioral correction, followed only by mechanical Prettier. Final direct **1 suite / 46 tests**, focused
> **3 suites / 73 tests**, and related **6 suites / 102 tests** pass warning-free; TypeScript, lint, Prettier, and
> diff checks pass.
>
> The rolling-neighbour row proves exact state remains queued while the neighbouring phantom is visible, then proves
> that rollback precedes an independent `true` result with exact tombstone, ledger, dequeue, and chat-date effects.
> The second row gates the exact `outgoingQueue` table-identity delete and semantic final chat-date driver call. An
> exact final-chat trigger failure rolls every earlier write back, and removing the trigger lets the same discard
> retry `true`; bounded polling, unconditional gate release, promise drainage, driver restoration, and trigger cleanup
> contain failure paths.
>
> Scanner **35/35** coordinates only callback `45492546ab25` and opener `a6b1e3d1ccfc` under owner
> `discardOutgoingMessage`. Inner update `52e8602e5ddd`, queue delete `bd46b5b29f79`, and tombstone-helper edge
> `218041275c8c` retain their prior coordinated metadata; service caller `3f8f69a2103c` and reaction IDs
> `53cbac0fda45` / `93316102c235` remain unresolved/unproven. Live totals are **1,053 entries / 537 proved (444
> coordinated + 93 temporal) / 516 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> The pinned full gate passes **396 suites / 4,284 tests / 0 snapshots** under `--silent` in **62.93s** (Jest printed
> `estimated 66 s`); this is functional evidence, not a warning-free full-run claim. Child
> `DB-02A-DISCARD-OUTGOING` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ERROR-CLAIM-CLOCK UPDATE (2026-08-11):** `runErrorReportQueue` previously sampled numeric time before
> entering the process-wide DB mutex. A wait of at least the **120-second** claim lease could therefore commit an
> already-expired lease and allow foreground and background runners to POST the same privacy-sensitive report. This
> child fixes claim-lease timing only: `claimErrorReports` accepts a clock function and samples it once after
> mutex/BEGIN admission, while the service passes live `Date.now`. Frozen source SHA-256 values are
> `46d6b1960ba6dc8c115977233772e54847a0a925e146da41437ce07cd2c38bd6` for
> `src/db/repositories/errorReports.ts` and
> `9600e31a026401d4b0f7de369133aead8ce5d9d251229f194a407f15efeb9296` for
> `src/services/errors/errorReportQueueService.ts`; frozen test values are
> `90bfcac0e6b39dd696a6d5be777a4ff24194fc9b774cb679bea50dc7adb583b7` for
> `test/db/errorReportsRepo.test.ts` and
> `cc77656e48154202bafd554035e743479fcf179e4e1b6f93828de0ea8f145bbf` for
> `test/services/errorReportQueueService.test.ts`.
>
> The initial source candidate stopped on exact
> `src/db/repositories/errorReports.ts:254:5 TS1109: Expression expected`; a comma after the returned `db.all(...)`
> was the only cause, and only that punctuation was corrected. Skeptical audit then found that repo cleanup leaked
> its held neighbour under intended mutations and that no service row killed `Date.now` → `() => now`. The user
> explicitly approved expanding the slice from three to four files. The first saved expanded **2 suites / 48 tests**
> passed without behavioral correction; only mechanical Prettier followed. Final focused **2 suites / 48 tests**
> and related repository + queue-service + error-sink + transaction **4 suites / 65 tests** pass warning-free with
> zero snapshots. Full TypeScript, Prettier, ESLint `--quiet`, and diff checks exit zero. Ordinary lint retains the
> same **14** `import/first` warnings from the service test's mock-before-import setup, with no errors or new warnings.
>
> The repo and service rows prove the clock stays uncalled while queued, then pin the exact post-lock T1 + 120-second
> lease, exclusion at T1 and boundary-minus-one, and reclaim at the exact boundary. The service composition row also
> holds HTTP and proves a competing runner can neither claim nor POST; waits are bounded and cleanup is unconditional.
> Inventory reconciliation rekeys coordinated claim callback `43789dc203d7` → `0d070462cdff` (target
> `e01a0ef90b` → `259b0cdb97`) and opener `79377ea26b1d` → `7dd7d6bcc372`. Service caller `06ab2869b880` /
> callback `cf8abc3869` becomes `b93334f0174a` / callback `91b592da90` but remains
> UNASSIGNED/unreviewed/unproven; eight exact line-only remaps preserve all other metadata. Scanner **35/35** and
> live `--report` remain green at **1,053 entries / 537 proved (444 coordinated + 93 temporal) / 516 unproven / 0
> structural errors / 0 nested coordinators / 0 membership errors**.
>
> The full functional gate run alone passes **396 suites / 4,285 tests / 0 snapshots** under `--silent` in **288.348s**,
> exit zero; this is not a warning-free claim because `--silent` masks open `TEST-01` warning debt. Numeric
> list/maintenance time and failure backoff after slow failed HTTP still use invocation-time samples and remain
> follow-ups. Reaction repository/retry temp-target identity and payload bounds also remain open; the UI guard child
> did not classify reaction IDs. Child `DB-02A-ERROR-CLAIM-CLOCK` is **DONE**; parent `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ERROR-LIST-FAILURE-CLOCKS UPDATE (2026-08-11):** The remaining error-report operational clocks had
> two concrete pre-mutex defects. `listRetryableErrorReports` could clean and select using stale invocation time after
> a queue wait, retaining reports that became older than seven days or omitting retries that became due. A slow
> failed HTTP request followed by a DB wait could persist an already-elapsed failure backoff and immediately retry
> the same privacy-sensitive report. The repository list and failure APIs now accept clock functions, sample and
> validate one non-negative safe-integer timestamp after mutex/BEGIN admission, and use it throughout their owner:
> list cleanup and eligibility SELECT share one transaction/snapshot; failure UPDATE and capped-row DELETE share one
> transaction. `runErrorReportQueue` passes live `Date.now` to both. The completed claim API/lease is untouched, and
> the queue's numeric `now` argument remains upload-envelope fallback time.
>
> Frozen SHA-256 values are
> `a26471cc587d8be8d1e7043d2ad15e473c865fa9a9d934ba6d3cb59042ec8a2b` for
> `src/db/repositories/errorReports.ts`,
> `0b760061fb706cb6689ef30aefb26d575a47e999658fcf9b8f2bdcd909e87aaf` for
> `src/services/errors/errorReportQueueService.ts`,
> `9fc0c96ed3d9f3bbae9713cc0fc6bfbaa24e28122ebbc2fb9573df61057acb8f` for
> `test/db/errorReportsRepo.test.ts`, and
> `e402d5432f82f2453ecb029712370222b0b76df4798beee40cd2b8cd69bccf2a` for
> `test/services/errorReportQueueService.test.ts`. The first saved two-suite run passed the repository but failed
> `rebuilds legacy JSON/malformed...`, yielding **49/50 tests**: the service expected a sent report but received
> `undefined` because fixture `createdAt` values `1` and `2` are now correctly pruned as more than seven days old by
> live `Date.now`. Only those two fixture timestamps moved relative to local `uploadNow`; the privacy/envelope
> assertions stayed unchanged. Final focused **2 suites / 50 tests** and related repository + queue service + error
> sink + transaction **4 suites / 67 tests** pass warning-free with zero snapshots. Full TypeScript, project
> Prettier, ESLint `--quiet`, and diff checks pass; ordinary lint retains only the **14** established service-test
> `import/first` warnings, with no errors or new warnings.
>
> The test matrix proves list/failure clocks remain uncalled behind a rolling-back neighbour; T0→T1 then prunes an
> age-expired row, admits a newly retryable row, and records the exact T1 backoff. Guard rejection precedes clock
> invocation and invalid values roll back. Exact delayed-driver gates keep list trim awaited before the eligibility
> SELECT and both inside the transaction. Service rows pin live list composition and a **30,001ms** HTTP failure,
> failure-time + 30-second backoff, exclusion through boundary-minus-one, and retry at the exact boundary. All waits
> are bounded and held neighbours, HTTP promises, driver methods, clocks, and logger spies have unconditional cleanup.
>
> Scanner **35/35** newly coordinates only list opener `e417cfc06d79`, callback `8866f799b02f`, and trim edge
> `4d1cf884e6f6` under `listRetryableErrorReports`. Failure opener/callback rekeys
> `fd9901cf00e5`→`88e056c09037` and `ed0157826d4d`→`e440696b862e` retain their existing coordinated metadata.
> Service list/failure edges rekey to `f50377d16a5c` / `017639acfdf8` and remain
> UNASSIGNED/unreviewed/unproven; **21** exact line-only remaps preserve all other records. Live validation caught a
> generic line edit that briefly moved contacts record `42255f8c4337` from 84 to 94 instead of error-report record
> `d00f2ee94ed5`; an ID-bound correction restored contacts line 84 and set only the intended error-report line to 94
> before final validation. The live inventory is **1,053 entries / 540 proved (447 coordinated + 93 temporal) / 513
> unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> The full functional gate run alone passes **396 suites / 4,287 tests / 0 snapshots** under `--silent` in
> **253.246s**, exit zero; this is not a warning-free claim because `--silent` masks open `TEST-01` warning debt.
> Reaction repository/retry temp-target identity, logical payload bounds, op-sqlite/SQLCipher device evidence, the
> remaining `DB-02A` inventory, and `DB-02B`/`DB-02C` migration remain open. Child
> `DB-02A-ERROR-LIST-FAILURE-CLOCKS` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-DELETE-CHAT-IDENTITY UPDATE (2026-08-11):** `deleteChatLocal` previously resolved a chat GUID to its
> numeric id before entering the process-wide writer owner. On the one shared SQLite connection, that read could see
> a neighbouring transaction's uncommitted AUTOINCREMENT row. Rollback also rolled back the sequence; a queued insert
> could therefore reuse the same id for an unrelated chat before the delete began, causing the stale id to tombstone
> and purge the innocent replacement while GUID-keyed queue, schedule, and draft deletes targeted the vanished
> original. This was a reachable identity/data-loss defect, not scanner-only hardening.
>
> The one-production-file fix moves GUID lookup inside the outer transaction, fences its UPDATE by both id and GUID,
> and returns the exact committed `{chatId, boundary}` pair. No matching row means no decision deletes and no purge.
> Message purge remains deliberately post-commit and independently owned, with at most 500 messages per transaction;
> total chunks and duration are not claimed bounded. `src/db/repositories/chats.ts` changed from SHA-256
> `f1afe5d9f95f6a4fc605945ec677361a4b8ca5e1f6589f047a70ea77853fcf08` to
> `6a0d85413a0c9d2dedb9cf72e522c7811310e822892377f1d58a51f5447110df`. Service/account policy did not change:
> existing tracked realtime-work admission drains exact-account work before wipe/reconnect; no new commit guard or
> purge guard is claimed.
>
> The unchanged-test repository/service gate passed **2 suites / 48 tests**. The first saved four-case matrix passed
> direct **1/33** without behavioral correction. Frozen `test/db/chatActionsRepo.test.ts` SHA-256 is
> `3fb64b950fdebbc2a8c0f4b841526077223a4878958b5ee6f3d0f4850ee483a9`. Its matrix proves exact rollback plus
> AUTOINCREMENT id reuse leaves the innocent replacement unchanged; a committed delete waits behind a rolling-back
> neighbour and commits independently; an exact final-draft DELETE trigger rolls every outer decision back and starts
> no purge before the same retry succeeds; and sequential semantic gates keep chat UPDATE, outgoing delete, scheduled
> delete, draft delete, outer COMMIT, and the first independent purge chunk awaited in order. Polling is bounded and
> release, drainage, driver restoration, and trigger cleanup are unconditional. Final direct **1/33** and related
> repository + delete service + transaction **3 suites / 61 tests** pass warning-free with green TypeScript, ESLint,
> Prettier, and diff checks.
>
> The first full run passed **395/396 suites and 4,290/4,291 tests**; the only failure was the new rollback assertion,
> whose helper used `instanceof Error` across Jest realms and therefore hid the wrapped SQLite canary in an empty
> cause chain. Replacing only that helper with bounded structural `{message, cause}` traversal produced the frozen
> hash. The row then passed **8/8** filtered repetitions; `handleServiceIdentity` + `chatActionsRepo` passed **2/39**
> both cached and `--no-cache`; direct **1/33** and related **3/61** remained green. A subsequent full run printed the
> corrected chat suite and **284 passing suites**, then exited **139** without Jest totals. macOS report
> `node-2026-08-11-205421.ips` records main-thread `EXC_BAD_ACCESS`/`SIGSEGV`, `KERN_INVALID_ADDRESS` at
> `0x000000000000000e`, in
> `v8::internal::ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers` during mark-compact GC on pinned Node 24.19
> binary UUID `5cf2f254-9668-37ee-9bae-7b6f0ece16f6`. The same top frame, UUID, and address occurred earlier August
> 11 before this slice; the same frame and UUID occurred August 4. Three boundary-cluster **8/158** runs passed in
> **26.718s / 25.984s / 26.081s**. The final full functional gate run alone passes **396 suites / 4,291 tests / 0
> snapshots** under `--silent` in **61.31s**, exit zero; this is not a warning-free claim. The recurring Node/V8
> native-GC crash and possible `better-sqlite3` upgrade evaluation remain separate open `TEST-01` harness/tooling
> follow-ups, not a product-code failure.
>
> Scanner **35/35** coordinates outer opener `84e70be46f0e` and callback `a09c26040866` under `deleteChatLocal`, plus
> purge opener `63396864b914` and callback `3813b67ad498` under `purgeChatMessages`. Coordinated chat UPDATE
> `9da511d42b07` rekeys to `7f340a4cad48`; unresolved delete-to-purge edge `f3e5d12040b7` rekeys to `4b0c893b8080`
> and remains UNASSIGNED/unreviewed/unproven. Resume edge `09fe46a88daa`, service caller `e98149765f27`, and other
> callers remain unproven; raw purge DELETE `483ea7d7c766` and the outer inner deletes preserve their coordinated
> metadata. Exactly **39** line-only remaps are reconciled. The live inventory is **1,053 entries / 544 proved (451
> coordinated + 93 temporal) / 509 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> Child `DB-02A-DELETE-CHAT-IDENTITY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, `TEST-01` remains open,
> and op-sqlite/SQLCipher device evidence plus the remaining inventory and `DB-02B`/`DB-02C` migration remain open.

> **DB-02A-DELETE-MESSAGE-OWNER UPDATE (2026-08-11):** This is proof-only hardening; production did not change.
> `deleteMessageLocal` already resolves an exact GUID or retained temp→real alias inside one transaction, prefers an
> exact current GUID if namespaces overlap, removes a live temp retry row in that same commit, and awaits the
> transaction-only deletion-ledger, message-tombstone, and chat-sort primitive. Frozen
> `src/db/repositories/messages.ts` remains SHA-256
> `e5e7df49686f8253836974004fe5754017635b864fb347c5ddfd38524feff0d7`; frozen
> `test/db/messagesRepo.test.ts` is SHA-256
> `5abca799969aceb41146a817eff2434cec942cd64399aea9ff914d6ab2d73e65`.
>
> Baselines were direct **32/32** and related **5 suites / 71 tests**. The first saved three-case matrix passed direct
> **35/35**. Skeptical review found that its neighbour row used a real GUID rather than the required exact current
> temp message with a live queue entry, and hardened failure-path drainage at the same time. The in-place correction
> changed that fixture and cleanup only; post-correction direct **35/35** remained green. Final related **5 suites /
> 74 tests** passed twice, and an independent rerun passed direct **1/35** and related **5/74**, warning-free with
> zero snapshots. TypeScript, ESLint, Prettier, and diff checks pass.
>
> The matrix proves current-temp deletion and queue removal wait behind a rolling-back neighbour and commit
> independently; a queued real-GUID promotion finishes before the stale temp deletion resolves identity; and exact
> semantic gates keep the temp queue DELETE, ledger insert, message UPDATE/RETURNING, and final chat UPDATE awaited
> inside the same transaction. An exact final-chat trigger rolls every queue/message/ledger/chat fixture back before
> the same-GUID retry succeeds. Polling is bounded and outcome handling, neighbour/gate release, promise drainage,
> trigger removal, and driver restoration are unconditional.
>
> Inventory SHA-256 is `048f14159087d5ef0364879ad4b216c86019622ec79f0ecae7a5510743cb74e7`. Scanner
> **35/35** classifies only opener `b23bdb02d771` as `transaction-coordinator` and adopted callback
> `adc6c67cceea` as `withDbTransaction`, both under `deleteMessageLocal`. Existing coordinated temp-queue delete
> `fa382907379e`, transaction-only edge `7daafcdeffcd`, and all inner writes preserve their metadata; service caller
> `65ef55b84361` remains UNASSIGNED/unreviewed/unproven. Live totals are **1,053 entries / 546 proved (453
> coordinated + 93 temporal) / 507 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> The full functional gate run alone passes **396 suites / 4,294 tests / 0 snapshots** under `--silent` in **61.588s**,
> exit zero; this is not a warning-free claim. Child `DB-02A-DELETE-MESSAGE-OWNER` is **DONE**; parent `DB-02A`
> remains **IN_PROGRESS**, `TEST-01` remains open, and reaction identity, payload/device evidence, the remaining
> inventory, and `DB-02B`/`DB-02C` migration remain follow-ups.

> **DB-02A-CACHE-LEDGER-WIPE UPDATE (2026-08-11):** This is proof-only hardening; production did not change.
> `clearLocalCache` already deletes the account-private `message_deletion_ledger` in at-most-500-row
> `DELETE ... RETURNING` batches, with each batch taking its own `withDbWriteLock` queue slot. `localCacheDirty`
> already takes a later queue slot so `forget()` cannot accept a neighbouring transaction's uncommitted empty view as
> a clean old-account wipe. Frozen `src/db/repositories/maintenance.ts` remains SHA-256
> `a1665345807df9bd4912d7e8124a62c356b4ce3d4c2c7282426c9929ce6e8c19`; frozen
> `test/db/clearLocalCache.test.ts` is SHA-256
> `12657f4f840d031239806421dccc29071c7cb960662bbafac6626de37b5e7936`.
>
> Baselines were direct **26/26** and related `clearLocalCache` + `forget` + `withDbTransaction` **3 suites / 118
> tests**. The first saved candidate compile-failed at `test/db/clearLocalCache.test.ts:622` with **TS1135:
> Expression expected** because a normalized neighbour `.then(...)` ended with `});` instead of `);`; only that
> punctuation changed, after which direct **27/27** passed. The first formatting check then required only mechanical
> Prettier output. Skeptical audit found that a single ledger-driver gate allowed a mutation removing or enlarging
> `LIMIT 500` to survive by deleting all 501 fixtures at once. A separate second semantic gate now proves the exact
> **501 → 1 → 0** batch progression. Final direct **1/27** and related **3/119** pass warning-free in both the owner
> run and an independent repeat, with zero snapshots; TypeScript, ESLint, Prettier, and diff checks pass.
>
> The staged SQLite row gates the preceding alias delete, inserts a rolling-back neighbour into the queue, then gates
> both ledger deletes and the following attachment-cache delete. It proves independent rollback, queue order, the
> 500-row statement bound, adopted callback/driver lifetimes, and no early successor. The existing `localCacheDirty`
> rollback row was hardened with unconditional release/drain and proves the check remains pending behind the
> neighbour before returning dirty after rollback. All polling is bounded and every gate, neighbour, outcome, and
> driver spy is unconditionally released, drained, or restored.
>
> Inventory SHA-256 is `04f6c084423df718f80611d136d9667fd6bc4eaebef6d038153d58698044df51`.
> Scanner **35/35** coordinates exactly `25b8d31b80df` as `clearLocalCache` / `transaction-coordinator`,
> `e79ade7c65e1` and `e04a760b714e` as `clearLocalCache` / `withDbWriteLock`, and `3117ce193e0b` as
> `localCacheDirty` / `transaction-coordinator`. Bootstrap callers `80814999e829` and `972629a8899e` remain
> UNASSIGNED/unreviewed/unproven. The first broad-context inventory patch accidentally matched `rotateDbKey`
> `743c04944fee`; exact review caught and restored it before validation, and only the four authorized IDs carry the
> final evidence. Live totals are **1,053 entries / 550 proved (457 coordinated + 93 temporal) / 503 unproven / 0
> structural errors / 0 nested coordinators / 0 membership errors**.
>
> The full functional gate run alone passes **396 suites / 4,295 tests / 0 snapshots** under `--silent` in
> **62.259s**, exit zero; this is not a warning-free claim. This host proof does not bound total wipe duration or total
> rows, establish process-kill/op-sqlite/SQLCipher behavior or forensic page erasure, or approve the unresolved callers
> and remaining inventory. Child `DB-02A-CACHE-LEDGER-WIPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**,
> `TEST-01` remains open, and `DB-02B`/`DB-02C` plus device evidence remain follow-ups.

> **DB-02A-NOTIFICATION-ROUTE-CLEANUP UPDATE (2026-08-11):** This slice fixed a real boundedness defect.
> `clearNotificationRoutes` previously held the process-wide DB mutex for one prefix-wide DELETE even though stored
> FaceTime routes have no schema cap. Public APIs, production callers, and exact-key `deleteFaceTimeRoute` behavior
> are unchanged. `src/services/notifications/notificationRouting.ts` changed from SHA-256
> `88dc763e824fafbe1de2c0cc17c852f32b56ce4af9718c421f241d1cdc74d0e5` to
> `61f0561d6a409d4a66aaacbd08fe73b00dadfc678fbfe880772d45637addc292`: clear now deletes rowid-ordered batches
> of at most 500 matching KV rows with `DELETE ... RETURNING`, each inside its own `withDbTransaction`. Zero matching
> rows require one empty confirmation batch, exactly 500 require that confirmation after the full batch, and 501
> commit as 500 then 1. Failure rolls back only the current batch, so retry safely resumes after earlier committed
> cleanup. No account guard was added: account teardown has already revoked and drained admitted work, and a cleanup
> failure prevents account B from proceeding to the broader cache wipe.
>
> Baselines were direct **10/10** and related routing + Notifee service + session-scoped state + transaction **4
> suites / 89 tests**. The first saved two-case candidate passed direct **12/12** without behavioral correction.
> Skeptical review found that delayed first/second driver gates alone could survive a mutation that kept both deletes
> in one long transaction, so the clear test was strengthened in place with an exact final-row trigger. It now proves
> **501 → 1 → 0**: batch one remains committed when batch two rejects, the exact final row remains, and a same-helper
> retry removes it; post-strengthening direct **12/12** remained green. The companion exact-delete row proves
> rolling-neighbour isolation, adopted raw-driver lifetime,
> and bystander/global-key preservation. All polling is bounded and all neighbours, gates, outcomes, triggers, and
> spies are unconditionally released, drained, removed, or restored. Frozen test SHA-256 is
> `73ec0dee5284b9ff86b89fdb60c78d693eb003cbf07119666dbeb453dbc473f1`. Final direct **1/12** and related
> **4/91** pass warning-free in both owner and independent runs with zero snapshots; TypeScript, ESLint, Prettier,
> and diff checks pass.
>
> Inventory SHA-256 is `962cd88113f76b597696fb0070ffabab5047b72e4fb5f966b3c955877833601a`. Scanner **35/35** coordinates
> stable exact-delete opener `c3d03cde0a0e` and callback `ec4625bd7241`; clear callback `4d12a32d1bb3` rekeys to
> `33710a48b511`, clear opener `b2072d560d14` rekeys to `8e582f820418`, and already-coordinated raw clear DELETE
> `487cbd0a4e5e` rekeys to `f27d9c134c56`. Raw exact delete `cb58d0dd06c4` retains its prior metadata; caller edges
> `4cd9c37810a4` and `5e1eda48b4c7` remain UNASSIGNED/unreviewed/unproven. An initial generic inventory patch
> mis-targeted `maintainIncomingEvents` `3ec3e30efd66`; exact-ID review restored it before final validation. Live
> totals are **1,053 entries / 554 proved (461 coordinated + 93 temporal) / 499 unproven / 0 structural errors / 0
> nested coordinators / 0 membership errors**.
>
> The full functional gate run alone passes **396 suites / 4,297 tests / 0 snapshots** under `--silent` in
> **71.163s**, exit zero; this is not a warning-free claim. Each DB queue slot is now capped at 500 route rows, but
> total batch count/duration, op-sqlite/SQLCipher/device behavior, unresolved callers, and remaining inventory remain
> open. Child `DB-02A-NOTIFICATION-ROUTE-CLEANUP` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**,
> `TEST-01` remains open, and `DB-02B`/`DB-02C` remain follow-ups.

> **DB-02A-DB-KEY-ROTATION-OWNER UPDATE (2026-08-11):** This is proof-only hardening; production did not change.
> `src/db/key.ts` remains SHA-256
> `9d04cbc6bd67512c95dcfb2c21e1a6b125d0995de22f2ef1f65525ac922b445e`, and frozen
> `test/db/dbKeyRotation.test.ts` is SHA-256
> `a9ea8ee6a759c313e79eb14dd2bc49dd6d8915657dd754299918f6fd9ca20223`. Baselines were direct **1/6** and
> related key rotation + transaction + database-open single-flight + Settings **4 suites / 45 tests**. The first
> saved in-place strengthening passed direct **1/6** without behavioral correction; only mechanical Prettier
> formatting followed. Final direct **1/6** and the exact correct-path related **4/45** pass warning-free with green
> TypeScript, targeted ESLint, Prettier, and diff checks.
>
> Independent verification first supplied nonexistent `test/db/ensureDatabaseSingleFlight.test.ts`: Jest reported
> only `ENOENT`, while the other three suites passed **42/42**. The single corrected retry used
> `test/services/ensureDatabaseSingleFlight.test.ts` and passed the intended **4/45** warning-free. The strengthened
> row holds a predecessor lock slot, verifies that the exact 64-hex-key SQLCipher PRAGMA has not reached the shared
> connection while queued, delays that exact native PRAGMA, and queues a successor behind it. While the driver is
> held, rotation and successor remain unsettled, the primary key remains old, and the exact pending key remains
> staged. Only driver completion permits successor entry, primary promotion, and pending-key deletion. All waits are
> bounded; predecessor, driver, outcomes, and successor are unconditionally released and drained.
>
> Inventory SHA-256 is `397cafbfdb88ecdbe4752b94ecab21a9cdf1d3678a4572128c13b19e39929a35`.
> Scanner **35/35** coordinates only opener `743c04944fee` as `rotateDbKey` / `transaction-coordinator` and callback
> `b495209d9e52` as `rotateDbKey` / `withDbWriteLock`. Raw PRAGMA `3a94b1e1c97e` retains its prior coordinated
> metadata; service caller `dc60d96f0ec1` and Settings caller `ac9fcd609606` remain
> UNASSIGNED/unreviewed/unproven. Live totals are **1,053 entries / 556 proved (463 coordinated + 93 temporal) / 497
> unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> The unchanged-count full functional gate run alone passes **396 suites / 4,297 tests / 0 snapshots** under
> `--silent` in **71.79s**, exit zero; this is not a warning-free claim. The sole current Settings route awaits one
> rotation inside tracked exact-account work. Because staging has one pending-key slot, a single-flight must be added
> before any second or re-entrant production caller is introduced. Device/op-sqlite/SQLCipher proof, unresolved
> callers, remaining inventory, and primary `DB-02B`/`DB-02C` remain open. Child
> `DB-02A-DB-KEY-ROTATION-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-REMINDER-ID-MIGRATION-OWNER UPDATE (2026-08-11):** This is proof-only hardening; production did not
> change. `src/services/notifications/notificationRouting.ts` remains SHA-256
> `61f0561d6a409d4a66aaacbd08fe73b00dadfc678fbfe880772d45637addc292`, and frozen
> `test/services/notificationRouting.test.ts` is SHA-256
> `f87e5307b9eb7909fe1705769e55f2fcf10f67899c53959726d1b096cb417c20`. Both paths were pre-existing
> untracked files, so a Git diff was unavailable; the exact hashes, behavior gates, and static checks are the
> evidence. Baselines were direct **12/12** and related routing + Notifee service + session-scoped state + transaction
> **4 suites / 91 tests**. The first saved rich row passed direct **13/13** without behavioral correction; only
> mechanical Prettier formatting followed. Final direct **1/13** and exact related **4/92** pass warning-free in the
> owner and independent runs, with zero snapshots and green TypeScript, ESLint, Prettier, and diff checks.
>
> The matrix queues migration behind a rolling-back neighbour, then delays the exact old→new
> `UPDATE ... RETURNING` driver and proves the transaction open, migration unsettled, old id intact, new id absent,
> and a synchronously queued successor excluded. Driver release produces exact `true` and one durable new id. A
> second old→new call proves the no-match UPDATE uses the fallback SELECT and returns `true`; missing-old→missing-new
> returns `false`. The revoked-account row now uses immediate normalized outcomes and unconditional neighbour/work
> drainage while proving the queued guard rejects without changing either id. Every wait is bounded and the semantic
> driver spy is restored only after started work drains.
>
> Inventory SHA-256 is `130b6ea30d5d71a4ed76aeeeae014f25f2a91e374812d3e1df5d79883fdfaa72`.
> Scanner **35/35** coordinates only callback `44918d382fdf` as `migrateReminderNotificationId` /
> `withDbTransaction` and opener `7ac9ad737605` as the same owner / `transaction-coordinator`. Raw UPDATE
> `d6c50c44f83d` retains its prior coordinated metadata. Notifee callers `fc0ca0b8b11a` and `f8804eee4845`, plus
> recognition-ready but separate DbEventSink opener `89d7a5f4910f`, remain UNASSIGNED/unreviewed/unproven. Live
> totals are **1,053 entries / 558 proved (465 coordinated + 93 temporal) / 495 unproven / 0 structural errors / 0
> nested coordinators / 0 membership errors**.
>
> The full functional gate run alone passes **396 suites / 4,298 tests / 0 snapshots** under `--silent` in
> **63.402s**, exit zero; this is not a warning-free claim. `reminders.notification_id` is neither unique nor
> schema-capped, so the fixed-statement proof is not a hard one-row-cardinality claim. Device evidence, unresolved
> callers, remaining inventory, and primary `DB-02B`/`DB-02C` remain open. Child
> `DB-02A-REMINDER-ID-MIGRATION-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains
> open.

> **DB-02A-DB-EVENT-SINK-OWNER UPDATE (2026-08-11):** This is inventory-only recognition from existing mutation
> evidence; production and tests did not change. `src/services/realtime/dbEventSink.ts` remains SHA-256
> `9fedccb993886538bf81122ffe296a8068f140bd5fba2a94c15a0b960402ea25`, and direct
> `test/services/dbEventSink.test.ts` remains SHA-256
> `74cc77cd43ccb0c9b9baf1d0f11e4b16d517e233399171e7eaebcb23d26f6124`. Direct **1 suite / 24 tests** and exact
> related sink + phase-6 + incoming-drain + transaction **4 suites / 47 tests** pass warning-free with zero snapshots
> under pinned Node 24.19.0.
>
> Existing evidence mutation-pins the common owner. A rolling-back neighbour proves sink writes do not join another
> transaction. The five-branch revocation table proves pre-task routing and account-guard rejection; a separate
> new-message commit-handoff row executes writes before the final guard and proves `return await`, stale-rejection
> translation, and rollback. Durable-checkpoint failures prove the domain mutation and incoming receipt roll back
> together. Scanner callback-lifetime fixtures and transaction tests reject detached, escaped, or nested variants.
> The neighbour rejection is attached synchronously and its gate is released before later assertions, leaving no
> queued cleanup in the relevant mutation set. Only the commit-handoff case is post-task rollback evidence; this does
> not overstate the five early-revocation branches.
>
> Inventory SHA-256 is `267d259ae85013e595f10b04549eb0c3fac34ad7ad15982199ff35a50fffaf48`.
> Scanner **35/35** coordinates only
> `src/services/realtime/dbEventSink.ts#withCurrentDeliveryTransaction:mutator-call:89d7a5f4910f` under owner
> `withCurrentDeliveryTransaction` / `transaction-coordinator`. All other 19 sink entries keep their prior
> `DbEventSink.onEvent` coordinated metadata; upstream/dynamic callers remain excluded. The first generic inventory
> patch matched `maintainIncomingEvents` `3ec3e30efd66`; exact-ID audit caught and restored it before validation.
> Reversing only the authorized four fields reproduces prior inventory SHA-256
> `130b6ea30d5d71a4ed76aeeeae014f25f2a91e374812d3e1df5d79883fdfaa72`, proving exact restoration and a
> target-only final delta. Live totals are **1,053 entries / 559 proved (466 coordinated + 93 temporal) / 494
> unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> No full Jest rerun followed the inventory/docs-only change. The preceding full functional gate remains current at
> **396 suites / 4,298 tests / 0 snapshots** under `--silent` in **63.402s**, exit zero; this reuses the reminder
> checkpoint and is not a warning-free claim. Message attachment arrays and group chat/participant wire arrays remain
> without schema caps, so this proves coordination and account-lifetime ownership, not absolute callback boundedness.
> Device evidence, unresolved callers, remaining inventory, and primary `DB-02B`/`DB-02C` remain open. Child
> `DB-02A-DB-EVENT-SINK-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-REACTION-PAYLOAD-PRIVACY UPDATE (2026-08-12):** This child removes a redundant durable copy of the
> selected message's potentially large/private body from reaction retry JSON and proves the reaction insert's common
> transaction owner. `insertOutgoingReaction` still accepts the optional compatibility input, but new queue rows
> persist only target GUID, reaction, and optional emoji; the optimistic message row and resend contract are unchanged.
> Migration `0038_scrub_reaction_selected_message_text` transactionally removes the obsolete key from canonical valid
> legacy reaction JSON while preserving absent-key reactions, other queue kinds, and malformed payloads byte-for-byte.
> Its lazy `CASE` avoids applying JSON path functions to malformed JSON, and the merge-time registry records exact
> migration and named upgrade-test evidence.
>
> Frozen SHA-256 values are: `src/db/repositories/outgoing.ts`
> `71201e10470e9b56802ee99220b4eb77b7f4454f13fcbf786c45cb0a108cf0e9`; `src/db/migrations.ts`
> `92db1a9a5df155f2636650211d8bdcaa74bd362642b5dee9db8e6800a1658831`; `scripts/migration-registry.json`
> `c51544f1adcb18f9c1966335f25047172ecfd917e8a6b03dcb928f41145734e7`; `test/db/outgoingBranches.test.ts`
> `c4803e01763db8db033293a1f78103c6edc027805e6b7c826a20226a41f20896`; and
> `test/db/migrations/0038_scrub_reaction_selected_message_text.test.ts`
> `ba911e787e1b5ffd9453902036630d7de419fba1b1d43a0dca7e48b6428a3e9b`. The earliest narrow design omitted legacy
> cleanup. Once migration `0038` was added, the first expanded four-file scope still omitted the required allocation
> registry; work stopped at that contradiction, and the user approved the final five-file scope.
>
> Two preflight environment failures were separated from product evidence. Ambient Node 26.5.0 expected ABI 147 while
> the existing `better-sqlite3` build exposed ABI 137, so **4 suites / 57 tests** failed before behavior; pinned Node
> 24.19.0 passed the same **4/57** baseline. Separately, one shell wrapper stopped before Jest because
> `/Users/munkle/.nvm/nvm.sh` was absent; the cached Node 24 binary then passed direct **1/46**. The first saved expanded
> tests passed **2 suites / 49 tests / 0 snapshots** before any behavioral correction; only mechanical Prettier
> followed. Final focused **2/49** and exact related reaction **6/62** pass warning-free. TypeScript, targeted
> zero-error lint, Prettier, diff checks, the **38/head 0038** migration guard, and its **5/5** unit tests pass.
>
> Mutation evidence is non-vacuous: a rolling-back predecessor keeps the helper and both exact rows pending; semantic
> table-identity gates prove queue-insert → message-insert await order; the exact second-insert trigger rejects and
> rolls the first insert back before same-input retry; and a 4 KiB private sentinel is absent from exact durable JSON
> while target, reaction, and emoji survive. The upgrade row sees the scrub inside the migration transaction, forces
> migration-record insertion to fail, proves payload and marker rollback, then proves retry and idempotency. Canonical,
> null, empty, absent-key, non-reaction, and malformed cases are pinned. Rejections are attached immediately and all
> predecessor, driver, trigger, and spy cleanup is bounded and unconditional.
>
> The first complete `--silent` attempt exited **139** without Jest totals after both new suites passed. Its only new
> macOS report (`node-2026-08-12-001904.ips`) is the outer Homebrew Node 26/npx launcher forwarding SIGSEGV through
> `__kill` → `uv_kill` → `node::Kill`, not the older pinned Node 24 V8 mark-compact invalid-address signature. One
> bounded retry bypassed npx and used the cached exact Node 24.19.0 binary; it passes **397 suites / 4,301 tests / 0
> snapshots** under `--silent` in **181.985s**, exit zero. This is functional evidence, not a warning-free claim, and
> the native-runtime instability remains an open `TEST-01` harness follow-up rather than a product failure.
>
> Inventory SHA-256 is `96ae3da4574565588ce2bb7332e82a429c045b35956454a40520466ce445158b`.
> Scanner **35/35** rekeys reaction opener `53cbac0fda45` → `86b1d6a504a7` (`transaction-coordinator`) and callback
> `93316102c235` → `a848c92353ac` (`withDbTransaction`) under owner `insertOutgoingReaction`; migration write
> `a6a11f9eb292` is the one new startup temporal exclusion. Existing inner inserts `db1a559ab2f4` / `bc47389eaa50`
> retain coordinated metadata, 55 exact findings receive line-only remaps, and service/DEV callers `adb0857a9956` /
> `3990f707da46` remain unresolved/unproven. A first combined inventory patch rejected atomically on an exact migration
> anchor; split exact-ID patches then passed exact exclusion audits. Live totals are **1,054 entries / 562 proved (468
> coordinated + 94 temporal) / 492 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> The one-time UPDATE is not row/WAL bounded. `json_remove` removes only the first duplicate object key, so hostile or
> corrupt duplicate-key JSON is outside the canonical app-produced legacy guarantee. The ignored compatibility text
> still crosses JavaScript memory; already-queued stale temp-target identities are not repaired; reaction/emoji and
> other logical strings remain uncapped; caller ownership and exact op-sqlite/SQLCipher device evidence remain open.
> Child `DB-02A-REACTION-PAYLOAD-PRIVACY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`,
> `DB-02B`, `DB-02C`, and release-device proof remain open.

> **DB-02A-SEARCH-TEXT-BACKFILL-OWNER UPDATE (2026-08-12):** This child closes a real shared-connection race in
> `runSearchTextBackfillPass`. The preliminary page SELECT intentionally runs outside the global write mutex and could
> observe another transaction's uncommitted message eligibility. If that neighbour rolled back, the old pass could
> advance beyond the restored row and persist the completion marker, leaving the message permanently without searchable
> text. The deterministic reproduction temporarily hides the sole decodable row while exposing 50 undecodable rows;
> rollback restores the missed row only after the dirty page has been selected.
>
> Every nonempty page is now re-read with the identical cursor and **LIMIT 50** inside the existing tracked,
> account-guarded transaction. The exact ordered `{id, attributed_body}` page must match before the CASE update runs.
> Membership, ordering, eligibility, or body drift causes no message write and retries the same cursor; it cannot
> advance or mark completion. Zero-decode pages receive the same validation. Preliminary read/decoding stays outside
> the mutex, while each guarded owner remains DB-only and row-bounded to one revalidation SELECT plus at most one
> 50-row UPDATE.
>
> Frozen SHA-256 values are `src/services/databaseControl.ts`
> `82da12422f64349fb6638577329f42c601209252733f0959942cc0e034e75186` and
> `test/services/searchTextBackfillOwner.test.ts`
> `aa8aa18d080a17b11fe6dfec1dc17904163be318407aec60a363dc33981b5b20`. The unchanged mocked suite passed **10/10**
> before and after the source change. The first saved real-DB suite passed **1 suite / 3 tests / 0 snapshots**; its
> three expected recovery logs were then suppressed locally. The first static pass found only an unused type import,
> an unused polling helper, and Prettier layout, all corrected mechanically. Skeptical review made the 50 visible dirty
> rows all undecodable and replaced a trigger-only failure with an in-owner source mutation that yields a real one-of-two
> CASE update. The test sees the partial text/body changes inside the open transaction, then proves both roll back on the
> exact row-count mismatch before same-input retry and queued-successor release.
>
> Final direct **1/3** and exact related search/boot/transaction **4 suites / 30 tests / 0 snapshots** pass
> warning-free. TypeScript, targeted zero-error ESLint, Prettier, and diff checks pass. The complete functional gate,
> run alone with the cached exact Node 24.19.0 binary, passes **398 suites / 4,304 tests / 0 snapshots** under `--silent`
> in **101.4s**, exit zero. This is functional evidence, not a warning-free claim. The three real-DB rows prove dirty
> zero-decode retry, statement-local row-count rollback and queue release, and queued stale-account rejection before
> BEGIN followed by fresh-generation success. Source-controlled waits are bounded, failures are observed immediately,
> and every gate, neighbour, successor, and raw handle is unconditionally released or drained.
>
> Inventory SHA-256 is `b8abfe1d85d1142f326ba728eb21774225ba8fe79dfeb639e19ad85fe8942d6f`.
> Scanner **35/35** rekeys opener `29cdf96d6d18` → `6da3cbf440f3` (`transaction-coordinator`), callback
> `eac896a9ceb7` → `6d998498b99c` (`withDbTransaction`), and update edge `b448c444999c` → `0346bc63b66f`
> (`withDbTransaction`) under owner `runSearchTextBackfillPass`. Raw helper `b00dbabd5a56` remains
> UNASSIGNED/unreviewed/unproven; the three `tryFinish` records preserve their prior metadata with line shifts, and
> production callers remain outside this recognition. Live totals are **1,054 entries / 565 proved** (**471
> coordinated + 94 temporal**) / **489 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> A direct host op-sqlite probe stopped before SQL with `ERR_MODULE_NOT_FOUND .../node/dist/database` because the
> package's Node ESM bundle uses an extensionless internal import; exact op-sqlite/SQLCipher device execution remains
> open. The page is bounded by rows, not absolute bytes or time: `attributed_body` is uncapped and a full history may
> require unbounded short passes. Separately, failed optimistic edit recovery can restore an older empty `text`
> snapshot after the cursor has passed; that adjacent writer/revert contract remains a distinct source follow-up.
> Child `DB-02A-SEARCH-TEXT-BACKFILL-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`,
> remaining inventory, `DB-02B`, `DB-02C`, and release-device proof remain open.

> **DB-02A-OPTIMISTIC-EDIT-SAFETY UPDATE (2026-08-12):** This child closes three related edit-failure hazards. The
> old service read a restore snapshot outside the process-wide DB mutex, so it could observe a neighbour's uncommitted
> text and later make that rolled-back value durable. Empty/null legacy text reverted to `''` even when the exact rich
> body contained the original searchable text, leaving neither original nor optimistic terms in FTS after backfill was
> already marked complete. Concurrent edits of one message also had no full-lifecycle ordering, so two failures could
> strand an optimistic value. That exact clean initial empty-text row is UI-gated because Edit requires a truthy
> selected text; the production-reachable defects were the pre-lock dirty/stale snapshot and overlapping same-message
> lifecycles, while the fallback closes the adjacent recovery gap.
>
> `applyLocalEdit` now snapshots committed text, exact `attributed_body`, prior edit marker, and chat identity and
> applies optimistic text in one short DB-only transaction. It clears the rich body while the optimistic value is live,
> because rendering prefers it over `text`. After commit and outside the mutex, empty/null stored text uses decoded text
> from the exact captured body when available and otherwise preserves the original null-versus-empty state. Failure
> restores effective searchable text, the byte-exact body, and the prior marker only while marker, optimistic text, and
> cleared-body state still match. Thus an authoritative echo with differing text or a restored rich body wins. Missing
> rows do not POST, missing chat identity is compensated before returning, and unsend is unchanged.
>
> The complete edit lifecycle is admitted synchronously to an in-memory queue keyed by captured
> `(AppDatabase, messageGuid)`, while HTTP remains outside every DB transaction. Rejected DB work cannot poison later
> edits; cleanup requires the original key and exact tail identity; three overlapping edits stay ordered; caller object
> mutation cannot redirect cleanup; and the same GUID on another DB proceeds independently. The existing
> `runUiAccountOperation` adoption keeps admitted edits inside account teardown/drain.
>
> Frozen SHA-256 values are `src/db/repositories/messages.ts`
> `ee03a76da17479d2bb7bea5e8ef88d9b2808257a3da246e5a725debe891f0120`,
> `src/services/send/sendEditService.ts`
> `ac5b15cc7ce755433a87b317dad993de4096698fddae4e43223d34d86623a510`, and
> `test/services/sendEditService.test.ts`
> `f0dd369e4611ea51ccb24d745e40335f3344c883fd2e8b3d29505cc27bb61b2a`. The pinned unchanged baseline passed **6
> suites / 45 tests / 0 snapshots**; the first saved direct candidate passed **1/12**. Skeptical review then hardened
> HTTP observations that the service catch could swallow, mutation-safe cleanup, decoding outside the mutex, mutable
> key capture, three-flight tail identity, cross-DB independence, missing-row behavior, and both revert-CAS dimensions.
> A final reread found undecodable rich bodies could normalize prior NULL to empty. Its first regression-test scaffold
> failed TypeScript before tests because it omitted `await createTestDb()` and named unavailable helpers; correction used
> the file's existing async DB/HTTP fixtures, then parameterized the same row over NULL and empty to pin both states.
> Final direct **1/13**, independent exact **7/60**, and root related **8 suites / 65 tests / 0 snapshots** pass. Full
> TypeScript, targeted zero-error ESLint, Prettier, and diff checks pass.
>
> The complete functional gate, run alone with the cached exact Node 24.19.0 binary, passes **398 suites / 4,308 tests
> / 0 snapshots** under `--silent` in **180.443s**, exit zero. This is functional evidence, not a warning-free claim.
> Scanner **35/35** and inventory SHA-256
> `d155fd213bfd8f44619d952432519321417dcc9011ca95088d881341aebb3f46` record **1,055 entries / 565 proved (471
> coordinated + 94 temporal) / 490 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> Six already-coordinated apply/revert records were rekeyed to the final source. Service edges remain deliberately
> unproven: three rekeyed and two new concrete edges replace the former upstream edge, yielding one net new finding.
> The JavaScript `WeakMap`/`Map` queue operations are not database writes and correctly do not enter the inventory.
>
> One representation limit remains honest: an authoritative echo with the identical marker, identical text, and null
> rich body is indistinguishable from the optimistic row without a durable server revision or attempt token. Message
> upsert rich-body refresh, crash recovery between optimistic apply and revert, exact op-sqlite/SQLCipher device proof,
> remaining inventory, `DB-02B`, and `DB-02C` remain open. Child `DB-02A-OPTIMISTIC-EDIT-SAFETY` is **DONE**; parent
> `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-OPTIMISTIC-UNSEND-SAFETY UPDATE (2026-08-12):** Unsend now snapshots committed message/chat identity
> and the exact prior retraction marker inside the same short transaction that applies the optimistic retraction.
> Failure restores that exact predecessor only while this attempt still owns the marker; missing rows never POST.
> Edits and unsends share one synchronous per-database/message lifecycle queue outside SQLite, preventing overlapping
> restores while allowing unrelated database work and the same GUID on another account database to proceed. Rejected
> tails release successors, captured keys resist caller mutation, and a differently stamped server echo remains
> retracted after a lost response.
>
> Frozen source/service/repository-test/service-test/inventory SHA-256 values are
> `ac74c658c8b155908a83b8ebeb1f1a5f619670c2ab8f9d0b320ef1cca781ecf1`,
> `268e3e95bcb0d69729fda8b4a2eded035077cd2250265eaddccc944454f54a96`,
> `887373e1fdd473aa3eb40f77652dc0702c6b913558b435afffa6166fc15c470e`,
> `c2cb1a31b53aff6df595c8c3bf0536d772ef31fab64fd1ed31b16d732244fbea`, and
> `0b5d7ae2f0956711d85eccaf3af49e4dca94e0b927b54e37f975a159dae0b6bb`. The first current direct run passed
> **25/26** after exposing one stale acknowledgement fixture. The first saved new-test attempt then exposed a typed
> `Outcome` mismatch and a test expecting `messageGuid` in a wire body that deliberately omits it; both tests were
> corrected before final claims. Final direct **2 suites / 29 tests** and related **9 suites / 103 tests** pass. Full
> TypeScript, targeted zero-error ESLint, Prettier, diff checks, and scanner **35/35** pass.
>
> The complete functional gate passes **398 suites / 4,311 tests / 0 snapshots** under `--silent` in **241.992s**,
> exit zero; this is functional evidence, not a warning-free claim. Inventory is **1,056 entries / 565 proved (471
> coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> A same-marker server echo still needs a durable revision/attempt token; the aggregate in-memory queue is uncapped and
> an HTTP request can occupy its per-message slot for 30 seconds. Crash recovery, exact-device proof, remaining
> inventory, `DB-02B`, and `DB-02C` remain open. Child `DB-02A-OPTIMISTIC-UNSEND-SAFETY` is **DONE**; parent `DB-02A`
> remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-MESSAGE-RICH-BODY-REFRESH UPDATE (2026-08-12):** Message ingestion previously refreshed decoded `text`
> but did not refresh an existing `attributed_body`. MessageBubble prefers the rich body, so a genuine server edit could
> be searchable under its new wording while rendering the old wording. A present non-null incoming rich body now
> replaces the stored body. A strictly newer dated edit carrying nonempty plain text and no rich body clears the stale
> rich source. Null or omitted bodies, undated receipt-shaped updates, and equal-marker lean duplicates preserve the
> stored body; a rich projection arriving at that same marker can restore it.
>
> Frozen SHA-256 values are `src/db/repositories/messages.ts`
> `5e4d42adcc58ae7f40536675e6207c68998dd7eef309d1e8911b3a6b6f62fc8d`,
> `test/db/messagesRepo.test.ts` `098fb0d95a73349babe2b012194ef526f50761604f481bff0b88acee3248a7ae`,
> `test/services/dbEventSink.test.ts` `3109197587ec0787f9e97a2a4e2f8ede212cbfff855a4c08ef4907fca219a3ec`, and
> inventory `2e30de6a3e7bbacbaacefcbde1d4c779ea9cd770183d64a0146d5fbcfcef9188`. The adjacent comment-only accuracy
> update in `test/services/sendEditService.test.ts` is frozen at
> `e8e28c76f2961d1fa369bd91d628f9942652e25d46d3c2d59f9b7d956f0f9aa5` and changes no behavior or test count.
> Focused **2 suites / 60 tests / 0 snapshots** and exact related **9 suites / 135 tests / 0 snapshots** pass under
> pinned Node 24.19.0. Full TypeScript, targeted zero-error ESLint, Prettier, and diff checks pass.
>
> Mutation evidence forces a post-message attachment failure, proves exact rich-body/text/edit-marker and FTS rollback,
> and then proves same-input retry replaces the byte-exact body and swaps old/new search hits. It separately pins the
> strictly-newer nonempty plain clear; preservation for newer marker-only, equal-marker explicit-null, and undated
> omitted-body projections; same-marker rich restoration; and the production chats-less `updated-message` path followed
> by a lean FCM duplicate. Cleanup is unconditional and DB handles close after settlement.
>
> The complete functional gate passes **398 suites / 4,312 tests / 0 snapshots** under `--silent` in **246.733s**,
> exit zero; this is functional evidence, not a warning-free claim. Inventory remains **1,056 entries / 565 proved
> (471 coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> Equal-millisecond plain-versus-rich authority remains indistinguishable without a durable revision. A stale present
> rich payload still needs an ordering fence. Crash/device proof, remaining inventory, `DB-02B`, and `DB-02C` remain
> open. Child `DB-02A-MESSAGE-RICH-BODY-REFRESH` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
> remains open.

> **DB-02A-OUTGOING-CHAT-IDENTITY UPDATE (2026-08-12):** Text, contact, reaction, and attachment sends used to
> resolve a local numeric chat id before their optimistic-insert transaction owned the shared SQLite connection. That
> read could retain a neighbouring transaction's uncommitted id. SQLite reproduction confirmed rollback also restores
> the AUTOINCREMENT sequence, so an unrelated chat can later reuse that exact integer while queue/network state still
> names the requested GUID. A temporarily absent target could instead reject a valid send.
>
> One fixed-copy transaction-only resolver now resolves GUID to id inside each existing short owner. Production services
> omit the preliminary read and legacy `chatId` inputs are ignored. Scheduled text invokes the resolver through its
> existing transaction-only text primitive, keeping schedule transition, lookup, message, and queue in one non-nested
> commit. Missing committed chats fail with `unknown chat` before network work.
>
> Frozen SHA-256 values are `src/db/repositories/chats.ts`
> `a2b58a5012e98ee3e058cd9c1e025630fd6399a914642c2ae1bf8f30764d2f52`,
> `src/db/repositories/outgoing.ts` `ecbe23d61f0ead7e2c5eecea6e0321543d78a6c531b45a47b289ce1374254289`,
> `src/db/repositories/attachments.ts` `14b0d58eed83120de1585ded19cbe0947b7d4f18cd79cb713e0c6b25f1e05062`,
> `src/services/send/sendService.ts` `74448675b4a6ce56e9a9b5a5f6e3d6ff469219c5d496f0b62219a7a3d08072d7`,
> `src/services/send/sendContactService.ts` `690f0a18760b2985d5604351ef82f4e21b89e7c6f45977c03b0b3ff58845f5d3`,
> `src/services/send/sendReactionService.ts` `8cabc2cf7dff8cca5da5507360d410ab8fb5084122a50a45419b1e6609b38b40`,
> `src/services/send/sendAttachmentService.ts`
> `5ae53670dc19c21e72124d56a1b45c75844d65798e71caccceb7abf144f9626d`,
> `test/services/sendChatIdentity.test.ts` `9b2f10311af7d48b21fe7200ddc4a7eaf29216a723f44d52aa5899f1dbcc02a1`,
> `test/services/sendQueueHandover.test.ts`
> `a6bcbce7f6de7e4cd1dd7ce9d3248d45ed0cf6ace53ca3e60057ffb3a0321974`,
> `scripts/check-scheduled-recovery.mjs` `9339101802de2ae06f1d4e5efa32f26cc377a5682c50ae1c62f63d44e474948a`,
> and inventory
> `b13e9f2f4fc9cacf2fba0af2bbc2c9707098c115920f7c2ad0829970497257ea`.
>
> The four-kind real-DB matrix holds a rolling-back deletion, proving sends stay pending with no residue or network until
> release and every semantic chat lookup sees `raw.inTransaction === true`. At network start the durable message-chat,
> queue-chat, and wire GUID agree; an unrelated transaction commits while HTTP/upload remains held, proving network is
> outside the mutex. Committed misses leave zero residue/network, lookup and insert cannot become separate queue owners,
> and scheduled handoff stays one owner without nesting.
>
> The first optional attachment signature broke an old `Parameters<>` fixture. A compatibility overload restored
> compilation but hid two scanner edges; the final single optional/ignored signature plus explicit legacy fixture typing
> keeps compiler and scanner honest. The first related run exposed one stale scheduled fixture that waited for the
> removed pre-read; it now revokes on the semantic in-owner chat SELECT and proves commit-guard rollback. This was a test
> correction, not a production rollback.
>
> The late architecture gate correctly rejected the stale reviewed `sendTextMessage` AST fingerprint. One expected-value
> line moved from old `f283…` to current `381fed…`; checker logic and tests did not change. Architecture **30/30** and
> its live core/scheduled guards pass under the final script hash above.
>
> Direct **6 suites / 48 tests / 0 snapshots**, related **8 suites / 117 tests / 0 snapshots**, and correction **3 suites
> / 45 tests / 0 snapshots** pass under pinned Node 24.19.0. TypeScript, earlier targeted zero-error ESLint, formatting,
> diff, architecture, and scanner **35/35** pass. A final standalone ESLint invocation could not start because the
> existing configuration could not resolve `@typescript-eslint`; it produced no additional code-lint result. The
> complete functional gate passes **399 suites / 4,322 tests / 0 snapshots** under `--silent` in **239.62s**, exit zero;
> this is functional evidence, not a warning-free claim. Inventory remains **1,056 entries / 565 proved (471
> coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
> The ignored legacy id field and construction-time transaction typing remain cleanup for `DB-02B`; exact native-driver,
> process-death, device, and remaining-inventory proof stay open. Child `DB-02A-OUTGOING-CHAT-IDENTITY` is **DONE**;
> parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-QUERY-MESSAGE-PROJECTION UPDATE (2026-08-12):** Incremental sync's `POST /message/query` previously kept
> a private inline projection while chat history used the shared `SYNC_WITH_QUERY`. It now sends the same exact ordered
> seven tokens: `chats`, `chats.participants`, `handle`, `attachments`, `attributedBody`, `messageSummaryInfo`, and
> `payloadData`. Attachment, rich-body, edit/retraction-summary, and rich-link requests are therefore consistent between
> incremental pages and chat history; limits, timestamp/row-id cursors, ascending order, wrapper parsing, persistence,
> and transaction ownership are unchanged.
>
> Current bbd selects `messageSummaryInfo` and `payloadData` by token presence, so the previous omissions kept that
> metadata out of incremental responses. It accepts singular `attachment` and plural `attachments` today; the canonical
> shared plural spelling is a compatibility and future-projection parity fix, not a claim that current bbd necessarily
> omitted attachments. One shared constant also carries future projection additions to both client endpoints.
>
> Frozen SHA-256 values are `src/core/api/endpoints/messages.ts`
> `7df15017f22569df1a710b3b1b515a14bc13f7b4f8adeb1e0d6a8e43ea40fcfc`,
> `test/contract/endpointShapes.test.ts` `116521da7c98c661d0260f52cb15b0346b38b134138316cca3671f93b3aeae05`,
> `src/core/config/constants.ts` `5f27965b0b3237a2c95f44a7f0fef6e6ab0c65e7772eb79e4d37c0b4f74a1bc0`,
> and byte-unchanged inventory
> `b13e9f2f4fc9cacf2fba0af2bbc2c9707098c115920f7c2ad0829970497257ea`. The contract pins the seven tokens literally,
> then spies on the exact shared constant's `join(',')` call while checking the complete request. That rejects both
> self-referential expectation and endpoint-hardcode survivors. Response checks prove edited parts, retracted parts, and
> rich-link-title model parsing.
>
> Final direct **2 suites / 29 tests** pass in **2.773s**, and related **6 suites / 78 tests** pass in **4.13s** under
> pinned Node 24.19.0. TypeScript, targeted zero-error ESLint, Prettier, diff, architecture **30/30**, scanner **35/35**,
> and migrations **5/5** pass. The complete functional gate passes **399 suites / 4,322 tests / 0 snapshots** under
> `--silent` in **62.661s**, exit zero; this is functional evidence, not a warning-free claim. Inventory remains **1,056
> entries / 565 proved (471 coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0
> membership errors**.
>
> This client contract does not prove a deployed server or Android device returns the requested metadata. Pages remain
> capped at 250 messages and HTTP JSON at 16 MiB, but nested attachment, edit-history, and payload arrays have no separate
> item-count schema cap. No durable revision fence was added: equal-millisecond plain-versus-rich authority and stale
> present-body ordering remain open. Crash/device proof, remaining inventory, `DB-02B`, and `DB-02C` remain open. Child
> `DB-02A-QUERY-MESSAGE-PROJECTION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-RESERVATION-OWNER UPDATE (2026-08-12):** Production attachment-cache admission
> previously reached its reservation INSERT through an injected `scope.runTransaction` method. The production scope
> did serialize that call, but the coordinator did not expose the owner at the write site, so exact scanner recognition
> depended on a dynamic method boundary and the interface could regress to a transaction-neutral task runner without a
> source-local guard.
>
> Reservation scope now separates account-teardown lifetime from database ownership. Its required `runTracked` adopts
> only the short task into the captured account drain; `AttachmentCacheCoordinator` directly opens one guarded
> `withDbTransaction` around `createAttachmentCacheReservation`. Losing the queued account generation maps to `stale`.
> A successful INSERT commits before the reservation is returned and before native download starts; native transfer
> remains outside the database mutex, and the existing promotion transaction still commits verified bytes with reactive
> `localPath` atomically.
>
> Two production-composition real-SQLite tests hold a rolling-back predecessor immediately before reservation creation.
> The first keeps `download()` and its native fetch pending with no target ledger row, then observes the durable
> `reserved` row and `raw.inTransaction === false` at native start before the final active-ledger/attachment commit. The
> second retires that queued account generation, proves no reservation, attachment path, or native effect survives, and
> proves a fresh generation can reserve and download the same attachment. All waits are bounded and every neighbour,
> pause, download, spy, and raw handle is released or drained unconditionally.
>
> The first saved direct run exposed both new cases returning `null` because the native free-space mock deliberately
> defaults to zero; the fixture was corrected to return safe space. The first broader focused run then stopped at
> `TS2322` because the coordinator suite's old synthetic account scope lacked required `runTracked`; adding the
> transaction-neutral tracked-task method was a mechanical fixture correction. The combined retry next exposed an
> insufficient safe-space mock sequence, so a third explicit safe-space result was added for the fresh generation.
> These were test-fixture corrections, not production rollbacks.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheCoordinator.ts`
> `1a1e12e93cbcf19a3a015b06beb1eff4fc04cc8675d2d6d5c946ed8f6ffa2433`,
> `src/services/download/index.ts` `845ea46e25385d93c4bd45f6b7f9a372a195d53ef794a1a8b84a35154f09fb05`,
> `test/services/downloadAccountScope.test.ts`
> `61cc7313bc8d5166fa278c043cbc0f176c0037bc26d4704ed169df9952fb9530`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `f25102103f1a06b4f398f7a86869e98bac14a6ca7f9b86c2e2014d98f065bfad`, and inventory
> `c1ef0d24c6b064038ab45257f055169eba36d59883f52b36f2c68300ef214aa7`.
>
> Final direct **1 suite / 16 tests / 0 snapshots** and focused **5 suites / 128 tests / 0 snapshots** pass under pinned
> Node 24.19.0. The complete functional gate passes **399 suites / 4,324 tests / 0 snapshots** under `--silent` in
> **99.924s**, exit zero; this is functional evidence, not a warning-free claim. TypeScript, targeted zero-error ESLint,
> Prettier, diff, architecture **30/30** plus its live 65-file core boundary and scheduled reset/claim/handoff guards,
> migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Initial npm-wrapper guard commands failed before
> execution with `MODULE_NOT_FOUND` for `node_modules/npm/bin/npm-cli.js`; direct pinned-Node guard commands passed, so
> this was a tool-invocation failure rather than a product or guard failure. Inventory is **1,059 entries / 568 proved
> (474 coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**.
>
> This child closes only the production new-reservation INSERT boundary. Cache reuse, retirement, recovery, and the
> unscoped fallback retain separate inventory dispositions. Aggregate cache lifecycle, exact op-sqlite/SQLCipher,
> process-kill, physical-device, remaining-inventory, `DB-02B`, and `DB-02C` proof remain open. Child
> `DB-02A-ATTACHMENT-CACHE-RESERVATION-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
> remains open.

> **DB-02A-ATTACHMENT-CACHE-REUSE-OWNER UPDATE (2026-08-12):** Production existing-path reuse previously reached
> its access-ledger and missing-file repair writes through the dynamic `scope.runTransaction` boundary. The tracked
> production branch now performs native `statFile` before database ownership, adopts only the short database task with
> `runTracked`, and directly opens one guarded `withDbTransaction`. An existing file records its exact byte count and
> coalesced access time; a missing active file clears every matching attachment `localPath` and deletes its ledger row
> atomically. A queued account-generation loss rejects the commit as `stale`, with no old-account write.
>
> Production-composition real-SQLite cases hold a rolling-back neighbour between native stat and reuse ownership. They
> prove native inspection runs outside the mutex, reuse waits, the neighbour rolls back independently, the cache access
> commit survives, no network fetch starts, and account revocation leaves the ledger and attachment path unchanged before
> a fresh generation retries. A coordinator case forces the missing-file ledger DELETE to fail after attachment paths
> were cleared; every repair write rolls back before a clean retry clears paths and ledger together.
>
> The first saved direct run passed 46 cases and failed one because recovery with an empty scan manifest consumed the
> one-shot native-stat fixture. A manifest-only correction still failed; evidence then showed mocked native free space
> remained zero, so quota recovery legitimately evicted the row. Supplying safe free space and asserting the active
> post-recovery row corrected the fixture without a production rollback.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheCoordinator.ts`
> `f44d2c3ffcc6105c39d4a54134c1ff1c4c020790fce8029d050bc3aff5740668`,
> `src/services/download/index.ts` `845ea46e25385d93c4bd45f6b7f9a372a195d53ef794a1a8b84a35154f09fb05`,
> `test/services/downloadAccountScope.test.ts`
> `cf201c46b825700781f0fb1b1d73f0dd46c38b7d088fe35a4b4ef1991954f580`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `a1b31bdd513cc0aa95fb9949b593a1fc5a3aab3818b8307f32ff380ce2bc47e2`, and inventory
> `d51dbb9e0e71a2c122a0a6f5f9175aa1dd7df972c1b39043781836a77697d5a2`. Final direct **2 suites / 47 tests / 0
> snapshots** and focused **5 suites / 129 tests / 0 snapshots** pass under pinned Node 24.19.0. The complete functional
> gate passes **399 suites / 4,325 tests / 0 snapshots** under `--silent` in **121.843s**, exit zero; this is functional
> evidence, not a warning-free claim. TypeScript, architecture **30/30** plus its live 65-file core boundary and three
> scheduled guards, migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Inventory is **1,063 entries / 572
> proved (478 coordinated + 94 temporal) / 491 unproven / 0 structural errors / 0 nested coordinators / 0 membership
> errors**.
>
> Exactly four tracked-production `reuseProtected` findings close here. The transaction-neutral repository definitions,
> public/outer and index caller edges, recovery and unscoped fallback branch, and retirement lifecycle remain unproven.
> Aggregate cache lifecycle, exact op-sqlite/SQLCipher, process-kill, physical-device, remaining-inventory, `DB-02B`, and
> `DB-02C` proof stay open. Child `DB-02A-ATTACHMENT-CACHE-REUSE-OWNER` is **DONE**; parent `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-RETIREMENT-SETTLEMENT-OWNER UPDATE (2026-08-12):** Native deletion remains outside the
> database mutex. The tracked production `settleRetirement` branch adopts only its short database settlement with
> transaction-neutral `runTracked`, then opens one guarded transaction. Confirmed native absence deletes the exact
> retiring ledger row; native failure or throw instead keeps it charged while atomically recording bounded retry/backoff.
> Exact-path ownership is token-checked and released in `finally`.
>
> Real-SQLite cases prove deleted and already-missing confirmation after a rolling-back neighbour, durable five-second
> retry scheduling after native failure, confirmation-DELETE rollback with the retiring row preserved, and clean
> same-path recovery. Production account-scope cases prove both confirm and retry settlement wait behind that neighbour
> while Disconnect's pause remains pending; queued generation revocation rejects the guarded commit with the exact row
> still retiring and unchanged, before a fresh generation confirms absence or persists retry. Native delete remains
> outside every database transaction.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheCoordinator.ts`
> `794a11a5de4ad8e9c4ba027710d18e678023361b5f9d01c80611b7393f3047bd`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `6af607b470fbeade6b78675c84e93c41d95e1d821438883b30d541b7f7b05886`,
> `test/services/downloadAccountScope.test.ts`
> `91b3335575e509fd6cbed40bf9d47df60464d33ad6e3fe4b7bd3620c7a674afe`, and inventory
> `0431455733482265027505b331fbd8123827256f6bebf49009b6b71bc1472ddb`. Final direct **2 suites / 52 tests / 0
> snapshots**, focused **5 suites / 134 tests / 0 snapshots**, and complete functional **399 suites / 4,330 tests / 0
> snapshots** pass under pinned Node 24.19.0. The full `--silent` run took **116.248s**, so it is functional evidence,
> not a warning-free claim. TypeScript, targeted zero-error ESLint, Prettier, diff, architecture **30/30** plus its live
> 65-file boundary and three scheduled guards, migrations **5/5** at 38/head `0038`, and scanner **35/35** pass.
> Inventory is **1,069 entries / 578 proved (484 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested /
> 0 membership**.
>
> The first new-test run passed **2/50** without correction; the first production-confirm expansion passed **2/51**.
> Mutation review then identified the retry branch's missing revocation proof, so a symmetric case was added and first
> passed **2/52**; the sole later correction was assertion wrapping required by Prettier. Exactly six tracked-production
> `settleRetirement` findings close here. Repository definitions, retirement claim/planning, outer-caller edges, recovery
> and unscoped fallback settlement, aggregate cache lifecycle, op-sqlite/SQLCipher, process-kill, physical-device,
> remaining-inventory, `DB-02B`, and `DB-02C` proof stay open. Child
> `DB-02A-ATTACHMENT-CACHE-RETIREMENT-SETTLEMENT-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
> `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-ADMISSION-CLAIM-OWNER UPDATE (2026-08-12):** Preflight first mapped the broader inactive
> retirement claim and stopped without edits: startup recovery passes a guarded account scope, but ordinary chat, send,
> sync, and realtime cleanup callers do not. That path needs a separate multi-caller scope prerequisite. The chosen
> admission eviction path was already reached through the exact production download account scope.
>
> Its tracked `planAdmissionStep` branch now uses transaction-neutral `runTracked` to adopt one source-local guarded
> transaction containing candidate state claim plus every matching attachment-reference clear. That handoff commits
> before native deletion begins. Queued account revocation rolls the ledger and references back together, pending path
> protection clears in `finally`, native deletion remains outside the mutex, and a fresh generation can replan, claim,
> delete, and reserve. The unscoped fallback is unchanged.
>
> Real-SQLite tests distinguish the explicit tracked owner from the former transaction-scope fallback, prove the
> retiring state and all cleared references are committed before native delete, force final-clear failure and whole
> rollback, retain outgoing/pin refusal, and pin admission batches at **100 + 1**. Production composition places a
> rolling-back neighbour immediately before claim: Disconnect's pause waits; revocation leaves the active victim and two
> references unchanged with no delete, reservation, or download; a fresh generation then completes the handoff. Native
> deletion is observed with no database transaction open.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheCoordinator.ts`
> `93532cbc6bab3d43e4684820d2b0d41b30133c999fc11908d681675b01e1ead6`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `c4c902eba7344ab407dc21f2957d23ab4f55c572f164d13bad48909182be43ad`,
> `test/services/downloadAccountScope.test.ts`
> `0945f46728b52d5bffc53f2baa7627a82a692f4bc7c957f64ee4743edd9db36b`, and inventory
> `847883f630b30273288feab48393feb0b123b7795d7d1b2cfac052b72ff47653`. The first saved tests passed **2/55**; the
> only correction was Prettier wrapping. Final direct **2 suites / 55 tests / 0 snapshots**, focused **7 suites / 130
> tests / 0 snapshots**, and complete functional **399 suites / 4,333 tests / 0 snapshots** pass under pinned Node
> 24.19.0. The full `--silent` run took **103.083s**, so it is functional evidence, not a warning-free claim. TypeScript,
> targeted zero-error ESLint, Prettier, diff, architecture **30/30** plus its live 65-file boundary and three scheduled
> guards, migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Inventory is **1,072 entries / 581 proved
> (487 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.
>
> Exactly three tracked admission-eviction claim findings close here. Initial snapshot, inactive and conformance claims,
> recovery, unscoped fallback, outer callers, transaction-neutral repository definitions, aggregate cache lifecycle,
> op-sqlite/SQLCipher, process-kill, physical-device, remaining-inventory, `DB-02B`, and `DB-02C` proof stay open. Child
> `DB-02A-ATTACHMENT-CACHE-ADMISSION-CLAIM-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
> remains open.

> **DB-02A-ATTACHMENT-CACHE-CHAT-SEND-SCOPE UPDATE (2026-08-13):** The admission preflight had established that
> ordinary inactive-retirement callers lacked an account scope. This prerequisite adds one shared factory that binds
> attachment-cache work to the caller's exact database and realtime account lease. Its transaction-neutral `runTracked`
> adoption makes short work visible to Disconnect; `runTransaction` uses the same lease as a last-moment database commit
> guard and quietly rejects work from a retired generation.
>
> `discardMessage` now constructs one non-null scope and passes that identical object to inactive retirement and retry
> drain after its tombstone commits. `deleteChat` constructs one scope after database admission and reuses it across both
> cleanup calls before resumed purge work and both calls afterward. Native cleanup remains outside the database mutex.
> This is caller-scope plumbing, not a claim that the inactive-file selection and claim writes are proved yet.
>
> Real-SQLite tests pin the supplied database, generic task result, stale no-task path, guarded work queued behind a
> rolling-back neighbour, rejection after Disconnect while its drain waits, queue release, and a fresh-generation
> successor. Composition spies pin exact non-null scope identity across send's two calls and chat deletion's four calls.
> Frozen SHA-256 values are
> `src/services/download/attachmentCacheAccountScope.ts`
> `8aba08631acb2e064f6fbd8f45ed8149eb1d7b082f4791d3c4d583cbae3fc059`, `src/services/send/index.ts`
> `42e0bddaf10f6de1aed8fd5e77774630745bccc1cd9327582fa201a37a62fb53`, `src/services/chatActions.ts`
> `799e8d9f8a48e82f61c4b1fa94b3f3fc9fc633a95789ff39163723f00ce9b27f`, `test/services/sendAccountScope.test.ts`
> `50b8cea5f2ce491d1eb577ec60d0cf32abd2e150ce2fcdfdedb473782f505c84`, `test/services/deleteChat.test.ts`
> `8e5a9c416e89a89c7ee98e274c7b2c9cda8ebff1bb5f76e57a02cd5aaaa1fa9a`, and inventory
> `6e0bb8c87e41072c09b6cecfd9cbf263679a4c60a910ad3829b922d265da327a`.
>
> The first saved direct gate passed **2 suites / 28 tests / 0 snapshots**. Two subsequent full-order harness corrections
> did not change production behavior. First, the admission rollback test genuinely rejected with native
> `SqliteError`/`SQLITE_CONSTRAINT_TRIGGER`, left native deletion untouched, and preserved ledger/reference rollback, but
> Jest's realm-sensitive `toThrow` matcher misclassified the error constructor retained from the preceding suite; the
> corrected assertion structurally pins exact name, code, and message. Second, two fixed 2026-08-06 error-report fixtures
> crossed the production queue's intended seven-day retention boundary, yielding zero eligible rows and no upload
> payload; those tests now pin `Date.now` to their fixture clock and restore it in `finally`. Corrected test SHA-256
> values are `test/services/attachmentCacheCoordinator.test.ts`
> `341905386b264a462ab1eba0dc63cd72c220190510b935a67399e7302b83d680` and
> `test/services/errorReportQueueService.test.ts`
> `9f9f1071750f46e31f466e36ce5e7344f5ec059d76d1d6dad5b2d591faa595a2`.
>
> Final direct **2 suites / 28 tests / 0 snapshots** and complete functional **399 suites / 4,337 tests / 0 snapshots**
> pass under pinned Node 24.19.0. The full `--silent` run took **63.276s**, so it is functional evidence, not a
> warning-free claim. TypeScript, Prettier, diff, architecture **30/30** plus its live 65-file boundary and three
> scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Focused ESLint exits zero
> with 14 pre-existing `import/first` warnings in the error-report queue test. Inventory is **1,074 entries / 581 proved
> (487 coordinated + 94 temporal) / 493 unproven / 0 structural / 0 nested / 0 membership**.
>
> The two new factory records remain deliberately unproven, so this prerequisite closes no additional DB-write record.
> Sync/realtime scope propagation, actual inactive-retirement selection/claim ownership, initial snapshot and conformance
> claims, recovery, unscoped fallback, transaction-neutral raw definitions, aggregate cache lifecycle,
> op-sqlite/SQLCipher, process-kill, physical-device, remaining-inventory, `DB-02B`, and `DB-02C` proof stay open. Child
> `DB-02A-ATTACHMENT-CACHE-CHAT-SEND-SCOPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains
> open.

> **DB-02A-ATTACHMENT-CACHE-INACTIVE-RETIREMENT-CLAIM-OWNER UPDATE (2026-08-13):** Ordinary chat/send cleanup now
> carries its exact account scope into an explicit tracked branch of `retireInactiveEntries`. Its source-local guarded
> transaction reads the bounded inactive list, excludes current in-memory owners, claims exact eligible ledger rows,
> and clears every matching attachment reference atomically. An outgoing-protected first claim keeps the same transaction
> and retries only safe siblings once. Guard rejection returns `stale`, `finally` clears pending path ownership, and
> native deletion begins only after commit and outside the database mutex.
>
> Real-SQLite tests distinguish `runTracked` from the recovery/unscoped transaction fallback, observe the semantic
> inactive-list query inside the transaction, force the final reference clear to fail, and prove ledger plus all-reference
> rollback and same-path retry. Existing outgoing and synchronous-pin refusal remains pinned, while a **101 → 100 + 1**
> case proves the batch bound. Production chat deletion queues the tracked claim behind a rolling-back neighbour;
> Disconnect waits for admitted work, revocation leaves the active ledger row and both references unchanged with no
> native delete, the neighbour rolls back independently, and a fresh generation completes retirement outside the mutex.
>
> The first source draft was discarded before test edits because a shared `claimInactivePaths` helper left both actual
> claim writes scanner-classified as unresolved; coordinated inventory entries would have overstated mechanically
> visible ownership. The frozen branch keeps the tracked writes inline. The first saved direct test candidate passed
> **2 suites / 57 tests / 0 snapshots**. Skeptical and inventory review then found that moving the inactive list outside
> its owner and removing the tracked path's 100-row bound would survive. A semantic SQL observation and the 101-row case
> close those gaps. Final direct **2/58/0** in **6.108s** and focused **7/137/0** in **15.218s** pass under pinned Node
> 24.19.0.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheCoordinator.ts`
> `4e4cea77fe4e9fe2275f1bea71b084720fe848177576ad0cbeda304559ef16c0`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `0bc86051b73ad9a2a6aa081da58ab66c7068176ee7f80b83399e2b188fdccd6e`, `test/services/deleteChat.test.ts`
> `a94ff47f7fa9e64b2597720936abc9d791e6b36df5c282870c055ec987267fab`, and inventory
> `41043f39b5519aed6fbf9bc80ee6f250fe7af286378d3f6a6eb54d6029219e2c`.
>
> Complete functional Jest passes **399 suites / 4,340 tests / 0 snapshots** under `--silent` in **105.641s**; this is
> functional evidence, not a warning-free claim. TypeScript, targeted lint, Prettier, diff, architecture **30/30** plus
> its live 65-file boundary and three scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner
> **35/35** pass. Live inventory reporting has **1,078 findings / 0 errors / 0 nested coordinators**; exact totals are
> **1,078 entries / 585 proved (491 coordinated + 94 temporal) / 493 unproven / 0 structural / 0 nested / 0
> membership**. The stricter approval check still intentionally exits at the first known unproven layout record; that
> expected backlog signal ran once outside the required structural gate and was not retried.
>
> Exactly four inline tracked-production findings close. Recovery and unscoped inactive claims, conformance and initial
> quota-snapshot ownership, sync/realtime propagation, outer caller and transaction-neutral raw-definition edges,
> aggregate cache lifecycle, exact op-sqlite/SQLCipher, process-kill, physical-device, remaining-inventory, `DB-02B`,
> and `DB-02C` proof stay open. Child `DB-02A-ATTACHMENT-CACHE-INACTIVE-RETIREMENT-CLAIM-OWNER` is **DONE**; parent
> `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A DB-WRITE PROOF/RECONCILIATION TOOLING UPDATE (2026-08-13):** The existing scanner now has a fail-closed
> reconciliation mode, exposed as `npm run reconcile:db-writes`. It is dry-run by default: run it before DB-source
> work to establish a clean baseline, rerun it after the bounded edit, and review every proposed line shift, rekey, or
> addition. It preserves reviewed metadata only for same-ID line movement or one unique callback-fingerprint rekey
> whose unchanged write snippet reconstructs both IDs; genuinely new findings remain `unproven`. Stale removals,
> changed scanner/context fields or write snippets, duplicates, and ambiguous cardinality abort. Only after the output
> matches the reviewed source change should `npm run reconcile:db-writes -- --write` atomically apply the mechanical
> update; the command never invents an owner, disposition, or evidence.
>
> `test/support/dbOwnershipProof.ts` now centralizes the rolling-back-neighbour test pattern. Callers await `entered`,
> retain and assert owner/successor promises, call idempotent `cleanup()` in `finally`, drain every observed successor,
> and then close the database. Its tests cover held rollback ordering, setup and BEGIN failure, direct cleanup, queue
> recovery, and rejection observation. Scanner/reconciler tests pass **48/48** and harness tests pass **5/5**; Node
> syntax, TypeScript, focused TypeScript lint, Prettier, and diff checks pass. Direct and npm live previews both report
> **0 line shifts / 0 rekeys / 0 additions**, so `--write` was not run. The inventory remains byte-identical at SHA-256
> `41043f39b5519aed6fbf9bc80ee6f250fe7af286378d3f6a6eb54d6029219e2c`, and the live scanner remains **1,078 findings /
> 0 structural or membership errors**. Frozen scanner/scanner-test/harness/harness-test/package hashes are
> `25413c87ed936c2394493218aa8a35d7d3946cc93762eaf3fdbdec9ce41f5268`,
> `8974bb864dcd65a1068c21915837e4ba5d3f7e3cbd923d788855d7c245305dce`,
> `5f602e2c32cc8759d25ec39cf9047ac0cedb8b0c2dd097e725c75e2f2c110bd4`,
> `7a2bcb61f6f067cc39b0ae037a2a7e41bbd12d56a65dc42dbd53dd500da7e72f`, and
> `7d5609b50953e459e04e6928734e304e74aa6ce1c7ced7402b43fe6f3ebc4210`. This tooling-only update changes no production
> behavior, proves or promotes no record, and deliberately avoids another full-app gate. `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-TRACKED-RECOVERY-PLANNING-OWNER UPDATE (2026-08-14):** Startup recovery now validates
> the complete native manifest before its first mutation-capable scope, then adopts each at-most-100-file page through
> the account scope's transaction-neutral `runTracked` lifetime around one source-local, commit-guarded
> `withDbTransaction`. Admission and current-quota conformance likewise take their fresh quota snapshots through
> explicit tracked guarded owners; conformance claims at most 100 exact retirement paths in a separate guarded commit.
> Native scan, free-space inspection, and file deletion remain outside the database mutex. The explicit transaction-scope
> compatibility branches remain unchanged.
>
> Real-SQLite recovery tests place each adoption owner behind a rolling-back neighbour, prove queued account-generation
> revocation leaves both ledger and attachment reference untouched before a fresh generation succeeds, reject a late
> duplicate before any page is adopted, and pin **101 files as 100 + 1 transactions**. Coordinator tests observe each
> tracked admission/conformance snapshot inside its transaction, pin conformance retirement at **100 + 1 claims** with
> native deletion outside the mutex, force final-reference-clear failure and whole-claim rollback, prove pending-path
> cleanup permits retry, reject a generation revoked before commit, and retain the explicit transaction-scope fallback.
>
> The ordinary reconciler correctly stopped on an ambiguous many-to-many `planAdmissionStep` group. Exact semantic-ID
> review preserved four coordinated and three unproven inactive-retirement callback rekeys, replaced only the three
> former unproven recovery-adoption records, and added five tracked planning/claim records. The eight newly coordinated
> suffixes are `71f05d67903d`, `75078a0a985e`, `d607bbd5b418`, `9ac0064005fa`, `cb1bfc109f34`,
> `807b4b5d0e88`, `8e297c53e5e4`, and `911c88673979`.
>
> Frozen SHA-256 values are `src/services/download/attachmentCacheRecovery.ts`
> `35da99952ef17bb9f84945d856f2ba07593766dcd31015d26ffd5a8a595af3f8`,
> `src/services/download/attachmentCacheCoordinator.ts`
> `9bb94656e84b0e80775eea6dcacc417b24ccff580623a9128149718c83ee8502`,
> `test/services/attachmentCacheRecovery.test.ts`
> `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `88730ba2279e3616ed5a1765d89b24995d7b9d641c38f0fc59dcc8544edc1d14`, and inventory
> `85614e28a8604cdafdf4aa1cc1a4a77faec8ee3611212b80d467dfd5ca70f9ab`.
>
> Final direct **2 suites / 57 tests / 0 snapshots** pass in **5.791s** and focused **7 / 143 / 0** in **17.268s**.
> The complete noninteractive CI-mode functional gate passes **400 suites / 4,351 tests / 0 snapshots** in **60.121s**;
> this supersedes an unrelated interactive wrapper timeout and remains functional evidence, not a warning-free claim.
> TypeScript, targeted lint, configured formatting, diff, architecture **30/30**, migrations **5/5** at 38/head `0038`,
> and scanner **48/48** pass. Live inventory is **1,083 / 593 proved (499 coordinated + 94 temporal) / 490 unproven /
> 0 structural / 0 nested / 0 membership**.
>
> The transaction-scope/unscoped compatibility branches, outer recovery/planner callers, and transaction-neutral
> repository definitions remain deliberately unproven. Sync/realtime account-scope propagation, aggregate cache
> lifecycle, exact op-sqlite/SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`,
> and `DB-02C` stay open; returned snapshot/claim pages are capped, but this child does not claim an absolute transaction-
> duration bound. Child `DB-02A-ATTACHMENT-CACHE-TRACKED-RECOVERY-PLANNING-OWNER` is **DONE**; parent `DB-02A` remains
> **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-SYNC-REALTIME-SCOPE UPDATE (2026-08-14):** Foreground sync now captures its account lease
> before database open, folds lease currentness into the existing session-ended guard, creates one attachment-cache account
> scope only after current-account database admission, and reuses that exact scope for startup retire → drain and
> post-deletion retire → drain. Durable realtime deletion cleanup now fails closed when its delivery context is missing or
> stale, derives one scope from the exact current context, and uses it for retire → drain.
>
> Mutation-sensitive sync coverage pins pre-open lease capture, one exact `{db, lease}` scope construction, the ordered
> retire → drain → retire → drain sequence, and lease-only revocation without an epoch change suppressing trailing cleanup
> plus old-account banner/contact effects. Realtime coverage pins exact context propagation, one same-scope retire → drain
> sequence, and zero cleanup for missing or stale contexts. The first saved direct run passed **2 suites / 40 tests / 0
> snapshots** in **7.422s**; skeptical mutation review found that removing the lease half of `sessionEnded` still survived,
> so the lease-only case was added. The strengthened direct run passes **2 / 41 / 0** in **7.071s**, and the focused cache
> matrix passes **8 / 171 / 0** in **7.2s**.
>
> Frozen SHA-256 values are `src/services/syncControl.ts`
> `fbb240f099e798b6fca74d41310ef08786025e60664fd7ee688588c8fbbbdf65`, `src/services/realtimeControl.ts`
> `85b5f1372332dbac33165447259f8c471004e54893e3c234b4425b0719fee8a5`,
> `test/services/syncControlTracking.test.ts`
> `c06353f3ac5e7a93edb264b79d442318d0c08193976894b77b71cac960d4f9e3`,
> `test/services/realtimeStartupOptional.test.ts`
> `21307cf3c57195fc4a1f7e77953f5e22e3a38680882ee904b16aa741faa1d2b0`, and inventory
> `dbe8d2d3696cc8c3334050f50e0e50013500632229117158b4086e4cf4f01c29`.
>
> The complete noninteractive CI-mode functional gate passes **400 suites / 4,355 tests / 0 snapshots** in **89.289s**.
> TypeScript, configured formatting, diff, architecture **30/30** with its live **65-core-file** boundary and three
> scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner **48/48** pass. ESLint reports **0
> errors** and four pre-existing `import/first` warnings, so this remains functional evidence rather than a warning-free
> claim. The live inventory and reconciliation preview report **1,083 / 593 proved (499 coordinated + 94 temporal) / 490
> unproven / 0 structural / 0 nested / 0 membership** and **0 line shifts / 0 rekeys / 0 additions**.
>
> This behavioral prerequisite promotes no DB-write record and changes no inventory classification. It closes only the
> prior sync/realtime account-scope propagation residual. Transaction-scope/unscoped compatibility branches, outer
> recovery/planner callers, transaction-neutral repository definitions, aggregate cache lifecycle, exact op-sqlite/
> SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C` stay open. Child
> `DB-02A-ATTACHMENT-CACHE-SYNC-REALTIME-SCOPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
> remains open.

> **DB-02A-ATTACHMENT-CACHE-TRACKED-DRAIN-LIST-RECHECK-OWNER UPDATE (2026-08-15):** Account-scoped
> `drainDueRetirements` now takes its bounded due-list snapshot and post-gate exact-path recheck through two separate
> transaction-neutral `runTracked` lifetimes. Each surrounds one source-local, account-guarded `withDbTransaction`; a
> path promoted from `reserved` to `active` after the snapshot is re-read before native-delete ownership is granted.
> Native deletion remains outside the database mutex. The explicit transaction-scope and unscoped compatibility branches
> retain their existing `runTransaction` fallback.
>
> The first saved exact coordinator/account-scope/recovery run passed **3 suites / 80 tests / 0 snapshots** in
> **10.485s** (real **10.99s**). Skeptical mutation review then found that deleting the due-list commit guard could still
> reach the later stale recheck and survive; the strengthened production-composition proof now requires queued revocation
> to reject before the due-list SQL runs. An independent audit then blocked the freeze because the 100-row limit was only
> statically visible. One 101-row case now proves an oversized first drain attempts and confirms exactly **100**, retains
> exactly **1**, then a second drain attempts and confirms that final row; all **101** native deletes observe
> `raw.inTransaction === false`. The first post-strengthening run passed **3/81/0** in **6.224s** (real **6.77s**), and
> the formatted final run passes **3/81/0** in **5.817s** (real **6.23s**). No source correction or rollback followed
> either review.
>
> Scanner reconciliation adds exactly two coordinated source-local openers: due-list `b3591dcd08ea` and recheck
> `5be4ec4c94d8`. The fallback rekeys `c7fd9cae2f23` → `e876c83ad518` without changing its unproven disposition, while
> `a777bbd94487` remains preserved and unproven. Frozen SHA-256 values are
> `src/services/download/attachmentCacheCoordinator.ts`
> `652e2cc4a9198b5bb897605c5115d8dccebe4f57726849b3be238e31644029d0`,
> `src/services/download/attachmentCacheAccountScope.ts`
> `8aba08631acb2e064f6fbd8f45ed8149eb1d7b082f4791d3c4d583cbae3fc059`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `0e693d63747e8b58d8e7407e6700ecefb04f4dda815371916f58bd91686afb0a`,
> `test/services/downloadAccountScope.test.ts`
> `8998e6e97df9e24cb22528c67bea1bd4ac280762d4a5f49ccbfc4421cc421a59`,
> `test/services/attachmentCacheRecovery.test.ts`
> `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`, `test/support/dbOwnershipProof.ts`
> `5f602e2c32cc8759d25ec39cf9047ac0cedb8b0c2dd097e725c75e2f2c110bd4`, and inventory
> `6d57ec244203dcc13efbd2e2fcc5c25a03b267b64ac20bebb8a30feff41eccfb`.
>
> The focused cache matrix passes **8 suites / 175 tests / 0 snapshots** in **12.886s**. The complete single-run
> noninteractive CI-mode functional gate passes **400 suites / 4,359 tests / 0 snapshots** in **141.095s**. TypeScript,
> zero-error ESLint,
> configured formatting, diff, architecture **30/30** with its live **65-core-file** boundary and three scheduled guards
> (**1/1 each**), migrations **5/5** across 38 migrations at head `0038`, and scanner **48/48** pass. The live scanner
> reports **1,085 findings / 0 structural or membership errors**, with **0 nested coordinators**; reconciliation reports
> **0 line shifts / 0 rekeys / 0 additions**. Inventory is **1,085 / 595 proved (501 coordinated + 94 temporal) / 490
> unproven**.
>
> This child closes exactly the two tracked source-local opener records. Transaction-scope/unscoped fallback edges and
> outer callers remain unproven. The 100-row database list cap does not bound native-delete latency or total drain
> duration. Aggregate cache lifecycle, exact op-sqlite/SQLCipher behavior,
> process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C` stay open. Child
> `DB-02A-ATTACHMENT-CACHE-TRACKED-DRAIN-LIST-RECHECK-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
> `TEST-01` remains open.

> **DB-02A-ATTACHMENT-CACHE-COMPATIBILITY-RETIREMENT UPDATE (2026-08-15):** The attachment-cache coordinator's
> standalone/unscoped paths now use direct source-local `withDbTransaction` owners instead of dispatching through its
> polymorphic `runTransaction` compatibility helper. Those owners cover inactive list/claim, due list/recheck, admission
> snapshot/reservation/claim, conformance snapshot/claim, reuse access/missing-file repair, and settlement confirmation/
> retry. Account-scoped production branches retain `runTracked` around the local guarded transactions. Recovery's separate
> ledger-list `scope.runTransaction` owner and the `AttachmentCacheTransactionScope` interface remain outside this child.
>
> The tests prove the relevant unscoped SQL executes with `raw.inTransaction === true` while native stat, free-space, and
> delete work stays outside the database transaction; due-list A → queued promotion B → exact recheck C, tracked
> sentinels, revocation, rollback, and **100 + 1** bounds remain covered. The first saved harness incorrectly awaited a
> queued promotion from a COMMIT spy while the outer queue slot was still owned, reproducing a test-only nested-queue
> wedge; it was stopped with SIGINT (**exit 130**) after **54.78s** and was not accepted. A corrected post-owner seam then
> produced **80/81** because one concurrent test invalidly assumed the process-global transaction flag must be false while
> another operation could legitimately own the shared transaction. After stopping and removing only that ambiguous
> instrumentation, the final direct run passed **3 suites / 81 tests / 0 snapshots** in **6.242s** (real **6.81s**).
>
> Exact scanner review promotes **27** records: inactive **4**, due-list/recheck **2**, admission **7**, conformance **4**,
> reuse **4**, and settlement **6**. Ten outer/handoff edges remain unproven: reserve → drain/plan/settle (**3**), conform
> → drain/plan/settle (**3**), reuse-existing → reuse-protected (**1**), retire-inactive → settle (**1**), drain-due →
> settle (**1**), and reservation-release → drain (**1**). Frozen SHA-256 values are
> `src/services/download/attachmentCacheCoordinator.ts`
> `bf378631f0cd929f999ba562ca4b523c11b582b405f352dc056cae70ab871dbd`,
> `src/services/download/attachmentCacheRecovery.ts`
> `7d5804fb60d3347029f26d99dcd05b3ea3e6d6d5b5c5833e33dce831c25cdfe3`,
> `test/services/attachmentCacheCoordinator.test.ts`
> `30cbd7abac5216bb2281c174b0ff76a80f335b689121f9be14a04e953ce89969`,
> `test/services/downloadAccountScope.test.ts`
> `8998e6e97df9e24cb22528c67bea1bd4ac280762d4a5f49ccbfc4421cc421a59`,
> `test/services/attachmentCacheRecovery.test.ts`
> `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`, and inventory
> `586a2838a708c70acb3eae6e4611b7cd1c2f277fcb44ad480369189e0fc2b003`.
>
> The focused cache matrix passes **8 suites / 175 tests / 0 snapshots** in **13.362s**. The authoritative managed full
> gate exits **0** with **400 suites / 4,359 tests / 0 snapshots** in **799.937s**. One unchanged
> `chatScreenReadMarker` suite took **735.137s** during a host stall but passed; the earlier detached run lost its aggregate
> output and is inconclusive, so it is not counted. TypeScript, zero-error ESLint, configured formatting, diff,
> architecture **30/30** with its live **65-core-file** boundary and three scheduled guards (**1/1 each**), migrations
> **5/5** across 38 migrations at head `0038`, and scanner **48/48** pass. The live scanner reports **1,089 findings / 0
> structural or membership errors**, with **0 nested coordinators**; reconciliation reports **0 line shifts / 0 rekeys / 0
> additions**. Inventory is **1,089 / 622 proved (528 coordinated + 94 temporal) / 467 unproven**.
>
> This host-green child closes only the 27 direct unscoped coordinator records. The ten outer/handoff edges, recovery
> ledger-list compatibility owner, transaction-neutral repository definitions, aggregate cache lifecycle and duration,
> exact op-sqlite/SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C`
> stay open. A **100-row database cap does not bound total native-delete latency**. Child
> `DB-02A-ATTACHMENT-CACHE-COMPATIBILITY-RETIREMENT` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
> remains open.

> **DB-02A-DB-REKEY-SELFTEST-THROWAWAY-EXCLUSION UPDATE (2026-08-15):** The DEV-only database rekey self-test still
> opens only the fixed `rekey-selftest.db`, never production `gator.db`. Preflight found that the primary-key,
> reopened-new-key, and stale-old-key handles could remain open when their reads or writes rejected, while the broad stale
> catch could misclassify a close failure as old-key rejection. Each keyed handle now closes from its own `finally`, and
> only the stale `SELECT` rejection sets `oldRejected`; best-effort prewipe and final-wipe deletion remain scoped to the
> fixed throwaway name. This is separate from the already-complete live production key-rotation owner.
>
> The first source save passed its static checks, but scanner reconciliation correctly rejected a local `db` identifier
> rename that would needlessly disturb stable record identity. Restoring the name was mechanical only: all six IDs remain
> stable, with **4 line shifts / 0 rekeys / 0 additions**. A local op-sqlite mock pins the exact five-handle success
> sequence—prewipe, key A, key B, stale key A, final wipe—plus exact open options, key relationships, CREATE → INSERT →
> PRAGMA → new-key SELECT → stale-key SELECT order, close attempts, and cleanup. Separate PRAGMA and new-key read failures
> prove every opened keyed handle closes before final wipe; a compact close-failure case proves close failure is not
> old-key rejection. The first saved and final direct gate passes **1 suite / 10 tests / 0 snapshots** in **4.715s**, with
> no test correction. One attempted standalone `tsc -p tsconfig.test.json` was an invalid repository invocation due to its
> legacy module-resolution setting, not a product/test failure; repo TypeScript and the exact ts-jest suite are green.
>
> The fixed-name delete, prewipe call, schema create, insert, rekey PRAGMA, and final-wipe call are now exactly six
> `proven-temporal-exclusion` records. Frozen SHA-256 values are `src/db/key.ts`
> `f6a0aa7d4d25745c0158c4dd845a0727215b1266714fcc65185b96dad82a9465`, `test/db/dbKeyRotation.test.ts`
> `fdde8433555890c70ffd0cfdebcd131238e3852c095a08d286cffe67cc1f9f3e`, and inventory
> `cedf1ffd92d2054380c9d1b0d39daa4c610a1e9789a70d87fa668b6c3a48d84d`. Inventory remains **1,089** total and is now
> **628 proved (528 coordinated + 100 temporal) / 461 unproven**.
>
> The focused ownership matrix passes **4 suites / 103 tests / 0 snapshots** in **5.143s**. The complete functional gate
> exits **0** with **400 suites / 4,363 tests / 0 snapshots** in **80.454s**. Scanner tests pass **48/48** in **8.562s**;
> the live report is **1,089 / 0 structural or membership errors**, with **0 nested coordinators**, and reconciliation is
> **0 line shifts / 0 rekeys / 0 additions**. TypeScript, zero-error ESLint, configured formatting, diff, architecture
> **30/30** in **6.945s** with its live **65-core-file** boundary and three scheduled guards (**1/1 each**), and migrations
> **5/5** across 38 migrations at head `0038` pass. No Jest process remains active.
>
> This host proof establishes JavaScript filename/options/order and cleanup behavior only. It does **not** prove native
> SQLCipher re-encryption, native filesystem deletion or path resolution, concurrent native handles, process-kill,
> exact-candidate, or physical-device behavior. The DEV foreground `startProcessWork → runDbRekeySelfTest` caller remains
> unproven, and the device checklist stays open. Child `DB-02A-DB-REKEY-SELFTEST-THROWAWAY-EXCLUSION` is **DONE**; parent
> `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

> **DB-02A-RUNTIME-TRANSACTION-CONTEXT-JOIN UPDATE (2026-08-15):** A preliminary type-only database brand was rejected
> after skeptical review proved that a cast, `any`, or an escaped handle could forge or outlive it. That prototype was
> reverted byte-for-byte. The retained runtime design gives each `withDbTransaction` owner a frozen, opaque
> `DbTransactionContext` whose state lives in a private `WeakMap`; transaction-only helpers join through
> `runInTransactionContext` rather than treating a raw database handle as evidence of ownership.
>
> A join registers synchronously. Once the owner callback settles, its context closes to new registrations and all
> already-registered tasks settle before the transaction chooses `COMMIT` or `ROLLBACK`. Any attempted late join latches
> a violation and forces rollback even when its returned rejection is ignored. The token is removed before the final
> commit guard and `COMMIT`, so forged, stale, cross-owner, and post-owner contexts reject. This runtime check does not
> make the token a general capability: it must stay inside the owner callback, must not be passed into unrelated code,
> and the raw callback database must never escape for later use.
>
> The scanner accepts only the exact imported `runInTransactionContext`, with an inline callback, when the guard call is
> itself awaited or returned. It rejects named callbacks, lookalikes, dynamic/namespace dispatch, unadopted promises, and
> returns replaceable by an enclosing `finally`. The guard call does not create a synthetic inventory finding; it gives
> the writes in its callback a mechanically checked transaction context, while transitive nested-coordinator checks
> remain unchanged. A generic finding ID does not encode whether an outer `await` is later removed, so this is not a
> blanket future-proof claim: the exact 52 promoted paths were additionally audited in the TypeScript AST and are all
> currently awaited or returned.
>
> The migration covers **25 transaction-only owner bodies** and promotes exactly **52 findings**. Independent AST review
> counted **112 calls** on those paths, **0 database/context escapes**, and **0 nested coordinator paths**. The durable
> incoming-event definition `e5c8469dbfa3` and call `1939ccb043fe` remain deliberately unproven. Inventory is now
> **1,089 entries / 680 proved (580 coordinated + 100 temporal) / 409 unproven / 0 structural errors / 0 nested
> coordinators / 0 membership errors**, with reconciliation at **0 line shifts / 0 rekeys / 0 additions**. Frozen
> SHA-256 values are inventory `1eedb2712217d6b3cf2617d54367ad1af8921ce19a1a151de2212f9353c9ac3a`, transaction
> runtime `9d590bd3ceb2fc535a72613b253a6ae6a7322fd75b1d984942dffd27e2c67411`, scanner
> `09a7f2de341918925aa9a2875bb87248808566a4a298f842f803422534e490ea`, and scanner tests
> `971dc58f1ea83adc150d11e9048413bf5814f678fde325a773e8e25df6e49719`.
>
> Scanner tests pass **52/52** in **6.38s**. The focused Node matrix passes **27 suites / 487 tests** in **61.505s**, and
> the component matrix passes **2 suites / 36 tests** in **2.091s**, totaling **29 suites / 523 tests**. The first full
> run reached **399/400 suites and 4,367/4,369 tests** in **253.701s** before two `markUnread` tests exhausted a fixed
> 20-microtask test wait. An isolated run reproduced the test-harness defect. Replacing it with a bounded event-loop wait
> and explicit fail-safe produced test SHA-256
> `bb9c6f821a5455d1c80f9fc5ca675388acc9503f89d028d2e89ab15729ce19ac`; the isolated suite passes **1 suite / 11
> tests** in **5.289s**, and the final full functional gate exits **0** with **400 suites / 4,369 tests / 0 snapshots**
> in **62.069s**.
>
> TypeScript, zero-error ESLint, configured Prettier, architecture **30/30** over **65 core files**, all three scheduled
> guards (**1/1 each**), and migrations **5/5** across 38 migrations at head `0038` pass. Live inventory report,
> reconciliation, and nested-coordinator checks are all clean. This proves the host JavaScript runtime contract and the
> exact reviewed promotions. It does **not** prove native op-sqlite/SQLCipher or process-kill behavior, an exact release
> candidate, or absolute row/byte/duration bounds for every transaction callback. The durable pair, remaining **409**
> findings, `DB-02B`, `DB-02C`, and device evidence remain open. Child
> `DB-02A-RUNTIME-TRANSACTION-CONTEXT-JOIN` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains
> open.

> **DB-02A-INCOMING-EVENT-LIFECYCLE UPDATE (2026-08-16):** The exact 35-row source-local backlog across the incoming
> repository, drain, and dispatcher is resolved as **34 coordinated findings plus one removed compile-time-only
> reference**. The durable DB-applied marker authenticates and joins the exact active transaction, lifecycle clocks are
> sampled at their ownership boundaries, and settlement revokes attempt authority. Detached auto-download and wallpaper
> work receives neither the short-lived attempt context nor its durable checkpoint; each captures a fresh
> account-generation lease. Dynamic recovery retains its exact guard, while claim token/version fencing preserves the
> documented soft-lease behavior.
>
> Scanner delegation proof is limited to the two reviewed lifecycle service files, never becomes inherited transaction
> membership, and fails closed through raw writes, scheduled callbacks, dynamic dispatch, references, and ordinary call
> edges. Inventory is **1,088 / 714 proved (614 coordinated + 100 temporal) / 374 unproven**, with zero structural,
> membership, or nested-coordinator errors and reconciliation at **0/0/0**. Scanner tests pass **55/55** and the focused
> matrix passes **11 suites / 219 tests**. TypeScript, lint, formatting, diff, architecture **30/30** plus live guards,
> and migrations **5/5** pass. One first-run unrelated component timeout left the full gate at **399/400 suites**; the
> exact suite passed unchanged **32/32** in isolation and the unchanged rerun passed **400 suites / 4,376 tests**.
>
> Maintenance-triggered terminal recovery, outer ingress callers, the soft-lease/device boundary, native
> op-sqlite/SQLCipher/process-death/killed-FCM/exact-candidate proof, server `attemptGuid`, and the remaining **374**
> findings stay open. This child is **DONE**; parent `DB-02A` and `PUSH-RETRY-01` remain **IN_PROGRESS**.

> **DB-02A-DB-OPEN-LIFECYCLE UPDATE (2026-08-16):** The first encrypted-database open is now an exact temporal proof.
> `ensureDatabase` synchronously publishes one shared attempt and clears only that attempt on both outcomes;
> `initDatabase` withholds both handles until its foreign-key PRAGMA, migrations, and Drizzle construction finish, then
> publishes them without another suspension. Failure closes the unpublished handle and preserves the original error.
> Key recovery closes every probe handle, promotes a pending key only after a positive read, and retains both candidates
> when neither can be proved. A tiny lazy notification helper preserves the pure-service import boundary while making
> the previously invisible notification database-open edge auditable.
>
> The scanner certifies only the exact symbol-resolved single-flight source shape and fails closed on altered admission,
> cleanup, awaiting, publication, state replacement, extra entry points, dynamic loads, CommonJS/import-equals, namespace
> or local aliases, extension substitution, and dotted barrels. The exact **26 findings** are **25
> `startup-single-flight-delegation`** records plus `initDatabase` → `runMigrations` as `startup-initialization`; adapter
> findings remain unproven. Inventory is **1,089 / 740 proved (614 coordinated + 126 temporal) / 349 unproven**, with
> zero structural, membership, or nested-coordinator errors and reconciliation at **0/0/0**.
>
> Scanner tests pass **59/59** and the focused matrix passes **6 suites / 50 tests**. TypeScript, lint, formatting, diff,
> architecture **30/30** plus live guards, and migrations **5/5** pass. The full gate exits **0** with **400 suites /
> 4,385 tests / 0 snapshots** in **101.627s**. Native op-sqlite/SQLCipher, process-death, same-ReactContext killed-FCM,
> exact-candidate/device proof, outer ingress ownership, and the remaining **349** findings stay open. This child is
> **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-INCOMING-INGRESS-LIFECYCLE UPDATE (2026-08-17):** Direct socket, eligible unlocked-FCM, and DEV callbacks
> now cross one tracked, generation-fenced durable-intake boundary. Callback payload, occurrence identity, and receipt
> time are captured synchronously before database-open or FIFO waits; FCM admission remains FIFO from native receipt,
> socket replacement retires the old lifecycle before reopening, and pause/account invalidation waits for admitted work
> while disposing the old dispatcher/drain. Locked FCM remains the intentional generic-notice/no-database exception.
>
> The exact edge-level `incoming-ingress-delegation` certificate binds the reviewed transport, coordinator, runtime,
> codec, disposal, and DEV gates by TypeScript symbol and fails closed on aliases, shadowed globals, mutable snapshots,
> reordered or detached FIFO work, missing lease/lock/session/generation guards, alternate native registration, and
> untracked work. Exactly **22 findings** are coordinated; seven newly visible handoffs grow inventory to **1,096 / 762
> proved (636 coordinated + 126 temporal) / 334 unproven**. Structural, membership, and nested-coordinator errors are
> zero, and reconciliation is **0/0/0**. Six mixed outer `startRealtime`/`resumeRealtime` edges remain unresolved.
>
> Scanner tests pass **61/61**; the focused matrix passes **16 suites / 224 tests**; TypeScript, lint, formatting, diff,
> architecture **30/30** plus live guards, and migrations **5/5** pass. After correcting one stale mock expectation for
> the new captured-receipt argument, the full gate passes **401 suites / 4,399 tests / 0 snapshots** in **65.105s**.
> Plaintext FCM account/server authentication, native Socket.IO/RNFB behavior, killed/background process behavior,
> op-sqlite/SQLCipher, physical-candidate evidence, server `attemptGuid`, mixed lifecycle owners, and the remaining
> **334** findings stay open. This child is **DONE**; parent `DB-02A` and `PUSH-RETRY-01` remain **IN_PROGRESS**.

> **DB-02A-FOREGROUND-UNLOCK-REVOCATION UPDATE (2026-08-17):** Biometric and cold-boot authority is now explicitly
> foreground-only. Background/unmount revokes a prompt result immediately while retaining its native in-flight slot
> until settlement, so resume cannot create overlapping Android prompts; null/unknown startup AppState waits for an
> explicit active event. The root records the exact cold-unlock run before awaiting it and invalidates that run—even if
> it just reached ready—or an ordinary loading run when foreground authority is lost. Active starts one successor;
> stale ids and normal already-ready runs are no-ops.
>
> This child deliberately promotes no DB finding. One old unresolved root edge became three explicit unresolved
> lifecycle edges; all 12 live root/foreground-boot findings remain unproven. Inventory is **1,098 / 762 proved (636
> coordinated + 126 temporal) / 336 unproven**, with zero structural, membership, or nested-coordinator errors and
> reconciliation at **0/0/0**. The focused matrix passes **7 suites / 122 tests**; TypeScript, lint, formatting, diff,
> architecture **30/30** plus live guards, and migrations **5/5** pass. The full gate passes **401 suites / 4,414 tests /
> 0 snapshots** in **87.488s**.
>
> Host revocation cannot cancel an already-admitted native biometric prompt or process-global SQLCipher open; native
> AppState order, biometric cancellation, SQLCipher behavior, process-kill, and physical-candidate evidence remain
> open. This child is **DONE**; parent `DB-02A` and `REL-007B2..C` remain **IN_PROGRESS**.

> **DB-02A-ERROR-REPORT-REVOCATION-LIFECYCLE UPDATE (2026-08-17):** Foreground error-report work now claims one
> synchronous flight and captures its exact account lease and database before any hydration, purge, sink, or network
> await. Account invalidation aborts the owned upload; consent revocation always retires the sink and serializes a
> guarded exact-database purge; failed/stale purges remain upload barriers; and post-pause diagnostics cannot enter a
> fresh ring. Both explicit consent values atomically store the versioned choice and clear the durable queue, closing
> rapid Off → Allow and headless/process-restart bypasses. A contained hydration failure remains unknown rather than
> being treated as destructive denial.
>
> Exactly **28** old unproven edges are now coordinated: **21** source-local `coordinated-delegation` records plus
> **7** exact outer `error-report-lifecycle-delegation` handoffs. Two explicit transaction-only purge calls grow the
> ledger to **1,100 / 792 proved (666 coordinated + 126 temporal) / 308 unproven**. Structural, membership, and
> nested-coordinator errors are zero; reconciliation is **0/0/0**. The branch-sensitive scanner tests pass **64/64**;
> the focused matrix passes **13 suites / 264 tests**. Three stale settings expectations failed the first full gate
> (**400/401 suites; 4,423/4,426 tests**); the corrected exact suite passes **27/27**, and the clean full rerun passes
> **401 suites / 4,426 tests / 0 snapshots** in **65.417s**. TypeScript, lint, formatting, diff, architecture **30/30**
> plus live guards, and migrations **5/5** pass.
>
> Host cancellation cannot recall a server-accepted POST. Native ErrorUtils/Hermes/fetch order, process death,
> op-sqlite/SQLCipher, physical-candidate/proxy proof, server duplicate aggregation, legacy consent policy, and
> pre-runtime native logging remain open. This child is **DONE**; `DB-02A`, `PRIV-02`, and `LOG-01` remain
> **IN_PROGRESS**.

> **DB-02A-NOTIFICATION-EFFECT-LIFECYCLE UPDATE (2026-08-17):** Reminder and private-notification effects now carry
> the captured account lease into the final reminder/route commit. Reminder updates and deletes compare the native id
> they observed, preventing a slow stale action from overwriting or deleting a newer schedule; uncertain native
> schedules are strictly canceled, and cleanup failure is surfaced. Detailed message, alias, and FaceTime presentation
> rechecks App Lock after deferred native/route work and substitutes the fixed generic locked notice before any remaining
> private write.
>
> Exactly **26** old unproven findings are now coordinated: **20** notifee-service edges, **4** reminder-service edges,
> and **2** exact reminder-press handoffs. The five reply/reaction/send action edges remain unresolved. Inventory stays at
> **1,100** and advances to **818 proved (692 coordinated + 126 temporal) / 282 unproven**; structural, membership, and
> nested-coordinator errors are zero, and reconciliation is **0/0/0**. Focused tests pass **4 suites / 146 tests**; the
> scanner passes **65/65**; TypeScript, scoped lint/format, architecture **30/30** plus live guards, migrations **5/5**,
> and the full **401-suite / 4,439-test** Jest gate pass. Independent review is GO.
>
> Android notify-kit ordering/cancellation, process-kill, op-sqlite/SQLCipher, physical-device evidence, the five action
> send edges, and broader send lifecycle remain open. Native notification state and SQLite use guarded compensation,
> not a cross-system atomic transaction. This child is **DONE**; `DB-02A` and `NOTIF-01..03` remain **IN_PROGRESS**.

> **DB-02A-INTERACTIVE-LEAF-DELEGATION UPDATE (2026-08-18):** Exactly **25** interactive leaf edges now have executable
> database-owner delegation proof: **13** chat appearance/customization calls, **6** conversation/scheduled-history
> controls, and **6** feature/theme preference setters. The proof is intentionally limited to delegation into already
> coordinated repository writers; it does not claim account-revocation, native-effect, or optimistic UI correctness.
>
> Inventory remains **1,100** and advances to **843 proved (717 coordinated + 126 temporal) / 257 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **8 suites / 202
> tests**; the fast scanner passes **65 relevant tests** with one intentional skip, the full scanner passes **66/66**, and
> TypeScript, lint, formatting, architecture **30/30**, migrations **5/5**, and the full **401-suite / 4,439-test** Jest
> gate pass. The new fast/full scanner split and short `docs/DB_02A_CURRENT.md` handoff reduce ordinary milestone latency
> without weakening the proof required when scanner logic changes. This child is **DONE**; `DB-02A` remains
> **IN_PROGRESS**.

> **DB-02A-ORDINARY-SEND-DELEGATION UPDATE (2026-08-18):** Exactly **26** ordinary-send call edges now have executable
> DB-owner delegation proof: notification reply/reaction handoff, optimistic text/contact/reaction/attachment services,
> send outcome settlement, and outgoing recovery. The proof does not claim network cancellation, immediate
> account-revocation rollback, scheduled-send or edit/unsend safety, discard/cache cleanup, or outer UI ownership.
>
> Inventory remains **1,100** and advances to **869 proved (743 coordinated + 126 temporal) / 231 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **11 suites / 144
> tests**; the fast scanner passes **66 relevant tests** with one intentional skip, the full scanner passes **67/67**,
> TypeScript passes, and bounded independent review is GO. Application source did not change after the immediately prior
> green lint/format, architecture **30/30**, migrations **5/5**, and full **401-suite / 4,439-test** gate, so those
> identical runtime gates were reused. This child is **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-DEFERRED-SEND-SERVICE-DELEGATION UPDATE (2026-08-18):** Exactly **23** internal scheduled-message and
> edit/unsend service edges now have DB-owner delegation proof: one scheduled reconciliation handoff, **12** schedule
> service edges, and **10** edit/unsend edges. Outer timer/UI ownership, network/native behavior, and account cancellation
> remain open.
>
> Inventory remains **1,100** and advances to **892 proved (766 coordinated + 126 temporal) / 208 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **9 suites / 135
> tests**; TypeScript and the fast scanner pass (**67 relevant tests**, one intentional skip), and bounded independent
> review is GO. Because this changed reviewed path/ID data only, the unrelated slow ingress mutation sweep was not
> repeated; the immediately prior full scanner passed **67/67**. Application code remained identical to the prior green
> lint/format, architecture **30/30**, migrations **5/5**, and full **401-suite / 4,439-test** gate. This child is **DONE**;
> `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-SEND-FRONT-DOOR-DELEGATION UPDATE (2026-08-18):** Exactly **21** public send-facade edges now have DB-owner
> delegation proof across text, contact, reaction, attachment, scheduled-message, retry, discard, and post-discard cache
> cleanup. The two cache handoffs enter their own short DB owners and keep native deletion outside the transaction; the
> cache coordinator's remaining internal lifecycle is not claimed here.
>
> Inventory remains **1,100** and advances to **913 proved (787 coordinated + 126 temporal) / 187 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **9 suites / 119
> tests**; TypeScript and the fast scanner pass (**68 relevant tests**, one intentional skip), and bounded independent
> review is GO. This reviewed path/ID data-only change did not rerun the unrelated slow incoming-ingress mutation sweep;
> application source and the prior green full runtime gates were unchanged. This child is **DONE**; `DB-02A` remains
> **IN_PROGRESS**.

> **DB-02A-CONVERSATION-ACTION-DELEGATION UPDATE (2026-08-18):** Exactly **32** production chat-action and DEV
> conversation-operation edges now have DB-owner delegation proof: **13** chat read/unread/delete, reminder, scheduled,
> purge, and cache-cleanup handoffs plus **19** DEV fixture/send/edit/unsend/reconcile handoffs. Existing stronger startup
> and incoming-ingress contexts in the same files are unchanged.
>
> Inventory remains **1,100** and advances to **945 proved (819 coordinated + 126 temporal) / 155 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **7 suites / 130
> tests**; TypeScript and the fast scanner pass (**67 relevant tests**, three intentional full-only mutation sweeps), and
> the two newly deferred error-lifecycle mutations pass **2/2** when explicitly enabled. Memoizing the immutable project
> scan across exact-boundary assertions reduced the fast run from about 56 seconds to about 15 seconds. This child is
> **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-SYNC-DELEGATION UPDATE (2026-08-18):** Exactly **21** foreground/background sync edges now have DB-owner
> delegation proof: **10** sync-control, **5** sync-engine, **4** synced-background, and **2** background-task handoffs.
> Stronger startup, direct-transaction, and error-lifecycle contexts in those files remain unchanged.
>
> Inventory remains **1,100** and advances to **966 proved (840 coordinated + 126 temporal) / 134 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **7 suites / 108
> tests**; TypeScript and the memoized fast scanner pass (**68 relevant tests**, three intentional full-only mutation
> sweeps) in about 16 seconds. Application code and the prior green full runtime gates are unchanged. This child is
> **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-ATTACHMENT-CACHE-TRANSACTION-CONTEXT UPDATE (2026-08-18):** Ten exported cache mutators covering **13**
> write findings now require an opaque runtime-checked transaction context. Their **10** coordinator and **7** recovery
> handoffs have DB-owner delegation proof, while native filesystem work remains outside the short owner callbacks.
> Stale and forged contexts reject, and a joined failure rolls back with its owner.
>
> Inventory remains **1,100** and advances to **996 proved (870 coordinated + 126 temporal) / 104 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **8 suites / 231
> tests**; TypeScript, lint, scanner **72/72**, architecture **30/30**, migrations **5/5**, and full Jest **401 suites /
> 4,440 tests** pass. Independent review is GO. The dynamic account-scope callback and native/device evidence remain open.
> This child is **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-ATTACHMENT-DOWNLOAD-DELEGATION UPDATE (2026-08-18):** Exactly **26** attachment UI, download-front-door,
> and download-service edges now have DB-owner delegation proof. The generic transaction callback remains unproven and
> the exact-set test prevents the reviewed boundary from widening silently.
>
> Inventory remains **1,100** and advances to **1,022 proved (896 coordinated + 126 temporal) / 78 unproven**. Structural,
> membership, and nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **10 suites / 218
> tests**; TypeScript and the fast scanner pass (**70 tests**, three intentional skips). The immediately preceding green
> full scanner **72/72** and full Jest **401/4,440** remain applicable because application code did not change. This proof
> does not establish native download behavior or account authority: five components still capture the active lease at
> invocation rather than binding it to the mounted account. This child is **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-REPOSITORY-CONTEXT-AND-THIN-DELEGATION UPDATE (2026-08-18):** Six raw repository/service leaves now use
> one short owner or an exact runtime-checked transaction-context join, and the scanner rejects a joined write that
> captures a different database handle. Exactly **21** formerly unresolved repository and thin caller edges now have
> DB-owner delegation proof; contacts' dynamic callback, driver adapters, rekey/native crypto, and account/device
> lifecycle work remain outside this child.
>
> Inventory is **1,102 / 1,045 proved (919 coordinated + 126 temporal) / 57 unproven**. Structural, membership, and
> nested-coordinator errors are zero; reconciliation is **0/0/0**. Focused tests pass **17 suites / 305 tests**;
> TypeScript, scoped format/lint, scanner **71 passed + 3 intentional skips**, architecture **30/30**, and migrations
> **5/5** pass. The milestone-wide Jest run passed **400/401 suites and 4,440/4,441 tests**; its only failure was an
> unrelated five-second account-screen timeout, and that exact suite immediately passed **13/13** in isolation. Bounded
> independent review is GO. This child is **DONE**; `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-ACCOUNT-TRANSITION-AUTHORITY UPDATE (2026-08-19):** Downloads now require an explicit account lease, and
> Audio/File/Image/Sticker/Video components retain their mounted lease across rerenders and later actions. Exactly five
> Home, Settings, and realtime transition edges are proved as `account-transition-delegation`; scheduled, key-rotation,
> and mixed-resume siblings remain unresolved.
>
> Inventory is **1,102 / 1,050 proved (924 coordinated + 126 temporal) / 52 unproven**, with structural, membership,
> nested-owner, and reconciliation checks clean. Focused tests pass **10 suites / 182 tests**; the strengthened component
> subset passes **5/71**; scanner **76/76**, architecture **30/30**, migrations **5/5**, and four non-overlapping
> full-Jest shards **402 suites / 4,442 tests** all pass. Native filesystem, process-death, device behavior, bootstrap
> composition, and generic/dynamic transaction callbacks remain open. This child is **DONE**; `DB-02A` remains
> **IN_PROGRESS**.

> **DB-02A-OUTER-LIFECYCLE-DELEGATION UPDATE (2026-08-19):** Exactly **31** records across nine reviewed outer
> lifecycle/orchestration files now use the existing whole-program proof to show that each call reaches an already-safe
> DB owner. The proof deliberately excludes the root/foreground process/self-test chain, driver adapters, contacts and
> cache dynamic callbacks, and live database rekey.
>
> Inventory is **1,102 / 1,081 proved (955 coordinated + 126 temporal) / 21 unproven**; structural, membership,
> nested-owner, and reconciliation checks are clean. The exact boundary passes **1/1**, and the fast scanner passes **73
> tests** with four intentional full-only skips. With no application-code change, the preceding same-day scanner
> **76/76**, architecture **30/30**, migrations **5/5**, and four-shard full Jest **402 suites / 4,442 tests** remain
> applicable. This is DB-owner delegation only, not account/timer/network/native/device proof. This child is **DONE**;
> `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-DYNAMIC-TRANSACTION-CALLBACK-ELIMINATION UPDATE (2026-08-19):** Generic cache/download transaction
> callbacks and the contact raw-writer wrapper were replaced by explicit, short, guarded owners. Cache recovery now
> tracks its one ledger-read transaction directly; contact writes join through the runtime-checked transaction context.
> Queued-neighbour tests prove revocation rejects both contact publication and a download's final DB commit.
>
> The scanner pins the exact eight replacement records and rejects the retired dynamic coordinator shapes. Inventory is
> **1,100 / 1,085 proved (959 coordinated + 126 temporal) / 15 unproven**; structural, membership, nested-owner, and
> reconciliation checks are clean. Focused tests pass **6 suites / 120 tests**; TypeScript, scoped lint/format, full
> scanner **78/78**, architecture **30/30**, migrations **5/5**, and four full-Jest shards **402 suites / 4,445 tests** pass. Native
> contacts, filesystem/downloads, process death, and device behavior remain open. This child is **DONE**; `DB-02A`
> remains **IN_PROGRESS**.

> **DB-02A-LIVE-REKEY-DELEGATION UPDATE (2026-08-19):** Exactly two handoffs—the Settings confirmation into
> `rotateDatabaseKey` and that wrapper into `rotateDbKey`—now use the existing whole-program coordinated-delegation
> proof. The target-based exact-set test also pins the sole production caller. No production code changed.
>
> Inventory remains **1,100** and advances to **1,087 proved (961 coordinated + 126 temporal) / 13 unproven**;
> structural, membership, nested-owner, and reconciliation checks are clean. Focused Settings/key-rotation tests pass
> **2 suites / 42 tests**, TypeScript passes, and the fast scanner passes **75 tests with four intentional full-only
> skips**. The preceding same-day full scanner **78/78**, architecture **30/30**, migrations **5/5**, and full Jest **402
> suites / 4,445 tests** remain applicable. Native SQLCipher, Keystore,
> concurrent-handle, crash, and power-loss behavior remains device-only evidence. This child is **DONE**; `DB-02A`
> remains **IN_PROGRESS**.

> **DB-02A-FOREGROUND-BOOT-LIFECYCLE-DELEGATION UPDATE (2026-08-19):** Exactly seven root/foreground boot edges now
> have coordinated lifecycle-delegation proof, while the one DEV rekey self-test call has a distinct throwaway temporal
> proof. The certificate pins one-shot foreground admission, active/mounted restart authority, the exact
> `ForegroundLockGate` warm-unlock binding, the DEV guard, the fixed throwaway filename, every op-sqlite open, and every
> immutable handle's SQL/read/close receiver. Redirecting an open to the live filename, reassigning a throwaway handle to
> the shared live database, or moving the warm-unlock callback revokes the whole boundary.
>
> Inventory remains **1,100** and advances to **1,095 proved (968 coordinated + 127 temporal) / 5 unproven**;
> structural, membership, nested-owner, and reconciliation checks are clean. Focused tests pass **4 suites / 53
> tests**; TypeScript, scoped lint/format/diff, scanner **81/81**, architecture **30/30**, migrations **5/5**, and four
> full-Jest shards **402 suites / 4,447 tests** pass. The remaining five findings are driver adapters. Native SQLCipher,
> file deletion, bridge, process-death, and device behavior remain outside this host proof. This child is **DONE**;
> `DB-02A` remains **IN_PROGRESS**.

> **DB-02A-DRIVER-ADAPTER-PROOF UPDATE (2026-08-19):** An exact fail-closed certificate classifies the private
> migration runner's `exec/query` calls as two startup temporal exclusions and the private Drizzle Proxy's
> `execute/executeAsync/executeRawAsync` calls as three runtime-coordinated adapter calls. Escape through `$client`,
> `session.client`, extracted raw methods, `arguments`, or reflection is detected and revokes the proof.
>
> Inventory is **1,100 / 1,100 proved (971 coordinated + 129 temporal) / 0 unproven**; structural, membership,
> nested-owner, and reconciliation checks are clean. Focused tests pass **3 suites / 15 tests**; TypeScript, lint,
> format, full scanner **85/85**, architecture **30/30**, migrations **5/5**, and four full-Jest shards **402 suites /
> 4,448 tests / 0 snapshots** pass. `DB-02A` is **DONE**. This host ownership result does not prove native
> Drizzle/op-sqlite/SQLCipher behavior: `DB-01` remains open, including the missing synchronous-`execute` reactive
> flush, and Android/device evidence remains required.

> **DB-01A-SYNC-EXECUTE-REACTIVE-FLUSH UPDATE (2026-08-19):** The synchronous Drizzle adapter now performs
> `executeSync`, requests one reactive-query flush after success, and then wraps the result; execution failure does not
> flush. A real installed-Drizzle contract verifies sync `db.all(UPDATE ... RETURNING)`, async `db.run`, and builder
> `.returning()` routing, while the exact scanner certificate fails closed when the sync flush is removed.
>
> Inventory remains **1,100 / 1,100 proved (971 coordinated + 129 temporal) / 0 unproven**; structural, membership,
> nested-owner, and reconciliation checks are clean. Focused tests pass **4 suites / 16 tests**; TypeScript, lint,
> format, full scanner **85/85**, architecture **30/30**, migrations **5/5**, and four full-Jest shards **403 suites /
> 4,449 tests / 0 snapshots** pass. Independent review is GO. This child is **DONE**; `DB-01` remains **IN_PROGRESS**
> for Android JSI result shapes, reactive callback timing/ordering, commit/rollback behavior, SQLCipher, upgrades, and
> process reopen.

> **DB-01B-ANDROID-DRIVER-CONTRACT UPDATE (2026-08-19):** The DEV boot lane now runs a finite native database
> contract against fixed disposable `driver-selftest.db` while retaining the private production Drizzle adapter. The
> API-35 arm64 emulator passed encrypted open, forced wrong-key rejection, FTS5, commit/rollback reactive convergence,
> the synchronous/async/raw Drizzle write routes, rekey, new-key reopen, old-key rejection, and final cleanup. The
> review also fixed transaction notification behavior: intermediate transaction statements no longer flush reactive
> subscribers, successful COMMIT/ROLLBACK flush once, and a failed ROLLBACK cannot leave later autocommit notifications
> permanently suppressed.
>
> The privacy-safe artifact is
> `android/app/build/reports/db-contract/android-db-contract-2026-08-19T20-21-45-109Z.json` (ignored under `/android`),
> with all **11/11** finite checks true. Focused host tests pass **6 suites / 116 tests**; the harness tests pass
> **12/12**; the hostile-driver scanner matrix passes **1/1**; and the full adversarial scanner passes **86/86** in
> **529.594s**. Inventory is **1,113 / 1,113 proved (971 coordinated + 142 temporal) / 0 unproven**, with structural,
> membership, nested-owner, and reconciliation checks clean. The complete Jest gate passes **404 suites / 4,450 tests
> / 0 snapshots**. Independent review is GO. The child is **DONE**.
>
> Parent `DB-01` and `DB-03` remain **IN_PROGRESS**. At this DB-01B checkpoint, the local DEV result was same-process
> close/reopen evidence for a tiny disposable schema; it did not run the 38 production migrations, prove process
> death/relaunch, touch the production database, cover crash/power loss, or replace exact release-candidate and
> physical-device evidence. DB-03A below supersedes only that migration-path gap.

> **DB-03A-ANDROID-MIGRATION-CONTRACT UPDATE (2026-08-19):** The finite DEV database marker is now schema V2 and
> runs the exact production `runMigrations(opRunner(handle))` path only against fixed disposable
> `driver-selftest.db`. A deliberate `0030` index-name conflict proves that the failed migration leaves neither its new
> table nor a ledger row, while already committed `0001`–`0029` remain. After a same-process close/reopen, an audited
> head-`0029` fixture exercises exact `0030`–`0038`: tombstone-ledger backfill, legacy error-report purge, local
> scheduled-send retirement with server/control preservation, exact legacy-setting purge, and valid reaction-payload
> scrub with malformed and non-reaction controls preserved. A third exact runner call is empty.
>
> The same native run verifies the production `messages_fts` insert/update/delete triggers and `MATCH`, an empty
> `foreign_key_check`, `integrity_check = ok`, and all retained DB-01B rollback/reactive, three-route Drizzle, rekey,
> key-specific reopen, wrong-key rejection, and cleanup checks. The privacy-safe API-35 arm64 artifact is
> `android/app/build/reports/db-contract/android-db-contract-2026-08-19T21-44-08-558Z.json`, with schema **2**,
> migration count **38**, head `0038_scrub_reaction_selected_message_text`, and all **17/17** finite checks true.
>
> Focused runtime tests pass **3 suites / 100 tests**; the ADB harness passes **13/13**; the pinned migration guard
> passes **1 suite / 5 tests**; and TypeScript passes. The fast scanner passes **80 tests + 6 intentional full-only
> skips**, the hostile V2 mutation passes **1/1** in **233.425s**, and the full adversarial scanner passes **86/86**
> in **623.426s**. The reviewed inventory retires three obsolete ad-hoc-schema writes, carries one replacement
> production-schema `handles` fixture seed, and adds 27 V2 writes: net **+24**, for **1,137 / 1,137 proved (971
> coordinated + 166 temporal) / 0 unproven**. Structural, membership, nested-owner, and reconciliation checks are
> clean. Architecture passes **30/30**, the full migration guard passes **5/5**, and the complete Jest gate passes
> **404 suites / 4,452 tests / 0 snapshots** in **111.749s**. The child is **DONE**; parent `DB-01` and `DB-03` remain
> **IN_PROGRESS**.
>
> This is per-migration rollback/retry and same-process close/reopen evidence for the current 38-migration registry and
> one audited head-`0029` fixture on a debuggable emulator—not whole-chain atomicity. It does not prove true process
> death/relaunch, every historical pre-`0029` or shipped database state, abrupt crash/power loss, the production
> database file, scheduled CI, or exact release-candidate/physical-device behavior.

> **DB-03B1-ANDROID-PROCESS-RELAUNCH UPDATE (2026-08-19):** A separate DEV-only lane claims foreground boot before
> production work and uses only fixed `driver-relaunch-selftest.db` plus four zero-byte phase files. Process A opens
> the encrypted database, commits exact `0001`–`0029`, verifies deliberately rolled-back `0030` and a continuity
> sentinel, then emits READY while its native handle remains retained. The harness ties READY to A, force-stops the
> package, observes no process, and requires a numerically different process B.
>
> B first opens the existing encrypted state with `readOnly: true` and verifies the exact head-`0029` ledger,
> sentinel, and absent rolled-back `0030` table before any read-write reopen. It then applies exact `0030`–`0038`,
> verifies the full ledger, foreign keys, integrity and idempotency, and removes only the fixed database/phase state.
> Interrupted, malformed, or orphaned phase states fail closed with finite codes and bounded recovery. The privacy-safe
> API-35 arm64 artifact is
> `android/app/build/reports/db-relaunch/android-db-relaunch-2026-08-20T02-09-52-914Z.json`, with all **7/7 prepare**,
> **12/12 resume**, and **3/3 host** checks true at 38/head `0038`.
>
> Focused Jest passes **3 suites / 37 tests**; the harness passes **22/22**; the fast scanner passes **81 + 7
> intentional skips**; and the required full scanner rerun passes **88/88** in **840.708s** after one stale older
> hostile assertion was narrowed from all throwaway delegations to its exact V2 target. The reviewed inventory adds 17
> fixed-file writes and 12 exclusive DEV handoffs: **1,166 / 1,166 proved (971 coordinated + 195 temporal) / 0
> unproven**, with structural, membership, nested-owner, and reconciliation checks clean. Independent review is GO.
>
> Architecture passes **30/30** including both live guards; migrations pass **5/5** across 38 migrations at head
> `0038`; and pinned Node 24 full Jest passes **406 suites / 4,479 tests / 0 snapshots** in **61.736s**. The child is
> **DONE**. This is controlled two-PID force-stop/relaunch state-continuity evidence, not inode identity or spontaneous
> OS-death proof. Parent DB-03B remains **OPEN**; DB-03B2 still owns reviewed repository heads
> `0024`/`0027`/`0029`, active-write/migration crash and power-loss recovery, the production database, scheduled CI,
> and exact release-candidate/physical-device evidence. Parent `DB-01` and `DB-03` remain **IN_PROGRESS**.

> **DB-03B2A-REPOSITORY-HEAD-MATRIX UPDATE (2026-08-20):** A host provenance test pins the complete migration
> prefixes at `0024`, `0027`, and `0029` to three full reviewed Git commit objects and proves they equal the current
> canonical prefixes. Because the repository has no release tags or retained historical APK/AAB/database samples,
> this establishes three reviewed repository logical heads—not Play/store distribution provenance.
>
> Schema V3 keeps the existing audited `0029` path and sequentially constructs encrypted logical `0024` and `0027`
> fixtures in fixed disposable `driver-history-selftest.db`. Each earlier fixture stops at its exact boundary, proves
> the next migration rolled back, closes, rejects a wrong key, verifies unchanged state through `readOnly: true`,
> reopens read-write, and applies the exact tail through `0038`. Ledger/data transforms, production FTS5
> insert/update/delete triggers, foreign keys, integrity, idempotence, and cleanup pass. The V3 aggregate
> `historicalReadOnly` and wrong-key checks cover `0024`/`0027`; `0029` read-only/process continuity remains the
> separate DB-03B1 evidence.
>
> The privacy-safe API-35 arm64 artifact is
> `android/app/build/reports/db-contract/android-db-contract-2026-08-20T05-04-33-795Z.json`, with schema **3**, 38
> migrations at head `0038_scrub_reaction_selected_message_text`, and all **28/28** exact checks true. Focused Node 24
> Jest passes **4 suites / 110 tests**; the host harness passes **35/35**; and independent source/artifact/privacy
> review is GO.
>
> The optimized fail-closed scanner preserves the exact 39-finding boundary and passes its pinned Node 24 full
> adversarial matrix **90/90** in **996.036s**. Manual inventory review adds 39 throwaway temporal exclusions:
> **1,205 / 1,205 proved (971 coordinated + 234 temporal) / 0 unproven**, with structural, membership, nested-owner,
> and reconciliation checks clean. TypeScript and repository lint pass; architecture passes **30/30** over 65 core
> files; migrations pass **5/5** at 38/head `0038`; formatting/diff passes 13 touched source/test files; and pinned
> Node 24 full Jest passes **407 suites / 4,487 tests / 0 snapshots** in **129.711s**. The child is **DONE**.
>
> This is same-process logical-fixture evidence, not an old signed-app install-over or retained historical database.
> Parent DB-03B and `DB-03` remain **IN_PROGRESS** for abrupt write/migration death, WAL/power-loss recovery,
> production `gator.db`, scheduled CI, actual historical/release artifacts, and exact
> release-candidate/physical-device evidence.

> **DB-03B2B1-ACTIVE-WAL-WRITE-DEATH UPDATE (2026-08-20):** A third mode in the existing single DEV relaunch
> dispatcher uses only fixed disposable `driver-wal-write-death-selftest.db` and distinct zero-byte
> request/preparing/ready/resuming markers. Process A commits an exact baseline in WAL mode, requires a successful
> `wal_checkpoint(TRUNCATE)`, begins `BEGIN IMMEDIATE`, writes and verifies a bounded multi-page uncommitted canary,
> and emits READY while the transaction and encrypted handle remain open. The host binds READY to A, observes the
> physical WAL grow beyond its header, invokes exact `adb shell am crash <PID A>`, proves the no-process gap, and launches
> a distinct process B.
>
> B's first database open is `readOnly: true` and must prove the exact committed baseline row set with every
> uncommitted canary absent; there is no read-write recovery fallback. Only then does B reopen read-write, pass
> integrity and foreign-key checks, commit one recovery row, close, and reopen read-only to prove the exact two-row
> state. The first device gate correctly failed its unchanged pre-fallback absence check because WAL and SHM remained
> after the main-file delete. The bounded correction runs only after the final read-only proof: it requires an exact
> zero-work WAL checkpoint, confirms `journal_mode=DELETE`, closes, deletes the fixed main file, and leaves the
> unchanged host gate to prove the database, journal, WAL, SHM, and four scenario markers all absent.
>
> The privacy-safe API-35 arm64 artifact is
> `android/app/build/reports/db-wal-write-death/android-db-wal-write-death-2026-08-20T16-46-24-970Z.json`, with schema
> **1** and all **9/9 READY**, **12/12 final**, and **5/5 host** checks true. It postdates all seven runtime, service,
> harness, test, and package sources by **44.362s**. Pinned Node 24 focused Jest passes **3 suites / 53 tests**, the
> standalone host harness passes **31/31**, TypeScript reports no diagnostics, and independent runtime/harness/artifact
> review is GO. Final repository gates pass lint, architecture **30/30**, migrations **5/5** over 38 migrations at head
> `0038`, and full Jest **407 suites / 4,503 tests / 0 snapshots** in **142.18s**.
>
> The fail-closed certificate pins the fixed file/key, ordinary non-migration SQL shape and ordering, exact row sets,
> read-only-before-write recovery, cleanup retirement, scenario-specific durable state, single dispatcher, sole
> callers, and no capability escape. Its pinned full scanner matrix passes **92/92**. Manual inventory review adds 33
> direct throwaway writes and 13 exclusive DEV delegations: **1,251 / 1,251 proved (971 coordinated + 280 temporal) /
> 0 unproven**, with structural, membership, nested-owner, and reconciliation checks clean. The child is **DONE**.
>
> This proves only one controlled shell-induced crash of an ordinary active WAL write on a local debuggable emulator.
> Parent DB-03B2B, DB-03B, `DB-03`, and `DB-01` remain open or **IN_PROGRESS** for `DB-03B2B2` active-migration
> crash, power-loss/torn-write recovery, production `gator.db`, actual historical signed/store provenance,
> spontaneous or uncontrolled process death, scheduled CI, and exact release-candidate/physical-device evidence.

> **DB-03B2B2-ACTIVE-MIGRATION-DEATH UPDATE (2026-08-21):** A fourth mode in the existing single DEV relaunch
> dispatcher uses only fixed disposable `driver-active-migration-death-selftest.db`, never `gator.db`, and distinct
> zero-byte request/preparing/ready/resuming markers. Process A constructs the exact production ledger through head
> `0037`, commits an exact 133-row fixture containing 128 bounded spill targets and five controls, enables WAL, and
> requires a successful truncate checkpoint. A private exact-SQL wrapper observes the production runner begin migration
> `0038`, awaits its real `UPDATE`, and proves the exact migrated in-transaction rows while the ledger remains exactly at
> `0037`. It enters the non-settling READY callback before returning, so the runner cannot begin its ledger insert or
> commit.
>
> The host binds READY to process A, requires the WAL to exceed its header, invokes exact
> `adb shell am crash <PID A>`, proves the no-process gap and that the WAL still exceeds its header, then launches a
> distinct B. B's first database open is `readOnly: true` and proves the exact head-`0037` ledger and original 133-row
> fixture. Only then does B reopen read-write, pass integrity and foreign-key checks, apply exact `[0038]`, prove the
> exact head-`0038` ledger and migrated data, prove idempotency, reopen read-only for persistence, retire WAL, and leave
> the unchanged host pre-fallback gate to prove all eight scenario database, sidecar, and marker paths absent.
>
> The privacy-safe API-35 arm64 artifact is
> `android/app/build/reports/db-active-migration-death/android-db-active-migration-death-2026-08-21T09-05-01-344Z.json`,
> with schema **1**, 38 migrations at head `0038_scrub_reaction_selected_message_text`, and all **11/11 READY**,
> **15/15 final**, and **6/6 host** checks true. Pinned Node 24 focused Jest passes **3 suites / 70 tests**, and the
> standalone host harness passes **36/36**. TypeScript and repository lint pass; architecture passes **30/30** over 65
> core files with the single reset/claim/handoff owner; migrations pass **5/5** over 38 migrations at head `0038`.
> The authoritative pinned Node 24.19.0 full Jest run under `caffeinate` with `--runInBand --no-cache` passes **407/407
> suites / 4,520/4,520 tests / 0 snapshots**. Its raw reported **2,519.353s** duration is host-clock contaminated and is
> not performance evidence.
>
> The fail-closed certificate pins the fourth file/key, exact `0038` SQL and post-return/pre-ledger callback boundary,
> exact 37/38-entry ledgers and 133-row states, read-only-before-write recovery, both WAL observations, retirement,
> scenario-specific durable state, single dispatcher, sole callers, and no capability escape. Its exact certificate
> passes **4/4**, its hostile matrix passes **17 cases**, its fast matrix reports **84 pass / 10 skip**, and its pinned
> full scanner passes **94/94** in **1,179,132.309ms**. Manual review adds 34 direct throwaway writes and 15 exclusive
> DEV delegations: **1,300 / 1,300 proved (971 coordinated + 329 temporal) / 0 unproven**, with structural, membership,
> nested-owner, and reconciliation checks clean. The child is **DONE**.
>
> This proves only one controlled shell-induced crash after migration `0038`'s `UPDATE` resolved inside its open
> transaction and before its ledger insert/commit on a local debuggable API-35 emulator. It is not statement-in-flight
> evidence. Parent DB-03B2B, DB-03B, `DB-03`, and `DB-01` remain open or **IN_PROGRESS** for power-loss/torn-write
> recovery, production `gator.db`, actual historical signed/store provenance, spontaneous or uncontrolled process
> death, scheduled CI, and exact release-candidate/physical-device evidence.

## Current Codex audit — Claude-built repository, 2026-08-03–05

**Verdict:** Claude produced a strong foundation, not a rewrite candidate. The central ideas are
good: an offline-first encrypted database, typed domain models, one HTTP authentication boundary,
one realtime event router, a platform-free core, and a durable outgoing queue. The weakness was
uneven finishing at system boundaries. Several features looked complete in JavaScript tests while
their Android, process-death, hostile-input, privacy, or account-switch behavior was unproved or
unsafe. That is why this remediation keeps the architecture and hardens its edges.

The authoritative, item-by-item implementation plan is
[`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md). It includes acceptance criteria,
release disposition, ordering, and verification for every current finding. The older tables below
remain a historical Flutter-parity snapshot and must not be used as present status.

**Current privacy direction:** `DEC-10` is complete and supersedes the table's former recommendation to keep expanding a
configurable Redacted Mode. The completed containment and removal slices remain useful regression evidence; no
configurable mode state, UI, runtime API, or branch remains. Phases 2A–2E restored ordinary detailed rendering in `ContactSuggestionList`, `SearchResultsView`,
`ReplyQuote`, `PinnedGrid`, `MessageRow`, `ReactionDetailsSheet`, `EditHistorySheet`, `MessageDetailsSheet`, and
`IncomingFaceTimeOverlay`, plus ordinary shared-media previews and links in `MediaSections`; any table wording that those
leaves still fail closed is historical. Phase 2F removes the mode dependency from `PairingQr` while preserving its
default-hidden, exact-payload, lifecycle-revoked explicit reveal. Phase 2G restores ordinary detailed conversation-action
titles and header identity/avatar/Details output while retaining account-owned mutations and the generic Delete prompt.
Phase 2H restores ordinary detailed conversation-tile identity, preview, accessibility, and avatar output while retaining
row-instance account leases, account-scoped swipe mutations, memoization, and the generic Delete prompt.
Phase 2I restores ordinary detailed iMessage-account identity/status/alias presentation while retaining generation-keyed
queries, original-account ownership, stale-result suppression, tracked alias mutation, and guarded result/error cleanup.
Phase 2J restores ordinary scheduled-list bodies, accessibility, and editor navigation while retaining original-account
sync/cancel ownership, tracked history deletion, stale-result/error suppression, and exact internal IDs.
Phase 2K restores ordinary reminder previews, times, accessibility, and actions while retaining the mounted original-
account lease across picker and service boundaries, stale-result/error suppression, and exact row bindings.
Phase 2L restores the ordinary Scheduled editor while retaining exact route/database loading, the mounted original-account
lease across picker and Save boundaries, stale-result/error suppression, fixed dialogs, and failure-without-navigation.
Phase 2M restores ordinary per-chat wallpaper URI/chrome rendering while retaining the mounted original-account lease and
stable list/composer/callback identities across reactive wallpaper-source changes.
Phase 2N restores ordinary Find My identity/location rows, validated source-namespaced marker/focus data, and explicit
encoded system-map actions while retaining no-WebView `WEB-02` containment, polling, and store-generation reset ownership.
Phase 2O restores ordinary Thread Sheet content and navigation while retaining a generic controlled-open lifetime, the
original account lease, account-invalidation close/dedupe, tracked DB read/drain, and exact originator/result/action checks.
Phase 2P restores ordinary Location Card filename/finite-coordinate output and map/download actions while retaining a
generic exact-source lifetime, original-account ownership, bounded parse publication, finite geo validation, and manual-
download lease propagation; any table wording that `LocationCard` still fails closed is historical.
Phase 2Q restores ordinary Contact Card vCard identity, accessibility, native-open, and download behavior while retaining
a generic exact-source lifetime, original-account invalidation, bounded parse publication, token-owned native outcomes,
and lease-bound missing-file re-download; any table wording that `ContactCard` still fails closed is historical.
Phase 2R restores ordinary fullscreen Media Viewer URI/blurhash/counter/carousel/action rendering while retaining exact-
route and original-account ownership, route/page lifetimes, cache pin/refusal/release, protect-before-player ordering, and
stale native-result suppression; any table wording that the fullscreen Media Viewer still fails closed is historical.
Phase 2S restores ordinary Server Management identity/status/statistics/origin/sync/action/log presentation while retaining
generation-keyed account reads, reactive account retirement, original-lease actions, tracked restart/log drain, stale-
result/error suppression, and the pairing QR's independent explicit reveal; any table wording that Server Management still
fails closed under Redacted Mode is historical.
Phase 2T restores ordinary MessageBubble content, accessibility, nested actions, and attachment/sticker/reaction children
while retaining exact cached-URL adoption, text-only/no-network preview containment, safe external URL opening, hidden
plugin-attachment filtering, and child-owned native/cache boundaries; any table wording that MessageBubble or ReplyQuote
still fails closed under Redacted Mode is historical.
Phase 2U restores ordinary Server Health diagnostics, alerts, RCS state, accessibility, and actions while retaining ten
generation-keyed account reads, monotonic reactive account retirement, a fixed generic stale-account tree, original-lease
Refresh, and tracked Clear/RCS result/error ownership; any table wording that Server Health still fails closed under
Redacted Mode is historical.
Phase 2V restores ordinary New Chat drafts, recipients, contacts, staged media, transport, existing-chat shortcut, and
form actions while retaining captured-account retirement, exact recipient/effect ownership, protected handoff pins, and
original-lease create/send/result publication; any table wording that New Chat still fails closed under Redacted Mode is
historical.
Phase 2W restores ordinary Chat Settings identity, media/link rows, customization, group actions, notification settings,
and picker flows while retaining outer captured-account retirement, a GUID-keyed mount lifetime, exact-source callbacks
and result publication, serialized picker ownership, guarded external-link routing, and source-aware notification settings;
any table wording that Chat Settings or `MediaSections` still fails closed under Redacted Mode is historical.
Phase 2X removes the Settings Redacted control and About masking while retaining ordinary exact current-account app/server
details, monotonic account retirement, App Lock, explicit sanitized error-report consent, and account-owned destructive,
key-rotation, and Contacts actions; any table wording that Settings About still fails closed under Redacted Mode is
historical.
Phase 2Y removes the root Redacted store subscription, notification-privacy coordinator, and obsolete dialog plumbing
while retaining one foreground boot entry, the App Lock gate, and connected per-run notification maintenance; any table
wording that the root layout still coordinates Redacted Mode is historical.
Phase 2Z deletes the uncalled standalone notification-privacy coordinator and its direct test while retaining root boot,
App Lock, Notifee, and the headless notification privacy gate; the deleted coordinator itself has no remaining residue.
Phase 2AA removes bootstrap preview seeding while retaining guarded critical Feature/Sync hydration before delivery
admission, durable account/DB/cache/session ownership, and sync/realtime startup; realtime-control, hydration/Redacted
stores, notification-preview state, Notifee branches, and the headless privacy gate remained live at that checkpoint.
Phase 2AB removes realtime-control's mode hydration, preview seeding, and presentation gate while retaining fail-closed
message-feature consent with durable retry, FaceTime behavior, unknown-sender filtering, stale delivery-context rejection,
DB-first notification derivation, and App Lock's independent generic boundary; the Redacted store/hydration registry,
notification-preview state, headless privacy gate, and Notifee mode branches/tests remained live at that checkpoint.
Phase 2AC deletes the now-uncalled untracked headless privacy gate and its obsolete direct suite while preserving root boot,
App Lock, Notifee, realtime feature/durable ownership, and DB-first notification behavior; the Redacted store/hydration
registry, notification-preview state, and Notifee mode branches/tests remained live at that checkpoint.
Phase 2AD removes Notifee's mode-preview branches and the untracked preview-state module while restoring the owner-chosen
detailed ordinary notification presentation. App Lock's generic locked-delivery boundary, legacy payload/channel and
route-ID migration, reminder repair, serialized native-operation/account ownership, guarded DB handoffs, and teardown
containment remain. The Redacted store/hydration registry and other runtime consumers remained live at that checkpoint,
and the intent source/test still contained stale mode-preview wording.
Phase 2AE removes the Redacted store from shared hydration and critical-readiness admission while retaining exact
Theme/Feature/Sync hydration, critical Feature+Sync activation, Theme fallback, guarded failure propagation, and Home's
original-account hydration barrier. The now-unused store, its tests/resets, persisted backup key, and stale intent wording
remained at that checkpoint.
Phases 2AF/2AG remove the obsolete Redacted test setup/assertions and then delete the tracked, runtime-uncalled store while
retaining ordinary MessageList/session-reset and Sync/Feature/Theme/hydration/boot protections. The ignored persisted
backup key, compatibility/migration fixtures, dead Find My helper, and stale comments remained after those phases.
Phases 2AH/2AI remove the retired key from backup export/import compatibility and transactionally purge its exact persisted
KV row while preserving supported backup settings, restore ownership, unrelated rows, rollback/retry, and migration
allocation safeguards. Phases 2AJ–2AT then remove or rename the remaining mode-only helper/API/test artifacts and correct
stale source/test/`AGENTS.md` contracts; the NUL-bearing stale test filename remains only as a documented ordinary-test
artifact. Only intentional legacy-key migration/backup negatives and independent secure log/error redaction remain.
This completed decision does not remove App Lock, explicit pairing-QR reveal, account isolation, or stale-result protection.

| Area                 | What Claude chose well                                                                                                                                           | What needed improvement / current direction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture         | DB-as-source-of-truth, strict TypeScript, Zod validation, repositories by domain, injected native crypto/vault interfaces, centralized event normalization.      | Composition and session ownership were spread across long-lived singletons. Ordered boot, production adapters, durable-session handoff, single-flight coordination, bounded waits/cleanup, and UI wiring are now host-implemented and host-green; the platform-free `src/core` rule is enforced automatically. `REL-007` remains open for exact-device cold/warm, locked, retry, process-death, and TalkBack evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Database             | SQLCipher, migrations, FTS, reactive reads, durable outgoing work, and careful tombstone semantics are sound choices.                                            | One op-sqlite connection plus a process-wide transaction mutex is fragile: nesting wedges all writes and an uncoordinated write can join another transaction. Scheduled claim/recovery and schedule→outgoing ownership are now atomic and statically guarded on host. A bounded encrypted alias ledger retains the newest 4,096 learned temp→real deletion identities through row purge and clears them on account wipe. The inventory still has 491 deliberately unproven entries, and real-driver/process-kill stress remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Security             | OS TLS validation, SecureStore/Keystore secrets, XChaCha20-Poly1305, Argon2id, central auth injection, redacting logger, and schema validation are appropriate.  | Several attacker-controlled paths trusted JavaScript callbacks after native bytes had already been consumed. The current source now uses an owned actual-byte-capped native download stream; JSON responses are byte-capped while streaming. Automatic previews, embedded remote map code, and unsafe ACTION_SEND/Direct Share stay disabled until containment is proved in the rebuilt candidate. App Lock remains honestly described as a UI/policy gate, not biometric key custody.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Privacy              | Redacted Mode and encrypted message storage were good product instincts.                                                                                         | Notifications, logs, files, backups, diagnostics, Recents, and accessibility labels did not share one complete privacy model. Message-search titles/snippets/highlight fragments, including before privacy hydration, contact suggestions, chosen-recipient chips, Account identity/status/aliases, the pairing QR, Settings' automatic server identity-value rows, Server Management's status/statistics/origin-share/log-modal surface, Server Health's diagnostic/action surface, Scheduled list/editor bodies, saved-reminder message previews, the long-press conversation-action heading/Delete prompt, ordinary conversation-tile identity/avatar/swipe-Delete output, chat-header identity/photo/Details output, pinned-grid identity/photo/GUID-host-prop output, Conversation Details' identity/media/member/editor subtree, the fullscreen Media Viewer's URI/blurhash/player/action surface, chat-wallpaper URI/chrome, the app-global incoming FaceTime caller-name/action-ownership surface, active-chat MessageBubble content/native-child/fresh-long-press output, precise LocationCard filename/coordinate/parser/native-action output, active-chat MessageRow sender/event/avatar/current-swipe output, Reaction Details' reactor/custom-emoji subtree/open state, Edit History's revision/date/part subtree/open state, Message Details' sender/service/timestamp subtree/open state, Thread Sheet's reply-count/sender/body/attachment/timestamp/query/action/open-state surface, Contact Card's vCard identity/parser/native-action lifecycle, and New Chat's recipient/query/message/staged/suggestion/existing-chat/Start host/accessibility plus retained-action/async/account/handoff lifecycle now fail closed without mounting raw identity/content values in their rendered/native-accessibility subtrees. New Chat preserves unfinished work in JavaScript for confirmed opt-out; a fully successful create plus optional attachment send that loses its privacy grant instead consumes the submitted form and aggregate handoff pins. Raw values may still remain in process/upstream props; the selected data/refs for Reaction Details, Edit History, and Message Details may remain until parent closure commits; ThreadSheet can retain loaded same-account rows locally across an ordinary dismissal; raw reaction, `message_summary_info`, selected message, and thread rows continue to exist in the DB and upstream MessageList/JavaScript state; raw vCard/parsed values can remain upstream or in JavaScript; raw search query/result rows can remain in JavaScript/search hooks while the parent search input and exact result timestamps remain visible and generic hits retain exact navigation; and raw New Chat drafts, recipients, staged attachment metadata/file names, contact-search results, and handoff/stat work may remain or continue in JavaScript. These are rendered/accessibility boundaries, not no-fetch/no-memory claims. Deterministic tile/pinned/message-row avatars remain correlatable; audio-versus-video call type, reminder time, tile service/time/unread/mute metadata, plus pinned count/order/unread presence and message timestamps/status/reaction spacing remain visible. Contact Card's sole current MessageBubble parent already unmounts attachment leaves while hidden, so that child is leaf/future-reuse defense. Already-open Composer reply/message-action/selection state, in-progress native swipe timing, exact native Reaction Details/Edit History/Message Details/Thread Sheet modal teardown or hardware-Back timing, sibling attachment cards, OS notification/full-screen caller presentation, an OS picker/share/settings surface already opened before privacy, an already-admitted save/call/download/map operation, admitted Contact Card read/open/download work, an admitted uncapped Thread Sheet SELECT that drains rather than cancels and may delay Disconnect, Contact Card host removal pending parent unmount/next rerender after account invalidation, same-account arbitrary-unmount/native-intent/cache lifecycle, active-chat Composer reply/drafts/staged media, admitted New Chat create/send work that cannot be recalled, consumed New Chat pins that rely on route unmount after later account invalidation, create-success/`sendImages`-failure retry/idempotency ambiguity, exact IME/native transition timing, exact Recents/TalkBack behavior, and the remaining device sweep stay open. New/unhydrated reporting defaults off with versioned consent, abort/purge behavior, and bounded retention; whether a legacy stored opt-in counts as prior informed consent still needs an owner decision. Device proxy/storage proof and a final Play Data Safety cross-check remain required. |
| Reliability          | Durable send retry, event deduplication, FCM/socket convergence, and best-effort degradation are valuable.                                                       | Fresh-process background bootstrap, process death, account A→B races, and fire-and-forget startup were under-specified. The worker now reads durable vault/lock/revocation state, caps each wake by work count, gives each headless attachment retry a 60-second deadline, and uses one recovery barrier plus an atomic scheduled→queue handoff. Whole-wake budgeting, killed-process/op-sqlite proof, native cancellation, and exact-device timing remain release work. Lossless missed-deletion catch-up still needs a server continuation and snapshot-consistent first cursor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Packages             | Expo Router, Zustand, FlashList, Zod, Drizzle, op-sqlite/SQLCipher, React Query, and Expo modules fit the app. Critical native versions are now pinned.          | The stack has two owned compatibility liabilities: the Drizzle↔op-sqlite adapter and the notify-kit fork. They are acceptable only behind tests/adapters and explicit replacement triggers. The CI workflow is configured to check lockfile audits, immutable actions, clean Expo prebuild, local Kotlin compilation, APK/AAB packaging, and final artifact contents; hosted enforcement remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Features             | The core messaging loop is broad: compose, sends/retries, replies, reactions, edits/unsends, attachments, search, contacts, reminders, themes, and server tools. | Breadth sometimes arrived before lifecycle and hostile-input proof. Remaining product work includes capability-gated alias selection, device-proven background scheduling with truthful timing copy, richer document/media journeys, folders, internationalization, and server-coordinated features where local emulation cannot provide the same guarantee. `PARITY-01` now requires an explicit implement/defer/drop owner for every remaining app/server mismatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Design/accessibility | Reusable theme tokens, conversation primitives, iOS-inspired interaction, and increasing role-based tests are a solid base.                                      | An iOS visual language on Android still must respect Android keyboard, Back, permissions, notifications, font scaling, TalkBack, reduced motion, contrast, tablets/foldables, and system bars. Automated contrast/layout work has improved, but the physical accessibility/device matrix remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Highest remaining risks

1. **Production-artifact and physical-device proof:** The current source snapshot has a successful local debug APK,
   debug-signed release-variant AAB, and packaged manifest/resource/DEX inspection with the CI Firebase fixture.
   Production signing/configuration, hosted enforcement, and target-device SQLCipher/op-sqlite behavior, bounded
   download/paste cancellation, notifications, keyboard insets, and killed-process tasks remain unproved. Inbound
   ACTION_SEND/Direct Share is deliberately absent; hostile-provider proof applies only before that feature can be
   re-enabled and to the separate foreground composer-paste path that remains available.
2. **Headless reliability:** vault-based, Zustand-independent bootstrap and bounded schedule/outgoing
   drains now exist in code, including a 60-second deadline per headless attachment retry. Remaining risk is a
   whole-wake wall-clock budget, killed-process WorkManager proof, observed retry/timing behavior, and Android
   proof that native cancellation and late settlement behave as designed.
3. **Database coordination:** the shared-connection mutex rules are load-bearing and should
   eventually become harder to misuse by construction.
4. **Lossless deletion catch-up:** the current client safely stops on an ambiguous 500-row timestamp tie, but only a
   server continuation plus snapshot-consistent initial cursor can prevent starvation or first-sync skips.
5. **Release truthfulness:** licensing/third-party notices, privacy/Data Safety answers, store
   claims, rollout ownership, and candidate-specific evidence must close before public release.

### Bottom line

Claude made mostly defensible technology choices and delivered substantial feature breadth. The
main issue was confidence: too many boundaries were considered finished when only the happy-path
TypeScript layer had been exercised. The remediation plan therefore favors containment, boring
owned adapters, bounded inputs, explicit account ownership, and evidence from the exact Android
artifact rather than a rewrite or a package-fashion overhaul.

---

## Historical 2026-06-20 Flutter-parity snapshot (frozen)

> **STATUS UPDATE (2026-06-30):** Re-verified against the current code — most findings are now
> RESOLVED. The one CRITICAL item (F-1, no compose/new-chat) is fully built (`app/(app)/new-chat.tsx`
>
> - FAB + `POST /chat/new`); group management (F-2), Find My refresh calls (F-13), the server
>   contacts endpoint (F-10), and ESLint-in-CI + Firebase boot guard (CS-1/CS-3/CS-4) are all DONE.
>   Still genuinely open: multi-alias send (F-6), server-synced settings backup (F-11),
>   sticker-render / video-fullscreen / Android share-intent (F-14), and `allowBackup`/legacy-query
>   hygiene (SEC-5/6). Test/file counts below are historical (as of 2026-06-30: **104 suites / 532 tests**).
>   Everything below is the ORIGINAL 2026-06-20 snapshot.
>
> **Superseded for current feature/parity status by** [`docs/OLD_APP_PARITY_AUDIT_2026-07-15.md`](./docs/OLD_APP_PARITY_AUDIT_2026-07-15.md) **and** [`docs/GITHUB_ISSUES_FEATURE_AUDIT_2026-07-15.md`](./docs/GITHUB_ISSUES_FEATURE_AUDIT_2026-07-15.md) **(2026-07-15).** This file is retained as the 2026-06-20 baseline; where it disagrees with those, trust the newer audits and the code. (Note: SEC-1's `requireAuthentication: true` recommendation was later explicitly decided _against_ by design — see `src/native/secureVault.ts` — so it is closed, not open.)

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
header + socket `auth`; permissive bad-cert acceptance → standard OS TLS validation;
`usesCleartextTraffic` true → false). The at-rest posture moved from AES-256-CBC + unsalted-MD5-KDF
to XChaCha20-Poly1305 + Argon2id + full-DB SQLCipher with **crash-safe key rotation**, and the code
quality (strict TS, a genuinely pure `core/` boundary, 345 tests, a CI-enforced redaction logger) is
well above the original.

**The gaps are at the edges, not the center.** The messaging _loop_ (send/receive, edit/unsend,
replies, tapbacks, typing, receipts, effects, attachments, search, reminders, redacted mode) is solid
and tested. But there is **no way to start a new conversation** (critical), no audio/voice/document
support, group management has endpoints but no UI, and several features are local re-implementations
of server-backed Flutter ones (scheduled messages, contacts, backup).

**Top priorities:** (P0) ship a compose/new-chat flow; close the link-preview **SSRF**; add a crash
guard around the now-top-level Firebase import; bind the headless-push DB-open to the app-lock.

| Severity    | Count |                                                                                                                      |
| ----------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| 🔴 Critical | 1     | No new-chat creation flow                                                                                            |
| 🟠 High     | 9     | compose-adjacent gaps, audio/voice/doc, group UI, send-method, scheduled, app-lock key custody, Firebase boot import |
| 🟡 Medium   | ~18   | SSRF, encrypted-FCM drop, server panel, themes, contacts, backup-sync, no-ESLint, EventRouter silent-drop, …         |
| ⚪ Low/Info | ~48   | parity polish + verified-fixed + strengths                                                                           |

---

## 2. Security

### 2.1 ✅ Verified fixed (the original Flutter issues)

| #   | Original Flutter weakness                                    | RN status                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | Credentials in plaintext SharedPreferences                   | **Fixed** — `ExpoSecureVault` over Keystore-backed expo-secure-store; non-secret prefs in the encrypted SQLCipher `kv` table; no plaintext store exists (`src/native/secureVault.ts`, `src/core/secure/vault.ts`).                                                    |
| S-2 | Auth token in the URL query (~20 sites + socket)             | **Fixed** — `Authorization: Bearer <pw>` (single injection point) + socket `auth` payload; tests assert `searchParams.has('guid') === false` (`src/core/api/http.ts`, `socketService.ts`).                                                                            |
| S-3 | `badCertificateCallback` accepted any cert on the host       | **Fixed** — no TLS bypass anywhere; HTTPS uses ordinary Android/OS certificate validation, without application-level pinning.                                                                                                                                         |
| S-4 | `usesCleartextTraffic="true"` app-wide                       | **Fixed** — `false` in the release manifest via expo-build-properties; `sanitizeServerAddress` prepends https. _(2026-07-17: OBSOLETE — now deliberately `true` for direct-LAN servers, gated by an app-layer default-deny "Allow insecure" toggle; see top banner.)_ |
| S-5 | Exported receiver gated by a plaintext-password `==` compare | **Hardened** — rotating Keystore token + constant-time compare + default-deny allowlist (`src/core/secure/intents.ts`).                                                                                                                                               |
| S-6 | AES-256-CBC + unsalted single-iteration MD5 KDF              | **Fixed** — XChaCha20-Poly1305 AEAD + Argon2id, versioned envelope, device-verified (`src/native/crypto.ts`, `src/core/crypto/`).                                                                                                                                     |

### 2.2 ⚠️ Residual / new security findings

| #     | Sev     | Finding                                                                                                                                                                                                                                                                                                                         | Evidence                                                           | Recommendation                                                                                                                                      |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-1 | 🟠 High | **App-lock is a JS gate, not OS key custody.** Keystore items use only `keychainAccessible: WHEN_UNLOCKED` (iOS-only / no-op on Android); no `requireAuthentication`, so the SQLCipher key + server password are readable by the app process with no biometric binding. The headless-FCM path opens the DB ignoring lock state. | `src/native/secureVault.ts:10-12`; `src/services/index.ts:136-145` | Set `requireAuthentication: true` on `dbEncryptionKey` (and `serverPassword`) when app-lock is on; gate the headless DB-open on lock.               |
| SEC-2 | 🟡 Med  | **SSRF in the auto link-preview fetch.** `fetchOgMetadata` GETs the first URL in a _received_ message on bubble render, following redirects, with no private-IP/host allowlist — a sender can make the recipient hit `169.254.169.254`, `192.168.x`, `localhost`.                                                               | `src/services/urlPreview.ts:79-99`; `useUrlPreview.ts`             | Reject loopback/link-local/private hosts before fetch **and after each redirect**; restrict to ports 80/443; stream-cap the body; add an SSRF test. |
| SEC-3 | 🟡 Med  | **Encrypted FCM payloads silently dropped.** The FCM parser ignores the `encrypted/partial/encoding` envelope Flutter honors, so an encrypted push fails schema validation and is dropped with no log.                                                                                                                          | `src/services/notifications/fcmPayload.ts:14-19`                   | Decode the envelope (decrypt when `encrypted`); at minimum log dropped pushes (see CS-3).                                                           |
| SEC-4 | 🟡 Med  | **`Authorization: Bearer <pw>` value not redacted** when logged as a raw string (the redactor scrubs the _key_ `authorization`, not a bare header value).                                                                                                                                                                       | `src/core/secure/redact.ts:12-32`; `http.ts:87-96`                 | Add a `Bearer <token>` value pattern to the redactor.                                                                                               |
| SEC-5 | ⚪ Low  | **Legacy `?guid=` query-auth + plaintext-JSON backup import paths remain** (dead in production, but present).                                                                                                                                                                                                                   | `http.ts:104-110`; `backupService.ts:97-99`                        | Remove or feature-gate behind an explicit "legacy server" setting.                                                                                  |
| SEC-6 | ⚪ Low  | **`allowBackup="true"`** + debug-variant cleartext (hygiene). The PRAGMA-rekey key is string-interpolated (safe today — CSPRNG hex only).                                                                                                                                                                                       | `AndroidManifest.xml:24`; `src/db/key.ts:81`                       | Set `allowBackup="false"`; pin the hex-only invariant with a comment at the interpolation site.                                                     |

---

## 3. Missing features & parity gaps (vs. Flutter)

| #    | Sev             | Gap                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                          |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| F-1  | 🔴 **Critical** | **No new-chat / compose flow at all** — no compose FAB, no contact/handle picker, no `POST /chat/new`, no iMessage-vs-SMS selection. You cannot start a conversation.                                                                                                                                                                                                                                     | `chats.ts` (no `/chat/new`); `home.tsx` (no compose); Flutter `chat_creator.dart` |
| F-2  | 🟠 High         | **Group management is endpoint-only** — `updateParticipant`/`renameChat` exist but have zero call sites; only _Leave_ is wired in chat-settings.                                                                                                                                                                                                                                                          | `chats.ts:42,54`; `chat-settings/[guid].tsx`                                      |
| F-3  | 🟠 High         | **No audio playback** — audio attachments (incl. voice memos) fall to a plain FileChip; no player/waveform/scrubber. No `expo-audio` in deps.                                                                                                                                                                                                                                                             | `AttachmentView.tsx:31`                                                           |
| F-4  | 🟠 High         | **No voice-memo recording** — composer has no mic/record affordance.                                                                                                                                                                                                                                                                                                                                      | `Composer.tsx`                                                                    |
| F-5  | 🟠 High         | **No document/any-MIME picker** — picker is images-only (the send pipeline is already MIME-agnostic).                                                                                                                                                                                                                                                                                                     | `chat/[guid].tsx:223-228`                                                         |
| F-6  | 🟠 High         | **No multi-account/alias send** — no way to choose the sending handle; `imessage-aliases-removed` is parsed then dropped.                                                                                                                                                                                                                                                                                 | `sendService.ts`; `dbEventSink.ts:70-72`                                          |
| F-7  | 🟠 High         | **Send method hardcoded `private-api`** — no `apple-script` fallback, so on a server without the private API every send fails instead of degrading. No SMS-vs-iMessage send choice.                                                                                                                                                                                                                       | `messages.ts:46`                                                                  |
| F-8  | 🟠 High         | **Scheduled messages are local-only, no recurrence** — fired by an on-device worker, not the server `/scheduled` API; a sleeping phone sends late/never.                                                                                                                                                                                                                                                  | `scheduleService.ts:20-27`                                                        |
| F-9  | 🟡 Med          | **No server-management panel** (restart server/iMessage/PrivateAPI, manual sync, logs, update check, QR sync, custom headers, multi-URL failover). Only Disconnect + read-only About.                                                                                                                                                                                                                     | `settings.tsx:215-239`; `server.ts`                                               |
| F-10 | 🟡 Med          | **Contacts sync is device-only** — no server/iCloud contact fetch.                                                                                                                                                                                                                                                                                                                                        | `contactsService.ts:18-47`                                                        |
| F-11 | 🟡 Med          | **Backup is local-file only** — no server-synced settings/theme backup.                                                                                                                                                                                                                                                                                                                                   | `backupService.ts`                                                                |
| F-12 | 🟡 Med          | **Themes: 4 fixed presets** — no in-app custom-theme creation/editing UI (DB layer + import exist), no Material You/Monet.                                                                                                                                                                                                                                                                                | `tokens.ts`; `settings.tsx:101-123`                                               |
| F-13 | 🟡 Med          | **Find My: no embedded map** (geo: URL fallback); the refresh-location endpoints are implemented but never called.                                                                                                                                                                                                                                                                                        | `findmy.tsx:9-12`; `findmyStore.ts:90-108`                                        |
| F-14 | 🟡 Med          | **No sticker rendering** (DB flag stored but never read by any UI); **fullscreen viewer is image-only** (videos never open fullscreen); **no Android share-intent** receiver.                                                                                                                                                                                                                             | `attachment.ts:16`; `media/[guid].tsx:59-66`                                      |
| F-15 | ⚪ Low          | Smart replies are a regex rule-engine (not ML Kit); no cross-chat notification group; binary mute (vs Flutter's 4 mute modes) + no custom avatar; subject stored but never rendered; live-photo motion not played (badge only); attributed text = mentions/attachments only (no bold/italic); reply = quote+jump (no thread view); no GIF picker; downloads have progress+retry but no HTTP-range resume. | various                                                                           |

---

## 4. Code smells & tech debt

| #    | Sev     | Smell                                                                                                                                                                                                                                                                                                                  | Evidence                                        | Fix                                                                                                    |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CS-1 | 🟠 High | **Lazy-native-import discipline broken for Firebase.** AGENTS.md forbids top-level native imports on the startup path, yet `app/_layout.tsx` statically imports `startFcm`, whose module calls `messaging().setBackgroundMessageHandler` at eval — **no try/catch**, so a misconfigured Firebase project crashes boot. | `app/_layout.tsx:13,44`; `fcmMessaging.ts:1,27` | Wrap firebase access in try/catch → degrade to socket-only; isolate the unavoidable top-level handler. |
| CS-2 | 🟡 Med  | **`GAP_ANALYSIS.md` is stale and now contradicts the code** (says FCM disabled / firebase absent; reality: enabled + wired + `google-services.json` present).                                                                                                                                                          | `GAP_ANALYSIS.md` §1                            | Refresh or retire it; point to this report.                                                            |
| CS-3 | 🟡 Med  | **EventRouter silently discards every unrecognized/invalid event** — no logging at all, so dropped pushes/socket events are invisible.                                                                                                                                                                                 | `eventRouter.ts:45-51,68-106`                   | Log (redacted) the event name + reason on the default/failed-validation path.                          |
| CS-4 | 🟡 Med  | **9 `eslint-disable` directives but ESLint is not installed or run in CI** — `react-hooks/exhaustive-deps` bugs go uncaught; UI/hooks have essentially no automated test coverage.                                                                                                                                     | no eslint in `package.json`/CI                  | Add ESLint (react-hooks) + a CI lint step; add RN Testing Library coverage for hooks/screens.          |
| CS-5 | 🟡 Med  | **`dev.local` dev session bypasses the entire production send/reply/react path** — a jest-green-hides-device-bug seam (like the crypto-AAD bug that was caught).                                                                                                                                                       | `chat/[guid].tsx:74,…`                          | Add a thin integration test or a staging path that exercises real services.                            |
| CS-6 | ⚪ Low  | `repositories.ts` is a **1596-line / 70-export god-module**; `isDev()` copy-pasted in 5+ files; `connectToServer`'s rich failure-kind enum is discarded by callers; migrations hardcode `applied_at=0`.                                                                                                                | `repositories.ts`; `findmyStore.ts:82` et al.   | Split repositories by domain; extract a shared `isDev()`; surface the failure kind.                    |

### Genuine strengths (for balance)

A React-free, node-importable `src/core/` boundary; TS `strict` + `noUncheckedIndexedAccess` + only
6 `as unknown` / 1 `any` / 0 `@ts-ignore` in the tree; offline-first DB-as-source-of-truth; a single
zod-validated `HttpClient`; a CI-grep-enforced redacting logger; a crypto **contract test** that
round-trips the real wiring (and already caught the AAD jest-vs-device divergence); crash-safe DB-key
rotation; fully parameterized SQL with FTS input tokenized (no injection).

---

## 5. Inert until a native rebuild / credential (not bugs — pending activation)

FCM push (enabled + wired; needs the firebase native build + server-side Firebase) · the hardened
automation-intent gate (JS core done; **exported native receiver
not built**) · Find My embedded map (needs a Google **Maps** API key + `react-native-maps`) · Sentry
(needs a DSN). Tracked in `RELEASE_CHECKLIST.md` + project memory.

---

## 6. Prioritized recommendations

**P0 — usability & security blockers**

1. **F-1 Compose/new-chat flow** — contact/handle picker + `POST /chat/new` + iMessage/SMS toggle. Without it the app can't start a conversation.
2. **SEC-2 Link-preview SSRF** — host/redirect allowlist + port restriction + streamed size cap.
3. **CS-1 Firebase boot guard** — try/catch around the top-level firebase access.
4. **SEC-1 App-lock key custody** — `requireAuthentication` on the DB key + gate the headless DB-open on lock.

**P1 — high-value parity & robustness** 5. F-3/F-4/F-5 audio playback + voice recording + document picker (one native-rebuild batch). 6. F-2 group-management UI (rename + add/remove). F-7 send-method fallback. F-6 alias send. 7. SEC-3 encrypted-FCM handling + CS-3 EventRouter logging + SEC-4 Authorization redaction.

**P2 — parity polish & hygiene** 8. F-8 server-side scheduled API + recurrence; F-9 server-management panel; F-12 custom-theme UI; F-13 Find My map. 9. CS-4 ESLint + CI lint; CS-6 split `repositories.ts`; CS-2 refresh/retire `GAP_ANALYSIS.md`.

---

_Method: parallel auditors over both repos, each citing RN `file:line` and the Flutter counterpart;
findings verified against the code before assertion. Full structured output in the session transcript._
