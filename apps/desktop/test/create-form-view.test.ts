import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * U5（unify-run-execution-workflow）任务 4.2：创建页的**布置与就近字段错误**。
 *
 * 判据来源：design D1/D2/D8 + delta「桌面端提供原生 run 创建入口」。四条验收场景里
 * 「userMessage 为空时禁用提交」「空 systemPrompt 允许」「settings 未配置时拒绝」的
 * **判据本身**打在 `lib/create-run.ts`（见 `create-run-dialog.test.ts`），本文件打的是
 * 它们**落到哪个位置**：错误跟着字段走、两模式都有接入摘要与可点的配置入口、
 * 执行范围与"一次真实模型调用"就地可读。
 *
 * ⚠️ 与 `create-form-draft.test.ts` 的分工：那份钉容器怎么读写草稿与锁位（源码级），
 * 本份钉视图给不给得出能力（喂 props 的 `renderToStaticMarkup`）。
 * 文案在、按钮也在，但 `disabled` 与 `aria-describedby` 没接上 —— 只有本份抓得到。
 */

// 组件经容器 import store → lib/api.ts 在**模块级**读 window.api ⇒ 桩必须先就位，
// 所以被测模块一律动态 import（本包无 jsdom）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { CreateRunWorkspaceView } = await import(
  "../src/renderer/src/components/CreateRunWorkspace"
);
import type {
  CreateRunFormViewProps,
  CreateRunLock,
} from "../src/renderer/src/components/CreateRunWorkspace";
const {
  CREATE_RUN_MODE_LABELS,
  ISOLATED_TOOL_PROFILE_LABEL,
  fieldErrorsOf,
  resolveCreateRunSubmission,
} = await import("../src/renderer/src/lib/create-run");
import type { CreateRunFieldErrors } from "../src/renderer/src/lib/create-run";

const NO_ERRORS: CreateRunFieldErrors = {
  userMessage: null,
  source: null,
  writesAuthorized: null,
  form: null,
};

const IDLE_LOCK: CreateRunLock = {
  fields: false,
  draftFrozen: false,
  busy: false,
  pickingSource: false,
  canSubmit: true,
  canDiscard: false,
};

function props(over: Partial<CreateRunFormViewProps> = {}): CreateRunFormViewProps {
  return {
    mode: "chat",
    userMessage: "用一句话解释时间旅行调试",
    systemPrompt: "",
    source: null,
    writesAuthorized: false,
    advancedOpen: false,
    errors: NO_ERRORS,
    settingsSummary: "当前模型 deepseek-chat（https://api.deepseek.com/v1）",
    settingsMissing: false,
    scopeFacts: { execution: "纯对话：空工具表", cost: "一次提交 = 一次真实模型调用。" },
    confirmation: {
      ready: true,
      summary: "纯对话 · 一次真实模型调用（按实际用量计费）",
      rows: [{ label: "任务（User Message）", value: "用一句话解释时间旅行调试" }],
      blocked: null,
    },
    lock: IDLE_LOCK,
    headingRef: { current: null },
    onMode: () => {},
    onUserMessage: () => {},
    onSystemPrompt: () => {},
    onPickSource: () => {},
    onWrites: () => {},
    onToggleAdvanced: () => {},
    onOpenSettings: () => {},
    onConfirm: () => {},
    onDiscard: () => {},
    onSubmit: () => {},
    onReturn: () => {},
    ...over,
  };
}

const html = (over: Partial<CreateRunFormViewProps> = {}): string =>
  renderToStaticMarkup(createElement(CreateRunWorkspaceView, props(over)));

