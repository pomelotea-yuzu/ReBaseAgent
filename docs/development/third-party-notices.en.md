# Third-party notices and release notes

> **Language:** English | [简体中文](third-party-notices.md)

Revised 2026-09-27. This document defines requirements for third-party content verification and notice delivery. It is **not the third-party license compilation for a final release package, nor a compliance acceptance conclusion**. This round did not rescan dependencies, unpack the exe, or change packaging configuration; existing inputs are in the [dependency audit record](audits/2026-09-27-dependency-licenses.md) (Chinese).

## Verification scope

Original project contributions are distributed under the root [MIT License](../../LICENSE). Third-party content retains copyright, license text, NOTICE, attribution, and other applicable obligations under its own license; the project's MIT notice cannot replace them uniformly.

| Content | Verification basis |
|---|---|
| Runtime and transitive dependencies | Locked name/version, upstream code and notices, location in the actual release artifact |
| Code in the frontend bundle | Build inputs and actual output; excluding the original node_modules directory does not remove obligations for bundled code |
| Runtimes such as Electron/Chromium | Actual bundled version, runtime license and its third-party notices; not excluded merely because it is in devDependencies |
| Development or build dependencies | Whether code, assets, or runtimes are copied into the release artifact; if not distributed, state the basis for that judgment |
| Icons, fonts, images, documentation, examples, and data | Source, license, modifications, attribution or redistribution requirements; content in the repository and external materials must both be considered |

A package's `license` field is a lookup clue, not a substitute for the full text. Missing a top-level LICENSE, not being in the production dependency graph, or upstream marking a dual license all require judgment based on actual content; none can be recorded as passed directly.

## Component records

For each candidate release, build a mapping of "actually bundled component → version → source and license → notice delivery location", linked to the source commit, lockfile, and release artifact SHA-256. Suggested fields are below; this is only a record format, and no verified component results are fabricated.

| Field | Content |
|---|---|
| Component and version | Package, runtime, or asset name; exact version/commit |
| Source and modifications | Upstream URL, local input location, whether modified and modification notes |
| Distribution scope | Bundle, asar, standalone file, or not distributed; include the judgment basis |
| License and obligations | Applicable license or chosen path, copyright/attribution, NOTICE, source-offer, and other specific requirements |
| Notice files | Source, hash, and delivery location of the actual full license text and related notices |
| Conclusion | Verified / pending verification / not distributed and basis; owner and date |

For dual licenses, determine from the original text whether one may be chosen or both must be satisfied; record the chosen path and handling. Handle notice changes, source-offer, or other conditions item by item; when in doubt, keep the item pending rather than inferring from the license name that all obligations are met.

## Existing key components

The table below comes from the 2026-09-27 audit report and is only a starting point for later checks. Actual versions follow the candidate package; do not treat the old list as the new release artifact list.

| Component | What must continue to be checked |
|---|---|
| Monaco | Its own LICENSE and ThirdPartyNotices.txt; actually bundled components |
| ECharts / zrender | Applicable license, copyright, and the ECharts NOTICE |
| Lucide / Feather-derived icons | Full license text; do not summarize based only on the metadata's ISC label |
| Electron / Chromium | Runtime LICENSE, LICENSES.chromium.html, and the actual runtime version |
| DOMPurify | The chosen path for its dual license and corresponding obligations |
| React and other bundled components | Retain required copyright and licenses per actual content, including transitive dependencies |
| Contributor Covenant adapted text | Source, CC BY 4.0 attribution, and adaptation notes in the [code of conduct](../../CODE_OF_CONDUCT.en.md) |

JSON produced by the read-only generator can serve as a metadata baseline, but it is not a user-readable compilation of full license texts. Missing packages and missing top-level notices in the machine inventory still need item-by-item explanation against the release contents.

## How notices are delivered

The actual release should provide a notice index users can obtain, together with applicable full license texts, copyright, and NOTICE. Package documentation or notice files shipped with release assets may be used; the specific method must satisfy each license and distribution form. Providing only a link to an upstream web page does not automatically satisfy the obligation.

The following document organization may be used; **this is a suggested layout and is not currently generated or connected to the packaging process**:

```text
THIRD_PARTY_NOTICES.md       Index of components, versions, licenses, and notice locations
third-party-licenses/       Full license texts, copyright, and NOTICE retained per component
```

Do not overwrite Electron's bundled `LICENSE` or `LICENSES.chromium.html`. If notices are placed in a separate download asset, it must be clearly linked to the executable's version, hash, and download entry, and each item must confirm that this delivery method satisfies the license; do not assume a standalone archive can always replace notices that should accompany the software.

Changing packaging inclusion rules, generating notice files, or adding a viewing entry is later implementation and is not completed by this document. Actual file locations should be noted in the [release record](release-and-handoff.md) (Chinese), not merely as "provided with the package".

## Completion criteria

1. Pin the candidate package and hash, and verify actual contents against the component mapping; items without a basis remain pending verification.
2. Confirm that required notices are fully retained and the original text has not been deleted or altered by summarization or translation; handle modification notes and other applicable obligations separately.
3. Verify from the final release assets that users can obtain the required notices, recording the specific path, file, and result; a directory existing before packaging is not sufficient to prove it exists in the package.
4. When dependency versions, actually bundled content, licenses, or notice files change, re-check the corresponding items; historical reports remain as they were.

The current status remains "dependency metadata has been audited; notices for the final release artifact still need verification". Adding this document does not automatically change that status to complete.
