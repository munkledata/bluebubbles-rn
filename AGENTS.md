# Gator RN — concise agent instructions

Gator RN is an Android-only React Native/Expo rebuild of the Flutter iMessage client. Start with
`README.md`. The authoritative open-work tracker is `docs/WORK_PLAN_2026-08-03.md`; older plans and
`docs/DB_WRITE_SAFETY_AUDIT_2026-07-25.md` are historical context, not current status.

This file is deliberately short because it is loaded into every agent turn. Keep only stable,
actionable rules here. Put incident histories, detailed reasoning, and subsystem-specific procedures
in the relevant document under `docs/`, then link to it here if future agents must discover it.

## Lean working mode

- Work in verified milestones. A homogeneous proof-only batch may cover roughly 40–60 audit records;
  keep concurrency, native-effect, crypto, migration, or lifecycle changes closer to 20–30. Split
  implementation into focused steps, but update inventory/docs and run the full Jest gate once at
  the milestone end.
- Use focused tests, typecheck, and the relevant scanner/guard while iterating. Run broad architecture,
  migration, and full functional gates once after the candidate is frozen.
- Format every touched source/test file before the final scanner pass or inventory edit. Never freeze
  callback-fingerprint ids and then run a formatter that can rekey them.
- Run `npm run check:db-writes:fast` for ordinary DB-write milestones. Run
  `npm run check:db-writes:full` whenever scanner algorithms or certificate implementations change,
  when the incoming-ingress proof changes, and when closing parent `DB-02A`; the full command includes
  the intentionally slow adversarial ingress matrix. A reviewed path/ID data-only addition uses the
  fast scanner plus an exact-set test and does not require the unrelated ingress mutation sweep.
- Use one implementer by default. Add one independent reviewer only for concurrency, scanner,
  migration, crypto, native, or other high-risk changes.
- Do not produce per-file hash manifests, repeated historical narratives, or full raw command output
  unless reconciliation or a failure investigation requires them.
- Preserve the dirty worktree and unrelated user changes. Use `apply_patch` for edits.
- On a real failure, show the exact error and explain it before correcting it. After two failed
  correction attempts, stop and rethink the diagnosis.
- Before claiming completion, reread the diff skeptically and show concrete verification output.

## Read the relevant reference before editing

| Area                                 | Current references                                              |
| ------------------------------------ | --------------------------------------------------------------- |
| Frozen DB-02A handoff                | `docs/DB_02A_CURRENT.md`                                        |
| Session late-result ownership        | `docs/REL_004_LATE_RESULT_INVENTORY.md`                         |
| Session teardown barrier             | `docs/REL_005A_TEARDOWN_INVENTORY.md`                           |
| Authoritative plan and audit history | `docs/WORK_PLAN_2026-08-03.md`, `AUDIT_REPORT.md`               |
| Phase/release dependencies           | `docs/PHASE-DEPENDENCIES.md`, `RELEASE_CHECKLIST.md`            |
| App/server event and API parity      | `docs/APP_SERVER_PARITY.md`                                     |
| Device proof runbook and history      | `docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md`, `docs/DEVICE_VERIFICATION_CHECKLIST.md`, `docs/SPIKES.md` |
| Push/headless delivery               | `docs/PUSH_DELIVERY.md`                                         |
| Upload behavior                      | `docs/UPLOAD_PROGRESS.md`                                       |
| Attachment cache                     | `docs/CACHE_ARCHITECTURE.md`                                    |
| Share intake                         | `docs/SHARE_INTENT_RELIABILITY.md`                              |
| Session/account isolation            | `docs/SESSION_SCOPED_STATE_INVENTORY.md`                        |
| Historical UI-test rollouts           | `docs/COMPONENT_TESTING_PLAN.md`, `docs/UI_COVERAGE_70_PLAN.md` |

## Architecture contracts

- Expo SDK 57, React Native 0.86, React 19, strict TypeScript with
  `noUncheckedIndexedAccess`.
