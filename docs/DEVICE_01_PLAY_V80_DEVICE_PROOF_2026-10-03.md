# DEVICE-01 — Google Play v80 bounded testing round, October 3, 2026

> **COMPLETED BOUNDED TESTING ROUND — broader device and release acceptance remains open.** This
> report records the exact installed Google Play `0.1.59` / version-code-`80` session through the
> final ledger cutoff **2026-10-03 20:48:40 UTC**. It includes synthetic episodes, authorized live
> messaging, font-scale, microphone, sync recovery, final cleanup, and the separate host proof for
> subsequent source fixes. The separately dated continuation below records later testing and the
> combined source milestone. No overall device, privacy, native-readiness, or release sign-off is
> claimed. The
> [work plan](./WORK_PLAN_2026-08-03.md) and
> [release plan](./RELEASE_PLAN.md) remain authoritative; this report does not change task statuses.

The phone reproduced an automatic sync-repair failure (`SYNC-04`) and loss of surviving
notification history during a cold-process withdrawal (`NOTIF-03`, ledger `NOTIFICATION-09`).
Both have reviewed source fixes with host tests, but **neither fix is installed in Play v80**.
An exact Settings-label search also failed on the phone (`SEARCH-02`); its later source repair is
host-verified, with replacement-device proof pending. The installed `NOTIF-02` App Lock limitation
also remains visible: new locked deliveries are generic,
while older detailed notifications remain readable in Android's shade.
The live episode also found a PDF filename-preservation issue and an initial history-sync failure
whose cause remains unknown. An automatic retry subsequently reached the app's up-to-date state;
that recovery does not erase the failed initial attempt or prove exact server/client history parity.

Private receipt and capture names below resolve under
`BB/gator-play-v80-device-20261003/`, relative to the checkout's parent directory, unless another
directory is given. These references identify retained private evidence; its raw contents are not
copied into this report.

## Exact candidate and evidence boundary

