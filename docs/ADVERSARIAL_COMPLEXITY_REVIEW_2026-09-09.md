# Adversarial architecture and complexity review — 2026-09-09

**Verdict: selectively overengineered.** The strongest evidence concerns the custom audit system,
repeated account-operation wrappers, and test machinery embedded in production modules. The main
stack and the need for reliable offline messaging remain justified. A rewrite would add risk without
addressing these specific causes.

## Plain-English summary saved from the review

**Yes, parts are overengineered. Keep the app's foundation and simplify specific areas.**

- The custom audit machinery creates unnecessary maintenance: a comment-only edit invalidated nine
  classifications, and renaming a local variable failed a scheduling check without changing behavior.
- About 96% of the 3,769-line database module is self-test machinery. Keep the useful tests, but move
  their implementation out of the production database module.
- Theme and folder operations repeat the same account-safety wrapper. Consolidate proven duplication
  without inventing a broader framework.
- Disconnect can leave the app unable to connect to another server when the old server cannot confirm
  credential revocation, even after local cleanup succeeds. Add an explicit local recovery option.
- The roughly 16,000-line work plan makes current priorities hard to find. Separate active work from
  history.

Encryption, the shared database writer queue, durable incoming events, and account isolation solve real
problems. A controlled experiment lost a completed write when it bypassed the queue; using the queue
preserved it. **A rewrite is not the recommendation.**

At the review snapshot, the full app test run passed **484 suites / 5,630 tests**, with one suite and
one test skipped; focused refresh tests passed **5 suites / 186 tests**, and architecture tests passed
**52/52**. The fast database scanner had **83 passes / 5 failures / 12 skips**, and the later typecheck
failed at `bootstrap.ts:1497` because `Promise<unknown>` was passed where `Promise<void>` was required.
Other sessions were changing source during these checks, so these results are dated observations.
This review itself had not yet run phone tests. The subsequent phone checks are recorded separately
in [the device follow-up](./PHONE_REVIEW_FOLLOWUP_2026-09-09.md).

The useful test for complexity is: **what failure does this prevent, and how much harder does it make
an ordinary change?**

This review challenged the [earlier review](./INDEPENDENT_REPO_REVIEW_2026-09-08.md), inspected current
source, ran the app tests and guards, and performed controlled mutations in memory or temporary
copies. Application code and existing project records were not edited for this review. The working
tree is based on `e18d548` and contains substantial ongoing changes; files also changed while checks
ran. Results describe the tested snapshots, not a frozen release candidate. The master work plan
remains the task tracker.

## 1. High priority: remote revocation can prevent leaving an unavailable server

**Confirmed behavior; a product/security policy to reconsider.**

For a paired-device credential—an access token issued to this app installation—Disconnect requires
the old server to confirm credential retirement.
The client correctly closes local authorization, drains work, and wipes local data, but still treats
remote retirement failure as incomplete cleanup. Connecting to another server reruns that cleanup
before it will validate the replacement.

The relevant functions are `revokeScopedCredentialRemotely`, `finishScopedCredentialRetirement`,
`runForget`, and `prepareCandidateConnection` in
[`bootstrap.ts`](../src/services/bootstrap.ts).

An isolated test reused the repository's dependency mocks with the actual bootstrap implementation:

1. Seed an active paired-device credential for a synthetic old server.
2. Make its revocation endpoint consistently report an unavailable server.
3. Run Disconnect: the local wipe succeeds and the durable local revocation marker is set, but
   Disconnect rejects and retains the inactive credential for retry.
4. Attempt connection to a different synthetic server twice: neither attempt reaches server
   validation.

The connection screen receives:

> Gator could not safely finish clearing the previous connection. Restart the app and try again before connecting.

Restarting cannot restore an unavailable old server. The durable cleanup gate also survives a
restart. A legacy shared-password control completes local Disconnect without this endpoint.

Requiring server revocation has a real purpose: it avoids silently abandoning a still-authorized
credential. However, server-side access revocation and preventing local account mixing are different
properties. Making both prerequisites for every local account change turns a remote outage into a
local recovery block. This is a concrete cost of an excessively broad failure policy.

