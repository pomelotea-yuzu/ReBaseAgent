# Project verification guide (current R3 implementation)

> **Language:** English | [简体中文](isolated-project-verification.md)

> In a **restricted container**, run fixed type checking / trusted tests against the historical source of an isolated checkpoint, and save
> auditable records and logs. Two verifications can be compared side by side for conditions and outcomes, and the tested input can be exported
> under the R2.1 contract.
>
> This guide covers the current implementation of `add-isolated-project-verification` (**shipped in the release zip since `v0.7.0-rc.2`;
> uploaded to GitHub / Gitee Releases, maintainer-confirmed 2026-10-28**).
> Evidence boundary: real Docker dual verification and export have been measured (2026-10-25); **Electron on-device visual/keyboard/narrow-window
> checks have not been completed**, and this guide cannot replace on-device acceptance.

## 1. Boundaries: what it cannot do

- **Only Windows x64 + Docker Desktop (Linux containers)** are supported. Remote Docker (TCP/SSH), engines inside WSL,
  Podman, or host shells are not accepted; when the backend is missing/unreachable, verification is unavailable and **never falls back to host commands**.
- **Only the `node-ts-v1` template** is supported: tested source may contain only `src/**/*.ts`; `package.json`/`tsconfig.json` are provided by the trusted environment,
  and the project's own `npm scripts`/dependency directory/lifecycle scripts are not read. Commands are the two enumerations `typecheck` and `test`;
  custom commands, arguments, paths, environment variables, images, or limits are not accepted.
- Tests come from `/opt/r3/tests` inside the image (currently frozen to two assertions: `add(2,3)=5`, `mul(2,3)=6`),
  not the project's own tests; changing templates is a new profile/change and is not silently opened here.
- **Verification never automatically initiates a model repair**. A fix must come from a recorded run branch (R2.1 result editing / R2.2 experiments);
  manually edited files without a record are not described as an Agent fix.
- Data stays local: verification reads only historical trace/blob and container output; source/logs/credentials are not uploaded; formal tests are offline.

## 2. Prerequisites

1. Windows 10/11 x64.
2. Docker Desktop (Linux containers) installed and running. The app **does not install** an engine; it uses only the user-level installation's
   `docker.exe` and the `desktop-linux` named pipe, and does not guess `DOCKER_HOST` or the current shell's PATH.
3. First use requires access to the following sources (network only during preparation):
   - base image `docker.m.daocloud.io/library/node:22-alpine@sha256:fe4f6d74…`;
   - `typescript@5.9.3` from the official npm registry (fixed-lockfile integrity verification).
   The formal test phase runs with network `none`.
4. Disk/memory: preparing the image uses about 0.5 GiB locally; per-verification container limits are 1 CPU, 512 MiB memory,
   64 PIDs, `/work` 160 MiB tmpfs, `/tmp` 32 MiB, 120 s per command, 180 s per verification.

Current on-device readings (2026-10-25): Docker Desktop **29.9.2**, API 1.56; the engine version is diagnostic only
and does not become a verification condition; conditions are defined by `profileId + manifestVersion + plan binding digest + actual environment identity`.

## 3. Prepare the environment (authorized separately from execution)

Entry: Files page → **Project verification** → expand (automatically performs two **read-only** checks: capability + preparation plan).

1. The preview shows: source run/checkpoint/snapshot/file count and bytes, profile and toolchain, download sources and size, network scope,
   limits, and isolation baseline. The preview **does not download, create containers, execute, or write records**.
2. The user explicitly confirms in the **Verify environment preparation** block, then clicks **Start environment preparation**. Preparation may use the network
   to download/build from fixed sources, forbids lifecycle scripts, and does not run npm on the host; the preparation record is sealed separately (failure is not a test failure).
3. After successful preparation, the capability shows a prepared environment; then the **Verify fixed-check execution** block appears. The two confirmations do not replace each other:
   having an environment ≠ being allowed to execute this test; changing the plan/command/target invalidates the old confirmation and requires re-verification.

## 4. Run a verification

- The checkpoint is explicitly bound at the entry: the initial checkpoint, or the run's **own completed steps**; switching checkpoints collapses the panel and resets the whole group,
  and never silently switches to the "latest step".
- Choose one command: `typecheck` (compile only) or `test` (compile first, then run trusted tests; requires TAP's
  `# tests` to **exactly equal** the expected count; zero tests / over-count / garbage output all fail).
- One confirmation executes once, with no automatic retry; resubmitting the same operationId only links to the original operation.
- Outcome layers:
  - **Request completion**: running/settled/requestOutcome in the registry;
  - **Test outcome**: `passed` / `check_failed` / `environment_failed` / `start_failed` /
    `process_failed` / `timed_out` / `output_limit` / `cancelled` / `artifact_invalid` /
    `evidence_incomplete` / `unknown`;
  - **Evidence completeness**: `evidenceComplete=false` cannot be displayed as a complete pass (for example, output truncated or collected items missing).
  - Exit code 0 does not equal pass: a trusted test report with an exact count match is also required; Agent text does not participate in the judgment.

