# REL-004 late-result inventory

- **Owner:** `REL-004A..C`
- **Baseline:** 2026-08-24, post-v56 source
- **Status:** Host inventory and focused remediation complete; Android A→Disconnect→B proof remains
  open on a future candidate that contains this work.

This is the formal inventory for asynchronous work that can outlive the account that started it.
It complements `docs/SESSION_SCOPED_STATE_INVENTORY.md`: that document owns what process-memory
state is reset, while this one owns what happens when an old promise, native callback, timer, or
retained UI callback settles later.

## Ownership rule

Every account-derived operation that can cross an `await` must capture ownership before its first
asynchronous boundary. A valid boundary is the foreground session epoch, an account-delivery
lease, or a narrower monotonic source lifetime layered on that lease. The operation must check the
same identity before starting another external/native effect and before publishing UI, store, DB,
cache, credential, or navigation state.

An origin or URL is not account identity. Disconnecting and reconnecting to the same server still
mints a new epoch and account generation. Cancellation is useful but insufficient: native work and
some HTTP/query functions cannot be forcibly aborted, so every result boundary must still fail
closed.

## `REL-004A` — query and cache ownership

| Audited family                | Ownership and late-result boundary                                                                                                                                                                                                                                                     | Focused evidence                                                                             | Result                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| iMessage Account              | Key is `['server', 'icloud-account', generation]`; GET success/error and alias mutation use the captured lease. Generation invalidation now reactively removes already-resolved account details.                                                                                       | `accountScreen.test.tsx` delayed success/error, alias mutation, and resolved-data retirement | Fixed in this batch                         |
| Server Management             | Ping, stats, and server-info keys each include generation. Shared reads reject stale success/error; app-wide server-info publication and retained actions recheck ownership.                                                                                                           | `serverManagementScreen.test.tsx`                                                            | Guarded                                     |
| Server Health                 | Ten channel keys share `['server', 'health', generation, channel]`. Reads, refresh, alert clearing, RCS actions, cache mutation, and mounted presentation are generation-owned.                                                                                                        | `serverHealthScreen.test.tsx`                                                                | Guarded                                     |
| Local/non-account query state | Chat search is an encrypted-DB read whose query entry is destroyed at Disconnect; the exact same-key non-abortable A→B case is covered. URL-preview dedupe contains only public URL metadata, no Gator credentials, and its production network caller remains disabled under `NET-00`. | `sessionScopedState.test.ts`, URL-preview containment suites                                 | In scope only at reset/public-data boundary |

There are no production `fetchQuery`, `prefetchQuery`, TanStack mutation-cache, or other hidden
`QueryClient` surfaces. At the `REL-004` freeze, production TanStack query functions did not consume
the supplied `AbortSignal`; their late publication was nevertheless fenced. The subsequent
`REL-005A` host batch threads cancellation through all 14 remote reads and the HTTP retry delay.

## `REL-004B` — server, store, and UI ownership

| Audited family                                  | Ownership and late-result boundary                                                                                                                                                                                                                             | Focused evidence                                                                                    | Result              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| Connection/bootstrap/server info                | Attempt identity, connection epoch, delivery lease, durable-session tuple, and revocation marker are checked around server reads and publication. The identity is generation-based, so same-origin reconnects do not reuse A authority.                        | `connection.test.ts`, `forget.test.ts`, boot/session suites                                         | Guarded             |
| Find My                                         | The store owns a private monotonic generation; reset increments it and every load/refresh continuation checks it, including B finishing before delayed A.                                                                                                      | `sessionScopedState.test.ts`, Find My store/polling suites                                          | Guarded             |
| Feature/sync/theme hydration                    | `shouldCommit` is captured before asynchronous preference reads and checked before store/runtime publication. Device-global choices intentionally survive Disconnect.                                                                                          | `hydrationCommitGuard.test.ts`, feature/sync/theme store suites                                     | Guarded             |
| Server URL rotation                             | Request ownership freezes the foreground epoch and delivery generation. Candidate validation, persistence, session publication, and reconnect recheck the same origin/password/session tuple and lease.                                                        | `serverRotationCoordinator.test.ts`, `serverRotationExecutor.test.ts`, `serverUrlEventSink.test.ts` | Guarded             |
| Contacts and server avatars                     | Contacts coalescing is generation-keyed; native reads and each DB task use the captured lease. Avatar transport/path/DB publication uses a generation destination and guarded commit.                                                                          | `contactsSyncCoalesce.test.ts`, `serverAvatars.test.ts`                                             | Guarded             |
| Group, theme, settings, and other route actions | Tracked requests/DB work use the mount lease and source lifetime; dialogs, cache/store writes, and retained callbacks recheck it.                                                                                                                              | owning group/theme/settings/new-chat/scheduled/reminder route suites                                | Guarded             |
| Backup                                          | The mounted route now retires reactively and clears passphrases/ciphertext. Export, picker-file, native-share, crypto, and restore continuations normalize ownership loss and cannot publish stale dialogs/state; temporary files still clean up in `finally`. | `backupScreen.test.tsx`, `backupService.test.ts`                                                    | Fixed in this batch |
| FaceTime                                        | Call-store generation and account lease are now captured when the owning hook mounts. A retained A header/dialer callback cannot adopt B credentials while carrying A chat GUIDs or recipients; in-flight call steps still recheck after every await.          | `useFaceTimeSessionScope.test.tsx`                                                                  | Fixed in this batch |

