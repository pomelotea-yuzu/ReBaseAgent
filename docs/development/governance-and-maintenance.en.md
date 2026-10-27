# Governance and maintenance arrangements

> **Language:** English | [简体中文](governance-and-maintenance.md)

Revised 2026-09-27. This document defines collaboration rules for the current single-maintainer stage, for both contributors and the maintainer. The existing [contributing guide](../../CONTRIBUTING.en.md), [code of conduct](../../CODE_OF_CONDUCT.en.md), [security policy](../../SECURITY.en.md), and [development workflow](workflow.en.md) cover submissions, community behavior, security reporting, and the development process respectively. Written rules do not mean remote settings or actual handling records have been verified; unimplemented items are listed separately at the end.

| Supporting document | Responsibility |
|---|---|
| [Version and maintenance policy](maintenance-policy.en.md) | Version scope, dependency updates, compatibility, maintenance slowdown, and end of maintenance |
| [Release and maintenance handoff guide](release-and-handoff.md) (Chinese) | Candidate baselines, independent packaging, verification and release records, personnel handoff |
| [Third-party notices and release notes](third-party-notices.en.md) | Actual component mapping, licenses and NOTICE, notice delivery, and verification criteria |

## Current basis

The project currently operates in a single-maintainer-led manner. The repository already has an MIT license, contributing guide, code of conduct, security policy, GitHub/Gitee issue and PR templates, and the Gitee Go [quality gate configuration](../../.workflow/ci.yml). A [GitHub Actions configuration](../../.github/workflows/ci.yml) has also been added locally but has not been verified online. This round checked only that files exist and their content; recent online pipeline execution was not verified.

Current materials are insufficient to prove a stable external maintenance team, continuous community-response statistics, organizational funding, or long-term financial support. Metrics without data remain marked as not established; document volume is not used as a substitute for actual operations.

## Responsibilities and decisions

| Role | Responsibility | Current arrangement |
|---|---|---|
| Maintainer | Determine scope, accept changes, handle releases and security matters | GitHub `pomelotea-yuzu` / Gitee `yuzu-tea-duck` |
| Contributor | Submit issues, documentation, tests, or code with sources and verification details | Participate via issues/PRs; no maintainer status required first |
| Reviewer | Check behavioral contracts, risk, evidence, and third-party sources | Invited per change; no independent standing team yet |

Behavioral-semantics changes continue to follow the OpenSpec process: proposal first, implementation afterward. Ordinary documentation corrections can go directly to a focused PR; new features, changes to side-effect boundaries, data formats, or compatibility commitments must leave design rationale and verification records.

Disagreements should return to reproducible problems, compatibility, and verification cost. The maintainer records the final choice and reasons; when independent review cannot be obtained, self-review and residual risk are recorded explicitly, without claiming multi-person approval. Automation can assist checks, but acceptance and release responsibility remain with the maintainer.

Decisions are recorded in the related issue/PR or OpenSpec change and include at least the problem, adopted approach, main trade-offs, and verification requirements. When privacy or security details are involved, only necessary conclusions are made public, and evidence is kept through the private process. Contributors can submit new facts and alternatives in the original record and request reconsideration; there is currently no committee vote or independent appeal body.

Repository permissions are granted by specific responsibility. Sustained contribution does not automatically grant merge or release permissions; adding a maintainer should publicly state the responsibility scope, handoff content, and effective date, with actual permissions configured separately by the existing maintainer.

## Contribution loop

1. Issue reports state the version, environment, minimal reproduction, and expected/actual behavior. Sensitive material does not go into public issues.
2. The maintainer first determines the type, impact, and reproducibility, then decides whether it enters the change scope. The current state is described as in the table below; remote labels have not been verified, so the body or comments can be used first without relying on label automation.
3. PRs describe the problem solved, behavior changes, verification, and limitations, and link the related issue or change. Third-party code, icons, examples, and data should state their source and license; if the source cannot be established, do not merge first.
4. Code contributions are accepted under the project's MIT license; third-party content retains its original license and notices. This does not relicense third-party work as MIT. No CLA/DCO automation exists yet, and no claim is made that signing is enforced.
5. When an issue is closed, state the fixing commit/version or the specific reason it cannot be handled; duplicate items link to the existing record. The same issue across GitHub/Gitee should cross-reference each other to avoid contradictory conclusions.

### Issue triage and status

Data loss, incorrect modification of existing data, and security issues are evaluated first; then reproducible execution or reading blockers and compatibility issues; then feature suggestions and experience improvements. Priority is determined by impact scope, reproduction conditions, available workarounds, and maintenance capacity, and is not equivalent to a fixed fix date. Sensitive issues move to the private process, and public records do not include exploitation details.

| Status | Meaning and records to leave |
|---|---|
| Needs reproduction / more information | State the missing version, steps, or minimal data; do not assert there is no problem just because it has not been reproduced yet |
| Confirmed | Record the reproduction environment, impact, and criteria; confirmation does not mean a schedule has been promised |
| In progress | Point to the owner and related PR/change; do not mark as in progress when no one has taken it |
| Needs verification | State the fixing commit, verification method, and uncovered items; merging code is not the same as a released fix |
| Closed | State the reason: fixed, duplicate, not adopted, or insufficient information; for fixes, note the commit and the released version or "pending release" |

Deferred items state the reason and re-evaluation conditions. Records with insufficient information may be closed after a request for more details if they still cannot be judged, but should state that they can be reopened with a new reproduction; do not set automatic timeout rules that are not actually configured. Cross-platform duplicates designate a primary record and cross-reference each other with consistent conclusions.

### Review and response