- `src/core/` is platform-free: no React, React Native, Expo, Zustand, native DB, feature, state,
  or UI imports. `npm run check:architecture` enforces this.
- The encrypted DB is the source of truth. UI observes it; network and eligible realtime events write
  through it. A locked FCM wake is the deliberate no-DB generic-notice exception.
- `HttpClient` is the only credential-injection boundary. Do not create another password transport.
- `EventRouter` is the only realtime normalization entry point. New server events require the
  constant, normalized variant, normalization case, and the appropriate injected sink.
- Path aliases are `@core`, `@db`, `@ui`, `@utils`, and their subpaths.

## Expo SDK 57 and native-module traps

- Use the exact SDK 57 docs: <https://docs.expo.dev/versions/v57.0.0/>.
- Root imperative APIs in `expo-contacts` and `expo-media-library` throw in SDK 57. Use their
  `/legacy` entry points where the app still uses imperative APIs.
- Metro cannot bundle `import(variable)`. Optional native modules must be dependency-injected so
  the bundle contains no reference until the native dependency exists.
- Native/config flag changes require a clean native rebuild. In particular, op-sqlite needs both
  `sqlcipher` and `fts5` enabled in `package.json`.
- Headless registrations must be imported by `index.js`, before `expo-router/entry`. Route modules
  such as `app/_layout.tsx` are not evaluated for a killed-app headless wake.

## Database safety

### One shared connection and one global writer queue

- `withDbTransaction` and `withDbWriteLock` share a process-wide mutex over one connection.
  Never call either one from inside itself or the other, directly or transitively. A nested call
  waits forever and blocks every later write.
- Many public repository helpers open their own transaction. Inspect the implementation before
  composing writers; do not infer safety from a harmless-looking call name.
- Run `node scripts/check-db-writes.mjs --report`. Every `nested-coordinator` finding is a defect,
  never an allowlist candidate.
- A write issued outside an owner while any transaction is open can silently join the other
  transaction. Put every dependent DB write inside the same short owner callback.
- Transaction callbacks must be DB-only and bounded. Do not hold the mutex across network, native
  filesystem, media, UI, timers, or unbounded row work.

### Transaction-only helpers

- A transaction-only helper accepts `DbTransactionContext`, not a raw database handle as proof.
  It must immediately return or await exactly one inline
  `runInTransactionContext(context, async (db) => { ... })`.
- The context is an opaque, runtime-checked token from the current `withDbTransaction` callback.
  Never cast/forge it, retain it, store it, return it, pass it to unrelated code, or capture the
  callback's raw `db` for later use.
- Join registration is synchronous. The owner closes joins when its callback settles, waits for all
  registered tasks, and rolls back on task failure or a late-join attempt.
- The scanner recognizes only the exact imported, inline, awaited/returned join. Named callbacks,
  dynamic dispatch, lookalikes, and unadopted promises fail closed.

### op-sqlite/Drizzle behavior

- Keep the `drizzleAdapter` Proxy in `src/db/database.ts`; Drizzle does not natively match
  op-sqlite v17's method/result shapes.
- Reactive queries need `flushPendingReactiveQueries()` after writes; the adapter owns this.
- Migrations are additive and transactional. Append named migrations to `MIGRATIONS`; never edit an
  applied migration.
- Use `db.all(sql\`...\`)`for reads.`db.run(sql\`...\`)`works for non-returning writes
but its affected-row count is not portable. Use`RETURNING` or a builder when ownership/counts
  matter.

### Durable data rules

- `incoming_event_queue` is the durable-before-effect path for socket, eligible unlocked FCM, and
  DEV events. Claims are bounded/fenced; the DB-applied marker joins the exact domain transaction.
- Local message/chat deletion uses tombstones, not hard row deletion. Preserve deletion ledgers,
  read-floor handoff, alias promotion, and the shared visibility predicate.
- Replacing sets is add-then-prune, never truncate-then-refill. Readers may observe same-connection
  intermediate writes even inside a transaction.

