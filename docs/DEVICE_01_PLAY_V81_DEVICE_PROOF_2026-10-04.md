# DEVICE-01 — Play v81 device proof, October 4, 2026

**Post-reboot checkpoint: October 4, 2026, 16:13:35 UTC.** This is reviewed evidence for Play 0.1.60 / code 81, not task closure or wider-release authorization. The Mac peer released the host at 15:07 UTC after the actual owner reboot passed; synthetic phone testing resumed and completed the cases below. Phone UI work is now paused for peer/owner production RCS pairing; no such pairing has occurred at this checkpoint. The earlier 14:49 handoff remains historical.

Private evidence uses backticked paths relative to the checkout’s parent, principally `BB/gator-v81-feature-replay-20261004/`; these are not public-checkout links. V80 observations are historical. AMFI remains enabled. The completed Mac reboot check bound server `c220041d`; its later production cutover is separately owned by the RCS/Mac peer, and live Android/server acceptance remains on hold. These synthetic fixtures did not mutate real message history.

**Build and source identity**

| Item                              | Verified identity                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Android package                   | `com.bluegreengatorapps.messages`                                                                         |
| Phone candidate                   | Google Play Internal Testing **0.1.60 / version code 81**, as bound by root’s installed-candidate episode |
| Source                            | `2c09378b495b11efdd145cdaa6ef0cc54c12f54a`                                                                |
| Release commit                    | `ec5beee552253b9c73f95b66034fb6f76c29b97e`                                                                |
| Signed AAB SHA-256                | `7ecad1e31bb3a55a25695681c8a57813d0f79dc84216f4b9192825ca80b5221b`                                        |
| Signed AAB size / native contents | **58,172,630 bytes; 33 native libraries, all arm64-v8a**                                                  |
| Migration head                    | **53 / `0053_versioned_server_message_state`**                                                            |

The artifact review (`BB/gator-android-0.1.60-20261004/artifact-review.json`) passed ZIP/payload/signature, expected upload-certificate, version/package, source/release-tree, Maps-digest and native-path checks. The JarInputStream warning remains recorded; all 1,756 payload digests were checked and no non-META-INF payload was unsigned under the verified JarFile path. Artifact checks do not prove phone behavior.

The exact candidate’s native test receipt (`BB/gator-android-0.1.60-20261004/native-test-results.json`) records **177 tests across 9 modules and 18 classes: 0 failures, errors or skips**. This includes 42 new tests: 9 background execution-registry, 6 native deadline, 9 TaskService lifetime and 18 navigation multi-pop tests. These are native unit-test results, distinct from both phone and emulator observations.

The host-tested source parent `2f853fa` passed **542 suites / 6,849 tests, 2 existing opt-in skips and 0 failures**. Production source is unchanged in `2c09378`; the intervening documentation/native-test compiler corrections retain their separate identity. No full rerun was performed for this report-only checkpoint.

**Scheduling on Play v81 — passed within the tested cases**

The local scheduling result (`BB/gator-v81-feature-replay-20261004/scheduling-result.json`) and dismissal result (`BB/gator-v81-feature-replay-20261004/scheduling-dismissal-result.json`) record:

- The themed sheet exposes date/time, presets, repetition, Schedule and Cancel. A preset fills fields without submitting.
- Cancel, Android Back and backdrop dismissal preserved the draft, closed the sheet and produced **0 scheduling mutations and 0 sends** in that dismissal episode.
- Impossible dates and past times were rejected; controls remained reachable with the keyboard open.
- One explicit one-time schedule created exactly one local pending row. The fixture returned 404 for the scheduling POST, exercising local fallback; **1 POST and 0 message sends** were recorded.
- Reschedule Cancel preserved prior values, accepting a time changed only the editor draft, and the discard guard distinguished keeping edits from discarding them. Save persisted the new time.
- Both a saved one-time row and a daily repeating row could be cancelled, removing their rows and counts.
- After explicit force-stop, observed process absence and manual cold launch, the schedule list remained empty (capture 045). The earlier ordinary-kill attempt left the process alive and receives no cold-launch credit.

The separate server cancellation result (`BB/gator-v81-feature-replay-20261004/server-schedule-result.json`), captures 079–085, covers three server-backed schedules: normal DELETE 200 removed the matching local/server row; the exact `scheduled_message_not_found` 404 removed the matching local row; and the exact `scheduled_message_in_flight` 409 preserved the row/count and showed truthful feedback. Normal cleanup then removed the retained row. Final counters: **3 creates, 4 deletes, one 404, one 409, 0 pending schedules, 0 successful sends**.

