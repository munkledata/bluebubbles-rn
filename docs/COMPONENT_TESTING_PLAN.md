# Component Testing Plan — jest-expo + React Native Testing Library

**Goal:** add automated UI component tests to Gator RN, alongside (never replacing) the existing
Node-only jest suite. Chosen over Maestro/Detox because it needs no emulator (this dev machine is
RAM-constrained) and reuses the existing jest toolchain.

**How to use this document:** each phase below is a self-contained work order for one agent.
Run the phases **in order** — each has a verify gate, and later phases depend on earlier ones.
Copy the entire "Agent prompt" block (plus the Shared Context section) into the agent. Do not
run two phases in parallel; within Phase 3, the per-component batches CAN run in parallel since
they only add independent test files.

---

## Shared context (paste into EVERY agent prompt)

> ### Project context — Gator RN
> - Repo: `/Users/munkle/github/bluebubbles-rn`. A React Native (Expo SDK 57, RN 0.86,
>   React 19) + TypeScript iMessage client, Android-only, iOS-styled. Read `AGENTS.md` at the
>   repo root FIRST — it is the authoritative gotcha list and its instructions override defaults.
> - Existing tests: 122 suites / ~700 tests, ALL Node-only via ts-jest (`jest.config.js`,
>   `testEnvironment: 'node'`, tests in `test/**/*.test.ts`). They test `src/core`, `src/db`
>   (against in-memory better-sqlite3 via `test/support/testDb.ts`), `src/services`, `src/state`,
>   and pure utils. **These must keep passing untouched — never edit an existing test to make
>   new work fit.**
> - Component tests (this project) live in `test/components/**/*.test.tsx` and run under a
>   SEPARATE jest project using the `jest-expo` preset. `.test.ts` = Node project,
>   `.test.tsx` = component project — the extension is the routing rule.
> - Path aliases: `@core`, `@db`, `@ui`, `@utils`, `@state/*`, `@features/*`, `@native/*`,
>   `@/*` → `src/*` (see `jest.config.js` moduleNameMapper and `tsconfig.json`).
> - Verify commands (BOTH must be green before you claim done, show the output):
>   `npm run typecheck` and `npm test`.
> - Style: strict TS (`noUncheckedIndexedAccess`), no raw `console.*` (use `logger` from
>   `@core/secure` — but tests generally shouldn't log at all), comments only for constraints
>   the code can't express.
>
> ### Hard constraints for component tests
> 1. **Never import real native modules in a test path.** `@op-engineering/op-sqlite`,
>    `react-native-notify-kit` (a stub exists at `test/__mocks__/notifee.ts`, mapped in `jest.config.js`; the mock file name is intentionally kept), Firebase,
>    `react-native-libsodium`, `jail-monkey`, `react-native-ssl-public-key-pinning` have no
>    native half in jest. jest-expo auto-mocks most `expo-*` packages; for the rest add
>    `moduleNameMapper` entries or `jest.mock()` in the test file.
> 2. **`@db/database` throws off-device.** Any store/component that hydrates from the DB needs
>    `jest.mock('@db/database', () => ({ getDatabase: jest.fn() }))` (see
>    `test/state/themeStore.test.ts` for the established pattern).
> 3. **Components read theme via `useTheme()`** — they throw outside a `ThemeProvider`
>    (`src/ui/theme/ThemeProvider.tsx`). Always render through the `renderWithTheme` helper
>    (created in Phase 1, at `test/components/support/renderWithTheme.tsx`).
> 4. **`__DEV__` is undefined under ts-jest but DEFINED under jest-expo.** Don't "fix" either
>    side; the guard pattern `typeof __DEV__ !== 'undefined' && __DEV__` in src is intentional.
> 5. **FlashList v2** rows are usually better tested by rendering the ROW component directly
>    with props than by mounting the whole list. If a list must mount, mock
>    `@shopify/flash-list` to a plain map-over-data renderer.
> 6. **Query priority:** `getByText` / `getByRole` / `getByLabelText` over testIDs. Add a
>    `testID` to src only when there is no user-visible handle, and keep such src edits minimal
>    and mechanical. Any other src change (refactor, prop change, bug fix) is OUT OF SCOPE —
>    if a component seems untestable or buggy, STOP and report it instead of changing it.
> 7. Component tests assert **behavior a user could observe** (text, a11y state, fired
>    callbacks, style-driven visibility), not implementation details (state internals,
>    private functions). Snapshot tests are banned — they rot.
> 8. macOS is case-insensitive: never create a test file whose name differs from an existing
>    file only by case (TS1261).

---

## Phase 0 — Toolchain: second jest project + smoke test

**Outcome:** `npm test` runs BOTH projects; a trivial `.test.tsx` renders RN `<Text>` and
passes; all ~700 existing tests still pass; typecheck passes.

**Design decisions (already made — implement, don't relitigate):**
- Convert `jest.config.js` to the multi-project form. Project 1 (`displayName: 'node'`) is the
  EXACT current config moved into `projects[]` (same testMatch `**/*.test.ts`, same
  moduleNameMapper, same ts-jest transform + `tsconfig.test.json`, `testEnvironment: 'node'`,
  `clearMocks: true`). Project 2 (`displayName: 'components'`) uses `preset: 'jest-expo'`,
  `testMatch: ['<rootDir>/test/components/**/*.test.tsx']`, the same path-alias
  moduleNameMapper, plus the notifee mapping.
- Root-level options that don't belong in a project (e.g. coverage settings) stay top-level.
- Install with `npx expo install jest-expo` so the version matches SDK 57, and
  `npm i -D @testing-library/react-native` (plus `react-test-renderer` at the EXACT installed
  React version if RNTL requires it — check the RNTL v13+ docs for React 19 first; do not
  guess versions, and consult https://docs.expo.dev/versions/v57.0.0/ for the SDK's
  testing guidance).
- jest-expo's preset includes `transformIgnorePatterns` for RN/Expo packages — keep its
  defaults; extend (don't replace) if a package fails to transform.
- TS: `.test.tsx` files must typecheck. `tsconfig.test.json` already sets `"jsx": "react-jsx"`;
  extend `types` with the RNTL/jest-native types if needed. `npm run typecheck` covers the
  whole repo — it must stay green.

**Agent prompt:**

```
[paste Shared Context here]

TASK — Phase 0 of docs/COMPONENT_TESTING_PLAN.md: set up the jest-expo component-test project.

1. Read AGENTS.md, jest.config.js, tsconfig.test.json, package.json.
2. Install: `npx expo install jest-expo`, then `npm i -D @testing-library/react-native`
   (and react-test-renderer pinned to the exact installed react version ONLY if the installed
   RNTL major requires it — read node_modules/@testing-library/react-native/package.json
   peerDependencies to decide).
3. Rework jest.config.js into the two-project form described in the plan's Phase 0 design
   decisions. Preserve every existing option of the Node project byte-for-byte in behavior.
4. Create test/components/smoke.test.tsx: render <Text>hello</Text> with
   @testing-library/react-native's render(), assert getByText('hello') exists.
5. Verify and SHOW OUTPUT: `npm run typecheck` clean; `npm test` runs both projects,
   existing suite count still all-passing plus the new smoke test; `npx jest smoke` alone
   also works. If jest-expo needs a babel config the repo lacks, add the minimal standard
   one (babel-preset-expo) and re-verify.
6. Report: exact versions installed, every file changed and why, any deviation from the plan.

Do NOT touch any file under src/ in this phase. Do NOT edit existing tests.
```

---

## Phase 1 — Test harness: renderWithTheme + shared mocks

**Outcome:** a reusable render helper + mock kit so component tests stay one-screen simple.

**Deliverables:**
- `test/components/support/renderWithTheme.tsx`: wraps RNTL `render()` in `ThemeProvider`
  (read `src/ui/theme/ThemeProvider.tsx` first — it hydrates `useThemeStore`, which calls
  `getDatabase()`, so the helper must pre-seed the store: set
  `useThemeStore.setState({ hydrated: true, ... })` in the helper, and reset state between
  tests). Export `renderWithTheme(ui, { preset?: PresetKey })` and re-export RNTL's helpers
  (`screen`, `fireEvent`, etc.) so tests import ONE module.
- Shared `jest.mock` setup for the component project (a `setupFilesAfterEnv` entry in the
  components project, e.g. `test/components/support/setup.ts`) mocking `@db/database`
  and any native module jest-expo does not auto-mock. Keep the mock surface MINIMAL — add
  mocks lazily when a phase actually needs them, not speculatively.
- One proving test: `test/components/theme.test.tsx` renders a small consumer of
  `useTheme().color.*` under two different presets and asserts the rendered colors differ
  (use the preset tokens from `src/ui/theme/tokens.ts` as the expected values).

**Agent prompt:**

```
[paste Shared Context here]

TASK — Phase 1 of docs/COMPONENT_TESTING_PLAN.md: build the component-test harness.
Phase 0 is already merged (jest-expo project exists; smoke test passes).

1. Read src/ui/theme/ThemeProvider.tsx, src/ui/theme/tokens.ts, src/state/themeStore.ts,
   and test/state/themeStore.test.ts (the @db/database mock pattern).
2. Build the deliverables listed under "Phase 1" in the plan doc exactly.
3. The helper must leave zustand stores clean between tests (reset in afterEach via the
   setup file) — leaked store state between tests is the #1 flakiness source.
4. Verify and SHOW OUTPUT: typecheck + full npm test green; the new theme.test.tsx proves
   both presets render distinct colors.
5. Report files added/changed and the final helper API signature.

Do NOT modify src/. Do NOT add mocks beyond what these deliverables need.
```

---

## Phase 2 — First real batch: pure primitives

**Outcome:** tests for the leaf components with no store/native dependencies. These validate
the harness before the harder targets.

Targets (all in `src/ui/primitives/`): `ServiceBadge` (renders the right label/color per
service — cross-check expectations with `resolveChatService` semantics in `src/utils/chat.ts`),
`Avatar` + `GroupAvatar` (initials derivation, `accessible={false}` per AGENTS.md,
participant collage collapse — see `dedupeParticipants` in `src/utils/chat.ts`), `Bubble`,
`Button` (onPress fires; disabled state doesn't). Plus `src/ui/ErrorBoundary.tsx`: a child
that throws → fallback UI renders (literal colors, no theme) and the screen doesn't crash;
note it needs a console.error silencer inside the test (React logs caught errors).

**Agent prompt:**

```
[paste Shared Context here]

TASK — Phase 2 of docs/COMPONENT_TESTING_PLAN.md: test the pure primitives.
Phases 0–1 are merged: use test/components/support/renderWithTheme.tsx for everything
except ErrorBoundary (which must render WITHOUT the theme provider — that's the point).

1. Read each target component fully before writing its tests:
   src/ui/primitives/{ServiceBadge,Avatar,GroupAvatar,Bubble,Button}.tsx and
   src/ui/ErrorBoundary.tsx. Derive expected values from the SOURCE (and the referenced
   utils), never from guesses.
2. One test file per component under test/components/primitives/ (ErrorBoundary at
   test/components/errorBoundary.test.tsx). 3–8 focused tests each: happy path, the edge
   cases the component's own comments call out, and a11y where AGENTS.md specifies it
   (avatars are accessible={false}).
3. Verify and SHOW OUTPUT: typecheck + full npm test green.
4. Report: per component, what behavior is now locked in, and anything that looked buggy
   (report, don't fix).
```

---

## Phase 3 — Behavior components (parallelizable batches)

**Outcome:** tests for the components where regressions actually hurt. Each batch below is
independent — safe to hand to parallel agents AFTER Phase 2 is merged.

- **Batch A — conversation row:** `ConversationTile` (title via `resolveTitle`, unread state,
  pinned, service badge, redacted-mode masking via `useRedactedModeStore` — seed the store
  directly with `setState`).
- **Batch B — message rendering:** `MessageBubble` + `ReactionCluster` + `ReplyQuote`
  (text runs incl. mentions from `@core/richtext`, edited label, tombstone, send-error state;
  render the bubble directly, not through MessageList). Respect AGENTS.md: effect animations
  must be cleaned up on unmount — assert the component unmounts without the "update on
  unmounted" warning under jest fake timers.
- **Batch C — composer surface:** `SmartReplyChips` (chips render from suggestions, tap fires
  callback), `UrlPreviewCard` (renders title/site as plain text — no HTML interpretation),
  `TypingBubble`.
- **Batch D — dialogs/overlays:** `AppDialog` driven end-to-end through `dialogStore`
  (`src/ui/dialog/dialogStore.ts`): showing sets text, confirm/cancel callbacks fire and close.

**Agent prompt template (fill in the batch line):**

```
[paste Shared Context here]

TASK — Phase 3, Batch <X> of docs/COMPONENT_TESTING_PLAN.md: <batch description verbatim
from the plan>.
Phases 0–2 are merged: renderWithTheme + store-reset setup exist under
test/components/support/. Mirror the style of the Phase 2 tests in test/components/.

1. Read every target component AND the stores/utils it consumes before writing tests.
2. Seed zustand stores with useXStore.setState(...) — never mock the store module itself.
3. Drive interaction with fireEvent/user-event; assert observable output only.
4. If a component needs a native/Expo module that is not yet mocked, add the SMALLEST
   possible mock to the shared setup and note it in your report.
5. Verify and SHOW OUTPUT: typecheck + full npm test green.
6. Report: behaviors locked in per component; any suspected bug (report, don't fix);
   any mock added.
```

---

## Phase 4 — Regression guards for documented gotchas

**Outcome:** tests that encode the hard-won AGENTS.md UI lessons so they can't silently
regress:

1. **Memo contract** (AGENTS.md "React.memo on a list row is INERT unless…"): render
   `MessageRow` via a parent with a `useCallback` handler; count child renders (wrap with a
   probe component incrementing a counter ref); assert a parent re-render with unchanged
   message props does NOT re-render the row, and a changed message DOES.
2. **Effect cleanup on recycle:** mount/unmount `BubbleEffectView` (or MessageBubble with an
   `expressiveSendStyleId`) under fake timers; assert no pending animation callback fires
   after unmount (no act() warnings, no leaked timers via `jest.getTimerCount()`).
3. **Redaction end-to-end:** with `useRedactedModeStore` enabled, ConversationTile +
   MessageBubble render masked content (no real message text in the tree).

**Agent prompt:** same shape as Phase 3's template with these three items as the task list;
allow adding a tiny render-count probe helper to `test/components/support/`.

---

## Acceptance criteria for the whole effort

- `npm test` green: all pre-existing Node tests + new component tests in one run.
- `npm run typecheck` green.
- No `src/` behavior changes; only additive `testID`s if truly unavoidable (each one
  justified in the report).
- Component project total runtime under ~90s on this machine.
- Final doc touch: add a short "Component tests" subsection to AGENTS.md's verify section
  (`npm test` now covers both projects; `.test.tsx` under test/components = jest-expo world;
  gotchas: __DEV__ IS defined there, stores reset via the setup file). Have the LAST agent
  (Phase 4) do this.

## Known risks (tell every agent)

- **Version alignment is the #1 setup risk:** jest-expo must match Expo SDK 57 and RNTL must
  support React 19. Resolve from the installed packages' own peerDependency declarations and
  the SDK 57 docs, not from memory.
- jest-expo may pull its own `jest` peer expectations; if the existing jest@29 conflicts,
  STOP and report options rather than force-resolving.
- Some components may turn out to import a native module at module top-level; the fix is a
  test-side mock, never restructuring src (report if a mock feels too heavy).
- Watch for open-handle warnings (timers, animations) — they make CI hang; `clearMocks` +
  fake timers where animations are involved.
