# IPC-01 exact Play v72 device proof — 2026-09-16

> **Evidence class:** Exact Google Play Internal candidate on an owner-authorized physical Android
> device, using a disposable hostile `content://` provider and IME fixture.
>
> **Disposition:** The `IPC-01` composer-paste hostile-provider, bounded-copy, deadline,
> process-kill/relaunch, and native-publication boundaries passed on v72. Current public-share
> absence also passed. Parent `IPC-01` remains **IN_PROGRESS** only because this post-cleanup install
> cannot prove a no-data-wipe upgrade from a real legacy shortcut-publishing build; that shared
> `IPC-01`/`SHARE-01` migration row remains open.

## Exact candidate and fixture

| Field                             | Observed value                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| App/package                       | Gator / `com.bluegreengatorapps.messages`                                                                          |
| Installed version                 | `0.1.52` / Android version code `72`                                                                               |
| Source commit                     | `e3ff3515292389abff05850a6bf7adccacf2cd0f`                                                                         |
| Release commit                    | `734e4f15b9d4aa3dd59e99cdc8a03c15753e6aff`                                                                         |
| Release run                       | `android-0.1.52-e3ff351-20260916072132`                                                                            |
| Submitted AAB                     | `gator-release-0.1.52-v72-734e4f1.aab`                                                                             |
| AAB SHA-256                       | `bf9f56d90db76cedaa7b18d4ba020f47a206cebe41618f7002084726316cb533`                                                 |
| EAS submission                    | `2d7d62a5-a795-4761-b17b-d7d786658833`; terminal success                                                           |
| Install source                    | `com.android.vending`                                                                                              |
| Play delivery certificate SHA-256 | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                                 |
| Update continuity                 | `firstInstallTime=2026-09-14 05:28:05`; `lastUpdateTime=2026-09-16 01:52:10`; existing session retained            |
| Device boundary                   | Samsung; Android 16 / API 36                                                                                       |
| Fixture                           | `ipc01-device-fixture-v68/fixture.apk`; SHA-256 `f24526347cf320898719692c8091fe4b3e472d0c5fe3264de12f4e408fae441b` |

The installed package had four Play-delivered splits, all carrying the recorded Play delivery
certificate. No uninstall, data clear, sideload, or local-signature replacement was used for Gator.

V72 adds commit `b3959e8`'s API 31+ permission-token hardening and version-pinned ReactEditText
wrapper above the v68 cache-policy source. The cache/storage policy and its native tests are
unchanged; today's repeated `grant_current=-1` live-path results directly exercise the later
permission change on API 36.

## Hostile-provider results

Every row began with an idle fixture and a mounted/focused Gator composer advertising the full
receive-content MIME list. “No publication” means the UI hierarchy contained zero
`Remove attachment` controls after settlement.

| Case                          | Exact result                                                                                                                                                                                   | Outcome |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Provider open failure         | One query and one failed open; no writer; live IME grant returned to denied; no publication                                                                                                    | Pass    |
| Declared per-file oversize    | One metadata query; zero opens/writers; live IME grant returned to denied; no publication                                                                                                      | Pass    |
| False small size              | Provider wrote exactly `134,217,729` bytes (128 MiB + sentinel); Gator rejected, published nothing, released the live grant, and package cache remained `753,664` bytes                        | Pass    |
| Empty stream                  | One query/open; writer closed with zero bytes; no publication; live grant released                                                                                                             | Pass    |
| Reliable mid-stream failure   | Provider injected an error after `2,097,152` bytes; no publication; active writer returned to zero; live grant released                                                                        | Pass    |
| Too many items                | With an 11-item clipboard already populated and Android's own preview traffic removed from the counters, Gator performed zero provider queries and zero opens; no publication                  | Pass    |
| Declared aggregate oversize   | Five 110 MiB declarations produced five queries and zero opens; no publication                                                                                                                 | Pass    |
| Actual aggregate oversize     | Five hidden-size streams opened; the provider observed a broken pipe after `536,936,448` bytes (512 MiB plus one pipe buffer); no publication; cache remained `753,664` bytes                  | Pass    |
| Traversal-style display name  | A valid 4 KiB stream named with mixed `..`, slash, backslash, query, and angle-bracket characters produced exactly one private attachment chip; live grant released; the chip was then removed | Pass    |
| Valid missing-size control    | One 4 KiB hidden-size stream produced exactly one chip; live grant released; the chip was removed                                                                                              | Pass    |
| Valid two-file atomic control | Two queries, two opens, two closed writers, and `8,192` total bytes produced exactly two chips together; both were removed                                                                     | Pass    |

Clipboard rows used fixture-owned direct grants so Android could expose multiple items. The fixture
revoked all 11, 5, 5, and 2 grants after their respective rows. The single-item IME rows used the
real `InputContentInfo` permission path and each live terminal path ended with
`grant_current=-1`.

