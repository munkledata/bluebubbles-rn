# DL-01 Play v75 device proof — 2026-09-18

> **Disposition:** `DL-01` is `DONE` under the owner's approved evidence split. Play-delivered v75
> passed the scoped Android 16 / API 36 matrix on the physical Samsung. A Google-generated,
> Play-signed v75 universal APK from the same candidate passed the Android 17 / API 37 matrix from a
> sideloaded installation, and controlled host/native proof covers destructive private-state
> branches. Per-OS Play-delivery provenance, including a future genuine Play-installed API 37
> repeat, now belongs to `DEVICE-01`/release scope rather than this remediation item.
>
> **Scope limit:** This checkpoint does not close `DEVICE-01`, a fresh-install journey, private
> cache migration from an approved prepared baseline, a distinct account-A→account-B journey, the
> general staged-server matrix, or any release-operation task in `RELEASE_PLAN.md`.

## Candidate identity

| Field                      | Observed value                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                         |
| Version                    | `0.1.55` / Android version code `75`                                                              |
| Built source               | `546750a0844adc48733436f26d81ebea63f0319c`                                                        |
| Release commit/branch      | `9c73c1ffb0d4d63ecc562ab988ae73f28c8750dc` / `release/android-0.1.55`                             |
| Release run                | `android-0.1.55-546750a-20260918055448`                                                           |
| Submitted AAB              | `gator-release-0.1.55-v75-9c73c1f.aab`; 57,878,322 bytes                                          |
| AAB SHA-256                | `86e7ee236f2caa644e97b645fc9d0ec1fa562fc105ffa5bb26549d44f42b3197`                                |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Play certificate SHA-256   | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                |
| Submission                 | `8953c1c0-79f1-463a-a3cf-1ff1b49f46b5`; Internal; finished/completed                              |
| Play readback              | Release `0.1.55`, version code `75`, status `completed`                                           |
| Android boundary           | `minSdkVersion=36`, `targetSdkVersion=36`; Play API 36 and supporting API 37 matrices passed      |

The guarded release receipt passed zip integrity, packaged-artifact identity, signature, hash,
Google Maps key binding, and native-path checks. The official Google-generated universal APK used
for the API 37 run was 74,326,414 bytes with SHA-256
`9a2a549a7cd52224ac07559b12106e05f718ea2b818ca4e4f749cf9ae19e6340`; `apksigner`
verified its v3 signature, Google SourceStamp, and the Play certificate above. Separate package
inspection verified its version/build, API floor, and ABI.

The final recorded fail-closed release-runner state was `submission_unknown`. Completion was
established at the time by the separate direct-submission recovery result (`FINISHED` / `COMPLETED`)
plus the matching Play readback, not by rewriting that runner state. Those local runner receipts are
no longer retained; their bounded identities and results are preserved in this record and the
release plan.

## Evidence boundary

The v56 candidate identity in `DEVICE_VERIFICATION_CHECKLIST.md` is retired, but its current slice 2
evidence-class and safety rules supersede historical section `(j.1)`. They prohibit treating a
sideload as Play-delivery proof and prohibit private-state fabrication on a tester candidate while
assigning exact quota/corrupt-state branches to `STATIC/HOST + LOCAL-DEV SUPPORTING ONLY`.
Accordingly, neither device was modified with `run-as`, private DB/cache fabrication, symlinks,
thousands of synthetic private files, or fake multi-gigabyte ownership. Only app-exposed aggregate
diagnostics and sanitized fixture counters are reported. The owner-approved closure combines the
genuine Play-installed API 36 run, supporting API 37 behavior, and controlled proof; it does not
relabel the sideloaded API 37 installation as Play delivered.

## Play-installed Samsung / API 36 runtime results

The candidate verifier independently matched version `0.1.55` / code `75`, minimum and target API
`36`, API `36`, arm64, physical-device identity, installer `com.android.vending`, every installed
split's Play certificate, source/AAB receipts, and the direct submission-recovery receipt. The app
then connected only to the isolated loopback fixture through an ADB reverse mapping.

### Transport, image, lifecycle, and cache integration

- Valid, missing-length EOF, and finite-chunked controls completed once. False-smaller and
  false-larger lengths, invalid image bytes, and an 8,193 × 8,193 dimension bomb made one bounded
  request each without a successful result.
- Endless and 5 MiB-plus-one responses stopped at their actual-byte boundary. A no-body stall and an
  eight-byte partial response both closed through the native time boundary. No connection remained
  active afterward.
- A valid maximum automatic attachment transferred exactly 5 MiB. When delivered to a killed app,
  the private download completed while the public Gator Album count stayed unchanged; foregrounding
  created one copy, and two later foreground drains created no duplicate.
