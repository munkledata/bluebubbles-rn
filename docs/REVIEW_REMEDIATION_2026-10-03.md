# Gator RN — review remediation, October 2–3, 2026

**Status: paused at the owner's request; source repairs and combined host gates pass, native verification remains incomplete.** Remediation status remains owned by [the work plan](./WORK_PLAN_2026-08-03.md); release operations remain owned by [the release plan](./RELEASE_PLAN.md). This report records the approved overnight repair. The original three product defects, coordinated synchronization fixes, dependency alignment, native CI coverage, and UI test corrections are integrated. The frozen combined application checkpoint passes **538 suites and 6,670 tests**, with two suites/tests skipped, every configured UI coverage threshold met, and no React warnings. The full database safety gate passes **115 tests, zero failures or skips**. The reviewed source was transferred without changing this checkout's Git HEAD/index or unrelated work, then deliberately copied into the isolated Android probe. Remaining native execution and exact Android artifact evidence still need verification. This report does not declare the candidate release-ready.

The security audit remains a real blocker: the latest captured full audit reports **58 high and 3 moderate affected dependency entries, with zero critical**; the production-filtered audit reports **49 high and 3 moderate, with zero critical**. These are dependency entries, including packages affected through their dependencies, rather than 58 separate root vulnerabilities. The installed gRPC advisory has been removed through a narrowly scoped fixed-version override. Braces, node-forge, and the URI decoder now have independently reviewed local source mitigations and passing focused tests. They remain listed because npm audit evaluates their unchanged package versions. These local patches are not published fixed versions, and the raw audit failures have not been waived.

The comparison baseline is the frozen October 2 review snapshot at `/var/folders/yc/pcpkcfgx2715_29blbntkl580000gn/T/gator-rereview-20261002.z7zz4jcu/snapshot`, based on commit `1868709c676364e84f735420b56089abe9fef976` plus the dirty worktree and four untracked files captured for that review. The original review is Gator-RN-review-2026-10-02.md (local evidence: `/Users/munkle/Desktop/Gator-RN-review-2026-10-02.md`). Existing work in that snapshot is preserved; it must not be presented as newly implemented during this overnight repair.

## Finding status

| October 2 finding or follow-up                                                      | Current implementation                                                                                                                       | Verification and remaining limit                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read receipts can ignore a privacy setting changed while the operation waits        | Recheck the live preference and settings readiness immediately before sending                                                                | Focused regression and combined full suite pass                                                                                                                                                   |
| A lean RCS receipt can be permanently discarded before its message/chat exists      | Preserve its durable event, request recovery, and replay after its owner exists                                                              | Real database/drain regression passes, including one-time application; stale/conflicting owner and revoked-account/provider cases pass                                                            |
| Selected mention metadata disappears when the composer temporarily becomes inactive | Hide suggestions while retaining a valid selected mention in the draft                                                                       | Focused composer regression and combined full suite pass                                                                                                                                          |
| CI omits the share-intake native tests                                              | Add the share-intake compile and unit-test tasks; include task-manager unit tests                                                            | Workflow/host guards, 29 actual share-intake tests, and all 4 task-manager lifecycle tests pass                                                                                                   |
| README and AGENTS describe the old disabled share-intake state                      | Describe the owned, bounded native intake and its account/App Lock guards                                                                    | Source change confirmed; this documents the previously implemented replacement                                                                                                                    |
| Expo SDK 57 packages are out of alignment                                           | Refresh SDK 57 patch versions, update corresponding local patches, and resolve required peers                                                | Expo reports dependencies up to date; doctor passes 20/20; exact final native artifact pending                                                                                                    |
| UI coverage falls below its configured floor                                        | Exclude two development-only benchmark harnesses from production UI coverage, test their release-route barriers, and add chat-route coverage | Latest root run meets all unchanged aggregate/critical-file floors: 88.35% statements, 91.26% lines, 82.18% branches, 88.72% functions                                                            |
| Four strict-lint warnings in the chat route                                         | Replace effect-based resets with guarded state reconciliation; tie voice recording revocation to the voice capability                        | Focused route tests pass; final candidate verification must retain the strict-lint result                                                                                                         |
| Vulnerable decoder is reachable through URL query parsing                           | Backport the upstream fixed decoding scanner while retaining the existing CommonJS API                                                       | Installed decoder, query-string, and Expo Router parsing tests pass; Android deep-link/bundle evidence pending                                                                                    |
| Firestore pulls vulnerable gRPC                                                     | Scope an exact `1.13.6` override to Firestore                                                                                                | Complete root dependency tree has no reported problems; real offline client construction/termination passes; no TLS/RPC behavior proof claimed                                                    |
| Braces stack exhaustion                                                             | Backport the depth-limit portion of upstream PR 72, retaining the installed version's stringify behavior                                     | Boundary, malformed-depth, caller-supplied syntax-tree, and real micromatch tests pass; raw audit remains blocked                                                                                 |
| node-forge malformed RSA signature data                                             | Backport PR 1152's nested-element count checks and additionally reject a nonempty NULL parameter                                             | Valid and malformed signature-data tests plus actual Expo certificate/signing smoke pass; raw audit remains blocked                                                                               |
| Component-test asynchronous warnings                                                | Tighten completion/cleanup and scoped query-observer delivery; await asynchronous interactions                                               | Both affected suites pass 30 tests with zero warnings; the final combined 538-suite run also has zero React warnings                                                                              |
| Server authentication rejection can strand live updates                             | Retry finite temporary authentication codes through the existing account-owned ladder; keep rejected credentials terminal until manual retry | 3 socket suites / 46 tests pass, including throttling, duplicate errors, stale callbacks, account revocation, and observer replacement                                                            |
| Valid long RCS attachment IDs exceed the local filename limit                       | Use bounded full-SHA-256 identity directories and short MIME-preserving fallback filenames                                                   | 7 root suites / 193 tests pass, with additional canonical-input regressions; updated Android module compiles and all 56 native unit tests pass; actual Android bridge and image rendering pending |

## Product fixes

### Coordinated sync changes passed their final gates and are integrated

The other session completed versioned server message-state synchronization in
`/Users/munkle/github/bluebubbles-rn-sync-2026-10-03`, checkpoint
`35c446212bd57577a39dde568243b978a222b58b`. The reviewed 61-path handoff is now present in this
checkout: 59 files were written and two already matched. The existing Git HEAD/index and 1,283
unrelated baseline paths were preserved. Independent comparison verified all transferred bytes;
outside that scope, 1,276 files match, four old patch files are absent in both trees, and only three
report documents differ. Earlier migration-52 results below remain historical evidence.

Independent review found that an evicted message could retain a conversation owner in its deletion
ledger or GUID aliases while the new message-state path checked only its live row. The peer's fix
checks those retained owners before applying, hydrating, or restoring a snapshot. Seven regressions
cover conflicting owners and correct restoration; the correction passed its 23-suite, 188-test
focused batch and independent review. Migration-53 current-head checks, host reporters, and twelve
older migration-tail assertions were also aligned while preserving historical migration targets.
The earlier complete run's 15 failing suites and 53 failing tests are retained as failures, not
retroactively counted as a pass.

