# Dev DB harness: moving it out of `database.ts` (design notes, paused)

Status: **paused** (2026-10-13). Phase 6 step 5 of the 2026-10-09 Codex-review remediation planned
to move the dev-only device self-test harness out of `src/db/database.ts` (about 3,700 of its 4,117
lines) and replace the DB-write guard's call-by-call harness proofs with a few simpler rules. A
read-only survey showed the simple version would drop real production-safety guarantees, so the
owner paused it as its own planned project. These notes record what the survey found so the next
attempt starts from facts. Line numbers refer to `scripts/check-db-writes.mjs` at commit `1a6a3c6`
and will drift.

## What the guard proves about the harness today

The harness is reached only under `__DEV__` from `src/services/boot/foregroundBoot.ts`
(`runDbDriverSelfTest`, `startDevDbRelaunchContractIfRequested`) and from dev-gated PERF routes and
Home. About 364 inventory approvals for it carry `throwaway-database` or
`throwaway-database-delegation`; both are temporal-exclusion contexts that come only from the proofs
below.

| Proof (function)                                         | Covers                               | Production-safety part (examples)                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dbProcessRelaunchCertificateCandidate` (~1697-4356)     | DB-03B1/B2B1/B2B2, DB-02C, BACKUP-02 | fixed throwaway names/keys; exact shape of every `open()`; takeover before normal boot with a single caller; exact imports and marker file names; no escaped references or dynamic imports; hashes of the 19 production functions the waves drive; harness-only notice suppression; allowed raw-write list |
| `driverHistorySelfTestCertificateCandidate` (~4364-4746) | DB-03B2A                             | no `rawDb`/`dbInstance`/`DB_NAME`/`getDatabase`/`getRawDatabase`; exact `open()` calls                                                                                                                                                                                                                     |
| `perf01ColdBenchmarkCertificateCandidate` (~4749-4910)   | PERF-01                              | `DB_NAME` stays `'gator.db'`; `__DEV__` throws pinned by hash; no production state; allowed callers                                                                                                                                                                                                        |
| `perf02InboxBenchmarkCertificateCandidate` (~4919-5240)  | PERF-02                              | benchmark DB name differs from `DB_NAME`; exact callers; no production state                                                                                                                                                                                                                               |
| `driverSelfTestCertificateCandidate` (~5247-6736)        | android-db-contract                  | all 41 `open()` calls accounted for (exactly 1 production); handles/clients cannot escape                                                                                                                                                                                                                  |
| `driverAdapterCertifiedCallables` (~7338-8023)           | **production** adapter proof         | returns empty unless every harness proof succeeds; `opRunner`/`drizzleAdapter` stay unexported; every runner/migration/adapter call is production or certified                                                                                                                                             |
| `startupSingleFlightDelegationTargets` (~6745-7322)      | **production** startup proof         | every `open()`/`drizzle()`/`runMigrations` call is production or certified                                                                                                                                                                                                                                 |
| `foregroundBootLifecycleDelegationNodes` (~14167-14887)  | boot lifecycle                       | real (unshadowed) `__DEV__`; relaunch claim before `coordinator.start()`; driver self-test reaches no other writer                                                                                                                                                                                         |

Much of the rest is experiment validity (function hashes, call counts and order, exact SQL, crash
ordering, marker contents), which does not need to stay in a production-safety guard.

Measured coupling: with the harness proofs forced to `undefined`, all 364 harness approvals change
context **and 183 production approvals break** (coordinated delegation, startup single-flight,
incoming ingress, foreground boot, adapter), because the production proofs above depend on them.

## Why "doorway + sealed harness + `__DEV__` gate" is not enough

The first plan was: one certified doorway that opens only throwaway databases, a rule that harness
files may reach a database only through it, and the existing `__DEV__` gate. Gaps it would miss:

1. **Shared write lock.** DB-02C, BACKUP-02 and PERF-02 use the production `withDbTransaction` /
   `withDbWriteLock` (one process-wide queue, fence counter and watchdog). PERF-02 does so while the
   real app runs (`deviceInboxBenchmark.ts` uses `withDbTransaction`; started from Home).
2. **Exclusive takeover.** Relaunch scenarios must claim the process before normal boot and never
   after it (`ordinaryBootClaimedProcess` latch). `__DEV__` gives no ordering.
3. **Who may call the harness.** An import rule limits what harness files reach, not who calls
   them. Today exact callers are pinned and dynamic imports/escaped references are banned. Non-PERF
   entry points in `database.ts` have no `__DEV__` check of their own.
4. **Production code the harness drives** (19 production functions, PERF repositories and UI) is
   pinned by hash; a new `getDatabase()`/network/background call there would go unnoticed.
5. **Harness-only switch in production code** (`failureNoticeMode: 'suppressed'` only from the
   wave).
6. **File system.** Marker files go through `expo-file-system`; a SQLite doorway does not stop
   file access to `gator.db` or its WAL.
7. **Exact `open()` shapes and names**, including PERF-01's computed `perf01-cold-${chats}.db`, so
   the doorway needs an exact name allowlist, not just "not `gator.db`".
8. **Key vault.** Harness keys are public/random; vault access is excluded only by hashes, and
   `@core/secure` (which the harness imports for `logger`) also re-exports the vault.
9. **Handle escape.** Throwaway handles cannot leave their owner today, except PERF-02's
   intentional throwaway-backed `source` passed to production UI.
10. **Coupling.** The two production proofs count every harness call site and require `opRunner`
    and `drizzleAdapter` to stay private, so moving the harness means rewriting them.

## A safer shape for a future attempt

- One doorway with an exact name allowlist (including the PERF-01 pattern) that refuses `DB_NAME`,
  owns `open`/`close`/`delete`, and hands out runners without exporting `opRunner` itself.
- Rules for: callers of each harness entry point (dev-gated sites only, no dynamic import), the
  relaunch takeover latch before `coordinator.start()`, harness use of the shared write lock
  (DB-02C, BACKUP-02, PERF-02 only), file access through a marker-file doorway, no vault imports
  (import `logger` from a vault-free path), PERF-02's handle exception, and the harness-only notice
  switch.
- Rewrite the production adapter and startup proofs to treat the doorway as the single
  non-production call site instead of counting harness calls.
- Move experiment-validity checks (hashes, call order, exact SQL) into the harness's own Jest tests
  and device runbooks, out of the guard.
- Budget several 60-minute full guard runs and an independent review; measure that the 183
  production approvals keep their contexts before deleting any old proof.
