import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveConfigGate, deriveEntryGate } from "../src/renderer/src/lib/entry-gate";
import { type OperationSession, initialSession } from "../src/renderer/src/lib/operation-session";

/**
 * U4 任务 4.3：create 与 result（普通/隔离）两个入口的**界面门禁派生**。
 *
 * 判据来源：tasks.md 4.3 + design D6；delta spec `desktop-ui`：
 * - 「初始握手失败禁用主动入口」/「所有入口实际使用同一适配器」——入口可用性一律
 *   从 `operations` 会话派生（`deriveEntryGate`），不再各判一套本地 `in_progress`；
 * - 禁用**必须有可见理由**：按钮只置灰 = 死按钮，`notice` 要说清为什么、下一步做什么；
 * - 门禁只拦"再发一条"，**不锁输入、不锁关闭、不锁只读预检**——那是"自己那次提交在飞"
 *   才需要的冻结（U3 的 `draftFrozen` 语义），两者混起来会让别人的操作把这份草稿冻住；
 * - 只有通信未知才引导"去核对状态"（拿它当通用文案会误导用户去核对一个正在跑的操作）。
 *
 * 组件形状用源码级接线契约钉（与 `test/layout.test.ts`、`create-form-draft.test.ts` 同法）：
 * 这三条都是"少接一支就静默失效"的接线判据，纯 reducer 测不到。
 */

const DIALOG = resolve(
  import.meta.dirname,
  "../src/renderer/src/components/CreateRunWorkspace.tsx",
);
const PANEL = resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx");
const SETTINGS = resolve(import.meta.dirname, "../src/renderer/src/components/SettingsDialog.tsx");

function sessionWith(overrides: Partial<OperationSession>): OperationSession {
  return { ...initialSession(), ...overrides };
}

describe("4.3 入口门禁的派生（纯判据）", () => {
  it("空闲会话 ⇒ 可提交且无提示；未握手 ⇒ 禁用并给提示", () => {
    const fresh = deriveEntryGate(initialSession());
    expect(fresh.canSubmit).toBe(false);
    expect(fresh.blockedBy).toBe("not_handshaked");
    expect(fresh.notice).toContain("握手");
    expect(fresh.shouldReconcile).toBe(false);

    const idle = deriveEntryGate(sessionWith({ epoch: "e-1" }));
    expect(idle).toEqual({
      canSubmit: true,
      blockedBy: null,
      notice: null,
      shouldReconcile: false,
    });
  });

  it("五种禁用原因各给一句可读理由，且只有通信未知引导核对", () => {
    const cases: [OperationSession, string][] = [
      [sessionWith({}), "握手"],
      [sessionWith({ epoch: "e-1", unknown: true }), "核对"],
      [sessionWith({ epoch: "e-1", closing: true }), "退出"],
      [sessionWith({ epoch: "e-1", configurationBusy: true }), "变更"],
      [sessionWith({ epoch: "e-1", activeOperationId: "op-1" }), "已有操作"],
    ];
    const reconciles: boolean[] = [];
    for (const [session, keyword] of cases) {
      const gate = deriveEntryGate(session);
      expect(gate.canSubmit, keyword).toBe(false);
      expect(gate.notice, keyword).toBeTruthy();
      expect(gate.notice, `${keyword} 的理由文案`).toContain(keyword);
      reconciles.push(gate.shouldReconcile);
    }
    expect(reconciles).toEqual([false, true, false, false, false]);
  });

  it("本地尚未确认的提交同样禁用入口（与 main 槽同源）", () => {
    const gate = deriveEntryGate(
      sessionWith({ epoch: "e-1", pending: [{ epoch: "e-1", operationId: "op-1" }] }),
    );
    expect(gate.canSubmit).toBe(false);
    expect(gate.blockedBy).toBe("operation_running");
  });
});