These synthetic servers never dispatched a schedule. This does not prove recall after send, every provider-handoff race, or delivery to a real recipient. An accidental automation Send in the first server fixture was rejected, showed Not Delivered, and its failed bubble was removed; it is not credited as a successful-send test.

**Settings and folder navigation — passed within the tested cases**

Settings/folder evidence (`BB/gator-v81-feature-replay-20261004/settings-folder-result.json`), captures 048–059, shows exact Server Management and Server Health search results, accessible links beneath the connection banner, and appropriate unavailable-health feedback from the limited fixture.

An owned folder was created with one synthetic conversation, opened through browse → nested editor, then deleted. Navigation returned to the empty folder list and a responsive inbox with both conversations intact. The observed PID remained unchanged across this deletion, exercising the previously crashing multi-pop path.

The updated result receipt also credits folder-deletion persistence: root verified ordinary-kill process absence, observed a recreated background process, and capture 061 (`folder-empty-after-process-recreation`) still shows the folder absent. The screenshot/XML alone does not establish the process lifecycle; that part relies on root’s recorded PID absence and recreation. Predictive-back gestures and arbitrary navigation stacks remain outside this proof.

**Photo actions and upload filenames — partial completed coverage**

The photo/upload result (`BB/gator-v81-feature-replay-20261004/photo-upload-result.json`) records **six gesture assertions** in the corrected `photo-replay-U4JO9X` episode (captures 086–092): ordinary taps on both cells of a two-image message and on a separate single-image message opened the matching viewer item; center holds on each of those three targets opened message actions without opening the viewer on release. Attachment selection and upload/cancel flows followed through capture 108. The first fixture’s missing grid was traced to its HTTP 400 rejection of the real client’s `with`/`sort` query fields. The fixture was corrected and tested against the frozen client endpoint/schema; the first missing-grid observation is not an app defect or a pass.

Two owned PNG uploads independently reached the observer with their exact original names: `Gator-v81-upload.png` and `Gator-v81-café.png`. Both file bodies were **6,291,456 bytes**, and both matched the generated asset SHA-256 `e1ad1d06edc9040f54b7bf104391dd8a4459b0c318ec8b3838858f3b071289cc`. The UTF-8 filename and file-only hash are separate checks.

Captures 101–108 and the settled two-upload status (`BB/gator-v81-feature-replay-20261004/photo-replay-U4JO9X/status-1791120907083-a178d7.json`) support active cancellation: both rows ended `client_closed`, with **0 fixture expirations, 0 fixture releases, 0 active uploads and 0 successful sends**. The first confirmation’s Keep action preserved its active upload; subsequent Cancel Sending removed it. The bodies had already completed before cancellation. This proves cancellation while awaiting a response, not interruption halfway through payload transmission or real-message delivery.

**Queued cancellation now passes in one bounded fresh episode.** The queue result (`BB/gator-v81-feature-replay-20261004/queue3-5hue954c/result.json`) and finite stages (`BB/gator-v81-feature-replay-20261004/queue3-5hue954c/events.jsonl`) bind three individual UI sends to Sending 3 files, then the newest photo's message actions and Cancel Sending confirmation, followed by Sending 2 files. Both receiver requests remained `held_complete` throughout cancellation. Explicit release closed exactly those two responses at **51.200 seconds after the first wire admission**; a further **12.246 seconds** retained exactly **2 request starts, 0 active uploads and 0 successful sends**. All 21 retained XML captures match their recorded hashes. This proves no third request in that observed window, not successful delivery or mid-body interruption. Device preferences were unchanged, including that episode’s DND value 1.

Two earlier attempts remain excluded: the first request timed out after 60.026 s and admitted the third 29 ms later (`BB/gator-v81-feature-replay-20261004/photo-replay-U4JO9X/status-1791121145599-927377.json`); the first runner stopped after two sends on its composer check (`BB/gator-v81-feature-replay-20261004/queue3-2exp5bzq/result.json`). Its exact failed XML is unavailable. The successful runner’s retained XML shows disabled-then-enabled composer state, handled by one read-only resample without repeating taps/extending the deadline. This does not establish the earlier failure’s cause.