**Recommendation:** support a deliberate “forget on this device” recovery path after local isolation
and cleanup are confirmed. Report remote revocation as unconfirmed and give a separate retry/admin
cleanup route. Preserve blocking for unresolved local writers, native cleanup, and old-account
presentation; those can actually contaminate the next account. This requires an explicit product
decision, not removal of the existing guards as a quick fix.

## 2. High maintenance priority: the audit system overfits implementation details

**Controlled experiments demonstrate avoidable review work.**

The DB scanner is 15,466 lines, its regression file 8,528 lines, and the scheduling guard 2,441 lines.
Its certificates are stored rules describing the exact code the audit approved.
Size alone is not the finding. The problem is that correctness approval depends on incidental source
text and exact local names.

### Comment-only experiment

In a temporary copy of the actual source, I inserted one comment before `mountedRef.current = true`
inside the startup effect in [`app/_layout.tsx`](../app/_layout.tsx).
No executable statement changed.

```text
Detected findings before / after:       1904 / 1904
Old IDs removed / new IDs introduced:   3 / 3
Other unchanged IDs losing approval:    6
Automatic reconciliation:              rejected on context drift
```

The three renamed callback records also lost their approved classification. The six other records
included startup functions in another file. Thus a comment affected nine classifications in total.
This comparison started from the same copied source on both sides; existing live-inventory drift
does not explain the difference.

The cause is visible in `callableOwnName`, `normalizedSnippet`, and the hardcoded startup identities
in [`check-db-writes.mjs`](../scripts/check-db-writes.mjs). The callback hash retains comments, and a
certificate depends on its exact value. Reconciliation can handle some uncomplicated callback
renames, but cannot repair this classification cascade.

### Harmless rename versus unsafe changes

The unchanged send service and a comment-only variant pass the scheduling validator. Renaming only
the local variable `targetCommitGuard` to `targetOwnershipGuard` fails it with three diagnostics.
Two still fail without the whole-function hash check. The executable behavior is unchanged.

Conversely, removing `transport.assertNetworkCurrent()` or dropping the outgoing attempt generation
is correctly rejected. These checks do protect real boundaries; the experiment establishes excessive
coupling, not that the scanner is worthless or that the unsafe changes are currently in production.
See `scheduledHandoffSourceErrors` in
[`check-scheduled-recovery.mjs`](../scripts/check-scheduled-recovery.mjs).

**Recommendation:** first make comments and harmless local renames neutral to these checks, with
the unsafe mutations retained as controls. Then reduce application-specific certificates by
narrowing the write interface and checking ownership behavior. Do not automatically update every
hash, disable the scanner, or attempt to build a more general custom compiler. Splitting the scanner
into smaller files alone would not solve this coupling.

## 3. Medium priority: device-test machinery dominates the database module

**Confirmed separation problem; no release-size claim.**

[`database.ts`](../src/db/database.ts) has 3,769 lines. Its self-test section starts at line 163 and
extends for 3,607 lines through the end: about 96% of that module.
The related DEV relaunch coordinator adds 1,664 lines. Native crash/rekey/migration tests are
valuable, but keeping their fixtures, historical migration assertions, marker handling, and cleanup
alongside the production connection adapter makes everyday database work harder to understand.

These tests also require dedicated scanner certificates and inventory maintenance. Changes to
historical fixtures can therefore affect the same approval machinery used for production writes.

The foreground entry checks `__DEV__` before invoking the relaunch contract. I did not establish
that these tests execute in release builds or measure their contribution to the shipped bundle.

**Recommendation:** move the disposable driver contracts into a clearly isolated device-test area,
retaining a small production adapter and narrowly controlled test access. Preserve native evidence
and the protections separating disposable files from the real account database. Do not delete the
tests or widen raw database access just to make the extraction easier.

## 4. Medium priority: account tracking has repeated, avoidable adapters

**Confirmed duplication; the lifetime protections themselves are necessary.**

