import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runModelAb } from "../src/main/fork-runner";
import { ProxyForkError, ProxyManager } from "../src/main/proxy-manager";
import { runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";
import type { RunSettings } from "../src/main/settings";
import { withMockLlm } from "./helpers/mock-llm-harness";

/**
 * U1（refactor-run-workspace）任务 6.6：在受控模型服务上回归 代理设置/messages 重发 与 模型 A/B
 * dry-run/真实执行，并钉住「未捕获 key 门禁保留」。
 *
 * 判据来源：tasks.md 6.6——「验证『旧创建设置及执行入口保持可达』『其它分叉形态不加缓存提示』，
 * 受控请求日志证明 dry-run 零请求，未捕获 key/配置缺失等原门禁保留」。
 *
 * 与 6.4/6.5 同手法：入口不经 stub，把上游指向**受控模型服务**（ProxyManager 不注入 fetchImpl ⇒
 * 用全局 fetch 真实转发；runModelAb 不注入 llm ⇒ 入口 new 真实 `OpenAiCompatClient`）。
 *
 * ⚠️ llm-proxy 通道是「唯一会发 `stream:false` 的地方」：外部 agent 非流式请求经代理 JSON 直通到
 * 上游 ⇒ 受控服务按 `stream:false` 回真 JSON；而「编辑 messages 重发」内部分叉路径 `buildForkRequest`
 * **恒设 `stream:true`**（`handler.ts:515`，走 SSE 聚合）⇒ 同一个代理会话在同一条受控服务上同时验
 * 两条协议分支，正是 design D7「不能将统一 SSE 冒充全协议」在代理侧的落点。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

const dirs: string[] = [];
const managers: ProxyManager[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // 先停掉本流程未关闭的代理服务（withMockLlm 另关受控服务），再清目录
  for (const m of managers.splice(0)) {
    await m.toggle({ enabled: false, port: 0, upstreamBaseUrl: "" }).catch(() => {});
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 起一个指向受控服务的代理管理器（upstream = handle.baseURL，用全局 fetch 真实转发） */
function proxyTowards(h: { baseURL: string }): {
  dataDir: string;
  repository: RunRepository;
  manager: ProxyManager;
} {
  const dataDir = tempDir("controlled-proxy-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const manager = new ProxyManager({
    repository,
    settings: new SettingsStore({ dataDir, cipher }),
    tracesDir,
  });
  managers.push(manager);
  return { dataDir, repository, manager };
}

// ---------------------------------------------------------------------------
// 1. 代理设置 / messages 重发（llm-proxy 通道 → 受控服务）
// ---------------------------------------------------------------------------