| Boundary                                    | Recorded value                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Package                                     | `com.bluegreengatorapps.messages`                                                                                                          |
| Installed version                           | `0.1.59`, Android version code `80`, nondebuggable                                                                                         |
| Installation source                         | `com.android.vending` — Google Play                                                                                                        |
| Device                                      | Samsung `SM-S938U1`, Android 16 / API 36; device serial omitted                                                                            |
| Source checkpoint                           | `bf1a9116463aed2bc5e420a3b5d8b6e7c963ead2`                                                                                                 |
| Release commit                              | `acf08e7ee2ad68aceb2fbc104f409124627034a7`                                                                                                 |
| Distribution                                | Internal Testing; Publisher read-back recorded release status `completed`                                                                  |
| AAB                                         | `gator-release-0.1.59-v80-acf08e7.aab`, 58,153,376 bytes                                                                                   |
| AAB SHA-256                                 | `4430c8edb5fc29484b75a73ed8afd3755ed0a9bc80e3a04e673f5e794eb755cd`                                                                         |
| Packaged boundary                           | `arm64-v8a` only; 33 native libraries; recorded minimum and target SDK 36                                                                  |
| Upload certificate SHA-256                  | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`                                          |
| Installed Play delivery certificate SHA-256 | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                                                         |
| Test baseline                               | Existing Play-installed v80 followed by an owner-authorized disposable app-data clear                                                      |
| Display scope                               | Three-button navigation; baseline font scale `0.8`, one reversible `1.3` check, then restored to `0.8`; scoped OLED and Gator observations |

The private release receipt (`BB/gator-android-release-2026-10-03/RELEASE_REPORT.json`) records the
successful release build, artifact validation, independent review, and completed Internal upload.
Its original statement that device testing had not yet happened describes the pre-device release
checkpoint; this report adds the later phone evidence. The clean app-data baseline does **not**
prove migration from a previous installed version or preservation of pre-update account data.

The candidate identity cases are `IDENTITY-01..02`. Four installed APKs were pulled: the base,
arm64, English, and density splits. The bounded
signature verification receipt (`apk-signature-verification.json`)
records eight successful v2/v3 signature, content-digest, and certificate-binding checks and eight
rejected corruption controls. Its independent source review found no blocker for that exact
four-APK RSA/SHA-512 verification. This was a scoped Python/OpenSSL verifier, not Android
`apksigner`; it does not claim source-stamp, v1, v4, rotation, or general Android installation-policy
validation. Package/version/installer identity comes from the separate phone baseline.

## How this session was bounded

The owner authorized disposable app data and synthetic tests on the exact Play installation. The
completed episodes used separate loopback fixtures for socket/media, versioned message-state
sync, notifications, send failures, and media/documents. The notification fixtures made real
Firebase Cloud Messaging (FCM) submissions for fixed synthetic content to the enrolled owner
phone. The send-failure fixture disabled FCM and outbound sending and accepted only its three
fixed failure cases. Ordinary killed-process checks used `am kill` and confirmed process absence;
they did not use force-stop as a substitute for a background-delivery test. The later backup
persistence check explicitly used force-stop after ordinary kill did not end the process, and is
credited separately.

The owner then authorized a separate live episode in one existing iMessage conversation with the
approved recipient. It used synthetic test content and the owned USB loopback connection with an
explicit HTTP exception. This was not external-network/TLS pairing, unrestricted recipient testing,
or permission to mutate unrelated conversation history. Message and attachment readbacks were
limited to the approved conversation and recent owned test activity; a separate server-wide query
returned aggregate counts only.

The retained device ledger (`TEST_LEDGER.json`) identifies
individual receipts and private capture aliases. This report does not embed screenshots, raw
notification dumps, OS share-sheet content, phone identifiers, live-recipient details, credentials,
tokens, backup passphrases, or live message bodies. The live section distinguishes UI observations,
exact-message server corroboration, timeline-only associations, and recipient-device proof that
was not obtained.

Throughout this report, **pass-scoped** means the stated observation passed on this phone. It does
not close the surrounding subsystem. A server request, byte count, or FCM submission is not by
itself proof of phone persistence, rendering, or delivery.

The final ledger contains **81 observations**: **18 pass, 54 pass-scoped, four fail, two issue,
one not-tested, one inconclusive harness interruption, and one documented open privacy gap**.
These are individual observations, not 81 completed subsystem acceptance tests. The four failed
cases are `SYNC-04`, `NOTIFICATION-09`, `SEARCH-02`, and the initial live sync attempt `LIVE-08`.
Its later recovery is the separate pass-scoped `LIVE-11` result. The UI/copy and filename issues
and documented older-notification privacy gap retain their own classifications.

## Observed failures, open issues, and repair status

| Finding                                            | Exact installed-v80 result                                                                                                                 | Current disposition                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `SYNC-04`: expired message-state cursor            | Cold launch and manual Sync Now repeatedly show Error after retention pruning; no repair snapshot starts                                   | Source fix and full host milestone pass; new build and phone recovery proof required                       |
| `NOTIF-03` / `NOTIFICATION-09`: cold withdrawal    | With six retained native history entries, withdrawing only entry 4 removes the entire conversation notice                                  | Source fix, focused checks, and combined full host milestone pass; new-build phone replay pending          |
| `NOTIF-02` / `APPLOCK-02`: older detailed notices  | Previously displayed detailed content remains readable after enabling App Lock; a new generic notice coexists with it                      | Reviewed source privacy sweep and generic policy pass host tests; native replacement proof open            |
| `UI-02`: connection banner and offline explanation | Persistent banner covers chat/Settings titles; the offline explanation says live socket updates still work while the UI reports Offline    | Measured header inset and truthful copy repaired in source; keyboard/font/device replay pending            |
| `SEARCH-02`: exact Settings label                  | Verified input `Server Management` produced No settings match; the control query `Server` exposed both Server Management and Server Health | Word-based visible-label search repaired and host-tested; rebuilt-device replay pending                    |
| `LIVE-08` / `LIVE-11`: initial live history sync   | Initial sync showed trouble/Error; a later automatic retry reached Up to date with 75,503 messages                                         | Initial cause unresolved; finite privacy-safe diagnostics added for a repeat; history parity unproved      |
| `LIVE-09`: PDF filename preservation               | Uploaded PDF first showed its selected name, then a UUID PDF name; exact marked server attachment also lacked the selected filename        | Reviewed native streaming filename override and host guards added; Kotlin and rebuilt upload proof pending |

### SYNC-04 — expired cursor is not classified for automatic repair

The versioned-sync fixture uses the reviewed server implementation at
`d06e26db55f07c18d7333c80dcfe12f0f6595e9f`. Initial snapshot work completed, and the live/offline
delete and restore cases below passed. For the retention case, the app process was killed and
confirmed absent, then the fixture seeded 501 changes, pruned 500 journal rows, and armed a
deliberate invalidation of the next repair page. Cold launch showed Sync Error. Manual Sync Now
repeated the error.

The final sync receipt (`sync-phone-final-status.json`)
records `/sync/message-state` at nine requests, `/sync/repair-snapshot` still at the two initial
calls, zero repair invalidations, and the next-page invalidation still armed. This establishes that
the app did not reach the intended repair-page test. The unmatched-route count is not used to
diagnose the repair failure.

Independent source tracing confirmed that the fixture uses the production server operation and
HTTP adapter, which return HTTP 409 with error type `repair_required` for the expired cursor. In
the released client, `page()` and `activeMessage()` in `src/core/api/endpoints/messageState.ts`
checked for that type but did not request bounded error-detail parsing from `HttpClient`. The
default error path discarded the body, leaving a generic 409 error; the existing repair
orchestrator therefore never received `MessageStateRepairRequiredError`.

The repair adds `captureErrorDetail: true` to those two requests. It reuses the existing bounded
parser: at most 4 KiB, a maximum two-second read, cancellation, sanitized detail, and non-enumerable
error fields. It adds no alternate credential path, response logging, DB write, or migration.
Nineteen new regression cases feed real JSON/streamed responses through the actual `HttpClient`
with its transport mocked. They cover both endpoints, the exact declared 409 type, unrelated and
malformed/oversized 409 responses, 401/403, account retirement, revoked pinned credentials, and the
existing 404-to-null hydration behavior. The positive cases failed on the original source and pass
with the two request flags.

The two-file repair passed independent security review, six focused suites / 128 tests, typecheck,
lint, and the relevant guards. Its frozen milestone then passed **538 suites / 6,689 tests**, with
two opt-in benchmark suites/tests skipped, plus 52 architecture tests and five migration tests.
That full run predates the notification repair below. Evidence:
`sync-repair-milestone-8gVgnN/result.json`.

Required new-build proof remains: repeat the expired-cursor episode, observe a repair begin, let
the deliberately invalidated page fail safely, then verify the next bounded repair succeeds and
the local-deletion and provider controls remain intact. A manually forced full refresh would
exercise a different entry path and would not establish that automatic 409 recovery is fixed.

### NOTIF-03 — preserve surviving history after a headless wake

The native history parser recorded entries 1, 2, and 3 after the paired arrival. After ordinary
process death, arrivals 6 and 7 left exactly the latest six entries: 2, 3, 4, 5, 6, and 7. A late
unseen older message did not change the notification: the seven-entry episode's final capture and
the subsequent late-arrival capture were byte-identical, including Android creation, update,
ranking, and interruption fields. App Lock was OFF throughout this withdrawal episode, and no
chat was opened between the killed-process wake and withdrawal.

Withdrawing only entry 4 then removed the entire conversation notification instead of preserving
entries 2, 3, 5, 6, and 7. The full active-count receipts and operator capture establish zero
notifications after settlement. A stripped history input containing only an empty header is
explicitly **not** treated as independently complete zero-notification evidence. Relevant retained
receipts are `notif03-seven-history.json`, `notif03-late-history.json`,
`history-withdraw-middle.json`, and `history-withdraw-middle-settled.json` in the device evidence
directory; ledger `NOTIFICATION-09` binds them to this failure.

The release's withdrawal reconciler required a hydrated foreground App Lock store before replacing
a detailed child. A cold FCM wake deliberately does not hydrate that store; it independently reads
the persisted App Lock policy and can post detailed content after verifying OFF. Consequently,
withdrawal found valid surviving DB-backed history but cancelled the child because foreground
hydration remained false.

The repair in `src/services/notifications/notifeeService.ts` reuses the existing bounded persisted-OFF
guard for replacement of already-present, DB-reconciled history. It captures account ownership
before its first await, preserves the cold lock snapshot, revalidates the native child's presence
after DB work, and checks ownership/policy at replacement. If ownership or lock policy changes
while native display is in flight, it attempts cancellation of that exact child. It does not
hydrate the foreground lock store or add a new notification path. Unknown, ON, failed, or timed-out
policy reads do not authorize detailed replacement. Native cancellation remains best effort; an
App Lock transition alone does not schedule a global notification sweep.

Thirteen new stateful-tray regressions cover the five survivors, default/explicit OFF, unknown and
locked policies, failed and hung reads, late policy/account changes, swipes during DB reads, and
post-display compensation. The two positive cases failed on the released source. The candidate
passes **five focused suites / 232 tests**, typecheck, lint, and independent security review.
The required inventory adjustment changed only 18 existing source-line fields by +6; no write IDs
or classifications changed. The fast scanner passed **101 tests**, with 14 full-only tests skipped;
strict inventory checking reports **2,248 approved mutations**, and reconciliation has zero drift.
Evidence: `notif03-repair-focused-jPo2tL/result.json`.

The earlier sync-only full Jest pass does not cover this notification change. A subsequent frozen
combined milestone passed **538 suites / 6,702 tests**, with the same two opt-in benchmark
suites/tests skipped, in **179.666 seconds**. Architecture passed 52 tests plus both live guards;
migration verification passed five tests with 53 sequential migrations. There were no failures,
console warning/error sections, or React act warnings. Evidence:
`combined-repair-milestone-cjZ2Bd/result.json`.
The exact rebuilt-phone six-entry withdrawal replay remains pending. The narrower warm grouped
withdrawal pass below does not substitute for the failed cold-history case.

### NOTIF-02 — new generic delivery does not hide old detailed notices

In `APPLOCK-01`, after App Lock was enabled, the next warm delivery produced the fixed generic
child. After another confirmed ordinary process kill, a delivery updated that same generic child. Tapping it reached
the fingerprint unlock gate; cancelling authentication kept Gator locked and did not navigate to a
chat. These are positive observations for generic new delivery and cancelled authentication.

However, the detailed conversation notice containing the earlier resource entries remained
readable in the expanded Android shade, alongside the generic child and Samsung's summary. The
shipped Storage & Privacy explanation in `app/(app)/storage-privacy.tsx` already says App Lock does
not retroactively replace previously displayed detailed notifications. This phone session confirms
that open `NOTIF-02` boundary; it is not a full notification-privacy pass. The receipt named
`applock-enable-clears-details.json` did **not** show successful clearing, despite its filename.

Successful biometric unlock, grace-period timing, post-unlock drain, every push-envelope version,
replay rejection, and a complete locked delivery/action matrix were not established here. App Lock
is a presentation gate, not evidence of encryption-key custody.

### UI banner and search follow-up

The connection banner overlapped the chat title and Settings title during the observed degraded
connection state. The offline explanation also claimed that live socket updates still work while
the connection state was Offline. This report records those observations without claiming a
layout or wording fix in that installed candidate. The later source repair is recorded below.

Settings search at `app/(app)/settings.tsx:166–189` normalizes the full input, then calls
`terms.includes(q)` on a keyword bag for each section. Its server bag contains `server`,
`management`, and `health` separated by other words, so the full visible labels `Server Management`
and `Server Health` do not match. A fresh device test (`SEARCH-02`) verified the exact input
`Server Management` and captured the result `No settings match “Server Management”.` Replacing
that query with `Server` exposed both the Server Management and Server Health rows. Evidence
aliases are `screens/189-settings-exact-phrase.xml` and `screens/190-settings-server-word.xml`.
This confirms the exact Management-label failure with a working single-word control. The Health
phrase and other multiword inputs remain source predictions rather than device-tested cases.

The earlier capture containing the truncated query `ervermanagement` remains invalid device
proof. The later exact-input test supplies separate evidence; it does not rehabilitate that
attempt. The successful conversation-search test below is a different feature. The later source
repair does not establish a corrected-build phone pass.

### LIVE-08 / LIVE-11 — an initial failure followed by automatic sync recovery

The first live history-sync attempt surfaced `Sync had trouble`; Server Management later showed
`Sync: Error`, even while individual live message operations worked. The last captured progress
before that failure was approximately 335 chats and 4,665 messages; the failure was observed later.
Following the font-scale Activity
recreation, sync resumed automatically. The Sync Now controls in captures 319–320 were disabled,
so this report does not credit a successful manual retry or infer that the attempted tap caused
recovery.

Capture 326 later showed **Up to date (75503 msgs)** with Sync Now enabled. This is a completed
sync state reported by the app, following visible progress; it is stronger than a growing progress
counter alone. It does not establish one-to-one parity with the separate server aggregate, which
uses different selection rules, nor absence of every missing/duplicate row. The failed initial
attempt remains `LIVE-08`; the observed recovery is a separate `LIVE-11` result.

The private `live-initial-sync-diagnostic.json` records an independent review of the retained
2,681-line, process-scoped log. It did not contain a useful API status/error classification, schema
failure, DB write-fence rejection, or repair error identifying the cause. The released
`src/services/syncControl.ts:1018–1037` catch stores the error message in `syncStore.error`; the
setup and Server Management views show status/counts without that detail, and the catch does not
log it. Absence from this log does not mean no error occurred. No evidence establishes that this
live failure shares the reproduced expired-cursor cause in `SYNC-04`.

No fix is claimed for the unexplained initial failure. A future reproduction should retain a
bounded, redacted error classification and sync stage without logging credentials, message
contents, or raw responses. The completed retry does not justify guessing a network, server,
schema, or database cause.

### LIVE-09 — the PDF upload loses its original display filename

Immediately after the captioned PDF upload, capture 310 showed the selected synthetic filename
and 618 bytes. Later captures 316–317 showed a UUID `.pdf` name. The server readback binds the
exact marked caption message to a sent `application/pdf` attachment of 618 bytes whose transfer
name did not match the supplied name. No byte hash or recipient rendering was obtained, so this
is a filename-preservation finding, not evidence of payload corruption.

The initial v80 source review explains the mismatch. The picker retains the original display name while Expo
copies the selected document to a UUID-named cache file. The optimistic attachment stores that
original name, but `src/services/send/attachmentUpload.ts:257–272` deliberately omits the separate
name parameter for the narrow iMessage route. The installed legacy Expo uploader takes the actual
multipart file-part filename from `file.name`; it offers no independent filename option.

The server stages the file using that multipart filename and rejects a conflicting separate name
in its narrow iMessage guard, because the helper receives the staged path. When canonical metadata
arrives, `src/db/repositories/attachments.ts:134` accepts a non-null canonical transfer name, and
the file chip displays it. At that initial checkpoint, the reviewed upload/send/repository/display
files were identical in the main checkout and released v80 source. Those upload tests explicitly expected the UUID URI and
omitted original name, including for PDFs and captions; they do not establish filename fidelity.

This is an existing upload-path defect/limitation, separate from the two subsequent repairs.
Font scaling does not contain a rename operation in this path. The exact echo-versus-REST
reconciliation timing was not captured, so Activity recreation is an observation boundary, not a
proven cause. Simply restoring a name parameter would conflict with the server guard; refusing
canonical names in the DB would conceal the wrong transmitted filename on one client.

A correction must preserve the safe original basename in the actual multipart file part
while retaining legacy streaming, progress, cancellation, and account ownership. The later combined
source milestone below implements a narrowly validated native filename option. Its Kotlin tests,
replacement build, and actual device upload proof remain pending. The initial private
`pdf-filename-source-review.md` retains the precise Expo/server references and proposed regression
boundaries, including unsafe names, concurrent same-name uploads, retirement, and canonical echo.

## Completed phone observations and their limits

### Setup, continuity, permissions, and account transitions

| Ledger cases                | Observed result                                                                                                                                                                                                                           | Limit                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BOOT-01`, `SETUP-01..04`   | Authorized app-data clear reached Welcome; camera denial left manual pairing usable; unsupported URL scheme was rejected; HTTP required explicit insecure opt-in; wrong synthetic password failed and the correct one reached permissions | One clean synthetic setup. Activity launch timing is not a full app-interactive benchmark                             |
| `PERMISSION-01..02`         | Denied notifications and contacts did not block Messages; no contacts were imported; Android Settings later restored notifications and the app displayed Enabled                                                                          | No complete permission revocation/import matrix                                                                       |
| `LIFECYCLE-01`, `SEARCH-01` | After confirmed process death and fixture disconnection, cold launch retained messages, both images, and the draft; offline conversation search showed two results and closing it restored the composer                                   | One ordinary offline restart, not crash injection during writes or a search-performance bound                         |
| `UI-01`                     | The typed composer remained above the keyboard with three-button navigation; observed OLED and Gator previews were legible                                                                                                                | Font scale was 0.8; no large-font, gesture-navigation, or general accessibility claim                                 |
| `AUTH-01`                   | Two injected `AUTH_UNAVAILABLE` rejections were followed by automatic socket admission and removal of the warning banner                                                                                                                  | One transient-recovery sequence, not the full retry or throttle matrix                                                |
| `AUTH-02`                   | `AUTH_REQUIRED` prevented further admissions/verifications for about 54.05 seconds after the server was restored; manual Retry then connected                                                                                             | Observed terminal rejection/manual recovery only; no timed `AUTH_RATE_LIMITED` proof                                  |
| `REKEY-01`                  | Settings reported the DB key rotated; confirmed process death and cold launch preserved messages, images, and the draft                                                                                                                   | Normal rekey continuity, not wrong-key rejection or death during rekey                                                |
| `ACCOUNT-01`                | Cancelling Disconnect preserved state; confirmed Disconnect reached Welcome; a new synthetic account showed only its three chats                                                                                                          | Visible account separation only, not exhaustive key/file erasure or all late-result races                             |
| `ACCOUNT-02`                | With the SEND01 fixture kept alive, Disconnect reached Welcome with zero notices; fixture close reported no registration, no held request, and removed its private receipt                                                                | Scoped application retirement and fixture cleanup; it does not retroactively validate the interrupted earlier attempt |
| `SHARE-01`                  | Warm Android plain-text ACTION_SEND opened New Message; Back prompted for discard and the operator selected Discard                                                                                                                       | Completed discard/replay unproved; no send, cold/multiple-file intake, Direct Share, or grant-revocation credit       |