[`runTrackedRealtimeWork`](../src/services/realtime/deliveryCoordinator.ts) tracks completion but
returns only `delivered` or `paused`. Callers needing a value consequently
introduce outer result variables, completion flags, stale-account sentinels, and additional checks.
This pattern appears in send, theme, folder, contact, reminder, backup, and cache operations.

The bodies of [`runThemeCommand`](../src/services/themeCommands.ts) and
[`runCustomFolderCommand`](../src/services/customFolderCommands.ts) are identical after substituting
their assertion and sentinel names: 20 normalized lines each.
They also expose the same `committed/value` or `stale` result shape.

**Recommendation:** start by sharing that exact value-preserving account-operation behavior. Keep
registration before the first await, error propagation for the active account, late-result rejection,
and the drain used by Disconnect. Migrate the two identical wrappers first and verify their existing
tests. Do not introduce a general workflow framework or merge distinct account, transport, and
screen-lifetime identities just because each uses a counter.

The 2,000-plus-line bootstrap coordinator deserves a later cleanup, but breaking it into files is
not enough: its many different failure states need explicit ownership and recovery policies. Finding
1 is a policy issue that should be resolved before reorganizing that code.

## 5. Lower priority: historical bookkeeping obscures active work

The authoritative plan measured 16,007 lines; all Markdown under `docs` measured 31,399 lines. The
stored DB inventory contained 1,802 entries and occupied roughly 1.4 MB. These are measurements of
the reviewed snapshot, not targets for deletion.

The plan includes extensive superseded milestones and repeated evidence narratives. The inventory
and source also require coordinated metadata updates for changes that do not alter the safety
property. This raises the effort required to answer “what is still broken?” and increases the risk
of citing an old passing result for new code.

**Recommendation:** keep a concise active register and subsystem contracts; archive completed
narrative history with links. Retain exact evidence for releases and substantive safety changes.
Avoid adding another parallel task tracker or another elaborate approval process.

## Complexity that earns its place

