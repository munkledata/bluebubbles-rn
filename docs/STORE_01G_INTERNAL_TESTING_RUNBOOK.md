# STORE-01G — Internal Testing readiness runbook

> **Status (2026-08-30): DRAFT / CURRENT LOCAL CANDIDATE / OWNER INPUT REQUIRED.** This runbook
> prepares a future private Google Play Internal Testing round. It records the completed local build,
> validation, and promotion below, but does not prove upload, submission, tester invitation, server
> deployment, Play acceptance, install, or device behavior.

This is the secret-free operational companion to `STORE-01`. Keep individual tester identities,
private endpoints, credentials, QR payloads, and the Play opt-in link outside Git. Record only the
non-secret labels, owners, counts, dates, and evidence references needed to reproduce the round.

## 1. Candidate boundary — frozen and promoted locally

The current conforming local candidate is frozen. Its identity does not authorize tester or Play work:

| Field                      | Current candidate value                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                                   |
| App version                | `0.1.42`                                                                                                    |
| Android version code       | `58`                                                                                                        |
| Candidate source commit    | `fd02247578e928d909f0ce73c083c3cbcedffb4c`                                                                  |
| Release commit/branch      | `7942ed5bfbdce28ecadfefc54e7bd7cdde2e57d8` / local `release/android-0.1.42`                                 |
| Release run                | `android-0.1.42-fd02247-20260830231420`                                                                     |
| Local AAB                  | `gator-release-0.1.42-v58-7942ed5.aab` — ignored, never commit it                                           |
| Size                       | `55,969,473` bytes                                                                                          |
| SHA-256                    | `ad7538bc3436eea017690801efdaa307a22a0565229c94006f7aacc278270298`                                          |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`           |
| Packaged boundary          | arm64-v8a only; package/version/signature/entry/permission/share/DEX guards passed; no device or Play proof |
| Build boundary             | Owner-approved EAS-backed local production build, validation, and local promotion passed; no hosted build   |
| Distribution boundary      | Private Google Play Internal Testing only; no upload or submission authorized                               |

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

The approved source freeze/push and one EAS-backed local `0.1.42` build completed through validation
and local promotion. The build retrieved the managed upload credential and advanced the remote Android
counter from 57 to 58. Any future submission must name the exact file above and verify its digest
immediately beforehand; never select an ambiguous “latest” build.

### Current execution mode

The approved post-v57 `PLAY-02` removal, source freeze/push, local EAS credential retrieval and remote
version increment, candidate build, validation, and local promotion are complete. Follow the
authoritative `STORE-01` execution mode in `WORK_PLAN_2026-08-03.md`. No Play upload or submission,
server action, device action, or remote release-branch publication is approved. Use this runbook as
the current handoff; future sessions should read only the Work Plan register and `STORE-01` section,
`RELEASE_CHECKLIST.md` section 0, and this file unless a specific contradiction requires history.

## 2. Current proven state

- `eas.json` has one Android submission target: Google Play track `internal`.
- The conforming current local candidate is `0.1.42` / version code `58`, identified in section 1.
  It is eligible for later separately approved Play and device work but supplies static artifact
  evidence only today.
- The release build phase is local-only and cannot submit. A separate submit phase previews by default and requires
  `--execute` plus an interactive candidate-specific phrase; no upload or submission was run for v58. The existing
  GitHub Actions native lane compiles disposable fixture/debug-signed APK/AAB verification artifacts. Manual run
  [`33476443641`](https://github.com/munkledata/bluebubbles-rn/actions/runs/33476443641) also completed the four
  disposable database lanes on an API-36 x86_64 emulator; the workflow's first configured schedule occurrence was
  unobserved, so genuine schedule proof remains open. These supporting artifacts are not release candidates and do not
  use EAS Build or submit to Play.
- The approved local production build incremented the EAS remote Android counter from `57` to `58`,
  fetched the existing managed keystore, completed all 1,264 Gradle tasks, and stopped after local
  validation and promotion. It did not create a hosted build or submission.
- The most recent pre-build read-only EAS history contained 22 hosted Android builds; the newest
  hosted artifact was version code `54`, with hosted counts for `55` and `56` both zero.
- Read-only EAS history contains 45 Android submission records: 42 finished and 3 canceled. Every
  record requested `internal` with release status `COMPLETED`; the newest is dated 2026-07-30.
- EAS records requested submission configuration, not current Google Play state. Pinned EAS CLI
  `21.5.0` states that Google Play app status is not available through EAS and exposes no tester list,
  opt-in link, or live track inventory.
- In the 2026-08-25 browser preflight, the only available signed-in Google account opened Play
  Console's developer-account creation page rather than an existing developer account. No app, track,
  tester, link, signing, prompt, or release state was accessible. Version code `58` is not proven
  uploaded or accepted.

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
| Prior-build update baseline          | `0.1.40 / code 53 / release commit 0564a80`                   | APPROVED |

The device-matrix versions are current official expectations as of 2026-08-23: Google's
[August 2026 Pixel update](https://support.google.com/pixelphone/thread/456979478/google-pixel-update-august-2026?hl=en-gb)
places the Pixel 10 Pro XL on Android 17, while Samsung's current
[U.S. Galaxy S25 Ultra update history](https://doc.samsungmobile.com/SM-S938U/035951251027/spa-us.html)
lists Android 16 through its latest published entry. Carrier and rollout timing vary. Record each
device's observed Android version and build during execution before awarding candidate evidence.

The project owner deferred physical-phone inspection on 2026-08-23. All Play-install and
device-dependent evidence remains open; no replacement-candidate device result is claimed.

The owner approved the update baseline on 2026-08-23. It is the most recent locally documented Play
release with a defensible source label: commit `0564a80b572f16faf63c4d7b13c798a72451c845`
records version `0.1.40` / code `53` as submitted to Internal Testing and verified through the
Android Publisher API. Code `54` is documented only as a hosted EAS artifact, without a source label
or Play-delivery proof. Execution evidence remains open until a selected device or live Play
evidence confirms that the Play-delivered code-53 build is actually available or installed.

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

| Server fact                                                    | Value                                        | Status  |
| -------------------------------------------------------------- | -------------------------------------------- | ------- |
| Environment label                                              | `[OWNER INPUT — no hostname or URL]`         | OPEN    |
| Server repository commit/version                               | `[OWNER INPUT]`                              | OPEN    |
| macOS/server compatibility owner                               | `[OWNER INPUT]`                              | OPEN    |
| Stable HTTPS/tunnel method                                     | `[OWNER INPUT — method only]`                | OPEN    |
| Dedicated synthetic identity confirmed                         | `No — owner deferred isolation (2026-08-23)` | BLOCKED |
| No production chats, contacts, files, or credentials confirmed | `[YES/NO + reviewer]`                        | OPEN    |
| Synthetic fixture manifest label/version                       | `[OWNER INPUT — no private content]`         | OPEN    |
| FCM configured for the test environment                        | `[YES/NO + date; no key material]`           | OPEN    |
| Credential rotation/expiry evidence location                   | `[PRIVATE REFERENCE LABEL]`                  | OPEN    |
| Reset and teardown owner                                       | `[OWNER INPUT]`                              | OPEN    |

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

### Current-candidate notice — draft v3

Draft v2 for frozen v57 was never approved and is retired. The current candidate identity is filled
below, but fresh owner approval is still required before sending this notice:

> Gator 0.1.42 (58) is an unfinished Android-only build for a small private test. It is
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

Approved version/date: `[OPEN — replacement notice not approved]`

## 6. Staged tester journey

Each result must identify the replacement version/code, exact source commit containing `9046e27`,
device model, Android version, test date, and tester evidence alias. Do not reuse the stale `0.1.28`,
v56, or v57 device records.

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
5. **Lifecycle and notifications**
   - Exercise foreground, background, ordinary process kill, notification receipt/tap, app restart,
     and reconnect. Do not use Android force-stop as killed-process delivery evidence.
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

Detailed native checks still belong to `DEVICE-01` and a refreshed
[`DEVICE_VERIFICATION_CHECKLIST.md`](./DEVICE_VERIFICATION_CHECKLIST.md). This runbook does not turn a
host test into device evidence.

## 7. Evidence ledger

| Checkpoint                     | Owner/evidence alias | Date       | Result                               | Private evidence reference |
| ------------------------------ | -------------------- | ---------- | ------------------------------------ | -------------------------- |
| Candidate source freeze        | Codex                | 2026-08-30 | PASS — pushed source `fd02247`       | Verified origin branch ref |
| Local build and validation     | Codex                | 2026-08-30 | PASS — exact v58 AAB                 | Release run receipt        |
| Local promotion                | Codex                | 2026-08-30 | PASS — local `7942ed5`               | Promotion receipt          |
| Hosted build                   | Codex                | 2026-08-30 | NOT RUN                              |                            |
| Play upload/submission         | Codex                | 2026-08-30 | NOT RUN — not authorized             |                            |
| Live track inventory           | Project owner        | 2026-08-25 | BLOCKED — account opens Play signup  |                            |
| Play App Signing certificate   |                      |            | OPEN                                 |                            |
| Tester list/count              |                      |            | OPEN                                 |                            |
| Replacement tester notice      | Project owner        |            | OPEN — not approved                  |                            |
| Feedback path round-trip       | Project owner        | 2026-08-23 | PASS — owner-confirmed               | Owner-held email record    |
| Staged server dry-run          | Project owner        | 2026-08-23 | BLOCKED — isolated setup unavailable |                            |
| Synthetic fixture manifest     |                      |            | OPEN                                 |                            |
| Non-admin opt-in/install       |                      |            | OPEN                                 |                            |
| Clean install journey          |                      |            | OPEN                                 |                            |
| Prior-build baseline           | Project owner        | 2026-08-23 | APPROVED — execution unverified      |                            |
| Prior-build update journey     |                      |            | OPEN                                 |                            |
| Notification/lifecycle journey |                      |            | OPEN                                 |                            |
| Disconnect/cleanup             |                      |            | OPEN                                 |                            |
| Credential/tester revocation   |                      |            | OPEN                                 |                            |

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

Uploading or submitting the AAB is a separate external-state milestone requiring explicit owner
approval, and no such approval is currently recorded. It must use
`gator-release-0.1.42-v58-7942ed5.aab` only after rechecking its exact SHA-256 from section 1. Frozen
v57 is prohibited; submission must not trigger a hosted EAS build or another promotion.
