import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuxWorkspaceFrame } from "../src/renderer/src/components/AuxWorkspaceFrame";
import { type AuxReturnLocation, decideAuxReturn } from "../src/renderer/src/lib/aux-workspace";
import {
  type CreateReturnLocation,
  decideCreateReturn,
  describeReturnDestination,
  describeReturnFallbackReason,
  workspaceViewName,
} from "../src/renderer/src/lib/create-workspace";

/**
 * refine-ui-for-community-release 任务 2.3：一致来源摘要与具体返回文案。
 *
 * 判据来源：delta ADDED「当前任务身份与返回目的地明确」——
 *   - 「返回入口 SHALL 使用可读目的地说明」（D2：返回运行概览／比较／编辑等实际目的地）；
 *   - 场景「返回来源失效可辨」：显示真实原因和可达退路，不声称已返回原调用，
 *     不跳到同名或邻近记录；
 *   - 场景「编辑对象与设置往返保持」：返回入口说明实际目的地。
 *
 * 判据全部复用既有 decideCreateReturn / decideAuxReturn（运行事实核对不抄第二份）；
 * 本模块只新增**文案派生**（describeReturnDestination / describeReturnFallbackReason）
 * 与外壳呈现（AuxWorkspaceFrame 的失效就近原因 + 退路按钮）。
 */

const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

describe("workspaceViewName：视图的面向用户名称（与 2.1 术语同源）", () => {
  it("七个视图全覆盖，trace/tree 用「运行记录／分支关系」", () => {
    expect(workspaceViewName("trace")).toBe("运行记录");
    expect(workspaceViewName("tree")).toBe("分支关系");
    expect(workspaceViewName("create")).toBe("新建运行");
    expect(workspaceViewName("compare")).toBe("比较");
    expect(workspaceViewName("recording")).toBe("录制");
    expect(workspaceViewName("experiment")).toBe("模型实验");
    expect(workspaceViewName("messages")).toBe("编辑 messages");
  });
});

describe("describeReturnDestination：返回入口的实际目的地（N02/D2）", () => {
  const loc = (over: Partial<CreateReturnLocation>): CreateReturnLocation => ({
    view: "trace",
    runId: "r_1",
    tab: null,
    spanId: null,
    file: null,
    ...over,
  });

  it("运行记录视图按页签可辨：概览／调用步骤／文件", () => {
    expect(describeReturnDestination(loc({ view: "trace", tab: "overview" }))).toBe(
      "返回运行记录 · 概览",
    );
    expect(describeReturnDestination(loc({ view: "trace", tab: "steps" }))).toBe(
      "返回运行记录 · 调用步骤",
    );
    expect(describeReturnDestination(loc({ view: "trace", tab: "files" }))).toBe(
      "返回运行记录 · 文件",
    );
  });

  it("无页签 ⇒ 只说视图；其他视图本身就是目的地", () => {
    expect(describeReturnDestination(loc({ view: "trace", tab: null }))).toBe("返回运行记录");
    expect(describeReturnDestination(loc({ view: "compare", tab: null }))).toBe("返回比较");
    expect(describeReturnDestination(loc({ view: "tree", tab: null }))).toBe("返回分支关系");
    expect(describeReturnDestination(loc({ view: "recording", tab: null }))).toBe("返回录制");
    expect(describeReturnDestination(loc({ view: "experiment", tab: null }))).toBe("返回模型实验");
    expect(describeReturnDestination(loc({ view: "messages", tab: null }))).toBe(
      "返回编辑 messages",
    );
  });

  it("不冒充算不出的粒度：文案里没有未验证的「第 N 轮」", () => {
    for (const tab of ["overview", "steps", "files", null] as const) {
      expect(describeReturnDestination(loc({ tab }))).not.toMatch(/第 \d+ 轮/);
    }
  });
});

describe("describeReturnFallbackReason：失效原因的真实文案（N03）", () => {
  it("no-location / run-missing 各有真实原因，不说成能返回", () => {
    expect(describeReturnFallbackReason("no-location")).toContain("没有记录来源位置");
    expect(describeReturnFallbackReason("run-missing")).toContain("已不在列表");
  });
});