| Mechanism                                              | Why I would keep it                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared writer queue and short transactions             | I exercised the actual coordinator against in-memory SQLite. A bypassing write appeared successful, then disappeared when another owner rolled back. With the queue, it waited and survived. SQLite does not isolate operations sharing one connection. [SQLite's explanation](https://www.sqlite.org/isolation.html) supports this behavior. |
| Opaque transaction tokens and commit guards            | They prevent accidental transaction ownership mistakes and reject revoked-account work. Narrower access could reduce external auditing; simply deleting these guards would lose protection.                                                                                                                                                   |
| Account generations and separate transport revisions   | Reconnecting to the same server and rotating transport are different events. One URL comparison or one global “cancelled” flag cannot safely represent both.                                                                                                                                                                                  |
| Durable incoming/outgoing queues, claims, tombstones   | Offline delivery, retries, duplicate events, killed processes, and deleted-message resurrection are real messaging problems. This is not evidence of unnecessary event sourcing.                                                                                                                                                              |
| SQLCipher, runtime schemas, centralized authentication | These protect actual private data and untrusted input. There is no measured reason here for another framework/database rewrite.                                                                                                                                                                                                               |
| Zustand and TanStack Query                             | Their current responsibilities differ: immediate presentation/session state versus async request caching. Replacing them with homemade equivalents would probably increase maintenance.                                                                                                                                                       |
| Bounded native file operations                         | JavaScript checks cannot constrain a native copy that has already run. The new document reader and redirect restrictions address concrete boundary failures. Their Android behavior still needs device verification.                                                                                                                          |

For context, measured RN app/source TypeScript was about 108,209 lines, versus 114,290 Dart lines in
the original Flutter `lib` directory. Their platform, feature, generated-code, and test scopes differ;
this is not a performance or quality comparison. It is another reason not to diagnose overengineering
from total application size.

## Adversarial hypotheses that did not become findings

- **“The prior failing app tests still prove the cleanup is broken.”** The fresh full run passes.
  The earlier review's failing-suite counts must not be carried forward.
- **“Every hash-based check is comment-sensitive.”** The scheduling hash removes comments and
  passed that control. The DB callback identity path does not.
- **“All raw mutation IDs change on a rename.”** Simple direct-write IDs stayed stable in the small
  control fixture; callback call-edge identities changed. The distinction matters.
- **“A `revoked: false` response means failed revocation.”** The server's
  `DeviceCredentialStore.revoke()` returns false when the row was already revoked. The matching
  handler still returns a successful outcome. Accepting it is correct; requiring literal `true`
  would break this repeat-safe behavior.
- **“Remove the mutex and let SQLite handle it.”** The actual-coordinator rollback experiment
  disproved that simplification for this shared-connection design.

## Verification and limits

| Check                                        | Observed result                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Jest run                                | 484 suites passed, one skipped; 5,630 tests passed, one skipped; 175.737 seconds.                                                                                                                                                                                                   |
| Focused refresh after concurrent edits       | Five suites / 186 tests passed: Disconnect, credential upgrade, server endpoints, and server-health UI. React `act` warnings appeared.                                                                                                                                              |
| Architecture                                 | 52/52 tests passed; live layer and scheduling guards passed.                                                                                                                                                                                                                        |
| Typecheck                                    | Initial run passed. The refresh failed after concurrent bootstrap edits: `src/services/bootstrap.ts(1497,25): TS2345: Argument of type 'Promise<unknown>' is not assignable to parameter of type 'Promise<void>'`.                                                                  |
| Migrations                                   | 47 sequential migrations through `0047_message_retraction_topology`; 5/5 guard tests passed.                                                                                                                                                                                        |
| Fast DB scanner suite                        | 83 passed, five failed, 12 skipped. Failures concern incoming ingress, conversation delegation, outer lifecycle, account transition, and repository-context exact sets.                                                                                                             |
| Live DB inventory report                     | 1,904 detected findings; 1,258 structural/membership errors; 223 reported as missing. These are discrepancies, not 1,258 confirmed data-corruption bugs. No finding carried the `nested-coordinator` label.                                                                         |
| Inventory reconciliation                     | Rejected on non-line context drift in the chat screen's `dispatchRealtimeEvent` call.                                                                                                                                                                                               |
| Temporary offline/contract probes            | Three assertions passed: offline paired-credential replacement is blocked; legacy Disconnect control succeeds; already-revoked acknowledgment is accepted. The first probe run had an incorrect expected UI message; it was corrected to the actual generic error before rerunning. |
| Source mutation probes                       | Safe startup comment and safe send-local rename cause the failures described above; the two unsafe send mutations are rejected; unchanged and scheduling-comment controls pass.                                                                                                     |
| Actual transaction coordinator + host SQLite | Bypassing write lost on rollback; coordinated write preserved. Synthetic in-memory data only.                                                                                                                                                                                       |

CI now includes the fast scanner suite and native unit-test tasks that the earlier review found
missing. Source now includes fetch redirect rejection, the filesystem redirect patch, and a picker
path without automatic copying. Those are verified source changes, not fresh native release proof.
No live dependency audit, full slow ingress mutation matrix, native build, phone session, original
Flutter binary, or live messaging account was exercised in this pass.

The first full test run used Node 24.19.0; npm on the shell path was 11.19.0 while the repository pins
11.17.0. No packages were installed. Concurrent source/release-script edits mean this is not a final
all-gates-passing snapshot. Temporary probes and logs are under `/private/tmp`.

## Recommended order

1. Resolve the offline account-recovery policy and restore the five failing scanner checks against
   reviewed source. These affect usability and the ability to trust the working baseline.
2. Make the audit system tolerate the demonstrated harmless edits while retaining hostile controls.
3. Isolate device-test machinery and merge the two identical account-operation wrappers in separate,
   verified changes. Do not combine them with new send or account-transition behavior.
4. Shorten the active work view. Consider wider cleanup only after these steps demonstrate reduced
   maintenance without weakening behavior.

The lesson is to judge complexity by the failure it prevents and the changes it makes expensive.
A passing test can confirm an inconvenient policy just as accurately as a useful one.
