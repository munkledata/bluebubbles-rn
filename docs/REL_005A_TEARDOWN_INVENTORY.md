# REL-005A bounded session teardown inventory

- **Owner:** `REL-005A`
- **Baseline:** 2026-08-24, post-v56 source
- **Status:** Host inventory and focused remediation complete; Android timing and A→Disconnect→B
  proof remain open on a future candidate containing this work.

This is the counting inventory for client operations that can still be active when the user taps
Disconnect. It complements `docs/SESSION_SCOPED_STATE_INVENTORY.md` (what memory is reset) and
`docs/REL_004_LATE_RESULT_INVENTORY.md` (how late results are rejected).

## Barrier contract

`runForget()` performs one fail-closed account transition:

1. Revoke the connection-attempt epoch, close realtime admission, increment the account generation,
   and write the independent revocation marker before the first await.
2. Cancel active attachment uploads and synchronously clear account-owned stores, query entries,
   credentials, socket/runtime references, and timers.
3. Join any prior cleanup quarantine, then retire durable credentials and old FCM registration while
   both revocation gates are already closed.
4. Bounded-drain admitted account work, exact cancelled-upload tails, sync writers, downloads, and
   diagnostic DB work. A second upload sweep catches a handle registered after the first sweep.
5. Perform the owned notification, database, media, shortcut, and log wipe.
6. Admit another account only after the complete cleanup succeeds. A timeout rejects Disconnect,
   leaves authority closed, retains the owning promise/registry slot, and forces a fresh complete
   sweep before B can connect.

An operation accepted by the server before cancellation is outside the client guarantee. Its local
ack/error continuation is still generation-rejected and the subsequent wipe remains authoritative.

## Counted work families

|   # | Work family                                                        | Stop/drain owner                                                                                                                                          | Late-result boundary                                                                                                 | Focused evidence                                                                                                                | Host result         |
| --: | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
|   1 | Connect/bootstrap candidates                                       | Connection-attempt epoch, stage abort signals, single-flight candidate quarantine                                                                         | Candidate identity and durable tuple rechecks precede every publication                                              | `connection.test.ts`, `forget.test.ts`, boot coordinator suites                                                                 | Guarded             |
|   2 | Direct text, reaction, contact, edit, unsend, and attachment sends | Whole UI operation is admitted through `runTrackedRealtimeWork`; Disconnect drains that slot                                                              | Captured lease surrounds transport and DB reconciliation                                                             | `sendAccountScope.test.ts`, owning send-service suites                                                                          | Guarded             |
|   3 | Direct multi-image native uploads                                  | Initial synchronous registry cancel, post-realtime second sweep, required exact `settled` promise, 5 s upload drain                                       | A post-insert lease check prevents a new old-session upload; post-upload checks suppress reconciliation/error writes | `uploadControl.test.ts`, `attachmentUploadTransport.test.ts`, `sendAttachmentService.test.ts`, `forget.test.ts`                 | Fixed in this batch |
|   4 | Automatic foreground/background outgoing retries                   | A production lease now admits the complete queue run, including list/claim, HTTP/native attempt, and outcome                                              | Per-row checks plus guarded short DB commits reject the retired generation                                           | `outgoingQueueService.test.ts`, background task/orchestrator suites                                                             | Fixed in this batch |
|   5 | Scheduled sends and reminders                                      | Scheduled work is generation-owned and admitted for its whole action; reminder DB→native→DB work is tracked                                               | Claims, leases, and compensating cleanup prevent a late account commit                                               | `scheduledAccountScope.test.ts`, `remindersService.test.ts`                                                                     | Guarded             |
|   6 | Error capture and diagnostic upload/purge                          | Session reset aborts transport and returns the already-entered DB drain; realtime tracking owns account work                                              | Consent generation, captured client/DB, guarded claims, and lease checks                                             | `errorReportSink.test.ts`, `errorReportQueueService.test.ts`, `forget.test.ts`                                                  | Guarded             |
|   7 | Foreground, background, and auxiliary sync                         | Foreground epoch/account lease plus independent sync slots; `awaitSyncIdle()` drains all writers through a 20 s bound                                     | Every phase and DB publication rechecks epoch/lease; headless work rechecks the durable marker/session tuple         | sync-control, engine, and background orchestrator/task suites                                                                   | Guarded             |
|   8 | Remote TanStack reads and HTTP retry backoff                       | `queryClient.clear()` synchronously aborts the 14 remote query signals; every endpoint now forwards that signal to `HttpClient`; retry sleep is abortable | Generation-keyed cache plus screen lease rejects a late injected/non-abortable result                                | `httpBranches.test.ts`, endpoint suites, `sessionScopedState.test.ts`, Account/Server Management/Server Health component suites | Fixed in this batch |
|   9 | Local encrypted-DB chat search                                     | Query entry is destroyed at Disconnect; SQLite read itself is deliberately not advertised as abortable                                                    | Same-key A-late/B-first regression proves the destroyed A entry cannot replace B                                     | `sessionScopedState.test.ts`                                                                                                    | Guarded             |
|  10 | Downloads, cache recovery, and synced backgrounds                  | Generation-keyed flights and cancellation controllers; bounded native transfers are cancelled/drained before media wipe                                   | Destination/lease checks discard late files and block DB publication                                                 | download/cache/synced-background ownership suites, `forget.test.ts`                                                             | Guarded             |
|  11 | Realtime, FCM, notification, and server-rotation work              | Admission closes synchronously; admitted work/native notification queue drains; socket/runtime is disposed                                                | Delivery generation, durable session marker, and source lifetime fence every effect                                  | delivery/socket/FCM/notification/rotation suites                                                                                | Guarded             |
|  12 | Dormant retry, reachability, typing, toast, and service timers     | Generation invalidation, store reset, watcher stop, or runtime disposal cancels the timer before B admission                                              | Retained callbacks recheck their generation/epoch before effects                                                     | timer-owner suites plus `sessionScopedState.test.ts`, `reachability.test.ts`                                                    | Guarded             |

