# Contributing to ReBaseAgent

> **Language:** English | [简体中文](CONTRIBUTING.md)

Thank you for contributing to ReBaseAgent! These are short collaboration guidelines. For usage questions, start with
[README.en.md](README.en.md) and [Getting started](docs/guide/getting-started.en.md).

## Ways to contribute

Documentation corrections, minimal reproductions, test improvements, and code fixes are all welcome. Small documentation fixes can go directly to a PR; for feature suggestions, describe the real scenario, current workaround, and expected result first, then discuss scope.

For public feedback, use [GitHub Issues](https://github.com/pomelotea-yuzu/ReBaseAgent/issues) or
[Gitee Issues](https://gitee.com/yuzu-tea-duck/re-base-agent/issues). If the same issue already exists, add to the original record first; cross-platform reports should link to each other and choose one primary discussion location. Both platforms use the same contribution rules, and duplicate PRs are not required.

## Development environment

- Node.js **>= 20** (pnpm for package management; the version is locked by the `packageManager` field)
- Windows x64 (the only current packaging target; feedback for other platforms is welcome, but no packages exist yet)

```bash
pnpm install --frozen-lockfile
pnpm check:build    # build library packages first so CLI tests do not skip for missing dist
pnpm dev            # start the desktop app
pnpm test           # vitest (all mock-injected, zero API cost)
pnpm check:ci       # quality gate: build → typecheck → test → lint → spec
```

Development conventions, the OpenSpec workflow, and test notes are in
[docs/development/workflow.md](docs/development/workflow.md) (Chinese).

Maintenance responsibilities, issue triage, review decisions, contribution licensing, and release requirements are in
[governance and maintenance](docs/development/governance-and-maintenance.md) (Chinese). A single maintainer is responsible; ordinary issues/PRs have no fixed response time.

## Submitting changes

1. Create a branch from `main`; keep one PR focused on one thing. Before starting, check related issues/PRs and active changes to avoid duplicating work in progress.
2. For changes that affect capability semantics, submit an [OpenSpec](https://github.com/Fission-AI/OpenSpec) proposal first (`openspec/changes/`) describing compatibility and acceptance conditions. Documentation corrections do not need a new change.
3. Describe the problem, changes, related issue/change, verification results, and remaining limitations. Unfinished work can be opened as a draft PR; draft does not mean mergeable.
4. Run `pnpm check:ci` before requesting merge of code or build configuration; changes involving UI, packaging, or real execution also need corresponding verification. UI changes cover actual clicks, keyboard, and affected layouts; OpenSpec scenarios link each item to tests or on-device evidence; source-structure assertions do not replace interaction acceptance. Pure documentation changes only need fact, relative-link, and formatting checks — do not start the desktop app or real model requests for wording changes.
5. If checks were not run due to environment limits, state the command, blocker, and uncovered scope; do not check them as passed. The maintainer will re-verify or keep them pending. Update affected check results after changes; a green light on an old commit does not replace verification of a new one.
6. User-visible behavior changes must be synced to README, user documentation, and limitations; public capability descriptions must distinguish `main`, candidate packages, and released versions. Commit titles describe the specific feature or engineering change, for example `docs: sync workspace progress and usage boundaries`; background, purpose, and verification details go in the body.

## Review and feedback

The maintainer checks scope, reproduction, compatibility, tests, documentation, and third-party sources, then decides whether to merge. There is no mandatory independent second reviewer; single-maintainer self-review should be recorded truthfully. CI passing does not mean a contribution is accepted, nor does it prove a real package or real model behavior is correct.

Review comments should identify blocking issues or optional suggestions and give reasons. Contributors can request re-review in the original PR after revisions; discussion and verification records are kept in the same PR. When not adopted or closed, explain why and link duplicate issues to the original record. Re-evaluation can be requested after adding new reproduction or revision details.

Ordinary issues/PRs have no fixed response time. While waiting, add information or ask for progress in the original record; do not open duplicate tickets across platforms. Merge timing and release version follow the maintainer's actual records.

## Licensing and content sources

Submitting a contribution means you have the right to provide the content and agree that original contributions are distributed under the project's [MIT License](LICENSE), without requiring copyright assignment. Third-party content retains its applicable license and is not relicensed as MIT merely because it enters this repository.

When introducing code, dependencies, icons, fonts, documentation snippets, examples, or data, list the source link, version or commit, license, modifications, and copyright/NOTICE files that must be retained. For contributions assisted by generation tools, the submitter remains responsible for checking correctness and sources; tool output does not replace source or license explanations. No CLA or DCO signature is currently required, and no automated check is configured.

Dependency declarations and lockfiles should be updated together, with purpose and necessity explained; do not bundle bulk upgrades into unrelated fixes. Update and compatibility rules are in the [version and maintenance policy](docs/development/maintenance-policy.md) (Chinese); release licensing requirements are in [third-party notices and release notes](docs/development/third-party-notices.md) (Chinese).

## Reporting issues

Use the [GitHub issue templates](.github/ISSUE_TEMPLATE/bug_report.yml) or the [Gitee issue template](.gitee/ISSUE_TEMPLATE.zh-CN.md), and include the run mode, release filename/version or exact source commit, operating system, minimal reproduction steps, and expected vs. actual results; self-built packages can include the artifact SHA-256. A `package.json` version number alone cannot establish which build or released version was used. If the issue is not reliably reproducible, describe the conditions rather than providing an unrelated full project.

Attach only necessary, redacted logs or examples. Traces, model messages, file attachments, and screenshots may contain keys, business data, or personal information; do not upload an entire `data/` directory. If the issue involves a security impact such as a leak or path escape, use the private process below instead.

## Security issues

**Do not report security vulnerabilities in a public issue** (especially those involving API key handling).
Report privately through the channels in [SECURITY.en.md](SECURITY.en.md).

## Code of conduct

Participating in the community means agreeing to [CODE_OF_CONDUCT.en.md](CODE_OF_CONDUCT.en.md).
