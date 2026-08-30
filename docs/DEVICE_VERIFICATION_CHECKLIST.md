# Device Verification Checklist — historical version-code-56 preparation

> **STATUS (2026-08-27): RETIRED V56 PREPARATION — NOT A CURRENT OR REPLACEMENT EXECUTION MATRIX.**
> This file preserves the prepared `0.1.40` / version-code-`56` ledger and its synthetic-safe matrix history. It
> contains no Play or device result. Do not execute its rows, fill its result fields, or transfer any checkmark or
> evidence to version code `57` or a future replacement.
>
> The later frozen `0.1.41` / version-code-`57` AAB is also nonconforming because it predates `9046e27`; no current
> candidate exists. Use [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) §0 and
> [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./STORE_01G_INTERNAL_TESTING_RUNBOOK.md) for identity and readiness.
> `DEVICE-01` in [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) remains blocked until this matrix is replaced
> row-by-row for the exact replacement AAB and its source applicability.

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

**Reduce Motion applicability gate:** Git ancestry places the frozen source commit `5d367eb` 24
commits before `8c5e783`, the commit containing the completed `A11Y-02A..L` host implementation.
Version code `56` therefore cannot earn `A11Y-02` device credit, and the motion matrix below must not
be executed on it. A later, separately approved Play candidate must be built locally from a commit
that contains `8c5e7836b52df4207e315a7a445893f7b36b4a41`, then receive its own artifact/source/install ledger
before motion testing. This documentation milestone neither authorizes nor creates that build,
upload, install, or device session.

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
| Display/font/TalkBack state            | `[OPEN]`                                                               | OPEN   |
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
- [ ] Record permissions, display/font/TalkBack state, Android/API, ABI, navigation mode, test date,
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
      detailed background and killed-process presentation; App Lock enabled in a still-live process
      permits detail only within its unexpired grace period; and an expired live process uses the
      generic path.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With persisted App Lock enabled, a fresh ordinary
      killed-process wake has no trustworthy warm-process grace and must always use the generic path.
      Expect one fixed `Gator` / `You have new messages` notice with no sender, chat title, body,
      avatar, or private route; repeated locked deliveries update the same generic notice.
- [ ] **`EXACT PLAY CANDIDATE`:** Tap the generic notice, unlock, and confirm sync makes the synthetic
      message available in the app. Do not expect a detailed per-chat notice to replay after unlock.
- [ ] **`EXACT PLAY CANDIDATE`:** Record the current boundary explicitly: enabling or expiring App
      Lock does not retroactively rewrite a detailed notice or reminder trigger Android already
      owns. App Lock is a UI/policy gate, not encryption-key custody; this observation does not close
      `NOTIF-02`.
- [ ] **`STATIC/HOST`:** Retain the fail-closed source/test evidence that an unknown stored lock state
      posts only the generic notice and that the killed handler does not open the encrypted DB on
      the locked path. Do not manufacture vault corruption on the Play candidate or present this as
      device proof.

### 6. Plaintext, encrypted, and unsupported push branches

- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Run one approved plaintext message and one
      `AEAD_GCM_V1` encrypted-message happy path in background and ordinary killed-process states.
      Disable App Lock before each detailed killed-process branch. Both must show the correct
      synthetic detail while App Lock is disabled; a fresh killed wake with persisted App Lock
      enabled belongs to the generic branch above even if the prior live process was within grace.
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
      and allow it to fire. Expect detailed reminder text near, not exactly at, the requested time;
      Gator uses an inexact Doze-capable alarm and requests no exact-alarm permission.
- [ ] **`EXACT PLAY CANDIDATE`:** Tap the fired reminder and confirm it opens the correct
      chat/message and removes that reminder from Gator. Repeat after an ordinary package kill if the
      approved session has enough time; do not use force-stop.
