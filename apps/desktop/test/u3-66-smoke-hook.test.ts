import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SmokeEventWindow,
  applySmokeEventAction,
  installSmokeEventHook,
} from "../src/main/smoke-event-hook";

/**
 * U3 任务 6.6（main 侧隔离测试面）：实机注入钩子的行为契约。
 * 实机（真崩溃 / 真窗口 / UIA 确认框）由 `apps/desktop/scripts/u3-66-cdp.cjs` 承载；
 * 本文件钉住钩子本身：动作白名单、哨兵消费节奏、以及「只合成事件、不注册监听」
 * 的 design D6 边界不因验收而失守。
 */

interface Calls {
  crash: number;
  emitted: Array<{ name: string; payload: unknown }>;
  destroyed: boolean;
}

function fakeWindow(calls: Calls): SmokeEventWindow {
  return {
    isDestroyed: () => calls.destroyed,
    webContents: {
      forcefullyCrashRenderer: () => {
        calls.crash += 1;
      },
    },
    emit: (name: string, ...args: unknown[]) => {
      calls.emitted.push({ name, payload: args[0] });
      return true;
    },
  };
}

const sentinels: string[] = [];
function sentinel(content: string): string {
  const path = resolve(
    import.meta.dirname,
    `.tmp-u366-${process.pid}-${Math.random().toString(36).slice(2)}.flag`,
  );
  writeFileSync(path, content);
  sentinels.push(path);
  return path;
}
afterEach(() => {
  for (const p of sentinels.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* 已被消费正是断言内容 */
    }
  }
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("applySmokeEventAction：动作白名单", () => {
  it("crash-renderer ⇒ 真调 forcefullyCrashRenderer，不 emit", () => {
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    expect(applySmokeEventAction("crash-renderer", fakeWindow(calls))).toBe(true);
    expect(calls.crash).toBe(1);
    expect(calls.emitted).toHaveLength(0);
  });

  it("两种系统会话结束事件 ⇒ 在窗口上合成 emit（带 preventDefault 面）", () => {
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    expect(applySmokeEventAction("query-session-end", fakeWindow(calls))).toBe(true);
    expect(applySmokeEventAction("session-end", fakeWindow(calls))).toBe(true);
    expect(calls.emitted.map((e) => e.name)).toEqual(["query-session-end", "session-end"]);
    const evt = calls.emitted[0]?.payload as { preventDefault: () => void };
    expect(typeof evt.preventDefault).toBe("function");
    expect(calls.crash).toBe(0);
  });

  it("白名单外（空串/陌生动作/大小写）⇒ false 且零副作用", () => {
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    for (const bad of ["", "quit", "Session-End", "crash_render", "  "]) {
      expect(applySmokeEventAction(bad, fakeWindow(calls))).toBe(false);
    }
    expect(calls.crash + calls.emitted.length).toBe(0);
  });
});

describe("installSmokeEventHook：哨兵文件轮询", () => {
  it("文件出现 ⇒ 执行动作并删除哨兵（一次性，不重复触发）", async () => {
    const path = sentinel("session-end");
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    const dispose = installSmokeEventHook(path, () => fakeWindow(calls), 20);
    await sleep(150);
    expect(calls.emitted.map((e) => e.name)).toEqual(["session-end"]);
    expect(existsSync(path)).toBe(false);
    await sleep(100);
    expect(calls.emitted).toHaveLength(1); // 哨兵已消费 ⇒ 不再触发
    dispose();
  });

  it("窗口不在（null）⇒ 哨兵照样消费但不执行任何动作", async () => {
    const path = sentinel("crash-renderer");
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    const dispose = installSmokeEventHook(path, () => null, 20);
    await sleep(150);
    expect(existsSync(path)).toBe(false);
    expect(calls.crash).toBe(0);
    dispose();
  });

  it("destroyed 窗口 ⇒ 不执行；dispose 后不再轮询", async () => {
    const path = sentinel("crash-renderer");
    const calls: Calls = { crash: 0, emitted: [], destroyed: true };
    const dispose = installSmokeEventHook(path, () => fakeWindow(calls), 20);
    await sleep(150);
    expect(calls.crash).toBe(0);
    dispose();
    writeFileSync(path, "session-end");
    await sleep(150);
    expect(existsSync(path)).toBe(true); // 解绑后哨兵不再被消费
    rmSync(path, { force: true });
  });

  it("未设置哨兵文件 ⇒ 永不触发（生产路径零动作）", async () => {
    const path = resolve(import.meta.dirname, ".tmp-u366-nonexistent.flag");
    const calls: Calls = { crash: 0, emitted: [], destroyed: false };
    const dispose = installSmokeEventHook(path, () => fakeWindow(calls), 20);
    await sleep(150);
    expect(calls.crash + calls.emitted.length).toBe(0);
    dispose();
  });
});

describe("U3 6.6 源码契约：钩子只合成、不监听（D6 边界跨文件成立）", () => {
  it("smoke-event-hook.ts 不注册任何事件监听器", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/main/smoke-event-hook.ts"),
      "utf8",
    );
    // 验收钩子若开始 `.on/.once/addListener` 系统事件，就变成"接入阻止/确认"，
    // 违反 design D6 —— 与 4.4 契约（attach/index 零监听）同一条红线
    for (const forbidden of [".on(", ".once(", "addListener(", 'on("']) {
      expect(src).not.toContain(forbidden);
    }
  });
});