The completed U4JO9X episode was properly disconnected and shut down with no active uploads or schedules; its private credential and owned reverse were removed. The fresh successful queue episode also ended with normal Disconnect (capture 121/Get Started), fixture exit 0, private receipt removal and owned reverse 43134 removal. Its final fixture counters (`BB/gator-v81-feature-replay-20261004/photo-replay-otCmQ3/final.json`) retain two explicitly released requests, zero active uploads and zero sends; the owned-file cleanup (`BB/gator-v81-feature-replay-20261004/owned-photo-files-cleanup.json`) records removal of all three test files and their directory, with other Downloads untouched.

**Background execution on Play v81 — scoped pass with explicit gaps**

The independent background review (`BB/gator-v81-feature-replay-20261004/background-review.json`) reconciles **8 closed observer sessions / 124 samples** plus the full retained native-event capture. Device-clock durations are:

| Case                                | Observed result                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| Normal background sync              | Success in **76 ms**                                                                |
| Held server-info response           | Success in **40.124 s**                                                             |
| Sequential 27 s + 27 s responses    | Task failure in **54.088 s**; WorkManager retry at **54.090 s**                     |
| 90 s synthetic hold                 | Task failure at **50.013 s**, then a retry and later success                        |
| Cold, missing USB route             | WorkManager retry in **2.670 s**                                                    |
| Restored route                      | Success in **1.847 s**                                                              |
| Native stop of an active held retry | Peer request closed before natural 90 s expiry; replacement succeeded in **112 ms** |

Final background counters were **0 active holds and 0 sends**, with at most one held fixture request at a time. Root reports no foreground entry from 13:05 until after the episode at 13:17.

The long hold reached the JS 50-second budget: no `native_deadline_retry` event occurred. An initial stop without a confirmed HTTP hold is excluded. The later stop proves cooperative HTTP closure, not fencing of a deliberately uncooperative continuation. Host/device clocks cannot establish exact cancellation latency. An operator fixture restart interrupted one retry and is not an app failure. Screen-off/Doze and arbitrary background-network conditions remain untested.

**Automatic sync repair on Play v81 — scoped pass**

The reviewed evidence is `BB/gator-v81-feature-replay-20261004/sync/phone-review.json`, with captures 124–140 and the episode’s finite wire/control projections. The fixture uses production read/state/repair/auth/socket handlers from server source `d06e26db55f07c18d7333c80dcfe12f0f6595e9f`, with disposable synthetic data and no send or FCM operations.

- Controlled delete → restore → same-date redelete → restore changed the target’s visible state as expected while other Apple canaries remained. The identical deletion date comes from the fixed control contract and host test, not a phone timestamp.
- An offline delete/restore/delete burst converged to the final absent state on reconnect. The attempted ordinary kill retained the process, so this is **warm reconnect**, not process-death recovery.
- After the user locally deleted the controlled target, later server delete/restore and the completed provider repair did not resurrect it. The separately named local-deletion sentinel remained visible; it was not the message actually deleted.
- Seeding 501 state changes, pruning 500 journal rows and arming one invalidation triggered `repair_required` through ordinary Home/resume. The first repair encountered the deliberately changed/invalid snapshot and cancelled. A **later ordinary Home/resume** started a fresh repair and completed successfully; no manual Repair or forced full refresh was used.
- Direct synthetic RCS and SMS chat views remained visible after the Apple-provider repair.

The initial successful snapshot had one begin/finish. After invalidation, counters showed two begins, still one successful finish, and one cancel; after fresh-resume recovery, three begins and two successful finishes. The invalidation failed during snapshot reads: **no finish 409 occurred**. Capture 136 did not show a SyncError banner. These results prove automatic recovery across separate foreground runs, not a same-run retry timer, raw cursor/transaction correctness, exhaustive history parity or crash durability.

Normal Disconnect reached Get Started in capture 140. `BB/gator-v81-feature-replay-20261004/sync/phone-cleanup.json` records the closed marker, fixture exit 0, private directory absence and owned reverse 43127 removal. The retained pre-close status still says closed:false and is not represented as a final closed receipt. No independent token-revocation HTTP request or broad private-data-erasure check is claimed.

**Notification history and withdrawal on Play v81 — scoped cold pass**

`BB/gator-v81-feature-replay-20261004/notif/notif03-phone-review.json` independently reconciles seven saved native-history dumps with their projections and hashes. An observed ordinary-kill process absence preceded the cold FCM continuation; the app process was recreated without an operator foreground launch.