### Versioned sync and deletion

| Ledger case | Observed result                                                                                                                                             | Limit                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SYNC-01`   | Live delete → restore → delete using the same earlier deletion timestamp → restore was reflected on the phone; unrelated provider controls remained visible | Establishes those final visible transitions, not every internal row or cursor value               |
| `SYNC-02`   | After process death and disconnection, a delete/restore/delete burst converged on cold launch to the target absent and controls visible                     | Final-state convergence only; UI captures cannot prove absence of every intermediate resurrection |
| `SYNC-03`   | A locally deleted controlled target stayed hidden after server delete/restore; the separate local-deletion control remained                                 | One local-tombstone protection case, not every alias/owner conflict                               |
| `SYNC-04`   | Retention pruning repeatedly produced Error and did not begin repair                                                                                        | Confirmed failure; details and new-build acceptance above                                         |

RCS/SMS controls being preserved does not prove live RCS/SMS provider operation. The synthetic
fixture is deliberately additive for those controls and does not supply a complete messaging
backend. No claim is made that UI state proves the journal cursor, repair checkpoint, deletion
ledger, or individual DB transaction boundaries.

### Notifications, grouping, and controlled send failures

| Ledger cases          | Observed result                                                                                                                                                                                                 | Limit                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NOTIFICATION-01`     | A warm synthetic notice was visible; its body tap opened the intended chat; another chat produced a separate notice while the first was open                                                                    | Six fixture submissions are not six independently observed arrivals; inline actions are not credited |
| `NOTIFICATION-02..03` | A killed-process FCM wake started a new process; two chat children and the Gator summary settled; tapping B opened B; Back/launcher resume did not replay that consumed route                                   | One cold delivery/tap episode, not all native duplicate events or later genuine presses              |
| `NOTIFICATION-04`     | The first attempted grouped withdrawal was rejected by fixture preconditions                                                                                                                                    | **Not tested.** The following snapshot cannot be counted as withdrawal evidence                      |
| `NOTIFICATION-05`     | The first fixture stopped before retirement settled; restart showed cleanup, and notices later cleared                                                                                                          | **Inconclusive harness interruption**, not a successful retirement or established app defect         |
| `NOTIFICATION-06`     | A fresh valid episode changed two children plus Gator summary → B plus the same summary → zero after withdrawing A then B; A showed an unsent placeholder; clean Disconnect followed                            | One warm grouped-withdrawal episode. Keeping the summary while B survives is intentional             |
| `NOTIFICATION-07..08` | Paired native history, killed-process six-entry retention, and unchanged late-unseen arrival were observed                                                                                                      | Does not override the subsequent cold-history withdrawal failure                                     |
| `SEND-01`             | Three fixed failed requests completed without cancellations or FCM: no local failure notice in the active chat, one from the other chat, and two unique failure children plus Samsung summary in the background | Controlled HTTP failures only; no successful send, retry, echo clearance, or locked-failure result   |
| `SEND-02`             | Removing the third failed message removed its bubble and exact notice child; the other failed items/notice remained                                                                                             | Targeted local removal only; no remote deletion                                                      |

