import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findExperimentSourceViolation, readRun, resolveBranch } from "../src/index";
import type { RunMetaInput, RunRecord, SpanLine } from "../src/index";
import { parseRunText } from "../src/reader";
import { RunMetaSchema } from "../src/schema";
import { createWorkspaceSnapshot } from "../src/workspace-hash";
import { buildRecord, sampleRequest, sampleResponse } from "./helpers";

/**
 * v3 隔离 prompt 实验（R2.2 任务 2.1–2.3）：
 * schema 自洽、strip 前版本守卫、reader 跨行约束、branch 独立执行边界。
 */

const initial = createWorkspaceSnapshot([
  { path: "config.json", sha256: "a".repeat(64), bytes: 3 },
]);

/** 最小合法 v3 meta 原始对象（可覆盖/替换字段） */
function v3Meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run.meta",
    id: "r_v3",
    format_version: 3,
    task: "隔离 prompt 实验",
    model: "m",
    created_at: "2026-10-21T00:00:00.000Z",
    parent: "r_root",
    fork: { at_span: "s_02", edit: { field: "system_prompt", value: "新指令" } },
    config_hash: "sha256:abc",
    workspace: {
      profile: "file-tools-v1",
      world_id: "r_v3",
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "initial", run_id: "r_root", snapshot_id: initial.id },
    },
    prompt_experiment: {
      baseline_run_id: "r_root",
      baseline_llm_span_id: "s_02",
      initial_snapshot_id: initial.id,
      original_value: "旧指令",
      execution: {
        model: "m",
        params: { temperature: 0.2, reasoning_effort: "none", think: false },
        provider_endpoint: "http://127.0.0.1:18787/v1",
        max_iterations: 12,
        budget: 60000,
        config_fingerprint: "sha256:fp",
      },
      hypothesis: "只改启动指令",
      acceptance_criterion: "未知键保留且目标值正确",
    },
    ...over,
  };
}

function v1Meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run.meta",
    id: "r_01",
    format_version: 1,
    task: "t",
    model: "m",
    created_at: "2026-10-21T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: "sha256:abc",
    ...over,
  };
}

function v2Meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return v1Meta({
    format_version: 2,
    workspace: {
      profile: "file-tools-v1",
      world_id: "r_01",
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "import" },
    },
    ...over,
  });
}

const lines = (...objects: Record<string, unknown>[]): string[] =>
  objects.map((o) => JSON.stringify(o));

const event = { type: "run.event", event: "stopped", reason: "completed", at: 1 };
const step = (id: string, n: number) => ({
  type: "span",
  id,
  kind: "agent.step",
  parent: null,
  n,
  workspace_snapshot: initial,
});

function deepMeta(over: {
  workspace?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  fork?: Record<string, unknown>;
}): Record<string, unknown> {
  const base = v3Meta();
  return {
    ...base,
    ...(over.fork === undefined ? {} : { fork: { ...(base.fork as object), ...over.fork } }),
    workspace: { ...(base.workspace as object), ...(over.workspace ?? {}) },
    prompt_experiment: {
      ...(base.prompt_experiment as object),
      ...(over.prompt ?? {}),
      execution: {
        ...((base.prompt_experiment as { execution: object }).execution ?? {}),
        ...(over.execution ?? {}),
      },
    },
  };
}

