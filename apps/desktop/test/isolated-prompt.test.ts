import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  isolatedPromptEntryOf,
  isolatedPromptGuard,
  verifiedRootNavigation,
} from "../src/renderer/src/lib/isolated-prompt";
import type { RunDetail } from "../src/shared/ipc";
import { createTestTranslator } from "./i18n/render-with-locale";

const zh = createTestTranslator("zh-CN");
const en = createTestTranslator("en-US");

/**
 * R2.2 6.1：隔离 prompt 实验的桌面入口判据。
 *
 * 验收映射（desktop-ui）：
 * - 「根定位和核对有明确目标」：根/分支分流，分支只给经验证根的导航；
 * - 「system prompt 不可还原」：无字符串 system 时两种编辑都不可用，不补造；
 * - 「往返恢复正文不恢复执行许可」：入口/草稿只保存事实与文字，不产生授权。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u2-file-fixtures/iso-data/traces");

function detailOf(fileName: string): RunDetail {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, fileName));
  return {
    meta: record.meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta: record.meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const ROOT = detailOf("run_mufbxhbd_qp0ijq.jsonl");
const BRANCH = detailOf("run_mufbxhen_73kc.jsonl");

describe("isolatedPromptEntryOf：根/分支/不可用三态", () => {
  it("普通 run（无 workspace）返回 null，普通 prompt fork 路径不受影响", () => {
    const v1 = { ...ROOT, meta: { ...ROOT.meta, workspace: undefined } } as unknown as RunDetail;
    expect(isolatedPromptEntryOf(v1, zh)).toBeNull();
    expect(isolatedPromptEntryOf(null, zh)).toBeNull();
  });

  it("隔离根：给根 id 与自有首次 llm.call，不把后续调用当入口", () => {
    const entry = isolatedPromptEntryOf(ROOT, zh);
    expect(entry?.kind).toBe("root");
    if (entry?.kind !== "root") throw new Error("应为隔离根");
    expect(entry.rootId).toBe(ROOT.meta.id);
    const first = ROOT.spans.find((span) => span.kind === "llm.call");
    expect(entry.firstLlmSpanId).toBe(first?.id);
    expect(entry.firstLlm.id).toBe(entry.firstLlmSpanId);
  });

  it("隔离分支：只返回带原因的导航状态（不猜根、不把分支消息当根上下文）", () => {
    const entry = isolatedPromptEntryOf(BRANCH, zh);
    expect(entry?.kind).toBe("branch");
    if (entry?.kind !== "branch") throw new Error("应为隔离分支");
    expect(entry.reason).toContain("只能从根运行发起");
    expect(entry.reason).toContain("不会");
  });

  it("根未封存 / origin 不是 import / 缺首次 llm.call：明确不可用，不给可执行入口", () => {
    const crashed = { ...ROOT, status: "crashed" as const };
    expect(isolatedPromptEntryOf(crashed, zh)).toMatchObject({ kind: "unavailable" });

    const checkpointRoot = {
      ...ROOT,
      meta: {
        ...ROOT.meta,
        workspace: {
          ...ROOT.meta.workspace!,
          origin: { kind: "checkpoint" as const, run_id: "run_other", step_span: "s_01" },
        },
      },
    };
    expect(isolatedPromptEntryOf(checkpointRoot, zh)).toMatchObject({ kind: "unavailable" });

    const noCalls = { ...ROOT, spans: ROOT.spans.filter((span) => span.kind !== "llm.call") };
    expect(isolatedPromptEntryOf(noCalls, zh)).toMatchObject({ kind: "unavailable" });
  });
});

describe("isolatedPromptGuard：隔离实验的本地拦截", () => {
  const base = {
    field: "system_prompt" as const,
    hasSystem: true,
    hasUser: true,
    settingsConfigured: true,
    unchanged: false,
  };

  it("合法单项编辑放行", () => {
    expect(isolatedPromptGuard(base, zh)).toEqual({ canSubmit: true, reason: null });
  });

  it("无字符串 system：两种字段编辑都不可用，且明确不补造原值", () => {
    for (const field of ["system_prompt", "user_message"] as const) {
      const result = isolatedPromptGuard({ ...base, field, hasSystem: false }, zh);
      expect(result.canSubmit).toBe(false);
      expect(result.reason).toContain("system 与 user 两种编辑均不可用");
      expect(result.reason).toContain("不会用 config_hash");
    }
  });

  it("隔离实验要求 system+user 至少各一条（普通 system-only 放宽不适用于本入口）", () => {
    const result = isolatedPromptGuard({ ...base, hasUser: false }, zh);
    expect(result.canSubmit).toBe(false);
    expect(result.reason).toContain("至少包含字符串 system 与 user 各一条");
  });

  it("未配置 / 未修改：分别拦截", () => {
    expect(isolatedPromptGuard({ ...base, settingsConfigured: false }, zh).reason).toContain(
      "运行配置",
    );
    expect(isolatedPromptGuard({ ...base, unchanged: true }, zh).reason).toContain("与原值相同");
  });
});

describe("verifiedRootNavigation：只采纳经核实的根", () => {
  it("parent_not_root 且带 rootId ⇒ 导航建议；不带 rootId 不猜根", () => {
    expect(
      verifiedRootNavigation({
        ok: true,
        data: {
          status: "unavailable",
          code: "parent_not_root",
          reason: "不是根",
          rootId: "run_root_verified",
        },
      }),
    ).toEqual({ kind: "root", rootId: "run_root_verified" });

    const noRoot = verifiedRootNavigation({
      ok: true,
      data: { status: "unavailable", code: "parent_not_root", reason: "父链缺失" },
    });
    expect(noRoot.kind).toBe("blocked");
  });

  it("其他领域拒绝/信封失败原样展示原因，不给根 id", () => {
    const blocked = verifiedRootNavigation({
      ok: true,
      data: { status: "unavailable", code: "source_changed", reason: "来源已变化" },
    });
    expect(blocked).toEqual({ kind: "blocked", reason: "来源已变化" });

    const envelope = verifiedRootNavigation({
      ok: false,
      code: "SETTINGS_NOT_CONFIGURED",
      message: "未配置",
    });
    expect(envelope).toEqual({ kind: "blocked", reason: "SETTINGS_NOT_CONFIGURED：未配置" });
  });
});

describe("2.7 英文独立期望：隔离入口原因按语言输出", () => {
  it("分支入口原因不是中文硬编码，且保留导航语义", () => {
    const entry = isolatedPromptEntryOf(BRANCH, en);
    expect(entry?.kind).toBe("branch");
    if (entry?.kind === "branch") {
      expect(entry.reason).toContain("isolated branch");
      expect(entry.reason).not.toContain("隔离分支");
    }
  });
});
