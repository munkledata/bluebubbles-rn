# Device Verification Checklist — historical version-code-56 preparation

> **STATUS (2026-09-13): RETIRED V56 PREPARATION — NOT A CURRENT EXECUTION MATRIX.**
> This file preserves the prepared `0.1.40` / version-code-`56` ledger and its synthetic-safe matrix history. It
> contains no current-candidate evidence. The explicitly labelled, bounded Play-v78 `UI-01`/`THEME-01A` reviews and
> local-debug `HANDLE-COLOR-01` review added on 2026-09-27 are task-scoped evidence only; they do not rebind this
> ledger or the v77 release candidate. Do
> not execute its other historical rows, fill their result fields, or
> transfer a checkmark or evidence to another artifact. Explicitly labelled local-development supporting results may
> be recorded separately without populating the retired v56 candidate fields.
>
> The later version-code-57 through 62 artifacts are also superseded history. The current candidate
> boundary is recorded in [`RELEASE_PLAN.md`](./RELEASE_PLAN.md) and
> [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) §0; bounded v63 automatic-preview evidence lives in
> [`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md). Those results
> do not make this v56 ledger executable.
> `DEVICE-01` in [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) remains blocked until the
> remaining matrix is refreshed and run for that exact AAB, source/release commit, device, and Android version.

This was prepared as the evidence record for the retired Google Play Internal Testing candidate. Host tests can
support a result, but notifications, Firebase Cloud Messaging (FCM), encrypted storage, native
bridges, process death, and Play delivery need evidence from the exact installed candidate. Never
copy a result from a development build or an older Play build into the candidate record.

## Historical exact version-code-56 candidate boundary

| Field                      | Frozen value                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                         |
| App version                | `0.1.40`                                                                                          |
| Android version code       | `56`                                                                                              |
| Candidate source commit    | `5d367eb58e38126258423f1cd9ce0da42b179f7f`                                                        |
| Local AAB                  | `gator-release-0.1.40-v56-5d367eb.aab` — ignored; never commit it                                 |
| Size                       | `55,729,707` bytes                                                                                |
| AAB SHA-256                | `926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`                                |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Build provenance           | Local EAS production build, 2026-08-23; tracking ID `0c5e82fe-e8d2-4dfa-ad94-38f9e805df7e`        |
| Packaged Android boundary  | `arm64-v8a` only; minimum SDK 24; target SDK 36                                                   |
| Distribution boundary      | Private Google Play Internal Testing only; no promotion                                           |
| Current external state     | Not proven uploaded, accepted, published, Play-installed, or device-tested                        |

**Accessibility scope:** The owner dropped `A11Y-01..03`, including Reduce Motion and TalkBack device
matrices, on 2026-09-25. Do not schedule those historical checks against this or a later candidate.

Do **not** rebuild this candidate. The production profile auto-increments, so another production
build would consume version code `57` and create a different artifact. If a separate upload is later
approved, select this exact local file by name and recompute its digest immediately beforehand;
never select an ambiguous "latest" artifact. The newest recorded hosted EAS build is code `54`, with
zero hosted builds recorded for codes `55` and `56`. GitHub Actions and development artifacts are
disposable supporting builds, not this candidate.

The AAB digest identifies the local file, and the upload-certificate fingerprint identifies its
upload signature. Google Play delivers split APKs signed with the separate **Play App Signing
delivery certificate**. Record that certificate and verify the installed package against it; do not
expect an installed split APK hash to equal the original AAB hash. A local or sideloaded install can
exercise behavior but cannot prove Google Play Internal Testing delivery.

## Candidate session and evidence ledger

Leave every field `OPEN` until a separate approved Play/device session produces evidence. Use an
alias rather than a tester's email address or device serial.

| Field                                  | Safe value to record                                                   | Status |
| -------------------------------------- | ---------------------------------------------------------------------- | ------ |
| Evidence-record commit/date            | `[OPEN — commit containing the completed results]`                     | OPEN   |
| Tester evidence alias                  | `[OPEN — no account address]`                                          | OPEN   |
| Device model                           | `[OPEN]`                                                               | OPEN   |
| Android version / API level            | `[OPEN]`                                                               | OPEN   |
| Device ABI                             | `[OPEN]`                                                               | OPEN   |
| Navigation mode                        | `[OPEN — gesture or three-button]`                                     | OPEN   |
| Display/font state                     | `[OPEN]`                                                               | OPEN   |
| Permission baseline                    | `[OPEN — fresh, denied, or previously granted]`                        | OPEN   |
| Test branch                            | `[OPEN — clean Play install or approved prior-build Play update]`      | OPEN   |
| Approved prior-build baseline          | `[OPEN — version, version code, and source label]`                     | OPEN   |
| Live Play inventory alias/date         | `[OPEN — private evidence reference]`                                  | OPEN   |
| Internal release status/artifact       | `[OPEN]`                                                               | OPEN   |
| Tester-list label/count                | `[OPEN — never tester identities]`                                     | OPEN   |
| Opt-in evidence alias                  | `[OPEN — never the link]`                                              | OPEN   |
| Install source                         | `[OPEN — must prove Google Play delivery]`                             | OPEN   |
| Installed package/version/version code | `[OPEN — must equal com.bluegreengatorapps.messages / 0.1.40 / 56]`    | OPEN   |
| Play delivery-certificate SHA-256      | `[OPEN — separate from the upload certificate]`                        | OPEN   |
| Installed signing fingerprint/result   | `[OPEN — compare with the Play delivery certificate]`                  | OPEN   |
| Server environment label/version       | `[OPEN — no hostname, URL, or credential]`                             | OPEN   |
| Synthetic fixture / Firebase labels    | `[OPEN — no message content or key material]`                          | OPEN   |
| Feedback route alias                   | `[OPEN — no private address or token]`                                 | OPEN   |
| Tester notice version/approval         | `[OPEN]`                                                               | OPEN   |
| Test halt owner role                   | `[OPEN]`                                                               | OPEN   |
| Test window / credential expiry        | `[OPEN]`                                                               | OPEN   |
| Server/feedback dry-run evidence       | `[OPEN — private evidence aliases]`                                    | OPEN   |
| Cleanup/teardown owner role            | `[OPEN]`                                                               | OPEN   |
| Cleanup evidence alias                 | `[OPEN — local, server, FCM, credential, tester, and capture cleanup]` | OPEN   |
| Test date / result                     | `[OPEN]`                                                               | OPEN   |
| Private evidence reference             | `[OPEN — approved private storage only]`                               | OPEN   |

Evidence must use the approved isolated server and synthetic conversations. Never put accounts,
endpoints, credentials, QR payloads, opt-in links, message bodies, private filenames, device
serials, raw logs, or unredacted screenshots in Git or public feedback. Record a sanitized result
and a private evidence reference; delete temporary captures after the approved reviewer has checked
them.

### Historical evidence — not version-code-56 credit

The 2026-07-23 remote ADB session used installed Play build `0.1.28` / version code `39` on a Galaxy
S25 Ultra with Android 16. Later database checks used a local API-35 arm64 development emulator.
Every existing `[x]` below is historical supporting evidence only, even when the checked line does
not repeat this label. None satisfies `DEVICE-01` or the version-code-56 release gate.

---

## (a) Exact-candidate and session preflight — do not rebuild

These boxes remain open until the release owner separately approves the Play/device session.

- [ ] Confirm `STORE-01G-TESTER-READINESS` records an approved tester notice and access plan, halt
      owner, test window/credential expiry, and successful staged-server and feedback dry runs.
      Device-session approval does not replace those still-open prerequisites.
- [ ] Recompute the SHA-256 of `gator-release-0.1.40-v56-5d367eb.aab` immediately before any
      approved upload and stop unless it matches the frozen value above.
- [ ] Before any separately approved submission, use a read-only Play preflight to confirm the
      selected app/package, intended track inventory, tester-list label/count, feedback destination,
      and opt-in state. Record version code `56` as absent, draft, or another observed state; do not
      invent acceptance and do not save unrelated Console changes.
- [ ] After a separately approved upload and Play acceptance, confirm the Internal Testing release
      identifies exact version code `56` before enrollment or install evidence begins.
- [ ] Select either the clean-install branch or the separately approved prior-build Play-update
      branch. For an update, record the prior version, version code, and authorized source first;
      never silently use the old `0.1.28` / code `39` record as the baseline.
- [ ] Confirm the staged server, synthetic fixture, Firebase environment, tester alias, feedback
      route, and evidence custodian are approved without recording their private values here.
- [ ] Keep local, CI, and development installs off both Play candidate branches. They may support
      separate native debugging, but they do not prove candidate delivery and may replace or wipe
      the Play-installed app state.
- [ ] After installation from Play, record the installer/source, exact package, version name, and
      version code, then verify the installed signing fingerprint against the Play App Signing
      delivery certificate.
- [ ] Record permissions, display/font state, Android/API, ABI, navigation mode, test date,
      and private evidence reference before executing a refreshed behavior matrix.

Stop immediately on a wrong file digest, package, version, version code, install source, or signing
certificate; an unapproved update baseline; an unexpected active later track; unintended tester
access; production data or credentials; or private information entering public evidence.

### Separate development/native lane — supporting evidence only

Native debug harnesses may require a fresh **local** development build on disposable device state.
That lane must have its own artifact identity and cannot run on the clean-install or update branch.
Do not check a candidate box from a `__DEV__` marker, emulator-only harness, sideloaded build, or
GitHub Actions artifact.

---

## Evidence classes for the current matrix

- **`STATIC/HOST`:** Source, configuration, or automated host evidence. It can justify an expected
  result but cannot prove Android or native behavior.
- **`LOCAL-DEV SUPPORTING ONLY`:** A disposable local debug/dev-client observation. It cannot prove
  the frozen AAB or Google Play delivery and must not run on either Play candidate branch.
- **`STAGED-SERVER`:** A read-only or owner-triggered result from the approved isolated synthetic
  server. Record only its non-secret label, aggregate result, date, and private evidence reference.
- **`EXACT PLAY CANDIDATE`:** An observation on the exact Play-installed version code `56`, after the
  package, installer, version, and Play delivery certificate have passed section (a). Only this class
  can earn candidate device credit.

No evidence class substitutes for another. A combined step must satisfy every named class. Keep all
boxes below open until the approved session actually runs; this offline audit did not execute them.

## Current matrix slice 1: notifications and lifecycle — PREPARED, NOT EXECUTED

This section supersedes historical sections (b)–(e), (g), and (i). Do not begin it until every
applicable section (a) preflight is complete, `STORE-01G-TESTER-READINESS` records its approved owner inputs and
dry runs, and the owner separately approves Play distribution and device execution. Use only the
approved isolated server, synthetic identity, and versioned fixture. Stop on any production data,
unexpected tester access, candidate mismatch, server/Firebase mismatch, or private evidence leak.

### 1. Notification baseline and safe push probe

- [ ] **`EXACT PLAY CANDIDATE`:** Record the candidate/session ledger before testing. Confirm the
      package, version code, Play install source, delivery certificate, permission baseline, device,
      Android/API, navigation mode, and private evidence reference; do not rebuild or sideload.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Confirm the approved server version, synthetic
      fixture label, Firebase label, credential expiry, halt owner, and cleanup owner. Do not record
      endpoints, credentials, raw device rows/tokens, tester identities, or fixture content.
- [ ] **`EXACT PLAY CANDIDATE`:** Establish the ordinary allowed baseline: Android notifications
      allowed, **Message Notifications** on, **Filter Unknown Senders** off, synthetic chat unmuted,
      and App Lock off. Clear only this fixture's old Gator notices before the first observation.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Have the server owner use the dashboard's push
      self-test. Expect the fixed app-authored notification `Gator` / `Test notification received.`.
      Record only sanitized sent/failed totals, the registered-device alias/count and last-active
      date, and a private evidence reference. Never give a tester the server's local-auth command or
      token and never copy a raw provider error into Git.
- [ ] **`EXACT PLAY CANDIDATE`:** Exercise Android notification permission allowed and denied. When
      denied, expect no system notice while socket/sync and in-app message access continue; record
      the app's degraded guidance if shown. Restore the approved baseline through Android settings
      without clearing candidate data.

### 2. Detailed message presentation, taps, and actions

- [ ] **`EXACT PLAY CANDIDATE`:** With the app backgrounded and unlocked, receive a synthetic
      incoming message. Expect one detailed per-chat Android `MESSAGING` notification containing the
      current line, conversation/sender presentation, and a contact avatar or Gator fallback. Do not
      treat it as bounded multi-message history; that remains `NOTIF-03`.
- [ ] **`EXACT PLAY CANDIDATE`:** Use four different synthetic incoming messages because each action
      can clear the notice: body tap opens the intended chat at its newest message; inline **Reply**
      becomes a durable outgoing message; **Mark as read** advances the unread state; and **Love**
      applies to the intended message. A failed Reply before durable queue handoff must leave the
      notice available to retry rather than lose the typed text.
- [ ] **`EXACT PLAY CANDIDATE`:** Open the synthetic chat's notification settings from Gator and
      confirm Android opens that conversation's channel. Record any changed sound/importance value
      so cleanup can restore it.

### 3. Message suppression and known open limitations

Use a new fixture message for each branch and confirm the message still follows the DB/sync path when
its system presentation is suppressed.

| Branch                                                | Current expected result                                                                                                                           | Result |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Android permission allowed / denied                   | Detailed system notice when allowed; no system notice when denied                                                                                 | [ ]    |
| **Message Notifications** on / off                    | Message notice when on; no message notice when off. Self-test, calls, and reminders are separate kinds                                            | [ ]    |
| Known / unknown sender with filtering on              | Known sender notifies; unknown sender is stored but does not notify                                                                               | [ ]    |
| Synthetic chat unmuted / muted                        | Unmuted chat notifies; muted chat is stored but does not notify                                                                                   | [ ]    |
| Incoming / marked `isFromMe` by the approved fixture  | Incoming message notifies; own message does not                                                                                                   | [ ]    |
| Currently visible chat                                | Frozen v56 may still alert; post-v56 source suppresses the exact focused/foreground/unlocked chat. No credit until a future candidate contains it | [ ]    |
| Two unread lines, then read/delete/unsend in one chat | Only the current line is posted; cancellation can clear the whole chat notice. Record open `NOTIF-03`, not a pass                                 | [ ]    |

#### Post-v56 failed-send notice — FUTURE CANDIDATE ONLY

Do not run or credit these rows against frozen v56; it predates `SEND-01C`. Once a separately frozen candidate
contains the post-v56 source, use only an approved synthetic staged-server failure:

- [ ] While viewing the exact chat in the foreground and unlocked, cause one outgoing row to become durably failed.
      Expect the in-chat error state but no system sound, vibration, heads-up, or tray notice.
- [ ] From another screen and from the background, cause separate failures. Expect one fixed `Message not sent` /
      `Open Gator to review and retry.` notice per failed local message, with no message/contact/server-error text;
      body tap opens the owning chat and no inline Reply/Read/Love action is offered. Repeated delivery of the same
      failure must update the same native record without a second alert.
- [ ] Confirm a success/echo or failed-bubble deletion removes the matching notice, a sticky RCS failure is not cleared
      by a late acknowledgement, and an expired App Lock produces only the existing generic `Gator` /
      `You have new messages` notice. Record any stale or duplicate notice as a failure.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Since review item M090, new sends use a longer,
      cryptographically random temporary id (`temp-` plus 16 hex characters). Send one iMessage text
      and one RCS text: each bubble moves from sending to sent without a duplicate. Then make one RCS
      send fail (for example with the phone offline) and confirm its failed bubble and notice match
      that exact message.

Do not test removed Hide Preview/Redacted Mode behavior. Normal notifications are detailed, Android
owns lock-screen presentation, and App Lock's limited generic-new-delivery behavior is tested below.

### 4. Foreground, background, killed-process, and reconnect paths

- [ ] **`EXACT PLAY CANDIDATE`:** Receive separate fixture messages while (1) viewing the synthetic
      chat, (2) foregrounded on another screen/chat, and (3) alive but backgrounded. Record DB/UI
      arrival, system presentation, sound/heads-up behavior, and whether a body tap opens the
      intended chat at its newest message. For frozen v56, a visible chat can clear the notice only
      after DB/UI arrival and may still alert. Post-v56 source instead suppresses native presentation
      for the exact focused, foreground, unlocked chat while preserving the other-screen/chat and
      background branches. Keep `NOTIF-01` open until this is run on a future candidate that includes
      that source; do not award the post-v56 behavior to v56.
- [ ] **`EXACT PLAY CANDIDATE`:** From the alive-background state, tap a message notice and confirm
      the resumed app opens the intended chat at its newest message rather than the previously
      visible screen.
- [ ] **`EXACT PLAY CANDIDATE`:** Prove ordinary killed-process delivery only after Gator has opened,
      connected to the approved staged server, and moved to the background. Run only
      `adb shell am kill com.bluegreengatorapps.messages`, confirm that package has no running
      process, have the staged-server owner trigger a fresh synthetic message, and record visible
      receipt before relaunch. Tap a separate killed-process notification and confirm the cold start
      opens the intended chat at its newest message. Never use `am force-stop`, `am kill-all`, or a
      broad process kill for push evidence.
- [ ] **`EXACT PLAY CANDIDATE`:** Foreground after background and killed-process cases and confirm
      reconnect/sync catches up without losing the synthetic message. Record duplicate or stale
      notices as failures; do not claim that a missing release log line proves success.

### 5. App Lock behavior and its boundary

- [ ] **`EXACT PLAY CANDIDATE`:** With App Lock enabled, confirm a resume inside the configured
      grace period follows the unlocked path and a resume after expiry or a cold launch presents the
      lock gate before private DB-backed UI.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Separate the push axes: App Lock disabled permits
      detailed background and killed-process presentation; App Lock enabled keeps notices generic
      in a still-live process, including after unlock and within its unexpired UI grace period.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With persisted App Lock enabled, a fresh ordinary
      killed-process wake has no trustworthy warm-process grace and must always use the generic path.
      Expect one fixed `Gator` / `You have new messages` notice with no sender, chat title, body,
      avatar, or private route; repeated locked deliveries update the same generic notice.
- [ ] **`EXACT PLAY CANDIDATE`:** Tap the generic notice, unlock, and confirm sync makes the synthetic
      message available in the app. Do not expect a detailed per-chat notice to replay after unlock.
- [ ] **`EXACT PLAY CANDIDATE`:** On a candidate containing the 2026-10-03 privacy repair, first post
      detailed notices with App Lock OFF, then enable it and verify the entire displayed group and
      private conversation-channel names are cleared before success. Repeat with a delivery in
      flight. Verify a generic scheduled reminder still fires, cold persisted ON clears old tray
      content before protected boot succeeds, and disabling restores detail only for fresh posts.
      Play v80 predates this repair and exposed old details after enabling; retain that historical
      failure. App Lock remains a UI/policy gate, not encryption-key custody.
- [ ] **`STATIC/HOST`:** Retain the fail-closed source/test evidence that a locked/unknown lock state
      never reveals content. An enrolled V2 delivery before its exclusive 2027-02-01 cutoff posts
      only the generic notice without opening the database; absent/V1/plaintext state posts no
      notice. Authenticated, active-bound V3 is the sole exception: it may decrypt the transport
      frame in memory and enqueue one canonical row into SQLCipher, then posts the notice only for a new
      durable admission. It never reads/decrypts a queued row, claims, routes, or runs a content
      effect until unlock; invalid, replayed, expired, conflicting, poisoned, or refused V3 input has
      no notice. Do not manufacture vault corruption on the Play candidate or present this as device
      proof.

### 6. Plaintext, encrypted, and unsupported push branches

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Run an enrolled random-key encrypted push in
      background and ordinary killed-process states: V3 for a scoped session, or V2 only before its
      exclusive **2027-02-01T00:00:00Z** cutoff. Disable App Lock before each detailed
      killed-process branch (turning it off asks for the phone's fingerprint or PIN since review
      M241; over adb, answer the system prompt with the device PIN). Confirm absent-state plaintext and password-derived `AEAD_GCM_V1` are
      dropped and recovered only by foreground sync; they are no longer happy paths.
- [ ] **`STATIC/HOST`:** Keep malformed ciphertext, wrong-key/decrypt-failure, and unsupported
      encryption branches as host/static evidence unless the staged-server owner separately approves
      a harmless, finite synthetic fixture. Their current fallback is no live presentation followed
      by later foreground sync; do not improvise hostile payloads during the tester round.
- [ ] **`STATIC/HOST`:** Do not create an `imessage-aliases-removed` candidate test: the current
      Gator server does not emit that event. Test an RCS status notice only if the staged server's
      exact version exposes an approved synthetic route; visible text must stay app-authored and
      generic.

### 7. Reminders and best-effort background work

- [ ] **`EXACT PLAY CANDIDATE`:** Schedule a reminder for a synthetic message, background the app,
      and allow it to fire. Expect fixed generic `Reminder` title/body near, not exactly at, the requested time;
      Gator uses an inexact Doze-capable alarm and requests no exact-alarm permission.
- [ ] **`EXACT PLAY CANDIDATE`:** Tap the fired reminder and confirm it opens the correct
      chat/message and removes that reminder from Gator. Repeat after an ordinary package kill if the
      approved session has enough time; do not use force-stop.
- [ ] **`EXACT PLAY CANDIDATE`:** With App Lock on, let a reminder fire, background the app past
      the lock timeout (or kill it with `adb shell am kill`), then tap the reminder. Since review item
      M102 the tap does no database work before unlock: the lock screen appears, and only after
      unlocking does the chat open and the reminder leave the Reminders list. Unlocking is what
      removes it; if the app is closed again before unlocking, the reminder stays listed.
- [ ] **`EXACT PLAY CANDIDATE`:** On a candidate containing the 2026-10-03 privacy repair, verify
      enabling App Lock preserves an already-scheduled generic reminder and cancels unsafe legacy
      detailed triggers. Keep native alarm/enable races and cancellation failures open until observed.
      Earlier candidate limitations remain historical evidence, not the replacement candidate's policy.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Record one observable, synthetic catch-up result
      after the app has been backgrounded long enough for Android to choose whether to run work.
      Since review item M183, a fresh background worker runs the same DB/sync work with persisted
      App Lock enabled. Registration uses a 15-minute minimum interval, not an exact
      schedule. Success must come from staged-server/UI state or an approved finite diagnostic,
      never absence of free-form release logs.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (review M183):** With App Lock enabled, schedule a
      local message a few minutes ahead and leave a failed send queued, then background Gator and
      lock the phone. Once Android runs background work, the scheduled message and the retry are
      delivered without unlocking. Any notice on the lock screen shows no sender, chat title, or
      message text.

### 8. FaceTime — conditional on capability and `PLAY-02`

Do not run this subsection unless the approved staged server advertises the required FaceTime helper
capability and the release/product owner has approved the `PLAY-02` eligibility and test branches.

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** In foreground, receive a synthetic incoming-call
      event and confirm the in-app overlay appears. Foreground **Answer** resolves the server
      answer/link and presents Gator's external-browser handoff; foreground **Decline** stops the
      overlay and makes a best-effort server leave request.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** In background and ordinary killed-process states,
      receive the CALL-category notification with **Answer** and **Decline**. Full-screen presentation
      is conditional; an actionable heads-up notice is the required fallback, not proof that the
      build is broken. Record Android version and full-screen special-access allowed/denied state.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Notification **Answer** asks the server to answer,
      opens only a validated FaceTime link through Android `Linking`, and clears the ring. Do not
      promise a Chrome custom tab. Notification **Decline** clears only the local ring; unlike the
      foreground overlay, it does not send server leave. Record this distinction for `PLAY-02`.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Confirm the server's ended status clears the
      active ring. Keep Android 16/17 allowed/denied full-screen coverage and browser
      camera/microphone hostile-navigation evidence open under `PLAY-02`/`DEVICE-01B3`.

### 9. Cleanup and privacy-safe evidence

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Record only candidate/session fields, synthetic
      aliases, action/outcome, aggregate counts, date, and approved private evidence references.
      Never commit raw `logcat`, unredacted `dumpsys`, raw push payloads/errors/tokens, endpoints,
      credentials, QR data, message content, filenames/paths, tester identities, serials, or private
      screenshots.
- [ ] **`EXACT PLAY CANDIDATE`:** Dismiss fixture notifications/calls/reminders, restore changed
      Android permission/channel/full-screen settings, and Disconnect. Confirm the visible notices
      are gone, Gator returns to Welcome with no prior-account UI, and any incomplete-cleanup error
      remains visible.
- [ ] **`STATIC/HOST`:** Retain source/test proof that Disconnect calls native notification/route
      cleanup and Firebase `deleteToken()`. Those internal calls are not directly observable tester
      evidence and must not be inferred from a clean-looking screen.
- [ ] **`STAGED-SERVER`:** The app does not delete its server device row. Have the server owner
      remove and verify that row separately, retire synthetic data/credentials, and record only a
      private cleanup reference. Remove tester access and private captures under the approved
      `STORE-01G` teardown procedure.

---

## Current matrix slice 2: data, files, and native storage — PREPARED, NOT EXECUTED

This section supersedes historical section (f) as a candidate instruction, section (h), the media
viewer and parallel-download rows of section (j), all of section (j.1), and the document/sticker
rows of section (z). Section (f)'s checked DEV results remain supporting history only. Section (z)'s
Redacted Mode rows are retired as removed-behavior history with no replacement test. Do not begin
this slice until every applicable section (a) preflight is complete, `STORE-01G-TESTER-READINESS` has its
approved owner inputs and dry runs, and the owner separately approves Play distribution, staged
fixture use, and device execution.

Use only bounded synthetic files and messages on the approved isolated server. Do not do any of the
following: rebuild or sideload the frozen candidate; use `run-as`; inspect private DB, WAL, cache,
ledger, or `.part` paths; fabricate private files; clear app data; uninstall apps to force a branch;
or capture raw logs. Stop on any candidate/server mismatch, production data, uncontrolled transfer,
unexpected tester access, private evidence leak, cleanup failure, or server activity outside the
approved fixture.

### 1. Candidate branch, fixtures, and applicability

- [ ] **`EXACT PLAY CANDIDATE`:** Reconfirm section (a), then record the clean-install or approved
      prior-build Play-update branch, device/API/ABI, fixture-set alias, and private evidence
      reference. Do not reuse a development install or the historical version-code-39 session.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Before transfers, have the server owner verify a
      finite synthetic set: searchable text plus edit/delete variants, an optional attributed-body
      message, small/large/slow downloads, three uploads, PDF, VCF, two images in one chat, video,
      ordinary photo, and sticker. Record only fixture labels, size classes, expected request counts,
      expiry, stop owner, and cleanup owner.
      Missing delayed-transfer, observer, or sticker support is `BLOCKED/OPEN`, never silently `N/A`.

| Branch or condition               | Current rule                                                                                                                                                                          | Result |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Clean Play install                | Exercise current-data persistence/search and current file flows. Record legacy DB/cache/shortcut upgrade as `N/A — clean-install branch selected`; that does not close update work    | [ ]    |
| Approved prior-build Play update  | Name the exact Play-delivered baseline and its version code first. Populate only synthetic state, update through Play without uninstall/clear-data, and test visible continuity       | [ ]    |
| No approved prior Play baseline   | Leave migration, legacy-layout, and old-shortcut continuity `BLOCKED/OPEN`. Do not substitute a sideloaded build, DEV fixture, or source inspection                                   | [ ]    |
| Selected Android support boundary | Android 16 / API 36 is the minimum and Android 17 / API 37 is the current latest. The exact candidate must enforce API 36 in artifact/Play metadata and run on both boundary versions | [ ]    |

### 2. Database persistence, search, and visible key-rotation continuity

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Receive a synthetic ordinary message containing
      a unique non-secret search token. If the approved server fixture supports an attributed-body
      message, receive that separately. Search each token and tap its result; the intended chat
      opens centered on the matching message. Do not use a subject-only token as a positive case;
      subjects are not indexed.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Have the owner edit one synthetic searchable
      message and delete/unsend another. The replacement text becomes searchable, the old token
      stops matching, and the deleted message disappears from search. Record only result aliases,
      never the search text or message body.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Since review item M060, a search inside a
      custom folder reads its message matches in short batches. On a phone with a large history,
      search a very common word inside a small folder while the owner sends you a synthetic message:
      the results appear, the new message arrives promptly, and the app never freezes for seconds.
      Typing several letters quickly settles on the last search without a backlog. Record only
      timings and result counts, never the search text.
- [ ] **`EXACT PLAY CANDIDATE`:** Enter a synthetic chat draft and change one non-secret setting,
      then background Gator and run only
      `adb shell am kill com.bluegreengatorapps.messages`. Relaunch from the launcher and confirm
      the conversations, messages, draft, and setting remain usable and rerunning the same searches
      finds the expected synthetic results. Never use force-stop, clear storage, or uninstall for
      persistence evidence.
- [ ] **`EXACT PLAY CANDIDATE`:** From Settings, use **Rotate encryption key…**, require the visible
      **Database key rotated.** result, ordinarily kill/relaunch, and reconfirm the same synthetic
      state and search. Credit this only as visible rekey continuity; it does not prove ciphertext,
      wrong-key rejection, key custody, or crash-at-each-rotation-step recovery.
- [ ] **`STATIC/HOST` + `LOCAL-DEV SUPPORTING ONLY`:** Keep the fixed native DB contract, relaunch,
      WAL-write-death, and active-migration-death harnesses in their disposable DEV lane. They
      require a debuggable app, Metro/markers, and private fixed fixtures and cannot run on or award
      credit to version code 56. Production-file continuity, wrong-key/integrity proof,
      spontaneous death, power loss, torn writes, and release-candidate migration internals remain
      open even when user-visible persistence passes.

For an approved Play-update branch, additionally confirm the baseline's synthetic messages, search
hits, drafts, settings, and downloaded-file affordances remain usable after the Play update. That is
visible continuity only; it does not identify which internal migration, cache-ledger adoption, or
legacy-shortcut cleanup path ran. A clean-install result must not be relabeled as update evidence.

### 3. Attachment download policy, progress, interruption, and cache boundaries

- [ ] **`EXACT PLAY CANDIDATE`:** Record and later restore **Auto-download Attachments**, **Only on
      Wi-Fi**, **Parallel Downloads**, and the **SAVE AUTO-DOWNLOADED IMAGES TO** choice. Start with
      **App only**, auto-download on, Wi-Fi-only off, and parallel downloads set to two. Do not infer
      these settings from an older account or build.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Receive a known-size ordinary image no larger
      than 5 MiB and confirm it downloads automatically. Separately receive an image above 5 MiB
      but within the manual ceiling and one with absent size metadata; neither starts automatically,
      while a user tap may start the bounded manual path. Malformed or non-positive metadata fails
      closed rather than starting either path. A sticker is checked separately below.
- [ ] **`EXACT PLAY CANDIDATE`:** Since review items M160/M164 the native download writes only its
      own temporary `bounded-download-parts/request-…part` file, and a failed shared-file copy
      removes only a file it created. Confirm a received image still downloads and opens, a synced
      chat background or contact photo still appears, and sharing a photo into Gator still attaches it.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With **Only on Wi-Fi** enabled, use the approved
      bounded image on Wi-Fi and away from Wi-Fi. Automatic work starts only on confirmed Wi-Fi;
      an unknown network fails closed. Restore the approved network and setting afterward.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Manually fetch finite synthetic image, video,
      audio, and document fixtures. Confirm visible progress or an indeterminate state and verified
      completion. Image, video, and document failures show an explicit retry state; audio instead
      returns to **Voice message · tap to load** without naming the failure, and a second tap retries.
      Record that audio-label limitation rather than passing a universal error affordance. Confirm
      cached reopen without a second request, but do not infer exact byte or deadline enforcement
      from a successful visible transfer.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Set **Parallel downloads** to one, request three
      fixtures, and require at most one observed transfer; repeat at two and require at most two.
      Pair the visible state with sanitized aggregate server concurrency, not packet capture or raw
      logs. Restore the original value.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Start the approved delayed download, background
      Gator, run only `adb shell am kill com.bluegreengatorapps.messages`, and relaunch. The item
      must not appear falsely complete; a tap retries and can finish. Do not inspect or claim exact
      `.part`, reservation, ledger, or native-delete cleanup from this visible result.
- [ ] **`EXACT PLAY CANDIDATE`:** If an ordinary, naturally missing completed file is encountered,
      tap it and confirm the UI returns to a download/retry path instead of silent failure. Do not
      clear Android cache—final attachments live in persistent app-private files—or manufacture a
      missing path. Without a natural case, leave this branch `BLOCKED/OPEN`.
- [ ] **`STATIC/HOST` + `LOCAL-DEV SUPPORTING ONLY`:** Retain exact-byte/time caps, `.part` cleanup,
      ledger ownership, symlink/malformed/zero-byte rejection, two-generation recovery, 2 GiB /
      4,096-file / 512 MiB-free quota enforcement, protected-reader/outgoing paths, and legacy
      layout adoption as controlled evidence. Do not manufacture these on an ordinary tester
      phone. API 24/25 is outside the owner-selected product boundary; retain the native fail-closed
      path as defense in depth, and prove the exact candidate on Android 16 / API 36 and Android 17 /
      API 37 instead.
- [ ] **`LOCAL-DEV SUPPORTING ONLY` (`REVIEW-888`):** On a disposable debuggable build, seed more
      than 8,192 small legacy files with `adb shell run-as <dev-package>` (for example 9,000
      `files/attachments/legacy-N/photo.jpg`), then repeat with about 17,000 one-file folders so the
      32,768-entry limit also overflows. Relaunch: the "New downloads are paused…" warning appears on
      every launch and a tap on a not-yet-downloaded image does not download. Settings → Storage &
      File Privacy → **Repair Downloads** → Repair: progress counts up, the result names how many
      files were removed, the warning is gone, the seeded files and their emptied folders are gone
      (no message refers to them), and a real attachment now downloads. Relaunch shows no warning.
      With a few real downloads among more than 4,096 files, the oldest are removed first and tap to
      download again. Also seed about 25,000 empty folders: the repair removes them. With less than
      512 MiB free, the result must say new downloads may still be refused, not that they work.
- [ ] **`EXACT PLAY CANDIDATE` (`REVIEW-888`):** With downloads working, Storage & File Privacy shows
      no Repair Downloads row. Do not manufacture an oversized cache on a tester phone; if an upgrade
      naturally shows the paused-downloads warning, run Repair Downloads and record the result.
- [ ] **`LOCAL-DEV SUPPORTING ONLY` (review M208):** On a disposable debuggable build, give a
      synthetic contact that exists only on the Mac a photo and let Gator show it. Change the photo on
      the Mac, then reopen Gator until the new photo shows. Listing the photo folder with
      `adb shell run-as <dev-package> ls -R files/server-contact-avatars` must show one file for
      that contact, not the old and new versions. Record only the file count.

### 4. Multipart uploads, concurrency, and cancellation

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Send finite synthetic files selected once from
      Photos and once from Files. Confirm the optimistic bubble and composer upload status. Media
      bubbles show a progress ring/byte overlay; a generic file chip instead shows an activity
      indicator plus byte/percent subtitle. Confirm the delivered result and removal of progress UI
      after settlement. Native multipart progress requires this device result; host mocks do not
      prove it.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Send the approved three-file batch. The server's
      sanitized aggregate must observe no more than two simultaneous upload requests, matching the
      fixed production upload gate. Record counts only, not URLs, headers, names, GUIDs, or bodies.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** During the delayed active upload, long-press its
      bubble and confirm **Cancel Sending**. The bubble disappears, but that alone is not proof:
      require the server owner to confirm request cancellation/connection close, or a stable byte
      count across the approved bounded observation window plus no completion. A single “started,
      not completed yet” snapshot is insufficient.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Occupy both upload slots, queue a third approved
      fixture, then cancel the third before a slot opens. Require zero upload starts for that third
      fixture in sanitized server evidence. Restore fixture/server state before another run.

Foreground uploads intentionally have no transport timeout, and the documented large-batch retry
interaction after roughly 60 seconds remains open. Do not turn “eventually finished” into timeout
or retry-safety evidence. Keyboard and wallpaper presentation of the upload bar belongs to the
ordinary visual-device matrix; accessibility-specific presentation is outside remediation scope.

### 5. Document open, media viewer, outbound share, and Photos save

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** For an undownloaded synthetic PDF and VCF, the
      first tap downloads; after completion, tap again. Expect an installed viewer/importer or the
      Android share-sheet fallback—never silence. Record which branch occurred without changing
      default handlers on a personal tester device.
- [ ] **`EXACT PLAY CANDIDATE`:** If the approved controlled device naturally has no matching
      viewer, confirm the share sheet opens or Gator shows **No app on this device can open …**. Do
      not uninstall apps to force the branch. Otherwise leave exact-native no-handler proof open
      and retain the host result.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Stage at least two downloaded images in one chat,
      open one from its bubble, and confirm fullscreen gallery paging plus the conditional
      current-item counter. Confirm a downloaded video plays inline from its chat bubble; then open
      that video deterministically from Chat Settings → Shared Media and confirm fullscreen native
      controls. Share the currently visible gallery item and confirm Android's outbound share sheet
      opens. A returned share sheet counts as opened even when the user cancels it.
- [ ] **`EXACT PLAY CANDIDATE`:** Save the current synthetic image to Photos and require the visible
      success result plus the actual external copy. On Android 13+ record the expected no-prompt
      branch when it occurs; test permission denied only on a platform/device that actually asks,
      without altering unrelated media access. An exported copy is not app-private cleanup.
- [ ] **`EXACT PLAY CANDIDATE`:** Exercise an unavailable or failed share/save result only when it
      occurs naturally or on a separately approved controlled device. Require Gator's dialog/toast
      rather than silence; do not infer the native failure from a button tap alone.

**Supporting observation — 2026-09-02; `LOCAL-DEV SUPPORTING ONLY`, no checkbox or candidate
credit:** A rebuilt `0.1.41` debug client on a physical Samsung device recovered and immediately
rendered the existing 186,575-byte synthetic image after an in-place reinstall and fresh DEV-session
seed. The current item reported `1 of 3`; Share foregrounded Android's chooser, and Save created an
exact 186,575-byte `DCIM/media-keynote.jpg` MediaStore row without a permission prompt. Only that
new synthetic external row was deleted after verification; the app-private source remains. No share
suggestions or unrelated MediaStore rows were inspected. Video, staged-server, and exact
Play-candidate results remain open.

### 6. Owned inbound sharing and outbound preservation (`SHARE-02`)

The former disabled-intake checks are retained in the historical IPC-01 proof. Current source uses
only the product-owned bounded intake described in
[`SHARE_02_DEVICE_PROOF_2026-09-28.md`](./SHARE_02_DEVICE_PROOF_2026-09-28.md).

- [x] **`LOCAL-DEV SUPPORTING ONLY` — host/native boundary:** The third-party
      `expo-share-intent` pre-handler remains absent. Owned intake policy/storage proof passed 29/29,
      final native token proof passed 3/3, and focused JavaScript shortcut/navigation proof passed
      2 suites / 31 tests. This does not provide packaged-candidate credit.
- [x] **`LOCAL-DEV SUPPORTING ONLY` — hostile provider:** On the API-36 Samsung, exercise provider
      open failure, false/actual over-size, empty/midstream failure, 11 items, aggregate overflow,
      traversal-style names, the 60-second stalled-provider bound, process restart cleanup, and a
      normal control. The app remained usable and no shared content was sent.
- [x] **`LOCAL-DEV SUPPORTING ONLY` — payload/routing:** Exercise generic plus opaque Direct Share
      routing for text, one image, a real video, a PDF, and two ordered images. Verify the selected
      target or recipient review receives one exact staged batch, then discard it without sending.
- [x] **`STATIC/HOST`:** The frozen SHARE slice passed strict TypeScript, 2 Node suites / 51 tests,
      3 component suites / 133 tests, and the exact SHARE certificate 1/1. Its 21 reviewed records
      are unique with zero stale or mismatched ids. Unrelated global scanner drift remains open and
      is not represented as task-local failure or success.
- [x] **`EXACT PACKAGED CANDIDATE`:** The current AAB's merged/protobuf manifest, generated
      `<share-target>`, owned activity hooks, autolinking, and DEX passed the focused 3/3 contract.
      Both owned modules and generic `SEND`/`SEND_MULTIPLE` are present; `expo-share-intent` is
      absent. The full release guard remains separately red for deferred Maps metadata and reviewed
      native-symbol path findings.
- [x] **`VERSION-INCREASING UPGRADE` + `FRESH INSTALL`:** Without clearing data for the upgrade,
      repeat bounded generic and Direct Share text/image/video/PDF/single/multiple routing across
      warm, cold, and background entry. A real code-1-to-code-2 no-wipe upgrade preserved first
      install time and completed all ten conservative route/payload pairs. The connected
      embedded-release fresh-install/background replay routed every required representative batch
      once, then a killed relaunch showed no retained composer or replay. Nothing was sent.
- [x] **`OWNER-AUTHENTICATED APP LOCK`:** With the owner present, enabling App Lock removed all
      personalized Direct Share targets. A killed-app generic image revealed no shared content
      behind the lock gate; after fingerprint authentication it routed once with one attachment,
      was discarded, and did not replay. The original App Lock-off setting was restored.
- [x] **`EXACT PLAY V78, PRE-SHARE-02 SUPPORTING CONTROL`:** Ordinary outbound sharing of downloaded
      synthetic media opened Android's chooser under completed `FEAT-07`. Repeat only if the frozen
      SHARE-02 candidate changes the outbound bridge.
- [ ] **`EXACT PACKAGED CANDIDATE` — copied-share descriptors (added 2026-10-11):** Share and send
      one synthetic image, let the batch clean up, then run
      `adb shell ls -l /proc/$(adb shell pidof com.bluegreengatorapps.messages)/fd` and confirm no
      entry points into `shared-in` or the copied attachment. Before the fix each successful copy
      left both descriptors open, keeping deleted files' space allocated. Host evidence is only a
      source-shape test.
- [ ] **`EXACT PACKAGED CANDIDATE` — share rejection shown once (M168, added 2026-10-18):** With
      Gator open, share 11 synthetic photos into it: one "too many items" message appears. Background
      Gator, run `adb shell am kill com.bluegreengatorapps.messages`, and relaunch from the launcher:
      the message does not appear again. Host evidence covers only the JS bridge.
- [ ] **`EXACT PACKAGED CANDIDATE` — unreadable share does not block sharing (M169, added
      2026-10-18):** Smoke only: share one synthetic photo and one PDF into Gator and send them; both
      still route and send. The unreadable-claim path itself (discard, message, next share staged) is
      host-tested only, because a real device cannot produce an unreadable claim on demand.
- [ ] **`EXACT PACKAGED CANDIDATE` — sent or removed shared files stay gone (M224, added
      2026-10-18):** Direct Share one synthetic photo with a caption into a chat, send it, then press
      Back: no "Discard shared item?" prompt and no attachment returns to the tray. Then share two
      photos into New Message, remove both, and pick an existing chat: neither photo reappears.
- [ ] **`EXACT PACKAGED CANDIDATE` — opening attachments in other apps (M202, added 2026-10-18):**
      Open a received synthetic PDF from its chat bubble, a contact card from its bubble, and a
      document from the chat's shared documents: each opens in its viewer. For a type with no viewer
      installed, the share sheet still appears. Opening now pins the file and passes the same native
      ownership check as sharing, so a file being cleaned up reports as missing and re-downloads.

### 7. Received stickers

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Deliver an approved synthetic sticker onto a
      synthetic target message. It appears as a small overlay on that target, not as its own
      separate message bubble. A temporary pending tile before attachment sync is allowed.
- [ ] **`EXACT PLAY CANDIDATE`:** Tap the downloaded sticker to fade it and tap again to restore it;
      long-press to hide it for the current screen session. Leave and reopen the chat and confirm
      the session-only hide has reset.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Record whether the live sticker becomes visible
      immediately or only after leaving/reopening the chat. This observation informs `STICKER-4`;
      it does not close that decision automatically. The Craig DEV seed is supporting-only and
      cannot replace this result.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With export-to-Photos/Gator enabled, receive one
      ordinary synthetic photo and one sticker. The ordinary photo follows the selected export
      behavior; the sticker creates no Photos/Gator copy and no “Downloaded 1 image” toast. Restore
      the setting and delete the ordinary exported copy during cleanup.

### 8. Storage disclosure, cleanup, and privacy-safe evidence

- [ ] **`EXACT PLAY CANDIDATE`:** Open Settings → **Storage & File Privacy** and confirm it clearly
      separates the SQLCipher database from ordinary app-private files, states the cache/API limits,
      and explains exported-copy and Disconnect boundaries. Treat the current “incoming-share
      copies” wording as legacy-copy disclosure only; it is not evidence that inbound sharing is
      enabled. Record any ambiguity as a candidate wording issue.
- [ ] **`EXACT PLAY CANDIDATE`:** Close viewers/share sheets, finish or cancel every fixture
      transfer, restore every download/export setting changed by this slice, and Disconnect. Confirm
      Welcome, no prior-account UI, and a visible incomplete-cleanup error if cleanup cannot be
      confirmed. Do not connect account B or claim full A→B isolation from this row;
      `DEVICE-01B3` owns that combined transition.
- [ ] **`EXACT PLAY CANDIDATE`:** Inventory every external copy actually created by this slice—such
      as a Photos gallery/Gator album export or a receiving-app/Files/Drive copy. Confirm Disconnect
      does not remove it, then delete each synthetic copy in its owning app. If an approved backup
      copy exists, include it in the same cleanup. Uninstall/clear-data is not a substitute and does
      not remove exported media.
- [ ] **`STAGED-SERVER`:** Have the owner verify transfers are settled/cancelled, delete synthetic
      messages/files and any remaining device row, retire credentials, and record only sanitized
      aggregate outcomes plus a private cleanup reference. App-visible cleanup does not prove
      server cleanup.
- [ ] **`STATIC/HOST` + `EXACT PLAY CANDIDATE`:** Record only branch/device labels, fixture aliases,
      file class and size bucket, action/outcome, aggregate request/byte counts, elapsed-time bucket,
      date, and private evidence reference. Never commit message/search text, filenames, paths,
      identities, serials, raw logs, DB/WAL/cache files, screenshots with private suggestions, or
      secrets. Delete approved private captures after review.

### 9. Claims that remain outside ordinary candidate observation

| Claim                                                                                        | Required evidence / current disposition                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Database ciphertext, wrong-key rejection, integrity, crash-step rekey, WAL/torn-write safety | Separate approved native design; fixed DEV fixtures are supporting only and visible candidate continuity cannot close it              |
| Migration transaction internals, legacy cache adoption, old shortcut cleanup                 | Approved natural Play-update baseline plus host/native proof; clean install is session-N/A, not program completion                    |
| `.part`/ledger/native-delete correctness, exact caps, quota/low-space pressure               | `STATIC/HOST` and separately approved disposable native evidence; never infer from a retry or manufacture on an ordinary tester phone |
| Multipart byte progress, active byte-stop, queued zero-start, maximum two uploads            | `EXACT PLAY CANDIDATE` plus privacy-safe `STAGED-SERVER` aggregate evidence                                                           |
| FileProvider/viewer/share/save bridge and natural missing-file recovery                      | Exact candidate observation when the branch is naturally reachable; host mocks alone do not prove it                                  |
| Selected minimum/latest Android support                                                      | Exact candidate declares API 36 minimum in artifact/Play metadata and passes on Android 16 / API 36 plus Android 17 / API 37          |
| Full account A → Disconnect → account B isolation                                            | `DEVICE-01B3`, coordinated with this slice's external-copy and server cleanup; Welcome-screen appearance alone is insufficient        |

All rows above remain open. This offline reconciliation did not execute a Play install, database
rotation, search, transfer, share, save, sticker, Disconnect, device command, or server action.
`DL-01`, `SHARE-01`, `FILE-01A`, parent `DB-03`/its residual native work, `STICKER-4`, `PLAY-02`,
`STORE-01G`, and `DEVICE-01` retain their existing open or blocked status.

---

## Current matrix slice 3: permissions, UI, and account transition — OPEN EXCEPT COMPLETED `UI-01`/`THEME-01A`/`HANDLE-COLOR-01`

This section supersedes the remaining UI rows of historical section (j), all of section (k), and
stale permission, embedded-browser, theme, and account-switch instructions elsewhere in the old
matrix. Functional transfer/viewer results remain owned by slice 2, and notification/App Lock/
FaceTime-alert results remain owned by slice 1. Do not begin this slice until section (a) is complete,
`STORE-01G-TESTER-READINESS` has approved owners and dry runs, and the release owner separately
approves Play distribution, the device session, controlled OS-setting changes, and both synthetic
server identities used for account isolation. The bounded owner-authorized Play-v78 `UI-01` and
`THEME-01A` reviews and the local-debug `HANDLE-COLOR-01` review in section 5 are the completed exceptions; they do
not execute or close any other row.

For every remaining row, use only its explicitly approved Play-installed candidate, controlled tester
profiles, synthetic contacts, neutral media, non-sensitive coordinates, and bounded staged-server
fixtures. Do not rebuild, sideload, clear app data/cache/defaults, uninstall
or disable handler apps, use `run-as`, capture raw logs/QR payloads/private paths, install an
interception certificate or proxy on a personal device, or manufacture cleanup, permission, storage,
browser, or native failures. Stop on production data, an unexpected permission or intent, private
evidence exposure, account-B admission after an incomplete cleanup, uncontrolled external traffic,
or a setting that cannot be restored safely.

### 1. Candidate state, fixtures, and Android applicability

- [ ] **`EXACT PLAY CANDIDATE`:** Reconfirm section (a), then record the clean/update branch,
      Android/API, navigation mode, OS appearance, display/font state, permission baseline,
      launcher state, and private evidence reference. Record existing grants rather than resetting
      the app to force a first prompt.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Approve two isolated synthetic server identities
      A and B, one shared synthetic participant identifier where practical, a synthetic device
      contact, controlled URL observer, optional finite Find My/FaceTime/send-contact capabilities,
      and cleanup owners. Record aliases and capability flags only—never endpoints, credentials,
      QR data, contact details, coordinates, or message text.

| Device/session condition                                              | Current rule                                                                                                                                 | Result |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Android 16/API 36 minimum boundary                                    | Exercise full, selected/limited, and denied media access when offered; selected access must expose only approved synthetic items             | [ ]    |
| Android 17/API 37 current-latest boundary                             | Repeat permission and Android-owned-settings behavior on the current latest release; do not infer it from the API-36 result                  | [ ]    |
| Android below 16/API 36                                               | Runtime permission testing is not applicable because the exact candidate and Play metadata must refuse installation                          | [ ]    |
| Missing optional Find My, FaceTime, or send-contact staged capability | Leave that positive result `BLOCKED/OPEN`, except send-contact may be session-N/A when the exact server truthfully advertises it unsupported | [ ]    |

### 2. Runtime permissions and Android-owned settings

- [ ] **`EXACT PLAY CANDIDATE`:** On the setup QR screen, denial leaves the camera rationale and
      **Enter Manually** usable; an allowed branch scans only the approved synthetic QR. Do not
      record, capture, or retain the raw QR payload in evidence; successful connection is expected
      to persist the normalized server credentials in the secure vault. Never treat successful
      manual entry as camera-permission proof.
- [ ] **`EXACT PLAY CANDIDATE`:** Opening the attachment tray exercises the current photo/video
      prompt. Full or selected/limited access shows only permitted synthetic media; denial shows
      Settings recovery while Camera and Files remain usable. Record that the tray currently asks
      without a separate in-app rationale as the open `ONBOARD-01` gap, not a pass. No Music/audio
      library prompt is allowed.
- [ ] **`EXACT PLAY CANDIDATE`:** Tapping the composer **Camera** requests camera only. Denial shows
      inline Settings guidance; allowance opens the camera and may cancel or stage one neutral
      photo without a microphone prompt. The action remains deliberately photo-only: no fresh-video
      capture control is expected. Selecting and sending an existing synthetic gallery video remains
      covered by the attachment and upload checks below.
- [ ] **`EXACT PLAY CANDIDATE`:** Tapping voice record requests microphone access. Denial or a native
      request failure closes the recorder and shows the fixed recovery guidance; allowance records
      only silence or a neutral tone and can cancel without sending private speech.
- [ ] **`EXACT PLAY CANDIDATE`:** Merely connecting or resuming does not prompt for Contacts when no
      grant exists. Explicit **Sync Contacts** may prompt; denial explains system-settings recovery,
      while allowance reads the synthetic-only address book and reports bounded counts.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** When send-contact is advertised, its explicit
      picker distinguishes cancellation from denial and sends only the approved synthetic card.
      Cancellation sends nothing; denial explains recovery. Restore/remove the synthetic contact
      afterward. A server without the capability must not show the Contact action.
- [ ] **`EXACT PLAY CANDIDATE`:** Each chat-settings photo picker requests access only after its
      explicit action, accepts the platform's allowed branch, and shows fixed denial/unavailable
      guidance without a stale-account dialog. Use only neutral synthetic media.
- [ ] **`EXACT PLAY CANDIDATE`:** The battery-reliability row opens Android's general battery list
      or the OEM App-info fallback and never a direct-exemption prompt. Exit without changing the
      battery policy. Notification permission remains slice 1; Photos save permission remains
      slice 2; full-screen-call settings remain `PLAY-02`.

An OS grant or denial persists across Disconnect by design. Restore only permission and Android
settings changed by this slice. A missing platform branch is session-N/A only; it does not close
the corresponding product/API task. Any Write Contacts, Music/audio-library, exact-alarm, overlay,
or Do Not Disturb access prompt is an unexpected failure.

### 3. External browser, Maps, and disabled embedded-WebView paths

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Mount a message containing an approved controlled
      HTTPS URL whose page names one controlled JPEG/PNG image. The card loads automatically and
      always shows/speaks the hostname derived from the message URL, even when page metadata claims
      another brand. Device traffic goes only to the configured Gator server; the controlled target
      sees the staged server's request/IP and never a direct phone request. The image renders only
      from returned bounded bytes, never a remote URL. Reopening/coincident duplicate cards reuses
      bounded app cache/in-flight work. A tap may still hand the original URL to the system browser.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Exercise the preview fixture's public-to-private
      page redirect, mixed public/private DNS answer, rebinding, nested image redirect, redirect
      loop, slow/stalled response, forged content type, compressed expansion, and chunked-over-limit
      branches. The server returns only fixed typed failures or safe text degradation; protected
      targets receive zero requests, the phone never contacts any target directly, no partial card
      is cached, and cancellation/account or server rotation frees queued/active work.

  **Separately authorized out-of-matrix engineering observation — 2026-09-13
  (`LOCAL-DEV SUPPORTING ONLY`; no checkbox credit):** this run did not execute or relax the
  prepared matrix above. A nondebuggable locally assembled `0.1.42` / code-1 APK (SHA-256
  `08702f18c76cabd05b159d2b472c5068f26c908788e9122a522bf90542b36cc9`) on the API-36 Samsung used
  USB reverse to a loopback server built from `76097f75`. The source map generated alongside its
  embedded JavaScript bundle exactly matched the five preview endpoint, loader, hook, bubble, and
  card files at app commit `4b89431`. Two
  existing outbound messages containing public Apple URLs were opened; no message was sent or edited,
  and no message text was retained in proof artifacts. They automatically rendered two accessible
  cards and two native image nodes; a card-only crop visibly contained decoded artwork, title,
  summary, and the message
  URL's hostname. The crop, full capture, and UI hierarchies were deleted. Two Wikipedia article
  links that exceeded the HTML limit returned fixed `413 url_preview_too_large` failures; the one
  opened on Android stayed visible as a raw link.

  During a fresh-cache repeat, an 80-sample app-UID socket baseline and a 150-sample preview window
  contained the same one pre-existing external HTTPS destination and the USB-forwarded Gator
  endpoint; no new direct web destination appeared while both cards/images loaded. This is bounded
  connection sampling, not authoritative packet capture, and the public pages were not owned
  controlled fixtures. A network-off repeat was ineligible because Android's network-status signal
  correctly put the app in Offline mode before preview admission. The temporary daemon's database
  and logs were isolated, but its stock standalone entry was later found to share Gator's Keychain
  namespace and Auto Start reconciler. After shutdown, no data-key modification was observed—the
  item's recorded modification date predated the run—but that does not establish whether it was read.
  The LaunchAgent's absence matched the documented saved-off state, real-home upload staging was
  absent, and the installed production Gator listener remained healthy. Therefore the two
  candidate/staged-host boxes above remain open.

- [ ] **`STATIC/HOST` + `EXACT PLAY CANDIDATE`:** Retain scheme-allowlist proof and stage inert
      `intent:`, `javascript:`, `file:`, and `content:` text. It must not become an in-app actionable
      link or open another app. Do not attempt to make Android execute a rejected value.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With a finite synthetic Find My coordinate, prove
      Find My renders only the server-provided point, never invokes Android's location prompt or
      phone-location layer, and limits external handoff to the explicit Find My **Open** action. Also
      exercise a synthetic received shared-location card; its explicit action may hand its finite
      point to the system Maps app. These server/received-coordinate flows are separate from sending
      this phone's Current Location. Without finite fixtures, leave this result open.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (`REVIEW-800`):** Settings → Change Server
      Address… with the server's new address: the approval prompt opens, the password manager can
      fill the password, a tap outside the card does not cancel, and approval reconnects with every
      chat, draft and setting intact. Then repeat and run `adb shell am kill <package>` right after
      tapping Approve: on reopen Gator must use either the old or the new address, never Setup or a
      wiped local state. Afterwards confirm push notifications still arrive. Entering a different
      Mac that accepts the same password must be refused. With a password manager that opens its
      own unlock screen, the prompt may close; Continue on the still-open screen offers it again.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (`FEAT-05A`):** Confirm the installed package declares
      coarse/fine foreground location but not background location or
      `FOREGROUND_SERVICE_LOCATION`. In a proven existing one-to-one supported conversation, the
      Current Location control appears only with `supports_imessage_location`; SMS, group, reply-mode,
      old-server, and stale-account cases expose no action. Confirmation must precede Android's
      permission prompt.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (`FEAT-05A`):** Exercise approximate and precise
      grants and record one server receipt from one foreground fix. Then separately exercise prompt
      cancellation/denial, permanent denial, services off, acquisition error, the 15-second timeout,
      backgrounding before a fix, capability revocation, and Disconnect. Every non-success
      case must create no optimistic message/queue row and make no location POST; no delayed result may
      cross accounts.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (`FEAT-05A`, added 2026-10-11):** With Google
      Location Accuracy off (GPS on), send Current Location. No "turn on location accuracy" dialog
      may appear; the send either succeeds or shows a timeout/error, never silently does nothing.
      Before the fix, that dialog backgrounded Gator and the chat screen cancelled the send.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE` (`FEAT-05A`):** After one successful fix, force a
      temporary server failure and prove the SQLCipher-encrypted outgoing row retains the exact
      coordinate and original idempotency key. Retry must not reacquire location and must stop before
      the snapshot reaches 15 minutes; an expired, malformed, terminal-uncertain, or
      capability-disabled row must not POST. Observe background/killed recovery without granting or
      declaring background location access.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** If the approved conditional FaceTime fixture
      exists, answering/starting shows Gator's browser handoff and then a system-owned custom tab or
      browser—never an embedded WebView. Do not require Chrome specifically. Any camera/microphone
      prompt belongs to the browser, not Gator, and does not close `FACE-01` or `PLAY-02`. If the
      foreground fallback overlay's explicit **Open** action is naturally refused, Gator shows
      `Couldn’t open this outside Gator.`
- [ ] **`STATIC/HOST`:** Retain proof that no production source mounts `react-native-webview`, Find
      My uses a disabled placeholder, and FaceTime validates its Apple link before external handoff.
      URL-preview retrieval must remain capability-gated through the authenticated `HttpClient`
      endpoint, and preview artwork must accept only bounded JPEG/PNG data URIs. No production path
      may directly fetch a message URL or mount a remote preview-image URL. The WebView dependency
      may remain installed; do not claim it is absent or that host/visual inspection proves native
      packet, image-decoder, or hostile-network behavior.

Do not uninstall browsers, Maps, Contacts, or viewers to force no-handler behavior. If a message
preview, Chat Settings Shared Media link, Find My **Open**, shared-location card, or foreground
FaceTime fallback-overlay **Open** action naturally fails, require `Couldn’t open this outside Gator.`
while its initiating source and account are current, never silence, and no delayed toast after
leaving or Disconnect. Otherwise leave the exact-native failure branch open and retain only the host
result.

### 4. Keyboard, navigation, chat layout, reactions, and effects

- [ ] **`EXACT PLAY CANDIDATE`:** With gesture navigation and no wallpaper, repeatedly show/hide the
      chat keyboard, send a synthetic line, and use Back. The composer stays above the keyboard,
      Back dismisses the keyboard before leaving, and no navigation-bar-sized gap remains.
- [ ] **`EXACT PLAY CANDIDATE`:** Repeat with three-button navigation and an approved synthetic
      wallpaper while opening reply/edit, attachment tray, upload status, and multi-select states.
      Keyboard and navigation-bar space form one union rather than a doubled gap; live wallpaper
      arrival does not remount the composer, lose its draft/staged item, or strand messages behind
      translucent bars.
- [ ] **`EXACT PLAY CANDIDATE`:** Under both gesture and three-button navigation, enter a long URL/password on manual
      setup and repeatedly open/close the keyboard. The Connect and insecure-HTTP controls remain
      reachable while open, and no navigation-bar-sized residual gap remains after hide. Source now uses the shared
      padding-while-visible contract with zero vertical offset; host tests prove those props, not native movement or
      layout. Record the exact candidate result before closing the manual-keyboard/layout gap.
- [ ] **`EXACT PLAY CANDIDATE`:** Open a long synthetic chat, confirm chronological rendering begins
      at the newest message, scroll to history, receive a new item while unpinned, use the newest-
      message affordance, and reopen through search/reply navigation. Late preview/attachment growth
      must not hide the tail, and Back returns to Messages rather than stacking prior chats.
- [ ] **`EXACT PLAY CANDIDATE`:** Reuse slice 2's finite media/upload fixture only for presentation:
      media rings, generic-file spinner/byte text, and the single aggregate upload progressbar remain
      legible with wallpaper on/off, keyboard open/closed, and both themes. Appearance/
      removal must not strand the list. This does not duplicate transfer or byte-credit from B2.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Long-press synthetic sent/received bubbles at the
      top, middle, and bottom under both navigation modes. The lifted bubble, tapback
      bar, scrollable action card, left/right alignment, arbitrary-emoji input, dismissal, and
      reaction toggle remain on-screen. Do not adjust layout code or safe-area values during a run.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** A newly arriving synthetic screen-effect message
      while its chat is open plays once, leaves scrolling and controls usable, auto-cleans, and does
      not replay from history. Separately observe a bubble-effect row's mount/remount behavior:
      current source starts the effect on mount and guarantees only that unmount stops it, so record
      any replay rather than requiring a false history/remount one-shot result; verify no animation
      bleeds into a recycled row. Screen effects are non-interactive; do not require tap-to-skip.

The app remains portrait-only, but predictive Back is enabled and its task-scoped frozen-package
matrix is complete under `ANDROID-02`. Rotation, landscape, tablet, and foldable behavior remain
outside the supported product; an exact future Play candidate should still receive its ordinary
root/navigation smoke without reopening the completed remediation matrix.

### 5. Dark themes and visual readability

| Enabled built-in preset | Task-scoped appearance matrix                                                                                                | Result |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| OLED Dark               | Play-v78 cold launch and Settings checks under Android light and dark; app and system bars stay dark and the preset persists | [x]    |
| Gator                   | Play-v78 cold launch and Settings checks under Android light and dark; Gator tokens and dark system bars persist             | [x]    |

- [x] **`TASK-SCOPED NEWER PLAY BUILD` / `THEME-01A`:** Across the four branches above, Play v78 on
      the API-36 Samsung retained a black splash and dark first paint, readable status icons, and a
      dark or theme-matched three-button navigation bar with visible light buttons. Both presets
      persisted across cold starts and Settings rendering. Android light was only an environment
      input; no app light theme is supported. The focused host gate passed 5 suites / 33 tests. This
      closes only `THEME-01A`; it does not rebind the v77 release candidate or close release-only
      launcher-icon, display-size, or exact-candidate rows.
- [x] **`TASK-SCOPED NEWER PLAY BUILD` / `UI-01`:** Play v78 on the API-36 Samsung showed readable OLED
      Dark and Gator Settings/inbox surfaces, unread badges, and the real filled Connect action.
      An existing chat supplied a no-send/no-edit ordinary bubble review. The focused rendered
      contrast and sent/received mention gate passed 7 suites / 113 tests. Accessibility Scanner,
      TalkBack, maximum-font, focus-order, and touch-target review are not remediation requirements.
      This closes only `UI-01`; it does not rebind the v77 release candidate. The separate
      `THEME-01A` task-scoped matrix above is also complete.
- [x] **`STATIC/HOST` / `THEME-02`:** Theme Studio now measures its editable text roles against all
      applicable surfaces, previews each failing pair and exact ratio, offers a safe foreground
      auto-fix, and requires a separate confirmation before an unresolved theme can be saved.
      Legacy light-theme continuity needs an approved natural Play-update baseline and otherwise
      remains `BLOCKED/OPEN`.
- [x] **`TASK-SCOPED LOCAL DEVELOPMENT` / `HANDLE-COLOR-01`:** On the Android 16/API-36 Samsung
      SM-S938U1 running disposable `0.1.51-debug`, selecting **Pale yellow** and **Navy** updated the
      selected Settings swatch and corresponding avatar/inbox presentation immediately. Pale yellow
      survived a force-stop cold relaunch plus DEV fixture re-seed; a Mom fixture showed readable dark
      text on its pale received bubble; both touched fixtures were restored to **Default**. Focused host
      proof owns exact-service isolation, direct/group projections, contrast, and backup-v4 behavior.
      The app deliberately ignores server color fields, so no staged-server color result is required or
      claimed. This result is not Play-install, release-candidate, or release-checklist evidence.

`A11Y-01`, `A11Y-02`, and `A11Y-03`, including the former motion and TalkBack device matrices, were
owner-dropped on 2026-09-25. Existing implementation and historical evidence remain, but none of
those rows is a current remediation or candidate requirement.

### 6. Synthetic account A → explicit Disconnect → account B

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** In A, create bounded identifiable state using
      aliases only: a conversation/search hit, draft, pin/mute/custom chat name, per-chat theme/
      wallpaper, reminder/schedule or queued item where safely supported, downloaded file, visible
      notice, and optional finite delayed read. Record one benign device-global theme/feature
      setting separately. Open the Disconnect confirmation, verify its permanent-deletion copy,
      cancel once, and confirm A remains intact.
- [ ] **`EXACT PLAY CANDIDATE`:** Confirm Disconnect, observe Welcome as an early UI transition only,
      then connect B through ordinary setup without clearing data or navigating around the gate.
      B validation must wait for cleanup or fail closed with fixed safe guidance; Welcome alone is
      never isolation proof.
- [ ] **`STATIC/HOST` + `EXACT PLAY CANDIDATE`:** If **Disconnect incomplete** or another cleanup
      failure occurs naturally, B remains unauthorized; fully close/reopen for residual cleanup and
      retry only after the fixed guidance. Do not induce a native/DB failure. Without a natural
      candidate failure, leave this branch open and retain host proof.
- [ ] **`EXACT PLAY CANDIDATE`:** In B, system Back and every visible route show no A server/account
      details, chat/search result, draft, customization, media, reminder/schedule/queue, Find My/
      FaceTime/RCS state, notice, dialog/toast, QR/log view, or delayed result. Device contacts,
      runtime grants, App Lock, global feature/sync settings, and built-in/custom global themes may
      persist by design; a device-contact name alone is not server-A leakage.
- [ ] **`STAGED-SERVER`:** Sanitized aggregates show no unexpected A request/activity after teardown
      and no A credential/content reaches B. The owner separately removes both accounts' synthetic
      fixtures/device rows and expires credentials. This supports visible isolation but does not
      prove each internal abort, DB/file deletion, FCM-token retirement, or server cleanup.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** If the synthetic server supports iMessage account
      aliases, change **Start Chats Using** once and restore it. The same conversations/session stay
      active: this is a server sender-alias setting, not account switching and never a substitute
      for the A→Disconnect→B journey or `ALIAS-SEND-01`.

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Since review item M130, replacing this phone's
      paired-client credential (Server Management → Replace Device Credential) frees the old
      credential's notification registration and then revokes the old credential, with no Mac
      dashboard step. Confirm the dialog says the old credential was revoked, the Mac dashboard no
      longer lists it as active, and a new message still notifies. With the Mac unreachable at the
      end, the dialog says revocation is pending and the old credential disappears once Gator is
      opened again with the Mac reachable.
      An approved server-address change made while that revocation is pending first revokes the old
      credential at the current address; if it cannot, the prompt asks to try again and the address
      stays unchanged.
- [ ] **`EXACT PACKAGED CANDIDATE` — slow Disconnect reaches setup (M120, added 2026-10-18):**
      On a synthetic account with a large history, ideally with the Mac unreachable so the wipe's
      server steps wait out their deadlines, tap Disconnect. Gator shows its loading screen and then
      the setup screen, never "Couldn't start Gator". Before the fix a wipe slower than 10 seconds
      ended on that error and needed a Retry.

### 7. Claims and cleanup boundaries

| Claim or boundary                                             | Required evidence / current disposition                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native permission dialogs, limited media, IME/insets, intents | Exact Play-candidate observation on each applicable Android/API/navigation branch; host mocks cannot prove them                                                                             |
| Theme and handle-color readability                            | Task-scoped device screenshots plus focused runtime contrast evidence; `UI-01`, `THEME-01A`, and `HANDLE-COLOR-01` are complete, while release-only candidate/display-size rows remain open |
| Embedded WebView/network absence                              | Static source plus controlled target/network observation; visual placeholder/browser handoff alone cannot prove traffic or hostile-navigation behavior                                      |
| Account work cancellation and local wipe internals            | Host/native DB, file, notification, log, FCM, query, and lifecycle proof; visible B isolation cannot identify every deleted row/file or recalled native intent                              |
| State that deliberately survives Disconnect                   | Device-wide themes/settings/contacts/App Lock/OS grants and user-created external copies; remove synthetic contacts/copies separately in their owning systems                               |
| Browser/Maps/share/native work already admitted               | Cannot be recalled after external handoff; close it before Disconnect and verify only the observable cleanup boundary                                                                       |

At cleanup, close browser/Maps/settings/share/native surfaces; settle or cancel fixture work;
restore only OS appearance, navigation, font/display, permission, theme, and feature
settings changed by this slice; delete only the synthetic device contacts and external media/files
actually created by this slice, in their owning apps; have the server owner remove A/B fixtures and
device rows, retire credentials, and delete temporary captures after private review. Do not clear
app data or uninstall as a substitute.

The former 51-field reconciliation and B4 motion counts are historical and superseded by the
authoritative work-plan register. `UI-01`, `THEME-01A`, and `HANDLE-COLOR-01` are complete and
`A11Y-01..03` are owner-dropped; the other named non-accessibility candidate/device tasks retain their
current work-plan status.

---

## Historical behavior matrix — PERMANENTLY NON-EXECUTABLE

Sections (b)–(z) are retained only as an inventory of past checks. They mix version-code-39 results,
development-only harnesses, removed settings, real-account prompts, stale full-screen-intent claims,
and evidence commands that may expose private data. Do not run, tick, or use them as tester
instructions. Current slices 1–3 supersede historical sections (b)–(i), all currently reachable
rows of (j), all of (j.1), all of (k), and the document/sticker rows of (z); the Redacted Mode rows
in (z) are retired with no replacement test. The remaining text is permanently non-executable
history and cannot regain candidate credit after a future feature or milestone.

---

## (b) Notifications (via notify-kit)

Send yourself (or have someone send) a normal iMessage while the app is in the background.

- [ ] The notification renders in **thread/conversation style** — it shows the **sender's
      name and their avatar**, not a generic app icon (this is the Android `MESSAGING` style
      in `postNotification`, `src/services/notifications/notifeeService.ts`).
- [ ] Tap the **Reply** field on the notification, type a message, send it — it actually goes
      out and appears in the chat (routes to `sendTextMessage`).
- [ ] Tap **Mark as read** — the notification clears and the chat's unread marker advances.
- [ ] With **Send Read Receipts** on, close Gator with `adb shell am kill <package>`, receive an
      iMessage, and tap **Mark as read** — the notification clears and the sender's iPhone shows
      the message as **Read** (review M199). With the setting off, no Read receipt appears.
- [ ] Tap **♥ Love** — a Love tapback is applied to that message (routes to
      `sendReactionMessage`).
- [ ] Open **per-chat notification settings**: from a conversation's settings, open its
      notification channel — Android's system settings for _that chat's own channel_ open, so
      you can give one conversation a custom sound/importance.
- [ ] Turn on **Hide preview / redacted mode** (Settings), then trigger a notification. The
      body, chat title, sender name, and avatar are all masked (generic "New message"). Check
      this for **every** notification path, not just a normal message: a reminder, a FaceTime
      call, and an alias-removed notice should all redact too.
- [ ] Leave a normal private message **already visible in the tray**, then turn Hide preview on.
      The existing notification is replaced immediately with generic text; turning the setting
      off again does **not** restore the old private text. Only notifications posted afterwards
      may show fresh content.
- [ ] Schedule a reminder, turn Hide preview on **before it fires**, and let it fire. It must show
      generic Reminder text and still open the correct chat/message when tapped. Repeat once with
      the alarm due while you are flipping the setting; no briefly fired private reminder should
      remain in the tray.
- [ ] On an upgrade from an older build, launch once with Hide preview **off** and verify any legacy
      GUID-derived per-chat channel is removed. After enabling Hide preview, verify a current
      local-key per-chat channel is named the generic **Conversation**, not the person's/group's
      name. Deleting a legacy channel loses its old custom sound once; reopen that chat's
      notification settings after turning privacy off to recreate it under the new private id.
- [ ] With a message, reminder, and FaceTime notice present, run
      `adb shell dumpsys notification --noredact` and inspect this app's records. Notification ids,
      `data`, `Person.id`, trigger ids,
      and channel ids must contain only `gator-*`, the `gatorOwner/gatorSchema/gatorKind` marker,
      local numbers, or random tokens — **no** chat/message GUID, phone number, email address, or
      FaceTime UUID. Visible title/body/avatar may still show content when Hide preview is off.
- [ ] While Hide preview is on, trigger the server RCS warning and push self-test paths. Their text
      must be the app-authored generic status (the server cannot inject arbitrary lock-screen text).
- [ ] Re-test Reply, Mark as read, Love, a reminder tap, and FaceTime Answer/Decline after the
      transition. Privacy-safe route keys must not break actions or deep links.
- [ ] With **app-lock enabled**, get a push while locked: you should see a single
      **content-less** "You have new messages" notice (from `postLockedNotification`) — no
      sender, no content. The real per-chat notifications appear only after you unlock.

---

## (c) FaceTime incoming call

Have someone FaceTime the linked Apple ID (or trigger one from the server).

- [ ] A **full-screen incoming-call** notification appears (full-screen intent, `CALL`
      category) — not just a small heads-up banner. (If it's only a small banner, the
      `USE_FULL_SCREEN_INTENT` permission didn't take — recheck the rebuild.)
- [ ] Tap **Answer** — the call is answered on the server and the FaceTime link opens (in a
      Chrome custom tab). The ringing notification clears.
- [ ] Tap **Decline** — the ringing notification clears and nothing else happens.

---

## (d) Reminders

- [ ] Set a message reminder for ~1–2 minutes out, then wait: the reminder notification
      **fires** near that time. (It uses an _inexact_ alarm that survives Doze, so it may be a
      little late — that's expected and needs no special permission.)
- [ ] Tap the fired reminder — it routes to the right chat and the reminder is cleared (its DB
      row is deleted).

---

## (e) Killed-app FCM push

This is the important one — it proves push works when the app isn't running at all.

- [ ] Open Gator once, background it, then run `adb shell am kill <package>`. **Never use
      `am force-stop` for this test:** force-stop puts the app in Android's stopped state and blocks
      broadcasts until the user launches it again, so it cannot prove killed-process FCM delivery.
- [ ] Send yourself a message. A notification should **still arrive** (the killed-app wake
      re-runs the FCM background handler).
- [ ] Repeat with an enrolled random-key encrypted push: identity-bound V3 for a scoped session, or
      V2 only before the exclusive **2027-02-01T00:00:00Z** compatibility cutoff. The notification
      arrives with real content while App Lock is disabled. Absent-state plaintext/V1 must not
      present live content; the message instead appears on the next foreground sync.

---

## (f) Dev native-contract proofs

Run a **dev** build (`npx expo run:android`, dev client) with Metro on port 8081. The crypto marker
remains a manual boot-log check:

- [x] **LOCAL DEV SUPPORTING ONLY (2026-09-08) —**
      `[crypto] self-test { ok: true, detail: 'round-trip + tamper-reject OK' }` was observed after
      the current-tree debug APK booted on physical API 36 arm64 hardware. This is not exact release-
      candidate evidence.

The database checks now have deterministic ADB harnesses. With exactly one authorized device, or an
explicit serial, run:

```sh
ANDROID_SERIAL=<serial> npm run test:android:db
ANDROID_SERIAL=<serial> npm run test:android:db:relaunch
ANDROID_SERIAL=<serial> npm run test:android:db:wal-write-death
ANDROID_SERIAL=<serial> npm run test:android:db:active-migration-death
ANDROID_SERIAL=<serial> npm run test:android:db:runtime-concurrency
ANDROID_SERIAL=<serial> npm run test:android:backup-restore
```

The first harness cold-launches the debuggable app, accepts exactly one finite
`GATOR_DB_CONTRACT_V3` marker after a unique log boundary, and writes only allowlisted target/check,
migration-count, and migration-head metadata under the ignored
`android/app/build/reports/db-contract/` directory. The relaunch harness exclusively claims a
zero-byte DEV request before ordinary boot, requires one READY marker from process A and one final
marker from a different process B, and retains the same finite metadata under the ignored
`android/app/build/reports/db-relaunch/` directory. The active-WAL mode uses distinct scenario
markers and the finite `GATOR_DB_WAL_WRITE_DEATH_V1` schema, requires physical WAL growth before
exact same-UID `adb shell run-as com.bluegreengatorapps.messages kill -9 <PID A>`, and retains only
allowlisted target/check metadata under the
ignored `android/app/build/reports/db-wal-write-death/` directory. The active-migration mode uses a
third distinct marker family and finite `GATOR_DB_ACTIVE_MIGRATION_DEATH_V1` schema, requires WAL
beyond its header both before and after crashing exact A, and retains only allowlisted target/check
and migration-head/count metadata under the ignored
`android/app/build/reports/db-active-migration-death/` directory. The runtime-concurrency mode uses
one exclusive DEV launch and the finite `GATOR_DB_RUNTIME_CONCURRENCY_V1` schema against only
`driver-runtime-concurrency-selftest.db`. It requires all 22 mixed sync/live/send/rollback/rekey,
reopen, integrity, and cleanup checks plus all three same-process/stop/private-state host checks, and
retains only allowlisted target/check metadata under the ignored
`android/app/build/reports/db-runtime-concurrency/` directory.
The backup/restore mode uses its own fixed disposable database and marker family. It requires all
22 native seal/open, near-limit, injected-late-failure rollback, retry, integrity, close, and cleanup
checks plus all three process/private-state host checks, and retains only allowlisted metadata under
the ignored `android/app/build/reports/backup-restore/` directory.

- [x] **LOCAL CURRENT-TREE DEV REFRESH (2026-09-08) —** A locally built debug APK on the physical
      API-36 arm64 Samsung passed all six disposable lanes. The APK contained registry head
      `0047_message_retraction_topology`, and all five head-bearing artifacts report that head: DB
      contract **28/28**; relaunch **7/7 READY, 12/12 final, 3/3 host**; active-migration death
      **11/11, 15/15, 6/6**; runtime concurrency **22/22 + 3/3 host**; and backup/restore **22/22 +
      3/3 host**. The fixed-WAL contract, which intentionally records no migration head/count,
      separately passed **9/9 READY, 12/12 final, 5/5 host**.
      All **158/158** retained booleans are true in the six 2026-09-09T04:09–04:11Z privacy-safe
      artifacts. Installed native metadata remains development-only `0.1.41`/version-code 1, so this
      does not satisfy the exact release-candidate checkbox below or provide FEAT-03 staged-server
      proof.

Exact artifacts for this local refresh under `android/app/build/reports/`:
`db-relaunch/android-db-relaunch-2026-09-09T04-09-53-377Z.json`,
`db-wal-write-death/android-db-wal-write-death-2026-09-09T04-10-15-041Z.json`,
`db-active-migration-death/android-db-active-migration-death-2026-09-09T04-10-34-772Z.json`,
`db-runtime-concurrency/android-db-runtime-concurrency-2026-09-09T04-10-52-441Z.json`,
`backup-restore/android-backup-restore-2026-09-09T04-11-12-760Z.json`, and
`db-contract/android-db-contract-2026-09-09T04-11-27-811Z.json`.

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Local API-35 arm64 emulator: **PASS**, schema 3,
      38 migrations at head `0038`, all 28 checks
      true; retained artifact `android-db-contract-2026-08-20T05-04-33-795Z.json`.
- [ ] Repeat on the exact release candidate and a supported physical device.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03A: run the exact current production
      migration registry from `0001` through `0038`, prove
      per-migration `0030` rollback/retry, and validate audited head-`0029` upgrade data.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B1: on the local API-35 arm64 DEV emulator,
      emit READY while process A retains its fixed
      encrypted throwaway handle, force-stop A, observe no process, launch a distinct PID B, and
      require B to verify the existing head-`0029` state through `readOnly: true` before any
      read-write reopen or exact `0030`–`0038` retry. All 7 prepare, 12 resume, and 3 host checks are
      true in retained artifact `android-db-relaunch-2026-08-20T02-09-52-914Z.json`.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2A: pin three reviewed repository logical
      heads (`0024`, `0027`, `0029`) to full Git
      objects. On API 35, construct encrypted `0024`/`0027` fixtures, close and verify them read-only,
      then apply their exact tails through `0038`; retain the existing `0029` migration path. V3 is
      28/28 in the artifact above.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2B1: on the local API-35 arm64 DEV emulator,
      process A commits an exact WAL baseline,
      checkpoints, opens a bounded ordinary write transaction, and emits READY while it and the
      encrypted handle remain open. The host proves physical WAL growth, crashes exact A, observes no
      process, and launches distinct B. B first proves the exact baseline-only state read-only, then
      commits and reopens one recovery row and cleans every fixed database/sidecar/marker path. All 9
      READY, 12 final, and 5 host checks are true in retained artifact
      `android-db-wal-write-death-2026-08-20T16-46-24-970Z.json`.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2B2: on the local API-35 arm64 DEV emulator,
      process A prepares exact head `0037` and an
      exact 133-row fixture, then emits READY only after the exact production migration `0038`
      `UPDATE` resolves inside its open transaction while the ledger remains at `0037` and before the
      runner can issue its ledger insert or commit. The host proves WAL beyond its header before and
      after crashing exact A and launches distinct B. B first proves the exact original head-`0037`
      state read-only, then applies exact `[0038]`, verifies the head-`0038` data, idempotency and
      persistence, and cleans all eight fixed paths. All 11 READY, 15 final, and 6 host checks are true
      in retained artifact
      `android-db-active-migration-death-2026-08-21T09-05-01-344Z.json`.
- [x] **POST-V56 / DEBUG-BUILD CREDIT —** DB-02C: the 2026-09-08 physical API-36 run passed all
      **22/22** runtime checks and **3/3** host checks in retained artifact
      `android-db-runtime-concurrency-2026-09-09T04-10-52-441Z.json`. Frozen version code 56 predates
      this lane and does not receive this evidence.
- [ ] Parent DB-03B2B/DB-03B remains open; power-loss and torn-write recovery remain unproved.
      DB-03C/DEVICE-01 still own scheduled CI, actual signed prior-build install-over,
      production-file continuity, spontaneous process death, and repetition of the active-migration
      crash on the exact release candidate and a supported physical device.

The disposable check deliberately fails the second statement of migration `0030`, proves only that
migration rolls back while `0001`–`0029` remain committed, then same-process reopens and applies exact
`0030`–`0038` over an audited fixture. It validates the ledger/data changes, real `messages_fts`
insert/update/delete triggers, foreign keys, integrity, idempotency, encrypted open, wrong-key
rejection, commit/rollback reactive convergence, all three private Drizzle adapter routes, rekey,
key-specific reopen, and cleanup without touching `gator.db`. A failed marker stops the lane with a
finite failure code; raw logs, database paths, keys, serials, and device model are not retained.

The V3 history extension uses fixed disposable `driver-history-selftest.db`, never `gator.db`. The
host test proves that the three canonical prefixes equal three reviewed repository commit objects;
there are no retained old APK/AAB/database samples or release tags. For `0024` and `0027`, the native
lane proves the exact boundary/rollback, closes the encrypted fixture, rejects the wrong key, verifies
unchanged state through `readOnly: true`, and applies the exact current tail with data, FTS5, foreign
key, integrity, idempotence, and cleanup checks. The aggregate V3 `historicalReadOnly` result covers
only `0024`/`0027`; head-`0029` read-only/process continuity is the separate DB-03B1 relaunch proof.

The relaunch lane uses its own fixed `driver-relaunch-selftest.db`, not `gator.db`. Its zero-byte
request/phase files make interrupted prepare/resume states fail closed and recoverable. Process B's
first encrypted open is read-only, so a missing file cannot be silently recreated before continuity
is checked. This proves a controlled force-stop/relaunch across two PIDs and preserved database
state; it does not prove inode identity, spontaneous OS death, crash-mid-write/power-loss behavior,
the production database, scheduled CI, old signed-app install-over, or release/physical-device
behavior.

The active-WAL lane uses its own fixed `driver-wal-write-death-selftest.db`, never `gator.db`, and
scenario-specific zero-byte phase files in the same exclusive DEV dispatcher. A commits the exact
baseline, requires WAL plus a successful truncate checkpoint, begins `BEGIN IMMEDIATE`, writes a
bounded multi-page uncommitted canary, and stays open at READY. The host requires the WAL file to
exceed its header before exact same-UID `SIGKILL`; B's first encrypted open is read-only and requires the
exact baseline-only row set, after which read-write integrity/foreign-key checks, recovery commit,
read-only reopen, WAL retirement, and the unchanged pre-fallback eight-path absence gate all pass.
This is controlled ordinary active-WAL write-death evidence only—not active-migration crash,
power-loss/torn-write recovery, spontaneous OS death, production-file behavior, signed/store
provenance, scheduled CI, or release/physical-device proof.

The active-migration lane uses its own fixed `driver-active-migration-death-selftest.db`, never
`gator.db`, and its own scenario-specific zero-byte phase files in the same exclusive DEV dispatcher.
A constructs exact production head `0037`, commits an exact 133-row original fixture containing 128
bounded spill targets and five controls, checkpoints WAL, then enters the exact production `0038`
transaction. Its private wrapper awaits the real `0038` `UPDATE`, proves the exact migrated
in-transaction rows while the ledger is still exactly at `0037`, and enters a non-settling READY
callback before returning, so the ledger insert and commit cannot start. The host requires WAL beyond
its header both before and after exact same-UID `SIGKILL`; B's first encrypted open is read-only and proves the
exact head-`0037` original fixture, after which read-write integrity/foreign-key checks, exact `[0038]`
retry, head-`0038` ledger/data, idempotency, read-only persistence, WAL retirement, and the unchanged
pre-fallback eight-path absence gate all pass. This is controlled post-statement/pre-ledger-and-commit
evidence only—not a statement-in-flight crash, power-loss/torn-write recovery, spontaneous OS death,
production-file behavior, signed/store provenance, scheduled CI, or release/physical-device proof.

- [ ] **LOCAL DEV (P6.5 stage 1):** Since P6.5 stage 1, the PERF-01 cold fixture and the PERF-02
      query benchmark live in `src/db/devHarness/perfInboxFixtures.ts` and reach their throwaway
      databases only through the doorway in `database.ts`. Use a dev build on an emulator or a spare
      device (never over the Play build), signed in to a synthetic account. On Home, tap
      **Measure PERF-02 queries** and wait for the dialog with the 1,000- and 10,000-chat results.
      Then open **Measure cold inbox**, tap **Prepare 1,000**, run
      `adb shell am kill com.bluegreengatorapps.messages`, relaunch, tap **Measure 1,000**, and finish
      with **Delete fixtures**. Pass: no error dialog, the real inbox is unchanged, and afterwards
      `adb shell run-as com.bluegreengatorapps.messages ls databases` lists no `perf01-cold-*.db` or
      `perf02-inbox-benchmark.db`. Record timings only.
- [ ] **LOCAL DEV (M213, added 2026-10-18):** In a dev build, open React Native DevTools and run
      `ErrorUtils.reportFatalError(new Error('M213 probe'))` in its console. After the red screen,
      relaunch Gator and open Settings → App Logs: the newest entries include the `runtime.fatal`
      line. Before the fix that line was usually lost, because the app ended before the 1.5 s
      batched log write. The crash now waits at most 750 ms for that write and the error report.
- [ ] **`EXACT PACKAGED CANDIDATE` — crash fingerprint (M214/M180, added 2026-10-18):** With Share
      Error Reports on, after a runtime error has been captured in the packaged build, open Settings →
      Share diagnostics (or the server's error-report list). Runtime events read like
      `runtime.uncaught [TypeError|fp-…]` with `fp-` plus 12 letters g–v, the same error repeated
      gives the same token, and no message text, file name or function name appears. If no runtime
      event ever carries a token, record one raw release stack shape in a dev session (frames other
      than `index.android.bundle` give none); host tests cannot prove the release Hermes format.

---

## (g) App lock (cold boot)

- [ ] Enable app-lock (requires an enrolled fingerprint/face — a bare emulator has none, so do
      this on a real phone).
- [ ] Fully kill the app, then cold-launch it. The **lock screen appears first**, before the
      foreground app opens or renders the message database.
- [ ] Authenticate: the app opens the database and routes you into the app normally.
- [ ] While the UI is locked, send a killed-app push and confirm an enrolled V2 push before its
      exclusive 2027-02-01 cutoff posts only the generic locked notice; absent/V1/plaintext posts no
      notice. V2 must not open the DB. Authenticated, active-bound V3 may perform only its
      SQLCipher enqueue and must not read/decrypt, claim, route, or apply content until unlock; a replay must
      not re-alert. After unlock, the durable drain (with sync as fallback) catches the event up. App
      Lock is a foreground/policy gate, not user-auth-bound key custody or encryption for downloaded
      attachments/app logs.
- [ ] Unlock, background the app, wait longer than the configured lock timeout **without bringing
      it foreground**, then send a push. It must post only the generic locked notice; a background
      FCM delivery must enforce timeout expiry even before the AppState resume listener runs.

---

## (h) Historical disabled Android sharing — IPC-01/SHARE-01 containment

`expo-share-intent@8.0.1` read provider metadata/media and could copy a stream without byte or time
limits before JavaScript received an event. The v75 containment candidate therefore accepted no
text, files, `SEND_MULTIPLE`, or Direct Share targets. This checklist is a non-executable historical
snapshot: the owned `SHARE-02` replacement now exists, and current matrix slice 2, section 6 is the
authoritative candidate procedure.

- [ ] Inspect the exact candidate manifest: MainActivity has no `android.intent.action.SEND` or
      `android.intent.action.SEND_MULTIPLE` filter.
- [ ] Inspect the exact candidate manifest/resources: MainActivity has no `android.app.shortcuts`
      meta-data and the generated `shortcuts.xml` contains no `<share-target>`.
- [ ] Run Expo autolinking for the exact candidate: `expo-share-intent` is absent.
- [ ] Open another app's Android share sheet with text, one image, multiple images, and a PDF:
      Gator and its conversation chips do not appear as destinations.
- [ ] Confirm ordinary **outbound** sharing (for example, exporting a backup or sharing downloaded
      media) still opens Android's share sheet. Outbound sharing uses `expo-sharing` and is not part
      of this containment.

---

## (i) Background sync + FCM token

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** After you connect to a server, confirm the
      **background sync task registered**: the dev
      log shows `[bg] background sync registered` (this is the ~15-minute catch-up sync).
      _(2026-07-23 adb, v0.1.28: line observed in logcat on a cold start of the release build.)_
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Confirm **FCM token registration** succeeds after
      connecting — the device token is
      fetched (`getToken`, Firebase v25 API) and sent to the server. On failure you'd see
      `[fcm] device token registration failed` in the log; a clean connect should not log
      that. _(2026-07-23 adb, v0.1.28: cold start + 20s observation — no failure line logged.
      Release build has no positive success line, so this is verified by absence, as written.)_
- [ ] **`EXACT PACKAGED CANDIDATE` — banner clears when the network returns (M116, added
      2026-10-18):** With Gator open and connected, turn on airplane mode for at least 4 minutes (long
      enough for the socket's reconnect backoff to reach about a minute), then turn it off. The
      "Connection problem" banner clears within a few seconds instead of staying for up to a minute.

---

## (j) SDK 57 general smoke test

A quick pass over the screens most likely to be disturbed by the RN 0.86 upgrade:

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Open a chat and scroll — messages scroll smoothly
      and, when you tap the composer, the
      keyboard pushes the input up instead of hiding it behind the keyboard.
      _(2026-07-23 adb, v0.1.28: scrolled a long thread both directions — reply-quotes, reactions,
      date pills all render; keyboard open showed the composer above it. Smoothness/fps is a feel
      judgment adb can't make — re-confirm by hand if it ever feels off.)_
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Open a chat that has a **wallpaper/background** —
      the header and composer bars are the
      frosted/translucent style and the message list runs under them without a smoky fringe.
      _(2026-07-23 adb, v0.1.28: verified on a wallpapered group chat — frosted chips, edge-fade
      dissolve under both bars, sender/date pills legible over the photo.)_
- [ ] Open an **image/video in the media viewer** — it opens and plays.
      _(2026-07-23 adb, v0.1.28: IMAGE verified — full-screen viewer, "n of n" counter,
      share/save controls. VIDEO playback still open.)_
- [ ] Send a message with a **send effect** (slam / confetti / balloons, etc.) — the effect
      animates once and cleans up (no leftover animation bleeding onto other rows).
- [ ] In Settings → Downloads, change the **parallel-downloads** stepper, then open a chat with
      many attachments — no more than that many download at once (the cap lives in
      `featureSettingsStore` as `maxConcurrentDownloads`, applied in the download service).

## (j.1) Ordinary attachment-cache limits and recovery (`DL-01`)

These checks require a fresh build containing the current `gator-bounded-download` module. Host
tests prove the state machine and bounds; only a real Android filesystem can prove the bridge,
process-death, low-storage, and upgrade behavior.

- [ ] On a supported Android 16/17 device with an approved pre-ledger Play baseline, download
      several attachments using the old two-level `attachments/<guid>/<name>` layout, upgrade in
      place, and launch. Every exact DB reference still renders; an unreferenced legacy file is
      removed without deleting its sibling or parent directory.
- [ ] With canonical files from two account generations for the same attachment GUID/name, launch
      recovery. The exact path stored in the DB survives; the unreferenced duplicate retires. Repeat
      with identical mtimes and confirm the outcome is deterministic.
- [ ] Kill the process with `adb shell am kill <package>` during a download (never `force-stop`),
      relaunch, and confirm the `.part` file and durable `reserved` owner are cleaned. The attachment
      must remain retryable and must not have a false `localPath`.
- [ ] Place a zero-byte file at an otherwise valid managed path before launch. Recovery clears the
      stale reference, removes that exact file, and a tap performs a new download instead of treating
      zero bytes as a cache hit.
- [ ] Exercise a hostile server that omits or lies about Content-Length and sends chunked/endless
      bytes. Automatic unknown-size download is refused; manual transfer stops at its actual-byte or
      time cap, cancels native work, removes partials, and never commits `localPath`.
- [ ] Fill the ordinary cache past **4,096 files** or **2 GiB** using a controlled fixture, and test
      with less than **512 MiB** free. Old unprotected files retire in deterministic least-recently-
      used order until all three constraints hold. Failed native deletes stay charged and cause new
      admissions to refuse rather than overfill storage.
- [ ] Keep one attachment visible in the media viewer while creating pressure; also queue an outgoing
      send/retry using another cached path. Neither protected file is removed. If those protected
      files alone prevent conformance, the next download fails cleanly and the app remains usable.
- [ ] Start launch recovery, then Disconnect/account-switch before it completes. No old-account DB
      mutation or native delete lands in account B; reconnecting B performs a fresh inventory before
      downloads open.
- [ ] Open Settings → Storage & File Privacy and confirm the 2 GiB/4,096-file, 512 MiB free-space,
      protected-file, and Android-version limitations are visible and understandable.
- [ ] Confirm the exact candidate cannot be installed below Android 16/API 36, and that Settings →
      Storage & File Privacy accurately names Android 16 as the minimum supported version.

## (k) Reaction / action menu placement

Long-press a message bubble in a chat. This is a JS-only change (no rebuild needed); the _math_ is
node-tested (`reactionMenuLayout.test.ts`) but the on-screen placement is device-only.

- [ ] The chat dims and the pressed bubble stays **bright** ("lifts"), with the **tapback bar
      floating just above that bubble** and the **Reply / Copy / … menu as a card below it** —
      positioned to that specific message, not down at the bottom of the screen.
- [ ] Long-press the **very first (top) message** — the tapback bar flips to just **below** the
      bubble instead of clipping off the top edge.
- [ ] Long-press a message **near the bottom** (just above the composer) — the action menu stacks
      **above** the bar, and a very long menu scrolls inside its card.
- [ ] Long-press your **own** (right-side) vs **the other person's** (left-side) bubble — the bar
      and menu hug the correct side.
- [ ] Tapping a reaction applies it and **dismisses immediately**; tapping the dimmed area (or the
      bright bubble) dismisses **without** reacting.
- [ ] The bar + menu sit at the **right height** (not shifted up/down by the status bar). If they're
      off, it's the Android edge-to-edge window-coordinate caveat noted in `AGENTS.md` — the
      `measureInWindow` vs `Modal` origin offset (adjust the safe-area clamp in `MessageActionsOverlay`).

---

---

## (z) Batch 1 defect fixes — branch `bb2-batch1-defects` (2026-07-30)

Three bugs from `BB_APP_2.0_COMPARISON_2026-07-30.md`. All three were INVISIBLE to the test
suite before this work, and two of them are things jest fundamentally cannot prove (a real
Android intent, a real screenshot). This section is the part of the fix that a machine can't
sign off.

Needs a **clean rebuild** (`npm run android` / a fresh dev client) — a JS reload is enough for
the redaction and sticker items, but the document-open path touches native FileProvider
plumbing, so build fresh to be sure of what you're testing.

### Received documents can be opened (DOC-1 / DOC-2)

- [ ] Have someone send you a **PDF**. Tap the chip in the thread. It should OPEN in a viewer
      (or, if you have no PDF app, show the share sheet). Before this fix the tap did
      **nothing at all** — no error, no toast, no log line.
- [ ] Repeat with a **contact card (.vcf)** — expect the contacts importer or the share sheet.
- [ ] With **no PDF viewer installed** (or after clearing defaults), confirm you get either the
      share sheet or a toast reading "No app on this device can open PDF files" — never silence.
- [ ] Clear the app's cache so the file is gone, then tap the chip: it should **re-download**
      rather than error (that's the `missing` branch self-healing).
- [ ] While tapping, watch logcat for `[openFile]`. A `no viewer for this attachment` warn line
      is expected on the share-sheet fallback; an `error`-level line is a real failure worth
      reporting.

### Redacted mode hides locations (REDACT-1 / REDACT-2)

- [ ] Settings → turn **Redacted Mode ON**. Open **Find My**.
- [ ] The map is replaced by a panel reading "Map hidden in Redacted Mode". No pins anywhere.
- [ ] Device rows read "Device" / "Item" (People tab: "Person"), with "Location available" or
      "No location" — **no street address**, and **no battery percentage**.
- [ ] There is **no "Open ↗" button**, and tapping a row does nothing (no map recenter).
- [ ] **Take an actual screenshot and look at it.** Nothing in the image should identify where
      any device is. This is the whole point of the mode, and it's the check only a human can do.
- [ ] Open a chat containing a **shared location** card: it should read "Hidden in Redacted
      Mode" instead of coordinates, and tapping it must NOT open Maps.
- [ ] Turn Redacted Mode **OFF** and confirm everything comes back (map, pins, address,
      battery, Open ↗). If it doesn't, the fail-closed guard is stuck — say so.

### Received stickers are visible (STICKER-1..3)

The dev seed includes a sticker on Craig's "Morning! ☀️" message, so you can check the
rendering without waiting for someone to send one.

- [ ] On a **dev build**, open the seeded Craig conversation. A small sticker image sits on the
      corner of the "Morning! ☀️" bubble.
- [ ] **Tap it** — it fades to ~25% so the bubble text underneath is readable. Tap again to
      restore.
- [ ] **Long-press it** — it disappears for this session.
- [ ] Confirm the sticker does **not** also appear as its own separate bubble in the thread
      (that would be a double-render).
- [ ] Now the real thing: have someone on iMessage **send you a sticker** onto one of your
      messages. It should appear on that bubble. Note whether it shows up **immediately** or
      only after you leave and re-open the chat — the live push carries no image, so a delay
      here is EXPECTED and is what decides whether the follow-up item `STICKER-4` is worth
      building. **Please record which you saw.**
- [ ] Check **Photos / the Gator album**: the received sticker must **NOT** be saved there, and
      you should get no "Downloaded 1 image" toast for it. (Ordinary received photos should
      still save as before — check one to be sure the skip is sticker-only.)
- [ ] With Redacted Mode **ON**, confirm the sticker imagery is **not** rendered.

_Historical report note only: do not use the old request for screenshots or raw logcat output. A
future version-code-56 result must use the candidate ledger above, a sanitized summary, and an
approved private evidence reference._

_No combination of boxes in this quarantined matrix signs off version code 56. Candidate sign-off
requires a refreshed matrix plus exact Google Play install and signing provenance._
