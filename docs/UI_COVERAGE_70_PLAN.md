# UI Coverage → 70% Plan

**Goal:** raise statement coverage of `src/ui/**` from the measured baseline **23.3%
(547/2347)** to **≥ 70%**, using the existing two-project jest setup (node + jest-expo
components). Successor to `docs/COMPONENT_TESTING_PLAN.md` (all 4 phases of which are merged:
harness, primitives, behavior components, regression guards — 141 suites / 807 tests green;
that count is a plan-time snapshot — the suite has grown well past it since).

## The metric contract (the ONLY number that counts)

Coverage instrumentation differs between the ts-jest and babel/jest-expo projects, so
per-project runs report different statement totals. The target is defined by exactly this
command, run over BOTH projects (node tests of pure `src/ui/**/*.ts` logic count too):

```bash
npx jest --coverage --collectCoverageFrom='src/ui/**/*.{ts,tsx}' \
  --collectCoverageFrom='!src/ui/**/index.ts' \
  --coverageReporters=json-summary --coverageReporters=text --silent
node -e "const t=require('./coverage/coverage-summary.json').total.statements; \
  console.log(t.pct+'% ('+t.covered+'/'+t.total+')'); process.exit(t.pct>=70?0:1)"
```

Barrel `index.ts` re-export files are excluded (covering them is import-graph noise, not
verified functionality). Do not "reach" the number by importing barrels or rendering
components without assertions — every test must assert user-observable behavior.

## Budget math (uncovered statements per file, combined metric)

Needed: ~1,100 newly covered statements. Assume tests realistically capture ~80% of a
file's statements (error branches etc. remain), so scope must total ~1,375 uncovered
statements. The waves below sum to ~1,440, plus a contingency backlog of ~360.

| Wave / batch | Files (uncovered stmts) | Budget |
|---|---|---|
| 1a | Composer (192), AttachmentTray (105) | 297 |
| 1b | MessageList (127), ConversationListScreen (119), PinnedGrid (18), SwipeableRow (18), PullToRefresh (18) | 300 |
| 1c | AttachmentView (67), ImageAttachment (116), FileChip (33), ProgressRing (10) | 226 |
| 1d | ContactCard (67), LocationCard (65), SearchResultsView (67) | 199 |
| 2a | MessageActionsOverlay (43), FailedMessageSheet (14), ChatActionsSheet (33), ConversationHeader (45) | 135 |
| 2b | ScreenEffectOverlay (30), EffectPicker (15), ChatThemeProvider (15), EdgeFade (7), LoadErrorBoundary (14) | 81 |
| 2c | IncomingFaceTimeOverlay (33), FaceTimeCallOverlay (23), FaceTimeWebView (15), pickDateTime (31) | 102 |
| 2d (node project) | editableTokens.ts (30), adaptiveFromImage.ts top-up (75) | 105 |
| Contingency | VoiceRecorder (97), VideoPlayer (68), AudioAttachment (53), ThemeStudio (40), FindMyMap (24), misc top-ups | ~360 |

**Explicitly out of scope regardless:** on-device-only behavior (expo-video released-player
crash, real recording, FCM). If a contingency file's native mock becomes a mock-testing-a-mock
exercise, skip it and take a different contingency item — the 70% number must be made of
honest tests.

## Orchestration

- **Wave 1** = 4 agents in parallel (batches 1a–1d). **Wave 2** = 4 agents in parallel
  (2a–2d). All batches only ADD test files, so waves are independent; run Wave 2 after
  Wave 1 merges to pick up lessons. **Wave 3** = orchestrator measures with the metric
  command; if < 70%, hand contingency items (largest first) to 1–2 more agents; repeat.
  Finish with the full gate: `npm run typecheck` + `npm test` + the metric command.
- Every agent verifies with `npm run typecheck` + its OWN test files only (`npx jest <files>`);
  the orchestrator runs the full suite and the metric between waves.

## Shared context (paste into EVERY agent prompt)

