import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVED_BODY_KEYS, runLoop } from "@rebaseagent/agent-loop";
import type { Tool } from "@rebaseagent/agent-loop";
import { ModelParamsValueSchema, sameParams, scalarParams } from "@rebaseagent/replay";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../packages/agent-loop/test/helpers";
import { runModelAb } from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import {
  modelAbGuard,
  parseArmParams,
  riskyToolNames,
  scalarRequestParams,
} from "../src/renderer/src/lib/model-ab";
import type { ArmDraft, ModelAbGuardInput } from "../src/renderer/src/lib/model-ab";

/**
 * 模型 A/B 的**双层判据一致性**（renderer 早拦层 ↔ replay 内核）。
 *
 * 背景（2026-09-17 K0 验收暴露的既有缺陷）：渲染层 `modelAbGuard` 曾在两处与内核不同粒度——
 * 空 fork 只在"**所有**臂都与父相同"时才拦（内核逐臂拦），副作用确认只是渲染层的一个复选框、
 * 从不作为声明下发（内核按"**每臂** allowSideEffects === true"判据）。结果是界面放行、
 * 提交整批被拒（INVALID_ARM / TOOL_POLICY），零文件零调用但用户白填一遍表单。
 *
 * 本文件的判据是**单向蕴含**：`guard.canSubmit === true` ⟹ 同一批 arms 交给内核 dry-run
 * 必须不被前置拒绝。反方向不成立——父链、封存、config_hash、隔离父本这些门禁刻意只在
 * main + 内核里有一份（早拦层不重复），所以"界面能拦、内核也会拦"不要求逐条对齐。
 *
 * 用真实 runLoop + mock LLM 现造父 run（零真实 API）；内核对齐走 `runModelAb` 的 dry-run
 * 路径（不联网、不写文件，但父链/封存/双真相源/工具策略/config_hash 全部照跑）。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

const TASK = "读取 README.md 并把要点写入 summary.md";
const PARENT_SCRIPT = [{ content: "父 run 直接收尾。" }];

/** 纯工具（全部显式 sideEffect: false）：能过内核的工具策略 */
const PURE_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "model-ab-parity-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 用真实 runLoop + mock LLM 造一个已封存的父 run；返回记录（设置/工具按入参） */
async function createParent(
  traces: string,
  tools: Tool[],
  params: Record<string, number> | undefined,
): Promise<RunRecord> {
  const toolsWithHandler = tools;
  const defs = toolsWithHandler.map(({ handler: _h, ...def }) => def);
  const config = sampleConfig({ tools: defs, ...(params !== undefined ? { params } : {}) });
  const tmpFile = join(traces, "tmp-parent.jsonl");
  await runLoop(
    config,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    toolsWithHandler,
    new MockLlmClient(PARENT_SCRIPT),
  );
  const record = readRun(tmpFile);
  expect(record.status).toBe("completed");
  renameSync(tmpFile, join(traces, `${record.meta.id}.jsonl`));
  return record;
}

/** 与 DetailPanel 的取值路径一致：父值来自父 run 首次 llm.call 的录制请求 */
function guardInputFrom(
  parent: RunRecord,
  arms: ArmDraft[],
  allowSideEffects: boolean,
): ModelAbGuardInput {
  const firstLlm = parent.spans.find((s) => s.kind === "llm.call");
  if (firstLlm === undefined || firstLlm.kind !== "llm.call") {
    throw new Error("父 run 缺少首次 llm.call 录制");
  }
  return {
    settingsConfigured: true,
    parentModel: firstLlm.request.model,
    parentParams: scalarRequestParams(firstLlm.request.params),
    riskyTools: riskyToolNames(firstLlm.request.tools),
    allowSideEffects,
    arms,
  };
}