`NOTIFICATION-10` records four synthetic native history entries, each exactly 512
Unicode code points and 2,048 UTF-8 bytes, within the configured limits. The aggregate receipt
`notif03-resource4-history.json` records no large notification icon, but Android's displayed
`Person` strings do not establish individual avatar absence/type. The fixture reported zero avatar
requests, so avatar download, fallback, and resource bounds remain unproved. Native timestamps retain their
Android meanings and are not delivery acknowledgements.

The NOTIF03 fixture eventually completed 14 fixed steps and recorded 15 FCM submissions. In
`APPLOCK-03`, the authorized app-data reset left zero active Gator notices; fixture shutdown removed its private
receipt and its reverse mapping was removed. Its pre-close status still had registration present.
This reset is not the application's Disconnect path or proof of server credential revocation.
FCM submission totals never become a claim of 15 independently verified phone presentations.

### Attachments, media, cache, and documents

| Ledger cases           | Observed result                                                                                                                                                                                                                        | Limit                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA-01`, `CACHE-01` | Synthetic RCS PNGs with attachment-ID lengths 119 and 2,795 rendered. Diagnostics reported two rows, local paths, and native files; zero missing active files, temporary files, and active transfers; settled DB/file equality was Yes | Bounded actual native long-ID/image and settled-cache evidence, not every hostile path, quota, or interrupted transfer case               |
| `MEDIA-02`             | The test MP4 played inline and in the native fullscreen player; the fixture served 14,704,688 bytes. The operator later returned to a responsive inbox                                                                                 | The resume capture helper failed during animation. Uninterrupted background/resume playback and exact phone-file hashing remain unproven  |
| `MEDIA-03`             | The two-image viewer paged from 2 of 2 to 1 of 2; sharing opened Android's chooser, which was cancelled                                                                                                                                | Paging and chooser handoff only, not target delivery or remote-video Share continuation                                                   |
| `MEDIA-04`             | Save reported success; the operator's app-owned MediaStore query found the synthetic PNG row at 68 bytes, matching the fixture asset size                                                                                              | No byte hash, external gallery viewing, video Save, or deletion proof in this save episode; later identified-file cleanup is `ACCOUNT-05` |
| `DOCUMENT-01`          | A valid PDF downloaded and opened an external handler; accessibility exposed Page 1 and the fixed document text                                                                                                                        | Settled visual capture appeared blank. Visible PDF rendering is not credited and no cause is assigned to Gator or the viewer              |
| `DOCUMENT-02`          | The controlled first PDF request failed and exposed Retry; retry reached Open. The fixture recorded two requests, one failure, and 610 bytes served                                                                                    | Download recovery and ready state only, not independent rendering or killed-process retry                                                 |
| `DOCUMENT-03`          | A synthetic vCard downloaded and opened the handler chooser, then was cancelled                                                                                                                                                        | No contact import or parsed-contact details credited                                                                                      |
| `DOCUMENT-04`          | Encrypted PDF handoff reached an external password prompt and then a filename after the synthetic password                                                                                                                             | Blank capture without a Page indicator does not prove successful decryption/rendering; unrelated to Gator backup encryption               |
| `DOCUMENT-05`          | The malformed 61-byte PDF opened through the handler and the operator returned to Gator                                                                                                                                                | No explicit viewer rejection was captured; no particular malformed-file behavior claimed                                                  |
| `DOCUMENT-06`          | The 6,291,456-byte PDF reached Open; fixture recorded one request and zero failures                                                                                                                                                    | No independent phone-file length/hash or viewer-rendering proof                                                                           |
| `DOCUMENT-07`          | Paging reached the oldest document; after fixture disconnection it opened from cache with Page 1 and fixed text exposed to accessibility. The final asset counter stayed at one request / 612 bytes                                    | One final-page offline opening, not all documents, pixel-perfect rendering, or cache survival after a killed-process restart              |

Media/document counters are retained in `feat07-status-before-retry.json`,
`feat07-status-media-documents.json`, and `feat07-status-offline-document.json`. Operator-observed
playback is stronger than a still screenshot alone, but it does not make the failed resume capture
a pass. All external-viewer results remain scoped to the stated handoff/accessibility observation.

### DL01 — bounded download failure and recovery cases

The separate DL01 fixture exercised eight generations on exact Play v80, with one request per
generation and no FCM enrollment or sends. The app's Download Integrity screen supplied native
file/cache and ownership observations. Scrolled captures are operator-grouped report episodes,
not atomic filesystem snapshots. The parser selects the last report in XML order when retained
routes coexist; visible-route attribution remains the operator's responsibility, and off-screen
fields remain unknown.

| Ledger case                           | Observed result                                                                                                                                                                                                                                                                                                                               | Limit                                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DL01-01`: valid baseline             | One 68-byte image request; diagnostics showed one attachment row, one local path/native file totaling 68 B, settled DB/file exact=Yes, no missing/mismatched/untracked/temp file or active transfer, and all six captured live-ownership counters zero                                                                                        | App diagnostics plus fixture counters, not an independent phone-file hash or every gallery/wallpaper field                                                                                                          |
| `DL01-02`: malformed image            | The 23-byte response produced the image Retry/not-downloaded state. After explicit Refresh, two attachment rows existed but only the original one settled file/68 B remained; the captured transient and live-ownership counters were zero                                                                                                    | One rejection and cleanup case; no specific native error code. The earlier unrefreshed capture is excluded                                                                                                          |
| `DL01-03`: maximum plus one byte      | The fixture attempted 5,242,881 bytes against the configured 5 MiB limit. Retry appeared; three rows existed but only the original settled file/68 B remained. Captured transient/cache-error/live-owner counters were zero and DB/file exact=Yes                                                                                             | Chunked oversized case only; attempted server bytes are not independently measured phone bytes or proof of every length variant                                                                                     |
| `DL01-04`: delete during held request | The request stayed at 0% with one held connection. Confirmed local conversation deletion removed the row; the later receipt showed zero active/held connections with no body-byte increase, well before the 135-second cap. Diagnostic top showed zero active transfer, owned destination, temporary file and temporary bytes                 | Bottom ownership/cache fields were not captured. Connection closure is observed, but no native cancellation reason code was retained                                                                                |
| `DL01-05`: ordinary process death     | Before kill, diagnostics showed one active transfer, one owned destination and one temporary file containing 8 B. Ordinary `am kill` confirmed process absence. COLD relaunch cleared those transient fields, retained the original settled file/68 B, and kept DB/file exact=Yes. Generation-five request count remained one during recovery | No automatic retry was observed in that interval. Bottom live-owner fields were off-screen; the retained file was reported as prior generation, not every generation counter zero                                   |
| `DL01-06`: natural automatic timeout  | Without a kill/delete action, the delayed request closed naturally with only the initial 8 B attempted and one request. Final captures showed transient fields, cache errors, reservations/reserved maximum and retirement owners/pending retirements zero, retaining the original settled file/68 B                                          | Consistent with the automatic 120-second deadline; no exact request-start timestamp/native timeout code. Protected paths and protection owners were off-screen; no manual-download timeout claim                    |
| `DL01-07`: false smaller length       | The fixture attempted a 68-byte image while declaring Content-Length 34. Retry appeared; seven rows existed but only the original settled file/68 B remained, with DB/file exact=Yes. Captured transfer/temp/cache-error and protection counters were zero                                                                                    | Phone-received bytes/native validation reason were not captured. The first four live-ownership rows were off-screen; false-larger/missing lengths and other truncation points remain untested                       |
| `DL01-08`: fresh valid control        | A later fresh valid generation succeeded: eight rows, two settled local paths/native files totaling 136 B, no transient/cache-error fields, and DB/file exact=Yes. One current and one prior-generation file remained                                                                                                                         | Demonstrates later valid work can succeed, not retry of a failed row or recognizable pixel fidelity. Protected paths=1 and protection owners=1 were retained with the image route; no leak or all-owners-zero claim |

The held-delete receipt is 32.217 seconds after the active sample and at most 46.301 seconds after
mode setup. The earlier file named `dl01-status-held-cancelled.json` still showed a held connection
and is not cancellation proof; the later `dl01-status-held-deleted.json` supplies that evidence.
The fixture's `responsesFinished` counter means the socket's writable side finished. Node's
half-close behavior can increment it during client shutdown, so `finished +1 / closedEarly=0`
does **not** prove that a full HTTP body was delivered or a download succeeded.

For the natural timeout, polling observed an active connection at **20:21:43.731631 UTC** and none
at **20:21:48.762734 UTC**. The close preceded the configured 125-second delayed tail and
135-second fixture cap. This brackets the observed close; it is not a millisecond-precise deadline
measurement. Captures 232–236 and the receipt named `timeout-settled` were taken before settlement
and are excluded from final cleanup proof. Later timeout ownership rows do not fill the missing
process-death ownership observations.