## Native upload residual

Attachment sends use the legacy `createUploadTask`, whose exact `uploadAsync()` promise is retained
after public cancellation and joined before successful Disconnect. A deadline keeps the UI bounded;
the unresolved promise remains in `uploadRegistry.pending`, Disconnect rejects, and B stays blocked
until it settles and a fresh wipe succeeds.

The group-photo helper still uses legacy `FileSystem.uploadAsync`, which exposes no cancel handle. Its
entire `runGroupAction` remains an admitted realtime operation, so successful Disconnect drains it;
a timeout rejects cleanup and keeps B blocked. This is tracked-and-bounded, not host proof of native
cancellation, and is not counted as a detached-tail defect.

## TanStack query inventory

There are 15 production TanStack query records: 14 remote account reads (Account 1, Server Management
3, Server Health 10) and one local encrypted-DB chat search. There are no production `fetchQuery`,
`prefetchQuery`, `ensureQueryData`, or mutation-cache call sites. The 14 remote functions consume
TanStack's `AbortSignal`; active fetch and retry-backoff aborts become non-retryable `cancelled`
errors and cannot issue another old-session request. The local search retains the existing
clear-and-late-publication proof because an `AbortSignal` does not cancel SQLite work.

## Focused host verification and remaining boundary

The post-v56 focused gate covers the changed upload, retry, HTTP/query, endpoint, reset, and route
surfaces:

- Node: 9 suites / 207 tests passed.
- Components: 3 suites / 66 tests passed.
- Strict TypeScript passed; targeted ESLint reported 0 errors and 10 unchanged import-order warnings
  in two test harnesses.
- The DB-write report found 1,301 mutations / 0 structural or membership errors, and reconciliation
  finished at 0 line shifts / 0 rekeys / 0 additions after the reviewed callback inventory update.
- Touched-file Prettier and `git diff --check` passed.

The full Jest/component, architecture, migration, adversarial DB-write, and native/device gates were
deliberately not repeated for this focused post-v56 batch.

Host mocks do not prove the synchronous JSI revocation-marker write, Expo/OkHttp cancellation,
Android process reuse, actual socket closure, native filesystem cleanup, or a physical account
switch. The exact Android A→Disconnect→B journey remains device-only and must use a future candidate
containing this post-v56 work.