- A held download followed by a destination change created no album copy. A second held download
  followed by turning automatic downloads off also created no copy. The original setting was
  restored after each case.
- Killing the ordinary app process during a held transfer removed the process and brought the
  fixture's active/held counts back to zero. Relaunch returned normally. The resulting pending media
  receipt was then cancelled through the documented destination change; the final aggregate showed
  zero pending receipts.

The physical phone was not filled by hundreds of gigabytes merely to force the 512 MiB branch, and
it was not rooted for the post-MediaStore stop window. Those two unsafe fault-injection branches
retain their API 37 and controlled host/native proof below.

### Gallery and wallpaper outcomes

- Four successful fixture images produced exactly four completed Gator Album exports. The valid
  maximum killed/background case produced no public copy until foreground, and repeated drains did
  not duplicate it. The destination/off cancellation cases produced none.
- A killed-process wallpaper event made zero download requests. Opening its synthetic chat in the
  foreground made one request and retained exactly one 10 MiB wallpaper.
- Invalid wallpaper bytes and an 8,193 × 8,193 wallpaper each made one request and retained no
  additional file.

The fixture ended after generation 18 with **96 API requests, 67 authenticated control requests,
zero unauthorized requests, 18 download requests, 18 encrypted FCM sends, 18 started and 18
finished responses, 26,280,603 attempted bytes, and zero active or held connections**.

The final safe diagnostic snapshots reported version/build/API `0.1.55` / `75` / `36`, all 48
migrations through `0048_attachment_media_exports`, DB/ownership bookends `Yes`, zero active
transfers, owned destinations, temporary files, and temporary bytes, a verified temporary scan,
zero pending and four completed Gallery/Album receipts, three wallpaper channels, one valid local
reference/file totaling 10 MiB, zero invalid or missing references, and both wallpaper quota flags
`Yes`.

One automated whole-report capture missed six rows, and a smaller-overlap retry stopped on a
partially clipped label/value pair. The exact errors were
`The Download Integrity capture is incomplete (6 aggregate rows missing).` and
`The visible diagnostic row ATTACHMENT CACHE / Reserved present / missing has no value.` After two
attempts, the run used the valid top/bottom aggregate snapshots plus fixture counters and the already
complete API 37 aggregate instead of weakening the fail-closed parser or repeating tests.

## API 37 Play-signed runtime results — supporting only

### Transport, cancellation, storage, and process death

The isolated fixture used bounded synthetic content and aggregate counters only.

- Valid, missing-length EOF, and finite-chunked controls each committed exactly once.
- False-smaller and false-larger lengths failed closed without a completed path.
- An endless response reached 5,374,519 attempted bytes and the 5 MiB-plus-one response reached
  5,242,881 bytes; neither committed.
- A no-body stall closed at about 100 seconds. An eight-byte partial response closed at about 123
  seconds. Neither left a completed path.
- Explicit cancellation closed within one second.
- Immediately before ordinary process death, diagnostics showed one active transfer, one owned
  destination, one zero-byte partial, and a 5 MiB reservation. Cold restart converged to zero active
  transfers, partials, reservations, and retiring files, with no false `localPath`.
- With only 341.11 MiB available, the 512 MiB floor failed before any request, reservation, partial,
  or DB path was created. The temporary space constraint was removed afterward.
- A legitimate maximum automatic attachment transferred exactly 5 MiB once and committed normally.

The final API 37 report showed zero active transfers, owned destinations, temporary files, reserved
files, and retiring files. Three ledger files matched three native files and three distinct DB paths,
with zero missing, mismatched, or untracked files. The current account generation was `3`, with zero
foreign-generation, unscoped, or legacy-layout files; settled DB/file state was exact.

### Gallery / Gator Album receipts

- A killed/background synthetic image created no immediate public-album copy. The private file and
  authoritative DB path completed before foreground activation exported one copy.
- Two additional foreground drains left the public media count unchanged.
- Changing the destination from Gator Album to App only while a held transfer was active cancelled
  the pending work and created no album copy. Turning automatic downloads off produced the same
  result. The original setting was restored after each case.
- For the crash window after MediaStore success but before receipt completion, an external rooted
  emulator watcher sent `SIGSTOP` to the Play-signed v75 process immediately after each public-file
  close; the run then sent `SIGKILL` to that exact PID. It never used Android force-stop. After the
  first, second, and third stops, diagnostics reported attempts `1`, `2`, and `3`; the public count
  advanced once per attempt. After the final lease expired, another foreground drain produced no
  fourth copy. The receipt finished terminal, pending `No`, leased `No`, attempts `3`, and the public
  count remained unchanged.