> ### Project context — Gator RN
> - Repo: /Users/munkle/github/bluebubbles-rn. React Native (Expo SDK 57, RN 0.86, React 19)
>   + TypeScript. Read AGENTS.md FIRST — including its "Component tests (jest-expo + RNTL)"
>   subsection, which records the environment gotchas as hard rules.
> - Two jest projects (jest.config.js): 'node' (ts-jest, `.test.ts`) and 'components'
>   (jest-expo preset, `test/components/**/*.test.tsx`). The extension routes the file.
> - Harness: `test/components/support/renderWithTheme.tsx` — `renderWithTheme(ui, { preset? })`
>   (ASYNC — always await) re-exporting all RNTL helpers. Shared setup already mocks
>   `@db/database` and resets the theme store. Exemplars to mirror:
>   test/components/conversations/conversationTile.test.tsx (store seeding, in-file service
>   mock), messageBubble.test.tsx (in-file `@ui/attachments` mock — the real module pulls `ky`,
>   an untransformed ESM package), typingBubble.test.tsx (Animated spy pattern),
>   appDialog.test.tsx (driving a real zustand store).
> - Hard-won environment rules (violating these costs hours):
>   1. RNTL 14 / React 19: `render()`/`cleanup()` are async — await them. After fireEvent use
>      `findBy*`/`waitFor`, never a bare `getBy*` for state-driven updates.
>   2. Store mutations on mounted trees: `await act(async () => …)`. Reset stores in
>      `beforeEach`, NOT `afterEach`.
>   3. Unmount assertions: wrap unmount in `await act(async () => { unmount(); })`.
>   4. NEVER assert `jest.getTimerCount() === 0` — the jest-expo Animated mock leaves
>      residual frame-loop timers. Measure a baseline in-situ or spy start/stop.
>   5. `__DEV__` IS defined under jest-expo.
>   6. Seed real zustand stores with `useXStore.setState(...)`; never mock a store module.
>      Mock HOOKS (e.g. data-fetching hooks) when data arrives via a hook rather than props.
>   7. Timing discipline: prefer `findBy*` with generous behavior-anchored waits over sleeps;
>      dialog-style suites have flaked under coverage instrumentation when they cut timing fine.
>
> ### Concurrency rules (other agents work in this repo simultaneously)
> - Touch ONLY your own new test files in your assigned paths. Do NOT edit
>   test/components/support/*, jest.config.js, existing tests, or anything under src/ —
>   zero exceptions. Extra mocks: `jest.mock()` INSIDE your own test files.
> - If a component needs a src change or testID to be testable, do NOT make it — report it
>   and test what you can. If a component looks buggy, report, don't fix.
> - macOS case-insensitive FS: no file differing from an existing one only by case.
>
> ### Quality bar
> - Read each target component's SOURCE fully first; derive expectations from it and the
>   utils/stores it consumes. Assert user-observable behavior (text, roles, a11y labels,
>   fired callbacks, resolved styles via StyleSheet.flatten). No snapshot tests. Every test
>   must assert something — coverage without assertions is banned.
> - Verify and SHOW output: `npm run typecheck` (clean) + `npx jest <your files>` (green).
>   Do NOT run the full suite (the orchestrator does).
> - Final message = orchestrator report: behaviors locked in per component, in-file mocks
>   added, suspected bugs (report only), deviations.

## Batch work orders

### 1a — Composer + AttachmentTray (`test/components/conversations/composer.test.tsx`, `attachmentTray.test.tsx`)
The highest-value untested surface. Read src/ui/conversations/Composer.tsx +
AttachmentTray.tsx fully; identify their props/store/hook dependencies and mock ONLY what
imports natively (pickers, camera). Cover at minimum: typing enables/disables send; send
fires with trimmed text and clears the field; the send-with-return feature flag
(useFeatureSettingsStore, real store via setState); reply banner render + dismiss; edit-mode
prefill/confirm/cancel; staged-attachment chips render + remove; audio/voice affordance
visibility. Component may need `@/services` / `@ui/attachments`-style in-file stubs — mirror
the exemplars.

### 1b — Lists (`test/components/conversations/messageList.test.tsx`, `conversationListScreen.test.tsx`, `pinnedGrid.test.tsx`, `swipeableRow.test.tsx`, `pullToRefresh.test.tsx`)
Mock `@shopify/flash-list` in-file to a plain map-over-data renderer (FlashList v2 renders
nothing meaningful in jest). MessageList: chronological order, date separators, sender-name
visibility rules, the stable-callback row binding (don't duplicate messageRowMemo.test.tsx —
that guard exists). ConversationListScreen: pinned rows split into PinnedGrid vs the list,
empty state, search field filtering callback; mock its data hooks (e.g. useChats) in-file —
they hit the reactive DB. SwipeableRow/PullToRefresh: render + callback contracts (gesture
simulation is limited — drive the exposed imperative/callback surface; partial coverage
accepted).

### 1c — Attachment rendering (`test/components/attachments/…` — new directory)
AttachmentView (the mime-type dispatcher → which child renders per attachment type),
ImageAttachment, FileChip, ProgressRing. ImageAttachment must encode the AGENTS.md rule:
the image swap is driven by the DB `localPath` (prop), while the progress ring is driven by
`downloadStore` (seed the real store) — and a store progress value alone must NOT swap the
image. FileChip: name/size/extension rendering (bytes formatting per src/utils/bytes.ts).
ProgressRing: progress→arc/label mapping.

### 1d — Data cards (`test/components/cards/contactCard.test.tsx`, `test/components/cards/locationCard.test.tsx`, `test/components/conversations/searchResultsView.test.tsx`) <!-- card tests landed under cards/, not the originally-planned attachments/ -->
ContactCard: name/phone rendering from vCard data (src/utils/vcard.ts has node tests — reuse
its fixtures' shapes), tap-to-add callback. LocationCard: place text from vlocation parsing,
open-map callback (mock expo-linking usage in-file if imported). SearchResultsView: result
rows render match context, tap navigates (callback), empty/no-results state.

### 2a — Chat chrome (`test/components/conversations/messageActionsOverlay.test.tsx`, `failedMessageSheet.test.tsx`, `chatActionsSheet.test.tsx`, `conversationHeader.test.tsx`)
MessageActionsOverlay: reaction row fires the right reaction type; action visibility rules
(edit/unsend only for own recent iMessage messages — derive the exact rules from source);
copy fires clipboard (mock expo-clipboard in-file). FailedMessageSheet: retry/delete
callbacks. ChatActionsSheet: per-action callbacks + visibility. ConversationHeader: title
via the same resolve semantics as the tile, back/avatar/call affordances fire callbacks.

### 2b — Effects & theming glue (`test/components/conversations/screenEffectOverlay.test.tsx`, `effectPicker.test.tsx`, `chatThemeProvider.test.tsx`, `edgeFade.test.tsx`, `loadErrorBoundary.test.tsx`)
ScreenEffectOverlay: MUST pin `pointerEvents="none"` (AGENTS.md: a touch-catching overlay
freezes chat scrolling) + auto-dismiss under fake timers + cleanup on unmount (spy pattern).
EffectPicker: renders the effect ids from src/core/effects/effectsMapper.ts, pick fires
callback. ChatThemeProvider: per-chat token override reaches a useTheme() consumer; null/absent
override falls through to the app theme (the async-arrival gotcha: same tree, styles flip).
EdgeFade: renders its gradient stops (cross-check src/ui/conversations/edgeFadeStops.ts).
LoadErrorBoundary: error → fallback + retry.

### 2c — FaceTime + picker (`test/components/facetime/…` — new directory; `pickDateTime` tests)
IncomingFaceTimeOverlay: caller name renders (and respects redaction if implemented — check
source), answer/decline fire the store/handler; drive the REAL faceTimeStore. FaceTimeCallOverlay:
render/dismiss contract. FaceTimeWebView: mock react-native-webview in-file; assert the URL/props
contract. pickDateTime (src/ui/conversations/pickDateTime.ts): mock
@react-native-community/datetimepicker's imperative API in-file; assert the future-clamp rule
(picked time floored to :00 must clamp to now+60s — the AGENTS.md TimestampTrigger gotcha).
`.test.tsx` under test/components/ so the RN import resolves via jest-expo.

### 2d — Node-project pure logic (`test/ui/editableTokens.test.ts`, extend `test/ui/adaptiveTheme.test.ts` coverage via a NEW file `test/ui/adaptiveThemeExtra.test.ts`)
Plain `.test.ts` (node project). editableTokens.ts: the editable-token catalog/mapping
functions. adaptiveFromImage.ts: the uncovered regions (per coverage: extraction fallbacks,
clamp/contrast helpers around lines 22-127/273-299 — read the file and target the untested
branches). Do NOT edit the existing adaptiveTheme.test.ts.

### Wave 3 — measure, contingency, close
1. Orchestrator: full `npm test` + typecheck + the metric command. If ≥ 70%: done.
2. If short: dispatch contingency files largest-first (VoiceRecorder, VideoPlayer,
   AudioAttachment, ThemeStudio, FindMyMap) as one agent per file, same rules; jest-expo
   auto-mocks many expo-* natives — if a file reduces to asserting mock echoes, skip it and
   report (honesty rule above).
3. Optionally harden the appDialog timing flake (findBy*/waitFor margins) — known one-off
   under coverage instrumentation.
4. Add an npm script `coverage:ui` running the metric command, and note the 70% status +
   command in AGENTS.md's component-tests subsection (final agent or orchestrator).

## Acceptance criteria
- Metric command reports **≥ 70%** statements for src/ui (barrels excluded).
- `npm run typecheck` and full `npm test` green; component project runtime stays under ~120s.
- No src/ changes (testIDs only if unavoidable, each justified); no edits to existing tests
  or harness files by batch agents.
- All suspected bugs found are listed in the final report (fixes are separate work).
