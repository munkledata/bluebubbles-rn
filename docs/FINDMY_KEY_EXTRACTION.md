# Find My Decryption Keys — Extraction Runbook

How to extract the three keys Gator needs to decrypt the local Find My caches (devices,
items/AirTags, and friend locations) on macOS 14.4+.

> First done on a **2018 Intel Mac mini, macOS 15.7.7 (Sequoia)**. The keys are **stable across
> reboots** (extract once) and **Mac-specific** (they only work on the Mac they were extracted from).

## Why this is needed

macOS **14.4+** (Sonoma 14.4 / Darwin 23.4) encrypts the local Find My caches. Decrypting them
without code injection / the Private API requires three keys that live in the login keychain,
guarded by an Apple-internal `keychain-access-group` entitlement. See
[`docs/FINDMY_DECRYPTION_PLAN.md`](FINDMY_DECRYPTION_PLAN.md) for how Gator uses them.

## The three keys

| File | Size / format | Unlocks |
|---|---|---|
| `LocalStorage.key` | 32 bytes, raw | Friend **locations** DB (`LocalStorage.db`) |
| `FMFDataManager.bplist` | 171 bytes, `bplist00` | Friend **metadata / names** (Find My Friends) |
| `FMIPDataManager.bplist` | 171 bytes, `bplist00` | **Devices + items/AirTags** cache (Find My iPhone) |

Each `.bplist` is a binary plist holding a 32-byte ChaCha20-Poly1305 symmetric key.

## Prerequisites — disable temporarily (re-enable after, see Cleanup)

1. **SIP off** — boot to Recovery (Intel: hold ⌘-R at startup; Apple Silicon: hold the power
   button → Options), open Terminal → `csrutil disable` → reboot.
   Verify: `csrutil status` → `disabled`.
2. **AMFI off** — `sudo nvram boot-args="amfi_get_out_of_my_way=1"` → reboot.
   Verify: `nvram boot-args` shows the arg.

Both are required: AMFI-off is what lets an ad-hoc/unsigned binary present the Apple-internal
`com.apple.findmy` keychain entitlement and read the keys.

## What does NOT work reliably on macOS 15 / Intel

`manonstreet/findmy-key-extractor` uses **lldb** to breakpoint FindMy.app's `SecItemCopyMatching`.
On macOS 15 + Intel this is flaky:

- The `LocalStorage.key` half (breakpoints `findmylocateagent`) **works**.
- The FMF/FMIP half (breakpoints FindMy.app) **fails** — macOS 15's lldb throws
  `KeyError: lldb_autogen_python_bp_callback_func…` when the script registers a breakpoint
  callback **re-entrantly**, and FindMy reads its keys lazily so the script then hangs.
  (Confirmed by the tool's author in repo issues
  [#2](https://github.com/manonstreet/findmy-key-extractor/issues/2) and
  [#3](https://github.com/manonstreet/findmy-key-extractor/issues/3) for this exact setup.)

So: get `LocalStorage.key` from that tool, and get the two `.bplist` keys a different way.

## The method that works

### 1. `LocalStorage.key` — from findmy-key-extractor

```bash
git clone https://github.com/manonstreet/findmy-key-extractor
cd findmy-key-extractor
python3 -m venv .venv && source .venv/bin/activate   # Homebrew Python needs a venv (PEP 668)
pip3 install -r requirements.txt
./extract.sh                                          # enter your sudo password
```

→ produces `keys/LocalStorage.key` (32 bytes). The two `.bplist` lines will likely show ❌ — that's
expected; we get those in step 2.

### 2. `FMFDataManager.bplist` + `FMIPDataManager.bplist` — the Pnut tool (the fix)

This is a small Swift program that queries the keychain **directly** (no lldb, no FindMy, no
timing) using the `com.apple.findmy` entitlement. With AMFI off, **ad-hoc signing works — no paid
Apple Developer certificate needed.**

```bash
git clone https://github.com/Pnut-GGG/FMIPDataManager-extractor
cd FMIPDataManager-extractor
swiftc -o extractor beaconstorekey-extractor.swift
codesign -f -s - --entitlements entitlements.plist extractor   # ad-hoc (-s -)
./extractor
```

→ produces `FMFDataManager.bplist` + `FMIPDataManager.bplist` (171 bytes each).

Notes:
- The Makefile's `make run` uses `DEVELOPER_ID = "Apple Development"`, which needs a real signing
  identity in the keychain. The ad-hoc `codesign -f -s -` above **avoids that** — AMFI-off means the
  entitlement isn't validated against a cert.
- Despite the repo name, it extracts **both** FMF and FMIP.
- It runs even over SSH (the entitlement + AMFI-off means **no keychain prompt**), as long as the
  console user is logged in (so the login keychain is unlocked).
- Verify the embedded entitlement: `codesign -d --entitlements - extractor` → contains
  `com.apple.findmy`.

### 3. Gather + sanity-check

```bash
mkdir -p ~/Desktop/findmy-keys
cp findmy-key-extractor/keys/LocalStorage.key       ~/Desktop/findmy-keys/
cp FMIPDataManager-extractor/FMFDataManager.bplist  ~/Desktop/findmy-keys/
cp FMIPDataManager-extractor/FMIPDataManager.bplist ~/Desktop/findmy-keys/
```

Expected: `LocalStorage.key` = **32** bytes; both `.bplist` = **171** bytes and start with the magic
`bplist00`.

## Import into Gator

In the Gator app: **Settings → Features → Find My Decryption Keys → Import Keys from Folder** →
pick `~/Desktop/findmy-keys`. The three badges turn green. Then on the phone:
**Find My → pull to refresh** — devices, items, and friends decrypt.

(The card only appears on macOS 14.4+, where the keys are needed.)

## Cleanup — re-enable security

The keys are saved, and Gator decrypts the caches itself (pure-JS, no debugger), so you can restore
security:

```bash
sudo nvram -d boot-args          # remove the AMFI arg
# then reboot into Recovery → run: csrutil enable → reboot
```

The keys keep working afterward. Only re-extract if you wipe/migrate the Mac (keys are Mac-specific).

## References

- findmy-key-extractor — <https://github.com/manonstreet/findmy-key-extractor>
  (relevant issues: #1 working-steps, #2 hangs-on-Intel, #3 bplists-not-captured, #7 auto-start)
- Pnut FMIP/FMF keychain extractor — <https://github.com/Pnut-GGG/FMIPDataManager-extractor>
- Gator's Find My implementation + how the keys are used — [`FINDMY_DECRYPTION_PLAN.md`](FINDMY_DECRYPTION_PLAN.md)