## Realtime, notifications, and lifecycle

- Use `react-native-notify-kit`; its API matches Notifee. Conditionally omit
  `AndroidStyle.MESSAGING` person icons instead of passing `undefined`.
- A notification tap while backgrounded arrives through the headless handler. Stash it there and
  drain it when the app becomes active; do not attempt router navigation from headless code.
- Test killed-process push with `adb shell am kill <package>`, not `am force-stop`; force-stop
  disables broadcasts until manual launch.
- Account-scoped async work must register cancellation/tracking before its first await and must not
  publish results after lease/generation revocation.
- Timer-driven work needs a DB claim/fence, not just an in-memory `useRef` guard.

## Files, uploads, cache, and sharing

- Download progress is presentation-only. The DB `localPath` write remains authoritative.
- Upload progress uses the legacy filesystem `createUploadTask`, not `uploadAsync` or the SDK 57
  `File` API. Cancellation can resolve `null`; release listeners/registry entries on every
  terminal path. See `docs/UPLOAD_PROGRESS.md`.
- Native stat/download/delete work stays outside DB transactions. Attachment-cache claims and
  settlement use short guarded owners; recovery and reference scans retain their documented bounds.
- Public ACTION_SEND/Direct Share intake is intentionally disabled. Do not reactivate historical
  `expo-share-intent` or custom native intake paths without a new approved design. See
  `docs/SHARE_INTENT_RELIABILITY.md`.
- Validate server/user-controlled URLs and file paths before native access. URL previews are
  attacker-controlled HTTP input and require scheme, redirect, size, timeout, and content-type
  limits.

## UI contracts worth keeping always visible

- Android edge-to-edge chat/input screens use
  `KeyboardAvoidingView behavior="padding"`. Bottom padding is the maximum/union of keyboard and
  navigation-bar insets, not their sum; leave `keyboardVerticalOffset` at zero.
- FlashList v2 has no `inverted` or `estimatedItemSize` prop. Render chat chronologically and use
  `maintainVisibleContentPosition={{ startRenderingFromBottom: true }}`.
- Guard calls on an auto-released `expo-video` player during focus/unmount cleanup.
- A plain `View` with an accessibility role/label also needs `accessible`. Test accessibility
  contracts by role, not only by test ID.
- Never give text containers fixed heights; support Android font scaling.
- Use themed colors explicitly. Bare React Native `Text` defaults can be unreadable on dark
  surfaces.
- Open chats through `useChatNavigator`, not raw route pushes.

## Privacy and security

- Never call `console.*` directly; use the secure logger. Do not log message bodies, credentials,
  raw push payloads, private file paths, or encryption material.
- App Lock is a UI/policy gate, not encryption-key custody. Locked notifications must remain generic.
- Backups exclude secret-looking keys and delete temporary export files in `finally`.
- Server-controlled URLs opened with `Linking.openURL` must pass an explicit scheme allowlist.
- Crypto/native behavior needs device evidence; host mocks do not prove SQLCipher, filesystem,
  process-kill, or native bridge behavior.

## Verification

During a focused step, run the smallest relevant test suite plus:

```sh
npm run typecheck
node scripts/check-db-writes.mjs --report
```

At a milestone freeze, run the relevant lint/format checks, then:

```sh
npm run check:architecture
npm run check:migrations
npm test -- --runInBand
```

For inventory work, also require:

```sh
node scripts/check-db-writes.mjs --reconcile
```

The final report must state the actual suite/test results and any remaining device-only or unresolved
evidence. Do not claim host tests prove native behavior.

### Component tests

- `npm test` runs separate Node and component projects. Use `--selectProjects` when focusing.
- React Native Testing Library under React 19 is async: await render and user interactions.
- Mounted-store mutations that rerender must be wrapped in awaited `act`.
- Do not assert the global timer count is zero; Expo animation mocks retain timers.
- Keep UI coverage at or above the configured 70% floor with `npm run coverage:ui`.
