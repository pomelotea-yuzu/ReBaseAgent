import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxyServer } from "@rebaseagent/llm-proxy";
import { describe, expect, it } from "vitest";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 6.1：录制 fixtures 的**可用性自检**。
 *
 * 判据来源：tasks.md 6.1「准备受控录制 fixtures/mock：端口占用、状态读取失败与配置应用中断，
 * 维护注入清单/指纹还原，禁止覆盖生产凭据」。
 *
 * 与 U5 controlled-read-faults 同一方法论——「我以为会失败」不算数，每种注入的
 * 实际失败形状对着真实实现数出来。本轮数出的三条分层依据（6.6 写判据前必读）：
 * ① 端口占用是 toggle 启动失败的唯一真实诱发面：占位 server（127.0.0.1 同 host）
 *   ⇒ startProxyServer 必撞 EADDRINUSE（server.ts:74-76）⇒ IPC 错误信封；
 * ② 「状态读取失败」（proxy:status 错误信封）真机没有注入面：main handler 恒 ok
 *   + loadProxy 全容错（settings.test.ts 已承载损坏回退默认值）——回读失败半边
 *   按单元承载，6.6 不追这条注入面；
 * ③ 「禁止覆盖生产凭据」由 writeProxySection 机械保证：只替换 proxy 字段，
 *   运行配置（含 apiKey 密文）逐字节不动，批尾 restoreFile 逐字节核验。
 */

const require = createRequire(import.meta.url);

interface Snapshot {
  path: string;
  exists: boolean;
  sha256: string | null;
}
interface RestoreResult {
  clean: boolean;
  restoreError: string | null;
  marked: boolean;
}
interface OccupyHandle {
  port: number;
  release: () => Promise<{ freed: boolean }>;
}
interface FixturesModule {
  RESTORE_MARKER: string;
  PROXY_START_FAILED_CODE: string;
  PORT_OCCUPIED_MESSAGE_PART: string;
  CONTROLLED_PROXY_PORT: number;
  snapshotFile: (path: string) => Snapshot;
  restoreFile: (snap: Snapshot, markerDir: string) => RestoreResult;
  writeProxySection: (
    dataDir: string,
    proxy: { enabled: boolean; port: number; upstreamBaseUrl: string },
  ) => { snap: Snapshot; settingsPath: string; restore: (markerDir: string) => RestoreResult };
  occupyPort: (port: number) => Promise<OccupyHandle>;
}
const fixtures = require("../scripts/lib/u8-recording-fixtures.cjs") as FixturesModule;

/** 占位 handler：用例只验 listen 成败，请求路径不会被走到 */
const stubHandler = { handle: () => undefined } as unknown as Parameters<
  typeof startProxyServer
>[0]["handler"];

/** 受控端口独立于 fixtures 常量（并行文件跑时互不相扰；批内顺序使用） */
const PORT = 18893;

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "u8-rec-fixtures-"));
  dirs.push(dir);
  return dir;
}

