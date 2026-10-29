import { describe, expect, it } from "vitest";

const zh = createTestTranslator("zh-CN");
const en = createTestTranslator("en-US");
import {
  type IsolatedPromptCapabilitySuccess,
  isolatedPromptCapabilityRequestOf,
  presentIsolatedPromptCard,
  resolveIsolatedPromptSubmission,
} from "../src/renderer/src/lib/isolated-prompt-card";
import { createTestTranslator } from "./i18n/render-with-locale";

/**
 * R2.2 6.2：隔离 prompt 核对卡与提交判据（纯逻辑）。
 *
 * 验收映射（desktop-ui）：
 * - 「单份确认表达实际条件与未知」：根/初始文件/固定工具/基线模型/当前端点/历史未知/计费；
 * - 「修改或配置变化撤销旧许可」：核对结论、费用确认、副本授权绑定当前现场；
 * - 「编辑前确认真实计费」：usage/价格/缓存执行前未知，不用 0 冒充。
 */

const CAPABILITY: IsolatedPromptCapabilitySuccess = {
  status: "ok",
  rootId: "run_root",
  baselineLlmSpanId: "s_first",
  initialSnapshotId: "a".repeat(64),
  fileCount: 3,
  totalBytes: 2048,
  originalValue: "旧的启动指令",
  editedValue: "新的启动指令",
  systemPrompt: "旧的启动指令",
  messages: [
    { role: "system", content: "旧的启动指令" },
    { role: "user", content: "读配置文件" },
  ],
  execution: {
    model: "baseline-model",
    providerEndpoint: "https://api.example.com/v1",
    maxIterations: 12,
    budget: { maxTotalTokens: 50000 },
    tokenBudgetSource: "recorded",
    historicalUnknowns: ["provider_backend", "max_iterations"],
  },
  configHash: "sha256:config",
  planFingerprint: "plan-fingerprint",
  configRevision: "config-revision",
  billing: { usage: "unknown_until_execution", price: "unknown", cache: "unknown" },
};

const BASE_INPUT = {
  rootRunId: "run_root",
  edit: { field: "system_prompt" as const, value: "新的启动指令" },
  originalValue: "旧的启动指令",
  hypothesis: "多读一次配置",
  acceptanceCriterion: "",
  capability: CAPABILITY,
  capabilityFresh: true,
  feeConfirmed: true,
  writesAuthorized: true,
  checking: false,
  inProgress: false,
  gateBlockedReason: null,
  guardCanSubmit: true,
  guardReason: null,
};

describe("presentIsolatedPromptCard：实际条件与未知项分列", () => {
  it("根/初始文件/固定工具/基线模型/端点/上限/计费都在卡上", () => {
    const card = presentIsolatedPromptCard(CAPABILITY, ["read_file", "write_file"], zh);
    const row = (label: string): string =>
      card.rows.find((item) => item.label === label)?.value ?? "";
    expect(row("根运行")).toBe("run_root");
    expect(row("初始文件")).toContain("3 个");
    expect(row("固定工具")).toContain("read_file、write_file");
    expect(row("基线模型（根首次请求）")).toBe("baseline-model");
    expect(row("本次端点")).toBe("https://api.example.com/v1");
    expect(row("执行上限")).toContain("12 轮");
    expect(row("token 预算")).toContain("50000 tokens（根录制值）");
    expect(row("编辑")).toContain("6 字 → 6 字");
    expect(card.summary).toContain("真实模型调用并计费");
    expect(card.billing).toContain("执行前未知");
    expect(card.billing).not.toContain("0");
  });

  it("历史未录制条件单独成行，不把当前设置说成历史一致", () => {
    const card = presentIsolatedPromptCard(CAPABILITY, [], zh);
    expect(card.unknowns).toHaveLength(2);
    expect(card.unknowns[0]).toContain("服务端实际后端/版本未录制");
    expect(card.unknowns[1]).toContain("历史迭代上限未录制");
    expect(card.rows.find((item) => item.label === "历史未知条件")?.value).toContain(
      "服务端实际后端",
    );
  });

  it("params 缺省与显式空对象分开表达", () => {
    const absent = presentIsolatedPromptCard(
      { ...CAPABILITY, execution: { ...CAPABILITY.execution, params: undefined } },
      [],
      zh,
    );
    const empty = presentIsolatedPromptCard(
      { ...CAPABILITY, execution: { ...CAPABILITY.execution, params: {} } },
      [],
      zh,
    );
    expect(absent.rows.find((row) => row.label === "根参数")?.value).toContain("缺省");
    expect(empty.rows.find((row) => row.label === "根参数")?.value).toContain("显式空对象");
  });

  it("根首次请求未录制工具表时如实说明，不伪造工具名", () => {
    const card = presentIsolatedPromptCard(CAPABILITY, [], zh);
    expect(card.rows.find((row) => row.label === "固定工具")?.value).toContain("未录制工具表");
  });
});