The ledger maps each case to its diagnostic captures and aggregate fixture receipts, including
`dl01-max-integrity.json`, `dl01-death-before-integrity.json`, `dl01-death-process.json`,
`dl01-timeout-timeline.json`, and `dl01-status-final-valid.json`. These eight cases found no new
app defect within their scope. They do not close the complete DL01 matrix, all content types,
every concurrent/cache-quota path, or all owner-retirement outcomes.

`ACCOUNT-04` records Disconnect reaching Get Started while the DL01 fixture was still reachable.
Its final status showed zero active/held connections, eight requests, zero FCM sends, and enrollment
disabled. The operator reported wrapper exit zero and a later app-data clear returning Success.
The cleanup receipt (`dl01-cleanup.json`) records the owned
reverse mapping and private directory absent, with a separate host check finding no remaining
DL01 private directory. Wrapper exit and app-data clear are operator reports rather than separate
retained process/clear receipts in this row. No push registration existed to revoke, and this
does not establish deletion of every Android cache or gallery copy. The subsequent live-account
episode requires separate evidence.

### Backup and customization — one local roundtrip, scoped proof

The first backup check (`BACKUP-01`) kept export disabled for short matching passphrases and reached
Android's encrypted-backup share chooser after a strong random passphrase. The chooser was
cancelled. This proves that export reached the sharing boundary, not the resulting file's
contents, cleanup, successful restore, wrong-passphrase rejection, or post-restart persistence.

The later FEAT07 conversation was given a distinctive local nickname, purple color, and mute state
(`UI-03`) as a restore marker. That preparatory record remains limited to customization. The
subsequent `BACKUP-02..06` episode supplies the separate roundtrip, persistence, and external-file
cleanup evidence:

| Ledger case | Observed result                                                                                                                                                                                                              | Limit                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP-02` | Export reached Termux's Save file dialog; the operator copied the one disposable backup locally. Gator's native document picker exposed the exact `.gatorbackup` file at **745 bytes** and selected it for restore           | One local export-copy/import boundary, not cloud delivery, a server-slot backup, an encryption audit, or proof that Gator deleted its temporary export                    |
| `BACKUP-03` | After changing the nickname following export, a deliberately wrong passphrase produced the fixed rejection message. The retained underlying chat surface still contained the post-export nickname                            | Direct rejection proof; the underlying UI tree is supporting state evidence, not an independent visible check of every setting or DB-level proof of zero partial mutation |
| `BACKUP-04` | The correct passphrase produced Restored: **one chat restored, zero chats skipped**. The visible inbox again showed the exported nickname and mute indicator                                                                 | Same-account chat-customization roundtrip. Settings, themes, folders, and handle colors each had zero restored entries; those categories were not exercised               |
| `BACKUP-05` | Two ordinary `am kill` attempts did not end the process. Explicit force-stop then confirmed process absence and a COLD manual launch. The restored nickname persisted; chat settings showed mute checked and Purple selected | Persistence after force-stop/manual launch only. It is not an ordinary-kill success or killed-process push/background-delivery evidence                                   |
| `BACKUP-06` | The operator selected only the unique disposable exported backup, confirmed Delete forever, and the owning local provider subsequently showed No items with the backup absent                                                | Deletion of that external copy only, not Gator's temporary export, every cache/copy, or private operator evidence                                                         |

The ledger binds these results to captures 171–188 and 195–197. It does not credit a messages or
credentials backup, cross-account migration, server-slot storage, concurrent restore, interrupted
restore, or restoration of the zero-count categories. No personal share-sheet targets, private
backup filenames, or passphrases are reproduced here.

The closing FEAT07 account episode (`ACCOUNT-03`) reached Get Started on Disconnect while its
fixture remained running. The final status was retained, then the operator stopped the wrapper,
removed its private credential directory and owned reverse mapping, and a later host check found
no remaining FEAT07 private directory. The final status receipt (`feat07-final-status.json`)
precedes shutdown, so it alone does not prove process exit or reverse removal. The fixture never
enrolled FCM; this is not push-token deletion or scoped-device revocation proof. The earlier saved
Photos image is also not credited as deleted by this cleanup.

### Authorized live messaging — exact successes and remaining attribution limits

`LIVE-01` records pairing the unchanged Play installation to the live server over the owned USB
relay and opening the approved existing iMessage conversation. It does not prove new-conversation
creation or external-network/TLS access. Synthetic messages are identified here only as A, B, C,
and D; no recipient, conversation identifier, body, or body hash is reproduced.

| Ledger case                 | Observed result                                                                                                                                                                                      | Limit                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIVE-02`: text and edit    | A moved from Sent to Delivered. Editing produced the revised message with Edited and Delivered labels. Exact-message server readback confirms own/sent/delivered/edited state and two edit revisions | Reported messaging state, not direct observation on the recipient's device                                                                                                                       |
| `LIVE-03`: Like and removal | The edited A row gained a Like, and its menu showed Like selected. Later captures removed that glyph; the exact-A server record is `-like`, sent, with a delivery timestamp                          | Capture 290 still shows Like; captures 294 and later establish eventual local removal. The retained server record corroborates removal, not a separately retained add transaction                |
| `LIVE-04`: Undo Send        | B first showed Sent; Undo Send within two minutes produced You unsent a message. Server readback found a recent own row with cleared text and one retracted part                                     | That blank server row was not bound to B before retraction. Exact-B server attribution and recipient-device disappearance remain unproved                                                        |
| `LIVE-05`: reply            | C appeared with the quoted edited parent and Sent. The matching server message is own/sent and has a reply origin                                                                                    | No delivery timestamp in the retained readback; no recipient delivery or exhaustive thread-sync result                                                                                           |
| `LIVE-06`: image upload     | The owned image was selected, staged, and displayed as a sent photo. The server recorded a recent own/sent PNG at the corresponding time, with 3,480 bytes                                           | Timeline association, not exact marked-message identity or content hash. The selected input was 68 bytes; the transformation path was not verified. No delivery timestamp or recipient rendering |
| `LIVE-07`: captioned PDF    | The selected PDF and caption D appeared with Sent. Exact marked-message readback binds D to a sent 618-byte PDF                                                                                      | No delivery timestamp, download/hash, or recipient rendering. Its original-name loss is separately recorded as `LIVE-09`                                                                         |

The safe projection `live-ui-safe-projection.json` compares fixed labels and owned-message values
in memory without emitting private text or identifiers. Reaction matching requires the edited A
row and its Edited sibling, so the later reply preview is not mistaken for A. Accessibility trees
can retain underlying routes; the projection supports, rather than replaces, the operator's
visible-screen attribution.

Authenticated readback receipts `live-owned-message-server-proof-203933.json` and
`live-owned-attachment-server-proof-204012.json` add exact A/C/D and reaction metadata while
preserving the weaker B/image associations described above. Sent and Delivered are distinct.
These records do not establish recipient reading, live inbound-message handling, RCS/SMS service,
all attachment types, upload cancellation/retry, scheduled sends, provider capability transitions,
or the entire messaging matrix. The synthetic send-failure cases earlier remain separate from
these successful live operations.

### Reversible larger-font and microphone checks

`LIVE-10` temporarily changed Android font scale from 0.8 to 1.3. The operator inspected Settings
and the live chat, entered a synthetic draft with the keyboard visible, and observed Send above
the keyboard. XML confirms an enabled Send message control and focused composer, but does not
include the keyboard itself; the relative layout is an operator screenshot observation. The draft
was cleared without sending, and `font-scale-restored.json` confirms restoration to 0.8. The
non-send is an operator observation, not a server-side proof of absence. This is one larger-font
layout check, not every screen, navigation mode, or a general accessibility pass.

`LIVE-12` denied the initial microphone permission, observed Gator's access explanation, then
retried and selected Android's Only this time permission. Recording started, and a later capture
showed a 0:28 timer with Settings beneath the recorder modal. Cancel removed the modal. The
retained `microphone-after-cancel.txt` reports a completed `RECORD_AUDIO` operation lasting
36 seconds 441 milliseconds with no running marker. No audio was sent.

Two intermediate hierarchy captures failed during recorder animation; those are harness limits,
not established app failures. The final UI and AppOps observation support recording cancellation
and microphone release, but do not prove temporary recording-file deletion, codec/playback
quality, a successful audio upload, or recipient delivery.

## Final phone, credential, and owned-file cleanup

