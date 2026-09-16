# STORE-01G — Internal Testing readiness runbook

> **Status (2026-09-15): SUPERSEDED V63 EXECUTION SNAPSHOT — REFRESH BEFORE ANY CURRENT ROUND.** The
> candidate-specific values and completed rows below describe the former `0.1.46` / code `63` round.
> Current candidate identity and status live in [`RELEASE_PLAN.md`](./RELEASE_PLAN.md) and
> [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md). Do not execute a current staged round from this file
> until its candidate fields, notices, prerequisites, and evidence rows are deliberately refreshed.

This is the secret-free operational companion to `STORE-01`. Keep individual tester identities,
private endpoints, credentials, QR payloads, and the Play opt-in link outside Git. Record only the
non-secret labels, owners, counts, dates, and evidence references needed to reproduce the round.

## 1. Superseded v63 candidate boundary

This snapshot's candidate was frozen from one release run. The table is historical and must not be
substituted for current candidate identity or an ambiguous “latest” build:

| Field                 | Snapshot value                                                        |
| --------------------- | --------------------------------------------------------------------- |
| App version/code      | `0.1.46` / `63`                                                       |
| Source commit         | `dc32380c6cb17d85e7ab08c4d5b9118660f763c8`                            |
| Release commit/branch | `a1ba9af51c46aac08f9c00e2c7c84762bb78cb2b` / `release/android-0.1.46` |
| Release run           | `android-0.1.46-dc32380-20260913175233`                               |
| Local AAB             | `gator-release-0.1.46-v63-a1ba9af.aab` — ignored; never commit it     |
| Size                  | `56,150,828` bytes                                                    |
| SHA-256               | `4a9c83a521b6eb20404d502b535a2001e201ae71f1a9f3a88d703aed79221a06`    |
| Submission            | Internal Testing; EAS id `63ddf33f-b3f1-496d-afcf-b7ee4c53a751`       |