describe("4.2 就近字段错误：给得出、接得上，没给就什么都不渲染", () => {
  it("userMessage 有拒绝 ⇒ 文本出现，且 textarea 用 describedby + aria-invalid 指向它", () => {
    const markup = html({
      errors: { ...NO_ERRORS, userMessage: "User Message 不能为空（它同时是该 run 的标题）" },
    });
    expect(markup).toContain("User Message 不能为空");
    expect(markup).toContain('aria-describedby="create-user-message-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('id="create-user-message-error"');
  });

  it("对照：没有拒绝 ⇒ 既无错误文本也无锚点（不是恒挂一条空提示）", () => {
    const markup = html();
    expect(markup).not.toContain("create-user-message-error");
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it("隔离目录与副本授权的错误各归各的控件；纯对话模式下两个槽都不存在", () => {
    const isolated = html({
      mode: "isolated_files",
      errors: {
        ...NO_ERRORS,
        source: "隔离文件运行需要先选择源目录",
        writesAuthorized: "请勾选允许本次执行的副本写入",
      },
    });
    expect(isolated).toContain("隔离文件运行需要先选择源目录");
    expect(isolated).toContain('id="create-source-error"');
    expect(isolated).toContain('id="create-writes-error"');
    // 授权复选框被接到自己的错误上（不是靠上方一条横幅说明）
    expect(isolated).toContain('aria-describedby="create-writes-error"');

    // 纯对话根本没有"目录/授权"这两个问题可报 ⇒ 隔离块整体不渲染
    const chat = html({
      errors: { ...NO_ERRORS, source: "隔离文件运行需要先选择源目录" },
    });
    expect(chat).not.toContain("create-source-error");
    expect(chat).not.toContain("create-writes-error");
  });

  it("表单级说明只收「不属于任何字段」的拒绝；执行中由进行条承接", () => {
    expect(html({ errors: { ...NO_ERRORS, form: "上一个操作仍在执行中" } })).toContain(
      "上一个操作仍在执行中",
    );
    // busy 时不再重复挂一条说明，改由进行条表达
    const busy = html({
      errors: { ...NO_ERRORS, form: "执行中：本次运行尚未结束" },
      lock: { ...IDLE_LOCK, fields: true, busy: true, canSubmit: false },
    });
    expect(busy).not.toContain("执行中：本次运行尚未结束");
    expect(busy).toContain("本次创建仍在进行中");
  });
});

describe("4.2 两模式共用的接入摘要、配置入口与执行范围", () => {
  it("两种模式都显示当前接入摘要，且都带可点的「运行配置」入口", () => {
    for (const mode of ["chat", "isolated_files"] as const) {
      const markup = html({ mode });
      expect(markup).toContain("当前接入：");
      expect(markup).toContain("deepseek-chat");
      expect(markup).toContain("<button");
      expect(markup).toContain("data-open-settings");
    }
  });

  it("未配置时摘要照给（拒绝理由是就近的，不是全局栏里才有）", () => {
    const markup = html({
      settingsSummary: "尚未配置运行参数：提交会被拒绝（SETTINGS_NOT_CONFIGURED）",
      settingsMissing: true,
    });
    expect(markup).toContain("SETTINGS_NOT_CONFIGURED");
    expect(markup).toContain("data-open-settings");
  });

  it("执行范围与计费事实就地可读，且随模式换内容", () => {
    const chat = html();
    expect(chat).toContain("执行范围：");
    expect(chat).toContain("空工具表");
    expect(chat).toContain("一次真实模型调用");
    const isolated = html({
      mode: "isolated_files",
      scopeFacts: {
        execution: `隔离文件运行：按固定 ${ISOLATED_TOOL_PROFILE_LABEL} 工具组执行`,
        cost: "一次提交 = 一次真实模型调用，采集到的文本会进入模型请求。",
      },
    });
    expect(isolated).toContain(ISOLATED_TOOL_PROFILE_LABEL);
    expect(isolated).toContain("采集到的文本会进入模型请求");
  });

  it("模式分段控件用标签文字（不靠悬停猜）", () => {
    const markup = html();
    expect(markup).toContain(CREATE_RUN_MODE_LABELS.chat);
    expect(markup).toContain(CREATE_RUN_MODE_LABELS.isolated_files);
    expect(markup).toContain('aria-pressed="true"');
  });
});

/** 取出某个控件自己的开标签（判 disabled 只能按属性判：类名里有 `disabled:` 变体） */
function tagOf(markup: string, idAttribute: string): string {
  const at = markup.indexOf(idAttribute);
  expect(at).toBeGreaterThan(-1);
  const start = Math.max(markup.lastIndexOf("<textarea", at), markup.lastIndexOf("<input", at));
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf(">", at));
}

describe("4.2 锁位与可操作性：disabled 真的落到控件上", () => {
  it("待定提交冻结 ⇒ 两段文本与模式分段都不可改，并给出处置说明", () => {
    const markup = html({
      advancedOpen: true,
      lock: { ...IDLE_LOCK, fields: true, draftFrozen: true, busy: true, canSubmit: false },
    });
    expect(markup).toContain("本次提交待处理");
    // **逐控件**判属性（只看"整页有几处 disabled"会被别的按钮凑数，类名里的
    // `disabled:` 变体也会误伤 ⇒ 一律认 `disabled=""` 这个 React 的真实输出）
    for (const id of ['id="create-user-message"', 'id="create-system-prompt"']) {
      expect(tagOf(markup, id), id).toContain('disabled=""');
    }
    expect(markup).toMatch(/disabled=""[^>]*>纯对话<\/button>/);
  });

  it("对照：未冻结时两段文本都可编辑（禁用不是恒挂着的装饰）", () => {
    const markup = html({ advancedOpen: true });
    for (const id of ['id="create-user-message"', 'id="create-system-prompt"']) {
      expect(tagOf(markup, id), id).not.toContain('disabled=""');
    }
  });

  it("未选目录时无可授权对象 ⇒ 复选框禁用（不是靠文案提醒）", () => {
    const markup = html({ mode: "isolated_files", source: null });
    const tag = markup.slice(markup.indexOf("<input"));
    expect(tag.slice(0, tag.indexOf(">"))).toContain('type="checkbox"');
    expect(tag.slice(0, tag.indexOf(">"))).toContain('disabled=""');
    // 对照：选了目录（但未勾选）⇒ 复选框可用，拒绝只作为授权槽的错误存在
    const chosen = html({
      mode: "isolated_files",
      source: { token: "tok_1", name: "src", path: "D:\\lab\\src" },
      errors: {
        userMessage: null,
        source: null,
        writesAuthorized: "请勾选允许本次执行的副本写入",
        form: null,
      },
    });
    const chosenTag = chosen.slice(chosen.indexOf("<input"));
    expect(chosenTag.slice(0, chosenTag.indexOf(">"))).not.toContain('disabled=""');
    expect(chosen).toContain('aria-describedby="create-writes-error"');
  });

  it("不可提交时按钮 disabled，且文案区分进行中 / 两种模式", () => {
    const blocked = html({ lock: { ...IDLE_LOCK, canSubmit: false } });
    // disabled 落在同一个 <button> 的开标签里；类名里也有 `disabled:` 变体 ⇒ 必须认属性本身
    expect(blocked).toMatch(/disabled=""[^>]*>创建<\/button>/);
    expect(
      html({
        mode: "isolated_files",
        lock: { ...IDLE_LOCK, busy: true, fields: true, canSubmit: false },
      }),
    ).toMatch(/disabled=""[^>]*>创建中…<\/button>/);
    // 对照：可提交时那条属性不存在
    expect(html()).not.toMatch(/disabled=""[^>]*>创建<\/button>/);
  });

  it("无可放弃内容 ⇒ 放弃入口禁用并说明原因；有内容才可点", () => {
    const empty = html();
    expect(empty).toContain("尚无修改可放弃");
    const dirty = html({ lock: { ...IDLE_LOCK, canDiscard: true } });
    expect(dirty).not.toContain("尚无修改可放弃");
  });

  it("高级区收起时不渲染 System Prompt 输入，展开时渲染并标注 expanded", () => {
    expect(html()).not.toContain('id="create-system-prompt"');
    const opened = html({ advancedOpen: true });
    expect(opened).toContain('id="create-system-prompt"');
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain("留空也可以");
  });
});

describe("4.4 创建页的核对与确认：未确认就没有提交这条路", () => {
  /** 取确认按钮自己的开标签（判 disabled 只认属性，理由同 `tagOf`） */
  function confirmTag(markup: string): string {
    const at = markup.indexOf("data-confirm-execution");
    expect(at).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf("<button", at), markup.indexOf(">", at) + 1);
  }

  it("收起态：关键摘要常驻可见、详细边界默认收起、确认按钮可点、提交仍被挡住", () => {
    const markup = html({
      confirmation: {
        ready: false,
        summary: "纯对话 · 一次真实模型调用（按实际用量计费）",
        rows: [
          { label: "任务（User Message）", value: "解释一下时间旅行调试" },
          { label: "已做的检查", value: "本地字段检查：必填项、模式与授权条件" },
          { label: "本次边界", value: "没有独立的模型连通性预检" },
        ],
        blocked: null,
      },
      lock: { ...IDLE_LOCK, canSubmit: false },
    });
    // 收起态唯一的内容行是关键摘要（3.1：费用/模式边界摘要与详情，摘要这半边）
    expect(markup).toContain("data-confirm-summary");
    expect(markup).toContain("一次真实模型调用（按实际用量计费）");
    // 详细边界默认收起：Disclosure 摘要行在（aria-expanded=false），全表不在标记里
    expect(markup).toContain("详细边界");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("本地字段检查");
    expect(markup).not.toContain("没有独立的模型连通性预检");
    expect(markup).toContain("已核对，确认本次提交");
    expect(confirmTag(markup)).not.toContain('disabled=""');
    expect(markup).toMatch(/disabled=""[^>]*>创建<\/button>/);
  });

  it("详细边界全表接的是 props.rows（静态渲染测不到展开态，接线在源码级钉住）", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
      "utf8",
    );
    expect(src).toContain("rows={props.confirmation.rows}");
  });

  it("已确认 ⇒ 确认按钮变状态标识且不可重复点，提交才可能放行", () => {
    const markup = html({
      confirmation: {
        ready: true,
        summary: "纯对话 · 一次真实模型调用（按实际用量计费）",
        rows: [{ label: "任务", value: "t" }],
        blocked: null,
      },
    });
    expect(markup).toContain("已确认本次提交");
    expect(markup).toContain('aria-pressed="true"');
    expect(confirmTag(markup)).toContain('disabled=""');
  });

  it("还不能确认 ⇒ 就近给出原因（不是只把按钮禁掉）", () => {
    const markup = html({
      confirmation: {
        ready: false,
        summary: "纯对话 · 一次真实模型调用（按实际用量计费）",
        rows: [{ label: "任务", value: "t" }],
        blocked: "先补齐必填输入，再核对本次提交",
      },
    });
    expect(markup).toContain("先补齐必填输入，再核对本次提交");
    expect(confirmTag(markup)).toContain('disabled=""');
  });
});