`ACCOUNT-05` records proper Disconnect reaching Get Started in settled capture 338, before the
final app-data clear. At **20:47:34 UTC**, an independent authenticated server-info check with the
exact saved, formerly working test bearer returned **HTTP 401**. The private
`live-credential-cleanup.json` records that no extra revocation request, server restart, or
other-credential change was needed. This proves that this bearer no longer authenticates; it
does not inspect the Mac credential table's displayed status or physical push-row deletion.

`live-owned-media-cleanup.json` records verification of the specific owned image's identity and
the synthetic PDF's hash before deletion, followed by confirmation that both were absent. Other
shared media were preserved. The PDF cleanup hash identifies the local test file; it does not
provide the missing uploaded/recipient-content comparison. The earlier external encrypted backup
copy was separately deleted in `BACKUP-06`.

Final app-data clear returned Success, followed by relaunch to the clean Welcome
screen in capture 339. `final-device-state.json` records the unchanged Google Play `0.1.59` / code
`80` installation, original font scale 0.8, Do Not Disturb value 0, stay-awake value 2, a
600,000-millisecond screen timeout, an awake phone, and no running microphone operation. Both
owned DL01/live USB reverse mappings were absent. Phone UI control was released; the wake keeper
continues by the owner's explicit request.

These are operational cleanup results, not forensic erasure of every private file or cache. The
app-data clear and clean Welcome state do not independently prove deletion of each recorder file,
database page, or external copy, and final package metadata is not a repeated APK signature check.
The untested acceptance branches below remain separate work.

## Host verification belongs to its exact source checkpoint

| Checkpoint                                 | Actual verification                                                                                                                                                                                                     | What it does not prove                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Source shipped in Play v80                 | 538 suites / 6,670 tests passed, two benchmark suites/tests skipped; release run 990.462 seconds; architecture 52, migrations 5, native artifact guard 30; 2,248 scanned DB writes with zero errors                     | Later fixes, actual runtime behavior merely because a build/test passed                |
| Retained full DB proof used for v80        | 115 / 115 tests, no failures/skips; source-equivalence assessment retained in `BB/gator-android-release-2026-10-03/db-proof-review.json`                                                                                | A new native process-death/migration/rekey test on this phone                          |
| Message-state 409 repair only              | Focused 6 suites / 128 tests; full 538 suites / 6,689 tests, two benchmark suites/tests skipped, 981.224 seconds; architecture 52 and migrations 5; no console warning/error sections                                   | The subsequent notification repair, coverage for new changes, or phone recovery        |
| Notification-history repair focused checks | Focused 5 suites / 232 tests, including 13 new regressions; typecheck/lint pass; fast DB scanner 101 pass / 14 full-only skips; strict inventory 2,248 approved and zero reconcile drift                                | Native tray/cancellation behavior or rebuilt-device fix acceptance                     |
| Frozen combined sync/notification repairs  | Full 538 suites / 6,702 tests passed, two benchmark suites/tests skipped, 179.666 seconds; architecture 52 plus live guards; migrations 5/head 0053; no failures, console warning/error sections, or React act warnings | New native artifact, phone recovery/withdrawal replay, or coverage for the new changes |

The notification focused-test counts are retained in a result receipt transcribed from completed
tool output; those two focused Jest runs were not redirected to separate disk logs. Its typecheck,
lint, scanner, and reconcile logs are retained. The initial inventory check failed with 18 stale
source-line diagnostics after formatting, then passed after the authorized line-only refresh; the
failure is preserved rather than treated as an earlier pass.

No current combined coverage claim is added. The released artifact's raw dependency audit remained
failing at **58 high / 3 moderate** findings for the full tree and **49 high / 3 moderate** for
production, with zero critical findings. Existing local mitigations and this device session do not
waive those gates or the separate legal/wider-release requirements.

## Remaining-test continuation — 2026-10-03

The owner authorized finishing the remaining tests and fixes before one combined rebuild. This
continuation uses the same Play-installed `0.1.59` / code `80` Samsung/API-36 app. Source repairs
below are not installed in it. Private evidence is in `BB/gator-prebuild-remaining-20261003/`,
relative to the checkout's parent. The original 81 observations remain the earlier round's record.

### Killed-process scheduled work

An authenticated loopback fixture accepted two disposable text requests and had no external
messaging transport. The phone scheduled one one-time message and one daily message for 17:38 MDT.
The fixture deliberately returned 404 for server scheduling, selecting the local fallback for the
one-time message. Both were visibly pending before Home and ordinary `am kill`; process absence
was observed throughout the wait.

An early forced JobScheduler invocation started a process but only rescheduled WorkManager because
its minimum delay had not elapsed. That invocation is **not** successful task evidence. After the
minimum delay, the 23:47 UTC invocation started process 10233 and logged native `doWork`, task
completion with `success=true`, and `Worker result SUCCESS`. The fixture counted exactly one request
for each case with distinct idempotency keys. The approximately nine-minute delay from the selected
send time demonstrates best-effort scheduling, not exact-time delivery.

| Check                   | Observed result                                                                                         | Scope                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Cold background handoff | Both pending messages reached the authenticated fixture once; native worker succeeded                   | Forced eligible job after process absence; not spontaneous OS timing or recipient delivery |
| Daily recurrence        | Daily row advanced to October 4 at 17:38; one-time row showed Sent                                      | One daily step; other patterns/time-zone changes remain open                               |
| Reopening               | Inbox and chat reopen did not increase the two-request count                                            | Finite reopen interval, not every concurrency/crash boundary                               |
| Cleanup                 | Disposable daily schedule was canceled and left the pending list                                        | No live recipient or server-owned schedule affected                                        |
| Diagnostics consent off | Settings showed consent off; sync, background work and reopening made zero error-report upload requests | Network observation only, not independent inspection of the encrypted report table         |

Evidence: `schedule-background-result.json`, `schedule-timeline.json`, fixture aggregate counters,
private native worker log, and captures `016`–`023`. Credentials stay in private local receipts.
The sole wake helper continued throughout. Offline, deadline, cancellation and overlapping-worker
cases remain separate tests.

### Combined source repairs and host verification

Settings search now matches words in visible labels. The measured connection banner reserves space
inside routed headers without shifting the navigator/keyboard coordinate origin or bottom inset.
Connection copy no longer claims the live socket works while transport is unavailable. A bounded
native multipart filename override retains streaming, progress and cancellation; source/patch and
packaged-code guards do not substitute for native execution proof.

App Lock waits for old detailed notices/private channel labels to be cleared and keeps new message
notices generic whenever enabled, including after unlock and during grace. The repair preserves
verified generic reminder alarms and fences delayed native posts/account changes. A new finite sync
failure diagnostic retains approved classifications instead of private error prose; it cannot
recover the earlier v80 failure's cause. These repairs require a replacement build and applicable
device replays.

The executable source is frozen at `58b2759a3a3a8a4e3bd3c218151d7c6fa2452af1` in the isolated
`gator-release-20261003-combined` checkout. The final full run passed **539 suites / 6,778 tests**,
with two existing opt-in skips. The separate UI-coverage run passed the same suites/tests and all
configured floors: statements **88.34%**, branches **82.14%**, functions **88.77%**, lines **91.27%**.
Typecheck, source lint, formatting, architecture **52**, migrations **5**, workflow security **37**,
diagnostic guards **37**, native/artifact guard unit tests **38**, Expo compatibility and Doctor
**20/20** passed. The fast DB scanner passed **101**, with 14 intentionally full-only skips; all
**2,248** approved mutations match, and final reconciliation reports zero drift. Reviewed data-only
proof-pin updates changed no scanner algorithm or ingress certificate logic.

The production Android JavaScript export and clean native project generation passed. Neither
executes the JVM, compiles Kotlin, builds an AAB, or proves native runtime behavior. A clean install
also exposed a preexisting stale legal component record: v80's bounded-download module already had
14 files, while its generated inventory still recorded 12. Only that count/digest and the matching
notices row were refreshed; dependency/provenance statuses and runtime notices remain unchanged.
The final documentation/data refresh received its own source identity and fresh release receipts,
recorded in the post-freeze checkpoint below.
Raw dependency warnings and legal review remain open.

Evidence under the continuation directory includes `combined-jest.log`, `ui-coverage.log`,
`typecheck-final.log`, architecture/migration/lint/format logs, `candidate-*.log`,
`candidate-legal-drift.json`, and `source-copy-receipt.json`. The separately prepared Mac package
contains reviewed server fixes at `917bd8191a1355effeeb4fbf1257ef9194c5f77b`; installation was pending
at the source freeze and subsequently completed as recorded below. The phone remains on v80; fingerprint participation,
temporary credential creation, and additional-hardware availability were requested separately.

### Post-freeze operation checkpoint — 2026-10-04 UTC

