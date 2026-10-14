# Deferred file splits: `bootstrap.ts` and `send/index.ts` (design notes)

Status: **deferred** (2026-10-14) by owner decision at the end of Phase 6 step 6 of the 2026-10-09
Codex-review remediation. Step 6 split the chat screen (`app/(app)/chat/[guid].tsx`, 2,501 → 1,030
lines) and the media viewer (1,400 → 966) and retired the legacy `hydrateSession` boot from
`src/services/bootstrap.ts` (2,188 → 2,026). The two remaining splits turned out to be mostly
DB-write-guard bookkeeping rather than clearer code, so they wait for their own planned change.
Counts and line numbers are as of commit `ba0400c` and will drift.

## `bootstrap.ts`: connect and account cleanup

Shape today (2,026 lines):

- ~1–330: messages, deadlines, quarantine helpers, the foreground delivery drain.
- ~342–655: the four foreground boot stages (inspect, open the database, hydrate settings,
  activate), run by `src/services/boot/foregroundBoot.ts`.
- ~657–1020: Connect (`prepareCandidateConnection`, `connect`).
- ~1022–1262: credential retirement (scoped revocation, durable credentials) and
  `cleanupAccountDatabase`.
- ~1263–1773: `runForget`, the Disconnect cleanup sequence (about 510 lines, ~15 failure kinds).
- ~1774–2026: `wipeLocalCache`, the `forget`/`forgetOnThisPhoneOnly` entry points, the single-flight
  helpers and `deleteCachedMedia`.

**Why it is not a plain move.** Connect, the boot stages and cleanup coordinate through
module-level variables, and seven of them cross those areas:

- `connectionAttemptEpoch`, `lastSuccessfulForgetEpoch` and `forgetInFlight` are used by all three.
- `connectCandidateQuarantine`, `activeConnectCandidate`, `activeConnectRevoker` and
  `accountCleanupQuarantine` are shared by Connect and cleanup.

`foregroundDeliveryDrain`, `connectDatabaseQuarantine` and `connectInFlight` each stay within one
area. Two examples of the sharing: cleanup advances `connectionAttemptEpoch` to revoke a running
Connect, and boot joins `forgetInFlight`. Separate files need the shared seven behind one small
shared-state module with named operations, which is a design change, not a move.

**Guard footprint** (`scripts/check-db-writes.mjs`, its inventory and tests):

- 17 approvals inside `bootstrap.ts` and 18 elsewhere name a `bootstrap.ts` function as their
  target. Approval ids embed the path, the owning function and the target, so every moved function
  re-keys them.
- `COORDINATED_DELEGATION_PATHS` lists `bootstrap.ts`; new files need entries.
- Exact-id pins: the foreground-boot lifecycle proof expects three references from
  `foregroundBoot.ts` to `bootstrap.ts#inspectForegroundBootSession`,
  `#openForegroundBootDatabase` and `#activateForegroundBootSession`. The Settings Disconnect proof
  expects `app/(app)/settings.tsx` to call `bootstrap.ts#forget`. The FCM runtime-load proof
  looks for the Firebase messaging load inside `bootstrap.ts` (it runs during cleanup).
- Exact-set tests in `scripts/check-db-writes.test.mjs` (for example the outer-lifecycle delegation
  boundary) list these ids.

**Suggested shape.** Keep the public entry points and the boot stages in `bootstrap.ts`. Move
`runForget` with its helpers to `accountCleanup.ts` and Connect to `connect.ts`. Put the shared
variables in an `accountLifecycleState.ts` with named operations (for example
`beginConnectAttempt()`, `revokeConnectAttempts()`, `joinCleanup()`). The review also suggested
replacing `runForget`'s 15-way `??` failure chain with a table of cleanup steps; do that as its own
reviewed change after the move. `test/services/forget.test.ts` (98 tests, now driving the real boot
stages) is the safety net for both.

## `send/index.ts`: the send front door

Shape (1,844 lines, 28 exported functions). It is a front door the UI calls; the per-feature work
already lives in `sendService.ts`, `sendAttachmentService.ts`, `scheduleService.ts` and the other
`*Service.ts` modules. Natural groups:

- shared guards (`runUiAccountOperation`, `runScheduledAccountOperation`, snapshot and assert
  helpers), ~167–347;
- message sends (`sendImage` … `checkUnsend`: photos, voice, text with an attachment, contact,
  location, reactions, replies, effects, mentions, formatting, edit, unsend), ~348–1128;
- scheduling (`schedule` … `fireDueScheduledWithDevelopmentSender`), ~1129–1507;
- outgoing recovery (`reportQueueHealthOnce`, `recoverOutgoing`, `retry`, `discardMessage`),
  ~1508–1845.

**Guard footprint:**

- 45 approvals inside the file and 13 elsewhere target it; `scripts/check-db-writes.test.mjs` names
  the file 62 times in exact-id lists.
- `COORDINATED_DELEGATION_PATHS` lists it.
- The process-relaunch proof pins `sendVoice` by path and source hash. Moving or editing it makes
  that proof fail. The production adapter proof requires the relaunch proof, so the failure also
  breaks harness approvals and production approvals (see `docs/HARNESS_PROOF_REDESIGN.md`).
- `scripts/check-scheduled-recovery.mjs` pins this path: it must import `runTrackedRealtimeWork`
  exactly once, `runScheduledAccountOperation` is fingerprinted, and `fireDueScheduled` is the
  expected `runDueScheduled` caller.

**Suggested shape.** Keep `index.ts` as the public entry point and keep `sendVoice`,
`runScheduledAccountOperation` and `fireDueScheduled` where the guards expect them (or update those
guards in the same change). Move the other message sends and the recovery group into two modules.

## How the Phase 6 moves were done safely (reuse this)

- Move code with a script that extracts exact text blocks, refuses unless every anchor matches
  once, and applies only named mechanical edits; then prove the moved code is byte-identical apart
  from those edits.
- After each move, `node scripts/check-db-writes.mjs --check` lists stale approvals and new
  findings. Re-key an approval only when it pairs one-to-one with a new finding on the same inner
  callback chain, operation, target and detected context. Carry owner and evidence unchanged, and
  compare the inventory as a set of approvals before and after.
- Run the relevant exact-set guard tests, the full 60-minute guard suite on the final commit, and
  check that tests catch deliberate breakages of the moved code before trusting them.