When a PR is ready, it states scope, behavior changes, third-party sources, verification, and limitations. Code and build-configuration changes complete gates per the development workflow; pure documentation revisions check facts, links, and formatting. Checks that cannot be run are explicitly recorded as not run, and the maintainer either re-verifies or leaves them pending; old results are not used to check items as passed.

Review comments distinguish must-fix problems from optional suggestions. After code updates, re-check affected behavior and results; final acceptance, deferral, or rejection is explained in the original record. Non-author review can be invited as needed; there is still no standing independent team, and no claim is made that branch protection, required approvals, or auto-merge are enabled.

Ordinary issues/PRs do not promise a fixed response time; the first-response target for security reports applies only to the root security policy. Each handling should leave status, next steps, and blockers where possible; automatic replies or AI review must not impersonate the maintainer having accepted the issue. When maintenance capacity is insufficient for a long period, state the maintenance slowdown and accepted scope in the repository rather than continuing to promise the original schedule.

### Minimal handling record

Keep the following information directly in the issue/PR; a second ticketing system is unnecessary. First human-response and close times may cite platform timestamps; when no actual event exists, record "not tracked" rather than filling in example numbers.

| Field | Recorded content |
|---|---|
| Primary record and related items | Platform links, cross-platform duplicates, PR or change |
| Impact and status | Version/commit, type, reproduction status, current status and owner (write "unassigned" when no one has taken it) |
| Handling and verification | Reasons for adoption or rejection, fixing commit, check results, uncovered scope |
| Closure and release | Close reason, version containing the fix or pending-release status, re-evaluation conditions |

Private reports, identity information, and undisclosed vulnerabilities do not enter public statistics details; public summaries keep only necessary conclusions that do not reveal personal information.

## Release and compatibility

Code or build-configuration changes run `pnpm check:ci` per the contributing guide. Release records should also include target platform, source commit, lockfile, artifact hash, change notes, known limitations, and actual test results. When an environment prevents a check from running, state the alternative checks and uncovered parts. Gate passing, build completion, real-package acceptance, and public release are recorded separately; one does not replace another.

The current packaging target is Windows x64. Adding a platform, breaking a data format, or changing how old traces are read requires a separately stated compatibility strategy and migration verification. Daily maintenance scope is in the [version and maintenance policy](maintenance-policy.en.md); the scope for accepting security reports follows the root security policy; neither adds a long-term supported-version commitment.

Third-party license checks should cover the actual release contents, including dependencies bundled into the frontend bundle and notices shipped with Electron/Chromium. The source code being MIT does not mean all dependencies are MIT. See the [dependency audit report](audits/2026-09-27-dependency-licenses.md) (Chinese).

When adding or updating dependencies, record purpose, locked version, upstream source, license, and required notices; third-party code and assets retain applicable copyright and NOTICE and are not relicensed as MIT merely by entering the repository. For dual licenses, record the chosen path; when the source or distribution conditions cannot be determined, resolve that before accepting a contribution or releasing. Metadata scanning is only an input to verification, not a conclusion that all dependencies are compliant.

Releases are confirmed by the maintainer; the same version's commits, assets, and hashes on GitHub/Gitee should correspond. When one side is not yet synchronized, state that explicitly. When a release defect is found, record affected versions, available workarounds, and the follow-up fix version; avoid silently replacing same-named assets and changing hashes. When data formats are involved, state the compatibility scope and backup requirements first; do not assume an old package can read a new format.

## Continuous maintenance plan

The following is a suggested order and completion conditions, not committed dates. The current maintainer coordinates by default; once a task is confirmed, the owner and scope are recorded in the corresponding issue/change.

| Stage | Work | Completion condition |
|---|---|---|
| Current documentation stage | Clarify responsibilities, issue status, contribution licensing, review requirements, and the security-reporting process | Entry points are navigable; rules and actual operating state are separated |
| Next release preparation | Verify private reporting channels; check release third-party notices; record build and run results | A verifiable channel exists, artifact checks are recorded, and issues are handled before release |
| Subsequent stable iteration | Prioritize data integrity, error diagnosis, compatibility, and high-frequency usage blockers | Each item traces to an issue, implementation, and verification; dependency updates have regression evidence |
| When sustained contributors appear | Introduce a second maintainer for clearly defined modules and gradually hand over review and release capability | Continuous contribution records, handoff notes, and actually completed independent maintenance tasks |

A single maintainer is the current continuity risk. Mitigations include reproducible builds, clear data formats and error semantics, runnable tests, release steps, and least-privilege handoff; these only reduce handoff cost and cannot replace actual people and time.

Each release is encouraged to record unresolved defects, first-response and close durations for issues, and external contributions and maintainer effort. When no record exists, mark "not tracked"; do not fabricate historical numbers. When maintenance capacity remains insufficient for a long period, publicly narrow the maintenance scope or mark a slowdown and update the support policy, rather than continuing to promise a roadmap that cannot be executed.

Maintenance handoff should at least describe active issues, supported versions, build and release steps, data-compatibility limits, and permission scope on each platform; keys are not written into handoff documents or the repository. A completed handoff should have an actual recipient and responsibility record; there is currently no second maintainer, and automation is not treated as personnel replacement.

## Items not yet implemented

The following describes governance status; they are not external operational tasks for this round. This round changes documentation only: no remote permissions or labels are configured, no reports are sent, no experiments are run, and no packaging or development code is modified.

- Verify security-reporting entry points and correct wording; close the loop after the maintainer actually receives a test report.
- Complete third-party notices for the final release artifacts and record a conclusion for each package awaiting verification.
- Collect real issues and usage feedback, and establish the first traceable response records.
- Verify remote labels, branch protection, and review settings; do not claim enforcement before configuration exists.
- Determine maintainer expansion and handoff arrangements after a sustained contribution base exists.
