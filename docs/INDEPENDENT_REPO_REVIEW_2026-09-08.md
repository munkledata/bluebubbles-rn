# Independent repository and original-app review — 2026-09-08

This is a dated review snapshot, not a new work tracker. Current task ownership and completion
remain in [the master plan](./WORK_PLAN_2026-08-03.md). No application code, dependencies, native
configuration, existing documentation, or release artifacts were changed during this review.

**Assessment:** retain the main stack. The offline-first design, encrypted database, runtime input
validation, centralized authentication, and durable delivery queues fit this product. Several
implementation and verification gaps prevent approving the present checkout as correct or ready to
release. The strongest newly identified concerns are automatic HTTP redirects escaping the approved
transport boundary and document-picker copying occurring before the backup size limit.

## Scope and evidence

Reviewed the working tree based on RN commit `e18d548`, including its substantial existing
uncommitted changes; the sibling original Flutter checkout, clean at `8a6e67d32`; and selected
contracts in the sibling canonical server checkout, based on `e55f1210` with uncommitted work. A
separate older server checkout was not treated as the current protocol authority. Findings concern
these local sources, not an inferred installed release.

The review traced storage, transaction ownership, authentication, redirects, setup, account retirement,
push encryption, background entry, send/retry, backup import, attachment boundaries, UI data flow,
dependency selection, and CI. It compared original-app source and checked current official framework
documentation. Existing audit documents supplied context; their old green results were not reused as
fresh verification. This was a risk-based source review with host execution, not an exhaustive proof
of every line, a full server audit, or an Android penetration test. No phone, live messaging account,
production server, Play release, or original Flutter binary was exercised.

Tests ran with Node `24.19.0`. The available npm was `11.19.0`, while this repository requires
`11.17.0`; that environment mismatch is explicitly recorded below. There was no dependency install,
lockfile update, build, or deployment. Synthetic probes used no real credentials or message content.

## Findings, in priority order

### R1 — High priority: redirects can bypass server-origin and cleartext approval

**Source-confirmed defect, with an offline native-library reproduction.**

The app allows Android cleartext networking so a user can explicitly approve a local HTTP server
([app.config.ts](../app.config.ts)). However, ordinary JSON requests do not set a redirect policy
([HttpClient](../src/core/api/http.ts)), and attachment uploads use the legacy Expo upload client's
redirect defaults ([attachmentUpload.ts](../src/services/send/attachmentUpload.ts)).

