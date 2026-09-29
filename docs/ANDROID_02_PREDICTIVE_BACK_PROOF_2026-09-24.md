# ANDROID-02 predictive Back proof — 2026-09-24, closed 2026-09-27

## Result

`ANDROID-02` is complete for the supported Android phone/portrait product. The earlier
development-client matrix proved predictive preview, cancellation, deterministic local-layer
unwinding, and authored-work confirmation. A frozen release APK with an embedded JavaScript bundle
now supplies the previously missing exact-package proof: setup Back, setup completion, root Back,
and relaunch all passed on the physical Samsung without a native navigation crash.

This closes the remediation item. It is not a Google Play, production-signing, release-submission,
tablet, foldable, or landscape claim.

## Frozen package and environment

- Source: isolated candidate commit `6244127` (`fix(navigation): isolate setup navigation stack`).
- APK: `gator-0.1.57-android02-nested-setup-release.apk`, 113,876,637 bytes.
- SHA-256: `276a6bd733e2ecc0d39262accdedb95c9f620ea4590e0874039a22fd275321ae`.
- Package/version: `com.bluegreengatorapps.messages.debug`, version code `1`, version name
  `0.1.57-android02`, minimum/target SDK 36.
- Variant: nondebuggable release build with an embedded bundle; a temporary Gradle init script
  supplied only the disposable `.debug` application id and proof version name.
- Build: `:app:assembleRelease` passed in 42 seconds; **1,561 tasks**, 71 executed and 1,490
  up-to-date.
- Device: Samsung SM-S938U1, Android 16 / API 36, temporarily switched to gesture navigation.
- Server: bounded local synthetic fixture reached only through `adb reverse`; no production server,
  personal credential, contact, participant, or message content was used or retained.
- The Play-installed production package `com.bluegreengatorapps.messages` remained installed at
  version code 78 and was never cleared, replaced, or launched for this replay.

## Final implementation

- Android predictive Back remains explicitly enabled.
- Root, authenticated, and setup route layouts use headerless Expo Router SDK 57.0.20
  `ExperimentalStack` navigators.
- `app/(setup)/_layout.tsx` makes all first-run screens one nested root route. Normal first-run still
  enters explicit `/welcome`; authenticated recovery still enters explicit `/permissions` without
  anchoring Welcome underneath it.
- Permissions completion keeps the existing absolute `router.replace('/home')`. Because setup and
  the authenticated app now diverge at the root navigator, that action replaces the single
  `(setup)` route with `(app)` in one exact one-pop/one-push native operation.
- The Android build guard reads all three layouts and rejects a standard Stack, a missing
  `ExperimentalStack`, or a visible native header in any of them.
- The reviewed Router patch still redispatches an exact prevented pop to the existing
  `beforeRemove` guards, uses the navigation-theme background, and omits an explicitly hidden native
  header. The React Native Screens patch remains narrowly limited to identity-matched uncommitted
  pairs and an exact sole-root replacement; unmatched, last-root, non-top, or broadened operations
  still fail closed.

Two sequencing approaches were rejected by real device evidence before the final design:

1. Removing all setup leaves and replacing Home in one JavaScript turn caused React Native Screens
   to receive multiple native pops together.
2. Continuing the unwind from transition/focus callbacks produced separate React renders, but
   Fabric still coalesced the native removals into one mount batch.

The diagnostic build exposed the exact native failure:

```text
java.lang.IllegalStateException: [RNScreens] Attempt to pop non-top screen
at com.swmansion.rnscreens.gamma.stack.host.StackContainer.applyOperationsAndComputeFragmentManagerOperations
```

The nested setup navigator removes the need for a multi-pop sequence instead of broadening the
native patch to accept it.

## Exact-package Samsung replay

