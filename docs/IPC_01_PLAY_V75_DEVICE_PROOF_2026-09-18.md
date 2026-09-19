# IPC-01 and SHARE-01 Play v75 device proof — 2026-09-18

> **Disposition:** `IPC-01` and `SHARE-01` are `DONE`. Two complementary, natural Google Play
> upgrades from the approved legacy shortcut-publishing build proved that the current app removes
> removable conversation shortcuts and converts a launcher-retained pinned shortcut into a
> disabled, generic, non-share target. Exact-v75 package validation, inbound resolver checks, and an
> outbound attachment-share control also passed.
>
> **Scope limit:** This proof closes the shortcut-system-state slice of `REL-005B`, not the parent.
> `REL-005B` still requires the complete account-A → disconnect → account-B DB, files, logs,
> notifications, queues, network, and system-state inspection. The broader release remains
> conditional.

## Candidate and baseline identity

| Field                                    | Observed value                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| App/package                              | Gator / `com.bluegreengatorapps.messages`                                                       |
| Approved legacy Play baseline            | `0.1.40` / Android version code `53`; release commit `0564a80b572f16faf63c4d7b13c798a72451c845` |
| Captured Play-delivered code-53 base APK | 72,423,401 bytes; SHA-256 `e9962a8b9aceb55c3aa5bde276c34b75e11225da4e5b0c41bf6b3bb835b2cb84`    |
| Current Play candidate                   | `0.1.55` / Android version code `75`                                                            |
| Current source                           | `546750a0844adc48733436f26d81ebea63f0319c`                                                      |
| Current release commit                   | `9c73c1ffb0d4d63ecc562ab988ae73f28c8750dc`                                                      |
| Submitted AAB                            | `gator-release-0.1.55-v75-9c73c1f.aab`; 57,878,322 bytes                                        |
| AAB SHA-256                              | `86e7ee236f2caa644e97b645fc9d0ec1fa562fc105ffa5bb26549d44f42b3197`                              |
| Install/update source                    | Google Play / `com.android.vending`                                                             |
| Play delivery certificate SHA-256        | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                              |
| Device boundary                          | Physical Samsung; Android 16 / API 36                                                           |

`aapt` independently identified the captured historical base APK as package
`com.bluegreengatorapps.messages`, version `0.1.40`, code `53`, and compile/platform API `36`.
`apksigner` verified the Play delivery certificate above. No code-53 AAB hash is claimed: the
repository has no retained code-53 AAB identity, and the separately documented code-56 AAB is not
this baseline.

The recorded v75 validation result is `passed` from `scripts/check-android-build.mjs`, including the
packaged-artifact, identity, signature, hash, and native-path checks. Exact-source Expo autolinking
contained the cleanup-only `gator-share-shortcuts` module and outbound `expo-sharing`, while
`expo-share-intent` was absent.

## Privacy-safe synthetic fixture

The existing loopback-only DL-01 fixture was extended with two authenticated endpoints:

- `POST /api/v1/contact/query` returns one synthetic contact only when the request includes the
  reserved `dl01-fixture@example.invalid` address.
- `GET /api/v1/contact/dl01-fixture-contact/avatar` returns a tiny synthetic PNG.

The focused fixture test passed **7/7**. No synthetic Android contact was created. For the avatar
run, external Wi-Fi and mobile data were disabled before temporarily granting Contacts access;
only the ADB-reversed loopback fixture remained reachable. Contacts access was revoked immediately
after shortcut publication. No personal contact content, account identifier, endpoint, or raw
shortcut dump is retained in this proof, and the tested app data was erased afterward by uninstall.

## Pass A — exact pre-launch migration timing

This pass deliberately used the generic app-icon fallback so that the update boundary could be
observed without Contacts access.

1. Google Play installed code 53. The synthetic chat published one dynamic shortcut with the
   legacy Direct Share category.
2. The shortcut was pinned only through Samsung's launcher UI. Android then reported the same row
   as both dynamic and pinned.
3. Google Play updated the package in place to code 75. The package retained its original
   `firstInstallTime`, its Play installer, and the same Play certificate.
4. Before the first v75 foreground launch, the same pinned row still carried its legacy label,
   launch metadata, and Direct Share category. This is the required no-data-wipe, pre-cleanup
   survivor observation.
5. The first v75 foreground launch removed the dynamic copy and changed the launcher-owned pinned
   row to `Disabled: by app`, the `RETIRED_SHORTCUT` category, the `gator.retired=1` marker, generic
   app-only label/intent data, and the generic Gator icon.
6. A second launch left the shortcut's exact last-changed timestamp unchanged, proving that cleanup
   is idempotent. Tapping the disabled pin produced Android's “This shortcut is no longer
   available” message instead of opening a chat.