## 5. Stop and unknown

- While execution is in flight, the panel offers **Request stop**; the request only means **stopping**. `cancelled` is recorded only after all workloads/descendants
  inside the container are confirmed stopped and `/work` no longer changes. A successful stop is not displayed as "finished".
- The preparation phase (image build) **has no targeted stop channel**; the panel truthfully states that it cannot be interrupted.
- Daemon disconnect, lost stop response, or unconfirmed residual cleanup ⇒ `unknown` and remain blocked; only verification and another targeted stop are allowed;
  unknown resources are not deleted and cleanup success is not faked.
- Repeated stops are idempotent; a late stop does not affect the next task.

## 6. Records, logs, and corruption

- Each verification has an independent JSONL record (`verifications/<verificationId>.jsonl`), append-only, sealed on termination;
  the run's trace and older records are not rewritten.
- The record header includes: source run/checkpoint/snapshot, profile/manifest version, command, plan binding digest,
  **actual environment identity** (preparationId, actual image digest, platform, toolchain, limits, isolation baseline).
- Logs are read in bounded streams: default 32 KiB/page, maximum 64 KiB/page, showing `totalBytes`, `nextOffset`, `remaining`,
  `truncated`; **a bounded slice is not the complete log**. Bytes beyond the retention budget are counted as total observed bytes but not written to disk.
- Record/log states are shown truthfully: unsealed records do not show an outcome; bad tails show line numbers/reasons; unknown versions are rejected; missing/corrupt attachments get stable codes,
  are not automatically rewritten, and are not filled from test copies/the source directory.
- If the source run is later deleted, the record is marked "source missing"; the record and its own attachments remain readable with hash verification; a same-named source is never guessed.

## 7. Compare two verifications

- A/B must be **explicitly selected** by the user from verification identities in this session's registered attachments (across runs allowed); identities are never guessed from time, logs, or record lists.
- Side-by-side display: source run/checkpoint/snapshot, recorded fork intervention, command/argv/cwd, profile/manifest/plan binding digest,
  actual image/runtime/limits/isolation baseline, outcome/evidence completeness/exit code/duration, log retention and total observed bytes.
- Only when **all recorded conditions are identical, both sides' evidence is complete, the left side is `check_failed`, and the right side is `passed`**
  is "same conditions: failed → passed" shown; the wording states only the actual result of that fixed check, not complete correctness or causality.
- Different conditions ⇒ list the differences; missing fields ⇒ mark unknown; neither **is** combined into same-condition failed → passed.
- Agent text does not enter conditions or conclusions; "View code differences in run comparison" opens the existing run comparison (explicitly two runs; the global comparison set is not changed).

## 8. Export the tested input (R2.1)

- In the verification-record reading area, click **Choose an empty directory and export the exact input**: the request carries only the trusted `verificationId`; main resolves
  the run/checkpoint/snapshot from the record and re-verifies once before and after the native dialog; the package layer compares the snapshot ID **before writing** again, and blocks on mismatch.
- The target must be chosen through the system directory dialog and must be empty; the export layout is `files/<logical path>` plus
  `rebaseagent-export.json` at the root (and `changes.patch` when necessary).
- Recheck: the success message shows "verification snapshot = exported snapshot (bound before writing)"; open
  `rebaseagent-export.json` at the target root and verify `source.run_id`, `source.snapshot_id`, and `files[].sha256`
  against the verification record and the tested source.
- **The export is the tested input code snapshot**: it does not include logs, material packages, or test artifacts, does not apply patches, and does not mean the test passed.
- Missing record source, removed record, missing source trace, and snapshot drift each block with a stable code (see §10);
  switching checkpoints/comparison sides or leaving the page does not change the already-initiated binding; feedback is kept by verification identity (lost after reload = result unknown;
  use the target manifest; do not automatically resend).

## 9. Known limitations

- **Template scope**: only the fixed `node-ts-v1` template (Node 22.23.4 / npm 10.9.9 / TypeScript 5.9.3;
  two trusted assertions). Real projects and custom dependencies/tests/commands/configuration are unsupported and require a separate profile/change.
- **Image source**: the base image is pulled by digest through the DaoCloud mirror; consistency with the official Docker Hub source has not been verified
  (backend-verification.md §1.2 open item). The environment image is built during preparation; identity is verified by the actual digest and the in-image
  hash recheck.
- **Platform**: Windows x64 only; Linux/macOS hosts, remote engines, or engines inside WSL are unsupported. The container platform is fixed to
  `linux/amd64`.
- **Comparison candidates** come only from the current main session's operation registry; old registrations are not restored after a reload, so a historical identity cannot be guessed for comparison.
- **Visual/keyboard**: current conclusions come from component static tests and the real backend; on-device evidence for wide windows / about 800 CSS px / 200% / real keyboard and the native directory
  dialog has not been completed (6.3); do not treat this guide as visual acceptance.
- **Real model**: 6.1's dual verification used a deterministic isolated run (hand-written trace) as a known failure and a recorded fix branch,
  not real LLM output; real-model tasks require separate authorization and must not cherry-pick successful samples to impersonate the first round.