- [ ] **`EXACT PLAY CANDIDATE`:** If a detailed reminder was scheduled before App Lock engaged,
      record that Android may still fire the existing detailed trigger. Do not claim App Lock
      retroactively sanitizes it.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Record one observable, synthetic catch-up result
      after the app has been backgrounded long enough for Android to choose whether to run work.
      Disable App Lock before this branch: a fresh background worker with persisted App Lock enabled
      stops before DB/sync work. Registration uses a 15-minute minimum interval, not an exact
      schedule. Success must come from staged-server/UI state or an approved finite diagnostic,
      never absence of free-form release logs.

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
      active ring. Keep Android 14/15/16 allowed/denied full-screen coverage and browser
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

| Branch or condition              | Current rule                                                                                                                                                                       | Result |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Clean Play install               | Exercise current-data persistence/search and current file flows. Record legacy DB/cache/shortcut upgrade as `N/A — clean-install branch selected`; that does not close update work | [ ]    |
| Approved prior-build Play update | Name the exact Play-delivered baseline and its version code first. Populate only synthetic state, update through Play without uninstall/clear-data, and test visible continuity    | [ ]    |
| No approved prior Play baseline  | Leave migration, legacy-layout, and old-shortcut continuity `BLOCKED/OPEN`. Do not substitute a sideloaded build, DEV fixture, or source inspection                                | [ ]    |
| Android API 24/25                | Remains conditional and open until an arm64 Play-delivered device runs it. A newer test phone does not close the advertised minimum-SDK behavior                                   | [ ]    |

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
      phone. API 24/25 persistent downloads remain an open product/device result; newer Android
      behavior cannot close it.

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
or retry-safety evidence. Keyboard, wallpaper, and TalkBack presentation of the upload bar belong to
`DEVICE-01B3`.

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

### 6. Inbound-share containment and outbound preservation

- [ ] **`STATIC/HOST`:** Retain exact source/packaged-boundary proof that Gator has no inbound
      `SEND`/`SEND_MULTIPLE` filters, Direct Share target metadata/resource, `expo-share-intent`
      dependency/autolinking, or active intake mount. Cleanup-only legacy shortcut code is not an
      inbound capability.
- [ ] **`EXACT PLAY CANDIDATE`:** From another app's Android share sheet, try bounded synthetic text,
      one image, multiple images, and a PDF. Gator and Gator conversation chips must not appear as
      destinations. Use fixture labels and a private evidence reference; never capture another
      app's real content or contact suggestions.
- [ ] **`EXACT PLAY CANDIDATE`:** Reconfirm ordinary outbound sharing from downloaded synthetic
      media opens Android's share sheet. Positive inbound intake is not a test branch; it is
      deliberately disabled until a new approved bounded design exists.

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
| API 24/25 persistent-download behavior                                                       | Arm64 Play-delivered API-24/25 device or an explicit product/minimum-SDK decision; a newer phone is not evidence                      |
| Full account A → Disconnect → account B isolation                                            | `DEVICE-01B3`, coordinated with this slice's external-copy and server cleanup; Welcome-screen appearance alone is insufficient        |

All rows above remain open. This offline reconciliation did not execute a Play install, database
rotation, search, transfer, share, save, sticker, Disconnect, device command, or server action.
`DL-01`, `SHARE-01`, `FILE-01A`, parent `DB-03`/its residual native work, `STICKER-4`, `PLAY-02`,
`STORE-01G`, and `DEVICE-01` retain their existing open or blocked status.

---

## Current matrix slice 3: permissions, UI, accessibility, and account transition — PREPARED, NOT EXECUTED

This section supersedes the remaining UI rows of historical section (j), all of section (k), and
stale permission, embedded-browser, theme, and account-switch instructions elsewhere in the old
matrix. Functional transfer/viewer results remain owned by slice 2, and notification/App Lock/
FaceTime-alert results remain owned by slice 1. Do not begin this slice until section (a) is complete,
`STORE-01G-TESTER-READINESS` has approved owners and dry runs, and the release owner separately
approves Play distribution, the device session, controlled OS-setting changes, and both synthetic
server identities used for account isolation.