The synthetic pin was then removed through the launcher UI.

## Pass B — distinct bitmap-avatar removal

This pass exercised the stricter privacy branch with a visually distinct synthetic avatar.

1. Google Play reinstalled code 53. With external networking disabled and the temporary Contacts
   permission active, the app synchronized the fixture chat and authenticated synthetic contact.
2. Android reported a dynamic shortcut with a bitmap-backed icon path rather than an app-resource
   fallback. Samsung's launcher long-press menu visibly showed the synthetic label and distinct
   avatar.
3. The shortcut was pinned through the launcher UI. Android reported the same row as dynamic and
   pinned, with its bitmap path and legacy Direct Share category intact.
4. Contacts permission was revoked, and Wi-Fi/mobile data were restored before the Play update.
5. Google Play updated code 53 to code 75 in place, preserving `firstInstallTime` and the Play
   installer/certificate.

During this second replacement, Play unexpectedly started Gator's `MainActivity` itself. Android's
activity event log attributed that start to `com.android.vending`, so there is no claim that this
pass captured a pre-first-launch v75 dump. After that Play-triggered launch, the same launcher-owned
pinned ID was disabled and generic: the bitmap path was gone, the icon was the app resource, the
legacy category was replaced by `RETIRED_SHORTCUT`, and `gator.retired=1` was present. The publisher
cannot create a launcher pin, so the retained pinned ID is the migrated legacy row rather than a new
v75 shortcut.

A later manual launch left the row's exact last-changed timestamp unchanged. The launcher displayed
only the generic disabled Gator pin, with no synthetic chat label or avatar. The pin was then removed
through the launcher UI, and the package shortcut query returned an empty successful result.

Pass A supplies the exact pre-launch survival and first-launch timing observation. Pass B supplies
the distinct bitmap-avatar scrub. Together they cover the complete migration requirement without
misstating the Play-triggered launch as a manual launch.

## Inbound and outbound share results

Four real Android resolver launches were exercised against Play-installed v75 with bounded
synthetic content:

| Intent                 | MIME/content          | Gator or legacy conversation targets | Result |
| ---------------------- | --------------------- | ------------------------------------ | ------ |
| `ACTION_SEND`          | `text/plain`          | 0                                    | Pass   |
| `ACTION_SEND`          | `image/png`           | 0                                    | Pass   |
| `ACTION_SEND_MULTIPLE` | two `image/png` files | 0                                    | Pass   |
| `ACTION_SEND`          | `application/pdf`     | 0                                    | Pass   |

In every case Android opened its resolver and package-specific resolution returned zero Gator
activities. Neither Gator nor a conversation chip appeared. The synthetic image/PDF files were
removed afterward.

For the positive outbound control, sharing a bounded synthetic fixture attachment from Gator opened
Android's chooser through `expo-sharing`. This proves the exercised attachment/media outbound path;
it is not claimed as a backup-export test.

## Cleanup and final phone state

After evidence capture:

- the synthetic pin was removed through the launcher;
- the fixture server and ADB reverse mapping were stopped;
- the three synthetic public files were deleted;
- Gator was uninstalled, erasing the synthetic session/database and any app-local contact copies;
- current v75 was installed fresh from Google Play under the normal tester account;
- the final package reports code `75`, version `0.1.55`, installer `com.android.vending`, and
  `READ_CONTACTS: granted=false`;
- `cmd shortcut get-shortcuts --user 0 --flags 31 com.bluegreengatorapps.messages` returned
  `Success` with no rows;
- per-app automatic updates were restored; and
- the temporary Play Store Internal App Sharing device switch was turned off.

## Evidence boundary and disposition

The [v72 hostile-provider proof](./IPC_01_PLAY_V72_DEVICE_PROOF_2026-09-16.md) remains authoritative
for composer-paste count, byte, deadline,
descriptor-close, process-kill/relaunch, cleanup, and post-restart usability. That destructive matrix
was not rerun on v75. This v75 proof closes the sole migration gap left by v72 and adds exact-current
inbound resolver absence plus an outbound attachment-share control.

Accordingly:

- `IPC-01` is done: enabled composer paste has its v72 native/lifecycle proof, and disabled public
  share intake has exact-v75 package, resolver, and legacy-migration proof.
- `SHARE-01` is done: the unsafe package/surfaces are absent, removable rows disappear, and a real
  Play-upgraded pinned row loses its label, avatar, Person/deep-link/share-category behavior before
  being disabled.
- `REL-005B` remains in progress: only its shortcut-system-state subproof is complete.
- `SHARE-02` remains a separate future owned-intake item; nothing here re-enables public inbound
  sharing.
