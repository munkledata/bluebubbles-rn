# IPC-01 exact Play v68 candidate checkpoint — 2026-09-15

> **Evidence class:** Source review, focused host/native tests, signed Android App Bundle validation,
> EAS submission, and live Google Play Internal-track readback.
>
> **Disposition:** Version 68 contains the `IPC-01` paste-cache path correction and is live on the
> private Internal Testing track. This checkpoint does **not** close `IPC-01`: no phone was connected
> after publication, so installation and the hostile-provider/lifecycle matrix remain open.

## Exact candidate and delivery

| Field                      | Observed value                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                         |
| Version                    | `0.1.51` / Android version code `68`                                                              |
| IPC-01 implementation      | `7803d2e3bf6beb12eedef2f7f34984e3a65bdfbd`                                                        |
| Release commit/branch      | `139bb88194941a196e1e6ba63b61784ea61eedad` / `release/android-0.1.51`                             |
| Release run                | `android-0.1.51-7803d2e-20260916024651`                                                           |
| Submitted AAB              | `gator-release-0.1.51-v68-139bb88.aab`; 56,807,134 bytes                                          |
| AAB SHA-256                | `1f358285d35133e388c09be47a5edb9eae5248f502a60fd9f13568374022e2de`                                |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| EAS submission             | `7aba0f10-9998-4a28-9560-b916fb911636`; `FINISHED`; no reported error                             |
| Submission interval        | `2026-09-16T03:01:43.445Z`–`2026-09-16T03:03:26.794Z`                                             |
| Live Play state            | Internal track; release `0.1.51`; status `completed`; version code `68`                           |

The release branch was fast-forwarded into local `master`; it changes only the package and lockfile
version from `0.1.50` to `0.1.51`. The AAB and its release receipts remain in the isolated release
worktree pending device proof and final documentation reconciliation.

## Why a new candidate was required

Play v67 accepted rich-paste input at the Android editor boundary but logged `paste cache cleanup
failed` and `paste batch rejected` before it queried or opened the test provider. The strict native
path check required every raw app-cache path to equal its canonical spelling. Some Android devices
expose the same app sandbox through an operating-system-owned ancestor alias, so that rule could
reject the legitimate fixed `pasted-in` cache root.

The v68 source permits only that inherited ancestor alias. It still rejects:

- an alias or symlink at the fixed `pasted-in` root;
- `..` traversal or a symlink below that root;
- protected DB paths whose raw identity does not match the app-provided root spelling; and
- create/delete helpers that could otherwise treat a symlinked root as trusted.

An independent review initially returned **NO-GO** after finding that direct batch cleanup could
trust a symlinked final root. The implementation was corrected before commit, and the reviewer then
returned **GO for source readiness**. The remaining same-UID race assumption matches the existing
app-private attachment-cache model and is not evidence of cross-app access.

## Verification completed

- Paste-cache Kotlin policy tests: **21/21 passed**, including trusted ancestor aliases, raw URI
  identity, traversal rejection, atomic failure cleanup, and rejected create/delete through a
  symlinked final root.
- Matching bounded-download Kotlin policy tests from the independent review: **42/42 passed**.
- Paste hardening Jest contract: **1 suite / 10 tests passed**.
- TypeScript: **passed**.
- DB-write report: **1,961 classified mutations; zero structural or membership errors**.
- Production Gradle build: **1,334 tasks; BUILD SUCCESSFUL in 8m02s**.
- Release validation: package/version/signature, packaged manifest/DEX, and fresh native-path proof
  passed for the exact v68 AAB.
- EAS readback: submission status `FINISHED`, no error.
- Android Publisher readback: the Internal track returned only release `0.1.51`, version code `68`,
  status `completed`; the temporary read-only edit was deleted immediately afterward.
- Diff whitespace check: passed.

Expo Doctor reported **19/20 checks passed** and recommended newer SDK 57 patch releases for 28
Expo packages. The release build treated this as a non-fatal advisory and compiled the repository's
reviewed pinned dependency set. No dependency upgrade was mixed into this candidate.

## Submission recovery record

The guarded release runner's first submission invocation failed before creating an EAS job because
the outer clean worktree had no `node_modules`; EAS could not import `@expo/config-plugins` while
resolving `withNoWebSocketRedirects`. The runner preserved `submission_unknown` rather than claiming
success. A read-only EAS job audit proved that the newest job was still v67 and no v68 upload existed.

Recovery then:

1. installed the exact lockfile dependencies only inside the isolated worktree;
2. loaded the production config plugin successfully;
3. rechecked the retained AAB's exact SHA-256 and clean worktree;
4. submitted that same AAB once with pinned EAS CLI 21.5.0; and
5. verified both terminal EAS success and live Play Internal state.

The successful direct recovery job is authoritative for submission outcome. The earlier runner
state remains preserved as incident evidence and must not be described as a clean runner-managed
submission receipt.

## IPC-01 work still open

On an owner-authorized phone updated from Play to v68:

1. confirm the installed version, Play installer, signing identity, and natural-update continuity;
2. repeat public `ACTION_SEND`, `SEND_MULTIPLE`, and Direct Share absence checks;
3. exercise composer paste through a hostile `content://` provider for too many items, false and
   missing sizes, per-file and aggregate overflow, empty/junk content, provider failure, and a
   cancellation-resistant or never-ending stream;
4. prove the 60-second batch deadline, provider cancellation/close attempts, bounded disk use, and
   all-or-none publication;
5. kill the app during an active copy, relaunch/reattach, and prove stale `.pending` cleanup while a
   protected committed batch remains; and
6. confirm the app remains usable and the provider permission lease is released on every terminal
   path.

These are native/device claims. Host unit tests, AAB inspection, and live Play publication do not
substitute for them.

## Privacy and cleanup

- No production message body, private endpoint, push payload, device serial, private database
  content, service-account material, or API-key value is retained in this report.
- The temporary Play service-account symlink was removed after submission; the original credential
  file was not changed.
- The temporary Android Publisher edit used for live readback was deleted successfully.
- The private AAB/release workspace is intentionally retained until v68 device proof is complete.