/** 预置一份带运行配置（含密文 apiKey 形状）+ 旧 proxy 节的 settings.json */
function seedSettings(dataDir: string): void {
  writeFileSync(
    join(dataDir, "settings.json"),
    `${JSON.stringify(
      {
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: "enc:sk-controlled-only",
        apiKeyEncrypted: true,
        proxy: { enabled: false, port: 18787, upstreamBaseUrl: "https://api.deepseek.com" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("U8 6.1 录制 fixtures：每种注入的实际失败形状（数出来，不猜）", () => {
  it("端口占用：startProxyServer 同端口必撞「已被占用」；release 后端口真空出（对照项可再监听）", async () => {
    const handle = await fixtures.occupyPort(PORT);
    try {
      let message = "";
      try {
        await startProxyServer({ port: PORT, handler: stubHandler });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain(fixtures.PORT_OCCUPIED_MESSAGE_PART);
      expect(message).toContain(String(PORT));
    } finally {
      const { freed } = await handle.release();
      expect(freed).toBe(true);
    }
    // 对照项：释放后合法路径确实成功——防「一律失败」式的假阳判据
    const server = await startProxyServer({ port: PORT, handler: stubHandler });
    await server.stop();
  });

  it("writeProxySection：只替换 proxy 字段，运行配置（含密文 apiKey）原样；还原后逐字节一致", () => {
    const dataDir = tempDataDir();
    seedSettings(dataDir);
    const settingsPath = join(dataDir, "settings.json");
    const beforeSha = fixtures.snapshotFile(settingsPath).sha256;
    const handle = fixtures.writeProxySection(dataDir, {
      enabled: true,
      port: fixtures.CONTROLLED_PROXY_PORT,
      upstreamBaseUrl: "http://127.0.0.1:9/v1",
    });
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(after.proxy).toEqual({
      enabled: true,
      port: fixtures.CONTROLLED_PROXY_PORT,
      upstreamBaseUrl: "http://127.0.0.1:9/v1",
    });
    // 「禁止覆盖生产凭据」的机械形状：运行配置四个键一个不少、值不变
    expect(after.baseURL).toBe("https://api.deepseek.com/v1");
    expect(after.model).toBe("deepseek-chat");
    expect(after.apiKey).toBe("enc:sk-controlled-only");
    expect(after.apiKeyEncrypted).toBe(true);
    const restore = handle.restore(dataDir);
    expect(restore.clean).toBe(true);
    expect(fixtures.snapshotFile(settingsPath).sha256).toBe(beforeSha);
  });

  it("settings.json 不存在时：受控写入创建新文件，还原后回到「不存在」", () => {
    const dataDir = tempDataDir();
    const handle = fixtures.writeProxySection(dataDir, {
      enabled: false,
      port: 18787,
      upstreamBaseUrl: "https://api.deepseek.com",
    });
    expect(existsSync(handle.settingsPath)).toBe(true);
    const restore = handle.restore(dataDir);
    expect(restore.clean).toBe(true);
    expect(existsSync(handle.settingsPath)).toBe(false);
  });

  it("selfcheck：还原动作失败（settings.json 被换成目录）⇒ restore 认残留并落标记（还原判据不是恒绿）", () => {
    const dataDir = tempDataDir();
    seedSettings(dataDir);
    const handle = fixtures.writeProxySection(dataDir, {
      enabled: true,
      port: fixtures.CONTROLLED_PROXY_PORT,
      upstreamBaseUrl: "http://127.0.0.1:9/v1",
    });
    // 让还原**写不回去**：settings.json 被替换成同名目录（覆盖写抛 EPERM/EISDIR）
    rmSync(handle.settingsPath);
    mkdirSync(handle.settingsPath);
    const restore = handle.restore(dataDir);
    expect(restore.clean).toBe(false);
    expect(restore.restoreError).not.toBeNull();
    expect(restore.marked).toBe(true);
    expect(readFileSync(join(dataDir, fixtures.RESTORE_MARKER), "utf8")).toContain("未回到快照");
    // 测试自行收尾（目录里含伪装 settings.json 与标记，一并清除）
    rmSync(dataDir, { recursive: true, force: true });
    dirs.pop();
  });

  it("稳定码与文案锚：期望值从被引用的源码读出（端点改码 ⇒ 本用例判红，实机判据随之更新）", () => {
    const endpointSrc = readFileSync(join(__dirname, "../src/main/config-endpoints.ts"), "utf8");
    expect(endpointSrc).toContain(`"${fixtures.PROXY_START_FAILED_CODE}"`);
    const serverSrc = readFileSync(
      join(__dirname, "../../../packages/llm-proxy/src/server.ts"),
      "utf8",
    );
    expect(serverSrc).toContain(fixtures.PORT_OCCUPIED_MESSAGE_PART);
  });
});