The earlier clean Android candidate is `ea7054a4c011fa4d7598070236fac9a2e2684053`; its two children
after the tested executable checkpoint change only eight documentation/legal-data files. The native
release checklist now matches CI's six owned modules and includes the share-intake and task-manager
unit tasks. Release run `android-0.1.60-ea7054a-20261004001707` passed preflight and preparation for
**0.1.60**, with no JVM launch, Android build, remote version consumption, or submission. The two
earlier unused preparation receipts are explicitly superseded in private `combined-milestone.json`.
All 1,344 source files matched the working checkout at this freeze. This later report update does
not modify that retained candidate.

The Mac session installed exact `917bd819` and independently verified all 893 retained package
entries plus its strict signature. Local and public HTTPS ping returned 200; unauthenticated info
returned 401. Six protected state tables and the sync witness were unchanged, as were boot settings
and the repaired LAN tunnel. The previous app and matching stopped state are retained for rollback.
Evidence: `BB/gator-mac-fixes-install-2026-10-03-7n4wb1qu/completion.json`. Two initial desktop
inspection attempts timed out. A later explicit Refresh Messages Helper showed **CONNECTED,
authenticated**; Refresh Status showed **HEALTHY / READY**. The initial waiting/degraded display
was stale. Evidence: `BB/gator-prod-readiness-2026-10-03-ukr6o7x1/helper-health-verification.json`.
This finite helper check does not substitute for the matching updated-client live acceptance.

The Mac session subsequently installed `c8df5a16`, with owner-confirmed Connected and Healthy/Ready
status, then `5d9ac754`, which adds automatic status polling while visible and on focus. The latter
passed 5,480 JS/TS tests, nine Python tests, Go checks, package/signature verification and state
preservation; one optional GUI test was skipped. Its owner visual confirmation and coordinated
reboot recovery remain pending. Evidence: `BB/gator-status-refresh-2026-10-03-31ctxtpm/install/completion.json`.
Earlier helper confirmation is not relabeled as a visual check of the latest installation.

The phone remains awake. Owner authentication opened protected Settings on Play v80. A warm
Home/resume interval of **5.09 seconds** returned to Settings without another prompt; a second
interval of **35.10 seconds** in the same process presented the fingerprint prompt and removed
Settings from the UI tree. This proves the finite successful-unlock/30-second-grace slice only;
it does not prove cold launch, locked push drain, or the replacement source's notification sweep.
The owner completed the second fingerprint unlock, returning to the inbox. Settings was reopened
and App Lock was turned off for background testing; capture `036` verifies the unchecked control.
Evidence: `applock-grace-result.json` and captures `028`–`036` in the continuation directory.
Capture `034` is an inbox view despite its filename and is not App Lock-off evidence.

The synthetic fixture retains exactly
two schedule requests and zero diagnostic uploads. Its recorder-only shutdown race was fixed and
independently retested in a separate process; the resumed active fixture keeps the same connection.
Isolated phone tests continue. Live HTTPS credentials were not
created, and no live acceptance window started. AMFI remains unchanged; native Kotlin/unit/build
work requires the coordinated later AMFI/reboot step.

### Background deadline and native-stop continuation — 2026-10-04 UTC

The same authenticated synthetic fixture has no external messaging transport. App Lock is off,
diagnostic consent remains off, and the phone stays awake. Eligible JobScheduler invocations used
the constraint-respecting `-s` option; native worker events and fixture request timings establish
execution, rather than the command's acknowledgment alone.

| Case                            | Observed result                                                                                                                                                                                                                                           | Acceptance limit                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stalled server-info request     | First request closed at 29.957 seconds; retry closed after another 19.369 seconds. Native task failure and WorkManager RETRY occurred 51.364 seconds after worker start.                                                                                  | Pass for this uninterrupted request timeout/absolute work budget; native start includes JS startup, not exact callback-entry instrumentation.                           |
| Slow sequential phases          | Server-info completed after 27.002 seconds; the subsequent message query closed after 22.553 seconds. Native failure/RETRY occurred after 51.314 seconds.                                                                                                 | The next phase used the remaining overall budget; it did not receive a fresh 50 seconds.                                                                                |
| Duplicate active trigger        | A second constraint-respecting trigger during the slow query created no second observed worker or request chain.                                                                                                                                          | Native serialization in this episode; an outstanding uncooperative JS continuation was not exercised.                                                                   |
| Native timeout/cancellation     | Android logged worker cancellation 37 ms after the command, but HTTP completed naturally at 40.002 seconds, about 22.584 seconds after cancellation.                                                                                                      | Prompt network cancellation was not achieved. Native stop does not prove JS cleanup.                                                                                    |
| Later replacement               | The old failure callback appeared immediately before a replacement worker; the old request had already ended. Replacement requests then closed at 30.003 and 19.724 seconds; the replacement logged failure/RETRY after 50.011 seconds.                   | This did not exercise overlapping HTTP, and the cancelled worker's later callback cannot be credited as WorkManager RETRY. Its callback timing/cleanup remain unproved. |
| Offline constraint and recovery | With Wi-Fi and mobile data off, the due job refused a constraint-respecting trigger and showed unsatisfied CONNECTIVITY. Restoring both settings caused an automatic worker run, one info/query pair, and native WorkManager SUCCESS after 1.489 seconds. | Scoped OS connectivity/recovery pass; no force bypass or post-restoration run command. A reachable-network/unreachable-server failure remains a distinct test.          |

The cancellation result exposes a source-level gap: WorkManager cancellation stops the Kotlin wait
without revoking the JavaScript callback's abort signal. Separately, a callback can report its
deadline result while its protected continuation remains alive; normal TaskManager completion can
then release the native timer keeper too early. The existing continuation fence must remain until
actual settlement. Native-stop propagation and keeper lifetime require a focused correction and
replacement-build proof. `REL-001` remains open.

No additional synthetic sends or diagnostic uploads occurred in these lanes. Receipts include
`stall-info-holds-result.json`, `slow-cycle-holds-result.json`,
`overlap-trigger-during-slow-cycle.json`, the cancellation observer's 21 samples, and its separate
native-timeout/replacement-trigger receipts, `cancellation-result.json`, and
`offline-and-normal-recovery-result.json`. The initial bounded line-tail capture missed late native
events. A separate UID/tag-filtered, byte-bounded capture recovered the replacement RETRY and normal
recovery SUCCESS; finite projected events are in `background-native-late-capture.json`. Wi-Fi,
mobile data and airplane-mode settings match their baseline. Settled HTTP holds alone are not native
terminal-result proof.

The later **network-up/server-unreachable** lane failed its bounded native-result expectation.
Fixture B's owned loopback reverse was removed while Wi-Fi/mobile data stayed enabled. Ordinary
`am kill` left PID 21680 alive because Termux retained Gator's sharing provider, so this is explicitly
a warm-background lane. Android started the due worker automatically; no operator run command
was sent. TaskService logged that its timer keeper started one millisecond later. Restoring the
route after **130.874 seconds** did not itself settle the worker. Bringing Gator forward was followed
immediately by task failure and WorkManager RETRY, **194.059 seconds** after native start.
The following retry completed only by taking the foreground-deferral branch, so its SUCCESS is not
background-sync recovery proof. Evidence: `server-unreachable-result.json`, the 55 finite observer
samples, `server-unreachable-lifecycle.json`, and the route/foreground receipts.

Native consumer dispatch does not prove JavaScript callback entry, and fixture counters cannot
observe refused connections while the route is removed. The keeper-start event does not establish
the cause of the stall. The reviewed retention correction alone is not claimed to solve it. A
separate native 60-second watchdog now wraps the cancellable scheduler wait, preserving
external cancellation and the outstanding-consumer fence. Its own timeout must request retry;
it cannot guarantee interruption of blocking native calls or execution while Android suspends the
process. Independent review and 27 host guard tests pass. Six additional virtual-time native tests
are authored but uncompiled/unrun; exact rebuilt-phone replay remains required.

### Expanded backup and account-switch continuation — 2026-10-04 UTC

An encrypted local backup on fixture A included a compact-list setting, one custom theme, and one
folder with one member. After reversing those settings, native file selection and restore recovered
all three visibly. A second encrypted backup added a phone-local nickname, pin, mute, bubble color,
and contact color. The operator retained ciphertext and a separately protected random passphrase;
host decryption verified the expected category counts without printing private contents. An initial
automated password entry was incomplete; paced entry succeeded with the same validated file/key.
This was an input-automation failure, not evidence of a cryptographic defect.