The settled history grew to five lines, then retained exactly **[2,3,4,5,6,7]** at the six-entry limit. A late unseen event left the complete projected history and native timing metadata unchanged. Withdrawing the middle message removed only 4, preserving **[2,3,5,6,7]**, the notification identity and survivor metadata. Resource history separately retained six lines of **512 code points / 2,048 UTF-8 bytes each** while the earlier history stayed unchanged. Two child records and one group summary were present.

The first early capture had no active record and an early fifth-line capture contained only four lines; both are superseded timing observations, not settled failures. Capture 143 opened resource chat C rather than history chat A and provides no history-chat reopen proof. Avatar requests were 0; Android Person strings did not expose avatar presence/type, so avatar fetch/decode is unproved.

The closed fixture recorded 14 completed steps and 15 FCM submissions. Submission counts are not delivery acknowledgements; the saved native records supply the actual presentation evidence. Normal Disconnect reached Get Started in capture 144; the native projection then contained 0 Gator records. The final result records no fixture failure, registration false before close and private receipt removal; the operator recorded exit 0 and owned reverse 43126 removal before the next episode.

**Grouped withdrawal and cold notification actions — separate scoped passes**

`BB/gator-v81-feature-replay-20261004/notif/grouped-result.json` records **two children/one summary → one child/one summary → zero records** across the two withdrawals. The surviving child and summary metadata remained unchanged after the first withdrawal. Ordinary process absence was observed before the first withdrawal, with no foreground launch during them. The closed grouped fixture result, `BB/gator-v81-feature-replay-20261004/notif/notification-result-e684195d-4e2e-4ba3-b17c-fa27fbfec098.json`, records no failure and private receipt removal. The final grouped status records four FCM submissions, no unauthorized requests and registration cleared; the operator recorded normal Disconnect to Get Started in capture 148, fixture exit 0 and removal of that episode’s reverse before reuse. This covers fixed synthetic encrypted FCM updates, not real recipients.

`BB/gator-v81-feature-replay-20261004/notif/actions-review.json` independently reviews the next episode:

- **Cold Mark as read:** process absence was recorded immediately before the action and a new process afterward. Native state changed from two children/one summary to one child/one summary, removing only A; B and the summary’s raw record blocks stayed unchanged. Capture 159 showed A’s unread badge absent while B retained one, before A was later opened. A remote read acknowledgement is not proved.
- **Cold inline reply failure retention:** a second observed ordinary-kill absence preceded one authored synthetic reply action on B. The recreated process retained the exact authored copy in B’s outgoing failed bubble. It showed Not Found / Not Delivered and the working **Message Not Delivered** menu with Try Again, Delete and Cancel. The deliberately unsupported fixture endpoint returns 404; no successful backend send, recipient delivery, retry success or independent wire-request count is claimed.

UIAutomator’s shade-idle failure and a tap on a non-button Not Delivered label were automation limitations; screenshots bound the eventual visible route and working menu. The fixture then supported the separate privacy/reminder continuation and was normally disconnected and closed at the 14:49 handoff recorded below.

**Separate development-emulator native evidence — all six lanes passed**

The private DEV aggregate (`BB/gator-v81-dev-native-20261004/aggregate-results.json`) records **158 true finite checks**:

| Native lane                                 | Passing checks               |
| ------------------------------------------- | ---------------------------- |
| Encrypted DB / SQLCipher contract           | 28                           |
| Relaunch recovery                           | 7 ready + 12 final + 3 host  |
| WAL write-process death                     | 9 ready + 12 final + 5 host  |
| Active migration-process death              | 11 ready + 15 final + 6 host |
| Runtime writer/rekey/upload concurrency     | 22 native + 3 host           |
| Encrypted backup/restore rollback and retry | 22 native + 3 host           |

This used the existing **debug APK 0.1.51 / code 1**, SHA-256 `e621c076e6d076294f1658a952ff283ea115c2b82770c68752f7ec607094f4ef`, with Metro from exact source 2c09378 on a fresh **API 37 arm64 emulator**, 2 cores and actual 4 GiB RAM. It is **LOCAL-DEV SUPPORTING ONLY**, not a claim that these development-only drivers ran inside Play v81 on the Samsung.