describe("4.3 接线契约：create 与 result 都从同一份会话派生", () => {
  const dialog = readFileSync(DIALOG, "utf8");
  const panel = readFileSync(PANEL, "utf8");

  it("两个入口都读 s.operations 并经 deriveEntryGate 判定", () => {
    for (const [src, label] of [
      [dialog, "CreateRunWorkspace"],
      [panel, "DetailPanel（result 编辑器）"],
    ] as const) {
      expect(src, label).toContain("deriveEntryGate(useAppStore((s) => s.operations))");
    }
  });

  it("门禁 AND 进提交判据，但没有并进输入锁/关闭锁/只读预检", () => {
    // create：canCreate 含 gate，formLocked 不含 gate（门禁不该锁输入与关闭）
    expect(dialog).toMatch(/const canCreate = submission\.ok && !draftFrozen && gate\.canSubmit/);
    const locked = dialog.slice(
      dialog.indexOf("const formLocked"),
      dialog.indexOf("\n", dialog.indexOf("const formLocked")),
    );
    expect(locked).not.toContain("gate.");
    // result：canFork 含 gate
    expect(panel).toMatch(
      /const canFork = canSubmit && sourceExecutable && sourceBlocked === null && gate\.canSubmit/,
    );
    // 只读能力预检不受主动槽影响（spec「只读入口和被动录制不占主动槽」）
    const checkAllowed = panel.slice(
      panel.indexOf("const checkAllowed"),
      panel.indexOf("\n", panel.indexOf("const checkAllowed")),
    );
    expect(checkAllowed).not.toContain("gate.");
    // 本地"自己那次提交在飞"仍走 inProgress/busy，不与门禁混用
    expect(panel).toContain('const inProgress = forking === "in_progress" || draftFrozen;');
  });

  it("禁用理由真的渲染出来（不是只改 disabled 的死按钮）", () => {
    expect(panel).toContain("gate.notice !== null");
    expect(dialog).toContain("blockedReason");
    // create 侧：submission 自身判据通过时，理由回落到门禁文案
    expect(dialog).toMatch(
      /const blockedReason = submission\.ok \? gate\.notice : submission\.reason/,
    );
  });
});

describe("4.4 接线契约：prompt / messages / A-B 也接同一份会话", () => {
  const panel = readFileSync(PANEL, "utf8");

  /** 切出某个编辑器（从声明到下一个顶层声明），避免"文件里某处出现过"式的假绿 */
  function editorBody(start: string, end: string): string {
    const from = panel.indexOf(start);
    const to = panel.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`unreachable：切不出 ${start}`);
    return panel.slice(from, to);
  }

  const PROMPT = editorBody("function PromptForkEditor({", "function scalarText(");
  const MESSAGES = editorBody("function MessagesForkEditor({", "function toolMessageText(");
  const MODEL_AB = editorBody("function ModelAbEditor({", "function LlmCallDetail(");

  it("三个编辑器都声明同一来源的门禁，并渲染禁用理由", () => {
    for (const [label, body] of [
      ["prompt", PROMPT],
      ["messages", MESSAGES],
      ["modelAb", MODEL_AB],
    ] as const) {
      expect(body, label).toContain("deriveEntryGate(useAppStore((s) => s.operations))");
      expect(body, label).toContain("<EntryGateNotice gate={gate} />");
    }
  });

  it("真实执行的提交按钮受门禁约束", () => {
    expect(PROMPT).toMatch(
      /onClick=\{doSubmit\}\s+disabled=\{inProgress \|\| !canSubmit \|\| !gate\.canSubmit\}/,
    );
    expect(MESSAGES).toMatch(/sourceBlocked !== null \|\|\s+!gate\.canSubmit/);
    expect(MODEL_AB).toMatch(
      /onClick=\{doExecute\}\s+disabled=\{inProgress \|\| !canSubmit \|\| activePlan === null \|\| !gate\.canSubmit\}/,
    );
  });

  it("只读入口与本地放弃不受门禁影响（占槽期间照常可用，正文始终可达）", () => {
    const disabledOf = (body: string, handler: string): string => {
      const at = body.indexOf(`onClick={${handler}}`);
      if (at < 0) throw new Error(`unreachable：没有 onClick={${handler}}`);
      const start = body.indexOf("disabled={", at);
      return body.slice(start, body.indexOf("}", start));
    };
    // A/B 的"校验并预览计划"走只读通道 ⇒ 不该被主动槽禁用
    expect(disabledOf(MODEL_AB, "doPreview")).not.toContain("gate.");
    // 放弃草稿是本地动作：门禁不该把它一起锁掉
    expect(disabledOf(PROMPT, "discardCurrentField")).not.toContain("gate.");
    expect(disabledOf(MESSAGES, "discardCurrent")).not.toContain("gate.");
    expect(disabledOf(MODEL_AB, "discardBatch")).not.toContain("gate.");
    // 门禁也没被并进"自己那次提交在飞"的输入锁
    expect(PROMPT).toContain('const inProgress = forking === "in_progress" || draftFrozen;');
    expect(MESSAGES).toContain('const inProgress = forking === "in_progress" || draftFrozen;');
    expect(MODEL_AB).toContain("const inProgress = modelAbInFlight || draftFrozen;");
  });
});

