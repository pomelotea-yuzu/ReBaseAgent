# Rerun state-consistency mechanism

> **Language:** English | [简体中文](replay-state-consistency.md)

Reviewed 2026-09-27. This document explains the execution semantics that already exist, based on the [replay specification](../../openspec/specs/replay/spec.md) (Chinese), the [workspace-isolation specification](../../openspec/specs/workspace-isolation/spec.md) (Chinese), and the corresponding source code. It does not add a new product contract, nor does it mean all tests were rerun for this revision.

## The problem being solved

If only the model's conversation history is restored while later tools read today's working directory, the "then" in the messages and the "now" in the files may contradict each other. Conversely, copying files without determining which tool turn the message prefix corresponds to does not make the continuation boundary clear either.

ReBaseAgent's isolated mode defines the starting point of a continuation by three things: the derived message prefix, the file snapshot at the end of the whole turn that contains the selected tool, and the fork position in the direct parent run. The scope is this project's execution loop and the fixed `file-tools-v1` tool group.

## What editing a tool observation actually means

Suppose a turn's model produces two tool calls, T1 and T2. Executing both yields observations O1 and O2 and forms the end-of-turn file world W. The user changes O1 to O1' and creates a branch:

1. The derived messages keep this turn's tool calls and both tool results, replacing only O1 with O1'.
2. The branch's initial file state is W, so it includes the file effects that T1 and T2 originally produced.
3. T1 and T2 are not re-executed, and neither is undone; the next model call sees the new observation combination.
4. New tool calls produced afterward execute for real and change only the current branch's file mapping.

This mode therefore studies "how changing one observation affects later decisions under the established end-of-turn file facts". It is not "actually replacing T1 with a different execution and recomputing the world". A manually edited observation may conflict with the file facts; that conflict is itself an experiment input, and one cannot claim to have restored a history that necessarily happened.

Multi-generation forks additionally require the edit point to belong to the direct parent run itself and to have a corresponding complete checkpoint. The ancestor-reference scope allowed by ordinary message forks cannot be applied directly to the isolated entry.

## The file world and failure boundaries

| Mechanism | Purpose | Limitation |
|---|---|---|
| Importing ordinary file bytes from a source directory | Establish an independent initial world; later reads do not fall back to the source directory | Does not preserve empty directories, permissions, timestamps, or link identity; rejects links and unsupported objects |
| Content-addressed immutable blobs | Identical content can be shared; attachments are verified by hash and size | Hashing is not a backup strategy; attachments may still be lost, and execution is refused when they are missing |
| Independent path mapping per branch | Later writes do not change the parent world or sibling worlds | Does not automatically merge back to the source directory, and is not an OS permission sandbox |
| Initial and tool-turn-end checkpoints | Message boundaries and file boundaries can be located | Does not provide an arbitrary restore point after each individual tool |
| Explicit copy-write authorization for the current request | Prevents historical records from automatically authorizing a new execution | Neither the `sideEffect` declaration nor parent-run authorization can replace this authorization |
| Pre-execution validation and rejection downgrade | Does not silently fall back to ordinary tools when an attachment is missing/corrupt or the parent is invalid | The trace remains readable, but "viewable" must not be written as "continuable" |

First-release quotas include 2,000 files, 8 MiB per file, 64 MiB for the current world, and 128 MiB of new unique content per run. Quotas and path constraints are governed by the specification; this document does not promise larger task scales. Controlled tools support only `read_file` / `write_file`; historical restoration is not provided for shells, databases, network side effects, or custom handlers.

## Different entry points must not be conflated with full reproduction

| Entry | Starting point and execution | What it can show |
|---|---|---|
| Normal tool-result rerun | Reuse the message prefix; later tools execute in the original configured cwd | Continuation after an observation change; external state rollback is not guaranteed |
| Isolated tool-result continuation | Reuse the message prefix and the matching end-of-turn file snapshot; later operations work on the copy | An auditable branch experiment inside a controlled file world |
| Prompt or model experiment | Start a new run from the initial input | Re-execution under a new configuration; not a continuation after a tool edit point, and isolated prompt/A-B is currently unsupported |
| Proxy recording and resend | Capture or resend model requests | Observation at the single-request level; not full restoration of an arbitrary third-party Agent |
| Trace-as-test | The current loop uses recorded model responses and stub tool execution | Verifies execution structure by default; does not verify real model answer quality or real external side effects |

In cassette tests, `request_drift` / `config_drift` display warnings but do not by themselves change the pass status or exit code. Proxy-originated runs cannot perform dynamic cassette reruns; only explicit static assertions are allowed. See the [trace-as-test specification](../../openspec/specs/trace-as-test/spec.md) (Chinese).

## Implementation and verification entry points

| Claim | Implementation entry | Check point in test source |
|---|---|---|
| End-of-turn restoration maps to observation editing | [isolated-replay.ts](../../packages/replay/src/workspace/isolated-replay.ts), [derive.ts](../../packages/replay/src/derive.ts) | [workspace-isolated-replay.test.ts](../../packages/replay/test/workspace-isolated-replay.test.ts): reads `middle`, not `after`; replaces only the T1 observation in the same turn and keeps T1/T2 file effects |
| Branches share content but not mutable mappings | [world.ts](../../packages/replay/src/workspace/world.ts), [blob-store.ts](../../packages/replay/src/workspace/blob-store.ts) | [workspace-isolated-integration.test.ts](../../packages/replay/test/workspace-isolated-integration.test.ts): multi-generation forks, sibling independence, parent unchanged |
| Missing attachments do not fall back to the source directory | [preflight.ts](../../packages/replay/src/workspace/preflight.ts), [read-api.ts](../../packages/replay/src/workspace/read-api.ts) | [workspace-package-recovery.test.ts](../../packages/replay/test/workspace-package-recovery.test.ts): migration recovery, trace readable with missing attachments but continuation refused |
| Cassettes are not the same as real-model regression | [cassette-llm-client.ts](../../packages/trace-test/src/cassette-llm-client.ts) | [cassette.test.ts](../../packages/trace-test/test/cassette.test.ts): continues consuming responses after a request-drift warning |

## Boundaries of the technical contribution claim

Checkpoints, time travel, content addressing, copy-on-write, tracing, and cassette testing are all existing techniques. What can currently be stated is that, for tool-observation intervention, the project implements message/whole-turn file-snapshot alignment, branch identity tracing, controlled copy writes, and failure-rejection policies, with corresponding implementation and test source code.

This constitutes an explainable, verifiable system design and engineering implementation, but it cannot by itself prove a new fundamental algorithm, that comparable approaches cannot implement it, or absolute priority. Actual value still needs validation of correctness, resource cost, and real-task benefit through the [experiment plan](../research/2026-09-27-replay-consistency-experiment.md) (Chinese).