Except for the explicitly post-v56 motion matrix in section 5, use only the frozen Play-installed
candidate, controlled tester profiles, synthetic contacts, neutral media, non-sensitive coordinates,
and bounded staged-server fixtures. Do not rebuild, sideload, clear app data/cache/defaults, uninstall
or disable handler apps, use `run-as`, capture raw logs/QR payloads/private paths, install an
interception certificate or proxy on a personal device, or manufacture cleanup, permission, storage,
browser, or native failures. Stop on production data, an unexpected permission or intent, private
evidence exposure, account-B admission after an incomplete cleanup, uncontrolled external traffic,
or a setting that cannot be restored safely.

### 1. Candidate state, fixtures, and Android applicability

- [ ] **`EXACT PLAY CANDIDATE`:** Reconfirm section (a), then record the clean/update branch,
      Android/API, navigation mode, OS appearance, display/font/TalkBack state, permission baseline,
      launcher state, and private evidence reference. Record existing grants rather than resetting
      the app to force a first prompt.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Approve two isolated synthetic server identities
      A and B, one shared synthetic participant identifier where practical, a synthetic device
      contact, controlled URL observer, optional finite Find My/FaceTime/send-contact capabilities,
      and cleanup owners. Record aliases and capability flags only—never endpoints, credentials,
      QR data, contact details, coordinates, or message text.

| Device/session condition                                              | Current rule                                                                                                                                                 | Result |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Android 14/API 34+ selected-photo access                              | Exercise full, selected/limited, and denied media access only when the OS offers each branch; selected access must expose only approved synthetic items      | [ ]    |
| Android 13/API 33 without the API-34 selected-photo branch            | Exercise its actual photo/video and notification behavior; a missing selected-photo choice is session-N/A, while B1 still owns notification candidate credit | [ ]    |
| Android 12/API 32 or lower                                            | Legacy media/storage permission behavior remains `BLOCKED/OPEN` until such a supported device runs it; a newer phone cannot close `PERM-01`                  | [ ]    |
| Missing optional Find My, FaceTime, or send-contact staged capability | Leave that positive result `BLOCKED/OPEN`, except send-contact may be session-N/A when the exact server truthfully advertises it unsupported                 | [ ]    |

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
      HTTPS URL. The target observer sees no HTML/image request merely from opening the chat, and
      no remote preview artwork mounts. Only an explicit tap hands the URL to the system browser
      and may produce the bounded target request. Do not add a personal-device interception proxy.
- [ ] **`STATIC/HOST` + `EXACT PLAY CANDIDATE`:** Retain scheme-allowlist proof and stage inert
      `intent:`, `javascript:`, `file:`, and `content:` text. It must not become an in-app actionable
      link or open another app. Do not attempt to make Android execute a rejected value.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** With a finite synthetic Find My coordinate, the
      route shows the privacy-disabled embedded-map placeholder and the observer sees no tile/script
      request. Only **Open** may hand the synthetic point to the system Maps app. Gator requests no
      device-location permission. Without a finite fixture, leave this result open.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** If the approved conditional FaceTime fixture
      exists, answering/starting shows Gator's browser handoff and then a system-owned custom tab or
      browser—never an embedded WebView. Do not require Chrome specifically. Any camera/microphone
      prompt belongs to the browser, not Gator, and does not close `FACE-01` or `PLAY-02`.
- [ ] **`STATIC/HOST`:** Retain proof that no production source mounts `react-native-webview`, Find
      My uses a disabled placeholder, FaceTime validates its Apple link before external handoff, and
      URL-preview lookup is cache-read-only. The dependency may remain installed; do not claim it is
      absent or that visual inspection proves zero network traffic/hostile-navigation safety.

Do not uninstall browsers, Maps, Contacts, or viewers to force no-handler behavior. A naturally
missing-handler result may be recorded, but ordinary safe URL/Maps failures can currently be
silent; record that limitation instead of turning a tap into a pass.

### 4. Keyboard, navigation, chat layout, reactions, and effects

- [ ] **`EXACT PLAY CANDIDATE`:** With gesture navigation and no wallpaper, repeatedly show/hide the
      chat keyboard, send a synthetic line, and use Back. The composer stays above the keyboard,
      Back dismisses the keyboard before leaving, and no navigation-bar-sized gap remains.