Android itself queried every clipboard URI twice while preparing its clipboard preview. For the
count and aggregate tests, counters were reset only after the populated clipboard returned focus to
Gator; this isolates Gator's provider traffic without altering the clipboard or its grants.

## Deadline and blocked-provider result

The cancellation-resistant `stalled` provider returned a pipe and then slept for 90 seconds before
attempting its first byte.

- Fixture stream start mapped to device wall time `01:59:15.481`.
- Gator logged `paste batch rejected` at `02:00:15.487`: **60.006 seconds** after start.
- The UI published zero attachment chips and remained responsive.
- The live IME grant returned to denied.
- When the provider woke at `02:00:45.483`, it observed a broken pipe; its writer closed and the
  active-writer count returned to zero.

The fixture's `cancellation_count=0` is not evidence of a missed Gator cancellation. Android routes
the read-only typed open outside the fixture's cancellation-aware override and detaches the remote
`CancellationSignal` after open returns. The observable post-open abort is the descriptor close,
proved here by the provider's broken pipe. Independent review confirmed the 60-second result and
rejected an unnecessary `Os.poll` production experiment; that experiment was fully reversed, and
no v73 rebuild is warranted.

## Process-kill, restart cleanup, and usability

An `endless` provider stream was active with its temporary grant held. The provider had written
`16,121,856` bytes when Gator was backgrounded and killed with `am kill` (never `force-stop`).

- The old Gator PID disappeared.
- The provider immediately recorded `broken_pipe=1`, `writers_closed=1`, and `active_writers=0`.
- Relaunch returned to the retained Messages session with no stale attachment chip.
- Reattaching the composer reran native startup cleanup. Android then reported only `753,664` total
  package-cache bytes, less than the interrupted 16 MiB partial, proving the `.pending` copy did not
  survive cleanup.
- A subsequent hidden-size 4 KiB commit produced exactly one chip and released its grant, proving
  the restarted native bridge and composer remained usable. The chip was removed.

Immediately after process death, `dumpsys activity permissions` still showed the killed row under a
system-owned `InputContentUriTokenHandler`. This is an Android lifecycle caveat, not a Gator live-path
leak: `am kill` cannot run Gator's `finally`/destroy callbacks; Android 16's system handler uses
nondeterministic finalization as its abrupt-death fallback; and the fixture IME can retain its source
`InputContentInfo` too. A later valid commit acquired and released its separate token normally while
the old system owner remained. Reinstalling the disposable fixture removed that old owner and the
URI-permission history recorded the final revoke. Therefore immediate `grant_current=-1` is required
for live success/reject/deadline paths, but is not a valid process-kill assertion.

Relevant platform contracts:

- <https://developer.android.com/reference/android/view/inputmethod/InputContentInfo#requestPermission()>
- <https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/inputmethod/InputContentUriTokenHandler.java>
- <https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/inputmethodservice/InputMethodService.java#4595>

## Public-share containment

- `android.intent.action.SEND` resolver count for Gator: **0**.
- `android.intent.action.SEND_MULTIPLE` resolver count for Gator: **0**.
- `cmd shortcut get-shortcuts` returned no Gator shortcuts.
- Installed-package inspection showed only outbound visibility queries, not inbound share filters.

Public `ACTION_SEND`, `SEND_MULTIPLE`, and Direct Share intake therefore remain disabled. This proof
applies to the narrower foreground composer-paste feature and current installed containment. It
does not prove cleanup of a shortcut that a pre-cleanup build had already published.

## Evidence boundary

The production sandbox correctly prevents ADB from directly listing Gator's private `pasted-in`
directory. Partial cleanup is instead proved by the provider's exact byte counter, package-wide
cache size after reattach, zero stale publication, and the successful post-restart control. The
deterministic native policy tests remain the evidence for corrupt/symlinked roots, root-entry and
batch-count ceilings, expired legacy batches, and DB-protected legacy `pasted-in` paths; seeding a
fake protected database row into the Play-signed encrypted production database would weaken rather
than strengthen this exact-candidate test.

This phone's current install began after the legacy Direct Share publisher had already been removed.
An empty v72 shortcut inventory therefore cannot prove the separate no-data-wipe legacy migration.
That proof needs an approved same-Play-signature baseline that first contains a synthetic legacy
shortcut and is then naturally updated to the cleanup build; neither an uninstall nor a differently
signed local fixture preserves the state being tested. This is the sole remaining `IPC-01` boundary
after this run and is also owned by `SHARE-01`/`REL-005B`.

No message body, account credential, private endpoint, raw provider URI outside the synthetic
fixture namespace, device serial, or service-account material is retained in this record.