The emulator overrode requested 2 GiB to 4 GiB, stopping the first run after three valid passes. A fresh run then exposed a missing app-private `files/` prerequisite; creating only that directory through guarded `run-as` allowed the other lanes to pass. Interrupted/setup-failed attempts remain retained. All 1,155 audited device calls targeted emulator-5560; 32 host samples showed normal pressure and decreasing swap. Emulator/Metro/reverse/process-group cleanup and closed ports 8081/5560/5561 passed; source stayed unchanged and the physical Samsung/live Mac were untouched.

**App Lock privacy — scoped enable, cold arrival and post-unlock state**

`BB/gator-v81-feature-replay-20261004/notif/applock-first-review.json` independently recomputed active-list projections, channel names, process evidence and the exact-source generic presentation. Enabling App Lock changed **four active Gator notices to zero** and showed Unlock Gator in capture 173. The baseline contained two detailed children, a summary and an operator-classified send-failure notice.

The one synthetic private per-chat channel was renamed **on the same active local-ID channel** to the fixed generic name. Its old label was absent from the inspected current/stale-UID PackagePreferences, including deleted-channel entries. Restored-without-UID records and other OS-retained copies are excluded.

After ordinary kill and observed process absence, the sole arriving notice matched the fixed generic title/body, with no observed additional non-null presentation/messaging fields, unknown Android fields or action section. This is scoped native metadata evidence, not complete avatar/OS-history erasure, every privacy race, or encryption-key custody. The checker’s nine synthetic tests remain separate host evidence.

The final independent review (`BB/gator-v81-feature-replay-20261004/notif/applock-final-review.json`) confirms owner unlock reached the inbox in capture 175 and App Lock remained on in 176. The later saved notice still matched the fixed generic fields, but its native creation/update time, **14:38:35**, predates the unlock captures; this proves post-unlock generic state, not a newly posted sixth-push notice during grace. The first disable attempt left App Lock on in 177–178; only 179 verifies off. No toggle defect is attributed to the unsuccessful automation tap.

**Cold reminder — open, no defect attribution**

`BB/gator-v81-feature-replay-20261004/notif/reminder-cold-observation.json` records **19 samples over 185.938 s, 14:34:46–14:37:51 UTC**, with no reminder notice and no PID at any recorded sample. The retained Gator alarm was still inside Android’s inexact scheduling window; neither delivery nor a defect is established. Root cold-launched in 465 ms at 14:38 and observed the fingerprint prompt in capture 174. After owner unlock, the owned reminder row remained in 180; Delete left No reminders in 181. This proves row deletion, not alarm firing, tap/consumption or independently inspected native alarm cancellation.

**Post-reboot socket recovery and long-ID cache — scoped passes**

The peer's completed receipt, `BB/gator-prod-readiness-2026-10-03-ukr6o7x1/reboot-c220-amfi-on-4xwobshw/completion.json`, verifies the actual owner reboot, normal launch, authenticated helper and healthy readiness on `c220041d72710f6a8b4fcc4de97d026f557d63a6`, with AMFI on. Auto Start remained off, so automatic startup is not proved. This completed isolated check is separate from the peer's subsequent production cutover and remaining live Android/server acceptance.

After owner pattern unlock, fresh synthetic episode `KxCaOp` used unchanged Play v81 and the isolated server fixture at `c18076819b013c4fd22c51a6e131237b9f5fbc11`. `BB/gator-v81-feature-replay-20261004/socket-rcs/phone-auth-review.json` records two injected `AUTH_UNAVAILABLE` failures followed by recovery without an extra visible chat row. One `AUTH_REQUIRED` then held socket verification/admission/emission counters unchanged through **eight samples / 65.085 seconds**; HTTP pings continued. Restoring normal mode alone did not reconnect during the operator-recorded eight-second wait. One explicit Retry recovered, removed the banner and retained both image rows. Capture 195's XML and PNG straddle recovery; they do not prove a simultaneous banner or continuous absence of every transient false-success state. Exact retry timing and process-death retry remain outside this case.

`BB/gator-v81-feature-replay-20261004/socket-rcs/phone-cache-review.json` confirms separate labelled rows and viewer positions for source-bound **119- and 2,795-character attachment IDs**. A complete Download Integrity projection independently reproduced **73 fields, zero missing and zero issues**: two distinct local paths, two ledger/native files totaling **370 bytes**, settled DB/file agreement and zero active, temporary, reserved, retiring, missing, mismatched or untracked work/files. After ordinary kill with observed PID absence and the fixture reverse removed, both images reopened in offline viewers; media fetches and 200 responses remained at two. The full integrity scan preceded the kill. Both images contain identical bytes and were already loaded at baseline: no different-content assignment, clean-zero-cache first fetch or pulled private-cache hash is claimed.