describe("请求构造：只带允许的字段", () => {
  it("空假设/判据省略；非空原样携带", () => {
    expect(
      isolatedPromptCapabilityRequestOf({
        rootRunId: "run_root",
        edit: { field: "system_prompt", value: "x" },
        hypothesis: "",
        acceptanceCriterion: "",
      }),
    ).toEqual({ rootRunId: "run_root", edit: { field: "system_prompt", value: "x" } });

    expect(
      isolatedPromptCapabilityRequestOf({
        rootRunId: "run_root",
        edit: { field: "user_message", value: "y" },
        hypothesis: "h",
        acceptanceCriterion: "c",
      }),
    ).toMatchObject({ hypothesis: "h", acceptanceCriterion: "c" });
  });

  it("提交请求包含模式/计划指纹/配置修订/本次授权，不含模型或路径", () => {
    const submission = resolveIsolatedPromptSubmission(BASE_INPUT, zh);
    expect(submission.ok).toBe(true);
    if (!submission.ok) throw new Error("应为可提交");
    expect(submission.request).toEqual({
      executionMode: "isolated",
      parentRunId: "run_root",
      edit: { field: "system_prompt", value: "新的启动指令" },
      allowFileWrites: true,
      expectedConfigRevision: "config-revision",
      expectedPlanFingerprint: "plan-fingerprint",
      hypothesis: "多读一次配置",
    });
    expect(JSON.stringify(submission.request)).not.toContain("baseline-model");
    expect(JSON.stringify(submission.request)).not.toContain("api.example.com");
  });
});

describe("resolveIsolatedPromptSubmission：逐条撤销与拦截", () => {
  const rejected = (patch: Record<string, unknown>): string => {
    const result = resolveIsolatedPromptSubmission({ ...BASE_INPUT, ...patch } as never, zh);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.reason;
  };

  it("未核对/核对失效/结论与当前正文不一致 ⇒ 拒绝", () => {
    expect(rejected({ capability: null })).toContain("核对本次运行");
    expect(rejected({ capabilityFresh: false })).toContain("核对本次运行");
    expect(rejected({ capability: { ...CAPABILITY, editedValue: "另一个值" } })).toContain(
      "不一致",
    );
  });

  it("费用确认与副本授权默认未选，各自缺失都拒绝", () => {
    expect(rejected({ feeConfirmed: false })).toContain("真实调用模型并计费");
    expect(rejected({ writesAuthorized: false })).toContain("允许本次副本写入");
  });

  it("本地字段判据 / 执行槽 / 进行中分别拦截", () => {
    expect(rejected({ guardCanSubmit: false, guardReason: "缺少 user 消息" })).toContain(
      "缺少 user 消息",
    );
    expect(rejected({ gateBlockedReason: "已有操作正在执行" })).toContain("已有操作");
    expect(rejected({ checking: true })).toContain("正在核对");
    expect(rejected({ inProgress: true })).toContain("提交进行中");
  });
});

describe("2.7 英文独立期望：核对卡与提交原因按语言输出", () => {
  it("核对卡标签/未知项/计费说明为英文，未知项不丢失", () => {
    const card = presentIsolatedPromptCard(CAPABILITY, ["read_file", "write_file"], en);
    const labels = card.rows.map((row) => row.label);
    expect(labels).toContain("Root run");
    expect(labels).toContain("Historical unknowns");
    expect(card.summary).toContain("Rerun from the initial files of root");
    expect(card.billing).toContain("Real model calls are billed");
    expect(card.unknowns.some((text) => text.includes("server backend"))).toBe(true);
    expect(labels).not.toContain("根运行");
  });

  it("缺费用确认/副本授权的原因按语言输出", () => {
    const noFee = resolveIsolatedPromptSubmission({ ...BASE_INPUT, feeConfirmed: false }, en);
    expect(noFee.ok).toBe(false);
    if (!noFee.ok) expect(noFee.reason).toContain("Confirm that this rerun from the start");

    const noWrites = resolveIsolatedPromptSubmission(
      { ...BASE_INPUT, writesAuthorized: false },
      en,
    );
    if (!noWrites.ok) expect(noWrites.reason).toContain("Allow copy writes for this execution");
  });
});
