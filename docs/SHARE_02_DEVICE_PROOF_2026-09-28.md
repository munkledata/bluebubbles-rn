# SHARE-02 owned Android share-intake proof — 2026-09-28

> **Status: DONE.** The owned intake, exact SHARE DB certificate, current AAB inspection, real
> code-1-to-code-2 no-data-wipe upgrade, all ten conservative route/payload pairs, connected
> embedded-release lifecycle, fresh-install replay, and owner-authenticated App Lock cycle are
> green. This record contains no phone number, conversation
> identifier, private path, screenshot, raw chooser dump, credential, server URL, or shared-content
> body.

## Candidate and scope

- Repository: the current local working tree on 2026-09-28. It contains concurrent remediation
  work and is not represented as a frozen Play candidate.
- Device: Samsung SM-S938U1, Android 16 / API 36. Warm upgraded routing used the exact-current
  local debug APK; an embedded-bundle release APK from the same source was then installed for the
  cold/background, fresh-install, and App Lock proof.
- Session: the embedded release connected only to an isolated loopback fixture with one synthetic
  chat. Upload capability flags were injected into that disposable fixture in memory; no
  repository source, deployed server, or retained credential changed.
- Intake: product-owned `gator-share-intake` and `gator-share-shortcuts` Expo modules. The retired
  `expo-share-intent` dependency and parser are not used.
- Safety limits: at most 10 `content://` files, 128 MiB per file, 512 MiB per batch, 64 KiB text,
  one 60-second absolute capture deadline, 1 GiB / 32-batch private-cache bounds, atomic manifest
  publication, restart cleanup, and exact acknowledge/release/discard ownership.
- Direct Share identity: bounded display labels plus opaque HMAC identifiers. Resolution is limited
  to the same canonical active-chat prefix used for publication and is fenced to the current
  account generation. App Lock publishes no personalized rows.

## Verification completed

### Host and native boundaries

- Intake JVM policy/storage suite: **29/29 passed**.
- Shortcut native suite before the final token-failure correction: **10/10 passed**. The focused
  final token resolver suite then passed **3/3**, covering one immutable key/epoch snapshot,
  deterministic resolution, epoch-rotation invalidation, and operational failure propagation.
- Final focused JavaScript shortcut/navigation run: **2 suites / 31 tests passed / 0 snapshots**.
  This includes one-attempt no-match behavior, account-generation checks, generic fallback, exact
  batch routing, and best-effort usage ranking that cannot veto a valid target.
- Final settlement-fence verification: **2 Node suites / 51 tests passed** and **3 component suites
  / 133 tests passed**. Every settlement API captures its account DB and lease before the first
  await; teardown waits for native settlement, receipt cleanup, store clearing, and any allowed
  next-batch drain.
- Strict TypeScript passed. The focused SHARE DB scanner certificate passed **1/1** over **21 unique
  reviewed records**, with **0 stale** and **0 mismatched** records. The repository-wide scanner
  still reports unrelated concurrent structural-membership drift; it is not represented as green.

### Exact-current Android artifacts

- Release AAB: **82,933,235 bytes**, SHA-256
  `4e7490e17f21cae027e7b55d9a885fc5301bbe354412c27eb32664a85e05b382`.
- Debug APK used for the code-1-to-code-2 route replay: **239,580,581 bytes**, SHA-256
  `4bf988c048cf1bdcbfbbb99c4766b0f4c63f0b57397ef1647b77aa5762e8f0b2`.
- Embedded-bundle release APK built from the same frozen source: **152,547,350 bytes**, SHA-256
  `88ad261a9150ece41c5a55d05c574c65bd1692b843f8c3c9506a41701065ee7e`.
- All three identify `com.bluegreengatorapps.messages`, version name `0.1.51`, version code `2`,
  and minimum/target API 36 where applicable.
- Focused Android artifact proof passed **3/3** for the owned generic filters, Direct Share metadata,
  pre-React MainActivity capture, packaged native markers, and absence of `expo-share-intent`.
  The repository protobuf parser then inspected the exact AAB using an in-memory, exact-path and
  exact-digest exception set for the candidate's 32 already-known native-symbol path findings. It
  reached every packaged manifest/shortcut/DEX check and reported only the separately deferred
  missing Google Maps metadata. The strict full Android release guard therefore remains red; this
  record claims only the green SHARE-owned packaged boundary.