describe("6.6 受控服务回归：代理设置/messages 重发（llm-proxy 通道）", () => {
  it("外部非流式请求 JSON 直通 + 编辑 messages 分叉按 stream:true 重发：受控日志两种模式、fork run 落盘、父不改写", async () => {
    await withMockLlm({ turns: [{ content: "初次回复" }, { content: "分叉回复" }] }, async (h) => {
      const { dataDir, repository, manager } = proxyTowards(h);
      const tracesDir = join(dataDir, "traces");

      const state = await manager.toggle({
        enabled: true,
        port: 0,
        upstreamBaseUrl: h.baseURL,
      });
      expect(state.running).toBe(true);

      // 1. 外部 agent 非流式请求经代理 → JSON 直通到受控服务
      const initial = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-c",
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          stream: false,
          messages: [
            { role: "system", content: "你是文件助手。" },
            { role: "user", content: "你好" },
          ],
        }),
      });
      expect(initial.status).toBe(200);
      expect(manager.status().hasKey).toBe(true);

      // 受控日志 entry[0]：stream:false + 真 JSON（代理通道是唯一发非流式的地方）
      const first = h.entries()[0];
      expect(first?.stream).toBe(false);
      expect(first?.mode).toBe("json");
      expect(first?.messages.map((m) => m.role)).toEqual(["system", "user"]);

      // 录制出代理 run，捕获到 key
      const runsAfterInit = repository.listRuns().runs;
      expect(runsAfterInit).toHaveLength(1);
      const parent = repository.loadRunRecord(runsAfterInit[0]!.id);
      expect(parent.meta.source?.kind).toBe("proxy");
      expect(parent.meta.config_hash).toBeDefined();
      const parentFile = join(tracesDir, `${parent.meta.id}.jsonl`);
      const parentBefore = readFileSync(parentFile, "utf8");

      // 2. 编辑 messages 分叉重发（内部分叉路径恒 stream:true）
      const llmSpan = parent.spans.find((s) => s.kind === "llm.call");
      const atSpanId = llmSpan?.kind === "llm.call" ? llmSpan.id : "s_02";
      const edited = [{ role: "user", content: "编辑后的消息" }];
      const { id: forkId } = await manager.fork({
        parentRunId: parent.meta.id,
        atSpanId,
        messages: edited,
      });

      // 受控日志 entry[1]：stream:true + SSE（buildForkRequest 恒设 stream:true）
      const forkEntry = h.entries()[1];
      expect(forkEntry?.stream).toBe(true);
      expect(forkEntry?.mode).toBe("sse");
      expect(h.served()).toBe(2);

      // fork run 落盘：父 / edit.field=messages（不是 tool-result ⇒ 不触发缓存提示，5.7 契约）
      const forkRun = repository.loadRunRecord(forkId);
      expect(forkRun.meta.parent).toBe(parent.meta.id);
      expect(forkRun.meta.fork?.edit.field).toBe("messages");
      expect(forkRun.meta.fork?.edit.field).not.toBe("tool-result");
      expect(forkRun.meta.fork?.edit.value).toEqual(edited);
      expect(forkRun.status).toBe("completed");
      const forkSpan = forkRun.spans.find((s) => s.kind === "llm.call");
      const forkMessages =
        forkSpan !== undefined && "messages" in forkSpan.request ? forkSpan.request.messages : [];
      expect(forkMessages).toEqual(edited);

      // 父记录未改写（逐字节）
      expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
    });
  });

  it("未捕获 key 时分叉 → PROXY_NO_KEY，且受控服务零请求（门禁在联网之前）", async () => {
    await withMockLlm({ turns: [{ content: "不应被调用" }] }, async (h) => {
      const { manager } = proxyTowards(h);
      await manager.toggle({ enabled: true, port: 0, upstreamBaseUrl: h.baseURL });

      const err = await manager
        .fork({
          parentRunId: "run_x",
          atSpanId: "s_02",
          messages: [{ role: "user", content: "a" }],
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProxyForkError);
      expect((err as ProxyForkError).code).toBe("PROXY_NO_KEY");
      expect(h.served()).toBe(0); // 受控服务从未被调用
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 模型 A/B：dry-run 零请求 / 真实执行
// ---------------------------------------------------------------------------

describe("6.6 受控服务回归：模型 A/B dry-run / 真实执行", () => {
  it("经受控服务创建父本后：dry-run 零请求；真实执行每臂恰一次（请求日志证明）", async () => {
    const dataDir = tempDir("controlled-ab-desktop-");
    try {
      const tracesDir = join(dataDir, "traces");
      mkdirSync(tracesDir, { recursive: true });
      const repository = new RunRepository(tracesDir);

      await withMockLlm(
        { turns: [{ content: "父答" }, { content: "臂一" }, { content: "臂二" }] },
        async (h) => {
          // 父本也经受控服务现造（普通创建，恰一次提交）
          const parent = await runCreate(
            {
              repository,
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dataDir,
            },
            { systemPrompt: "你是文件助手。", userMessage: "你好" },
          );
          expect(h.served()).toBe(1);

          // dry-run：零模型请求（费用门禁前早退）
          const dry = await runModelAb(
            {
              repository,
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dataDir,
            },
            {
              parentRunId: parent.id,
              arms: [{ model: "a" }, { model: "b" }],
              dryRun: true,
            },
          );
          expect(dry.ok).toBe(true);
          expect(dry.ids).toEqual([]);
          expect(h.served()).toBe(1); // 受控请求日志证明：dry-run 不发任何请求

          // 真实执行：每臂恰一次，顺序=臂顺序
          const live = await runModelAb(
            {
              repository,
              settings: { ...SETTINGS, baseURL: h.baseURL },
              execCwd: dataDir,
            },
            { parentRunId: parent.id, arms: [{ model: "a" }, { model: "b" }] },
          );
          expect(live.ok).toBe(true);
          expect(live.ids).toHaveLength(2);
          expect(h.served()).toBe(3);
          expect(
            h
              .entries()
              .slice(1)
              .map((e) => e.model),
          ).toEqual(["a", "b"]);
        },
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
