# Development workflow

> **Language:** English | [简体中文](workflow.md)

## Environment and daily commands

Node + pnpm workspace (`packages/*` + `apps/*`):

```bash
pnpm install
pnpm dev            # start the desktop app
pnpm test           # vitest (zero API cost, all mock-injected)
pnpm build          # full build (including desktop electron-vite frontend bundling)

pnpm --filter @rebaseagent/desktop dist   # package the Windows portable exe
```

## Quality gates

CI and local development run the same command chain (Gitee Go `.workflow/ci.yml` and GitHub Actions `.github/workflows/ci.yml`):

```bash
pnpm check:ci   # = check:build → check:typecheck → check:test → check:lint → check:spec
```

The two build commands **are not interchangeable**:

- `pnpm check:build` (the first step of `check:ci`) builds only the `packages/*` library artifacts for tests and cross-package consumption;
- `pnpm build` is the full build and additionally bundles the desktop frontend for local development.

⚠️ Test note: `pnpm check:build` runs before `pnpm check:test` — when dist is missing, some cases silently skip; running multiple package tests in parallel may produce false failures, so judge regressions by rerunning a single package/file.

## Spec-Driven Development (OpenSpec)

Each capability goes through the full lifecycle; see the `openspec/` directory:

```text
proposal → review → apply (implementation + tasks checked off one by one)
→ acceptance (quality gates + on-device evidence) → archive (+ evidence-index)
```

- Archived changes are the **authoritative record** of capability semantics and evidence: `openspec/changes/archive/<date>-<name>/`
- Master specs (`openspec/specs/`) are merged from deltas when a change is archived; judge current state only from `src/` + archived deltas.
- On-device acceptance screenshots go to `docs/reviews/<date>-<batch>/` by batch; raw measurement data goes to the gitignored `.workbuddy/`.

## Documentation conventions

- The documentation map is [`../README.md`](../README.md) (Chinese); cross-directory references use the full `docs/<category>/...` path.
- Session artifacts (logs, reviews, reports) carry a `YYYY-MM-DD-` date prefix; long-lived documents do not.
- Pure documentation changes check facts, version boundaries, relative links, and formatting; do not start the app or real model requests just for wording. If code or build configuration is also changed, still verify with the corresponding quality gates.
- Contribution, review, and issue-handling rules are in [governance and maintenance](governance-and-maintenance.en.md); checks that were not run state the reason, and plans or old-commit results are not recorded as passing this time.

## Maintenance and release

- [Version and maintenance policy](maintenance-policy.en.md): support scope, dependency updates, and data-compatibility requirements.
- [Release and maintenance handoff guide](release-and-handoff.md) (Chinese): formal releases use an independent candidate directory and record the commit, artifact hashes, and each verification; a local build is not a release.
- [Third-party notices and release notes](third-party-notices.en.md): actually distributed components and notice-delivery requirements; package metadata is not a substitute for final release-artifact verification.
