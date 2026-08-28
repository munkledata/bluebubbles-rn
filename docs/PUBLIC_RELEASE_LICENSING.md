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
- The embedded Find My map is disabled and Leaflet is not currently packaged; map-related obligations
  must be reassessed if that feature returns.

Stop the release review if ownership is unresolved, an artifact lacks provenance, a required notice or
source obligation cannot be met, the proposed distribution exceeds the approved terms, or owner/legal
approval is missing.