- [ ] **`EXACT PLAY CANDIDATE`:** Repeat with three-button navigation and an approved synthetic
      wallpaper while opening reply/edit, attachment tray, upload status, and multi-select states.
      Keyboard and navigation-bar space form one union rather than a doubled gap; live wallpaper
      arrival does not remount the composer, lose its draft/staged item, or strand messages behind
      translucent bars.
- [ ] **`EXACT PLAY CANDIDATE`:** Enter a long URL/password on manual setup at large font and open/
      close the keyboard. Record any obscured Connect/insecure-HTTP controls as the current Android
      keyboard gap; this screen does not yet use the chat's padding behavior and must not receive a
      broad layout pass from chat evidence. Regardless of the visual outcome, record that this
      Android route lacks the chat screen's padding keyboard behavior. This is a device-specific
      findings record and cannot close the manual-keyboard or accessibility-layout gap.
- [ ] **`EXACT PLAY CANDIDATE`:** Open a long synthetic chat, confirm chronological rendering begins
      at the newest message, scroll to history, receive a new item while unpinned, use the newest-
      message affordance, and reopen through search/reply navigation. Late preview/attachment growth
      must not hide the tail, and Back returns to Messages rather than stacking prior chats.
- [ ] **`EXACT PLAY CANDIDATE`:** Reuse slice 2's finite media/upload fixture only for presentation:
      media rings, generic-file spinner/byte text, and the single aggregate upload progressbar remain
      legible with wallpaper on/off, keyboard open/closed, both themes, and large text. Appearance/
      removal must not strand the list. This does not duplicate transfer or byte-credit from B2.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** Long-press synthetic sent/received bubbles at the
      top, middle, and bottom under both navigation modes and large text. The lifted bubble, tapback
      bar, scrollable action card, left/right alignment, arbitrary-emoji input, dismissal, and
      reaction toggle remain on-screen. Do not adjust layout code or safe-area values during a run.
- [ ] **`STAGED-SERVER` + `EXACT PLAY CANDIDATE`:** A newly arriving synthetic screen-effect message
      while its chat is open plays once, leaves scrolling and controls usable, auto-cleans, and does
      not replay from history. Separately observe a bubble-effect row's mount/remount behavior:
      current source starts the effect on mount and guarantees only that unmount stops it, so record
      any replay rather than requiring a false history/remount one-shot result; verify no animation
      bleeds into a recycled row. Screen effects are non-interactive; do not require tap-to-skip or
      turn this into Reduce Motion evidence.

The app is portrait-only and predictive Back is disabled. Record rotation and predictive-Back as
outside this candidate's supported product, not as proof for `ANDROID-02` or `ANDROID-03A/B`.

### 5. Dark themes and accessibility — record known gaps, never pass them

| Enabled built-in preset | Exact candidate appearance matrix                                                                                                                  | Result |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| OLED Dark               | Cold launch and navigate representative setup/inbox/chat/settings/media screens with Android OS appearance set to light, then dark; app stays dark | [ ]    |
| Gator                   | Repeat OS light/dark cold launch and navigation; app stays dark and uses Gator tokens rather than claiming a system/light theme                    | [ ]    |

- [ ] **`EXACT PLAY CANDIDATE`:** Across the four branches above, inspect the black splash-to-first-
      paint transition, status/navigation bars, adaptive launcher mask, and Android 13+ themed icon
      where offered. No white flash or unreadable system bar is allowed; a missing themed-icon OS
      branch is session-N/A only.
- [ ] **`EXACT PLAY CANDIDATE`:** On both presets, run the approved screenshot/Accessibility Scanner
      review at normal and maximum supported font/display size across setup, inbox, chat, Settings,
      media/upload presentation, reaction/action menus, and Theme Studio. Record clipping, hidden
      controls, contrast, touch-target, or focus-order defects individually; do not award a global
      `UI-01`/`THEME-01A` pass from host ratios.