### Hostile provider on the Samsung

The actual Android `ACTION_SEND` boundary rejected or contained the following disposable-provider
cases without sending content: provider-open failure, false declared size, actual over-size stream,
empty stream, mid-stream failure, 11-item count overflow, aggregate-byte overflow, traversal-style
names, a non-cooperative stalled provider at the 60-second deadline, and process-kill/restart
cleanup. UI responsiveness and a normal bounded control were also observed. Only exact disposable
fixture state was removed afterward.

### Ordinary and Direct Share on the Samsung

- Warm and cold text intake reached recipient review or the selected opaque Direct Share target.
- A gallery image reached the selected target. Resolution completed in 37 ms on a clean current
  Metro bundle.
- A real MP4 staged as one `video/mp4` / `.mp4` item and reached the selected target.
- A PDF staged as one `application/pdf` / `.pdf` item and reached the selected target.
- `ACTION_SEND_MULTIPLE` staged two ordered PNG items and reached the selected target.
- The exact final two-image batch was discarded through the app-owned native discard path;
  the diagnostic result was `hadBatch=true`, `discarded=true`, `remainingBatch=false`.
- No message was sent, no composer send action was invoked, and no private chooser capture was
  retained.

### Version-code-increasing upgraded candidate

- Android reported code `1` / name `0.1.51` before the replacement and code `2` / name `0.1.51`
  afterward. `firstInstallTime` remained `2026-09-28 16:21:45`; `lastUpdateTime` advanced from
  `18:19:21` to `19:35:16`. The install used `adb install -r`; no uninstall or data clear occurred.
- The upgraded code-2 debug candidate passed generic text; Direct Share image; generic and Direct
  Share real video; generic and Direct Share PDF; and generic and Direct Share two-item routing.
  The generic multiple row exposed exactly two attachment-removal controls. Every staged batch was
  explicitly discarded and no send/start action was invoked.
- The later same-code release-APK replacement also preserved the original install time and advanced
  `lastUpdateTime` to `19:52:17`. After connecting it to the isolated fixture, a killed-cold generic
  image reached New Message exactly once and a resident-background Direct Share text reached the
  synthetic chat exactly once. The image was discarded and the text draft was cleared. A later
  process kill/relaunch replayed neither item. These two rows complete the conservative upgraded
  route/payload matrix at **10/10**.

### Fresh-install/background replay

- The exact embedded-release APK was uninstalled and freshly installed, then connected to the same
  isolated fixture. Generic text, image, and real video plus Direct Share image, PDF, and two-image
  entry all reached the expected review surface. The two-image batch exposed exactly two attachment
  controls.
- Each fresh batch was cleared or discarded without invoking Send. The final ordinary process kill
  and launcher relaunch returned to the inbox with no New Message route, attachment control, text
  marker, or outgoing bubble.

### Owner-authenticated App Lock

- App Lock began off. Enabling it required the owner's fingerprint and immediately removed every
  personalized Direct Share shortcut; Android's shortcut inventory was empty.
- With Gator killed, the image chooser exposed only the generic Gator target. Selecting it opened
  the biometric prompt. Cancelling that prompt showed only `Gator is locked`, `Authenticate to
continue`, and `Try again`; no chat, composer, attachment, search surface, or shared marker was in
  the UI tree.
- After owner authentication, the durable batch reached New Message exactly once with one
  attachment control. It was discarded without sending. App Lock was restored to its original off
  state, and a final process kill/relaunch returned to the inbox with no lock gate or replay.

## Cleanup and evidence limits

- The disposable provider app was uninstalled, the isolated fixture server was stopped, and only
  its `tcp:43117` reverse mapping was removed. The existing Metro `tcp:8081` mapping and installed
  Gator release remained.
- All exact `share02*` diagnostic screenshots, UI dumps, APK-tool output, helper APKs, and fixture
  directories were removed from the Mac and phone. Verification found zero remaining matching
  temporary paths.
- The separately deferred Maps metadata and reviewed native-symbol path findings keep the strict
  full Android release guard red. They are outside the SHARE-owned boundary and are not represented
  as green here.

All `SHARE-02` acceptance gates are complete. No message was sent and no private proof artifact or
credential was retained.