describe("v3 schema：合法记录与字段往返", () => {
  it("v3 合法 meta 解析通过：initial origin、实验记录、假设/判据完整保留", () => {
    const meta = RunMetaSchema.parse(v3Meta());
    expect(meta.format_version).toBe(3);
    expect(meta.workspace?.origin).toEqual({
      kind: "initial",
      run_id: "r_root",
      snapshot_id: initial.id,
    });
    expect(meta.prompt_experiment?.baseline_run_id).toBe("r_root");
    expect(meta.prompt_experiment?.execution.params).toEqual({
      temperature: 0.2,
      reasoning_effort: "none",
      think: false,
    });
    expect(meta.prompt_experiment?.hypothesis).toBe("只改启动指令");
    expect(meta.prompt_experiment?.acceptance_criterion).toBe("未知键保留且目标值正确");
  });

  it("经 parseRunText 往返：meta/step 快照/实验字段逐项保留", () => {
    const record = parseRunText(lines(v3Meta(), step("s_v01", 1), event));
    expect(record.meta.format_version).toBe(3);
    expect(record.meta.prompt_experiment?.original_value).toBe("旧指令");
    expect(record.meta.fork?.edit).toEqual({ field: "system_prompt", value: "新指令" });
    const stepSpan = record.spans.find((s) => s.kind === "agent.step");
    expect(stepSpan?.kind === "agent.step" ? stepSpan.workspace_snapshot?.id : undefined).toBe(
      initial.id,
    );
  });

  it("original_value 允许真实空串；params 缺省与显式空对象可区分", () => {
    const emptyOriginal = deepMeta({ prompt: { original_value: "" } });
    expect(RunMetaSchema.parse(emptyOriginal).prompt_experiment?.original_value).toBe("");

    const explicitEmpty = deepMeta({ execution: { params: {} } });
    expect(RunMetaSchema.parse(explicitEmpty).prompt_experiment?.execution.params).toEqual({});

    const withoutParams = {
      ...(v3Meta().prompt_experiment as { execution: Record<string, unknown> }).execution,
    };
    withoutParams.params = undefined;
    const base = v3Meta();
    const missingParams = {
      ...base,
      prompt_experiment: {
        ...(base.prompt_experiment as object),
        execution: withoutParams,
      },
    };
    expect(RunMetaSchema.parse(missingParams).prompt_experiment?.execution.params).toBeUndefined();
  });
});