- [x] **`STATIC/HOST` / `THEME-02`:** Theme Studio now measures its editable text roles against all
      applicable surfaces, previews each failing pair and exact ratio, offers a safe foreground
      auto-fix, and requires a separate confirmation before an unresolved theme can be saved.
      Legacy light-theme continuity needs an approved natural Play-update baseline and otherwise
      remains `BLOCKED/OPEN`.
- [ ] **`STAGED-SERVER` + future exact candidate / `HANDLE-COLOR-01`:** Provide valid pale and dark
      six-digit colors for distinct direct/group handles, then observe a partial omitted/null
      refresh and a later changed valid color. Direct and group avatars plus received bubbles must
      retain/update the intended color without unreadable initials, body text, or mentions. This
      post-v56 code is not evidence for frozen version code 56.
- [ ] **`STATIC/HOST`:** Record the known `A11Y-01` gaps: visual `TextField` labels are not associated
      with inputs, the manual HTTP switch lacks a programmatic label, and message bubbles expose no
      TalkBack accessibility action for their long-press menu. These are findings, not candidate
      passes even if an adjacent label is read incidentally.

#### `DEVICE-01B4-A11Y-02-MOTION-MATRIX` — future eligible candidate only

Every row below is **BLOCKED ON A POST-v56 SOURCE REFRESH**. Do not run or check one against version
code `56`. First freeze a separately approved, locally built Play candidate that passes the
applicability gate above and record its new artifact, source, Play-install, delivered-signature, and
session ledger. For every applicable row, exercise Reduce Motion off and on, a cold first opening, a
foreground live toggle, a toggle while backgrounded followed by resume, and restoration to off.
Record Android/API, OEM/device, navigation mode, keyboard state, font/display scale, and TalkBack
state. Keep query-failure ordering, native listener counts, and generation fencing as host evidence;
do not infer them visually or manufacture a native failure.

- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02A` — screen effects:** With Reduce Motion
      on, a new synthetic screen effect shows no particles or first-frame flash; live enablement
      stops and settles an active effect once without hiding content or controls. Restoring off
      changes only future effects.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02B` — bubble and invisible-ink effects:**
      Bubble entrances remain static while reduced; live enablement lands final opacity/scale without
      replay. Invisible ink stays concealed until explicit reveal, then reveals immediately while
      reduced and with its existing animation while off; a consumed entrance does not replay
      unexpectedly.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02C` — typing pulse:** Reduced motion keeps
      three visible static dots; live enablement stops the pulse, and restoring off starts one fresh,
      non-overlapping pulse. Grouping, layout, and meaning remain usable.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02D` — message-action overlay:** The anchored
      action UI opens fully visible without its pop and leaves every control reachable. Live
      enablement settles an active pop at its final values without replaying, recreating, dismissing,
      or changing the anchored placement; restoring off affects only a later opening.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02E` — server modals:** QR and log modals
      suppress the slide while reduced and retain it while off; a visible opening stays latched, and
      close/reopen uses the latest preference. Verify Back/Done, QR concealment, content, and focus.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02F` — photo reset:** Pinch and pan remain
      finger-controlled; automatic return snaps while reduced and springs while off. Live enablement
      lands safely, and re-grab, pager/offscreen reuse, and TalkBack remain usable.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02G` — message-list scroll:** Reply jump,
      delayed own-send reveal, newest action, and near-bottom following are immediate while reduced
      and animated while off. Direct scroll, target landing, pinning, and late growth stay correct;
      record queued/in-flight native behavior without claiming cancellation that cannot be observed.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02H/H1` — shared motion owner:** Long,
      high-count message and conversation lists plus recycle/remount react consistently without stale
      rows, flicker, or duplicated visible behavior. Only retained host tests—not visual inspection—
      may prove one native query/listener owner.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02I` — message swipe:** Left timestamp and
      right reply tracking stay direct; automatic release snaps instead of springing while reduced.
      Verify live toggles during held/return motion, rapid re-grab, recycling, keyboard-open and
      vertical-list arbitration, and Samsung behavior.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02J` — conversation swipe:** Left/right
      tracking and actions stay direct; automatic destinations and action close snap while reduced,
      with each callback firing once. Verify live toggles, rapid re-grab, recycling, and vertical-list/
      OEM arbitration.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02K` — global Theme Studio:** New/Edit opens
      without a slide while reduced. A visible editor's identity, name, tokens, draft, and focus
      survive live toggles; Back/Cancel write nothing, successful Apply closes, and reopen uses the
      latest preference.
- [ ] **`BLOCKED — FUTURE EXACT PLAY CANDIDATE` / `A11Y-02L` — per-chat Theme Studio:** Repeat the
      modal, draft, focus, close, and reopen checks while proving Apply targets only the current chat
      GUID. Retired callbacks stay inert, GUID/account replacement exposes no prior data, and the
      route shows no duplicated preference behavior across keyed replacements.
- [ ] **`EXACT PLAY CANDIDATE`:** Run separate TalkBack journeys for labeled inbox/header/composer/
      tray/reaction/media controls and the aggregate upload progressbar, then record the known audio
      load/retry, generic file chip, fullscreen zoom image, voice recorder, and Theme Studio semantic
      gaps. Verify focus can escape every modal and system handoff. No single “TalkBack passes”
      result may close `A11Y-01..03`; this row is a findings record.

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

### 7. Claims and cleanup boundaries

| Claim or boundary                                             | Required evidence / current disposition                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native permission dialogs, limited media, IME/insets, intents | Exact Play-candidate observation on each applicable Android/API/navigation branch; host mocks cannot prove them                                                |
| Theme readability and accessibility                           | Exact-device screenshots/Scanner/TalkBack plus completed `THEME-02` host contrast/semantic evidence; remaining `A11Y-01..03` device gaps prevent a universal pass |
| Embedded WebView/network absence                              | Static source plus controlled target/network observation; visual placeholder/browser handoff alone cannot prove traffic or hostile-navigation behavior         |
| Account work cancellation and local wipe internals            | Host/native DB, file, notification, log, FCM, query, and lifecycle proof; visible B isolation cannot identify every deleted row/file or recalled native intent |
| State that deliberately survives Disconnect                   | Device-wide themes/settings/contacts/App Lock/OS grants and user-created external copies; remove synthetic contacts/copies separately in their owning systems  |
| Browser/Maps/share/native work already admitted               | Cannot be recalled after external handoff; close it before Disconnect and verify only the observable cleanup boundary                                          |

At cleanup, close browser/Maps/settings/share/native surfaces; settle or cancel fixture work;
restore only OS appearance, navigation, font/display/TalkBack, permission, theme, and feature
settings changed by this slice; delete only the synthetic device contacts and external media/files
actually created by this slice, in their owning apps; have the server owner remove A/B fixtures and
device rows, retire credentials, and delete temporary captures after private review. Do not clear
app data or uninstall as a substitute.

All **51** result fields above remain open; the 12 motion fields are B4-owned refinements within this
slice, not additional parent results. This offline reconciliation did not run a Play install,
permission prompt, OS-setting change, browser/Maps handoff, network observation, synthetic server
event, effect, accessibility scan, Disconnect, account transition, device command, or cleanup.
`PERM-01`, `ONBOARD-01`, `UI-01`, `THEME-01A/B`, `THEME-02`, `HANDLE-COLOR-01`, `A11Y-01..03`,
`TEST-01`, `UISEC-01`, `ANDROID-02/03A/03B`, `WEB-01..03`, `FACE-01`, `PLAY-02/03`, `REL-003/004/
005A/005B`, `SHARE-01`, `IPC-01`, `ALIAS-SEND-01`, `STORE-01G`, and `DEVICE-01` retain their
existing open, conditional, in-progress, or blocked status.

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
- [ ] Repeat with an **encrypted** push (server's `encryptComs` setting on): the encrypted
      payload is decrypted on-device (AEAD_GCM_V1) and the notification arrives with real
      content. If decryption ever fails, the message still shows up on the next foreground
      sync — that's the intended fallback, not a silent drop.

---

## (f) Dev native-contract proofs

Run a **dev** build (`npx expo run:android`, dev client) with Metro on port 8081. The crypto marker
remains a manual boot-log check:

- [ ] `[crypto] self-test { ok: true, detail: 'round-trip + tamper-reject OK' }`

The database checks now have deterministic ADB harnesses. With exactly one authorized device, or an
explicit serial, run:

```sh
ANDROID_SERIAL=<serial> npm run test:android:db
ANDROID_SERIAL=<serial> npm run test:android:db:relaunch
ANDROID_SERIAL=<serial> npm run test:android:db:wal-write-death
ANDROID_SERIAL=<serial> npm run test:android:db:active-migration-death
ANDROID_SERIAL=<serial> npm run test:android:db:runtime-concurrency
```

The first harness cold-launches the debuggable app, accepts exactly one finite
`GATOR_DB_CONTRACT_V3` marker after a unique log boundary, and writes only allowlisted target/check,
migration-count, and migration-head metadata under the ignored
`android/app/build/reports/db-contract/` directory. The relaunch harness exclusively claims a
zero-byte DEV request before ordinary boot, requires one READY marker from process A and one final
marker from a different process B, and retains the same finite metadata under the ignored
`android/app/build/reports/db-relaunch/` directory. The active-WAL mode uses distinct scenario
markers and the finite `GATOR_DB_WAL_WRITE_DEATH_V1` schema, requires physical WAL growth before
exact `adb shell am crash <PID A>`, and retains only allowlisted target/check metadata under the
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
- [ ] **POST-V56 / FUTURE DEBUG BUILD ONLY —** DB-02C: on a supported physical Android device, run
      `ANDROID_SERIAL=<serial> npm run test:android:db:runtime-concurrency` and require all 22 runtime
      checks and all three host checks to be true in the retained privacy-safe artifact. Frozen
      version code 56 predates this lane and cannot receive this evidence.
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
exceed its header before exact `am crash`; B's first encrypted open is read-only and requires the
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
its header both before and after exact `am crash`; B's first encrypted open is read-only and proves the
exact head-`0037` original fixture, after which read-write integrity/foreign-key checks, exact `[0038]`
retry, head-`0038` ledger/data, idempotency, read-only persistence, WAL retirement, and the unchanged
pre-fallback eight-path absence gate all pass. This is controlled post-statement/pre-ledger-and-commit
evidence only—not a statement-in-flight crash, power-loss/torn-write recovery, spontaneous OS death,
production-file behavior, signed/store provenance, scheduled CI, or release/physical-device proof.

---

## (g) App lock (cold boot)

- [ ] Enable app-lock (requires an enrolled fingerprint/face — a bare emulator has none, so do
      this on a real phone).
- [ ] Fully kill the app, then cold-launch it. The **lock screen appears first**, before the
      foreground app opens or renders the message database.
- [ ] Authenticate: the app opens the database and routes you into the app normally.
- [ ] While the UI is locked, send a killed-app push and confirm it posts only the generic locked
      notice without opening the DB; after unlock, sync catches the event up. App Lock is a
      foreground/policy gate, not user-auth-bound key custody or encryption for downloaded
      attachments/app logs.
- [ ] Unlock, background the app, wait longer than the configured lock timeout **without bringing
      it foreground**, then send a push. It must post only the generic locked notice; a background
      FCM delivery must enforce timeout expiry even before the AppState resume listener runs.

---

## (h) Inbound Android sharing — deliberately disabled (IPC-01 containment)

`expo-share-intent@8.0.1` reads provider metadata/media and can copy a stream without byte or time
limits before JavaScript receives an event. The release candidate therefore must not accept text,
files, `SEND_MULTIPLE`, or Direct Share targets until an owned bounded native intake replaces it.

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

- [ ] On Android 8+ with an existing pre-ledger install, download several attachments using the old
      two-level `attachments/<guid>/<name>` layout, upgrade in place, and launch. Every exact DB
      reference still renders; an unreferenced legacy file is removed without deleting its sibling
      or parent directory.
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
- [ ] On Android 7/API 24 or 25, confirm the inbox/sync remains usable but persistent attachment
      downloads fail closed. Before release, explicitly choose and document either this limitation
      or raising `minSdkVersion` from 24 to 26.

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