The installed Expo fetch native implementation defaults to following redirects; its
`NativeRequest.kt` disables both redirect flags only when requested. The installed legacy filesystem
module builds its own default OkHttp client. The declared OkHttp `4.9.2` implementation permits a
307/308 redirect to change host and scheme while preserving the POST body. The app's transport
snapshot checks only whether its configured identity changed; it does not inspect each redirected
request. The owned bounded-download module already rejects redirects, so policy differs by transport.
[OkHttp's versioned implementation](https://raw.githubusercontent.com/square/okhttp/parent-4.9.2/okhttp/src/main/kotlin/okhttp3/internal/http/RetryAndFollowUpInterceptor.kt)
supports this distinction.

An offline Java probe invoked that exact cached library's redirect builder with a synthetic HTTPS
POST and a synthetic HTTP destination. It opened no sockets:

```text
status=307 follows=true destination=http://unapproved.example/receive method=POST authorizationRetained=false bodyRetained=true
status=308 follows=true destination=http://unapproved.example/receive method=POST authorizationRetained=false bodyRetained=true
```

**Impact:** a server or reverse proxy returning such a redirect can cause private request content to
leave the approved HTTPS boundary without HTTP consent. Removing the Authorization header does not
remove message text, uploaded bytes, or sensitive registration data in the body. This requires a
redirect response from the contacted endpoint; the finding does not claim that a passive attacker can
break a correctly established TLS connection.

**Recommendation:** reject redirects for authenticated API calls and uploads before the next request
starts. Where a redirect is actually required, validate every hop under the same explicit transport
policy. Changing JavaScript fetch options alone will not change the independent native upload
client. Extend `TLS-00` to include this implementation gap, then verify 301/302/303/307/308,
cross-origin, and HTTPS-to-HTTP cases on an exact Android build. The probe establishes library
behavior; it is not device traffic-capture evidence.

### R2 — High priority: the current cleanup does not pass its required correctness gates

**Reproduced verification failure.**

The full Jest run reports:

```text
Test Suites: 3 failed, 1 skipped, 470 passed, 473 of 474 total
Tests:       9 failed, 1 skipped, 5370 passed, 5380 total
Snapshots:   0 total
Time:        180.635 s
```

The three failing suites have identifiable integration problems:

| Suite                                                | Observed failure                                                          | What the source shows                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/db/attachmentsBranches.test.ts`                | `TS2322`: `OutgoingInsertResult` is not assignable to `void`, at line 529 | A test's pending-result type still describes the older helper return value; the suite cannot run.                                                                                                                                       |
| `test/services/sendRetryGuard.test.ts`               | Four retry assertions fail; expected one POST but received none           | Its client mock supplies only `post` at line 29. The current retry implementation calls `http.pinTransport()` at `outgoingQueueService.ts:199`, then checks the pinned client. This fixture cannot exercise the new transport contract. |
| `test/components/routes/chatSettingsScreen.test.tsx` | Five cases fail with `Unable to find an element with role: image`         | The real media control now has the more appropriate `imagebutton` role in `MediaSections.tsx:51`; route tests still request `image`, including line 787.                                                                                |

These failures do **not** establish that production retry or media taps are broken. They establish
that the current regression proof is incomplete. In particular, failing early in those route tests
prevents their later account-isolation assertions from being checked.

Other gates also fail:

- Architecture test command: **44 passed, 4 failed**. The scheduled-recovery guard expects old call
  shapes and fingerprints, including `runDueScheduled no longer matches its reviewed AST body
fingerprint`. A fingerprint is a stored representation of reviewed code structure.
- Fast DB scanner suite: **67 passed, 20 failed, 11 skipped**. Many exact-set certificate checks no
  longer agree with the current source.
- DB report: **1,755 detected mutations; 880 structural/membership errors**, including **54 missing
  inventory records**. These are scanner/inventory discrepancies, not 880 independently confirmed
  data-corruption bugs. No finding was labelled `nested-coordinator` in this report.
- Reconciliation stops with `app/_layout.tsx#RootLayout...startOwnedRun... has non-line drift in
detectedContext: expected unresolved`.
- Formatting reports two files: `test/contract/endpointShapes.test.ts` and
  `test/db/migrations/0046_message_send_attempt_owner.test.ts`.

**Recommendation:** restore a verified baseline before extending this cleanup. Review changed
ownership and transport behavior, update fixtures to exercise the real contract, format source and
tests, then reconcile reviewed scanner records. Do not automatically bless new fingerprints or
delete failing assertions to obtain green output. These checks concern a dirty development tree;
they do not invalidate historical evidence for a different frozen commit.

### R3 — Medium priority: backup import limits start after an unbounded native copy

**Source-confirmed resource-boundary gap; no destructive device test performed.**

The backup picker in `app/(app)/backup.tsx` accepts arbitrary file types and sets
`copyToCacheDirectory: true`. Its next step calls `readPickedBackupCopy` in
[`backupService.ts`](../src/services/backup/backupService.ts), which correctly rejects files larger
than the configured **6 MiB** and cleans up the returned copy.

Before returning that URI, the installed `expo-document-picker` Android module calls
`copyDocumentToCacheDirectory`: `FileUtils.copy(inputStream, outputStream)` on newer Android, or
`inputStream.copyTo(outputStream)` on older Android. The copy has no app byte cap or app deadline.
See the installed `DocumentPickerModule.kt`, lines 82–99 and 126–134.

**Impact:** selecting a very large document, or a document provider that stalls while streaming, can
consume storage or leave import waiting before Gator's limit or cleanup runs. Cleanup cannot reach a
partial copy whose URI was never returned. Explicit file selection is required; this is not an
unsolicited share-intent attack. The composer document-picker path also requests automatic copies
and deserves the same boundary review.

**Recommendation:** pick a URI without automatic copying, then use an owned native copy operation
that bounds actual bytes and elapsed time, supports cancellation, and removes partial files. A
provider's advertised size is only an early check, not enforcement. Do not merely switch the flag
off while retaining a reader that assumes a private filesystem URI. The project already applied
this reasoning when disabling unsafe inbound sharing; apply it consistently to backup import.

### R4 — Medium priority: CI omits regression tests for critical safety code

**Verified from workflow and test configuration.**

[CI's DB step](../.github/workflows/ci.yml) runs the scanner against the repository but does not run
`check:db-writes:fast` or the scanner's `.mjs` regression suite.
Jest's configured projects do not discover `.mjs` tests. Consequently a scanner edit can lack the
adversarial checks intended to show that invalid code is rejected. The current fast-suite failures
demonstrate why this is separate evidence from a live scan.

[The Android CI job](../.github/workflows/ci.yml) compiles local modules and builds APK/AAB artifacts
but does not invoke their native unit-test tasks. Existing
Kotlin tests cover paste policies and attachment/background cache policies and scans. Compilation
alone does not execute these assertions. Scheduled Android DB tests are useful and cover another
boundary; they do not replace these native policy tests.

**Recommendation:** run fast scanner regression tests in ordinary CI, the full matrix when scanner
algorithms/certificates/ingress proofs change or on a scheduled lane, and the existing Kotlin unit
tests in the Android job. Preserve the real-device DB lane. No new test framework is needed.

### R5 — Medium priority: dependency health has changed since earlier green checkpoints

**Reproduced against the live registry and Expo compatibility service.**

Both full and production-only npm audits report **4 moderate, 0 high, 0 critical** findings. This is
two underlying advisory families, with the URL-decoder advisory also attributed to its parent
packages `query-string` and `expo-router`; it is not four unrelated exploits.

- Installed `decode-uri-component` is `0.2.2`, through `query-string@7.1.3`. Its maintainer describes
  excessive decoding work and lists `0.5.0` as patched.
  [Maintainer advisory](https://github.com/SamVerschueren/decode-uri-component/security/advisories/GHSA-vcc3-ghjq-m6fr).
- The installed `@xmldom/xmldom` copies are in affected ranges. Patched branches include `0.8.15`
  and `0.9.12`. No exploitable Gator runtime XML-serialization path was demonstrated.
  [Advisory and patched versions](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6).

Reachability was checked rather than inferred from the package name. A synthetic malformed query
of 770 bytes took about 880 ms in the installed `query-string` parser; 1,538 bytes exceeded the
isolated child's two-second deadline. **However, Expo's active `fork/getStateFromPath-forks.js`
parses incoming query parameters with `URLSearchParams`.** That actual function handled the
corresponding 1,544-byte `/home?...` input in about 1 ms. Its outbound fork uses `query-string` for
stringification. Therefore this review does not claim that an ordinary Gator deep link triggers the
advisory. Production dependency classification also does not prove code is present and reachable
in the shipped Android bundle.

The online Expo check reports these patch expectations:

| Package                 | Installed | Expected |
| ----------------------- | --------- | -------- |
| `expo`                  | 57.0.19   | ~57.0.20 |
| `expo-background-task`  | 57.0.15   | ~57.0.16 |
| `expo-build-properties` | 57.0.16   | ~57.0.17 |
| `expo-image-picker`     | 57.0.15   | ~57.0.16 |
| `expo-router`           | 57.0.18   | ~57.0.19 |
| `expo-sharing`          | 57.0.17   | ~57.0.18 |
| `expo-task-manager`     | 57.0.15   | ~57.0.16 |

**Recommendation:** take a focused SDK-matched patch update, then review the resulting lockfile and
remaining advisory paths. Do not use `npm audit fix --force`: the reported suggested Router version
was `5.1.11`, which would be an inappropriate stack downgrade. Do not assume the Expo patches alone
fix both advisories. A documented, evidence-based exception for unreachable code is preferable to
an untested major transitive override. CI's high/critical threshold is a reasonable blocking policy,
but moderate findings still need recorded triage.

## Assessment of the architecture and technology choices

| Choice                                                                          | Assessment and recommendation                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Native + Expo + strict TypeScript                                         | Appropriate for an Android messaging client maintained in TypeScript. Expo 57 / RN 0.86 / React 19.2.3 is the supported major-version combination. Keep it. The rewrite was not itself necessary to obtain security; those improvements come from the design and implementation. There is no measured evidence here that another Flutter or Kotlin rewrite would repay its cost. |
| Offline-first encrypted DB as message/chat truth                                | Strong choice. It supports offline history, notification-driven updates, retry recovery, search, and deterministic reconciliation. Keep remote caches and presentation stores subordinate to it.                                                                                                                                                                                 |
| Platform-free core, services, repositories, UI                                  | Useful separation, backed by boundary tests. API schemas, normalization, and crypto contracts can be exercised without React Native. Services return outcomes while UI owns presentation. The passing layer tests support this structure; the combined architecture gate still fails on scheduled recovery.                                                                      |
| op-sqlite + SQLCipher + FTS5                                                    | Valid integrated choice; both encryption and full-text search are enabled. Keep the existing driver while resolving correctness issues. Expo SQLite also supports SQLCipher and FTS, so encryption alone is not a unique reason to choose op-sqlite. Its current reactive integration and the cost of preserving existing encrypted data are stronger retention reasons.         |
| Drizzle with the owned compatibility adapter                                    | Defensible, but carries real maintenance cost. The installed driver and ORM disagree on method/result shapes, and the Proxy deliberately bridges them and flushes reactive queries. Keep the adapter explicit and small, with real Android contracts; do not remove it merely because the TypeScript interfaces appear compatible.                                               |
| One shared connection and writer queue                                          | The serialization rule is necessary for the chosen connection model. DB-only transactions, opaque context tokens, join tracking, and rollback guards are well-motivated. Raw handles still escape through a broad surface, so safety depends heavily on discipline and custom scanning. Narrow that surface incrementally after the baseline passes.                             |
| Durable incoming and outgoing queues                                            | Correct direction for an unreliable network and killed Android process. Persist-before-effect intake, bounded claims, stable logical send IDs, and exact attempt ownership address actual failure modes. They provide recoverable, repeat-safe processing where identities exist; they do not prove universal exactly-once delivery.                                             |
| Zustand + TanStack Query                                                        | Their roles are sufficiently different to justify both: synchronous session/settings/progress state versus remote request caching and cancellation. Durable message data stays in SQLite. Retain both; keep account retirement and query invalidation explicit.                                                                                                                  |
| Zod                                                                             | Appropriate runtime protection because TypeScript types do not validate server data. REST response limits, canonical event limits, schema parsing, and backup validation are meaningful. Validation after native work cannot bound work that has already occurred, as R3 demonstrates.                                                                                           |
| Socket.IO + RNFirebase + notify-kit                                             | Matches the server protocol and Android headless-delivery needs. Entry-point registrations are correctly placed before Expo Router. notify-kit and libsodium are deliberately excluded from one Doctor directory check, so native compatibility must come from retained build/device evidence rather than that exclusion.                                                        |
| Expo media/file modules and local Kotlin modules                                | Generally sensible. Current imperative contacts/media access uses `/legacy`; uploads use the legacy task API for progress and cancellation. Owned native download/paste boundaries address limits unavailable at the JavaScript layer. R1 and R3 show where native defaults still bypass application intent.                                                                     |
| FlashList v2 and custom iOS-styled Android UI                                   | Appropriate for large conversations. The inspected list renders chronologically and uses v2 position maintenance without obsolete inversion/estimate props. Keyboard handling follows the documented project contract. Retain the visual direction; validate gestures, font scaling, TalkBack, memory, and scrolling on actual target phones.                                    |
| Background tasks and schedules                                                  | WorkManager is appropriate for deferred catch-up, not an exact clock. FCM and foreground recovery remain necessary. The code requests a 15-minute minimum, which matches Expo's documented minimum; Android decides actual execution time. Server scheduling is the stronger place for time-sensitive sends where supported.                                                     |
| Generated Android project, pinned dependencies, isolated release runner, no OTA | Coherent release model. Native folders are generated rather than tracked; plugins own reproducible config. Native releases avoid updating JavaScript against incompatible native code. Pinning reduces variability but needs patch maintenance and a matching npm version.                                                                                                       |

Framework checks: [Expo's SDK compatibility table](https://docs.expo.dev/versions/v57.0.0/),
[Expo SQLite configuration](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/),
[FlashList v2 documentation](https://shopify.github.io/flash-list/docs/v2-changes/), and
[Expo background-task timing](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/).
These support the framework facts; the retain/change judgments are this review's assessment.

## What improved over the Flutter original

The original is a useful product and behavior reference, but its implementation is not a security
standard to reproduce unchanged.

| Boundary                | Original source inspected                                                                                                                                                                                                                                       | RN rebuild                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials at rest     | `lib/database/global/settings.dart` includes `guidAuthKey` in its default settings map and persists strings through SharedPreferences.                                                                                                                          | `ExpoSecureVault` stores credentials separately in Android-backed SecureStore. The in-memory session still needs the credential to make requests.                                                                                     |
| HTTP authentication     | `lib/services/network/http_service.dart:75` adds `guid` to query parameters.                                                                                                                                                                                    | The production composition client uses header authentication and coherent origin/credential snapshots. Legacy query support exists in the core, but is not wired into the ordinary production client.                                 |
| TLS validation          | `lib/services/network/http_overrides.dart` installs `shouldAcceptCertificate` as a bad-certificate callback. It compares the requested hostname to the configured server hostname without inspecting the certificate; that does not validate a bad certificate. | No corresponding bad-certificate bypass was found in the reviewed client paths. Ordinary Android TLS validation is the right default; R1 remains a distinct redirect gap.                                                             |
| Local database          | `lib/database/database.dart` opens ObjectBox without an application encryption key.                                                                                                                                                                             | SQLCipher encrypts the DB; key staging/recovery and serialized rekey explicitly handle interrupted rotation. Host tests cover the orchestration, while actual cryptographic storage needs Android evidence.                           |
| Composition and testing | Global GetIt/GetX service access and reactive settings are widespread.                                                                                                                                                                                          | Explicit interfaces, repositories, runtime schemas, service composition, and substantial host/component coverage improve auditability. The current failing fixtures show that test maintenance must accompany implementation changes. |

Product parity should be judged against accepted scope. This fork intentionally limits platforms,
keeps a dark/iOS-styled UI, disables unsafe incoming Android sharing, and removes embedded Find My
and FaceTime web surfaces and automatic remote preview artwork. These are product/security
trade-offs, not proof that those features were forgotten. Existing parity documents contain
superseded snapshots; their historical gap totals are not a current defect count. Selected current
server source agrees with the client's FCM V2 framing and RCS attempt-generation direction, but
that source agreement is not proof that the matching server is deployed or interoperates on a phone.

## Security choices that need accurate expectations

**App Lock:** keeping biometric authentication off for SecureStore supports headless work, while the
app's lock policy suppresses content and database access on locked push paths. This is a legitimate
usability/security trade-off. It does not make the database key biometric-bound or inaccessible to a
compromised app process. The code correctly notes that `WHEN_UNLOCKED` is an iOS-only option.
[Expo documents the distinction](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/).
Do not enable biometric-bound key storage as a casual fix: it changes killed-app delivery and key
recovery behavior.

**Files:** database encryption does not encrypt attachments, contact images, logs, backgrounds, or
shared-media exports. The README and storage-privacy UI explicitly describe this. Retaining ordinary
app-private files is a product threat-model decision; describe it clearly, and treat stronger file
encryption as its own design if the product requires it. Root detection and screenshot blocking do
not substitute for encryption.

**Crypto:** XChaCha20-Poly1305 plus Argon2id is a sound backup construction using native primitives.
The reviewed chunked envelope binds frame order, header, and final marker to authenticated data and
bounds input before expensive cryptographic work. Maintaining a custom envelope still creates a
long-term compatibility obligation. Preserve its versioned costs and independent conformance tests.
The current per-device AES-GCM FCM format is stronger than the legacy fast password-derived format;
the migrated-state gate rejects silent plaintext/V1 fallback. Complete replay/destination identity
and current-device delivery evidence remain separate work. Do not describe the Mac bridge as an
untrusted relay: it necessarily has access to the messages it handles.

## Maintainability and release judgment

The main architectural reservation is the amount of custom verification machinery needed to police
the implementation. At review time, `scripts/check-db-writes.mjs` is **14,675 lines**, its test file
**8,137 lines**, and the master work plan **15,838 lines**. App/source TypeScript totals about
**100,077 lines**, including substantial device self-test code. Line counts are not a quality score,
but the broad fingerprint failures show the practical coupling: routine source edits can invalidate
large proof sets.

Keep safety checks, but make fewer invariants depend on exact function-body shape. Prefer narrow
transaction capabilities, small command owners, behavioral contract tests, and a concise active
work view. Extract device proof machinery from production-facing DB modules when doing a focused
maintenance step. Do not combine that refactoring with new send/concurrency behavior or delete
guards before equivalent enforcement exists. The existing [stack ADR](./APP_STACK_ADR.md) is a good
decision record; acceptance of a library should remain open to measured reliability, compatibility,
security, and maintenance evidence.

Release evidence belongs to an exact candidate. The recorded version-code-59 build uses source
`7a3aa20`, which predates the current uncommitted changes. Its runbook explicitly leaves device and
Play proof open. Native encryption/rekey and crash recovery, new FCM/RCS behavior, account switching,
redirect rejection, document-provider limits, notifications, permissions, and UI performance must
be exercised on the next frozen Android candidate with the matching server. Current licensing and
asset-provenance work also remains an explicit distribution gate in the repository; this review does
not resolve it.

## Verification ledger

| Check performed                                     | Actual result                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                 | Passed, exit 0. Node test files are checked separately by Jest's TypeScript project.                                                                                                                          |
| `npm run lint -- --max-warnings=0`                  | Passed, exit 0.                                                                                                                                                                                               |
| `npm run check:migrations`                          | Passed: 46 sequential migrations; head `0046_message_send_attempt_owner`; 5/5 guard tests.                                                                                                                    |
| `npm run check:secret-hygiene`                      | Passed: 4/4 tests; 1,110 tracked files and 1,161 historical paths checked. This is the scanner's scope, not a guarantee about all untracked material.                                                         |
| `npm test -- --runInBand`                           | Failed: 470 passing suites, 3 failing, 1 skipped; 5,370 passing tests, 9 failing, 1 skipped. Full run was not silenced; React `act` warnings also appeared.                                                   |
| `npm run check:architecture`                        | Failed: 44/48 tests pass; four scheduled-recovery checks fail. Layer-boundary tests pass.                                                                                                                     |
| Standalone `node scripts/check-core-boundaries.mjs` | Passed: 73 core files, 133 UI-free service files, 150 UI/app files with read-only DB ownership, 1,673 synchronous runtime edges without cycles, no embedded WebView imports, and seven ordered entry imports. |
| `npm run check:db-writes:fast`                      | Failed: 67 pass, 20 fail, 11 intentionally skipped in the fast selection.                                                                                                                                     |
| `node scripts/check-db-writes.mjs --report`         | Reports 1,755 mutations and 880 structural/membership errors. Its reporting exit code is 0, which does not mean approval.                                                                                     |
| `node scripts/check-db-writes.mjs --reconcile`      | Failed on non-line context drift; no inventory write requested.                                                                                                                                               |
| `npm run format:check`                              | Failed on the two test files named in R2.                                                                                                                                                                     |
| Online `CI=1 expo install --check`                  | Failed: seven SDK patch expectations listed in R5. Sandboxed offline fallback had misleadingly reported up to date while warning that validation was unreliable.                                              |
| Full and `--omit=dev` npm audits                    | Both report 4 moderate, 0 high, 0 critical. The initial sandbox DNS failure was retried with approved registry access.                                                                                        |
| `node scripts/check-toolchain.mjs`                  | Failed: `npm on PATH is 11.19.0, but npm 11.17.0 is required`. This is a local environment issue, not an app defect.                                                                                          |
| Offline OkHttp redirect probe                       | Both 307 and 308 preserve the synthetic POST body across HTTPS-to-HTTP/origin change; authorization is removed. No network or phone involved.                                                                 |
| Decoder probes and active Expo parser control       | Affected dependency shows excessive work; active Expo incoming-query function handles the control promptly. No Gator deep-link exploit established.                                                           |

No new UI coverage run, clean native build, full adversarial ingress matrix, native Kotlin test run,
Doctor run, device session, or live server test was performed. The failed baseline already prevents
release approval, and the review did not mutate application code. Temporary host logs and the
offline redirect probe are under `/private/tmp`; the key results are preserved here because temporary
files are not durable evidence storage.

## Recommended repair sequence

1. **Restore the baseline:** use the pinned toolchain, review the changed send/scheduling ownership,
   repair the three stale test suites, format, and reconcile reviewed safety checks. Verify this
   milestone before introducing more behavior changes.
2. **Close transport redirects:** enforce one pre-request redirect policy across JSON and native
   uploads, with source tests and Android traffic proof. Avoid adding certificate pinning to solve
   a redirect-policy problem.
3. **Bound document imports:** retain explicit user selection while owning byte/time limits and
   partial cleanup before native copying. Exercise large, false-size, stalled, and cancelled provider
   streams on Android.
4. **Complete maintenance enforcement:** take SDK-matched patches, triage advisories, and wire
   existing scanner/native tests into CI. Verify the resulting lockfile and native build once frozen.
5. **Prove the exact product:** run the matching app/server device matrix and release/provenance gates.
   Defer broad architectural simplification until the preceding behavior is stable.

The useful lesson from this review is **test the enforcement point**: a size limit after a native
copy, an origin check before an automatic redirect, or a passing typecheck with stale test fixtures
does not establish the property its name suggests.

## Remediation follow-up — 2026-09-09

This follow-up records work performed after the dated review. It does not rewrite the observations
above or turn host evidence into Android, Play, server, licensing, or exact-candidate approval.

| Finding                    | Follow-up disposition                                                                                                                                                                                                                                                                                                                                      | Remaining proof                                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 — redirects             | Implemented for ordinary Ky requests, raw multipart requests, and Expo legacy uploads. Production configuration rejects the incompatible React Native fetch mode; the exact Expo FileSystem patch/build-from-source chain and native MockWebServer tests are pinned. Focused host suites passed 52/52 and the native redirect class passed 3/3.            | Capture exact-candidate Android traffic for 301/302/303/307/308, same/cross-origin, and HTTPS-to-HTTP cases and prove the redirect target receives no body or credential. `TLS-00` remains open; `TLS-01A` later closed on Play v63 without redirect credit. |
| R2 — broken baseline       | The three originally stale suites were repaired. The later credential-upgrade union and chat effect drift were also corrected; focused durable-session, quarantine, and chat tests pass, and current TypeScript, zero-warning lint, and source/test formatting pass.                                                                                       | Freeze the changing tree, complete the independently reviewed scheduled-send certificate, full DB-write scanner/reconciliation, architecture gate, and final broad Jest gate before calling the baseline closed.                                             |
| R3 — unbounded backup copy | Backup import now selects a provider URI without DocumentPicker's automatic copy and hands it to the owned `gator-bounded-document` native module. The copy enforces advertised-size, actual-byte, deadline, cancellation, and partial-file cleanup boundaries before parsing. Host tests passed 34/34; native unit and release-Kotlin compilation passed. | Exercise near-limit, oversized, lying-size, stalled, cancelled, cleanup, and responsiveness cases through a real Android document provider. `BACKUP-02` implementation is complete; candidate/provider evidence remains release work.                        |
| R4 — CI omissions          | Ordinary CI now runs the fail-closed fast DB scanner suite. Android CI runs applicable native unit tasks for paste, share, bounded document, bounded download, and patched Expo FileSystem code before packaging. The workflow guard passes 37/37 plus its live check.                                                                                     | Obtain the first hosted CI run from the frozen replacement source; local workflow parsing is not hosted execution.                                                                                                                                           |
| R5 — dependency drift      | SDK 57 patch releases are aligned, Expo FileSystem is exact-pinned and patched, and the reviewed XML/YAML transitive fixes landed without a force downgrade. The Expo package check and pinned Doctor pass 20/20; full and production audits pass the high-severity threshold.                                                                             | Preserve and periodically recheck the recorded moderate `decode-uri-component` family disposition; do not apply npm's incompatible forced Router downgrade.                                                                                                  |

A separate replacement-candidate path-hygiene repair is also implemented. Release/CI native builds
use exact compiler prefix maps to `/gator/source` and `/gator/gradle`, followed by an exhaustive
compile-database proof. The artifact scanner accepts only two path-and-digest-pinned OpenSSL outputs
from `io.github.ronickg:openssl:3.3.2-1`; it has no broad `/Users` or `/home` allowlist. Focused
release/artifact/path tests pass 38/38, toolchain/release tests pass 32/32, and workflow-security
tests pass 37/37. A clean mapped native build and new receipt-bound AAB are still required, so no
uploadable replacement candidate exists at this checkpoint.