describe("4.2 就近归属来自同一份提交判据（组件不重算）", () => {
  it("fieldErrorsOf 把拒绝送到它自己的槽，其余留空", () => {
    const blank = { userMessage: null, source: null, writesAuthorized: null, form: null };
    expect(
      fieldErrorsOf(
        resolveCreateRunSubmission(
          { mode: "chat", source: null, writesAuthorized: false },
          { systemPrompt: "", userMessage: "  ", busy: false },
        ),
      ),
    ).toEqual({
      ...blank,
      userMessage: "User Message 不能为空（它同时是该 run 的标题与首条用户消息）",
    });
    expect(
      fieldErrorsOf(
        resolveCreateRunSubmission(
          { mode: "isolated_files", source: null, writesAuthorized: false },
          { systemPrompt: "", userMessage: "任务", busy: false },
        ),
      ).source,
    ).not.toBeNull();
    expect(
      fieldErrorsOf(
        resolveCreateRunSubmission(
          { mode: "chat", source: null, writesAuthorized: false },
          { systemPrompt: "", userMessage: "任务", busy: true },
        ),
      ),
    ).toEqual({ ...blank, form: "执行中：本次运行尚未结束，不能重复提交" });
    expect(
      fieldErrorsOf(
        resolveCreateRunSubmission(
          { mode: "chat", source: null, writesAuthorized: false },
          { systemPrompt: "", userMessage: "任务", busy: false },
        ),
      ),
    ).toEqual(blank);
  });

  it("源码级：视图段里不出现 store 与提交判据（可见结构之外不做第二份决定）", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/CreateRunWorkspace.tsx"),
      "utf8",
    );
    const view = src.slice(
      src.indexOf("export function CreateRunWorkspaceView"),
      src.indexOf("export function CreateRunWorkspace("),
    );
    expect(view.length).toBeGreaterThan(1000);
    for (const token of [
      "useAppStore",
      "resolveCreateRunSubmission",
      "fieldErrorsOf",
      "deriveEntryGate",
      "isDraftFrozen",
    ]) {
      expect(view, token).not.toContain(token);
    }
  });
});
