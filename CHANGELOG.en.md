# Changelog

> **Language:** English | [简体中文](CHANGELOG.md)

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This English file covers recent releases from `0.5.0-rc.1` through `0.8.0-rc.1`; the full history (`0.3.0-k1` and earlier) is in [CHANGELOG.md](CHANGELOG.md) (Chinese). Facts and boundaries match the Chinese entries; the per-version release notes in `docs/engineering/reports/` are the authoritative records (Chinese).

## [Unreleased]

(empty; see [CHANGELOG.md](CHANGELOG.md) for the historical `Unreleased` backlog in Chinese)

## [0.8.0-rc.1] — candidate (built 11/7) 2026-11-07

New relative to 0.7.0-rc.2 (release scope = the `add-software-i18n` change, archived 2026-11-06):

- **Full software bilingual support**: desktop main/preload/renderer product copy fully covered, with zh-CN and en-US interface languages.
  - **Language switcher**: the "Interface language" section in Settings switches immediately without restart. Unsaved model input, drafts, and reading positions are preserved; unconfirmed cost/copied-write/side-effect/experiment/verification confirmations are reset and must be re-reviewed in the new language. The language preference is stored separately and is not committed with model configuration.
  - **Default language**: resolved from the system language (zh variants → zh-CN, others → en-US) when no explicit preference exists.
  - **MCP 13 tools bilingual**: controlled errors, summaries, and startup diagnostics are bilingual; the service startup language supports `--locale` and `REBASEAGENT_LOCALE`.
  - **CLI bilingual**: trace-test human-readable reports and configuration errors, and model-ab human output are bilingual; shared language resolution priority `--locale` > `REBASEAGENT_LOCALE` > system language > en-US, with invalid values exiting as a controlled error (INVALID_LOCALE).
  - Per-scenario evidence and limitation registry: the archived `add-software-i18n` evidence-index (G05 scenario mapping table + 11 registered limitations, §6.7); a new main spec `software-i18n` was created.
- **Bilingual usage notes in the release zip**: from this build on, the zip includes both `使用说明.txt` (Chinese) and `使用说明.en.txt` (English); the already-uploaded rc.2 zip contains only the Chinese notes.
- Gate baseline: user-terminal `check:ci` exit 0 (desktop 234 files / 3,588 cases, mcp-server 405, replay 625+1 skip, trace-test 93, trace-sdk 231+1 skip, i18n 40, agent-loop 105, project-verification 289, run-query 52, llm-proxy 45), biome 971 files 0, check-spec 16/0; exe release-verify, zip assembly three-stage self-check, extracted 13-tool self-run, and offline smoke 12 criteria all passed; manual on-device acceptance not performed.
- Artifacts and verification evidence: [build record](docs/engineering/reports/2026-11-07-v0.8.0-rc.1-build-record.md) (Chinese), [release notes](docs/engineering/reports/2026-11-07-v0.8.0-rc.1-release-notes.md) (Chinese).
- Engineering note: Linux/macOS packaging was assessed and **not pursued** (moderate-to-high difficulty: cross-building from Windows is not possible, the release pipeline is bound to the Windows portable exe, and cross-platform test behavior is unknown; see the [assessment record](docs/engineering/notes/2026-11-07-cross-platform-packaging-assessment.md), Chinese).

## [0.7.0-rc.2] — candidate (rebuilt 10/26) 2026-10-26

A fix candidate relative to 0.7.0-rc.1; no new user features:

- **Fixed same-millisecond root run ID collisions**: `runLoop` previously generated `run_<ts>` from a millisecond timestamp only; two runs created in the same millisecond received the same ID, and the later `rename` overwrote the earlier trace. Changed to `run_<ts>_<random6>` (same shape as replay's `newRunId`), with a uniqueness regression using a fixed clock and different random values.
- **CI portability**: Docker CLI candidates are returned per platform (empty table on non-Windows); Windows paths use `path.win32.join/dirname`; the Gitee root-container permission-injection case is skipped; slow-machine/R3 endpoint tests replace fixed sleeps with polling; the output-limit test uses 64 MiB to prove mid-run kill.
- Gate baseline: agent-loop 105, replay 599 (+6 skip), trace-test 78, project-verification 288 (+1 skip), mcp-server 393, desktop 225 files / 3,474 cases, biome 920 files 0, check-spec 15/0.
- Artifacts and verification evidence: [build record](docs/engineering/reports/2026-10-26-v0.7.0-rc.2-build-record.md) (Chinese), [release notes](docs/engineering/reports/2026-10-26-v0.7.0-rc.2-release-notes.md) (Chinese).

## [0.7.0-rc.1] — candidate (built 10/26) 2026-10-26

New relative to 0.6.0-rc.1:

- **R3 isolated project verification**: in a restricted Docker Desktop (Linux containers) container, run the fixed `node-ts-v1` template's `typecheck` / trusted `test` against historical checkpoint source; environment preparation and execution are authorized separately, outcomes are layered, logs/artifacts are read with bounds, dual verification comparison and exact input export are provided, and stop/unknown states are presented truthfully. Scope is declared as Windows x64 + Docker Desktop + `node-ts-v1` only; real-project integration is unscheduled.
- **MCP2 verification-evidence queries**: the release zip's `mcp/` grows from seven to **13 tools**, adding six read-only verification tools (list/detail/log/artifacts/comparison); shares projection and comparison criteria with the desktop, with zero writes, zero execution, a 64 KiB budget, and authenticated cursors; WorkBuddy 5.9.2 real-client recheck and desktop same-object comparison passed.
- **Engineering quality**: after the last MCP2 source revision, reran repository-wide biome, fixing 34 files (54 formatting/import-order items + 3 lint items), then reran affected packages and the full desktop suite.
- Gate baseline: desktop 225 files / 3,474 cases green; mcp-server 393, project-verification 289, replay 599, run-query 51, trace-sdk 231, trace-test 78, agent-loop 104, llm-proxy 45; zip assembly three-stage self-check, extracted 13-tool self-run, offline smoke 12 criteria all passed; manual on-device acceptance not executed. Build and verification evidence: [build record](docs/engineering/reports/2026-10-26-v0.7.0-rc.1-build-record.md) (Chinese), [release notes](docs/engineering/reports/2026-10-26-v0.7.0-rc.1-release-notes.md) (Chinese).
- Known issue (fixed in 0.7.0-rc.2): the root run ID was generated only from a millisecond timestamp; two runs created in the same millisecond could collide and overwrite a trace.

## [0.6.0-rc.1] — candidate (built 10/24, uploaded) 2026-10-24

New relative to 0.5.0-rc.1:

- **R2.2 isolated prompt experiments**: single-variable startup-instruction experiments on a root's initial snapshot, v3 records, cross-run checkpoint/file comparison, and single-side export.
- **MCP0 + MCP1 read-only diagnostics**: seven read-only tools (run list, step bodies, comparison, checkpoint files), with a self-contained `mcp/` directory in the zip; two rounds of real-client acceptance.
- **Renderer module split**: 63 giant component files consolidated into a store composition layer + connection layer, with zero behavior change (internal refactor).
- Gate baseline: desktop 216 files / 3,301 cases green; zip assembly three-stage self-check and extracted self-run, offline smoke 12 criteria all passed; manual on-device acceptance not executed. Build and verification evidence: [build record](docs/engineering/reports/2026-10-24-v0.6.0-rc.1-build-record.md) (Chinese), [release notes](docs/engineering/reports/2026-10-24-v0.6.0-rc.1-release-notes.md) (Chinese).

## [0.5.0-rc.1] — candidate (built 10/16, not uploaded) 2026-10-16

The first candidate using the **zip-only** format (portable exe + `SHA256SUMS.txt` + usage notes in the zip; extracting with 7-Zip/WinRAR avoids the first SmartScreen prompt). New relative to 0.4.0-rc.2:

- **R2.1 result export**: export entry and confirmation card on the Files page (three checks: empty target directory, written content, non-retained items; no manual physical-path entry); self-contained manifest (`source` / `patch.status`, attachment hashes verified byte by byte); failures clean up in reverse order with no partial artifacts; success/cancel/failure four-state feedback is truthful, and old feedback collapses when the checkpoint changes; isolated forks do not inherit execution authorization from the reading state; in the pure reading phase, trace/attachment/source-directory fingerprints remain byte-for-byte unchanged.
- **refine-ui reorganization (community-release polish)**: object identity restored, full run ID viewable and copyable in one action (including a keyboard path); "Run records / Branch relations" terminology unified, and switching does not reload; run list is task-first, with same-name long tasks distinguished by short ID; return destinations use readable labels, source invalidation is presented nearby while still protecting input; the bottom "Session activity" bar unifies draft/operation/result facts into three groups and locates them across pages; clean/dirty grouping is honest, with clear protection; form initial guidance and attempt verification are layered, and upstream exceptions are presented immediately; bad attachments are explicitly distinguishable (corrupt label / unavailable summary / export disabled); on-device acceptance surfaced and fixed a create-page white screen (unstable state reference caused the whole tree to unmount).
- Fix: replay tests crashed at module top level on unprivileged Windows (`isLinkAt` now tolerates ENOENT).
- Gate baseline: desktop 203 files / 3,180 cases green, Errors=0; post-packaging offline smoke 14 criteria all passed; manual on-device acceptance not executed.

Earlier versions (`0.3.0-k1` and before) are documented in the Chinese [CHANGELOG.md](CHANGELOG.md).