describe("guard ↔ 内核：空 fork 的粒度一致（逐臂，不是整批）", () => {
  it("guard 放行的臂必须被内核 dry-run 接受", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parent = await createParent(traces, PURE_TOOLS, { temperature: 0.7 });
      const guard = modelAbGuard(
        guardInputFrom(
          parent,
          [
            { model: "m-1", paramsText: "" },
            { model: "deepseek-chat", paramsText: '{"temperature": 0.9}' },
          ],
          false,
        ),
      );
      expect(guard.canSubmit).toBe(true);

      const result = await runModelAb(
        { repository: repo, settings: SETTINGS },
        { parentRunId: parent.meta.id, arms: guard.arms, dryRun: true },
      );
      expect(result.ok).toBe(true);
      expect(result.ids).toEqual([]);
      expect(result.plan).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("臂 2 沿用父本 ⇒ 界面必须已拦；照旧放行会被内核整批拒绝（回归钉）", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parent = await createParent(traces, PURE_TOOLS, { temperature: 0.7 });
      const arms: ArmDraft[] = [
        { model: "m-1", paramsText: "" },
        { model: "deepseek-chat", paramsText: "" },
      ];

      const guard = modelAbGuard(guardInputFrom(parent, arms, false));
      expect(guard.canSubmit).toBe(false);
      expect(guard.reason).toContain("第 2 臂");
      expect(guard.arms).toEqual([]);

      // 反向证明：把界面拦下的同一批直接交给内核，确实是整批 INVALID_ARM（零文件、零调用）
      const before = readdirSync(traces).sort();
      await expect(
        runModelAb(
          { repository: repo, settings: SETTINGS },
          {
            parentRunId: parent.meta.id,
            arms: [{ model: "m-1" }, { model: "deepseek-chat" }],
            dryRun: true,
          },
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARM" });
      expect(readdirSync(traces).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("逐臂空 fork 判据与内核 sameParams 逐例对照（矩阵）", () => {
    const parentModel = "deepseek-chat";
    const parentParams = { temperature: 0.7, reasoning_effort: "none" };
    /** 与父必不相同的陪跑臂：保证判据只由被检验的那一臂决定 */
    const otherArm: ArmDraft = { model: "deepseek-chat", paramsText: '{"temperature": 0.9}' };

    const candidates: ArmDraft[] = [
      { model: "deepseek-chat", paramsText: "" },
      { model: "deepseek-chat", paramsText: "{}" },
      { model: "deepseek-chat", paramsText: '{"temperature": 0.7}' },
      { model: "deepseek-chat", paramsText: '{"reasoning_effort": "none", "temperature": 0.7}' },
      { model: "deepseek-chat", paramsText: '{"reasoning_effort": "none"}' },
      { model: "deepseek-chat", paramsText: '{"reasoning_effort": "high"}' },
      { model: "deepseek-chat", paramsText: '{"temperature": 0.71}' },
      { model: "m-x", paramsText: "" },
      { model: "m-x", paramsText: '{"reasoning_effort": "none", "temperature": 0.7}' },
    ];

    for (const candidate of candidates) {
      const parsed = parseArmParams(candidate.paramsText);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;

      // 内核判据（deriveModelParamsState）：params 缺省 = 继承父值，然后逐键比较
      const armParams = parsed.params ?? parentParams;
      const kernelSaysEmpty =
        candidate.model === parentModel && sameParams(armParams, parentParams);

      const input: ModelAbGuardInput = {
        settingsConfigured: true,
        parentModel,
        parentParams,
        riskyTools: [],
        allowSideEffects: false,
        arms: [candidate, otherArm],
      };
      const guard = modelAbGuard(input);
      expect(guard.canSubmit, `候选臂 ${JSON.stringify(candidate)}`).toBe(!kernelSaysEmpty);
      if (kernelSaysEmpty) {
        expect(guard.reason).toContain("第 1 臂");
      }
    }
  });
});

describe("guard ↔ 内核：批次级副作用确认必须展开到每臂", () => {
  it("勾选后逃生舱真的可达（修复前：只勾复选框而不下发声明 ⇒ 必被 TOOL_POLICY 拒）", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 父 run 用 sampleTools()：write_file 缺 sideEffect 标记 ⇒ 按有副作用处理
      const parent = await createParent(traces, sampleTools(), undefined);
      const arms: ArmDraft[] = [
        { model: "m-1", paramsText: "" },
        { model: "m-2", paramsText: "" },
      ];
      const input = guardInputFrom(parent, arms, false);
      expect(input.riskyTools).toEqual(["write_file"]);

      // 未勾选：界面拦，且不下发任何声明
      const blocked = modelAbGuard(input);
      expect(blocked.canSubmit).toBe(false);
      expect(blocked.reason).toContain("write_file");

      // 勾选：界面放行，且声明逐臂展开（内核判据是 arms.every(allowSideEffects === true)）
      const allowed = modelAbGuard({ ...input, allowSideEffects: true });
      expect(allowed.canSubmit).toBe(true);
      expect(allowed.arms).toHaveLength(2);
      expect(allowed.arms.every((arm) => arm.allowSideEffects === true)).toBe(true);

      // 内核据此放行（dry-run：不联网、不写文件）
      const result = await runModelAb(
        { repository: repo, settings: SETTINGS },
        { parentRunId: parent.meta.id, arms: allowed.arms, dryRun: true },
      );
      expect(result.ok).toBe(true);
      expect(result.sideEffectsAllowed).toBe(true);
      expect(result.plan).toHaveLength(2);
      expect(result.plan.every((arm) => arm.allowSideEffects)).toBe(true);

      // 反向证明：同一批但缺声明 → 内核 TOOL_POLICY 整批拒绝
      await expect(
        runModelAb(
          { repository: repo, settings: SETTINGS },
          {
            parentRunId: parent.meta.id,
            arms: [{ model: "m-1" }, { model: "m-2" }],
            dryRun: true,
          },
        ),
      ).rejects.toMatchObject({ code: "TOOL_POLICY" });
    } finally {
      cleanup();
    }
  });
});

describe("guard ↔ 内核：params 形状与保留键判据同源", () => {
  it("保留键：渲染层 parseArmParams 与内核 ModelParamsValueSchema 拒绝同一键集", () => {
    for (const key of RESERVED_BODY_KEYS) {
      const renderer = parseArmParams(`{"${key}": "x"}`);
      expect(renderer.ok, `保留键 ${key} 应被渲染层拒绝`).toBe(false);

      const kernel = ModelParamsValueSchema.safeParse({ model: "m", params: { [key]: "x" } });
      expect(kernel.success, `保留键 ${key} 应被内核拒绝`).toBe(false);
    }

    // 非保留标量两侧都放行（避免"渲染层多拦"漂移）
    const ok = parseArmParams('{"temperature": 0.7, "reasoning_effort": "none", "think": false}');
    expect(ok.ok).toBe(true);
    expect(
      ModelParamsValueSchema.safeParse({
        model: "m",
        params: { temperature: 0.7, reasoning_effort: "none", think: false },
      }).success,
    ).toBe(true);
  });

  it("父值提取：scalarRequestParams 与内核 scalarParams 逐项一致（非标量一律丢弃）", () => {
    // 真实录制只可能来自 JSONL，故用 JSON 可达取值构造
    const fixtures: unknown[] = [
      undefined,
      null,
      "不是对象",
      {},
      { temperature: 0.7 },
      { temperature: 0.7, reasoning_effort: "none", think: false },
      { nested: { a: 1 }, list: [1, 2], nil: null, keep: "x" },
      JSON.parse('{"a":1,"b":"s","c":true,"d":{"e":1},"f":[1],"g":null}'),
    ];
    for (const raw of fixtures) {
      expect(scalarRequestParams(raw), JSON.stringify(raw)).toEqual(scalarParams(raw));
    }
  });
});