The exact source, build, validation, promotion, submission, and device evidence is summarized in
[`RELEASE_PLAN.md`](./RELEASE_PLAN.md) and frozen in
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md). The bounded automatic-preview device result is
frozen in [`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md). The
superseded records below remain history only.

### Superseded v62 — historical Play and bounded-device proof only

Version `0.1.45` / code `62`, source `8179d0a3a99c4e2e28a01fd83212fee919bad41c`, release commit
`644a566fb54da7d2c195e369d11677acfce097ea`, and run
`android-0.1.45-8179d0a-20260910075110` produced
`gator-release-0.1.45-v62-644a566.aab` (56,141,406 bytes), SHA-256
`110efe12a0d5cc620b2a523787bb95139f3f2ddf86550449d16de7d8fcd2bd51`. Submission
`736e29d7-d0d1-48f7-8f68-6095ce240d10` reached Internal Testing, and its natural Play update,
unsupported-scheme rejection, and ordinary-kill relaunch are retained in
[`PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md`](./PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md#replacement-candidate-closure--2026-09-10).
Those device results remain historical and do not transfer to v63.

### Superseded v59 — historical static proof only

The following artifact predates later source changes. It must not be uploaded, submitted, or
installed as the replacement, and cannot be credited to any replacement source, artifact, Play, or
device gate:

| Field                      | Superseded historical value                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                                   |
| App version                | `0.1.43`                                                                                                    |
| Android version code       | `59`                                                                                                        |
| Candidate source commit    | `7a3aa2058ad1bea4252379b2ea3df285e1fd94ef`                                                                  |
| Release commit/branch      | `e108ad7756cf2ae67a6873cbd1e1526df0613e18` / local `release/android-0.1.43`                                 |
| Release run                | `android-0.1.43-7a3aa20-20260904145333`                                                                     |
| Local AAB                  | `gator-release-0.1.43-v59-e108ad7.aab` — ignored, never commit it                                           |
| Size                       | `55,818,682` bytes                                                                                          |
| SHA-256                    | `e2a60f7b06837b47484f71d79fccb0c585ead745a2e1a1a48952d54cd5bdc0af`                                          |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`           |
| Packaged boundary          | arm64-v8a only; package/version/signature/entry/permission/share/DEX guards passed; no device or Play proof |
| Build boundary             | Owner-approved EAS-backed local production build, validation, and local promotion passed; no hosted build   |
| Distribution boundary      | Never uploaded; now prohibited from upload or submission                                                    |

### Superseded conforming v58 — historical static proof only

The former `0.1.42` / version-code-58 candidate remains preserved at source commit
`fd02247578e928d909f0ce73c083c3cbcedffb4c`, release commit
`7942ed5bfbdce28ecadfefc54e7bd7cdde2e57d8`, and release run
`android-0.1.42-fd02247-20260830231420` as `gator-release-0.1.42-v58-7942ed5.aab`
(`55,969,473` bytes), SHA-256
`ad7538bc3436eea017690801efdaa307a22a0565229c94006f7aacc278270298`. Its local build,
validation, and promotion passed, but it was never uploaded, submitted, installed, or exercised on
a device. Do not upload it or use it as current candidate evidence.

### Frozen nonconforming v57 — static proof only

The former `0.1.41` / version-code-57 candidate remains preserved at source commit
`8564b348d02c4e218e8a75a6a36e265ec5740772` as
`gator-release-0.1.41-v57-8564b34.aab` (`55,768,266` bytes), SHA-256
`3ad096fe474fb35b8f0619ca9b9ac337dc3613d16a1df1f98d638176ef25be2b`, upload certificate
SHA-256 `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`.
It is arm64-v8a, minimum SDK 24, target SDK 36, and backups-disabled, but it predates the approved
`PLAY-02` removal in `9046e27`. Do not upload, submit, install, or use it as current runtime evidence.

### Earlier retired v56 — static proof only

The former candidate remains preserved as `0.1.40` / version code `56`, source commit
`5d367eb58e38126258423f1cd9ce0da42b179f7f`, AAB
`gator-release-0.1.40-v56-5d367eb.aab` (`55,729,707` bytes), SHA-256
`926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`. Static proof remains
historical; no Play, tester, install/update, device, notification, or cleanup result transfers to a
replacement candidate.

The v63 run superseded the earlier histories above when this snapshot was current. Its local build retrieved the managed
upload credential, consumed version code `63` once, and submitted the validated artifact only to the
Internal track. Never select an ambiguous “latest” build for a future action.

### V63 snapshot execution state

The v63 source freeze, local production build, validation, promotion, Internal submission, Play
clean install, and bounded automatic-preview matrix are complete. V62's natural-update,
unsupported-scheme, and ordinary-kill results remain history only. Follow the
authoritative [`STORE-01`](./RELEASE_PLAN.md#store-01) status and `RELEASE_CHECKLIST.md` section 0.
No general staged-server setup or wider-track promotion is implied or approved. Future sessions should read
the release plan, checklist, and this runbook before consulting the historical records below.

## 2. V63 snapshot proven state

- `eas.json` has one Android submission target: Google Play track `internal`.
- Version `0.1.46` / code `63` was this snapshot's retained candidate. It was submitted only to Internal
  Testing and clean-installed through Play on one Samsung `SM-S938U1`, Android 16 / API 36.
- The v63 source contains the reviewed V2/V3 app work and is installed through Play, so the app
  candidate build/install prerequisite for the RCS/FCM matrix is satisfied. Server-owned RCS attempt
  identity is source/host-green at server commit `e55f1210`, but no isolated staged environment has
  paired and freshly enrolled this exact Play candidate against that server. The text/media echo,
  scoped V3 FCM, physical-phone namespace, replay, and restart/re-pair rows remain open in
  [the candidate matrix below](#61-push-retry-01-immutable-rcs-attempt-identity). The superseded v59
  incompatibility is history only and no result transfers from it.
- The release build phase is local-only and cannot submit. A separate submit phase previews by default and requires
  `--execute` plus an interactive candidate-specific phrase; that separately authorized path submitted v63 to
  Internal Testing on 2026-09-13. The existing
  GitHub Actions native lane compiles disposable fixture/debug-signed APK/AAB verification artifacts. Manual run
  [`33476443641`](https://github.com/munkledata/bluebubbles-rn/actions/runs/33476443641) also completed the four
  disposable database lanes on an API-36 x86_64 emulator; the workflow's first configured schedule occurrence was
  unobserved, so genuine schedule proof remains open. These supporting artifacts are not release candidates and do not
  use EAS Build or submit to Play.
- This snapshot's local production run advanced the EAS remote Android counter from `62` to `63`, fetched
  the managed keystore, completed the Gradle bundle, validation, and promotion, then used the
  separately authorized submit phase. No hosted build was created.
- The most recent pre-build read-only EAS history contained 22 hosted Android builds; the newest
  hosted artifact was version code `54`, with hosted counts for `55` and `56` both zero.
- The snapshot's submission receipt records successful Internal Testing submission id
  `63ddf33f-b3f1-496d-afcf-b7ee4c53a751` on 2026-09-13. This proves the requested destination and
  successful submission outcome, not every live Play Console field.
- EAS records requested submission configuration, not current Google Play state. Pinned EAS CLI
  `21.5.0` states that Google Play app status is not available through EAS and exposes no tester list,
  opt-in link, or live track inventory.
- The v63 app was clean-installed from Play and its installed APK matched the expected Play App
  Signing identity. Live tester-list, opt-in-link, declaration-prompt, and wider-track inventory
  remain open because the submission receipt and installed package do not expose those fields.

Google's current [Internal Testing guidance](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)
allows up to 100 testers, requires eligible Google accounts in a selected email list, asks for a
feedback email or URL, and provides a shareable opt-in link. The link is displayed only after the
app status is `Published`, not while it is `Draft` or `Pending publication`. Each tester must be both
included and opted in. Do not confuse Play Internal Testing with EAS
`distribution: "internal"`, which is a separate direct-APK mechanism and is not the selected channel.

## 3. Owner inputs — do not put private values here

Recommendation: use a dedicated Play email list named `gator-internal-testers` and a private
feedback email or access-controlled form. A stable name makes the configuration auditable, while a
private feedback destination avoids accidental disclosure through this public repository's Issues.

| Decision                             | Safe value to record in Git                                   | Status   |
| ------------------------------------ | ------------------------------------------------------------- | -------- |
| Play tester list label               | `gator-internal-testers`                                      | RECORDED |
| Intended tester count                | `1`                                                           | RECORDED |
| Membership administrator role        | `Project owner`                                               | RECORDED |
| Opt-in-link custodian role           | `Project owner`                                               | RECORDED |
| Private feedback channel label       | `Private feedback email`                                      | RECORDED |
| Primary response owner role          | `Project owner`                                               | RECORDED |
| Backup response owner role           | `None — halt test if project owner unavailable`               | RECORDED |
| Response target                      | `Acknowledge within one business day`                         | RECORDED |
| Person/role allowed to halt the test | `Project owner`                                               | RECORDED |
| Staged-server maintenance owner role | `Project owner`                                               | RECORDED |
| Test window and credential expiry    | `7 days from first Play install; expire within 24h after`     | RECORDED |
| Approved device/Android matrix       | `Pixel 10 Pro XL / Android 17; Galaxy S25 Ultra / Android 16` | EXPECTED |
| Owner-approved full update baseline  | `0.1.40 / code 53 / release commit 0564a80`                   | APPROVED |
| Observed bounded Play baseline       | `0.1.44 / code 61`                                            | OBSERVED |

The device-matrix versions are current official expectations as of 2026-08-23: Google's
[August 2026 Pixel update](https://support.google.com/pixelphone/thread/456979478/google-pixel-update-august-2026?hl=en-gb)
places the Pixel 10 Pro XL on Android 17, while Samsung's current
[U.S. Galaxy S25 Ultra update history](https://doc.samsungmobile.com/SM-S938U/035951251027/spa-us.html)
lists Android 16 through its latest published entry. Carrier and rollout timing vary. Record each
device's observed Android version and build during execution before awarding candidate evidence.

The earlier 2026-08-23 deferral is superseded only for the historical bounded v62 Play-update,
URL-rejection, and ordinary-kill checks and the bounded v63 automatic-preview matrix. All general
staged-server-dependent and broader device evidence remains open.

The owner approved the update baseline on 2026-08-23. It is the most recent locally documented Play
release with a defensible source label: commit `0564a80b572f16faf63c4d7b13c798a72451c845`
records version `0.1.40` / code `53` as submitted to Internal Testing and verified through the
Android Publisher API. Code `54` is documented only as a hosted EAS artifact, without a source label
or Play-delivery proof. Execution evidence for that approved branch remains open until a selected
device or live Play record confirms that the Play-delivered code-53 build is actually available or
installed. The separate natural code-61-to-62 update proves Play delivery and update mechanics on
one device, but it does not replace the owner-approved code-53 full-update branch.

Private custody may be Play Console, an approved password manager, or another owner-approved secure
channel. It must not be a repository file, commit, issue, build log, screenshot, or tester handout.

## 4. Non-production server gate

The production AAB supports QR pairing and manual server URL/password entry, but the repository does
not define a staged endpoint or credential. Its DEV fixture is compile-time gated and is unavailable
in this production bundle. The sibling server's tracked public documentation starts a development
server that reads the real macOS Messages database and performs message actions through AppleScript;
it provides no isolated synthetic-data staging profile.

Recommendation: do not point this test round at an existing production Messages environment. The
server owner must first approve and exercise a genuinely isolated Mac/message setup—ideally a
separate Mac or macOS login and dedicated Apple test identity—with synthetic conversations only. If
that isolation cannot be provided, stop the test instead of treating a production account as staging.

Record these non-secret facts after provisioning:

| Server fact                                                    | Value                                                          | Status  |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| Environment label                                              | `[OWNER INPUT — no hostname or URL]`                           | OPEN    |
| Server repository commit/version                               | `[OWNER INPUT — must contain e55f1210 or reviewed descendant]` | OPEN    |
| macOS/server compatibility owner                               | `[OWNER INPUT]`                                                | OPEN    |
| Stable HTTPS/tunnel method                                     | `[OWNER INPUT — method only]`                                  | OPEN    |
| Dedicated synthetic identity confirmed                         | `No — owner deferred isolation (2026-08-23)`                   | BLOCKED |
| No production chats, contacts, files, or credentials confirmed | `[YES/NO + reviewer]`                                          | OPEN    |
| Synthetic fixture manifest label/version                       | `[OWNER INPUT — no private content]`                           | OPEN    |
| FCM configured for the test environment                        | `[YES/NO + date; no key material]`                             | OPEN    |
| Credential rotation/expiry evidence location                   | `[PRIVATE REFERENCE LABEL]`                                    | OPEN    |
| Reset and teardown owner                                       | `[OWNER INPUT]`                                                | OPEN    |

Before invitations, one owner must dry-run both QR and manual pairing, verify the origin is stable,
and prove that disconnect/reset cannot affect a production server or identity.

The project owner deferred creating a separate macOS user on 2026-08-23. This defers every
staged-server-dependent checkpoint; it does not approve using the production Messages account or
its data as test evidence.

## 5. Tester notices

### Retired v56 notice — approved historical v1

This notice was approved for the retired version-code-56 candidate. Preserve it as history; do not
send it for a future round.

> Gator 0.1.40 (56) is an unfinished Android-only build for a small private test. It is not a public
> release or evidence of Google Play policy compliance. Use only the supplied synthetic test account
> and content; do not connect a personal or production server, contacts, messages, files, or Apple
> identity. The app requires a separately managed compatible Mac server. This candidate contains
> native libraries only for 64-bit ARM Android devices, uses a dark-only interface, does not accept
> content shared into it, and has no over-the-air update channel. Terms acceptance, in-app blocking,
> reporting, and moderation operations are not implemented, so this round is limited to trusted
> testers and must not be promoted. App Lock is a screen gate, not encryption-key custody; attachments,
> caches, logs, and shared-media copies may be plaintext as documented in the app. Push delivery uses
> Firebase Cloud Messaging and depends on server configuration. Install/update, background delivery,
> killed-process behavior, permissions, and device compatibility are outcomes of this test—not proven
> guarantees. Send feedback only through the private channel supplied with the invitation. Never
> include message text, credentials, server URLs, QR codes, private filenames, raw logs, or other
> private values. A response owner may request only separately reviewed, sanitized diagnostics that
> contain none of those prohibited values.

Notice owner: `Project owner`

Approved version/date: `v1 / 2026-08-23`

### Superseded v59 notice — draft v4 (do not send)

Draft v2 for frozen v57 and draft v3 for superseded v58 were never approved and are retired. The
v59 draft below was also never approved and is now retired. Preserve it as historical copy only; a
new notice naming v63 must still be drafted and approved before tester expansion:

> Gator 0.1.43 (59) is an unfinished Android-only build for a small private test. It is
> not a public release or evidence of Google Play policy compliance. Use only the supplied synthetic test account
> and content; do not connect a personal or production server, contacts, messages, files, or Apple
> identity. The app requires a separately managed compatible Mac server. This candidate contains
> native libraries only for 64-bit ARM Android devices, uses a dark-only interface, does not accept
> content shared into it, and has no over-the-air update channel. Terms acceptance, in-app blocking,
> reporting, and moderation operations are not implemented, so this round is limited to trusted
> testers and must not be promoted. App Lock is a screen gate, not encryption-key custody; attachments,
> caches, logs, and shared-media copies may be plaintext as documented in the app. Push delivery uses
> Firebase Cloud Messaging and depends on server configuration. Install/update, background delivery,
> killed-process behavior, permissions, and device compatibility are outcomes of this test—not proven
> guarantees. Send feedback only through the private channel supplied with the invitation. Never
> include message text, credentials, server URLs, QR codes, private filenames, raw logs, or other
> private values. A response owner may request only separately reviewed, sanitized diagnostics that
> contain none of those prohibited values.

Notice owner: `Project owner`

Historical approval: `NOT APPROVED — retired; v63 notice remains open`

## 6. Staged tester journey

Each result must identify the replacement version/code, exact source commit containing `9046e27`,
device model, Android version, test date, and tester evidence alias. Do not reuse the stale `0.1.28`,
v56, v57, v58, or v59 device records.

1. **Access preflight**
   - Confirm live Play Console shows only the intended Internal Testing release for this round.
   - Confirm the selected tester list, feedback channel, and opt-in page without saving unrelated
     changes.
   - Verify the staged server, versioned synthetic fixture manifest, credential expiry, responder,
     approved prior-build baseline, and halt owner.
2. **Enrollment and install**
   - Add only an owner-approved Google account through the private Play list.
   - On the clean-install branch, have a non-admin tester open the private opt-in link, opt in, and
     install from Google Play.
   - On the separate update branch, record the approved prior app version/code and authorized source,
     then update through Play to the exact replacement version code recorded in section 1.
   - Record the installed package/version and Play-provided artifact evidence. Record Play App
     Signing's delivery-certificate fingerprint separately from the upload-certificate fingerprint.
3. **Connection and initial sync**
   - Exercise QR pairing, then repeat with manual URL/password entry on the selected clean branch.
   - Confirm only synthetic conversations, identities, attachments, and contacts appear.
4. **Core messaging**
   - Send and receive staged text plus one small staged attachment.
   - Exercise sync, reply/reaction, retry, search, and the selected edit/unsend path only when the
     staged server reports support.
   - Complete the linked `PUSH-RETRY-01` physical-phone text/media correlation and restart/re-pair
     checks; record only bounded non-secret evidence.
5. **Lifecycle and notifications**
   - Exercise foreground, background, ordinary process kill, notification receipt/tap, app restart,
     and reconnect. Do not use Android force-stop as killed-process delivery evidence.
   - V63 satisfies the app candidate prerequisite. After an isolated compatible staged server and a
     fresh scoped V3 enrollment are available, complete the linked attempt-A/attempt-B killed-app
     `message-send-error` matrix with encrypted FCM and cross-transport exact deduplication. No
     result may be credited to v59.
6. **Privacy and containment**
   - Confirm locked notices remain generic, no inbound Android share target appears, and captured logs,
     screenshots, Recents, and notifications contain no private value.
7. **Disconnect, cleanup, and feedback**
   - Disconnect and verify local account data is cleared. Remove separately saved shared-media copies,
     clear remaining app data, and uninstall the test copy.
   - Send one harmless test report through the private feedback destination and confirm owner receipt.
   - Retire the server-side FCM device registration, remove staged synthetic data, and reset the test
     identity according to the approved fixture procedure.
   - Revoke or expire staged credentials and remove the tester when the round ends. After Play's
     propagation delay, verify the removed account cannot newly enroll or install; an existing copy
     can remain installed until the tester removes it.

### 6.1 `PUSH-RETRY-01` immutable RCS attempt identity

The superseded v59 app could not complete this matrix. The current source removes password-derived
V1 and plaintext receive, retains random-key V2 only before the exclusive
**2027-02-01T00:00:00Z** cutoff, and requires identity-bound, rotating V3 for scoped sessions. Run
the socket/phone rows only with an isolated staged server whose recorded commit is `e55f1210` or a
reviewed descendant. V63 closes the exact app candidate prerequisite below; its FCM rows still need
a fresh scoped V3 enrollment against that isolated staged server. Keep raw phone ids, message ids,
temp/attempt ids, payloads, tokens, and database paths out of the evidence; record only commit/build
identities, counts, equality or difference results, timestamps, and PASS/FAIL.

- [x] **APP CANDIDATE PREREQUISITE FOR FCM ROWS:** v63 was built, submitted, installed through Play,
      and contains the random-key V2/V3 lifecycle, scoped identity binding, crash-safe 30-day key
      rotation with bounded old/new overlap, exact server acknowledgements, downgrade/cutoff
      enforcement, and the reviewed cross-language/host results.
- [ ] **STAGED FCM PREREQUISITE:** pair v63 with an isolated compatible `e55f1210`-or-newer server
      over approved HTTPS and record a fresh scoped V3 enrollment. Until this passes, stop before the
      killed-app FCM steps; retained-key evidence from the locally signed release APK is not a fresh
      v63 enrollment result.

- [ ] Pair one physical Android phone for RCS. Record only that the sidecar's destination-
      registration phone namespace is non-empty and compares equal before and after a sidecar/BBD
      restart; do not record the identifier itself. If an upgraded Gaia session performs the
      documented one-time watermark reset/resweep, record that it completed without duplicate
      visible messages.
- [ ] Send one staged RCS text and one small staged RCS attachment. Also exercise an approved staged
      request at the documented maximum `tmpID` length. For each, prove Google/libgm returned the
      opaque correlation and owner-only `rcs.db` retained a non-empty correlation/phone pair for the
      resulting real message. Record only before/after matching-row counts and PASS/FAIL.
- [ ] After the staged FCM prerequisite passes, begin a staged RCS attachment send while the app is alive.
      Use a deterministic staged loopback fault seam: let readiness, admission, and media
      preparation pass; hold the sidecar fetch pending until the immediate ack returns; then
      background the app and run `adb shell am kill <package>`. Release the held fetch as classified
      `ECONNREFUSED`, proving the sidecar never accepted attempt A. A text/new-chat failure,
      bridge-down preflight, or lifecycle stop that wins before the ack does not exercise this
      event. Confirm A is emitted with `retryable: true`, FCM starts the killed process, the keyed
      payload decrypts as `AEAD_GCM_V3_IDENTITY`, socket/FCM copies converge to one durable occurrence,
      the exact bubble reaches error once, and the automatic ladder re-enqueues the attachment. Do
      not use force-stop.
- [ ] Restore the bridge and let that automatic ladder send attempt B under the same logical
      tempGuid. Prove its attempt id differs from A. Replay an **already-processed** copy of A through
      the other authorized transport and verify it neither evicts B's server reservation nor
      changes B's app state. A first-ever A event delayed until after B is not yet fenced by
      app-side attempt ownership; do not claim that stronger result.
- [ ] Separately surface one correlated delivery-phase failure and confirm it marks only its exact
      bubble after restart/status-only delivery. Record the current client limitation: because the
      immediate ack already consumed its queue, Try Again reports that the message cannot be resent.
      Do not claim a user-driven attempt B until a durable post-ack retry design is implemented.
- [ ] Restart BBD between the correlated message frame and a status-only failure, then verify the
      failure still resolves to the same attempt. Re-pair the staged phone and verify an old
      phone/message correlation is not accepted in the new phone namespace.
- [ ] Record the honest residuals with the result: a crash after Google accepts the send but before
      BBD durably receives the first correlated frame is not covered, and a correlation older than
      90 days or outside the newest 50,000 cached messages falls back to non-exact socket/webhook
      delivery. These boundaries do not turn a failed run into a pass.

Record the bounded result in the `RCS immutable-attempt matrix` row in section 7.

Detailed native checks still belong to `DEVICE-01` and a refreshed
[`DEVICE_VERIFICATION_CHECKLIST.md`](./DEVICE_VERIFICATION_CHECKLIST.md). This runbook does not turn a
host test into device evidence.

## 7. Evidence ledger

| Checkpoint                         | Owner/evidence alias | Date       | Result                                                               | Private evidence reference |
| ---------------------------------- | -------------------- | ---------- | -------------------------------------------------------------------- | -------------------------- |
| Superseded v59 source freeze       | Codex                | 2026-09-04 | HISTORICAL PASS — no replacement credit                              | Promotion receipt source   |
| Superseded v59 build/validation    | Codex                | 2026-09-04 | HISTORICAL PASS — no replacement credit                              | Release run receipt        |
| Superseded v59 promotion           | Codex                | 2026-09-04 | HISTORICAL PASS — no replacement credit                              | Promotion receipt          |
| Replacement source/artifact        | Codex                | 2026-09-13 | PASS — v63 identity and retained receipt match                       | Release receipt            |
| Hosted build                       | Codex                | 2026-09-13 | NOT RUN — v63 used the approved local build path                     |                            |
| Play upload/submission             | Codex                | 2026-09-13 | PASS — v63 submitted only to Internal Testing                        | Submission receipt         |
| Live track inventory               | Codex                | 2026-09-13 | PARTIAL — API read-back found completed v63; full Console state open | NET-01 device proof        |
| Play App Signing certificate       | Codex                | 2026-09-13 | PASS — v63 installed APK certificate recorded                        | NET-01 device proof        |
| Tester list/count                  |                      |            | OPEN                                                                 |                            |
| Replacement tester notice          | Project owner        |            | OPEN — not approved                                                  |                            |
| Feedback path round-trip           | Project owner        | 2026-08-23 | PASS — owner-confirmed                                               | Owner-held email record    |
| General staged-server dry-run      | Project owner        | 2026-08-23 | BLOCKED — stable general isolated setup unavailable                  |                            |
| General synthetic fixture manifest |                      |            | OPEN — the bounded NET-01-only fixture does not satisfy this row     |                            |
| Non-admin opt-in/install           |                      |            | OPEN                                                                 |                            |
| General clean-install journey      |                      |            | OPEN — the bounded NET-01-only install does not satisfy this row     |                            |
| Owner-approved update baseline     | Project owner        | 2026-08-23 | APPROVED — code 53 execution unverified                              |                            |
| Approved-baseline update journey   |                      |            | OPEN — code 53 to v63 not run                                        |                            |
| Historical v62 Play update         | Codex                | 2026-09-10 | HISTORICAL PASS — natural code 61 to 62; no v63 credit               | Historical v62 proof       |
| Historical v62 lifecycle           | Codex                | 2026-09-10 | HISTORICAL PARTIAL — ordinary-kill cold relaunch only                | Historical v62 proof       |
| Bounded v63 `NET-01` matrix        | Codex                | 2026-09-13 | PASS — exact Play install and automatic-preview matrix               | NET-01 device proof        |
| RCS immutable-attempt matrix       | Codex                | 2026-09-13 | IN PROGRESS — v63 app gate passed; staged V3 enrollment/matrix open  |                            |
| Disconnect/cleanup                 |                      |            | OPEN                                                                 |                            |
| Credential/tester revocation       |                      |            | OPEN                                                                 |                            |

## 8. Stop conditions and approval boundary

Stop the round immediately if any of these occurs:

- a tester sees production data or receives production credentials;
- an unintended account can enroll or install;
- Closed, Open, or Production contains an unexpected active/manual release;
- the installed version, source, or upload digest differs from the exact replacement recorded in
  section 1;
- the staged server origin changes unexpectedly or requires insecure/unapproved access;
- credentials, QR data, server URLs, message content, private file paths, or raw logs enter public
  feedback, Git, screenshots, or build output;
- a crash, data-loss, privacy, signing, or Play validation issue makes continued testing unsafe.

`STORE-01G` may be marked done only after every owner-input field has a safe non-secret value, the
notice is approved, the staged server and feedback channel pass a dry run, the live Play track/list/
feedback/link state passes a read-only preflight, and the access plan has an independent review.
`STORE-01` must remain open until the separately approved submission, Play acceptance, opt-in/install,
exact-candidate device journeys, prompted declarations, cleanup, and tester-access evidence pass.

The owner-authorized v63 Internal submission completed on 2026-09-13. Any resubmission, tester-list
mutation, staged-server action, or wider-track promotion is a separate external-state milestone and
needs its own authority. The superseded `gator-release-0.1.43-v59-e108ad7.aab` and every earlier
artifact remain prohibited; any future submission must use an explicitly selected, receipt-bound
artifact rather than an ambiguous latest build.