A further review found that delete → restore → delete entries within one response could briefly
clear the local deletion marker between writes. The peer now validates the entire response, retains
the exact known conversation owner, rejects conflicting owners, and applies only each message's
final state. Its 90-test focused batch passes. The pre-transfer combined checkpoint passes **538 suites and
6,670 tests**, with two suites/tests skipped, in **425.664 seconds**. Coverage is **88.35% statements,
91.32% lines, 82.24% branches, and 88.69% functions**, meeting every configured floor. The log contains
zero console-warning/error sections or React act warnings, and no new Node crash report appeared.
Evidence: `BB/bluebubbles-sync-evidence-2026-10-03/logs/rn-jest-coverage-frozen-final.log` under the
shared GitHub directory. The fresh full database safety scan passes **115 tests, zero failures or
skips**, in **3,564.544 seconds**, with actual exit zero. Its log is the sibling
`rn-db-full-frozen-final.log`. Both runs used the frozen candidate; they overlapped with the native
VM initially off and memory monitored. The transfer receipt is
`BB/bluebubbles-sync-evidence-2026-10-03/rn-transfer-results.json` under the shared GitHub directory.

After that verified handoff, all 61 paths were deliberately refreshed into the isolated probe,
with exact bytes checked and its package identity, signing key, credentials, and generated build
configuration preserved. Evidence: `/tmp/gator-probe-source-refresh-20261003-j5slxpbw`.
Native testing is now proceeding against that migration-53 source. Older native/device results
are not silently rebound to it. The older synthetic socket/media fixture does not advertise the new
message-state protocol, so it cannot prove that protocol on the phone; matching server work is at
checkpoint `1482ee4595d66965c28228bb1651d43bdc843010`.

A separate POST-02 synthetic fixture is prepared against the reviewed server checkout at
`d06e26db55f07c18d7333c80dcfe12f0f6595e9f`. Its host self-test passes 509 transitions,
500-row retention pruning, stale-lease rejection, deleted/restored owner checks, and unchanged
SMS/RCS controls. The fixture and validation receipt are in
`BB/bluebubbles-sync-evidence-2026-10-03`; the [controls](../../BB/bluebubbles-sync-evidence-2026-10-03/phone-sync-controls.md)
describe its isolated phone port 43127. Phone acceptance remains pending: live delete/restore,
offline burst convergence, local deletion protection of the controlled target, retention repair
with a deliberate page invalidation and retry, and SMS/RCS sentinel preservation. This fixture
has no attachment or push support. Socket/media port 43125 and notification port 43126 remain
separate tests. Before any installation, the exact APK must pass identity, version, nondebuggable,
signer, architecture, URL-scheme, and stable-hash checks.

### Read-receipt privacy is checked at the actual send boundary

Previously, opening a chat could start a read operation while read receipts were enabled, then wait for transport discovery or an earlier serialized operation. If the user disabled receipts during that wait, the operation could still send one using the earlier decision.

`src/services/chatActions.ts` now reads the current settings immediately before the HTTP request. For serialized iMessage operations, that check occurs inside the queued callback, after earlier work has finished. The direct path also checks after transport discovery. The settings must still be loaded and read receipts must still be enabled. Existing account, transport, provider, and iMessage capability checks remain.

The local database read marker continues to update independently. Turning off receipts therefore prevents the outward notification without making the conversation remain unread on this device. Four new regression cases cover settings becoming disabled or unready during either transport discovery or queue waiting. They assert that the local read state persists and that the server receipt call does not occur.

### A current RCS receipt waits for its missing message owner

A lean receipt carries a message identifier and delivery/read information without necessarily carrying its chat. Previously, if the corresponding message was not yet in the local database, the RCS precheck returned successfully. The durable incoming queue could interpret that as completion and erase the event payload, losing the receipt permanently.

`src/services/realtime/dbEventSink.ts` now distinguishes an unknown owner from a known conflicting owner. An eligible durable event whose account and RCS provider generation are still current requests recovery and raises the existing missing-dependency error. The queue retains the event for a later attempt. A known Apple owner, an owner from another RCS provider generation, an outdated event, or a non-durable delivery remains rejected. The account and provider checks are repeated after the asynchronous owner lookup, so revocation during that lookup does not start recovery.

The new regression uses the real incoming queue, event router, provider wrapper, database sink, and SQLite-backed test database. Its first drain retains the payload in `pending` state with `dependency-pending`, no applied marker, and one recovery request. It then hydrates the message/chat, advances the retry time, and drains again. The delivery date is applied, the queue records completion and clears the payload, and a database trigger verifies that another drain does not apply the receipt twice. Separate tests cover conflicting ownership and account/provider revocation while the lookup is paused.

The recovery request stays outside the shared database writer lock. The fix adds no transaction nesting, migration, or alternate event-normalization path. The existing source certificate was repinned to the reviewed implementation, and the mutation inventory was reconciled for changed locations/callback identities. The full adversarial checks and corrected exact-set/fast checks are recorded below; earlier interrupted scanner attempts are not passing results.

### Temporary composer inactivity preserves selected mentions

`src/ui/conversations/Composer.tsx` now hides an unfinished mention suggestion when the composer becomes inactive without discarding valid metadata for an already selected mention. A user can temporarily enter another chat mode and return to the same draft without silently converting that selected mention into plain text.

Participant/capability changes and incompatible editing or reply modes still clear metadata when it is no longer valid. The visible draft text is retained. New tests cover a selected mention across inactivity, an unfinished suggestion across inactivity, and invalidation when participant availability changes.

### Temporary socket authentication failures recover without reviving old accounts

The coordinated server repair now rejects unauthenticated Socket.IO namespace handshakes with `connect_error`.
Socket.IO stops its own automatic retries on that rejection. The client previously logged the error and continued
displaying connecting/reconnecting, which could leave live updates unavailable until another manual or lifecycle
restart even after a temporary authority/storage failure cleared.

The server and client agreed on finite `error.data.code` values. `AUTH_UNAVAILABLE` schedules a same-origin retry
with a 1–60 second exponential delay, including bounded jitter. `AUTH_RATE_LIMITED` imposes a conservative 60-second
wait, matching the server's `retryAfterMs: 60000` contract. `AUTH_REQUIRED` and unrecognized inactive-namespace errors
show an error and stop automatic retries. Human-readable error text is never parsed as authority. Ordinary transport
errors whose Socket.IO retry path remains active retain that existing retry behavior.

The change uses the existing lifecycle observer and escalation scheduler; certified durable-ingress methods remain
unchanged. Terminal decisions are scoped to the socket generation. Timers also check their exact timer identity,
socket generation, and account lease before replacing a connection. This prevents a cancelled short timer from
bypassing a newer rate-limit wait, and prevents observer callbacks or account replacement from reviving stale
credentials. Explicit manual retry starts a new generation. Three focused socket suites pass **46 tests** after the
final clean install; actual paired app/server recovery remains pending device execution.