The owned external album copy was separately identified by Android's collision name `media-synthetic (1).png`. Its recorded **185-byte, 32×32** content hash matched the fixture; only that exact MediaStore item was deleted, with subsequent exact-ID absence. The two earlier exact-name misses are explained by the collision suffix, not export failure. `BB/gator-v81-feature-replay-20261004/socket-rcs/owned-album-final-review.json` does not claim Gallery pixels, removal of other files or deletion of the private cache.

**Completed key rotation and local encrypted backup — scoped passes**

`BB/gator-v81-feature-replay-20261004/backup-prep/rekey-review.json` records visible **Database key rotated** success, followed by retained synthetic nickname, color, mute and unsent draft. After observed ordinary process death and the operator-reported 435 ms cold launch, the same tested local canaries remained and a local search found the known stored message (captures 220–232). This proves completed rotation and continued use, not interrupted-rekey recovery, ciphertext/key/WAL inspection, migration stress or complete search-index parity. Controlled message edit/delete updating search remains untested in this episode.

The local encrypted backup roundtrip used one owned **1,033-byte** Termux file. The correct-attempt selected BB2 body independently matched the recorded export hash. After changing compact-list mode and nickname/color/mute and clearing the draft, the actual wrong-passphrase submission showed the expected rejection; separately reopened screens retained the changed values. Correct restore reported **2 settings / 1 chat, zero skipped chats and all other categories zero**, and visibly restored the tested global setting and chat customization. The second reported setting was not independently varied. The draft remained empty, consistent with backup scope. Compact-list mode returned to baseline before the account-switch episode.

`BB/gator-v81-feature-replay-20261004/backup-prep/backup-roundtrip-review.json`, `file-cleanup.json` and `private-material-cleanup.json` in that directory record exact owned-file recheck/removal and removal of the now-unneeded local passphrase receipt. Only the actual rejection at 246d is credited; earlier offscreen-picker/navigation-bar taps are excluded. No raw backup body or passphrase is reproduced. This does not prove all categories, large/malformed/interrupted/cross-account restore, post-restore process death or Gator private temporary-file erasure.

**Normal account A-to-B separation — scoped pass**

`BB/gator-v81-feature-replay-20261004/socket-rcs/phone-account-isolation-review.json` records A's visible nickname/color/mute and draft before normal Disconnect/Get Started (255–257). Distinct synthetic B then showed its own conversation, no marker search result, an empty composer and default nickname/color/mute (258–261), with no deliberate backup import. The empty composer is the direct draft check; an unsent draft is not a searchable message.

Eight old-A fixture samples remained identical to the disconnected baseline while it was still open, ending at **35.090 seconds**. Its final result, `BB/gator-v81-feature-replay-20261004/socket-rcs/phone-app-fixture-result-2909dc53abf4218684b0a353.json`, records unchanged counters, closed state, private removal and no cleanup failure; the operator verified exit 0, private-directory absence and reverse 43125 removal. This is normal visible separation and bounded fixture quiet, not an injected late-result race, same-ID collision, complete account erasure or phone-wide network silence. B's later download episode has separate evidence and cleanup.

**Four finite download cases — scoped passes**

`BB/gator-v81-feature-replay-20261004/media/dl01-finite-review.json` reviews four cases in fresh HTTP-only fixture `ed845b47-8313-4de1-b818-6653709e9557`. Source generation and per-case request increments bind the cases; identical chat titles alone do not. Each completed integrity projection was independently reproduced with **73 fields, zero missing, zero issues and settled DB/file agreement**.

| Case                              | Observed result                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Advertised 85 bytes, supplied 68  | Rejected; no completed local path/cache file. An automatic first attempt already existed; the later manual attempt was a second rejection. |
| Missing Content-Length, clean EOF | Accepted the bounded body; one settled 68-byte cache file.                                                                                 |
| Finite chunked body               | Accepted; a second settled file brought the total to two files / 136 bytes.                                                                |
| Supplied PNG header 8,193×8,193   | Rejected without increasing the two-file / 136-byte cache; four attachment rows included the two rejected cases.                           |

