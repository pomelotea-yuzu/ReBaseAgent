import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SettingsState } from "@shared/ipc";
import { ok } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { deriveConfigGate } from "../src/renderer/src/lib/entry-gate";
import { initialSession } from "../src/renderer/src/lib/operation-session";

/**
 * U5（unify-run-execution-workflow）任务 5.5：**清除凭据确认与 U4 门禁接线回归**。
 *
 * 判据来源：delta「设置往返保留编辑并真实反馈配置结果」之「清除确认包含凭据且受槽约束」，
 * 加两条**回归引用**：「初始握手失败禁用主动入口」（判据在 U4 `entry-gate`/`config-gate`，
 * 本项补设置对话框接线）与「结果不可读只重试同一记录」（1.3 既有证据，见 tasks 注记）。
 *
 * 本项的硬交付：渲染层最后一处 `window.confirm`（清除配置）迁到真模态——
 * 全量扫描归零，"执行确认与放弃确认都已就地化"从此对整个 renderer 成立。
 */

const SETTINGS_DIR = resolve(import.meta.dirname, "../src/renderer/src");

const apiStub: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).window = { api: apiStub };
const { useAppStore } = await import("../src/renderer/src/store");

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const walkTs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkTs(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

describe("5.5 渲染层 window.confirm 全量归零", () => {
  it("src/renderer/src 下没有任何文件再调用 window.confirm（剥注释后扫）", () => {
    const offenders = walkTs(SETTINGS_DIR)
      .filter((file) => stripComments(readFileSync(file, "utf8")).includes("window.confirm("))
      .map((file) => file.replace(SETTINGS_DIR, ""));
    expect(offenders).toEqual([]);
  });
});

describe("5.5 清除确认：点名凭据、取消零调用、受槽约束、查看/关闭不受锁", () => {
  const dialog = stripComments(
    readFileSync(resolve(SETTINGS_DIR, "components/SettingsDialog.tsx"), "utf8"),
  );

  it("确认文案点名保存凭据一并删除且不可恢复；走 requestConfirm 真模态", () => {
    const at = dialog.indexOf("const doClear");
    expect(at).toBeGreaterThan(-1);
    const block = dialog.slice(at, dialog.indexOf("const doProxyApply"));
    expect(block).toContain("requestConfirm(");
    expect(block).toContain("apiKey（保存的凭据）一并删除，不可恢复");
    expect(block).toContain("调试草稿与已有运行不受影响");
  });

  it("取消 ⇒ 清除通道一次都不碰；确认之后的复位只动配置输入，不越界清草稿", () => {
    const block = dialog.slice(
      dialog.indexOf("const doClear"),
      dialog.indexOf("const doProxyApply"),
    );
    // 顺序判据：`if (!confirmed) return;` 必须挡在 clearSettings 调用之前
    expect(block.indexOf("if (!confirmed) return;")).toBeGreaterThan(-1);
    expect(block.indexOf("if (!confirmed) return;")).toBeLessThan(
      block.indexOf("await clearSettings()"),
    );
    // 块内不出现任何草稿/提交通道动作（"不清其他草稿"的结构判据）
    for (const forbidden of ["draft", "Draft", "submission", "discard"]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });

  it("清除按钮受 U4 配置门禁（busy 防重入 + configGate），而「关闭/✕」不吃这把锁（查看返回可用）", () => {
    expect(dialog).toContain("disabled={!configured || busy || !configGate.canChange}");
    expect(dialog).toContain("if (busy) return;");
    // 关闭三路都走 requestClose；其处理器不引用写门禁（requestClose 只判 dirty）
    const closeBlock = dialog.slice(
      dialog.indexOf("const requestClose"),
      dialog.indexOf("const doSave"),
    );
    expect(closeBlock).not.toContain("configGate");
    expect(dialog.match(/onClick=\{requestClose\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("初始握手未成功 ⇒ 配置写入口整体禁用（U4 门禁接线回归到设置对话框这一层）", () => {
    const gate = deriveConfigGate(initialSession()); // epoch null = 从没握手
    expect(gate.canChange).toBe(false);
    expect(gate.notice).not.toBeNull();
    // 对话框确实把写通道绑在这把门上（保存与清除共用）
    expect(dialog).toContain("deriveConfigGate(useAppStore((s) => s.operations))");
    expect(dialog).toContain("!configGate.canChange");
  });
});

describe("5.5 store.clearSettings 两分支", () => {
  const saved: SettingsState = {
    configured: true,
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    encryption: "safe",
  };

  it("清除失败 ⇒ 配置事实原样保留（不假装清了），错误入 store", async () => {
    useAppStore.setState({ settings: saved, error: null });
    apiStub.clearSettings = async () => ({
      ok: false,
      error: { code: "SETTINGS_CLEAR_FAILED", message: "删除失败" },
    });
    const done = await useAppStore.getState().clearSettings();
    expect(done).toBe(false);
    expect(useAppStore.getState().settings).toEqual(saved);
    expect(useAppStore.getState().error).toContain("删除失败");
  });

  it("清除成功 ⇒ 配置状态回到未配置（settings null）", async () => {
    useAppStore.setState({ settings: saved, error: null });
    apiStub.clearSettings = async () => ok({ cleared: true });
    const done = await useAppStore.getState().clearSettings();
    expect(done).toBe(true);
    expect(useAppStore.getState().settings).toBeNull();
  });
});