describe("v3 schema：矛盾与非法字段拒绝", () => {
  it.each([
    ["缺 prompt_experiment", v1Meta({ format_version: 3, parent: "r_root" }), /prompt_experiment/],
    ["parent 为 null", v3Meta({ parent: null }), /parent/],
    [
      "带 resume_after_step",
      deepMeta({ fork: { resume_after_step: "s_01" } }),
      /resume_after_step/,
    ],
    [
      "edit.field=model_params",
      deepMeta({ fork: { edit: { field: "model_params", value: { model: "m" } } } }),
      /fork.edit.field/,
    ],
    [
      "edit.value 非字符串",
      deepMeta({ fork: { edit: { field: "system_prompt", value: 42 } } }),
      /fork.edit.value/,
    ],
    [
      "origin 不是 initial",
      deepMeta({
        workspace: { origin: { kind: "checkpoint", run_id: "r_root", step_span: "s_01" } },
      }),
      /initial/,
    ],
    [
      "baseline_run_id 不一致",
      deepMeta({ prompt: { baseline_run_id: "r_other" } }),
      /baseline_run_id/,
    ],
    [
      "baseline_llm_span_id 不一致",
      deepMeta({ prompt: { baseline_llm_span_id: "s_99" } }),
      /baseline_llm_span_id/,
    ],
    [
      "initial_snapshot_id 不一致",
      deepMeta({ prompt: { initial_snapshot_id: "b".repeat(64) } }),
      /initial_snapshot_id/,
    ],
    [
      "origin.snapshot_id 不一致",
      deepMeta({
        workspace: { origin: { kind: "initial", run_id: "r_root", snapshot_id: "b".repeat(64) } },
      }),
      /snapshot_id/,
    ],
    [
      "origin.run_id 不一致",
      deepMeta({
        workspace: { origin: { kind: "initial", run_id: "r_other", snapshot_id: initial.id } },
      }),
      /origin.run_id/,
    ],
  ])("%s ⇒ 拒绝", (_label, raw, pattern) => {
    expect(() => RunMetaSchema.parse(raw)).toThrow(pattern);
  });

  it("假设/判据超过 4000 字符被拒绝（4000 字符本身合法）", () => {
    expect(() =>
      RunMetaSchema.parse(deepMeta({ prompt: { hypothesis: "x".repeat(4001) } })),
    ).toThrow();
    expect(() =>
      RunMetaSchema.parse(deepMeta({ prompt: { acceptance_criterion: "x".repeat(4001) } })),
    ).toThrow();
    expect(() =>
      RunMetaSchema.parse(deepMeta({ prompt: { hypothesis: "x".repeat(4000) } })),
    ).not.toThrow();
  });

  it("params 只接受 JSON 标量：嵌套对象/数组/null/数字字符串以外的结构拒绝", () => {
    for (const bad of [{ nested: { a: 1 } }, { list: [1] }, { nothing: null }, { v: undefined }]) {
      expect(() => RunMetaSchema.parse(deepMeta({ execution: { params: bad } }))).toThrow();
    }
  });

  it("执行条件空串/非正数拒绝", () => {
    for (const bad of [
      { model: "" },
      { provider_endpoint: "" },
      { config_fingerprint: "" },
      { max_iterations: 0 },
      { max_iterations: 1.5 },
      { budget: 0 },
      { budget: -1 },
    ]) {
      expect(() => RunMetaSchema.parse(deepMeta({ execution: bad }))).toThrow();
    }
  });

  it("v1/v2 直接经 schema 携带 prompt_experiment 也拒绝", () => {
    expect(() => RunMetaSchema.parse(v1Meta({ prompt_experiment: null }))).toThrow(
      /prompt_experiment/,
    );
    expect(() => RunMetaSchema.parse(v2Meta({ prompt_experiment: {} }))).toThrow(
      /prompt_experiment/,
    );
  });

  it("v2 使用 initial origin 拒绝", () => {
    expect(() =>
      RunMetaSchema.parse(
        v2Meta({
          parent: "r_root",
          fork: {
            at_span: "s_02",
            resume_after_step: "s_01",
            edit: { field: "result", value: "x" },
          },
          workspace: {
            profile: "file-tools-v1",
            world_id: "r_01",
            write_authorized: true,
            initial_snapshot: initial,
            origin: { kind: "initial", run_id: "r_root", snapshot_id: initial.id },
          },
        }),
      ),
    ).toThrow(/initial/);
  });
});

