import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../src/shared/channels";

/**
 * U4 任务 4.9：桥接面与消费方的**契约复核**（renderer fixtures/API mock 的升级在
 * `test/helpers/operation-channels.ts` 与各用例桩里做，本文件钉"暴露面本身"）。
 *
 * 判据（delta spec `desktop-ui` 逐字标题）：
 * - 「预加载接口不含文件能力」——preload 运行在 sandbox 下，只允许
 *   `contextBridge + ipcRenderer.invoke` 这一条通道：不引入 node 运行时能力、
 *   不暴露 `ipcRenderer` 本体、方法集合与 `WindowApi` 一致（多一个都是攻击面）；
 * - 「非法操作响应不能解除门禁」的桥接半边——七个主动方法的**入参形状已是执行信封**
 *   （类型来自 `@shared/ipc` 的 `ExecutedRequest`），preload 不"贴心地"替调用方补身份；
 * - 本 change 不交付取消能力 ⇒ 桥接面**不得**出现 stop/cancel/abort 一类通道。
 *
 * 为什么按源码扫而不是跑真 electron：真机 IPC 与 renderer 消费在 §6 实机里跑；
 * 这里要防的是"哪天有人顺手把 fs 或 ipcRenderer 挂上去"，那是一行 import 的事，
 * 源码级契约最直接也最不会假绿。
 */

const R = (p: string): string => readFileSync(resolve(import.meta.dirname, p), "utf8");
const PRELOAD = R("../src/preload/index.ts");
const MAIN = R("../src/main/index.ts");

const ACTIVE_CHANNELS = ["createRun", "forkRun", "promptFork", "proxyFork", "modelAb"] as const;

describe("4.9 预加载桥接面：不含文件能力", () => {
  it("preload 不引入任何 node 运行时能力，也不把 ipcRenderer 交给渲染层", () => {
    expect(PRELOAD).not.toMatch(/from\s+"node:/);
    expect(PRELOAD).not.toMatch(/require\(/);
    expect(PRELOAD).not.toMatch(/\b(__dirname|process\.|Buffer\b|eval\()/);
    // 只暴露一个受限 api 对象（类型就是 WindowApi），不转发 ipcRenderer / event 对象
    expect(PRELOAD).toContain('contextBridge.exposeInMainWorld("api", api)');
    expect(PRELOAD.match(/exposeInMainWorld/g)).toHaveLength(1);
    // api 对象的每个字段都是"包一层的调用"，没有一处把 ipcRenderer 本体或 event 对象交出去
    expect(PRELOAD).not.toMatch(/:\s*ipcRenderer\s*[,}]/);
    expect(PRELOAD).not.toMatch(/:\s*\(?\s*event\s*\)?\s*=>\s*event\b/);
    // 桥接面是**封闭清单**：多一个方法就是多一个攻击面，所以按白名单整表核对。
    // 清单里只有"取数 / 主动执行（经 main 登记）/ 只读辅助 / 配置与代理 / 关闭协商"，
    // **没有任何文件写入、删除、执行外部命令的能力**——文件读写只发生在 main 侧。
    const keys = [...PRELOAD.matchAll(/^ {2}([a-zA-Z]+):/gm)].map((match) => match[1] as string);
    expect([...new Set(keys)].sort()).toEqual([
      "chooseSource",
      "clearSettings",
      "createRun",
      "draftCloseAnswer",
      "draftCloseHandshake",
      "draftCloseReport",
      "forkCapability",
      "forkRun",
      "getRun",
      "getSettings",
      "inspectWorkspace",
      "listRuns",
      "modelAb",
      "modelAbPlan",
      "onDraftCloseQuery",
      "onDraftCloseRelease",
      "onDraftCloseSession",
      "operationsReconcile",
      "operationsStatus",
      "promptFork",
      "proxyFork",
      "proxyStatus",
      "proxyToggle",
      "readWorkspaceFile",
      "saveSettings",
    ]);
  });

  it("窗口安全基线在 main 侧钉死：nodeIntegration 关、contextIsolation 开、sandbox 开", () => {
    const block = MAIN.slice(
      MAIN.indexOf("webPreferences: {"),
      MAIN.indexOf("}", MAIN.indexOf("webPreferences: {")),
    );
    expect(block).toContain("nodeIntegration: false");
    expect(block).toContain("contextIsolation: true");
    expect(block).toContain("sandbox: true");
  });

  it("七个主动方法都按执行信封透传，preload 不替调用方补身份", () => {
    for (const name of ACTIVE_CHANNELS) {
      const line = PRELOAD.slice(
        PRELOAD.indexOf(`${name}: (`),
        PRELOAD.indexOf("\n", PRELOAD.indexOf(`${name}: (`)),
      );
      // 载荷原样传，不出现 `{operation:` 之类的兜底构造
      expect(line, name).toContain(`${name}: (request) =>`);
      expect(line, name).not.toContain("operation:");
    }
    // 两条只读操作通道同样原样透传
    expect(PRELOAD).toContain("operationsStatus");
    expect(PRELOAD).toContain("operationsReconcile");
  });

  it("本阶段不交付取消能力：桥接面没有 stop/cancel/abort 通道", () => {
    for (const banned of ["stop", "cancel", "abort", "terminate"]) {
      const hit = Object.entries(CHANNELS).filter(
        ([name, value]) =>
          name.toLowerCase().includes(banned) || String(value).toLowerCase().includes(banned),
      );
      expect(hit, banned).toEqual([]);
      expect(PRELOAD.toLowerCase(), banned).not.toContain(`${banned}:`);
    }
  });

  it("通道白名单里操作相关只有 status / reconcile 两条只读", () => {
    const operationChannels = Object.values(CHANNELS).filter((one) =>
      one.startsWith("operations:"),
    );
    expect(operationChannels.sort()).toEqual(["operations:reconcile", "operations:status"]);
  });
});
