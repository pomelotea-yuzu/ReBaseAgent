import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Disclosure, DisclosureButton } from "../src/renderer/src/components/Disclosure";

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 1.1/1.2/1.3：
 * 统一折叠控制的静态断言。
 *
 * 判据来源：desktop-ui delta 场景「键盘折叠显示当前状态」与「列表和步骤控制可发现
 * 且可恢复」——控制 SHALL 使用可辨文字/方向、与实际状态一致的 aria-expanded、
 * 至少 28 CSS px 命中区、可见焦点。本包无 jsdom ⇒ renderToStaticMarkup 只能做
 * 静态结构断言；键盘焦点流转与实机命中区归任务 4.3。
 *
 * ⚠️ 判据钉的是**结构与接线**（类名/属性由共享组件单点产生），不是某个具体文案：
 *    文案变了能力还在 ⇒ 不算违规；结构缺了（无 aria-expanded / 无命中区类）才算。
 */

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

describe("DisclosureButton：结构与可访问语义", () => {
  it("aria-expanded 与传入状态一致（true/false 都显式输出，不吃默认值）", () => {
    const on = html(
      createElement(DisclosureButton, {
        expanded: true,
        onToggle: () => {},
        label: "收起运行列表",
      }),
    );
    const off = html(
      createElement(DisclosureButton, {
        expanded: false,
        onToggle: () => {},
        label: "展开运行列表",
      }),
    );
    expect(on).toContain('aria-expanded="true"');
    expect(off).toContain('aria-expanded="false"');
  });

  it("aria-controls 透传（调用方保证受控区域 id 存在）", () => {
    const out = html(
      createElement(DisclosureButton, {
        expanded: true,
        onToggle: () => {},
        label: "收起运行列表",
        controls: "run-navigation",
      }),
    );
    expect(out).toContain('aria-controls="run-navigation"');
  });

  it("可访问名称来自 label（动作短语），可见内容与名称可不同（标题行形态）", () => {
    const out = html(
      createElement(
        DisclosureButton,
        { expanded: true, onToggle: () => {}, label: "收起运行列表" },
        createElement("span", null, "运行记录"),
      ),
    );
    expect(out).toContain('aria-label="收起运行列表"');
    expect(out).toContain("运行记录");
  });

  it("命中区至少 28 CSS px 且焦点可见（共享类单点产生）", () => {
    const out = html(
      createElement(DisclosureButton, {
        expanded: false,
        onToggle: () => {},
        label: "展开",
      }),
    );
    expect(out).toContain("min-h-[28px]");
    expect(out).toContain("focus-visible:ring-2");
  });

  it("方向箭头与状态一致：收起朝右（-rotate-90）、展开朝下（无旋转）", () => {
    const expanded = html(
      createElement(DisclosureButton, { expanded: true, onToggle: () => {}, label: "收起" }),
    );
    const collapsed = html(
      createElement(DisclosureButton, { expanded: false, onToggle: () => {}, label: "展开" }),
    );
    expect(expanded).not.toContain("-rotate-90");
    expect(collapsed).toContain("-rotate-90");
  });
});

describe("Disclosure：摘要行 + 受控内容块", () => {
  it("收起时不渲染内容（完整原文在数据层，展开即取；不是 CSS 隐藏半成品）", () => {
    const out = html(
      createElement(
        Disclosure,
        {
          summary: "来源与技术详情",
          meta: "隔离文件运行 · 摘要",
          expanded: false,
          onToggle: () => {},
          controlsId: "notice-x",
        },
        createElement("div", null, "完整保真边界正文"),
      ),
    );
    expect(out).toContain("来源与技术详情");
    expect(out).toContain("隔离文件运行 · 摘要");
    expect(out).toContain("展开");
    expect(out).not.toContain("完整保真边界正文");
    expect(out).toContain('aria-expanded="false"');
  });

  it("展开时渲染内容且内容区 id 与 aria-controls 对上（唯一 aria-controls）", () => {
    const out = html(
      createElement(
        Disclosure,
        {
          summary: "来源与技术详情",
          meta: "摘要",
          expanded: true,
          onToggle: () => {},
          controlsId: "notice-x",
        },
        createElement("div", null, "完整保真边界正文"),
      ),
    );
    expect(out).toContain("完整保真边界正文");
    expect(out).toContain('aria-controls="notice-x"');
    expect(out).toContain('id="notice-x"');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain("收起");
  });

  it("动作文字可定制（比较证据用「展开/收起」，也可换措辞）", () => {
    const out = html(
      createElement(
        Disclosure,
        {
          summary: "修改证据",
          meta: "字段 message",
          expanded: false,
          onToggle: () => {},
          controlsId: "evidence",
          openLabel: "展开",
        },
        createElement("div", null, "body"),
      ),
    );
    expect(out).toContain("展开");
    expect(out).toContain("字段 message");
  });
});