## 10. Troubleshooting (stable codes)

| Symptom/code | Meaning and handling |
|---|---|
| `R3_NOT_CONFIGURED` / `BACKEND_MISSING` | No trusted Docker CLI found or pipe unreachable; start Docker Desktop and confirm Linux containers |
| `R3_PREPARE_MISSING` | The environment has not been prepared or the preparation record is unavailable; complete preparation first |
| `R3_PREPARE_PLAN_STALE` / `R3_RUN_PLAN_STALE` | The plan/policy/recipe has changed; re-verify and confirm the current plan |
| `R3_RUN_SOURCE_*` / `R3_RUN_*` | Source preflight/inside-gate rejection; fix the source or reselect the checkpoint according to the reason |
| `output_limit` / `evidence_incomplete` | Output limit exceeded or evidence item missing; not a pass — inspect log gaps and limits |
| `R3_LOG_ASSET_MISSING` / `R3_LOG_ASSET_CORRUPT` | Log attachment missing/corrupt; not rewritten; re-read or handle as a missing item |
| `VERIFICATION_EXPORT_SOURCE_INVALID` | Verification record missing/corrupt/unsealed; first confirm the record state in the reading area |
| `VERIFICATION_EXPORT_SOURCE_MISSING` | The source run's trace is missing; export is blocked and a same-named source is not guessed |
| `VERIFICATION_EXPORT_SNAPSHOT_DRIFT` | The located snapshot does not match the verification record's binding; no other checkpoint is exported |
| `attachment_unavailable` / `target_invalid` | Export attachment missing/corrupt or target non-empty/invalid; choose an empty directory, fix the source, and retry |
| `R3_STOP_*` | Invalid stop target / stale epoch / not registered; verify the registry first and do not send stops to arbitrary resources |

Docker Desktop's own license, updates, and resource settings are governed by its own terms and are unrelated to the app's license.

## 11. Third-party components and licenses (current trusted image)

The environment image built during preparation is based on `node:22-alpine` (digest above); **top-level** components inside the image:

| Component | Version | License | Notes |
|---|---|---|---|
| Node.js | 22.23.4 | MIT | Included in the official Alpine image |
| npm | 10.9.9 | Artistic-2.0 | Same as above |
| TypeScript | 5.9.3 | Apache-2.0 | Installed from a committed fixed lockfile (`integrity` verified) |
| Alpine base packages (19) | — | See upstream | `alpine-baselayout`, `apk-tools`, `busybox`, `ca-certificates-bundle`, `libcrypto3`, `libssl3`, `musl`, `zlib`, etc.; per-package licenses follow Alpine upstream and are not summarized item by item |
| Trusted runner/tests/supervisor | Committed in this repo | MIT | `runner.mjs`, `tests/smoke.test.mjs`, `supervisor.sh`, `stop-workloads.sh` are hash-frozen and rechecked during preparation |

Not done: a **per-package** license summary for Alpine base packages, and a byte-for-byte consistency check of the base image against the official Docker Hub source.
These are pre-release legal/supply-chain checks and should not be obscured by this guide's engineering scope.

## 12. Measured evidence (summary)

- 2026-10-25: Docker Desktop 29.9.2; **v4 trusted environment** (manifestVersion 4) real preparation built image
  `sha256:fd809329…`; controlled template `src/calc.ts` known failure (`mul` mistakenly written as `a-b`) ⇒
  `check_failed` exit 1; recorded fork fix (`fork.edit.field=result`) ⇒ `passed` exit 0;
  two independent sealed records, TAP `not ok 2` auditable; comparison conditions identical item by item, snapshots different;
  (v3 first round also measured) `traces/` and `workspace-blobs/` root fingerprints unchanged; both verification inputs exported through main,
  manifest snapshot and source hashes matched.
- 2026-10-25 security subset (v4): in-container writes to host/relative traversal ⇒ EROFS; docker.sock/network/host credentials unreachable;
  uid 1000; Buffer over 512 MiB ⇒ `process_failed` exit 137/SIGKILL; 2 MiB test output ⇒
  retained 1,048,576 B / total observed 2,097,581 B / `evidence_incomplete`; orphan writer stopped by targeted stop
  (stoppedPidCount=2, quiescence 2,584 ms, zero residual containers). v4 also fixed two real v3 defects:
  the runner's 1 MiB buffer misclassified long output as assertion failure; the supervisor's sleep child process made stop confirmation randomly unknown.
  Not rerun: P18 continuous writer not stopping during collection, P21 disconnect unknown, P22/P23 crash restart/unconfirmable cleanup.
- Distortion list: dual verification used a deterministic fixture (not real model/R2.1 UI output); export directory selection was a test stub;
  UI visual/keyboard/native dialog on-device evidence was not collected (6.3).
- Original reports and logs: `.workbuddy/r3-61b/report.json`, `.workbuddy/r3-62/report.json` and corresponding `-probe.log`
  (local temporary evidence, not committed); gate readings: `.workbuddy/r3-64/`.