### Long RCS attachment identifiers fit the owned cache namespace

The paired-server fixture exposed a separate compatibility defect: its valid 2,795-character RCS
attachment GUID exceeded the app's 180-character encoded path-segment limit, so download failed
before making its server request. Missing transfer names had a related problem because their
fallback filename repeated the GUID.

Attachment identity now uses a separate mapping. Existing short identity directories stay byte-for-byte
unchanged. Long identifiers use `id-sha256-` plus the full lowercase SHA-256 digest of their exact UTF-8
bytes. Both JavaScript and the pure synchronous Android hasher reject empty, malformed-Unicode, or
over-4,096-byte identifiers. Hashing introduces no await, filesystem work, or database transaction.
The original GUID still goes to the server and owns the attachment database row. Reservation and
download derive the same generation-scoped path before native work starts.

Only the attachment identity-directory grammar is extended. Transfer filenames, wallpapers, fixed
path depth, generation validation, symlink rejection, page limits, and quota rules retain their
existing restrictions. An absent transfer name keeps its old GUID-plus-extension spelling when it
fits, otherwise it uses `attachment` plus the MIME-derived extension. Existing paths are read from
the database and are not renamed. The parser exposes the hash explicitly rather than pretending
it has recovered the original GUID. Recovery and deletion continue to use exact stored paths.

The isolated prototype passed **6 JavaScript suites / 188 tests**, followed by **2 suites / 53 tests**
covering the tightened argument assertion and generation diagnostics; these runs overlap and are
not additive. An independent bounded ARM64 Temurin 17/Kotlin 2.1.20 run compiled the actual identity,
policy, and scanner implementations with their tests and passed **33 JUnit tests**. The independent
security review found no blocking production defect. Root integration passes **7 suites / 193 tests**,
followed by **2 suites / 110 tests** covering additional rejected newline forms and **1 suite / 16 tests**
using a canonical epoch-qualified maximum-length RCS identity; these runs also overlap. Typecheck,
strict lint, formatting, 52 architecture tests, and 62 native-build/workflow host tests pass.
At the long-ID checkpoint, the ordinary database report was clean at **2,187 writes / zero errors**, and reconciliation had zero
drift after updating one import-induced line shift without changing its write ID or ownership.
These are JavaScript/pure-JVM results; the rebuilt Android bridge and actual long-ID image rendering
still require the phone candidate. Evidence: `/tmp/gator-long-guid-prototype-js2.log`,
`/tmp/gator-long-guid-prototype-js3.log`, and
`/tmp/gator-kotlin-junit-20261003/attempt-m6g8gae8/output.log`.
Root evidence: `/tmp/gator-overnight-long-guid-tests.log`,
`/tmp/gator-long-guid-newline-before.log`,
`/tmp/gator-overnight-long-guid-qualified-fixture.log`,
`/tmp/gator-overnight-long-guid-db-check.log`, and
`/tmp/gator-overnight-long-guid-db-reconciled.log`. The earlier `long-guid-db-report.log`
contains the one inventory-location error before reconciliation and is not a passing gate.

## Build, testing, and documentation changes

The Android workflow now explicitly compiles `gator-share-intake` and runs its `testDebugUnitTest` task. The third Linux Android run executed **29 share-intake tests with zero failures or skips**; this replaces the earlier source-count-only evidence for that module. The workflow also executes `expo-task-manager:testDebugUnitTest` for the locally patched task-manager behavior, which that earlier run did not reach; its subsequent dedicated run passed all four lifecycle tests. Host checks verify the required task names and retain the blocking dependency audit requirements; those host assertions do not themselves execute Kotlin or prove phone behavior.

README and AGENTS now describe the existing owned `gator-share-intake`/`gator-share-shortcuts` replacement. The change removes outdated instructions saying public share intake is disabled. It does not newly enable public sharing or relax byte/time limits, durable ownership, account isolation, or App Lock restrictions.

The dependency refresh stays on Expo SDK 57, React Native 0.86.3, React 19.2.3, and Jest 29.7.0. Expo is now 57.0.26. The versioned local patches were moved to the refreshed background-task 57.0.21, file-system 57.0.7, router 57.0.24, and task-manager 57.0.21 packages. Reanimated 4.5.1 and Worklets 0.10.1 satisfy the current peer requirements. A temporary dependency-layout failure, `Cannot find module 'expo-modules-core'`, is recorded in an earlier route-test log; subsequent focused tests pass after dependency resolution. Do not count that earlier failing invocation as a current passing result or hide it by citing its misleading `final` filename.

The pre-libsodium-patch root `npm ci --no-audit` succeeded: **1,313 packages installed and all 11 local patches applied**. Audits
run separately and remain blocking, as described above. The Linux probe's subsequent dependency synchronization
also applied all 11 patches and includes the gRPC lockfile change. Its partial native results and failed overall command are recorded below.

UI coverage now measures production UI rather than the two development-only device benchmark screens. Their release routes already redirect away from those screens; new route tests verify that each redirects to `/home` outside development and renders its benchmark screen during development. Only `ColdInboxBenchmarkScreen.tsx` and `PerfInboxBenchmarkScreen.tsx` are newly excluded. The aggregate statement/line/branch/function floors and critical production-file floors are unchanged. This is an explicit measurement-scope correction, so any new percentages must be compared with the October 2 percentages with that scope change disclosed.

Chat-route tests were also expanded while addressing strict-lint warnings. Reset conditions now reconcile stale reply/edit/return-to-newest state before children commit. Recording revocation follows the voice capability. Focused tests and the complete combined functional/coverage run pass.

Asynchronous warning cleanup first touched the server-health, media-viewer, and conversation-list component tests. Their first focused run passed 3 suites and 116 tests, but still emitted two media-timer warnings and a new health-screen warning: `The current testing environment is not configured to support act(...)`. After scoping the health-screen React act environment correctly, a second diagnostic run passed 2 suites and 80 tests with no warnings. The earlier 534-suite combined run passed but recorded five act-environment warnings in attachment-tray tests and one Account-screen observer warning. Attachment-tray tests now await all 17 asynchronous RNTL button presses. Account-screen tests await their presses, scope synchronous query notifications inside React `act`, and verify the changed display name/usable alias control rather than stopping when a request starts. These two test-only fixes pass TypeScript, strict lint, formatting, and whitespace checks. Both complete affected suites then pass **30 tests in 2.505 seconds with zero warnings**, recorded in `/tmp/gator-overnight-test-timing-focused.log`. Production source is unchanged by these final test edits. This focused result resolves the observed warnings in those suites; it does not relabel the earlier aggregate run as warning-free. No global warning suppression is being credited as a fix.

## Dependency security changes and unresolved advisories

### URI decoder: compatible source backport

