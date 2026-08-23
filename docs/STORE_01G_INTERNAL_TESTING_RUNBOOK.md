# STORE-01G — Internal Testing readiness runbook

> **Status (2026-08-23): DRAFT / OWNER INPUT REQUIRED.** This runbook prepares the private Google
> Play Internal Testing round. It does not authorize or prove an upload, submission, tester invitation,
> server deployment, Play acceptance, install, or device result.

This is the secret-free operational companion to `STORE-01`. Keep individual tester identities,
private endpoints, credentials, QR payloads, and the Play opt-in link outside Git. Record only the
non-secret labels, owners, counts, dates, and evidence references needed to reproduce the round.

## 1. Exact candidate boundary

| Field                               | Frozen value                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                         | Gator / `com.bluegreengatorapps.messages`                                                         |
| App version                         | `0.1.40`                                                                                          |
| Android version code                | `56`                                                                                              |
| Candidate source commit             | `5d367eb58e38126258423f1cd9ce0da42b179f7f`                                                        |
| Evidence commit before this runbook | `f646afbe3ca27c50a46392e7191b9584dba75615`                                                        |
| Local AAB                           | `gator-release-0.1.40-v56-5d367eb.aab` — ignored, never commit it                                 |
| Size                                | `55,729,707` bytes                                                                                |
| SHA-256                             | `926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`                                |
| Upload certificate SHA-256          | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Build boundary                      | Candidate built locally; release scripts enforce local-only EAS builds                            |
| Distribution boundary               | Private Google Play Internal Testing only; no promotion                                           |

Do not rebuild this candidate. Production auto-increment would consume version code `57` and create
a different artifact that needs a new identity and verification record. Any future submission must
name this exact local file and verify its digest immediately beforehand; never select an ambiguous
“latest” build.

## 2. Current proven state

- `eas.json` has one Android submission target: Google Play track `internal`.
- Release scripts build candidate artifacts locally and contain no submission step. The existing
  GitHub Actions native lane can compile disposable fixture/debug-signed APK/AAB verification
  artifacts; those are not release candidates and do not use EAS Build or submit to Play.
- The EAS remote Android counter is `56`.
- Read-only EAS history contains 22 hosted Android builds; the newest hosted artifact is version code
  `54`. Hosted build counts for `55` and `56` are both zero.
- Read-only EAS history contains 45 Android submission records: 42 finished and 3 canceled. Every
  record requested `internal` with release status `COMPLETED`; the newest is dated 2026-07-30.
- EAS records requested submission configuration, not current Google Play state. Pinned EAS CLI
  `21.5.0` states that Google Play app status is not available through EAS and exposes no tester list,
  opt-in link, or live track inventory.
- No authenticated live Play Console evidence is available for this candidate. Version code `56` is
  not proven uploaded or accepted.

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

| Decision                             | Safe value to record in Git                                        | Status |
| ------------------------------------ | ------------------------------------------------------------------ | ------ |
| Play tester list label               | `[OWNER INPUT — recommended: gator-internal-testers]`              | OPEN   |
| Intended tester count                | `[OWNER INPUT — count only, maximum 100]`                          | OPEN   |
| Membership administrator role        | `[OWNER INPUT — role, not tester addresses]`                       | OPEN   |
| Opt-in-link custodian role           | `[OWNER INPUT — do not paste the link]`                            | OPEN   |
| Private feedback channel label       | `[OWNER INPUT — do not record private address/token]`              | OPEN   |
| Primary response owner role          | `[OWNER INPUT]`                                                    | OPEN   |
| Backup response owner role           | `[OWNER INPUT]`                                                    | OPEN   |
| Response target                      | `[OWNER INPUT — recommended: acknowledge within one business day]` | OPEN   |
| Person/role allowed to halt the test | `[OWNER INPUT]`                                                    | OPEN   |
| Staged-server maintenance owner role | `[OWNER INPUT]`                                                    | OPEN   |
| Test window and credential expiry    | `[OWNER INPUT]`                                                    | OPEN   |
| Approved device/Android matrix       | `[OWNER INPUT]`                                                    | OPEN   |
| Prior-build update baseline          | `[OWNER INPUT — app version, version code, source label]`          | OPEN   |

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

| Server fact                                                    | Value                                | Status |
| -------------------------------------------------------------- | ------------------------------------ | ------ |
| Environment label                                              | `[OWNER INPUT — no hostname or URL]` | OPEN   |
| Server repository commit/version                               | `[OWNER INPUT]`                      | OPEN   |
| macOS/server compatibility owner                               | `[OWNER INPUT]`                      | OPEN   |
| Stable HTTPS/tunnel method                                     | `[OWNER INPUT — method only]`        | OPEN   |
| Dedicated synthetic identity confirmed                         | `[YES/NO + date]`                    | OPEN   |
| No production chats, contacts, files, or credentials confirmed | `[YES/NO + reviewer]`                | OPEN   |
| Synthetic fixture manifest label/version                       | `[OWNER INPUT — no private content]` | OPEN   |
| FCM configured for the test environment                        | `[YES/NO + date; no key material]`   | OPEN   |
| Credential rotation/expiry evidence location                   | `[PRIVATE REFERENCE LABEL]`          | OPEN   |
| Reset and teardown owner                                       | `[OWNER INPUT]`                      | OPEN   |

Before invitations, one owner must dry-run both QR and manual pairing, verify the origin is stable,
and prove that disconnect/reset cannot affect a production server or identity.

## 5. Tester notice — draft v1

The owner must approve this versioned notice before it is sent:

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

Notice owner: `[OWNER INPUT]`

Approved version/date: `[OWNER INPUT]`

## 6. Staged tester journey

Each result must identify version `0.1.40` / code `56`, candidate source `5d367eb`, device model,
Android version, test date, and tester evidence alias. Do not reuse the stale `0.1.28` device record.

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
     then update through Play to code `56`.
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

| Checkpoint                     | Owner/evidence alias | Date | Result | Private evidence reference |
| ------------------------------ | -------------------- | ---- | ------ | -------------------------- |
| Live track inventory           |                      |      | OPEN   |                            |
| Play App Signing certificate   |                      |      | OPEN   |                            |
| Tester list/count              |                      |      | OPEN   |                            |
| Feedback path round-trip       |                      |      | OPEN   |                            |
| Staged server dry-run          |                      |      | OPEN   |                            |
| Synthetic fixture manifest     |                      |      | OPEN   |                            |
| Non-admin opt-in/install       |                      |      | OPEN   |                            |
| Clean install journey          |                      |      | OPEN   |                            |
| Prior-build baseline           |                      |      | OPEN   |                            |
| Prior-build update journey     |                      |      | OPEN   |                            |
| Notification/lifecycle journey |                      |      | OPEN   |                            |
| Disconnect/cleanup             |                      |      | OPEN   |                            |
| Credential/tester revocation   |                      |      | OPEN   |                            |

## 8. Stop conditions and approval boundary

Stop the round immediately if any of these occurs:

- a tester sees production data or receives production credentials;
- an unintended account can enroll or install;
- Closed, Open, or Production contains an unexpected active/manual release;
- the installed version is not code `56`, or the upload digest does not match this runbook;
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
approval. It must use the existing local candidate by exact path and hash and must not trigger a
hosted EAS build or any promotion.
