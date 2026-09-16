# DL-01 supporting v66 download evidence — 2026-09-15

This is supporting historical evidence only. It is **not** exact-current-candidate or Play-install
proof for the current `DL-01` source, because the v66 artifact predates the durable destination
receipt and strict synced-wallpaper admission changes.

## Artifact and installation provenance

- The source, release commit, AAB identity, Play-delivered base APK identity, signing certificate,
  and original phone installation source for version `0.1.49` / code `66` are recorded in
  [`WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md`](./WEB_01_03_PLAY_DEVICE_PROOF_2026-09-14.md#play-v66-app-lock-completion).
- For this narrow download run, the exact installed v66 set was copied as `base.apk` plus
  `split_config.en.apk`, `split_config.xxhdpi.apk`, and `split_config.arm64_v8a.apk`, then installed
  with ADB onto a clean API-35 arm64 emulator. The emulator install was therefore a **sideload of
  Play-extracted bytes**, not an install performed by Google Play.
- The emulator used only the isolated local synthetic fixture through `adb reverse tcp:1236`; this
  did not exercise a production server or credential.

## Narrow observations

- An invalid nine-byte synthetic PNG remained `Photo, not downloaded`; neither a promoted final file
  nor a partial file remained.
- The valid control used `assets/favicon.png`: 96×96 pixels, 13,191 bytes, SHA-256
  `b56fdb8a77c6959edc9e92c5ad589c0624848e03213360cf0245f7d051ecf6f2`. It rendered as `Photo`, the
  final file matched those bytes, and the partial namespace was empty.

These observations prove only the older artifact's basic valid/invalid actual-file behavior. They do
not prove current receipt ordering/restart behavior, strict wallpaper admission, the full hostile
transport and quota matrix, process-death recovery, legacy/account isolation, API24/25 behavior, or
current-source packaging.

## Cleanup

The synthetic fixture was stopped, its reverse removed, the v66 app was uninstalled from the
emulator, the emulator was shut down, and the temporary copied-split directory was deleted. The
physical phone's installed app and data were not changed by this emulator run.
