# DEVICE-01 exact Play v79 device proof — 2026-09-29

> **Campaign status: IN PROGRESS; parent `DEVICE-01` remains BLOCKED.** This is the executable,
> sanitized evidence ledger for Android `0.1.58` / code `79`. It replaces neither the frozen v77
> release checklist nor the retired v56 device matrix. Record only results observed from this exact
> Play installation. Do not put credentials, server addresses, phone numbers, conversation
> identifiers, message bodies, private paths, or raw screenshots in Git.

**Latest privacy checkpoint:** The [finite Samsung/API-36 privacy matrix](#finite-api-36-privacy-matrix-completion)
is complete with OFF/OFF restoration. UISEC-01 remains open only for genuine physical Play/API-37
privacy proof. Earlier handoffs below describe their then-current evidence; they are not the latest
remaining-case list. The separate locked-push failure and wider DEVICE-01 blockers are unchanged.

## Candidate and device binding

| Field             | Bound value / result                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| App source        | `a0add484c00fdda06b7ee2c0a5bb5221d256d292` on local `master`                              |
| Release run       | `android-0.1.58-a0add48-20260929062534`                                                   |
| Release commit    | `4cbb05064ec9f891f00cb0a4f697435206f54fce`                                                |
| Artifact          | `gator-release-0.1.58-v79-4cbb050.aab`, 58,215,008 bytes                                  |
| Artifact SHA-256  | `c60cc661a318399afc5d30ed6d914303df41674cfafadfef9d835bfe3c442e19`                        |
| EAS submission    | `3138fc9b-c658-4fbc-b144-6a19f68a9e6e`; `FINISHED`; Internal / `COMPLETED`                |
| Installed package | `com.bluegreengatorapps.messages`, `0.1.58` / code `79`                                   |
| Install source    | Google Play (`com.android.vending`)                                                       |
| Device            | Samsung SM-S938U1; Android 16 / API 36; arm64-v8a                                         |
| Installed splits  | Base plus arm64, English, and xxhdpi configuration splits                                 |
| SDK/debug state   | min/target API 36; production package has no `DEBUGGABLE` flag                            |
| Mac server        | Gator `2.0.15`, source `75537204`; local health HTTP 200 after safe stale-helper recovery |

## Result ledger

| Campaign                                | Result           | Exact evidence / remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play delivery and package identity      | **PASS**         | Package Manager reports v79, Google Play installer, expected SDK/ABI/splits, and no debuggable flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Play delivery certificate               | **BLOCKED**      | One `apksigner` attempt pulled all four installed APKs but aborted with exit `134` before printing the certificate. Per owner instruction, the known Java-native failure was not troubleshot or retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Welcome-screen lifecycle smoke          | **PASS**         | 439 ms cold launch, 22 ms hot resume, ordinary `am kill`, 430 ms cold relaunch, replacement PID, and no scoped fatal exception were recorded when v79 arrived from Play.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Play v79 phone/portrait enforcement     | **PASS**         | Baseline `accelerometer_rotation=1` and `user_rotation=0`; after forcing `0/1`, MainActivity reported `SCREEN_ORIENTATION_PORTRAIT` and the display remained `ROTATION_0`; the baseline `1/0` settings were restored. This is system-state proof, not visual-render proof, because the device reached keyguard before capture.                                                                                                                                                                                                                                                                                                                                                     |
| Fresh setup navigation                  | **PARTIAL PASS** | The manual server form kept both fields and Connect reachable above the open keyboard; one root Back returned to the Connect choice screen. The already-authorized session resumed before camera denial/manual fallback could be isolated, so that branch remains open.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Mac server health prerequisite          | **PASS**         | Fresh helper socket, handshake, and ownership receipt were observed after a graceful restart; `GET /api/v1/health` returned HTTP 200. This proves readiness only, not authenticated pairing or an isolated staged-server matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Authenticated connection/core messaging | **PARTIAL PASS** | An existing scoped credential resumed automatically after Mac health recovery, completed the setup transition, began the historical sync, and opened Messages while optional permissions remained denied. After Home plus ordinary `am kill`, PID `12192` was absent; a 457 ms cold launch created PID `12860`, returned directly to Messages, and produced zero scoped fatal lines. Send/receive and mutation checks remain barred on the non-synthetic account.                                                                                                                                                                                                                  |
| Notification/push/headless/scheduling   | **PARTIAL PASS** | The app continued into Messages with notification permission denied. Its enable flow reached Android's prompt; denial produced the expected foreground-only guidance and recovery action. A reversible package grant established `POST_NOTIFICATIONS: granted=true` / default app-op `allow`, with unrelated runtime permissions still denied; `Notification Access…` opened Android's app-notification settings. The controlled foreground, alive-background, and ordinary-killed Firebase test-notification branches all passed; exact process and visible-notice evidence is recorded below. WorkManager, message-specific policy/actions, retries, and scheduling remain open. |
| Account A to Disconnect to B            | **NOT RUN**      | Requires two distinct isolated identities and controlled delayed operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| App Lock and private Recents            | **API-36 PASS**  | Independently reviewed finite Samsung matrix complete: all switch-pair screenshots/recording samples, warm/grace/delayed Recents, representative cold/recreation, and locked-modal removal; OFF/OFF and device baselines restored. Genuine physical Play/API 37 remains external. Scoped StopApp and sampled-frame limits apply; original both-on viewport lookup stays historically inconclusive. The separate locked-push failure is unchanged.                                                                                                                                                                                                                                  |
| Locked killed-Firebase admission/drain  | **FAIL**         | Firebase started a new process, but no generic notice appeared before unlock and no fixed test notice appeared after owner authentication within five minutes of the native receiver broadcast. The candidate source contains a locked-session authorization rejection on this path; details below.                                                                                                                                                                                                                                                                                                                                                                                |
| Genuine Play-installed API 37           | **EXTERNAL**     | No approved API-37 Play device is currently available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Independent second-device backup slots  | **EXTERNAL**     | The Pixel is owner-excluded; Samsung-only partial proof cannot close `BACKUP-SLOTS-01`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Controlled Firebase test-notification checkpoint

On 2026-09-29, the owner invoked the installed Mac Gator app's **Devices → Manage → Send Test
Notification** exactly once for each branch below. The owner refreshed/confirmed one row in the
**Android Devices** push table. A read-only server check independently found one eligible FCM target,
named `Gator (Android 36)`, bound to the Samsung's current scoped credential. The longer **Paired Client
Credentials** table is authorization history and does not expand notification fanout. No registration
or credential was removed, revoked, or created for this campaign.

The sole row's non-secret key-version marker was `1`, with no rotation metadata. In the installed
server source this marker is written by V3 enrollment only, so it supports the retained V3 enrollment
state. No secret, key, or sealed envelope was read; this metadata is not per-send decryption or
replay-rejection evidence.

| Branch                  | Result   | Observed physical-device evidence                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foreground              | **PASS** | A Firebase receiver broadcast was observed at 13:19:30 MDT after Gator had been brought to the foreground. Process `27746` was running, and Android displayed the fixed app-authored `Gator` / `Test notification received.` notice.                                                                                                                                                                                                                                     |
| Alive background        | **PASS** | The fixed first notice was dismissed and confirmed absent. Home remained the resumed activity, process `27746` remained running, a new Firebase receiver broadcast arrived at 13:22:29 MDT, and the fixed test notice appeared again.                                                                                                                                                                                                                                    |
| Ordinary killed process | **PASS** | The fixed second notice was dismissed and confirmed absent. Home plus ordinary `am kill --user 0` removed process `27746`; `pidof` confirmed no Gator process before the send. At 13:24:48 MDT Android started process `29477` specifically for the Firebase receiver broadcast. Home stayed resumed and the fixed test notice appeared without opening Gator. No `ReactNativeFirebaseMessagingHeadlessTask` registration warning was observed. Force-stop was not used. |

These results prove exact-Play-v79 Firebase receipt and test-notice presentation across the three
lifecycle branches. They advance `DEVICE-01`, `REL-001`, `PUSH-RETRY-01`, and the retained-delivery
slice of `PUSH-CRYPTO-01E`; none of those tasks is closed by this checkpoint. The test notice is
app-authored and exercises no contact message, conversation mutation, message-specific notification
action, scheduled send, retry fault, replay, key rotation, or account replacement. Mac result-counter
toasts were not captured, so no `{configured,total,sent,failed}` values are inferred.

Baseline Do Not Disturb was priority mode (`zen_mode=1`), app standby bucket was active (`10`), and
the app was not device-idle-whitelisted. Do Not Disturb was temporarily disabled for these sends and
restored to `1` afterward. Only the located fixed test notices were dismissed. Temporary device UI
dumps were deleted, the bounded two-minute keep-awake helper was stopped, and Gator was successfully
foregrounded again. No scoped Android fatal line was observed in the killed-branch trace.

## Locked killed-Firebase checkpoint

The owner then completed one additional Samsung-only test on the same exact Play-v79 package.
App Lock and Secure Screen were initially off. Enabling App Lock produced Android's `Unlock Gator`
prompt. After Home, the first immediate `am kill` left process `29477` alive; a second attempt after
confirming Home was resumed removed it. `pidof` confirmed no Gator process and Android had no Gator
notification before the owner invoked the trusted Mac test control once. Force-stop was not used.

At 13:43:38 MDT, Android started process `32036` for the Firebase receiver and logged receipt.
Home remained resumed. At 13:43:59 and one follow-up, there was no Gator notification record;
`You have new messages` and `Test notification received.` were both absent. Foregrounding Gator
produced `Unlock Gator`. After owner authentication, at 13:47:10 the app displayed Messages in the
same process, but there was still no Gator notification record or fixed test notice. This was within
five minutes of receipt. No package-scoped Android fatal or missing-headless-task warning was
observed. This is a **failed locked admission/notice/drain branch**, not a partial pass for it.

**Source diagnosis:** `persistAuthenticatedLockedFcmV3Event` calls
`resolveAuthorizedRealtimeTransport`. In a fresh process the resolver calls
`inspectBackgroundSession`, which returns `kind: 'locked'` when persisted App Lock is enabled.
The resolver accepts only `kind: 'ready'`. Any fresh-process locked V3 delivery that reaches this
helper receives no transport and returns `not-enqueued`, preventing both the generic notice and
later drain. The affected files are unchanged
between candidate source `a0add484` and the audited local master. Independent source review confirms
this contradiction. It is a definite source defect matching the result; native receiver receipt
alone does not prove this specific envelope completed V3 authentication or reached that line.
The finite in-app JS receipt was not captured, and release logcat intentionally omits the detailed
warning diagnostics, so those missing observations are not treated as evidence of callback failure.

`PUSH-CRYPTO-01E`, `NOTIF-02`, `REL-007`, and `DEVICE-01` remain open for this failed branch. The
three unlocked delivery passes above remain valid. No code fix or replacement candidate is claimed
by this device checkpoint; the later host correction below does not change the installed v79 result.
App Lock and Secure Screen were verified off afterward; Do Not Disturb was restored to `zen_mode=1`.
Temporary device UI dumps were removed. The test procedure did not intentionally send a contact
message or create, change, or remove credentials, accounts, or user content.

## Post-v79 host correction — replacement build deferred

**2026-09-29: HOST FIX AND REQUIRED HOST GATES COMPLETE / NEW BUILD AND DEVICE PROOF DEFERRED.**
The validated durable session tuple is now available to a dedicated locked-V3 transport resolver.
Only `persistAuthenticatedLockedFcmV3Event` uses this resolver. Ordinary background work still
requires `ready` and exits before client creation or DB access when the session is `locked`.
The narrow path retains account generation, transport revision, durable revocation, transport
currentness, and the caller's lock/deadline ownership. It does not hydrate foreground credentials,
unlock the app, drain while locked, or post a notice before durable admission.

The new six-case regression uses the real session inspection, transport resolution, and admission
composition from cold store defaults, mocking native/database leaves. Its positive case failed
before the fix (`enqueued` expected; `not-enqueued` received), then passed with the correction.
Negative cases reject an already-revoked account or generation, transport-revision, revocation,
and lock-owner changes during DB open. The focused gate passed **5 suites / 119 tests**; TypeScript,
focused ESLint, and source formatting passed. Independent review found no blocking issue. The DB
proof's two exact incoming-ingress fingerprints and the scheduled-recovery inspector fingerprint
were renewed after review, without widening eligibility or changing the write inventory.

Full Jest passed **529 suites / 6,407 tests**, with two intentional skipped suites/tests;
architecture/recovery passed **51 tests**, migrations **5 tests**, and documentation **5 tests**.
The 2,187-write guard and zero-drift reconciliation passed; the required full adversarial DB gate
passed **115/115 tests**, with zero failures, cancellations, or skips. Source/test ESLint has no
errors; linting the renewed guard scripts retained one unchanged unused-helper warning in
`check-scheduled-recovery.mjs`. These are not evidence of native delivery or SQLCipher. Final host suites used the
installed compatible Node `24.21.0`, not the machine-default Node `26.10.0`:
the existing host SQLite test module requires Node ABI `137`, while Node 26 requires `147`.
The incompatible run was stopped; no dependency rebuild or system-wide runtime change was made.
This is not an exact release-toolchain certificate (the build tooling pins Node `24.19.0` / npm
`11.17.0`).

At the owner's direction, **do not build or upload yet**. After an approved replacement build is
installed, repeat only the failed Samsung branch first: enable App Lock; Home plus ordinary
`am kill` and confirm no process or prior fixed test notice; send the trusted built-in Samsung test
once; verify a generic notice without opening Gator; authenticate within the event lifetime and
verify the fixed test notice drains once. Restore App Lock/Secure Screen/DND to their prior states.
Record the replacement candidate identity and actual observations, including failure if any.
`PUSH-CRYPTO-01E`, `NOTIF-02`, `REL-007`, and `DEVICE-01` remain open. No build, upload, installation,
AMFI change, or device retest is part of this host correction.

## Warm App Lock Recents continuation

**2026-09-29: INSIDE-GRACE AND CONTROLLED DELAYED SETTINGS/RECENTS SLICES PASS; THAT WARM BATCH'S OFF/OFF RESTORATION VERIFIED.**
This continuation used the same installed Play-v79 Samsung/API-36 candidate. No replacement build,
upload, installation, OTA, or AMFI change was performed. Baseline App Lock and Secure Screen were
both off. Only neutral Settings controls and the cropped Gator app-switcher card were intended
capture targets; another app's preview is not evidence.

| Observation                                | Result           | Exact boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OFF/OFF control                            | **PASS**         | Foreground Settings and its Recents preview were readable. The selected 840 × 1,500-pixel task-preview interior contained 8,749 distinct RGB colors.                                                                                                                                                                                                                                                                                                                           |
| App Lock ON / Secure Screen OFF foreground | **PASS**         | Both switch values were observed, and a foreground Settings capture remained readable; App Lock alone did not apply blanket screenshot blocking on this API-36 lane.                                                                                                                                                                                                                                                                                                           |
| Warm inside-grace Recents preview          | **PASS**         | Home was confirmed resumed by 107 ms after the departure command. The Gator card was cropped by 4,183 ms; its identical 1,260,000-pixel interior had one RGB value, `37,37,37`, with no Settings text. The Gator icon and card outline remained visible. Independent inspection agreed with this control-to-blank comparison.                                                                                                                                                  |
| Warm inside-grace return                   | **PASS**         | Gator was confirmed resumed by 5,092 ms after departure, below the 30,000-ms grace threshold. PID `14885` was unchanged, Settings remained in the inspected tree, and no `Unlock Gator` prompt was present. This proves the observed return, not every transient frame or timing combination.                                                                                                                                                                                  |
| First delayed attempt (historical)         | **INCONCLUSIVE** | A fresh Home departure was confirmed, followed by an enforced 35,000-ms wait. The first Recents inspection stopped with `No unambiguous Gator Recents card`. A later read found the card, but the continuation guard then stopped with `Expected existing Recents interval` because the screen had changed. `Unlock Gator` was subsequently observed in the same PID, but no controlled delayed card capture/return was completed; the prompt alone did not close this branch. |
| First OFF/OFF restoration (historical)     | **PASS**         | After exclusive-use confirmation and owner authentication, Settings was inspected, App Lock was switched off, and both native switch values reported checked=false at 16:14:14 and again at 16:17:00 MDT. Secure Screen remained off. No visual-capture confirmation is claimed.                                                                                                                                                                                               |
| Controlled delayed Recents preview         | **PASS**         | A new exclusive-use continuation confirmed Settings, App Lock on / Secure Screen off, and PID `22431` / task `20836`. Home was confirmed by 95 ms; an enforced 35,009-ms wait preceded Recents. The existing Gator card was captured 106,657 ms after Home confirmation, without launching Gator during that interval. Its 840 × 1,500-pixel interior had only RGB `37,37,37`; independent visual review confirmed the Gator icon/outline and blank preview.                   |
| Controlled delayed return                  | **PASS**         | Selecting that existing Recents card produced `Unlock Gator` and the biometric surface, with protected Settings controls absent. Observation was 152,255 ms after Home confirmation, with unchanged PID `22431` and task `20836`. This is a delayed ≥35-second warm branch, not an exact 35-second endpoint or proof of every transient frame.                                                                                                                                 |
| Final OFF/OFF restoration                  | **PASS**         | After owner authentication, the actual Settings header matched the readable baseline. App Lock was switched off; both native controls read checked=false at 18:08:19 MDT and again after reopening Settings at 18:08:22, without an unlock prompt. The post-restoration header also exactly matched the baseline. PID `22431` and Play `0.1.58` / code `79` were unchanged. Secure Screen stayed off; USB/wake `2` and timeout `600000` ms were untouched.                     |

After the first inconclusive attempt, Android UI inspection returned `Killed`. The system USB/wake setting also changed from
`stay_on_while_plugged_in=2` to `15` despite this session issuing no setting write; the screen/wake
changes suggest possible outside interaction, not a proven App Lock defect. Phone control was stopped
to avoid overlap, and exclusive-use confirmation was requested. Do not overwrite another operator's
wake setting. The original screen timeout was still `600000` ms. Only this session's bounded
keep-awake helper was stopped; no other session or helper was stopped. The accidental temporary
capture from the unexpected route was removed immediately and is not evidence or a retained artifact.
That attempt's neutral temporary captures were also removed after review; only its sanitized observations remain.

**Restoration continuation (16:14–16:17 MDT):** The owner confirmed exclusive Samsung use and
authenticated at Gator's prompt. Settings initially reported App Lock on / Secure Screen off.
App Lock was switched off, and reopening Settings produced `checked=false` for both controls,
without an authentication prompt. A later targeted Settings reopening independently reported the
same two false values. The installed package remained `0.1.58` / code `79`. An intervening capture
showed a different route, so it was deleted and is not visual confirmation; an attempted gear-button
recheck also did not reach Settings and is not credited. The restored state is supported by the two
native UI switch readings, not by those observations. The initial restoration attempt remains
uncredited: its pre-tap Settings image showed App Lock on / Secure Screen off, and its post-tap
observation showed a chat; the transition timing and tap target/effect were unverified.
No delayed test was repeated during that restoration, and the unrelated USB/wake value `15` and
`600000`-ms timeout were left unchanged.

**Controlled delayed continuation (16:46–16:48 MDT):** After owner authentication, one intended Settings
navigation was followed by two header-only PNG captures. Their decoded pixels exactly matched each
other and the previously readable Settings header; native inspections bound the same Activity,
window, task, process, and on/off controls. Some image-viewer presentations disagreed despite identical
local pixels, so those presentations are not evidence of app navigation. An initial preflight guard
read a Window-report variant that omitted its focus field; the full report confirmed Gator focus
before departure. Neither tooling issue required an app code change.

The single Home interval then enforced a 35,009-ms wait. The initial Recents capture stopped with
`Capture failed`: the command's default 1-MiB output buffer was insufficient for the 3,141,828-byte
PNG successfully captured with a larger allowance. Gator stayed in that same Recents interval; no
new activity, deep link, process kill, or second timed run was used. The corrected capture and return
therefore occurred at 106.657 and 152.255 seconds after Home confirmation, respectively. Only the
Gator card at bounds `[265,427,1174,2305]` was retained temporarily, with dimensions 909 × 1,878;
its selected 1,260,000-pixel interior was uniformly gray. This proves the observed delayed branch,
not an exact 35-second return or the broader privacy matrix. The owner later completed Gator's own
authentication; final restoration at 18:08 MDT confirmed both controls off before and after reopening
Settings, with the actual header matching the neutral baseline. The current USB/wake value `2` and
`600000`-ms timeout were not changed by this session.

**Historical handoff (18:08 MDT):** App Lock off / Secure Screen off was restored and verified. The bounded warm inside-grace
and delayed branches passed at that checkpoint; cold/recreation/modal
combinations, broader timing, and genuine Play/API-37 evidence remained open. `UISEC-01` stayed
**IN_PROGRESS**, `DEVICE-01` stayed **BLOCKED**, and the failed locked-push branch still awaited the
deferred replacement build. All eight temporary neutral PNG captures and their task-specific directory
were deleted after review; only these sanitized observations remain. This session's bounded wake-only
helper was stopped; no other session/helper was disturbed. This continuation made no source edits or
Android system-setting changes; only the intended app privacy switches were toggled.

## API-36 popup, configuration recreation, and cold-start continuation

**2026-09-29: BOUNDED NATIVE PRIVACY SLICES PASS; ORIGINAL BOTH-ON SETTINGS VIEWPORT INCONCLUSIVE; FINAL OFF/OFF RESTORATION VERIFIED.**
This later continuation used the same Play-installed v79 Samsung/API-36 candidate, starting with
both privacy switches off. No build, upload, installation, OTA, AMFI change, source edit, credential
change, or message/account mutation occurred. The owner authenticated at Gator's own prompt when
App Lock was enabled; the agent did not bypass authentication.

### Neutral React Native Modal

The existing **Share error reports?** consent popup provided a neutral, separate Android
`APPLICATION` window. **Allow was never selected**: Android Back selected the popup's cancellation
path, and error-report consent remained off after every dismissal.

| App Lock | Secure Screen | Popup screenshot                     | Main and popup native windows |
| -------- | ------------- | ------------------------------------ | ----------------------------- |
| Off      | Off           | Readable; 679 distinct RGB colors    | Both `FLAG_SECURE` off        |
| Off      | On            | Uniform black; one RGB value `0,0,0` | Both `FLAG_SECURE` on         |
| On       | Off           | Readable; 679 distinct RGB colors    | Both `FLAG_SECURE` off        |
| On       | On            | Uniform black; one RGB value `0,0,0` | Both `FLAG_SECURE` on         |

Each screenshot retained only the neutral 780 × 660-pixel popup region. A two-second streamed
recording with App Lock off / Secure Screen on yielded **one decoded static frame**, uniformly
black; only that observed frame is credited, not continuous coverage of every recording frame.
No full-screen PNG or raw video was saved.

With App Lock on / Secure Screen off and the popup open, the Gator Recents card's selected
840 × 1,500-pixel interior was uniformly `37,37,37`. Return was observed at 8,196 ms, inside the
30-second grace period, with unchanged process `22431` / task `20836`, no new authentication,
and the same popup restored. This confirms independent Recents protection, not all modal timings.

### Actual configuration-driven Activity recreation

Both switches were on and the popup was dismissed. The **installed** Activity's configuration
mask `0x80000fb3` does not handle the `FONT_SCALE` bit. Temporarily changing the system font scale
from its observed baseline **0.8 to 0.85** caused an Android
`wm_relaunch_resume_activity` event with configuration bit `0x40000000`; restoring **0.8** in
`finally` caused a second such event. The non-baseline setting lasted about five seconds.
This uses an actual unhandled configuration change, not merely an Activity resume.
[Android configuration-change behavior](https://developer.android.com/guide/topics/manifest/activity-element#config)

| Observation                | Native privacy result                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Font scale 0.85            | Same process/task and Activity token; main Window changed `dfcfe27 → f8e27f5`, `FLAG_SECURE` on; header capture uniform black |
| Font scale restored to 0.8 | Main Window changed again `f8e27f5 → 9d3e050`, `FLAG_SECURE` on; header capture uniform black                                 |
| Post-recreation Recents    | Selected 1,260,000-pixel interior uniformly `37,37,37`; same process; warm return observed at 8,192 ms                        |

**Original both-on Settings control lookup (historical): INCONCLUSIVE.** A subsequent cold-test preflight stopped with
`Both-ON preferences not visible before cold start`. One intended Settings navigation then stopped
with `Both-ON state not confirmed after one intended Settings navigation`; one fresh Settings-button
tap also did not locate search/switch controls in the inspected viewport. Inspection included inactive route titles,
so a title alone is not proof of a visible Settings screen. No further navigation variants or font
recreation repeats were attempted. The native privacy observations above remain valid, but they do
not prove navigation recovery, saved-state restoration, or every transient private frame. The later
controlled OFF/OFF follow-up below resolves its own missing-control observation as offscreen content;
the original both-on viewport was not directly resolved and is not retrospectively credited.

### Both-on scoped cold start

Home followed by ordinary `am kill` did **not** end process `22431` in this continuation. The guard
stopped with `Old process remains; not a cold launch`; that attempt receives no cold-start credit.

The scoped Android Task Manager-style command `cmd activity stop-app --user current` was then
used only for Gator. The old PID was confirmed absent before relaunch. Android documents that this
method removes the Activity back stack while leaving scheduled jobs/alarms scheduled; no app data
clear or force-stop was used. Therefore this is **not** ordinary-kill, natural-process-death,
or saved-task-restoration evidence.
[Android stop-app behavior](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)

Relaunch reported **COLD / 446 ms** and a distinct process **7416**. `Unlock Gator` appeared,
protected Settings controls were absent, and the new main Window `12b739` was observed with
`FLAG_SECURE` on; the header screenshot was uniformly black. Its Gator Recents card again had
one `37,37,37` value throughout the selected 1,260,000-pixel interior. Returning showed
`Gator is locked`, with protected controls absent and the same new process.

### Historical handoff at 18:54 MDT and then-open evidence

**Final OFF/OFF restoration is verified.** After the owner completed Gator's normal authentication,
usable Settings search and both on/on controls were observed in the cold process. Secure Screen was
switched off, restoring a readable header with pixels identical to the known Settings baseline.
App Lock was then switched off. Both controls read false at **18:53:32 MDT**, again after intended
Settings reopening at **18:54:08**, and in the final inspection at **18:54:18**, without an unlock
prompt. The reopened header also exactly matched the baseline's decoded pixels and 209 RGB colors.
The image viewer presented one matching header as blank; that inconsistent presentation is not
navigation evidence. Usable Settings after this cold launch does **not** close the earlier
configuration-recreation recovery question.

Process `7416`, task `20838`, main Window `12b739`, and Play `0.1.58` / code `79` were unchanged
during restoration; the Window's `FLAG_SECURE` was off. Error-report consent remained off.
Font scale is restored to **0.8**; USB/wake `2` and screen timeout `600000` ms were unchanged.

At this checkpoint an independent native reviewer accepted the bounded capture observations, but
not full recreation functionality. Genuine Play/API-37 evidence and remaining cold/recreation/modal
combinations remained open; earliest/transient recording frames were not claimed. `UISEC-01` stayed
**IN_PROGRESS**, `DEVICE-01` stayed **BLOCKED**, and the locked-push failure still awaited the
deferred replacement build. This continuation's own bounded wake-only helper has been stopped;
no other helper/session was stopped. All thirteen temporary neutral PNG crops and their task-specific
directory were deleted after independent review; only these sanitized observations remain.
No raw capture is a Git artifact.

## Settings recovery investigation

**2026-09-29: CONTROLLED OFF/OFF VIEWPORT AND SEARCH RECOVERY PASS; NO APP DEFECT ESTABLISHED.**
One controlled follow-up started from usable Settings with App Lock off / Secure Screen off and
font scale 0.8. The same brief 0.8 → 0.85 → 0.8 change caused two actual font-bit Activity relaunches.
Process `7416` and task `20838` survived; main Window `12b739 → 9ef4f39 → 365e759` remained
nonsecure. Font scale was restored in `finally`, about three seconds after changing it.

The expected search/privacy controls were absent from the inspected viewport again, **but this is
not evidence of a blank or unusable Settings route**. A fresh, foreground-bound native inspection
found the Settings title, an enabled scrollable `ScrollView` at `[0,257][1440,3120]`, and six
visible switches. A memory-only content sample had 511 distinct RGB values; no screenshot or XML
was saved. Scoped fatal, non-top/last-pop, fragment-restoration, and React soft-exception marker
counts were all zero. Source review confirms Settings places search inside its ScrollView and starts
with an empty section filter; native scroll layout can preserve an existing offset. Independent review
therefore favors a viewport expectation error over the earlier navigation-failure hypothesis.
It does not establish the original both-on viewport's exact position.

A bounded scroll-to-top check stopped **before any app gesture** because the system lock screen
had appeared. One scoped status-bar collapse did not remove it; Android then confirmed system
keyguard `showing=true` / timeout lock. Android reported AC power (`mPlugType=1`) while the
unchanged stay-awake setting `2` covers USB, and `mStayOn=false`; wake-only key events did not
prevent this timeout. This is Samsung system authentication, not Gator App Lock.

**Completed after owner system unlock (19:21–19:24 MDT):** Foreground Settings still had the same
process `7416`, task `20838`, Activity token `47659124`, and Window `365e759` from the OFF/OFF
recreation. Before the gesture, search/privacy controls were absent from the inspected viewport.
**One swipe toward the top**, measured from the current ScrollView bounds, exposed the search and
both privacy controls at 19:21:32. Both switches read false. No route launch, deep link, process stop,
new font pulse, or privacy toggle occurred.

Typing the neutral query `secure` filtered the section and showed both false-valued privacy controls
at 19:22:50, proving usable search on that same recreated screen. The query was then cleared.
An initial cleanup guard stopped with `Settings query was not cleared` because Android reported the
empty field's **Search settings** placeholder as its text. A fresh inspection confirmed that placeholder
and the reappeared THEME section, not leftover query text; no further clearing or app fix was needed.
Final handoff at **19:24:58** confirmed unfiltered Settings, both switches off, no unlock prompt,
font scale **0.8**, unchanged USB/wake `2` / timeout `600000` ms, and Play `0.1.58` / code `79`.
The same Window remained nonsecure.

**Conclusion:** This controlled OFF/OFF missing-control observation was an offscreen/viewport
inspection issue, not broken Settings navigation. No app source correction is warranted.
It does not establish the earlier both-on viewport's exact cause or close every recreation/privacy
combination. At that checkpoint `UISEC-01` remained **IN_PROGRESS** for its remaining physical matrix
and API-37 lane; the separate failed locked-push branch still awaited the deferred replacement build.
Only this follow-up's own wake helper was stopped; no other session/helper was touched.
No new screenshot/XML was saved, and no build, upload, or app-code edit occurred.

## Finite API-36 privacy matrix completion

**2026-09-29: ALL SEVEN REMAINING REPRESENTATIVE SAMSUNG CHECK GROUPS PASS.**
The independently reviewed finite matrix uses App Lock / Secure Screen ordering below. It extends the
earlier v79 screenshot, warm-grace, both-on cold/recreation, and OFF/OFF recovery evidence; it does not
repeat a timing × setting × window Cartesian product. The candidate remains the same genuine
Play-installed `0.1.58` / code `79` Samsung/API-36 package.

| Remaining group             | Observed result                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recording OFF/OFF           | Two decoded neutral-popup frames, 2,324–2,374 RGB colors; main and popup Windows nonsecure.                                                                                                                                                                                                                                                       |
| Cold OFF/ON + Recents       | Scoped StopApp removed PID `7416`; **COLD / 392 ms**, new PID `14203`, task `20839`, Window `ae4dabb` secure. Both switches persisted; no App Lock prompt. Header black, Recents interior uniform gray, return without authentication.                                                                                                            |
| Recording ON/ON             | One decoded black frame `0,0,0`; main and popup Windows secure.                                                                                                                                                                                                                                                                                   |
| Recording ON/OFF            | One decoded neutral-popup frame, 2,324 RGB colors; main and popup Windows nonsecure.                                                                                                                                                                                                                                                              |
| Recreation ON/OFF + Recents | One font pulse `0.8 → 0.85 → 0.8`; two actual font-bit relaunches, same PID `14203` / task `20839` / Activity token `215295069`. Final Window `ae4dabb → 16c13e6` nonsecure, usable Settings/search and on/off controls. Header crops detailed (414 / 404 RGB colors); blank Recents, same-process return at **5,086 ms**, no new authentication. |
| Delayed open popup ON/OFF   | Enforced Home wait **35,207 ms**, return **39,230 ms**. Same process/task; lock gate shown, protected Settings controls and popup absent, no visible/on-screen popup APPLICATION Window; Recents blank.                                                                                                                                           |
| Cold ON/OFF + Recents       | Scoped StopApp removed PID `14203`; **COLD / 375 ms**, new PID `16924`, task `20840`, Window `f7fae91` nonsecure. Authentication gate and no protected controls; after cancelling only the biometric prompt, the generic **Gator is locked** title was capturable (225 RGB colors). Recents blank; return stayed gated in the same process.       |

Each blank Recents result bound the unique Gator task card at `[265,427][1174,2305]` and decoded
its selected 840 × 1,500-pixel interior: all 1,260,000 pixels had RGB `37,37,37`. Popup recordings
requested two seconds and decoded only the cropped neutral region; the table credits the observed
frames, not continuous/all-frame coverage or an independent recording text-legibility assessment.
Allow was never selected, and cancelled popup checks left diagnostic consent off.

**Instrumentation corrections, not app fixes:** The recreation guard initially expected decimal
`1073741824`, while Android's scoped relaunch events at **19:45:34.938 / 19:45:38.816 MDT**
reported hexadecimal `40000000`. Correlating those original events confirmed the actual font
recreations without another pulse. The font was restored in `finally` after 3,990 ms. The first
0.85-stage Window metadata was not emitted before the guard stopped; only the final restored
replacement Window's native flags are credited. The two original bound header crops were retained,
and the restored **Settings** title was visually checked.

An initial cold Recents inspection returned `UI inspection Killed`. A fresh read succeeded but
found Gator foregrounded, not Recents. One new, verified Home → Recents navigation then bound the
actual Gator card and passed; neither cold launch nor font recreation was repeated. These tool
failures are not evidence of an app crash or an app correction.

**Evidence limits:** Scoped StopApp removes the Activity back stack; these cold rows are not
ordinary-kill, natural-death, or saved-task-restoration proof. The original both-on Settings viewport
lookup remains historically inconclusive, not retrospectively credited or a proven app defect.
Source review plus the finite representative rows satisfy the Samsung/API-36 policy lane; no
additional OFF/ON font recreation or exhaustive cross-product repetition is required.

**Final handoff (19:56 MDT): OFF/OFF restored after normal owner authentication.** Both privacy
controls read false at 19:56:00 and again in unfiltered Settings at 19:56:11. Diagnostic consent was
off, the search was cleared (its placeholder was correctly recognized), and no lock gate remained.
PID `16924`, task `20840`, Activity token `208280671`, and nonsecure Window `f7fae91` were
unchanged; the neutral Settings header was detailed (209 RGB colors). Font scale **0.8**, wake setting
**2**, and timeout **600000 ms** match the original baseline. Package identity and the production
package's Google Play installer were rechecked. Only this session's bounded wake helper was stopped.
All nine temporary neutral PNG crops and their task-specific directory were deleted after review;
no full-screen PNG, XML, or raw video was saved in this continuation. No source edit, test writing,
build, upload, installation, OTA, credential change, or message/account mutation occurred.

An independent native reviewer accepted all seven groups and the final handoff. `UISEC-01` remains
**IN_PROGRESS solely for genuine physical Play/API-37 privacy evidence**; no approved device is
available, and the excluded Pixel was not used. `DEVICE-01` remains **BLOCKED** for its wider
campaign prerequisites. The separate installed-v79 locked-push failure is unchanged and awaits the
deferred replacement build; these privacy results do not validate that newer source correction.

<a id="notif-01-play-v79"></a>

## NOTIF-01 — isolated Play-v79 active-chat notification matrix

**2026-09-30, approximately 17:08–17:12 MDT: SIX OF SIX PASS.** This closes only
[`NOTIF-01`](./WORK_PLAN_2026-08-03.md#x-notif-01--suppress-notifications-for-the-active-chat).
The Samsung/API-36 used the genuine already-installed Play `0.1.58` / code `79` APK through
`pm install-existing --user 10`; there was no build or primary-profile reinstall. The owner approved
the synthetic fixture extension and a temporary managed profile with cleanup. User 0's real account,
credential, messages, and app process were not reset, re-paired, or killed.

The opt-in `notif01` mode in `scripts/dl01-hostile-fixture.mjs` serves two fixed `.invalid` chats,
distinct handles, two outgoing bootstrap seeds, and exactly six fresh text-only incoming messages.
An ephemeral scoped credential enrolls only the test-profile FCM token/key in memory. Each check uses
real Google Firebase HTTP-v1 delivery with the existing identity-bound encrypted V3 frame, not the
Mac built-in test notification. The fixture is loopback-only through one owned USB reverse mapping;
it neither reads the Mac Messages database nor sends to real recipients. Its app API exposes only
synthetic reads, enrollment, and self-revocation; download scenarios and recipient-send routes are
unavailable. App Lock and Secure Screen were visibly off; notification permission was granted only
in the temporary profile, Contacts remained unrequested, and DND was temporarily off.

| Check | App state                          | Incoming chat | Actual device observation                                                                                                                        |
| ----- | ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Foreground viewing A               | A             | Fresh `Notification check 1` appeared in A without navigation; no user-10 Gator native notification.                                             |
| 2     | Foreground viewing A               | B             | Native B message notice contained fresh check 2, importance HIGH (4); opening B showed it and cleared that notice.                               |
| 3     | Home, last viewed A, process alive | A             | Fresh check 3 in native A notice, importance HIGH; PID `29077` remained alive and Gator was not foreground.                                      |
| 4     | Home, last viewed A, process alive | B             | Fresh check 4 in native B notice, importance HIGH; same PID `29077`, still not foreground.                                                       |
| 5     | Ordinary killed process            | A             | `am kill --user 10` left no test PID before delivery. Fresh check 5 appeared in native A notice before any UI launch; headless wake PID `32693`. |
| 6     | Separate ordinary killed process   | B             | A second scoped ordinary kill again left no test PID. Fresh check 6 appeared in native B notice before UI launch; new headless wake PID `348`.   |

All six sends were accepted and all six rows have actual receipt evidence; absence of a notification
was not credited without the fresh UI message. After the last headless delivery, a normal test-profile
launch showed both chats with latest checks 5/6 and two unread messages each. Native records were
filtered to user 10 and the exact Gator package before reporting; no real message payload or private
notification dump was saved. The fixture reported **6 incoming / 6 successful FCM sends / 0 downloads /
0 unauthorized requests / delivery not halted**.

**Candidate binding and verification:** `git diff --exit-code` against the v79 source
`a0add484c00fdda06b7ee2c0a5bb5221d256d292` was empty for the active-chat owner, notification
dispatcher/history, chat read-lifecycle hook, session-scoped reset, and chat route. The focused fixture
Node suite passed **20 tests / 0 failed / 0 skipped**; this includes unchanged DL-01/FEAT-07 modes,
two-chat pagination/cursors, six distinct decrypted payloads matching canonical history, authentication,
the send bound, overlapping-send rejection, uncertain-delivery stop, and no dispatch after revocation
during OAuth. An independent reviewer accepted the final enrollment snapshot/recheck and finite device
matrix. Scoped lint declared Node's existing `Buffer` global and passed with **0 errors / 0 warnings**;
both script files were formatted. No production app code or native build configuration was changed.

**Verified cleanup:** the synthetic scoped credential was revoked, then only the owned profile
`10 / GatorNotif01Test-20260930` was removed (`Success: removed user`), discarding its synthetic
database and temporary credentials. The fixture exited successfully, the owned `tcp:43117` reverse
was removed, and the bounded wake helper stopped (exit 130 after SIGINT). User 0 and its production
package remained installed at `0.1.58` / `79`. DND returned to **1**, stay-awake to **2**, and screen
timeout to **600000 ms**, matching the pre-test baseline. No test profile or reverse mapping remained.

**Limits:** this is notification suppression/delivery proof, not an audible sound or independently
observed vibration assessment. The fixture intentionally lacks a realtime socket, so its temporary
reconnecting/connection-problem banner is expected; it is not live-server connectivity proof.
`NOTIF-02`'s installed-v79 locked-push failure still needs its deferred replacement build. `NOTIF-03`
history/concurrent withdrawal, `FEAT-05B` grouping, wider `DEVICE-01`, and physical API-37 proof are not
closed by this finite matrix. The Pixel was not used.

<a id="notif-03-play-v79"></a>

## NOTIF-03 — isolated Play-v79 bounded notification history

**2026-09-30, approximately 17:47–17:54 MDT: DEVICE MATRIX PASS.** The genuine installed Samsung/API-36
Play `0.1.58` / code `79` ran the fixed `notif03` fixture in temporary managed user **12**. No Gator
build, primary-profile reinstall/reset, real-recipient send, or Mac Messages database access occurred.
Notification permission and Contacts sync were enabled only in this empty profile; sync visibly
reported **read 0 contacts / matched 0**. App Lock and Secure Screen retained their fresh-profile off
defaults. The fixture supplied three `.invalid` chats and a fixed 1,024×1,024 solid-green RGBA avatar
through its authenticated synthetic contact/thumb route. There were **14 completed control steps /
15 accepted real identity-bound V3 Firebase sends / 14 incoming rows / 2 avatar downloads /
0 unauthorized requests / delivery not halted**. Preparatory user 11 was revoked and removed after
one uncredited setup push exposed an omitted sender object; the corrected finite matrix began from
a fresh profile and included the sender's address/service, not just a numeric server handle id.

| Required behavior                    | Actual Samsung evidence                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground and concurrent arrivals   | A stayed unopened while B was viewed. Line 1 alerted; the fixed simultaneous pair 2/3 on Home retained all three ordered lines in PID `22540`. Line 4 foreground and line 5 on Home extended that same history without loss.                                                                                                                              |
| Killed-process merge                 | Ordinary scoped `am kill --user 12` left no test PID before line 6. Headless PID `4094` posted all six lines before any UI relaunch.                                                                                                                                                                                                                      |
| Newest-six limit                     | Line 7 left exactly lines **2,3,4,5,6,7**, with local ids **9,10,17,18,19,26**.                                                                                                                                                                                                                                                                           |
| Fresh late arrival without repost    | A new, never-seen GUID used line 1's timestamp: newer than the bootstrap/read floor but older than all retained lines. Native text, six local ids, and enqueue timestamp stayed unchanged. Later conversation inspection showed the late row, ruling out duplicate-event or failed-admission explanations.                                                |
| Exact unsend                         | Authenticated V3 `updated-message` retracted line 4's exact GUID after canonical fixture history was updated. Only local id **17** disappeared; **2,3,5,6,7** and ids **9,10,18,19,26** remained. This withdrawal was background/alive: an immediate kill attempt did not remove PID `4094`, so it is not credited as killed-process withdrawal.          |
| Native long-text/avatar presentation | Six distinct 520-code-point Unicode inputs posted as exactly **512 code points / 2,048 UTF-8 bytes each**, with six opaque local ids. The separate resource chat did not change A's five-line history. Expanding its native child visibly rendered the solid-green sender avatar.                                                                         |
| Restart and durable retraction       | A subsequent ordinary kill demonstrably removed the process. Both native histories survived; fresh startup PID `7221` preserved five normal and six resource lines. Opening A showed **“Notification Test A unsent a message”**, no original line-4 text, and all unrelated conversation messages. Reading A then cleared its whole-chat notice normally. |

**Native resource evidence and limits:** the posted resource notification's Notifee metadata bundle
reported **21,260 parcelled bytes**; this is not a measurement of the complete Binder transaction.
The full six-line notification was successfully accepted and rendered without losing lines or the
decoded avatar. Android 16's [notification builder and MessagingStyle implementation](https://android.googlesource.com/platform/frameworks/base/+/android16-release/core/java/android/app/Notification.java)
reduce each sender icon before building the styled notification. A read-only resource lookup in
Gator's Samsung user-12 context resolved `notification_person_icon_max_size` to **144dp**, with
effective density **560dpi**: a **source/resource-derived 504-pixel ceiling**, not directly measured
posted Person dimensions. Standard shell dumps expose Person hashes, not their bitmap dimensions.
The synthetic input is 1,048,576 pixels / roughly 4MiB decoded RGBA; the existing authenticated
download guard remains **5MiB / 16Mi pixels**. This representative native presentation plus the
source bounds is not an arbitrary-image peak-memory, all-OEM, or exact worst-case Binder-size claim.
Native direct-message sender labels were ordinary synthetic addresses; maximum label/URI projection
remains grounded in the existing host/source proof, not falsely reported as a measured maximum
sender-label device case. The old all-unresolved native history/resource checkpoint is superseded
by this finite device proof; locked V3 notice behavior remains separately owned by `NOTIF-02`.

**Verification and cleanup:** notification, ingress-dispatch, DB event-sink, and server-avatar source
matched v79 source `a0add484c00fdda06b7ee2c0a5bb5221d256d292` with an empty scoped diff. The
fixture Node suite passed **21/21, 0 failed / 0 skipped**, including canonical withdrawal, fresh late
identity/timestamp, real decodable avatar bytes, mode isolation, and each complete FCM data payload
within 4,096 bytes. Strict TypeScript passed; touched-script ESLint passed **0 errors / 0 warnings**;
both scripts were formatted, and the DB report passed **2,187 mutations / 0 structural/membership
errors**. Independent fixture/crypto and native-resource review was read-only; production source
and the previously passed full-app candidate gate were not changed or needlessly rerun.

Self-revocation returned 200 and cleared enrollment. Only owned user **12 / GatorNotif03Test-20260930**
was removed (`Success: removed user`), discarding its synthetic database/credentials; the earlier
owned preparatory user 11 was also absent. The fixture exited **0**, the owned USB reverse and
temporary UI/screenshots were removed, and the bounded two-minute wake helper stopped **130** after
SIGINT. DND/stay-awake/timeout returned to **1 / 2 / 600000 ms**. The normal account's process remained
PID **16924** throughout; no primary data or credential was replaced. The Pixel was not used. The
fixture intentionally has no realtime socket, so its reconnect banner is not live-server evidence.

<a id="feat-05b-play-v79"></a>

## FEAT-05B — isolated Play-v79 grouping and lifecycle checks

**2026-09-30, approximately 18:10–18:22 MDT: PARTIAL PASS; KILLED-PROCESS SUMMARY DEFECT.**
The existing Samsung/API-36 Play `0.1.58` / code `79` ran the unchanged, bounded `notif01` fixture
in temporary managed user **13 / GatorGroupingTest-20260930**. Six fresh encrypted V3 Firebase
sends supplied three A/B episodes. No build, production-source edit, normal-account reset, Mac
Messages access, real-recipient send, or Pixel use occurred. App Lock and Secure Screen stayed off,
Contacts remained unrequested, and DND was temporarily off. Notification, navigation, lock and
session/boot sources were independently checked against the v79 source; the relevant scoped diff
was empty. The previously passed **21/21** fixture suite was reused without fixture changes.

| Check                                   | Actual Samsung result                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First child and native alert            | A/check 1 produced one grouped child without an app summary. Samsung's vibration-service trace showed exactly one completed notification effect for each of the six sends, **1,102–1,105 ms**, owned by this profile's Gator UID. Summary creation/maintenance added no such effect. This is native vibration-service evidence, not independently heard audio or a heads-up assessment; the channel's sound was null.                            |
| Killed-process group creation           | Scoped ordinary `am kill --user 13` left no owned PID before B/check 2. Headless PID **23417** posted both correct children, but no `message-summary` appeared for approximately **4 minutes 44 seconds**. Android created its own `AUTOGROUP_SUMMARY`, which is not Gator's required summary. Normal UI startup in that same PID immediately created the Gator summary without another vibration. **FAIL for killed-process summary creation.** |
| Required app summary                    | Normal startup and the subsequent alive/background and foreground A/B episodes produced the fixed `gator-message-summary` in `gator-message-group`: title **Gator**, count-neutral body **New messages**, kind `message-summary`, no `chatId`, `ONLY_ALERT_ONCE\|GROUP_SUMMARY`, child-only group-alert behavior **2**, and no auto-cancel flag.                                                                                                 |
| Child tap, read and Back                | Tapping grouped A/check 1 opened A's plain conversation; one Back returned to the Messages inbox. A's native child disappeared while B/check 2 and the silent summary remained. This was a background/alive child tap: a separate kill attempt immediately before the tap did not remove PID 23417, so it is not credited as cold-start navigation.                                                                                              |
| Child dismissal and empty-group cleanup | Swiping the last B/check 2 removed all owned records. In the second episode, swiping A/check 3 preserved B/check 4 plus the summary; normal startup did not restore A or change B's text/history. Reading the remaining B chat then removed both B and the summary.                                                                                                                                                                              |
| Account teardown                        | The third foreground/inbox A/check 5 + B/check 6 episode created both children and the summary. Disconnect, confirmed only in the synthetic profile, returned to Welcome and cleared all its native records and enrollment. A subsequent authenticated app-API request returned **401**, confirming credential revocation.                                                                                                                       |

**Cause and remaining evidence:** independent read-only review traced the failed headless summary
to `messageGroupMutationAllowed()` requiring the in-memory `lock.hydrated` flag. A fresh headless
process reads persisted App Lock OFF to allow detailed delivery but does not initialize that flag;
group reconciliation silently skips. Foreground boot hydrates it, allowing startup repair. This is
not a lost-push or fixture failure. No production fix was implemented in this proof-only batch.

Samsung exposes its group header as expand/collapse, not an independently tappable summary body;
expansion is not inbox-navigation proof. Global Clear All was not used because the shade also held
the owner's unrelated notices and this device allows only one switchable full user. Existing-group
App Lock/unlock maintenance, grouped withdrawal (NOTIF-03's exact withdrawal occurred before a
multi-chat group existed), scoped Clear All/no resurrection, and the unavailable summary-body
navigation lane remain unproved here. The separate NOTIF-02 locked-push defect still needs the
deferred replacement build. **FEAT-05B and parent FEAT-05 remain IN_PROGRESS.**

**Verified cleanup:** only owned profile 13 was removed (`Success: removed user`), the fixture
exited **0**, the owned USB reverse and temporary UI XML were removed, and the two-minute wake
helper stopped **130** after SIGINT. DND/stay-awake/timeout returned to **1 / 2 / 600000 ms**.
User 0's normal app stayed at PID **16924**, Play code **79**; its data and credentials were not
replaced. No test profile or owned reverse remained, and the private inspection kernel was reset.
The fixture reported **6 incoming / 6 successful FCM sends / 0 downloads / delivery not halted**;
its absent realtime socket is not live-server connectivity evidence.

<a id="feat-05b-play-v79-app-lock-attempt"></a>

## FEAT-05B — existing-group App Lock proof attempt

**2026-09-30, approximately 19:28–19:34 MDT: SETUP PASS; LOCK/UNLOCK PROOF NOT RUN.**
The unchanged Play `0.1.58` / code `79` and bounded `notif01` fixture ran in owned managed
user **15 / GatorGroupLockTest-20260930**, with the normal account untouched. The intended
sequence was two unlocked pushes, enable App Lock, dismiss A while gated, owner authentication,
and verify B plus the silent summary survive without A resurrection or another native alert.
No pushes were to be sent after enabling App Lock.

The two fresh real encrypted V3 sends succeeded. A/check 1 first produced only its child;
B/check 2 produced A+B and Gator's fixed summary. The summary had title **Gator**, body
**New messages**, kind `message-summary`, no chat identity, `ONLY_ALERT_ONCE|GROUP_SUMMARY`,
and child-only group-alert behavior **2**. Profile UID **1510581** had exactly two completed
notification vibration-service effects, **1,108 ms / 1,102 ms**, with no extra summary effect.
The owned process remained PID **17395**. These observations are unlocked setup evidence,
not another completed lock/unlock lane or independently heard audio evidence.

**Blocking observation:** enabling App Lock displayed
“Set up a fingerprint, face unlock, or device PIN before enabling App Lock.” Its switch stayed
OFF; Secure Screen also stayed OFF. Independent source review confirms this dialog returns
before changing App Lock when the hardware-and-enrollment availability check is false. The
dialog does not identify which operand failed in the temporary profile. It is not evidence
of a grouping failure, and a test-profile PIN alone is not proved sufficient. No OS credential
was configured, no lock gate was reached, no A dismissal or owner unlock was performed, and
no further FCM push was sent. **Existing-group App Lock/unlock maintenance remains OPEN;
FEAT-05B and parent FEAT-05 remain IN_PROGRESS.** A retry needs an isolated test profile that
reports authentication available; do not replace the normal account or bypass the security gate.

**Verified cleanup:** synthetic-profile Disconnect returned to Welcome, cleared all three native
records, removed FCM enrollment, and made the subsequent authenticated revoke-self API request
return **401**. Only exact owned user 15 was removed (`Success: removed user`). The fixture
closed and its controller exited **0**; the owned USB reverse/UI XML were removed and the
two-minute wake helper stopped **130**. DND/stay-awake/timeout returned to **1 / 2 / 600000 ms**,
the normal account remained PID **16924**, and no owned profile or reverse remained. Private
inspection state was reset. Final fixture totals were **2 incoming / 2 successful FCM sends /
0 downloads / delivery not halted**. An earlier setup-only user 14 was removed before this run
after a controller authorization-header error; that discarded fixture sent no pushes.
No app-source change, rebuild, reinstall, Pixel use, real-recipient send, or full Jest rerun occurred.

<a id="feat-05b-play-v79-cold-tap-replay"></a>

## FEAT-05B — cold child entry and consumed-tap replay

**2026-09-30, approximately 20:09–20:24 MDT: COLD ENTRY PASS; ONE-SHOT RESUME FAIL.**
Unchanged Samsung/API-36 Play `0.1.58` / code `79` ran the bounded `notif01` fixture in exact
owned managed user **17 / GatorColdTap-20260930**, with App Lock and Secure Screen OFF and
Contacts unrequested. Relevant notification entry/routing and boot sources were independently
checked against the v79 source. The uninstalled headless-summary source fix is not credited here.
No app-source change, rebuild, reinstall, normal-account replacement, real-recipient send, or
Pixel use occurred. Exactly **two fresh real encrypted V3 pushes** supplied A/check 1 and B/check 2.

A arrived alone; B formed both children and Gator's generic summary. The summary had title
**Gator**, body **New messages**, no chat identity, `ONLY_ALERT_ONCE|GROUP_SUMMARY`, and
child-only group-alert behavior **2**. Profile UID **1710581** recorded only the two arrival
notification vibration-service effects, **1,106 / 1,102 ms**. This is not independently heard
audio or heads-up evidence. No additional push was sent during either tap/resume sequence.

- **A cold entry: PASS.** Ordinary `am kill --user 17` removed owned PID **21227**; no owned
  process remained immediately before the tap, and all three native records were unchanged.
  Tapping A started new PID **2426**, opened the exact A chat at the newest check-1 message,
  and showed no older-window return anchor. A's child disappeared; B's exact native record and
  message history, plus the same silent summary, were preserved with no extra vibration.
  One Back returned to the inbox with no chat-details header or Go back control.
- **A subsequent resume: FAIL.** Home followed by a direct explicit Activity launch reopened
  A's chat without a new notification or push. A settled second snapshot confirmed the chat
  header, Go back control and newest check-1 message. This first launch shape alone was not
  treated as ordinary app-icon proof.
- **B control and ordinary-launcher resume: ENTRY PASS / RESUME FAIL.** After returning to
  the inbox, ordinary scoped kill removed PID **2426**. B's child and summary remained unchanged;
  no owned process existed immediately before tapping B. That tap started new PID **6186**,
  opened exact B at newest check 2, and removed the final child and summary without another
  native alert. One Back returned to the inbox. Home followed by `ACTION_MAIN`,
  `CATEGORY_LAUNCHER`, flags `0x10200000`, and the app's `MainActivity` reopened B in the same
  PID, despite zero native records and still only two total FCM sends. This is a launcher-intent
  equivalent comparison, not a separately observed physical app-icon tap.

**Acceptance boundary:** independent review accepts genuine cold entry, correct newest/plain
chat, first-Back inbox behavior, sibling/summary preservation, final empty-group cleanup and
no extra native vibration effects. It rejects one-shot tap/resume completion. The consumed chat
reopens under the normal launcher-intent shape, so this is not dismissed as the initial direct-ADB
launch edge case. Delayed pending-tap/sticky-event delivery is a source-review hypothesis only;
the exact cause is unresolved. Do not use a permanent chat/payload blacklist, which could suppress
a later genuine press. A focused fix and exact replacement-candidate native replay check are next;
neither occurred in this proof-only run. **FEAT-05B and parent FEAT-05 remain IN_PROGRESS.**
The prior killed-process summary and NOTIF-02 locked-push build requirements remain separate.

**Verified cleanup, completed approximately 20:32 MDT:** two UI automation attempts did not
observe the Disconnect confirmation; the phone was then at Home, so further taps were stopped.
The synthetic fixture credential was revoked directly (**200**), and the subsequent authenticated
revoke-self request returned **401** with enrollment false and zero owned native notices. This
does not establish app Disconnect behavior or an app Disconnect defect. Only exact owned user 17
was removed (`Success: removed user`); the owned USB reverse and temporary XML were removed.
The fixture/controller exited **0**, and the bounded two-minute wake helper stopped **130**.
DND/stay-awake/timeout returned to **1 / 2 / 600000 ms**; user 0's normal app remained PID
**16924**, and Play version/code remained **0.1.58 / 79**. No owned profile or reverse remained.
Final fixture totals were **2 incoming / 2 successful FCM sends / 0 downloads / delivery not
halted**. The fixture's absent realtime socket is not live-server connectivity proof. No fixture
or source changes were made, and no broad host gate was repeated for this device/documentation run.

## FEAT-05A / PERM-01 — Samsung location negative paths

**2026-10-02: THREE BOUNDED UI/HTTP CASES PASS; FIRST-DENIAL FEEDBACK FAILS.** The same
Play `0.1.58` / code `79` package was enabled in an owned temporary managed profile using
`install-existing`, without building or replacing the normal installation. The chat route,
location adapters, and dedicated send-location service have no diff against the bound v79 source.
Only synthetic one-to-one iMessage chats were used. A temporary loopback-only wrapper around the
existing `notif01` fixture advertised the location capability, disabled FCM, counted location
requests, and rejected every recipient-send operation. It never contacted a real messaging server.

| Case | Observed result | Credit |
| --- | --- | --- |
| First permission denial | Confirmation preceded Android's Precise/Approximate permission chooser. Selecting **Don't allow** returned silently to the seed-only chat: no **Location Permission Needed / Try Again** explanation appeared. No location or other message-write HTTP request occurred. | **FAIL feedback; PASS observed no-send safety.** |
| Permanent denial recovery | A second genuine native denial set both permissions to denied with `USER_FIXED`. The next explicit location action showed **Location Permission Needed / Open Settings**, which opened Gator's App info in the test profile. No location/message-write request occurred. | **PASS next-attempt recovery**, not immediate feedback after the second native denial. |
| Location services off | With the phone's location-services state verified false, the confirmed action showed **Location Services Are Off** and recovery controls, with no permission prompt or location/message-write request. Services were immediately restored and verified true. | **PASS bounded services-off UI/HTTP case.** |
| Home during permission prompt | After resetting only the disposable app, a fresh prompt was observed. Home resumed the Samsung launcher; reopening the same test task returned to the seed-only chat with the prompt dismissed and both permissions still denied. No new location bubble or location/message-write request appeared. | **PASS pending-prompt cancellation**, not background during an active location watch or a late grant. |

Final fixture observations: **50 API requests; 0 location POSTs; 0 other message-write attempts;
0 unauthorized requests; 0 downloads; 0 FCM sends.** The production encrypted database was not
inspected; these results do not directly prove absence of a queue row, successful acquisition,
delivery, retry, expiry, or encryption. The first-denial case remains unchecked.

**Defect diagnosis:** While the native permission prompt was visible, Android reported Gator's
test-profile MainActivity **PAUSED** and the permission Activity **RESUMED**. The current React
Native adapter converts host pause to background, and Gator cancels acquisition on every non-active
state. The later denial is consequently discarded as an already-cancelled operation. Source review
also predicts cancellation of a first grant, but a grant was not exercised here. A fix must preserve
real Home/background cancellation; simply ignoring background events during a permission prompt is
not safe. No app-source correction or replacement-build validation is claimed.

**Preparation boundaries:** Initial setup connected but returned to Connect; a force-stop/relaunch
of only the disposable copy resumed optional permissions. This is not ordinary-kill/push evidence,
and the navigation observation remains unclassified. A profile-only services toggle left the
effective state true, so that attempt was not credited; the successful case used the shared phone
switch and dismissed Google's location-off warning. Clearing only the test profile's `USER_FIXED`
flags did not restore the native prompt, so its synthetic app data alone was reset for the Home case.

**Verified cleanup:** location services returned to true for both profiles before the owned test
profile was removed. User 0's location grants and normal app process were preserved; no normal
credential, account, or message was changed. Closing the fixture cleared its in-memory registration
and credential, and removed its owned USB reverse. The temporary profile and device XML were removed;
only user 0 remained. The bounded two-minute wake helper was stopped. USB wake `2` and screen timeout
`600000` ms were unchanged; DND was not changed. `FEAT-05A`, `FEAT-05`, and `PERM-01` remain open.

<a id="overnight-no-build-oct02"></a>

## October 2 — isolated no-build replay, failure, and old-server checks

**2026-10-02, approximately 15:50–16:03 MDT: FOUR NARROW LANES PASS.** The unchanged Samsung/API-36
Play `0.1.58` / code `79` ran in owned managed profile **11 / GatorOvernight-20261002**, using
`install-existing`, not a new APK or replacement of the primary installation. The fixture served
only synthetic chats, with an ephemeral in-memory scoped credential. Normal user 0's account and
PID **27457** were untouched. The server session retained ownership of the live Mac; none of these
checks used it. A lease-aware wake-only helper ran every 180 seconds. App Lock/Secure Screen retained
fresh-profile off defaults, Notifications were granted, Contacts were unrequested, and DND was
temporarily off.

- **Unlocked V3 replay across ordinary process death: observable pass.** Fresh test-profile
  enrollment succeeded. A first encrypted Firebase delivery posted one A notification. Scoped
  `am kill --user 11` removed PID **14870**, with no owned process left. The controller replayed
  the exact encrypted request body once, retained only in memory, after **18,648 ms**, within its
  five-minute envelope lifetime. Firebase accepted it (**200**); receiver PID **27290** logged
  receipt. A's native record, one-line history, creation/update time **1790977851283**, and
  interruption time **1790977851485** stayed unchanged through the settled follow-up. A fresh B
  delivery then posted normally. After a second verified process stop, the owned USB reverse was
  absent during offline startup (**27446**): each inbox row showed one unread message, and opening
  each chat showed one corresponding incoming bubble. The fixture API count stayed **8** through
  offline inspection, so server rehydration cannot explain that observation. Final delivery totals
  were **2 fresh incoming / 2 fixture FCM sends + 1 separately counted exact replay**. No audible or
  independent vibration proof is claimed. This is observable duplicate/repost containment, not
  direct inspection of SQLCipher replay receipts or proof that only the cryptographic receipt,
  rather than message/history deduplication, prevented effects. Production-server enrollment,
  HTTPS confidentiality, locked admission, cross-account/device, rotation and downgrade remain open.
- **Failed-message persistence/deletion: pass for the generic failure branch.** The fixture's
  unsupported send endpoint produced a failed synthetic bubble with `Not Found` / `Not Delivered`;
  no owned native notification appeared while its chat was active. An immediate kill attempt left
  the process alive and was not credited. After a later verified no-process gap, offline PID
  **28319** retained that failed bubble and status, and its options sheet offered Try Again/Delete.
  Deleting only that bubble removed it; another verified ordinary stop and offline startup
  (**31213**) preserved its absence while the seed and incoming B bubble remained. This does not
  prove useful nested server detail, retry success, FIFO order, or background failure notices.
- **Older-server limited repair: pass for local failed-row preservation.** Before deleting the
  failed bubble, Repair Local Cache completed **Refresh complete (limited)** with **2 chats /
  4 messages**. Its UI explicitly reported additive refresh without absence cleanup or marker
  replacement. The local failed bubble, absent from the fixture's canonical history, retained its
  failed status afterward. No direct marker inspection, full customization matrix, modern atomic
  repair, cancellation or live Mac comparison is inferred.
- **Older-server Backup fallback: pass.** The existing `/backup/settings` 404 produced the named-
  backups-unsupported explanation, without server save/list/delete controls. Local export/restore
  fields remained present with their normal empty-input disabled states. Choose a backup file
  opened Android's empty document picker and cancellation returned safely; no backup was exported,
  selected, decrypted, restored or sent to the server in this lane. Cross-device slots remain open.

**Binding and batch retirement:** relevant crypto/ingress, failed-message sheet/routing/notice,
backup and repair source paths were compared with candidate `a0add48`; newer notification, send
capability and native fixes are not credited. Final fixture totals were **46 API requests /
2 control requests / 0 downloads**. Self-revocation returned **200**, cleared enrollment, and a
second request returned **401**; that deliberate negative check is the single unauthorized request.
The controller exited **0**, discarding its encrypted replay copy, and the USB reverse was removed.
Only the owned profile's Gator data was then cleared for a separate finite SEND-01 batch; the profile
and wake lease remained reserved. Final profile removal/settings restoration is recorded with that
later batch. All four parent remediation items remain open for their wider acceptance boundaries.

<a id="overnight-send-oct02"></a>

## October 2 — bounded send failures and completed offline detail persistence

**2026-10-02, approximately 16:03–16:14 MDT: ORDINARY-TEXT DETAIL RESTART GATE PASSES;
THREE PRESENTATION CASES PASS.** The same unchanged Play v79 installation ran in the owned profile
11 after clearing only that disposable profile's app data. The opt-in fixture accepted exactly
three fixed ordinary-text requests to synthetic chat A; it has no outbound message transport and
this mode rejects Firebase configuration. No real contact was messaged. Its bounded error response
was `The test server rejected this message. No message was delivered.` The two later responses were
held until the intended UI state, then explicitly released. Final pre-revocation counters were
**3 accepted / 3 released / 0 cancelled / no pending response / not halted**, with **29 API /
2 control / 0 download / 0 FCM** requests. UI/native observations, not just those counters, establish
the results:

- **Active failed chat:** the failed bubble's options sheet displayed the exact useful server
  detail, while the profile had no native notification. This is the active-chat suppression pass.
- **Different foreground chat:** B was visibly open before the A response was released. One
  native record appeared, id **1137795647**, with fixed title `Message status needs review` and
  body `Open Gator to review.` Its scoped record contained none of the synthetic message, contact,
  server detail, raw route GUID, or credential. These are the actual installed/current strings;
  the older plan's `Message not sent` wording was stale.
- **Useful detail survives offline restart:** after that second failure, an immediate ordinary
  kill left PID **435** alive and was not credited. A second ordinary kill produced a verified
  no-profile-process gap; user 0's PID **27457** remained. With the owned USB reverse removed,
  profile PID **2157** cold-started. Opening A's failed-message sheet still displayed the exact
  useful detail. The fixture API count remained **20** throughout the offline inspection, ruling
  out server rehydration. The detail was observed by **22:12:29.776Z**, approximately **27.8 seconds
  after notification creation**, not a directly measured DB retry deadline. This completes the
  `SEND-01B` ordinary-text restart requirement; it does not claim every upload/reaction/realtime
  transport was exercised on the phone.
- **Background failure:** Home was confirmed as the foreground activity before releasing the
  third response. One native record appeared, id **911926554**, with the same fixed title/body
  and the same negative private-content checks. Reopening the app showed the failed bubble and
  exact useful detail. Deleting each of the second and third failed bubbles separately withdrew
  its native notification; the corresponding scoped record lists were empty afterward. The final
  A screen retained only its seed message.

**Retry timing correction:** the first, slower restart attempt crossed an automatic-retry window;
the original detail was replaced by an offline `Connection Refused` failure. Installed-v79 source
confirms that ordinary text errors enter the retry queue regardless of HTTP status, with the first
retry eligible after 30 seconds, and that retry claims deliberately clear prior detail. The plan
requires that clearing. This attempt is therefore not a persistence failure or a pass; the later
verified offline restart above supplies the uncontaminated positive evidence. No retry-policy
change was made. Old failed bubbles were deleted before continuing the finite sequence.

**Scope and verification:** the relevant failure-detail/notice paths match candidate `a0add48`.
The new fixture is opt-in, authenticated, fixed-input, bounded to one held response and 25 seconds,
and halts on cancellation/revocation/close. Fixture tests **33/33**, scoped lint with zero warnings,
format/diff checks, and independent safety review pass. This is neither real-Mac send acceptance nor
evidence for uninstalled native/capability changes. FIFO/mixed attachment ordering, retry success,
success/echo withdrawal, notification tap/locked/killed matrix and broader `SEND-01C` acceptance
remain open; audible/vibration delivery is not claimed. Parent `SEND-01` remains **IN_PROGRESS**.

**Final cleanup and handoff:** self-revocation returned **200** and cleared enrollment; a subsequent
request returned **401**, then the controller closed with exit **0**, discarding the in-memory
credential. Final counters were **30 API / 2 control / 7 unauthorized / 0 download / 0 FCM**; the
unauthorized count includes post-revocation app traffic and the explicit negative check. The owned
USB reverse and device XML were removed. Only owned managed profile **11 / GatorOvernight-20261002**
was deleted, permanently discarding its synthetic data; `pm list users` confirmed only user 0.
DND was restored to **1**, USB stay-awake remained **2**, and screen timeout remained **600000 ms**.
Normal user 0's PID **27457**, Play installer and version **0.1.58 / 79** were unchanged. The exact
owned 180-second wake helper was stopped, the lease released, and the server session notified.
No normal-account reset, live Mac mutation, Android build, install or upload occurred.

<a id="overnight-v3-tamper-oct02"></a>

## October 2 — finite V3 tamper rejection with a fresh positive control

**2026-10-02, 16:56–16:58 MDT: THREE UNLOCKED TAMPER CASES PASS.** After an acknowledged second
Samsung reservation, a fresh owned managed profile **12 / GatorCrypto-20261002** used the unchanged
Play v79 binary, synthetic seed chats and an ephemeral in-memory scoped credential. Notifications
were enabled; Contacts remained unrequested and both privacy toggles retained their off defaults.
A lease-bound wake-only helper was configured for 180-second intervals. No live Mac or real
recipient was involved. The first UI dump timed out during startup; a later successful inspection
established the baseline before any Firebase send.

After enrollment and the two seed rows were visible, the owned USB reverse was removed. Ordinary
`am kill --user 12` removed PID **17981**, leaving only normal user 0's **27457**. The fixture then
constructed one fresh synthetic A envelope. Its injected transport captured the exact request in
memory and returned **local 200 only**, without contacting Google. Consequently the fixture's
`fcmSends=1` is a local capture counter here, **not a Google delivery count**. The untouched occurrence
had never been delivered, so a prior valid delivery/replay receipt could not mask the negative cases.

The independent-reviewed controller kept the same recipient token, allowed exactly four ordered
network attempts, and rejected sends after 240 seconds from local capture. Actual Google results were:

| Case | Mutation and observation |
| --- | --- |
| Authentication tag | One tag byte flipped. Google **200**; receiver **1790981810.626**, new PID **21523**; no owned notification. |
| Principal metadata | The authenticated principal UUID's trailing byte flipped, leaving UUID version/variant and the tag unchanged. Google **200**; receiver **1790981839.086**; no owned notification. |
| Outer event type | Only outer `type` changed from `new-message` to valid `updated-message`; encrypted frame unchanged. Google **200**; receiver **1790981849.634**; no owned notification. |
| Untouched positive | Exact original request sent **82,751 ms after local capture**. Google **200**; receiver **1790981876.671**; one A notification, id **245524571**, with one history line. |

Before the positive send, offline foreground inspection showed only A's seed message. After the
positive, offline A contained the seed plus exactly one incoming synthetic message. The fixture API
count stayed **8** throughout, excluding REST hydration. All four receiver broadcasts were observed
under the test profile; an initially incorrect observer tag was corrected to the installed
`RNFirebaseMsgReceiver` before proceeding beyond the first negative. No resend was needed.

This establishes observable rejection of these three tamper variants plus working delivery of the
untouched envelope. It does **not** establish wrong-key, correctly authenticated cross-account/device,
expiry, downgrade, locked admission, direct SQLCipher receipt inspection, sound/vibration or
production-server HTTPS confidentiality. `PUSH-CRYPTO-01` remains **IN_PROGRESS**.

**Cleanup:** self-revocation returned **200**, then **401**; registration cleared and the controller
exited **0**, discarding its captured frame and credential. Final fixture counts were **9 API /
1 control / 1 unauthorized / 0 downloads / 1 local capture**; real Google traffic was separately
**3 invalid + 1 valid**, each sent once. Owned profile **12** and its XML were removed, permanently
discarding synthetic data. Only user 0/PID **27457** remained; the reverse was absent, DND restored
to **1**, USB stay-awake **2** and timeout **600000 ms** unchanged. The exact helper was stopped,
lease released and server session notified. No Android build/install replacement or Mac change occurred.

## Earlier session notes

- Only Samsung serial alias `R5C…RXW` is in scope. The connected Pixel is not used.
- USB stay-awake was enabled, but the Samsung reached keyguard once. The owner then unlocked it;
  later checks explicitly woke and rechecked keyguard state between milestones.
- The installed v79 app began at the fresh Welcome screen.
- Once the Mac server recovered, the phone resumed an existing scoped credential. No new credential
  was created or entered. The connected server contains real user data, so the run stopped short of
  send, reply, reaction, scheduling, location, account replacement, and destructive recovery tests;
  their current runbooks require an approved isolated staged Mac and synthetic identity.
- The Mac server initially failed closed because two stale helper artifacts lacked the matching
  ownership receipt. After a graceful Gator restart, a fresh socket, handshake, and `messages`
  ownership receipt were observed, and `GET /api/v1/health` returned HTTP 200. The guarded
  quarantine path was not used. The recovery procedure did not intentionally edit app repository
  source, server configuration, credentials, the message database, or user content.
- Do not credit unchecked rows from `DEVICE_VERIFICATION_CHECKLIST.md`; that file is retired v56
  history. Each task owner remains open until its own acceptance boundary is satisfied.