| Check                 | Result                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fresh launch          | Welcome rendered from cleared disposable-app data.                                                                       |
| Nested committed Back | Welcome → Connect, then a real edge gesture returned to Welcome. PID stayed `17442`; no crash marker appeared.           |
| Setup completion      | The synthetic connection reached Permissions. `Continue to Messages` reached Messages with PID `17442` before and after. |
| Native crash scope    | Logcat contained neither `FATAL EXCEPTION` nor `Attempt to pop non-top screen` for completion or later Back operations.  |
| Root committed Back   | With the app launched from the Samsung launcher, the edge gesture returned to `com.sec.android.app.launcher`.            |
| Relaunch persistence  | Relaunch rendered Messages, not Welcome, Connect, or Permissions; no stale setup route was exposed.                      |

## Earlier full interaction matrix retained

The exact package replay intentionally repeated only the package-sensitive closure path. The prior
physical development-client matrix remains the detailed behavior proof:

| Surface                      | Canceled Back                                         | Committed Back                                                                            |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root and clean stack         | Preview cancellation retained the source.             | Preview reached its shown destination; root exited; relaunch did not expose stale setup.  |
| Chat search and multi-select | Local state remained attributable during calibration. | Search closed before chat removal; selection closed before chat removal.                  |
| Database-backed chat body    | Draft remained present.                               | Route left without a destructive prompt; reopening restored the encrypted-database draft. |
| Empty attachment tray        | True out-and-back gesture kept tray and chat open.    | Closed only the tray and kept the chat open.                                              |
| Staged attachment            | True out-and-back kept the staged file and chat open. | Cancel retained the file; explicit Discard removed it and then left the chat.             |
| Theme Studio                 | Keep Editing retained the changed value.              | Explicit Discard preceded exit.                                                           |
| New Message                  | Cancel retained recipient/authored state.             | Explicit Discard preceded return to the inbox.                                            |
| Scheduled Edit               | Cancel retained changed text.                         | Explicit Discard preceded return to the scheduled list.                                   |
| Voice Recorder               | Cancellation kept recording and the timer advanced.   | Keep Recording retained it; Discard closed only the recorder without sending audio.       |

No reachable production WebView exists, so there is no WebView-history branch to test.

## Host and review gates

- Predictive-Back Android guard: **23/23 passed**.
- Strict TypeScript: passed.
- Focused source/test ESLint, Prettier, and scoped whitespace check: passed.
- Architecture: **51/51 passed**, including live boundaries, cycle checks, entry ordering, and
  scheduled-recovery ownership.
- Migrations: **5/5 passed**; 49 sequential migrations through
  `0049_inbox_search_postings`.
- Full Jest under pinned Node 24: **493 suites passed / 2 intentionally skipped; 5,865 tests passed /
  2 intentionally skipped; 0 snapshots**. A first invocation under Node 26 was stopped because the
  shared `better-sqlite3` binary correctly reported an ABI mismatch (module ABI 137 versus runtime
  ABI 147); no dependency rebuild was performed, and the required pinned-Node run was green.
- Frozen-candidate DB report: the command exited successfully but is not claimed clean. It reports
  **2,016 mutations and 334 existing inventory issues**: 304 stale-field, 14 stale-entry, and 16
  unapproved findings. None references a file touched by this remediation slice.
- Current shared-tree DB report after surgical integration: **2,060 mutations / 1,579 structural or
  membership issues**. Concurrent unrelated DB/scanner work makes this moving-tree baseline much
  noisier; the new setup layout and Android guard files contain no finding, and no clean inventory
  claim is made.
- Independent native/navigation review: **GO** on the nested boundary, device replay, and closure;
  the reviewer separately confirmed that direct `/permissions` recovery must remain unanchored.

The device proof, not host mocks, supplies the native gesture and crash evidence. The main dirty
checkout received only the new setup layout and narrow guard/test additions; candidate-only
experiments were not cherry-picked over other sessions' work.

## Cleanup

The synthetic fixture was stopped and reverse port 59733 removed. Disposable candidate data was
cleared, the candidate package was uninstalled, and the preserved `0.1.51-debug` APK was restored.
The Samsung returned to three-button navigation (`navigation_mode=0`) with USB stay-awake disabled.
Final package inspection still showed the untouched production app at `0.1.57` / version code 78.