describe("4.8 接线契约：配置写入口绑同一门禁，读取与关闭不受影响", () => {
  const settings = readFileSync(SETTINGS, "utf8");

  it("deriveConfigGate 与提交门禁同源：空闲放行、有操作在跑/未握手/未知都拒写", () => {
    expect(deriveConfigGate(sessionWith({ epoch: "e-1" })).canChange).toBe(true);
    for (const [label, session] of [
      ["未握手", sessionWith({})],
      ["未知", sessionWith({ epoch: "e-1", unknown: true })],
      ["关闭协商", sessionWith({ epoch: "e-1", closing: true })],
      ["配置变更中", sessionWith({ epoch: "e-1", configurationBusy: true })],
      ["有操作在跑", sessionWith({ epoch: "e-1", activeOperationId: "op-1" })],
    ] as const) {
      const gate = deriveConfigGate(session);
      expect(gate.canChange, label).toBe(false);
      expect(gate.notice, label).toBeTruthy();
    }
    // "配置变更中"要说人话（不是套提交入口的文案）
    expect(
      deriveConfigGate(sessionWith({ epoch: "e-1", configurationBusy: true })).notice,
    ).toContain("变更");
  });

  it("三个写动作都判 configGate.canChange，且给出可见理由", () => {
    expect(settings).toContain(
      "const canSave = missing.length === 0 && !busy && configGate.canChange",
    );
    expect(settings).toContain("disabled={!configured || busy || !configGate.canChange}");
    expect(settings).toContain("disabled={proxyBusy || !configGate.canChange}");
    expect(settings).toContain('data-testid="config-gate-notice"');
  });

  it("读取、关闭与回读不被门禁锁掉（spec：settings:get / proxy:status 仍可用）", () => {
    // 关闭按钮：不带任何门禁判据（用户随时能退出这个对话框）
    const closeBtn = settings.slice(settings.indexOf("onClick={onClose}"));
    expect(closeBtn.slice(0, closeBtn.indexOf(">"))).not.toContain("disabled");
    // 载入/回读路径不接门禁
    const loaders = [
      settings.slice(
        settings.indexOf("void loadSettings()"),
        settings.indexOf("}", settings.indexOf("void loadSettings()")),
      ),
      settings.slice(
        settings.indexOf("void loadProxyStatus()"),
        settings.indexOf("}", settings.indexOf("void loadProxyStatus()")),
      ),
    ];
    for (const body of loaders) {
      expect(body).not.toContain("configGate");
    }
    expect(settings).not.toContain("disabled={configGate");
    // 模态焦点通道（ModalDialog + closeDisabled）不因门禁改写
    expect(settings).toContain("<ModalDialog");
  });
});