describe("AuxWorkspaceFrame：失效就近呈现 + 诚实退路（N03）", () => {
  const frame = (props: {
    returnAvailable: boolean;
    returnLabel?: string;
    returnFallback?: { reason: "no-location" | "run-missing"; fallbackView: "trace" } | null;
  }): string =>
    renderToStaticMarkup(
      createElement(
        AuxWorkspaceFrame,
        {
          title: "模型实验",
          description: "说明",
          ...props,
          onReturn: () => {},
        },
        createElement("div", null, "正文"),
      ),
    );

  it("restore：按钮文案就是实际目的地", () => {
    const html = frame({ returnAvailable: true, returnLabel: "返回运行记录 · 概览" });
    expect(html).toContain("返回运行记录 · 概览");
    expect(html).toContain('aria-label="返回运行记录 · 概览"');
    expect(html).not.toContain("disabled");
  });

  it("fallback：就近原因文字 + 可用的「回到运行记录」退路（不是禁用的假入口）", () => {
    const html = frame({
      returnAvailable: false,
      returnFallback: { reason: "run-missing", fallbackView: "trace" },
    });
    expect(html).toContain("来源运行已不在列表里");
    expect(html).toContain("回到运行记录");
    expect(html).not.toContain("disabled");
  });

  it("缺省文案形态（returnAvailable=true 无 label）保持「返回来源」", () => {
    const html = frame({ returnAvailable: true });
    expect(html).toContain('aria-label="返回来源"');
  });

  it("未给 fallback 的旧形态保持禁用按钮 + 原因在 title（兼容录制旧路径）", () => {
    const html = frame({ returnAvailable: false });
    expect(html).toMatch(/aria-label="返回来源"[^>]*disabled=""/);
    expect(html).toContain("没有记录来源位置");
  });
});

describe("容器接线：三个辅助工作区与创建页共用同一批判据（源码契约）", () => {
  it("实验 / messages / 录制容器都走 decideAuxReturn + describeReturnDestination", () => {
    for (const name of [
      "ExperimentWorkspace.tsx",
      "MessagesWorkspace.tsx",
      "RecordingWorkspace.tsx",
    ]) {
      const src = read(`../src/renderer/src/components/${name}`);
      expect(src, name).toContain("decideAuxReturn({");
      expect(src, name).toContain("describeReturnDestination(");
      // 失效分流语义在场：restore 显目的地，fallback 显原因+退路
      expect(src, name).toContain('kind === "restore"');
      expect(src, name).toContain('kind === "fallback"');
    }
  });

  it("创建页容器不自算：返回文案走 store 派生 createReturnFactsOf（接线纪律）", () => {
    const src = read("../src/renderer/src/components/CreateRunWorkspace.tsx");
    // 组件不读来源引用、不实现判据——判据归 lib，派生归 store
    expect(src).not.toContain("createReturnLocation");
    expect(src).not.toContain("decideCreateReturn");
    expect(src).toContain("createReturnFactsOf");
    expect(src).toContain("returnLabel={returnLabel}");
    expect(src).toContain("returnReasonText={returnReasonText}");
    // store 是唯一派生点：同一 decideCreateReturn 事实喂返回动作与呈现文案
    const store = read("../src/renderer/src/store.ts");
    expect(store).toContain("createReturnFactsOf");
    expect(store).toContain("describeReturnDestination(decision.location)");
    expect(store).toContain("describeReturnFallbackReason(decision.reason)");
  });
});

describe("判据复用：decideAuxReturn / decideCreateReturn 的 fallback 语义回归（既有判据钉住）", () => {
  const auxLoc = (over: Partial<AuxReturnLocation>): AuxReturnLocation => ({
    view: "trace",
    runId: "r_1",
    tab: null,
    spanId: null,
    file: null,
    ...over,
  });

  it("run-missing 时 fallback.view 跟随来源视图（退路如实，不偷偷换页）", () => {
    const decision = decideAuxReturn({
      location: auxLoc({ view: "compare", runId: "r_gone" }),
      knownRunIds: ["r_other"],
    });
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.reason).toBe("run-missing");
      expect(decision.view).toBe("compare");
    }
  });

  it("no-location ⇒ 退路 trace（store 既有口径不变）", () => {
    const decision = decideAuxReturn({ location: null, knownRunIds: ["r_1"] });
    expect(decision).toEqual({ kind: "fallback", view: "trace", reason: "no-location" });
  });

  it("decideCreateReturn：来源 run 在列表 ⇒ restore（既有判据原样）", () => {
    const decision = decideCreateReturn({
      location: auxLoc({ runId: "r_1", tab: "overview" }),
      knownRunIds: ["r_1"],
    });
    expect(decision.kind).toBe("restore");
  });
});