## `REL-004C` — transfer, realtime, background, and native effects

| Audited family                                        | Ownership and late-result boundary                                                                                                                                                                                                                                                    | Focused evidence                                                              | Result                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| Send, outgoing retry, and schedules                   | Originating leases, tracked operations, immutable transport snapshots, generation-keyed recovery, post-await checks, durable claims, and DB commit guards prevent A work from publishing into B.                                                                                      | send-account, queue-handover, scheduled-account, and recovery-barrier suites  | Guarded                                                 |
| Downloads, attachment cache, and synced backgrounds   | Flights/destinations include generation and GUID; revocation aborts bounded native work/timers; DB/ledger publication is guarded; stale files are discarded; cache recovery is generation-serialized.                                                                                 | download-account, bounded-download, cache-recovery, synced-background suites  | Guarded                                                 |
| Uploads                                               | Public cancellation, upload-store settlement, snapshotted A credentials, and result guards prevent a detached A native tail from adopting or publishing into B. Exact native-tail draining was deferred from this result-isolation batch and is now host-remediated under `REL-005A`. | upload-control and attachment-upload transport suites                         | Late publication safe; drain result owned by `REL-005A` |
| Foreground/background/headless sync                   | Foreground epoch plus account lease fence every phase; foreground, auxiliary, and background writers drain; durable-session and revocation-marker checks surround headless work.                                                                                                      | sync-control, sync-engine, background orchestrator/task suites                | Guarded                                                 |
| Socket, realtime, and FCM                             | Delivery admission closes synchronously; registered callbacks carry their generation; runtime/router/recovery keys are generation-owned; FCM captures its snapshot/lease before its first await and uses durable ingress.                                                             | delivery, socket, FCM, and incoming-event suites                              | Guarded                                                 |
| Notification routing and actions                      | Connected-layout listeners now carry their mount lease. Deferred route lookup and initial-tap drain recheck it before consuming pending state, navigating, restoring, or starting press side effects. Retained A listeners cannot invoke services under B.                            | `notificationOpen.test.ts`, `appLayout.test.tsx`, notification-action suites  | Fixed in this batch                                     |
| Reminders and error reports                           | Reminder DB→native→DB work is one tracked owner with compensating cleanup. Error capture/upload uses account generation, captured DB/client, abort, guarded claims, and reset/drain ordering.                                                                                         | reminder account-scope and error-report suites                                | Guarded                                                 |
| Native attachment Share, Save, and external file open | Callers reject retained A callbacks and late results. Shared media/file helpers accept the original ownership check and recheck it after file/permission/module awaits and immediately before viewer, share-sheet, or Photos effects.                                                 | chat screen, media viewer/service, FileChip/ContactCard, and open-file suites | Fixed in this batch                                     |

## Focused remediation in this batch

The audit found and fixed these concrete gaps rather than adding duplicate proof to already-safe
families:

1. Already-resolved Account query data was not reactively removed when its generation retired.
2. Backup secrets were not reactively hidden, and raw late native/crypto failures could repopulate
   global dialogs after account replacement. A review-found cleanup-order regression was also
   corrected so a picker cache copy returned after retirement still reaches its deleting `finally`.
3. Retained FaceTime callbacks captured B ownership at invocation while carrying A identifiers.
4. Retained notification listeners and deferred route/drain work could navigate under B or consume
   B's pending tap.
5. Message-menu Share/Save and FileChip results could publish late UI, and native helper awaits had
   no last pre-launch ownership check.

## Focused host verification

- Affected component tests: 8 suites, 168 tests passed.
- Affected service tests: 4 suites, 92 tests passed.
- Strict TypeScript and targeted production-source ESLint passed with no errors.
- Fast DB-write scanner certificates: 84 passed, 10 intentionally skipped; the inventory guard
  reports 1,301 approved mutations and reconciliation reports no remaining drift.
- Prettier and `git diff --check` passed for the final batch.

The full Jest/component, architecture, migration, DB-write adversarial, and native/device gates
were deliberately not repeated; they were outside this post-v56 focused batch.

## Remaining boundary

Host tests prove the JavaScript ownership decisions and injected native-call boundaries; they do
not prove Android process reuse, React Navigation windows, actual system share/viewer/Photos UI,
native upload cancellation, filesystem behavior, or physical account switching.

`REL-004` therefore remains `IN_PROGRESS` until the owner-approved Android A→Disconnect→B journey
runs on a future candidate containing this post-v56 work. The native upload tail and TanStack
transport cancellation are now host-remediated and counted in
`docs/REL_005A_TEARDOWN_INVENTORY.md`; Android bridge behavior remains device-only.
