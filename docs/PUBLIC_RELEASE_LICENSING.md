# Public and broader-distribution licensing gate

## Document role

This checklist records work required before Gator leaves its current owner-controlled private scope.
It is not itself a software license, legal approval, or a complete third-party notice inventory.

## Current decision

- Gator-authored source code and assets remain private and have no public or open-source license grant.
- The owner-approved private scope is binary distribution through Google Play Internal Testing only
  to owner-approved private testers.
- The root [`LICENSE`](../LICENSE) records that boundary.
- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) preserves the confirmed inherited Expo
  template notice without presenting Expo's copyright as Gator's ownership.
- Third-party components still retain their own license terms.

That private scope does not include source publication, public invitation links, recipient
redistribution, Closed/Open/Production Play tracks, or other distribution channels. Do not cross any
of those boundaries until every applicable item below is complete. Adding a recipient who has not
been specifically approved by the owner also triggers this gate.

This scope is a project-distribution decision, not an exemption from third-party terms. Obligations
that apply to private Internal Testing still apply, and the current files do not claim that a complete
dependency or asset review has been performed.

## Required review before broader distribution

1. Identify and approve the exact legal owner/copyright holder and applicable years for all
   Gator-authored code and assets.
2. Choose and record either a public project license or explicit proprietary distribution terms for
   the intended audience and distribution method.
3. Inventory the exact release's provenance, including:
   - Gator-authored code and assets;
   - inherited Expo template material;
   - React Native, React, direct and transitive npm dependencies;
   - Android, Gradle, and other bundled native dependencies;
   - fonts, icons, images, sounds, media, and generated assets; and
   - copied or adapted upstream/server material.
4. Review each inventoried item's license, copyright, attribution, source-offer, redistribution,
   modification, trademark, and notice obligations for the intended distribution.
5. Generate and manually review the notice bundle from the exact lockfile, native build, and shipped
   assets. Reconcile it with [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
6. If embedded maps or related assets return, review and restore the applicable Leaflet and
   OpenStreetMap licenses/attribution before enabling or distributing them. They are not currently
   packaged as a supported embedded-map feature.
7. Point the repository README, in-app About/support UI, and store metadata to the same approved
   project terms and notice bundle.
8. Obtain explicit owner and qualified legal approval for the intended distribution before publishing
   source, uploading a broader-track candidate, or inviting recipients outside the approved private
   scope.

## Current evidence and open work

- The Expo template MIT text inherited by this repository is preserved verbatim in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- The installed Expo, React Native, and React packages use the MIT License. Their notices, plus every
  other shipped dependency and asset obligation, must be reconciled from the exact release rather
  than inferred from this short known-items list.
- [`legal/generated/THIRD_PARTY_NOTICES.generated.md`](../legal/generated/THIRD_PARTY_NOTICES.generated.md)
  is a deterministic, conservative inventory of the current production lockfile, recursively found
  package legal files, tracked app and store artwork, local native modules, and build plugins. Its
  strict release mode fails while provenance or exact-artifact coverage is unresolved. It does not
  replace the required exact-AAB and legal review.
- [`legal/generated/aab-inventory-android-0.1.43-v59.json`](../legal/generated/aab-inventory-android-0.1.43-v59.json)
  is a local-receipt-matched, CRC-verified inventory of the retained historical version-code-59 AAB. It
  hashes all 1,752 archive files and records 330 reachable Gradle dependency coordinates, 21 fonts,
  three models, 33 native libraries, one JavaScript bundle, six DEX files, and eight embedded legal
  files. The inspector refuses unsafe or duplicate ZIP paths, malformed dependency graphs, and an
  artifact that does not match its validation and promotion receipts.
- That v59 inventory is historical evidence, not current-release approval. The AAB predates the
  present remediation tree; 47 Gradle records omit an artifact digest, 31 omit a repository index,
  and the AAB cannot reveal the exact npm modules retained by Hermes. The packaged fonts, models,
  native libraries, and legal texts also remain unmapped to approved provenance. A new frozen
  candidate must preserve its exact Metro and Gradle build graphs and pass the same receipt-bound
  audit before final notice reconciliation.
- Eleven v59 files contain an absolute user-directory marker. The inventory records only affected
  archive paths, not the private strings. Nine are blocked app/config or locally compiled native
  outputs; two are separately reviewed upstream OpenSSL outputs. Historical v59 therefore remains
  non-releasable and supplies no replacement-candidate credit.
- The release runner now copies Firebase configuration into its disposable worktree with owner-only
  permissions and gives Expo the fixed relative path `./.gator-release/google-services.json`. Native
  compilation runs in an owner-only, run-scoped `/private/tmp/gator-android-release-<uid>/<run-id>`
  container with separate EAS work and Gradle directories. Exact compiler file/debug prefix maps
  replace those roots with `/gator/source` and `/gator/gradle`; inherited C/C++ flags, Gradle home,
  and retained EAS workspaces are not trusted. CI applies the same logical maps.
- A bounded native-path proof discovers every Release/RelWithDebInfo `compile_commands.json` under
  the generated Android tree, local modules, and installed native packages, then checks every command
  for exactly one correct source and Gradle file/debug map. Missing, duplicate, conflicting, stale,
  future-dated, symlinked, malformed, oversized, or wrong-tree evidence fails closed. This proof must
  pass immediately after the replacement build; implementation tests alone do not prove a compiler
  honored the flags.
- The only technical exceptions are exact path-and-SHA-256 pairs for OpenSSL from the pinned
  `io.github.ronickg:openssl:3.3.2-1` dependency:
  `base/lib/arm64-v8a/libcrypto.so` /
  `da06ab9b38e9e28d2f9ab0040d398ec076d981f3a309325971a978e6135b80b1`, and
  `BUNDLE-METADATA/com.android.tools.build.debugsymbols/arm64-v8a/libcrypto.so.sym` /
  `168e5685408ac41ccc9338a7e202b03de1bf2575f8100678d54626a7bdc45a6b`. A renamed file, one-byte
  digest change, added marker-bearing file, `/Users` or `/home` wildcard, or different dependency
  coordinate is not approved. This narrow technical disposition is not license/provenance approval.
- The Android artifact validator still reads one bounded AAB snapshot and refuses unreviewed raw
  single-byte `/Users/<segment>/` and `/home/<segment>/` markers without printing their contents.
  Backslashes are normalized first, so the same raw markers in Windows, file-URL, UNC, and ordinary
  JSON slash/backslash forms are covered. Percent encoding, JSON `\uXXXX` escapes, UTF-16 text, and
  nested compressed payloads are not decoded by this guard. The ignored local receipts establish
  consistency among local files; they are not independently authenticated provenance or a substitute
  for signature/legal review.
- Settings links a local Legal & Third-Party Notices screen generated from the repository's root
  project notice and confirmed third-party notice, so it does not need a network connection or
  advertise Expo's inherited license as Gator's project license.
- The embedded Find My map is disabled and Leaflet is not currently packaged; map-related obligations
  must be reassessed if that feature returns.

Stop the release review if ownership is unresolved, an artifact lacks provenance, a required notice or
source obligation cannot be met, the proposed distribution exceeds the approved terms, or owner/legal
approval is missing.
