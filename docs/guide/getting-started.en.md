# Getting started (Guide)

> **Language:** English | [简体中文](getting-started.md)

> For new users: from zero to your first look at the time-travel debugging UI. For the full feature set and capability boundaries, see the repository root [`README.en.md`](../../README.en.md).

## 1. Get the app

Two paths (Windows x64):

- **Portable build (recommended)**: get `ReBaseAgent-0.8.0-rc.1-win-x64.zip` (`105,840,583` bytes, SHA-256 prefix `4d2aa5bbbf39a05a`) from [GitHub Releases](https://github.com/pomelotea-yuzu/ReBaseAgent/releases/tag/v0.8.0-rc.1), extract it with 7-Zip / WinRAR, and double-click the exe. This zip exceeds Gitee's per-attachment limit; the Gitee [release page](https://gitee.com/yuzu-tea-duck/re-base-agent/releases/tag/v0.8.0-rc.1) carries notes only. This candidate includes full software bilingual support (Simplified Chinese / English), R3 isolated project verification, the 13 MCP tools, and all archived desktop capabilities. The tag is local-only; uploading the Release is a separate step. Hashes and acceptance boundaries are in [project status](../development/project-status.md) (Chinese). App data lives in `data/` next to the exe; the launcher extracts temporarily at startup.
- **Run from source**:

```bash
pnpm install
pnpm check:build    # build shared libraries first for desktop development
pnpm dev            # start the Electron desktop app
```

## 2. Four paths

Choose according to what you have (detailed steps are in the root README's Quick start section):

| Your situation | Path |
|---|---|
| Nothing yet — just want a look | Click **New run** in the desktop app and run a run directly; no proxy or scripts |
| Want to debug controlled file tasks | Desktop isolated file run: import a directory, execute with fixed read/write tools, edit one step's `tool_result`, and continue from the copy world. It does not automatically take over an existing agent's arbitrary tools |
| Already using a model API | Local recording proxy: change only `base_url` to record existing calls as traces |
| Only want to debug an existing agent / use the execution engine | SDK integration: `packages/agent-loop` (engine) or `packages/trace-sdk` (instrumentation) |

## 3. Core concepts in one minute

- **run / trace**: the complete record of one Agent execution; JSONL, one file per run, append-only, sealed after termination.
- **Tool-result continuation**: edit a historical `tool_result`, reuse the prefix messages, and continue execution. Isolated file mode continues from the end-of-turn checkpoint without undoing that turn's writes or re-executing the edited tool. Cache benefits depend on the provider and the specific request.
- **prompt fork**: change the system prompt or the first user message and execute from the beginning; the parent run is kept for provenance. Isolated parents are currently unsupported.
- **Trace-as-Test**: turn a sealed trace into a cassette regression test — zero network, zero cost, CI-friendly.
- **Model A/B**: derive multiple arms from the same parent run; dry-run the plan first, then execute for real.

## 4. Next steps

- Architecture and package responsibilities: [`architecture/overview.en.md`](../architecture/overview.en.md)
- Contributing: [`development/workflow.en.md`](../development/workflow.en.md)
- Roadmap and current limitations: the corresponding sections in the root [`README.en.md`](../../README.en.md)