All four settled reports had zero active transfers, owned destinations, temporary/reserved/retiring files, live ownership work, missing files, byte mismatches or untracked files. The accepted 1×1 PNGs showed loaded Photo state and cache completion, not recognizable photographic pixels. No exact native rejection code or pulled private-file hash was captured. These are app-produced diagnostic snapshots, independently parsed, not atomic captures or a second native implementation audit. The bounded album query returned no matching item and no deletion was performed; that is not positive Gallery-export proof or global export absence.

`BB/gator-v81-feature-replay-20261004/media/dl01-cleanup.json` records normal Disconnect/Get Started (277), fixture exit 0, closed state, no failure, private receipt removal, process absence, zero active download connections and owned reverse 43132 removal; no reverse mappings remained. The phone returned Home. This episode does not close all DL01 cases: unbounded streaming, cancellation, download process death, redirects, HTML and broader malformed/resource cases remain outside it. The fixture's unavailable realtime banner is not a production-server or media-transfer defect.

**Remaining acceptance and current limits**

These scoped v81 results supersede corresponding pending wording; historical v80 failures and the unexplained live-sync failure remain recorded.

- **Still open:** cold-reminder delivery/tap/consumption and independently timed fresh-post privacy during grace. The post-unlock observation above does not prove a new notice was repainted.
- **Remaining media/continuity cases:** PDF/video/export/share-discard cold continuity is prepared but unrun on v81. The four finite download cases above do not close the broader hostile-download matrix. Completed socket, cache, rekey, backup and ordinary account-switch cases retain their stated limits; controlled edit/delete updating local search remains open.
- **Background/native gaps:** the native 60-second deadline did not fire on the phone; an uncooperative old continuation was not retained across replacement. Screen-off/Doze and arbitrary scheduling/network conditions remain outside the observed background cases. Unit tests support narrower implementation properties.
- **Messaging/media limits:** no synthetic fixture successfully sent to a real recipient. Native ASCII/Unicode multipart names and exact uploaded bytes are proven, but canonical server echo after successful delivery remains separate. Real scheduled/inline delivery, recipient reading, provider transitions, blocked-body upload interruption and arbitrary media/handler behavior need their own evidence.
- **Privacy/account gaps:** denied-consent traffic/DB inspection, push enrollment/rotation/replay/downgrade/isolation/HTTPS, exception/log/network canaries, complete file/account erasure, and server-slot/interrupted/two-device restore.
- **Environment/release gaps:** eligible API 37 Play installation, prepared upgrades, required device/live/owner branches, raw dependencies, legal/provenance, support/contacts decisions and wider-release gates. DEV emulation is not production migration history. Optional/owner-dropped accessibility and tablet branches remain excluded.

**Earlier cleanup and current operating state**

`BB/gator-v81-feature-replay-20261004/reboot-handoff.json` records the **14:49** normal Disconnect/Get Started, App Lock off, owned reminder removed and zero active notices. Fixture `3afcd811-76d9-4882-9b32-e3bcd2ed71dd` and its private receipt/reverse were cleaned up. That handoff had font scale 0.8, stay-awake value 2 and timeout **600,000 ms**; DND was externally changed to 0 and was not overwritten. The subsequent peer receipt establishes the actual reboot separately.

`BB/gator-v81-feature-replay-20261004/post-reboot-wake.json` records restored wake helper **PID 3297** and heartbeat. Later, after USB-powered and effective stay-on were reported false, root temporarily extended `screen_off_timeout` to **86,400,000 ms**. Restore **600,000 ms** at final device cleanup; the early wake receipt does not record this later override. Root retains the phone lease/wake helper. At **16:13:35 UTC**, download cleanup was complete and phone UI work paused for peer/owner production RCS pairing. No actual production pairing is credited. The RCS/Mac peer separately owns production cutover and the live-testing hold. No task statuses or counts change.

The exact Play 81 candidate passes the finite cases reviewed above, including the post-reboot socket/cache, completed rekey, local backup, ordinary account-switch and four download episodes. The 177 native unit tests and 158 DEV finite checks remain separate supporting evidence. Further phone acceptance awaits the coordinated pairing window; broad release readiness and live Android/server acceptance are not established. This RN replay changed no application source and established no new app defect. Rejected fixture/setup attempts and unproved criteria remain explicit.
