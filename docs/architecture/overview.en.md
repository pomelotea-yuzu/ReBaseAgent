# Architecture overview

> **Language:** English | [简体中文](overview.md)

> The authoritative package list and responsibility descriptions are in the repository root [`README.en.md`](../../README.en.md) "Architecture" section; this page expands on it.

## Monorepo structure

```text
packages/
  agent-loop   Agent execution engine (pure TS, zero Electron dependencies, headless)
  trace-sdk    Span instrumentation API + trace format v1 definitions
  replay       Replay orchestrator + sandbox manager (CI-friendly)
  llm-proxy    Local LLM recording proxy (change base_url to record)
  trace-test   Trace-as-Test: cassette rerun runtime regression tests (zero network / zero disk, CI-friendly)
apps/
  desktop      Electron desktop debugging workbench (the only Electron-dependent package; replaceable)
```

Workspaces are defined in `pnpm-workspace.yaml` (`packages/*` + `apps/*`).

## Data flow

```text
Model call ──► llm-proxy (recording) ─┐
Agent execution ──► trace-sdk spans ─┼──► trace (JSONL, one file per run)
Desktop "＋ New run" ─────────────────┘         │
                                                ▼
                    replay (replay/rerun/isolated sandbox orchestration) ──► new trace
                                                │
                    trace-test (cassette assertions) · model-ab CLI (multi-arm experiments)
                                                ▼
                    apps/desktop (timeline · branch tree · file view · experiment groups)
```

## Design principles

- **JSONL is the single source of truth**: one file per run, append-only; once the terminal event is written the run is sealed and no path may modify it.
- **Model access**: OpenAI-compatible protocol directly, zero vendor SDKs.
- **Data policy**: portable-first — all data lives in `data/` next to the app directory, never in AppData or the registry.
- **Electron is replaceable**: all core capabilities live in `packages/`; the desktop app is only one consumer.
- **Isolated rerun is not a permission system**: file checkpoints + the copy world guarantee only that "the parent run / source directory / sibling branches remain byte-for-byte unchanged"; they do not isolate networks, shells, or external state sources.

## Evolution decision record

The capability evolution path (A: isolated kernel → B: desktop entry → C: file view → U: usability) is governed by the archived changes in
`openspec/changes/archive/`: each change contains proposal / design / spec delta / tasks / evidence-index (on-device acceptance evidence index). The product direction is finalized in
[`product/product.md`](../product/product.md) (Chinese).