describe("v3 版本守卫：strip 前拒绝旧版本私带实验字段", () => {
  it.each([
    ["v1 + prompt_experiment=null", v1Meta({ prompt_experiment: null }), /prompt_experiment/],
    ["v2 + prompt_experiment={}", v2Meta({ prompt_experiment: {} }), /prompt_experiment/],
    [
      "v2 + origin initial",
      v2Meta({
        parent: "r_root",
        fork: { at_span: "s_02", resume_after_step: "s_01", edit: { field: "result", value: "x" } },
        workspace: {
          profile: "file-tools-v1",
          world_id: "r_01",
          write_authorized: true,
          initial_snapshot: initial,
          origin: { kind: "initial", run_id: "r_root", snapshot_id: initial.id },
        },
      }),
      /initial/,
    ],
    ["v3 缺 prompt_experiment", v3Meta({ prompt_experiment: undefined }), /prompt_experiment/],
    ["v3 缺 workspace", v3Meta({ workspace: undefined }), /workspace/],
  ])("%s ⇒ reader 明确报错", (_label, raw, pattern) => {
    expect(() => parseRunText(lines(raw))).toThrow(pattern);
  });

  it("v3 完整跨行：step 缺快照仍被拒绝", () => {
    const noSnapshot = { type: "span", id: "s_v01", kind: "agent.step", parent: null, n: 1 };
    expect(() => parseRunText(lines(v3Meta(), noSnapshot, event))).toThrow(/workspace_snapshot/);
  });

  it("v3 自有文件可独立读取（父文件不在时也不影响本文件解析）", () => {
    const record = parseRunText(lines(v3Meta(), step("s_v01", 1), event));
    expect(record.meta.id).toBe("r_v3");
    expect(record.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// branch：v3 独立执行边界与完整父根校验
// ---------------------------------------------------------------------------

function llmSpan(
  id: string,
  parent: string,
  messages: Array<{ role: string; content: string }>,
): SpanLine {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent,
    request: { ...sampleRequest(), messages },
    response: sampleResponse(),
  };
}

function toolSpan(id: string, parent: string): SpanLine {
  return {
    type: "span",
    id,
    kind: "tool.invoke",
    parent,
    tool: "read_file",
    args: { path: "config.json" },
    result: "{}",
    dur_ms: 1,
    error: null,
  };
}

function loaderOf(map: Record<string, RunRecord>) {
  return (id: string): RunRecord => {
    const rec = map[id];
    if (rec === undefined) throw new Error(`文件不存在：${id}.jsonl`);
    return rec;
  };
}

function rootRecord(): RunRecord {
  const root = buildRecord({
    id: "r_root",
    format_version: 2,
    task: "隔离根",
    model: "m",
    created_at: "2026-10-21T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: "sha256:abc",
    workspace: {
      profile: "file-tools-v1",
      world_id: "r_root",
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "import" },
    },
  });
  root.spans = [
    {
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
      workspace_snapshot: initial,
    },
    llmSpan("s_02", "s_01", [
      { role: "system", content: "旧指令" },
      { role: "user", content: "读 config.json" },
    ]),
    toolSpan("s_03", "s_01"),
    {
      type: "span",
      id: "s_04",
      kind: "agent.step",
      parent: null,
      n: 2,
      workspace_snapshot: initial,
    },
  ];
  return root;
}

function v3Record(
  over: {
    meta?: Record<string, unknown>;
    spans?: SpanLine[];
  } = {},
): RunRecord {
  const record = buildRecord(v3Meta(over.meta ?? {}) as unknown as RunMetaInput);
  record.spans = over.spans ?? [
    {
      type: "span",
      id: "v_01",
      kind: "agent.step",
      parent: null,
      n: 1,
      workspace_snapshot: initial,
    },
    llmSpan("v_02", "v_01", [
      { role: "system", content: "新指令" },
      { role: "user", content: "读 config.json" },
    ]),
    toolSpan("v_03", "v_01"),
    {
      type: "span",
      id: "v_04",
      kind: "agent.step",
      parent: null,
      n: 2,
      workspace_snapshot: initial,
    },
  ];
  return record;
}

describe("resolveBranch：v3 独立边界", () => {
  it("v3 叶子只返回自有轨迹，父链仍可溯源", () => {
    const root = rootRecord();
    const child = v3Record();
    const resolved = resolveBranch("r_v3", loaderOf({ r_root: root, r_v3: child }));
    expect(resolved.spans.map((s) => s.id)).toEqual(["v_01", "v_02", "v_03", "v_04"]);
    expect(resolved.chain.map((c) => c.meta.id)).toEqual(["r_root", "r_v3"]);
  });

  it("v3 父的 v2 result 子：只继承 v3 自身整轮前缀，不跨边界拼入根", () => {
    const root = rootRecord();
    const child = v3Record();
    const resultChild = buildRecord({
      id: "r_result",
      format_version: 2,
      task: "result 续跑",
      model: "m",
      created_at: "2026-10-21T00:00:00.000Z",
      parent: "r_v3",
      fork: {
        at_span: "v_03",
        resume_after_step: "v_01",
        edit: { field: "result", value: "改后的结果" },
      },
      config_hash: "sha256:abc",
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_result",
        write_authorized: true,
        initial_snapshot: initial,
        origin: { kind: "checkpoint", run_id: "r_v3", step_span: "v_01" },
      },
    });
    resultChild.spans = [
      {
        type: "span",
        id: "x_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        workspace_snapshot: initial,
      },
    ];
    const resolved = resolveBranch(
      "r_result",
      loaderOf({ r_root: root, r_v3: child, r_result: resultChild }),
    );
    // v3 第 1 轮整轮保留（v_01..v_03），第 2 轮（v_04）被截断；根的 s_* 不出现
    expect(resolved.spans.map((s) => s.id)).toEqual(["v_01", "v_02", "v_03", "x_01"]);
    expect(resolved.chain.map((c) => c.meta.id)).toEqual(["r_root", "r_v3", "r_result"]);
  });

  it.each([
    [
      "at_span 不指向父根首次 llm.call",
      v3Record({
        meta: { fork: { at_span: "s_03", edit: { field: "system_prompt", value: "新" } } },
      }),
      /首次 llm.call/,
    ],
    [
      "original_value 与父根请求不一致",
      v3Record({
        meta: {
          prompt_experiment: {
            ...(v3Meta().prompt_experiment as object),
            original_value: "被篡改的原值",
          },
        },
      }),
      /original_value/,
    ],
  ])("%s ⇒ 完整来源读取拒绝", (_label, child, pattern) => {
    const root = rootRecord();
    expect(() => resolveBranch("r_v3", loaderOf({ r_root: root, r_v3: child }))).toThrow(pattern);
  });

  it("父不是根 ⇒ 完整来源读取拒绝", () => {
    const mid = buildRecord({
      id: "r_mid",
      format_version: 2,
      task: "隔离分支",
      model: "m",
      created_at: "2026-10-21T00:00:00.000Z",
      parent: "r_root",
      fork: {
        at_span: "s_03",
        resume_after_step: "s_01",
        edit: { field: "result", value: "x" },
      },
      config_hash: "sha256:abc",
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_mid",
        write_authorized: true,
        initial_snapshot: initial,
        origin: { kind: "checkpoint", run_id: "r_root", step_span: "s_01" },
      },
    });
    mid.spans = [
      {
        type: "span",
        id: "m_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        workspace_snapshot: initial,
      },
      llmSpan("m_02", "m_01", [
        { role: "system", content: "旧指令" },
        { role: "user", content: "读 config.json" },
      ]),
    ];
    const root = rootRecord();
    const child = v3Record({
      meta: {
        parent: "r_mid",
        workspace: {
          profile: "file-tools-v1",
          world_id: "r_v3",
          write_authorized: true,
          initial_snapshot: initial,
          origin: { kind: "initial", run_id: "r_mid", snapshot_id: initial.id },
        },
        prompt_experiment: {
          ...(v3Meta().prompt_experiment as object),
          baseline_run_id: "r_mid",
          baseline_llm_span_id: "m_02",
        },
        fork: { at_span: "m_02", edit: { field: "system_prompt", value: "新" } },
      },
    });
    expect(() =>
      resolveBranch("r_v3", loaderOf({ r_root: root, r_mid: mid, r_v3: child })),
    ).toThrow(/不是根/);
  });

  it("findExperimentSourceViolation：非 v3 直接放行", () => {
    const root = rootRecord();
    expect(findExperimentSourceViolation(root, root)).toBeNull();
  });
});

// 既有 fixtures 回归：v3 升版不改变 v1/v2 读取
describe("v1/v2 回归", () => {
  it("v2 隔离根仍可读；v1 普通 run 仍可读", () => {
    const v2 = parseRunText(lines(v2Meta(), event));
    expect(v2.meta.format_version).toBe(2);
    const v1 = parseRunText(
      lines(v1Meta(), { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 }, event),
    );
    expect(v1.meta.format_version).toBe(1);
  });

  it("readRun 读取既有 fixtures 不受升版影响", () => {
    const dir = fileURLToPath(new URL("../fixtures/", import.meta.url));
    const record = readRun(`${dir}normal.jsonl`);
    expect(record.meta.format_version).toBe(1);
    expect(record.status).toBe("completed");
  });
});