Fixture A was disconnected through Gator's normal UI, without clearing app data. Fixture B used a
different loopback URL and credential. Before import, B showed no A draft, nickname, pin, mute,
bubble/contact colors, custom folder, or A-only scheduled messages. Global compact-list and custom
theme preferences deliberately survived. A's request counts stopped and its active holds were zero.
The fixtures share seeded conversation/message identities, so this is local-marker and credential
replacement evidence, not exhaustive distinct-server-history isolation.

Explicitly importing A's full backup into B reported **one setting, theme, chat customization,
folder, folder member, and handle color, with zero skipped entries**. The nickname, pin, mute,
purple bubble color, and navy contact color were visibly verified; the composer remained empty.
Capture `127` shows the restored folder with one saved conversation; `132` shows the pinned tile
in the actual inbox. Earlier covered-route XML alone is not visible pin proof. The synthetic
fixture supports authenticated HTTP but no working socket; Reconnecting remains expected.
Drafts are not part of the customization backup. Evidence includes `backup-expanded-result.json`,
`backup-full-content-check.json`, `account-B-connected.json`,
`account-B-customization-baseline.json`, `backup-cross-account-visible.json`, and captures
`109`–`134` in the continuation directory. Capture `098` is Settings despite its filename; capture
`101` is the actual reopened A-draft proof. Private temporary-export deletion, interrupted restore,
server-slot restore, and complete account erasure remain unproved. Compact-list mode was returned
to its original off setting, the owned theme was deleted, and the two owned Termux/share-storage
backup copies were removed. Private operator ciphertext remains separately protected evidence.

Deleting the first test folder from its nested editor also caused a real Play-v80 process crash:
`expo.modules.gatorscreensecurity.ReleaseReactInstanceException: runtime.fatal [UnknownError]`.
Cold relaunch recovered, the folder was gone, and conversations remained. Capture `063` is Termux
after the crash, not deletion proof. Native source review found a concrete multi-pop ordering defect
in Screens 4.26.2, consistent with the earlier predictive-back incident. The reviewed correction
orders removals by the committed stack and validates the complete batch before mutation. Eighteen
native regression tests are authored but have not been compiled or run. The redacted phone error
does not establish exact attribution; the rebuilt folder-delete/Back replay remains mandatory.

The continuation ended fixture B through normal Disconnect, then verified Welcome, Back out of
Gator, and Welcome again on relaunch (`139`–`141`). No B sends or diagnostic uploads occurred.
The dormant registered background job remains recorded; Welcome and quiet fixture counters are
not proof that every Android task or private SDK artifact has been erased. Both owned fixture
processes and reverse mappings were stopped after quiet-account checks; B stayed quiet for
31.766 seconds after its final Disconnect receipt. The wake-only helper remains active.

### Native correction host checkpoint — 2026-10-04 UTC

Source `15874ff552168070286bafdf83e9a60b93401821` freezes the cancellation/continuation and
Screens corrections. Fresh dependency installation applied every retained patch. Fifteen static
gates passed, including types, lint/format, architecture, migrations, fast DB scanner/report and
reconciliation, workflow/native guards, diagnostics, legal inventory, documentation, secret hygiene,
and toolchain checks. The full coverage run passed **540 suites / 6,798 tests**, with two existing
skips; UI coverage was **88.37% statements, 82.17% branches, 88.77% functions, 91.32% lines**.
All configured aggregate and critical-file floors passed.

The simultaneous ordinary Jest run crashed after 152 passing suites with exit 139. The macOS
report identifies `EXC_BAD_ACCESS / SIGSEGV` in V8 garbage collection; it reports no failed test
assertion. That incomplete run is not a pass. The coverage configuration includes both complete
base Jest projects. The ordinary serial rerun on final executable source
`b7b92e84b697adb05df4756daf4002f33e705848` then passed **540 suites / 6,798 tests**, with two
existing skips, in 128.810 seconds. The
reviewed native watchdog follow-up changes only its durable patch and two build-guard files;
it changes no TypeScript or DB source. Its own 27 guard tests pass; the final combined artifact,
native-path and legal-AAB guard suite passes **39 tests**. Fresh dependency installation, Android
JavaScript export and clean native project generation also pass with a clean source tree. No JVM
ran. The final documentation-only child is bound by the new release preparation receipt. Native tests, compilation,
signed artifacts and replacement-device proof remain pending. Receipts: `native-fix-host-gates.json`,
`native-fix-ui-coverage.log`, `native-fix-jest-crash.json`, and `bg-watchdog-implementation-receipt.md`.
Final rerun and generation receipts are `watchdog-final-jest-serial.log`,
`watchdog-final-verification.json`, and `watchdog-final-gates.json`.

## Current conclusion and remaining acceptance

**Continuation authorized, 2026-10-03:** The owner requested the remaining tests and fixes,
followed by one combined Android rebuild. The original 81 observations remain a completed v80
round; later source repairs and tests must retain their own identity. Work is proceeding in
three verified stages: (1) repair and review reproduced defects with focused tests, (2) run
the remaining feasible prebuild phone matrix, and (3) freeze the combined source, run the
full gates, then coordinate AMFI/reboot and the rebuild. Repaired behavior requires a
replacement-build device replay. RN owns the Samsung lease and sole wake helper; the server
session owns Mac source repairs and connectivity diagnostics. Biometric, actual-location, recipient-side,
second-device, and genuine API-37 acceptance remain dependent on their respective participation
or hardware. Optional and owner-dropped scope is unchanged.

The original bounded testing round completed its cleanup. The active continuation has its own
fixture, phone reservation, wake helper, and pending owner actions. The original round established useful exact-v80 native
behavior: normal encrypted-DB rekey/restart continuity, selected long-ID/cache and download cases,
one local encrypted-backup customization roundtrip, notification arrival/tap/grouping cases, and
authorized live text/edit/reaction/reply/attachment operations within the limits above. The initial
live sync failure later recovered to the app's completed state, and the former test credential is
now rejected.

**Release readiness is not established.** The reproduced sync/notification defects and subsequent
Settings, banner/copy, filename and App Lock repairs pass the combined **539-suite / 6,778-test**
host milestone, but the installed v80 does not contain them. The initial sync failure's cause remains
unexplained; added diagnostics support a future reproduction. Successful scoped observations
do not close the remaining device matrix or the raw dependency, legal, and wider-release gates.
The later native corrections and watchdog pass the **540-suite / 6,798-test** ordinary host gate and
39 final artifact-guard tests. Their **42 native registry, TaskService, deadline and Screens tests**
remain uncompiled/unrun, and Play v80 contains none of these new native corrections.

1. Bind any new Android artifact containing the host-verified combined repairs to its own
   source/release identity. Repeat automatic expired-cursor repair, invalidated-page recovery, and
   the cold six-entry notification withdrawal on that exact installation. Do not relabel the v80
   failures as passes or use a forced full refresh as proof of automatic repair.
2. Diagnose any repeat of the initial live sync failure with a retained, redacted classification.
   Exact server/client history reconciliation, missing/duplicate-row checks, and every native
   sync transaction boundary were not tested by the Up to date counter.
3. Install and retest the source repairs for Settings-label search, banner/copy findings,
   and multipart filename preservation. Host regressions cover invalid names and preserved source
   metadata; Kotlin execution, on-device keyboard/font layout and actual upload bytes/name remain open.
4. Verify the source App Lock old-notice privacy repair on the replacement candidate. Warm biometric
   unlock and the finite grace timing passed in the continuation; cold launch, post-unlock drain,
   all locked envelope/action versions, replay/isolation, notification
   inline actions, and native cancellation-failure cases were not established by this round.
5. Keep messaging proof bounded. Direct recipient-device reading/rendering, exact-B server unsend
   attribution, live inbound messages, RCS/SMS service, new-conversation creation, complete
   thread/receipt behavior, real scheduled-message delivery, upload cancellation/retry, audio upload, and provider
   capability transitions remain untested here. C, the image, and D lack retained delivery proof.
6. Keep download/media/backup results scoped. Missing off-screen owner rows, remaining hostile
   length/content/concurrency and quota cases, uninterrupted video resume, PDF pixel rendering,
   downloaded/uploaded content hashes, temporary export deletion, server-slot and interrupted
   restore, and recording-file deletion remain open. Positive customization categories and the
   bounded cross-account import now pass; they do not establish complete account isolation.
7. Keep native DB claims bounded. This session does not prove death during migration, an active WAL
   write or rekey, wrong-key rejection, concurrent SQLCipher behavior, interrupted backup restore,
   or complete cache/account erasure. Prepared prior-version migration, exhaustive distinct-account
   replacement, eligible API-37 Play delivery, other devices/navigation modes, and the broader
   permission/security matrix also remain unproved. Release builds and host mocks do not fill
   those gaps.