The vulnerable `decode-uri-component` is not merely a build tool in this application. `query-string` requires it, and the installed Expo Router state parser calls that query parser on incoming paths. The published fixed decoder release, 0.5.0, changes to ES modules; simply forcing that version underneath the existing CommonJS consumer would break its import contract. The chosen patch copies the upstream fixed scanning logic into the existing 0.2.2 module, preserving its callable CommonJS export, plus-to-space behavior, replacement wrapper, and MIT license. See the [advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) and [upstream fix](https://github.com/SamVerschueren/decode-uri-component/commit/fa479da).

The external prototype passed 180 tests, including fixtures from both upstream versions and real query-string/Expo Router integration. A deterministic 5,780-input comparison found no differences from the fixed upstream implementation after applying the legacy plus normalization. There were 335 differences from vulnerable 0.2.2, all containing encoded percent signs; these are intentional upstream corrections for malformed percent separators, not evidence of identical behavior on every malformed string. Isolated malformed-input deadline checks demonstrate that the original exponential decoding case is addressed on Node. They are not Android performance measurements or a universal bound on every operation in the preserved wrapper.

The repository now carries `patches/decode-uri-component+0.2.2.patch` and tests the actually installed module. Tests cover ordinary Unicode, plus and encoded-plus handling, malformed byte sequences, literal percent separators, real query-string parsing, real Expo Router parsing, and large malformed inputs inside a child process with a deadline and memory limit. The combined focused log for that test file and the two route files reports 3 suites and 103 tests passing. Those totals overlap other focused runs and must not be added together as unique tests.

The package version remains 0.2.2, so version-based npm audit continues to flag it. This report records a reviewed source mitigation with tests; it does not claim that npm recognizes it as a fixed release or that the audit gate has been waived. Exact Android bundling and device deep-link behavior remain unproven for this candidate. External provenance and compatibility evidence are in /tmp/gator-decoder-backport-20261003/README.md (local evidence: `/tmp/gator-decoder-backport-20261003/README.md`).

### gRPC: scoped published-version repair

The repository now overrides only Firestore's gRPC dependency:

```json
"@firebase/firestore": {
  "@grpc/grpc-js": "1.13.6"
}
```

Both the certificate-authorization issue and server error-disclosure issue identify 1.13.6 as a fixed release. See the [certificate advisory](https://github.com/advisories/GHSA-m9gg-hp2v-232j), [error-disclosure advisory](https://github.com/advisories/GHSA-f596-whhp-79r4), and [upstream release](https://github.com/grpc/grpc-node/releases/tag/@grpc/grpc-js%401.13.6).

The isolated compatibility prototype kept Firebase 12.15.0 and Firestore 4.16.0 unchanged. Its exact dependency delta was gRPC 1.9.16 to 1.13.6 plus `@js-sdsl/ordered-map` 4.4.2; no other package entry changed. Existing proto-loader resolution already satisfied the newer requirement. The root install reports the same one-added/one-changed delta, and its lockfile now resolves gRPC 1.13.6. This avoids replacing the app's Firebase, SDK, or Jest major versions merely to satisfy an audit tool's suggested downgrade/upgrade path.

There is a deliberate compatibility trade-off: Firestore still declares `~1.9.0`, so the override exceeds its published dependency range. Both the isolated tree and current root tree were inspected for dependency validity. Actual Firebase and Firestore Node modules were imported, a synthetic app and client were constructed, document/query/write-batch objects were created without executing operations, and clients/apps were terminated. The gRPC generic client and metadata APIs were also constructed and closed. Network entry points were guarded; the current root smoke result records zero network attempts. No existing top-level gRPC export was removed in the isolated before/after comparison.

Firestore still selects a separate React Native entry. Its inspected React Native source files do not import gRPC. This is package/source evidence, not a measurement of the packaged Android artifact. These checks also do not test credentials, a real backend RPC, TLS handshakes, certificate authorization, server error handling, retries, or every behavioral difference across gRPC versions. The fix status for the published security issues comes from the upstream advisories, not from claiming that offline construction tests reproduce them. Evidence: isolated prototype (local evidence: `/tmp/gator-firestore-grpc-20261003/README.md`), current root smoke result (local evidence: `/tmp/gator-overnight-grpc-smoke.json`), and complete root dependency tree (local evidence: `/tmp/gator-overnight-tree-complete.json`).

### Braces: reviewed depth-limit backport

`braces` 3.0.3 is affected by a stack-exhaustion advisory involving deeply nested patterns. It propagates through many tooling dependencies, explaining much of the increase in affected package counts. The inspected Gator paths use it through development/build tooling; no app message or remote-server input path into braces was established. That does not make untrusted repository/configuration inputs safe. At the time of this review, the advisory identified no published fixed release; an upstream depth-limit proposal remained under review. See the [advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [upstream proposal](https://github.com/micromatch/braces/pull/72).

The repository now carries `patches/braces+3.0.3.patch`, an independently reviewed adaptation of the upstream proposal restricted to depth handling. It caps nesting at 100 levels while allowing a caller to request a lower limit. Parsing counts brace and parenthesis nesting together. Compile, expand, and stringify also enforce depth limits for caller-supplied syntax trees, preventing callers from bypassing the parser. The patch retains 3.0.3's existing stringify parent behavior rather than importing an unrelated output change from the proposal.

The installed-package tests accept 100 levels and reject 101, reject 4,000 nested levels even below the existing 10,000-character limit, cover caller-supplied syntax trees, verify that options cannot raise the hard cap, and preserve escaped, quoted, and bracket-literal handling. Ordinary expansion/stringification cases and the real micromatch consumer also pass. This is a local stack-depth mitigation, not a claim that every form of expansion cost is bounded or that upstream has published this patch.

### node-forge: reviewed signature-data validation backport

`node-forge` 1.4.0 is affected by RSA signature verification accepting malformed nested algorithm data under specific conditions. Expo's signing/certificate tooling does call verification code, so it should not be dismissed as completely unused. The inspected app source did not import forge, and exploit prerequisites in the actual signing workflow were not demonstrated. No published fixed release was identified during this review; the relevant upstream proposal remained unmerged. See the [advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [upstream proposal](https://github.com/digitalbazaar/forge/pull/1152).

The repository now carries `patches/node-forge+1.4.0.patch`, independently reviewed after adoption. Its validation stays local to RSA `DigestInfo`, the structure identifying the signed digest, rather than changing the shared ASN.1 parser. It applies PR 1152's nested-child count checks and adds a check that a present NULL parameter contains no bytes. Valid encodings with an absent or empty NULL parameter remain accepted where the algorithm permits them; extra nested children and nonempty NULL values are rejected.

Regression tests cover SHA-1, SHA-224, SHA-256, SHA-384, and SHA-512; preserve the existing MD5 parameter requirement and digest-mismatch behavior; and exercise Expo's actual self-signed certificate generation, validation, and buffer-signing functions. The malformed-signature fixtures use a generated private key to construct invalid structures under normal PKCS#1 padding. They demonstrate parser rejection, not a forged signature created without possession of a private key. The tightened Expo smoke additionally requires a nonempty signature; its final focused capture passes 1 selected test with the other 26 deliberately skipped.

The three installed-package security suites for braces, node-forge, and the decoder pass **70 tests across 3 suites**, with no failures. This is current focused host evidence for the local patches, not a substitute for final clean installation, the complete application suite, or Android artifact checks.

`brace-expansion` is a different package from `braces`. Its available patched versions were refreshed; it is absent from the latest audit's direct advisory packages. Resolving it does not resolve the newly reported braces issue.

Keep dated dispositions describing the specific local mitigations, their compatibility evidence and limits, and the upstream versions/proposals they came from. Track published fixed releases so these patches can eventually be retired. Do not force sweeping Expo/Firebase/Jest version changes or silently lower the audit severity threshold. All three patched package versions remain unchanged; the latest full/production raw audit counts are 58 high plus 3 moderate and 49 high plus 3 moderate respectively. The source mitigations do not turn either raw audit gate green or authorize ignoring its failure.

The full count changed from 55 to 58 after the final clean install without a new underlying advisory or dependency
version change. Comparing the before/after complete trees found the same 3,367 dependency entries, including their
versions and resolved URLs, with no invalid/extraneous flags or tree problems. The three added audit entries are
React Native Testing Library, react-native-maps, and react-native-notify-kit, inherited through React Native.
The direct braces, forge, and decoder advisory records are unchanged. This reflects recalculated inherited
vulnerability metadata; the captures do not establish which cache/registry event triggered it. See npm's
[explanation of inherited vulnerability calculation](https://docs.npmjs.com/cli/v11/commands/npm-audit/#calculating-meta-vulnerabilities-and-remediations).

## Evidence recorded during this repair

These are individual captured results. They run at different points in the repair, overlap in coverage, and are not a substitute for the final frozen-candidate gates.

| Evidence                                               | Captured result                                                                                                             | Scope                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Focused product/route suites                           | 6 suites, 208 tests passed                                                                                                  | Chat route, development benchmark routes, read state, incoming drain, RCS ingestion, composer |
| Decoder and route additions                            | 3 suites, 103 tests passed                                                                                                  | Installed decoder and actual Router parser included; overlaps the route suites above          |
| Installed security backports                           | 3 suites, 70 tests passed                                                                                                   | Braces, node-forge, and URI decoder; overlaps the decoder cases above                         |
| Tightened Expo signing smoke                           | 1 selected test passed; 26 skipped                                                                                          | Actual certificate creation/validation/signing, with a nonempty result required               |
| Component warning cleanup                              | 3 suites, 116 tests passed                                                                                                  | First run still emitted media-timer and React act-environment warnings                        |
| Warning diagnostic after health-screen environment fix | 2 suites, 80 tests passed; no warnings in that capture                                                                      | Media warning is intermittent; this is not full-suite warning clearance                       |
| RCS revocation-focused run                             | 1 suite, 14 tests passed                                                                                                    | Current/conflicting/stale owners and account/provider revocation; overlaps the product run    |
| Expo dependency alignment                              | `Dependencies are up to date`                                                                                               | Captured dependency state after SDK refresh                                                   |
| Expo doctor                                            | 20/20 checks passed                                                                                                         | Host configuration/dependency checks                                                          |
| TypeScript                                             | No compiler diagnostics in captured final log                                                                               | Host type checking                                                                            |
| Formatting                                             | All matched source/app/test files use Prettier style                                                                        | Captured formatting check                                                                     |
| Architecture and scheduled recovery                    | 52 tests passed                                                                                                             | Includes source boundaries and scheduler ownership                                            |
| Earlier migration checkpoint                           | 5 tests passed; 52 sequential migrations                                                                                    | Before the coordinated migration-53 handoff and its newer passing gates                       |
| Diagnostics                                            | 37 tests passed                                                                                                             | 20 production calls, 19 error events, 20 opaque crash sites, 6 native log events              |
| Native build/workflow host guards                      | 62 tests passed                                                                                                             | Source/workflow assertions; not native test execution                                         |
| Current root gRPC smoke                                | App/client construction and cleanup passed; zero network attempts                                                           | Offline compatibility, not server/TLS security validation                                     |
| Latest full dependency audit                           | 58 high, 3 moderate, 0 critical                                                                                             | High-severity gate remains blocked                                                            |
| Latest production-filtered audit                       | 49 high, 3 moderate, 0 critical                                                                                             | Still includes production-declared tooling; not an Android bundle inventory                   |
| Current legal inventory                                | 1,012 package records; 920 unique package versions; 14 pending assets; 13 local components; 127 package records need review | Exact AAB coverage remains absent; generation is not legal clearance                          |

Source logs: focused product tests (local evidence: `/tmp/gator-overnight-focused-final.log`), decoder/route additions (local evidence: `/tmp/gator-overnight-final-additions.log`), Expo alignment (local evidence: `/tmp/gator-overnight-expo-final.log`), doctor (local evidence: `/tmp/gator-overnight-doctor-final.log`), architecture (local evidence: `/tmp/gator-overnight-architecture.log`), migrations (local evidence: `/tmp/gator-overnight-migrations.log`), diagnostics (local evidence: `/tmp/gator-overnight-diagnostics.log`), native host guards (local evidence: `/tmp/gator-overnight-native-host-final.log`), current full audit (local evidence: `/tmp/gator-overnight-audit-frozen.json`), current production audit (local evidence: `/tmp/gator-overnight-audit-frozen-prod.json`), and current legal generation (local evidence: `/tmp/gator-overnight-legal-grpc.log`).

Newer evidence: three security suites (local evidence: `/tmp/gator-overnight-security-tests.log`), tightened Expo signing smoke (local evidence: `/tmp/gator-overnight-forge-smoke-final.log`), first component warning run (local evidence: `/tmp/gator-overnight-warning-tests.log`), later clean warning diagnostic (local evidence: `/tmp/gator-overnight-warning-diagnostic.log`), security-stage typecheck (local evidence: `/tmp/gator-overnight-typecheck-security.log`), and legal regeneration after the security patches (local evidence: `/tmp/gator-overnight-legal-security.log`). The legal totals remain unchanged in that later capture.

The earlier audit/install captures predate the complete candidate. Current dependency evidence is the successful
`/tmp/gator-overnight-final-clean-install.log`, the full and production `audit-frozen` JSON captures, and
`/tmp/gator-overnight-tree-frozen.json`. The `*-frozen` check logs record the dependency/socket checkpoint;
later long-ID and corrected-scanner evidence appears in the corresponding sections. These filenames identify
checkpoints, not an immutable release artifact or proof that every pending gate passed.

## Final gate status, earlier attempts, and release limits

The frozen combined application checkpoint's full coverage and database gates pass, as recorded
above. The earlier attempts below remain separate evidence; native artifact, device, and release
requirements are still open.

1. **Earlier combined Jest/coverage checkpoint:** the serialized ordinary retry passes **534 suites / 6,602 tests**, with two suites and two tests skipped, in **812.131 seconds**. UI coverage is **88.36% statements, 91.31% lines, 82.17% branches, and 88.74% functions**; all four critical-file floors also pass. This measures the corrected production-UI scope described above and is not a like-for-like percentage comparison with the old benchmark-inclusive baseline. The runner exited zero without a timeout or new Node diagnostic report. Evidence: `/tmp/gator-overnight-coverage-serialized-retry.log`, its `.json` execution receipt, and `/tmp/gator-overnight-coverage-serialized-summary.json`. Six unsilenced React warnings led to the two test-only timing fixes described above; their subsequent focused run passes **2 suites / 30 tests with zero warnings**. The first overnight attempt remains a failure: exit 139 after V8 `SIGSEGV`, 55 suite PASS entries, and no aggregate or coverage totals. See [the V8 runbook](./TEST_01C_V8_HARNESS.md). One passing ordinary retry does not close that intermittent-runtime investigation.
2. **Earlier database safety checkpoint:** the complete run finished in 4,029,304.8625 ms with **114 passed and 1 failed**. All 14 full-only adversarial groups passed, including the incoming-ingress matrix. The sole failure was the conversation-action exact-set test retaining three callback IDs from before the read-receipt privacy check; the reconciled inventory already contained the current IDs. Independent review confirmed unchanged transaction operations/ownership and that the separate startup finding remains intentionally outside this filter. Only those three expected strings were corrected, with no scanner algorithm, production source, certificate, or ingress-proof change. The corrected exact-set run passes **1 test**, and the fast gate passes **101 tests, zero failures, 14 intentional skips**. This uses the repository's reviewed ID-only correction rule; the original full command is not relabeled as passing. That checkpoint’s ordinary report confirms **2,187 mutations and zero errors**, and reconciliation confirms **zero location shifts, rekeys, or additions**. Earlier interrupted full runs are not passing gates. Evidence: `/tmp/gator-overnight-db-full-with-long-guid.log`, `/tmp/gator-overnight-db-exact-set-corrected.log`, `/tmp/gator-overnight-db-fast-corrected.log`, `/tmp/gator-overnight-db-report-corrected-freeze.log`, and `/tmp/gator-overnight-db-reconcile-corrected-freeze.log`.
3. **Native compile and unit tests:** partially complete. The first Linux Gradle run failed with `Gradle build daemon disappeared unexpectedly`; the container recorded `oom_kill=1`, identifying an operating-system memory kill. Its separate Kotlin JVM had duplicated the heap budget. The second run used one worker and in-process Kotlin with a 1,536 MB Java heap, then stopped at the missing ICU prerequisite. After that prerequisite was installed, the third run compiled the Hermes host compiler and Java/Kotlin sources for ReactAndroid, Expo Modules Core, and local modules; it did not establish completion of every Android C++ library. Its captured XML reports **21 paste-input, 13 share-shortcut, 29 share-intake, 9 bounded-document, and 50 bounded-download tests passed**, with zero failures/skips. These are 122 tests across five modules. The command then failed after 1h 28m 12s: all three Expo file-system tests raised `IOException` during `MockWebServer.shutdown`, through `ServerSocket.close` and `NativeThread.signal`. The messages were `No such file or directory` or `Resource temporarily unavailable`. Because each shutdown is in a `finally` block, it can replace an earlier test failure; this output does not establish that the request assertions passed. Runtime/emulation behavior is under investigation. Task-manager tests and screen-security compilation were not reached. This probe snapshot predates the long-ID fix, so its 50 download tests do not validate the new native hash bridge. The updated module subsequently passed all 56 native tests, as detailed below; packaging remains pending. The separate 33-test pure-JVM cache result above remains distinct. At that earlier checkpoint Gradle warned that its 512 MiB Metaspace pool was tight; the subsequent unit steps below used 1,024 MiB. Evidence: `/tmp/gator-overnight-native-tests-icu-retry.log` and the probe modules' Gradle XML test reports.
4. **Dependency installation and package/source guards before the build-only follow-up:** the clean install applied all 11 patches and installed 1,313 packages. Expo reports dependencies up to date and doctor passes 20/20. Typecheck, formatting, strict lint, 52 architecture tests, 37 diagnostic tests, and 13 legal inventory tests pass after the socket change. These host checks do not replace the pending native/artifact gates.
5. **Android packaging and exact-device acceptance:** pending. Host mocks and workflow assertions do not prove SQLCipher, native filesystem behavior, the patched bridge, process-kill handling, permissions, native notifications, or installed release behavior. A native dependency/patch change requires a clean rebuild.
6. **Security and legal release blockers:** unresolved at the gate level. Braces, forge, and the decoder have reviewed local mitigations, but their unchanged versions remain audit-flagged and the raw high-severity audit gates still fail. Asset provenance and package review remain incomplete, and exact-AAB legal coverage is absent. No audit gate was weakened to manufacture a pass.

The updated bounded-download module subsequently compiled its production and test Kotlin and
passed **6 suites / 56 tests, zero failures, errors, or skips** against the synchronized migration-53
candidate. All XML results were freshly written during the 423.172-second Gradle run; the test task
actually executed. The container peaked at 3,020,009,472 bytes (about 2.81 GiB), with no memory-limit
or out-of-memory events. These 56 tests supersede the earlier overlapping 50-test result; they are
not an additional 56 distinct tests.
Evidence: `/tmp/gator-native-download56-20261003-xogzbin4`, including the Gradle log, six XML reports,
execution receipt, and memory counters. This still does not exercise the JavaScript/native bridge
or image rendering on the phone.

The next Gradle step passed **all 4 task-manager lifecycle tests**, with zero failures, errors, or
skips, and compiled the screen-security Kotlin and Java sources. Its XML was freshly written and
the three requested tasks actually executed. The overall step exited zero in **391.293 seconds**.
Evidence: `/tmp/gator-native-taskmanager-screen-20261003-n77ocl7v`, including the Gradle log,
execution receipt, and XML. Both new unit steps used 1,536 MiB Java heap, 1,024 MiB Metaspace,
in-process Kotlin, and one worker. Their shared container recorded no memory-limit or OOM events.
The completed download Gradle process remained alive after releasing its locks and removing its
registry entry; it was stopped before it could crowd out the next test. The owned test VM was then
closed through its supervisor before assessing the separate release-build budget.

The subsequent release dry-run found a build configuration defect: libsodium hard-coded four
Android architectures and scheduled `:react-native-libsodium:buildCMakeRelWithDebInfo[armeabi-v7a]`
despite the probe's arm64-only setting. The external checker rejected that graph before release
compilation. Evidence: `/tmp/gator-release-graph-20261003-16gbw0w3`; exit 1 in 350.396 seconds,
32 plugin tasks up to date, zero memory-limit/OOM events. Gradle also installed its missing Android
SDK Platform 35 prerequisite; the guest filesystem still had about 4.8 GiB available afterward.

A small `react-native-libsodium+1.7.0.patch` now reads the existing `reactNativeArchitectures`
property, using the same pattern as Gesture Handler and op-sqlite. Its fallback preserves the
dependency's original four architectures and order. Independent review confirms that only native
build selection changes; cryptographic sources, compiler/linker settings, and application
JavaScript/TypeScript are unchanged. The real patch-package tool successfully applied it to a
disposable pristine copy, whose result matches both installed copies. Root and probe now have
**12 identical patches**, with unchanged matching lockfiles. Evidence:
`/tmp/gator-libsodium-abi-patch-proof-20261003-tm7kt36g`.

The corrected release dry-run then **passed in 265.713 seconds**, covering 1,824 planned tasks.
All 20 CMake configure/build tasks select arm64-v8a. The external checker is installed on all ten
Android native builders plus the Hermes host compiler, including the included React Native build.
An independent review added an execution-time backstop that rejects any native task added after
the initial graph callback. Evidence: `/tmp/gator-release-graph-20261003-ee630x9u`, including
`graph-validation.json`. Dry-run verifies task selection and checker installation; it does not
execute or validate the final native compiler commands. Both small VM windows closed and restored
their original limits. The actual release build had not started at that checkpoint.

Follow-up typecheck, all **62 native/workflow host tests**, and the database report with
**2,248 mutations / zero structural or membership errors** pass. Evidence:
`/tmp/gator-libsodium-abi-host-checks-20261003`. The final root host milestone passed with the VM
off: **52 architecture tests**, **five migration tests**, and **538 suites / 6,670 tests**, with
two suites/tests skipped. The migration guard confirms 53 sequential migrations ending at
`0053_versioned_server_message_state`. The combined Jest run took **632.838 seconds** (635.177
seconds including its runner), produced no React or console warnings/errors, and retained no new
Node diagnostic report. Latest UI coverage is **88.35% statements, 91.26% lines, 82.18% branches,
and 88.72% functions**; all aggregate and four critical-file floors pass. Evidence:
`/tmp/gator-post-abi-host-milestone-20261003-7qdc_i4t`, completed at 10:56:35 UTC. This is a fresh
ordinary run after the build-only patch, with pinned Node 24.19 and unchanged heap flags. The
full 115-test database result remains tied to the preceding `35c4462` checkpoint; database and
scanner sources are unchanged by the subsequent build patch.

The first release-resource preflight then stopped before Gradle with `Native build memory limits
not applied`. A bounded diagnostic showed Podman inspection retaining the old settings even
though Linux enforced the requested 9 GiB memory limit and zero swap. The installed client is
5.7.1 and server is 5.6.1. The external helpers now check the live cgroup limits and namespace;
restoration also briefly restarts the idle container to verify its original limits persist, then
stops it. The diagnostic confirmed the original live limits before closing its VM window.
Evidence: `/tmp/gator-release-limit-diagnostic-20261003.json` and
`/tmp/gator-release-limit-diagnostic-restoration-20261003.json`. This is build-infrastructure
evidence, not a successful release assembly.

The supervised release build then ran for **504.647 seconds** before the resource watcher requested
a stop after two consecutive macOS memory-pressure warnings (`host_pressure_warning_twice`). The
build exited 137 when the supervisor stopped its container; the watcher recorded **zero OOM
events**, so this exit is not classified as an out-of-memory kill. It reached React Native's
release Kotlin compilation and the app's dependency-metadata check. The actual Hermes host build
command passed the one-worker checker, but the Android C++ commands had not been verified yet.
No APK was produced. The supervisor verified the original kernel limits after restarting the idle
container, then stopped the container and restored the VM at **11:14:40 UTC**. Host pressure returned
to normal. Evidence: `/tmp/gator-release-build-20261003-j4s5f4_q`,
`/tmp/gator-native-resource-watch-20261003-_i9atwdw`, and
`/tmp/gator-native-build-window-20261003-dhfvo6ga`. This establishes working resource supervision
and restoration, not release-build completion.

A single smaller resource trial used an 8 GiB VM and 7 GiB container, retaining the
4 GiB Java heap, 1 GiB Metaspace, 2 GiB Node limit, and one-worker settings. It stalled
before running any Gradle tasks: the log remained 337 bytes and a Java process-execution
thread consumed a CPU. A bounded thread-dump attempt returned
`AttachNotSupportedException`; a subsequent signal produced no dump. The precise cause
is unknown. The run was stopped after **341.412 seconds**, with normal host pressure and
zero OOM events, and original resource limits were restored at **11:26:08 UTC**. Evidence:
`/tmp/gator-release-build-20261003-7460j9w7` and
`/tmp/gator-native-build-window-20261003-5fz55a7d`. This was a supervised diagnostic stop,
not a successful assembly or an established memory failure.

The next approach changes the Linux build JVM's architecture instead of repeatedly
adjusting memory. Native ARM64 Temurin 17.0.20.1+1 was staged from the cached official
image alongside the existing x64 runtime and tools. The Mac's Java installations, AMFI,
and boot settings are unchanged. Java and its subprocess helper resolve ARM64 libraries;
the actual ARM JVM successfully launched and read output from **seven existing x64
tools**, including Node, Hermes, AAPT2, CMake, Ninja, and Clang. An initial smoke-check
failure came from overly exact expected version banners; the installed SDK metadata
confirmed the actual versions, and the corrected checks passed. Evidence:
`/tmp/gator-arm-runtime-stage-20261003-0vc42r5p` and
`/tmp/gator-arm-tool-smoke-20261003`.

The ARM Java release dry-run then passed in **38.828 seconds**: 1,824 planned tasks,
45 selected Java compile tasks, and all 20 CMake configure/build tasks restricted to
arm64-v8a. Both the Java-selection checker and native-command checker cover all six
build graphs and check again before task execution. The only probe configuration change
sets Hermes to its existing explicit `linux64-bin` compiler path, because React Native's
placeholder does not recognize a Linux ARM host. Root product configuration is unchanged.
Evidence: `/tmp/gator-arm-release-graph-20261003-aw_ktn02`. The compatibility window
closed and restored its original limits. These checks establish runtime/tool compatibility
and task selection; actual release compilation, native worker behavior, and an APK remain
unproven until the monitored full build completes.

The monitored ARM full build subsequently completed JavaScript bundling (**2,441 modules and
50 assets**, 196.083 seconds) and Hermes compilation, then reached Android release Kotlin
compilation. It stopped after **355.762 seconds** because the host again reported two consecutive
memory-pressure warnings. The watcher recorded 24 samples, zero sampling failures and zero OOM
events. Peak observed container use was about 2.81 GiB, well below its 7 GiB limit; Linux still
reported substantial available memory at the warning checkpoints. The immediate limitation is
host pressure, not an established container-memory exhaustion. VM overhead, guest reclamation,
and other host demand were not isolated sufficiently to name a precise cause. No APK was produced.
Original container limits were verified after restart, and the VM was stopped/restored at
**11:53:28 UTC**; host pressure returned to normal. Evidence:
`/tmp/gator-arm-release-build-20261003-6859qzk4`,
`/tmp/gator-native-resource-watch-20261003-475rx651`, and
`/tmp/gator-native-build-window-20261003-ecihfbt5`. This establishes real ARM Java build progress,
while full assembly and phone acceptance remain open. The pressure stops were not weakened.

A follow-up source/history check found useful derivation records for all 14 pending assets, but no
original-art ownership or permission evidence: seven launcher/brand/avatar/splash images trace to
replacement gator artwork introduced in `6d03db4`; five notification icons trace to a separate source
mentioned in `ba737c1` and later resizing in `51a513f`; the two store images arrived in `f821088`,
with a feature-graphic revision in `66869d3`. Their PNG text metadata contains timestamps, and no
tracked original design or asset-specific license was found. Git edits and AI co-author labels do
not establish how the original artwork was created. The owner subsequently identified **Claude**
as the source in response to the question covering all three artwork groups. This owner statement
is recorded for the next provenance update; creation dates, model, applicable terms, and asset
approval were not inferred. Work paused before the inventory was updated.

Device preparation now includes a dedicated temporary Firebase/Android probe registration using the unique `.probe20261003` application-ID suffix. Its configuration remains private and is not reproduced here. Cleanup is planned after device testing; it has not been represented as already completed. A continuously running phone keeper is maintaining device availability. Registration and device preparation are setup work, not successful push, lifecycle, or release acceptance evidence.

A minimal follow-up now reproduces the native-test shutdown problem outside Android, Expo, and
OkHttp. With the same verified Eclipse Temurin **17.0.20.1+1**, the AMD64 JVM under QEMU fails a
cross-thread `ServerSocket.close` at `NativeThread.signal` with `IOException: Invalid argument`;
the native ARM64 JVM passes. Both tests observed a blocked native accept first, and both disposable
containers were removed. This supports a runtime/emulation cause for that operation, without
identifying an exact upstream defect or proving the Expo request assertions. Evidence:
`/tmp/gator-socket-close-results-tbhkbw4v`. Export of the existing real Expo file-system test class
was first intentionally interrupted to return the shared test resources, then reached a 200-second
limit during Gradle configuration. Both attempts stopped the owned container and verified all
459 compiled Expo file-system files remained unchanged. Neither produced an export or a passing
Expo test result. A longer window subsequently completed the export in **238.281 seconds**, with
all 459 compiled files still byte-identical. The actual Gradle task log contains only the reviewed
61 plugin-preparation tasks and the exporter; all plugin tasks were up to date, skipped, or had no
source, and none reported doing work. Gradle's initial task-graph callback omitted later included-build
tasks, so the complete actual-task and outcome sets were separately reconciled after export and before standalone JUnit execution.

The unchanged real Expo tests then passed on ARM64 Temurin 17: **3 tests, zero failures**, with
the exact 247-entry exported classpath, working directory, assertions, and required class locations
verified. Two launcher checks initially failed before JUnit: reading the private Mac-owned mount
required Linux read/search permission, and Gradle legitimately includes a resource JAR among its
test-output entries. Both launcher assumptions were corrected without changing application or test
classes. Independent inspection confirmed that resource JAR is nonmodular. Evidence:
`/tmp/gator-existing-fs-arm64-results-8g_9kbms` and
`/tmp/gator-expo-fs-export-success-20261003-3lv9jlbt/task-validation.json`.
The test container was removed and the VM stopped at 09:27 UTC. This is a standalone execution of
the actual compiled tests, not a rerun of the failed Gradle worker or Android device proof.

The push preflight found that the existing configuration's Android-restricted API key did not
include the probe package. A separate temporary key was created for only the probe package and
the SHA-1 fingerprint read from its signing certificate. Its service allowlist contains Firebase
Management, Cloud Logging, Firebase Installations, and FCM Registration, following the
[Firebase required-API table](https://firebase.google.com/docs/projects/api-keys) and
[Android key restriction contract](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys).
The existing shared key was not changed. After the native job exited, the probe's generated Android
configuration and Expo root fallback were populated with only the verified probe client and its new key.
The latest long-ID source/tests were also synchronized before another build. Final APK signer verification,
push enrollment/delivery, and removal of this temporary key remain pending.

The isolated Linux native build first exhausted its container memory, then reached Hermes source
configuration and failed with `CMake Error at CMakeLists.txt:644: Unable to find ICU.` The missing
container build prerequisite was installed, and the next run completed the 122 native tests above before its file-system test failure. A stale
Java process from the failed attempt was confirmed orphaned after its shutdown log released the
Gradle registry and cache locks; stopping that owned process restored memory without interrupting
the active build. The owned build container and VM were stopped after the third run to free memory
for serialized JavaScript tests. The temporary, inactive 2 GiB swap file was subsequently
removed after verifying its exact owned path and that it was absent from active swap devices.
It was never added to persistent startup configuration. Evidence:
`/tmp/gator-unused-vm-swap-cleanup-20261003.json`.
No Mac reboot, phone reset, existing app replacement, or live server change was used to recover
the build. Partial native results remain separate from the failed overall command.
The owner confirmed that AMFI is disabled and requested completion of coding and available testing
before re-enabling it and rebooting. Boot settings remain unchanged; the Linux build runs separately
from the failing Mac Java runtimes. Rosetta and an additional Mac JDK were not installed.

The October 2 review already described newer source work targeting failures seen on the older v79 device build: locked killed-process V3 delivery, delayed grouped summaries, consumed notification-tap replay, and permission feedback. Those source changes existed before the overnight repair. Their old device failures and the old binary's successful checks cannot be converted into proof of the newly built candidate. Repeat the relevant runbook cases on the exact resulting artifact and retain any server-dependent limits.

## Historical baseline, kept separate

The frozen October 2 review reported **530 passing suites and 6,458 passing tests**, with 2 suites and 2 tests skipped. The combined command still exited unsuccessfully because UI statements were **78.38% against an 82% floor** and lines were **82.73% against an 84% floor**. Branches were 76.49% against 76%, and functions were 80.28% against 78%. It also reported 115 passing full database scanner tests and 2,187 approved mutations with no errors or drift. These numbers belong to that frozen review, not this repair candidate.

That historical dependency audit showed 12 high and 3 moderate entries. The later audit increase is not evidence that the overnight changes introduced dozens of new application vulnerabilities: the newly reported braces advisory affects an already installed version and propagates to many parents. Current root advisory status should be read from the newer `audit-frozen` captures and the package-specific analysis above.

The architecture remains appropriate: the encrypted database owns durable state, a shared writer serializes mutations, account/provider lifetimes fence late work, and event normalization has one entry point. The repairs use those existing boundaries. They do not justify a rewrite or erase the remaining native and release evidence requirements.

One useful concept from this work is that a successful test run, a dependency security audit, and device validation answer different questions. Keeping each result tied to its exact source/dependency candidate prevents a green result from being reused for work it never exercised.