Modern supported Android MediaStore writes do not use the retired broad storage permission. The
app's check-only/no-passive-prompt branch remains source/host verified; an artificial legacy
permission denial was not created on API 36/37.

### Images and synced wallpapers

- Invalid image bytes and an 8,193 × 8,193 dimension bomb were rejected without a completed
  attachment path. A valid maximum attachment succeeded.
- A killed-process wallpaper event made no download request until foreground activation.
- One valid maximum wallpaper made exactly one request and produced one 10 MiB native file.
- Invalid wallpaper bytes and an 8,193 × 8,193 wallpaper each made one bounded request and produced
  no additional file.
- Final diagnostics showed three wallpaper channels, one DB local reference, one distinct valid
  reference, two channels without paths, zero paths without channels, one native file / 10 MiB,
  zero invalid or missing references, and both the 90 MiB/255 and 100 MiB/256 limits satisfied.

### Account cleanup and supported Android versions

- Disconnect returned the app to onboarding while leaving already exported public album media alone.
  A fresh reconnect to the same isolated fixture registered normally; the app-exposed report showed
  the current account generation with zero foreign-generation, unscoped, or legacy-layout files.
  Controlled cleanup tests retain proof of the internal deletion mechanics; no raw private path
  receives candidate credit, and this run claims no distinct account-B isolation result.
- Android 17 / API 37 ran version `0.1.55` / build `75` and exposed the aggregate diagnostic results
  above. Its installer was `null` / `com.android.shell`, so this runtime result is supporting-only and
  does not satisfy the runbook's Play-install requirement.
- On the Samsung Android 16 / API 36 boundary device, Google Play naturally updated the existing
  Play installation from build 73 to build 75 without uninstall or data clearing. `firstInstallTime`
  stayed unchanged, the existing session opened to Messages, `.MainActivity` remained resumed, and
  the running build reported version `0.1.55`, code `75`, minimum/target API `36`, installer
  `com.android.vending`, and the expected Play certificate. The five scoped `DL-01` groups then ran
  on that Play installation as recorded above. This remains no claim about prepared legacy
  private-cache migration or a distinct second account.

## Controlled host/native evidence retained

Existing focused tests remain the authoritative proof for private or fault-injected state that must
not be manufactured on a tester candidate:

- exact actual-byte and absolute-deadline caps, response-length mismatch, abandoned `.part`
  cleanup, reservation/ledger settlement, and late-result cancellation;
- destination-receipt admission/commit before native download bytes, guarded `localPath` settlement,
  and the receipt drain state machine;
- the 2 GiB, 4,096-file, and 512 MiB-free attachment-cache limits; deterministic least-recently-used
  selection; failed/raced deletion remaining charged; recent, mounted, in-flight, media-export, and
  outgoing/retry protection;
- zero-byte repair, canonical and legacy/two-level adoption, two-generation recovery, duplicate
  paths, corrupt/malformed/unreadable/symlinked/raced layouts, and bounded reference scans;
- synced-wallpaper 90 MiB/255 preflight and 100 MiB/256 final ceilings, current-wallpaper protection,
  safe pruning, failed deletion, numeric overflow, and 8,192-file/32,768-node scan limits.

The current hostile-fixture regression suite passed **14/14 tests**. The frozen implementation
checkpoint also recorded **3 Node suites / 82 tests**, **45 bounded-download native unit tests**,
release Kotlin compilation, strict TypeScript, and the fast DB-write scan at **91 passed / 13
intentional skips / 0 failures**. These tests support the runtime observations; they are not
misrepresented as Play-install device proof.

## Cleanup and limitations

- Fixture credentials, endpoints, raw push payloads, message content, filenames, private paths, and
  database rows are absent from this report.
- A transient physical-device UI hierarchy contained ordinary visible private screen content. It was
  immediately deleted from the device, was not copied into the repository, and received no evidence
  credit. Only safe package/activity aggregates were retained.
- The earlier API 37 run ended at the Gator welcome screen and removed its nine known synthetic
  album exports. The final Samsung Disconnect also returned Gator to onboarding. Android's normal
  Files UI permanently removed exactly the four current-run synthetic exports, returning the public
  Gator Album from nine files to its five older pre-run files; those unrelated files were left alone.
- Rooted watcher processes, temporary low-storage filler, reverse port mappings, fixture processes,
  transient APK/UI copies, and fixture UI hierarchies were removed after use.
- `DEVICE-01`/release still owns genuine Play-installed API 37 provenance, the fresh-install/general
  journey, any prepared prior-build private-data upgrade evidence, and distinct account-A→account-B
  isolation. The four release-operation task statuses remain governed by `docs/RELEASE_PLAN.md`.
