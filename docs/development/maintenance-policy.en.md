# Version and maintenance policy

> **Language:** English | [简体中文](maintenance-policy.md)

Revised 2026-09-27. This document describes version, dependency, and compatibility maintenance rules for the single-maintainer stage; it does not add a long-term support cycle or fixed release dates. The current scope for accepting security reports follows the root [Security Policy](../../SECURITY.en.md); whether a specific version was publicly released is governed by the corresponding Release and acceptance records.

## Maintenance scope

| Object | Current scope | What it does not promise |
|---|---|---|
| Desktop release artifacts | Windows x64 portable; each release note states the verified environment and capabilities | Does not mean all Windows versions have been tested; no macOS/Linux release support is provided |
| Released versions | Accept issues, assess impact; fixes preferably enter the current development line, and the containing version is stated | No default per-version backports, no LTS commitment |
| Previews and candidate packages | Locate feedback by version, commit, and hash; public preview packages and local-only builds are recorded separately | A preview is not a stability guarantee; a candidate build is not a release |
| `main` and source runs | Accept issues with commit, environment, and reproduction steps; active change status is listed separately | No guarantee of releasability at any moment; do not write partial implementation as a completed item |
| Workspace libraries | APIs, CLIs, and data formats maintained per specifications and corresponding version notes | The desktop package version does not mean all libraries were published to npm at the same version |
| Models and external services | Handle compatibility issues within the declared protocols, tools, and configuration scope | Does not guarantee that any provider, model, third-party Agent, or custom tool will run |

Release notes should state stable or preview, the exact commit, platform, included scope, and limitations. Product versions, library versions, and trace-format versions are distinct identifiers; do not infer data compatibility from a version name.

## Fixes and dependency updates

Prioritize data integrity, security, execution or reading blockers, and compatibility issues; then high-frequency experience issues and new features. The maintainer states the reason for adoption, deferral, or rejection in the related issue/PR; confirming an issue does not promise a completion time. When backporting to an older version, record the necessity, target version, and verification results separately.

Dependency updates are proposed for security fixes, known defects, compatibility requirements, or explicit functional needs; unrelated upgrades are not bundled merely to chase new versions. Ordinary updates keep a small scope; dependencies that need grouped upgrades state the related reason. Update package declarations and lockfiles, and record upstream changes, license changes, and impact on applications and data.

When Node, pnpm, Electron, or build tools are involved, check runtime requirements, CI, and the packaging process at the same time. The minimum version in `engines` is not a complete support matrix; build reports record the versions actually used. There is currently no commitment to periodic automated scanning, automatic upgrades, or a fixed update frequency.

Code and build changes are verified per the [development workflow](workflow.en.md); runtime, resource trimming, or packaging changes also need corresponding real-package checks. After dependencies or bundled content change, re-check affected items per the [third-party notices](third-party-notices.en.md). When checks are incomplete, keep them pending rather than reusing results from an old commit.

## Data compatibility and upgrades

The real boundaries for data reading, forking, and isolated execution are governed by the master specifications such as [trace-format](../../openspec/specs/trace-format/spec.md) (Chinese) and [workspace-isolation](../../openspec/specs/workspace-isolation/spec.md) (Chinese) and by the implementation. Being able to read a record does not mean it can be used for continuation; whether an old package can read a new format must be verified separately.

When changing formats, required fields, path layout, or old-record behavior, first use OpenSpec to state the impact scope, rejection behavior, migration needs, and acceptance conditions. Before a migration tool is implemented and verified, do not promise automatic migration in upgrade notes; do not bypass guards by deleting isolation fields or lowering the format version.

Before upgrading, back up the complete data directory after the app has stopped writing, preserving trace parent chains and file attachments; copying a single trace may not restore an isolated run. First test the target version with a data copy. Rolling back to an old package does not mean the data has rolled back too; use the pre-upgrade backup when necessary, and never rewrite original records directly for a downgrade.

## Slowdown, end, and resumption of maintenance

When maintenance capacity declines, state the date, accepted scope, unfinished issues, and whether security reports will continue to be handled in the README, release notes, or a pinned public record, and synchronize the root security policy; do not use unfulfilled planned dates as a status statement.

When ending maintenance for a version line or the whole project, state the end scope, last usable version, known risks, data-retention method, and available migration or fork entry points where applicable. Ending maintenance does not delete existing licenses or revoke open-source licenses already granted. There is currently no fixed end date or advance-notice period.

When adding a maintainer or resuming maintenance, record the responsible person, permission scope, handoff results, and new support scope, and check them per the [release and handoff guide](release-and-handoff.md) (Chinese); changing documentation alone does not mean the handoff is complete.
