/**
 * U8 任务 6.1：受控录制 fixtures/注入原语（§6.6 实机批主用）。
 *
 * 两种注入（批次按此清单引用，不另造第五种）：
 * - `端口占用`（occupyPort）：toggle 启动失败的唯一真实诱发面——
 *   saveProxy 先落盘（「部分应用」成立）→ startProxyServer 撞 EADDRINUSE
 *   （server.ts:74-76 抛「端口 X 已被占用…」）→ config-endpoints 捕获后回
 *   PROXY_START_FAILED 错误信封（config-endpoints.ts:134）→ store 无条件回读
 *   proxy:status ⇒ enabled=true / running=false 的「已保存但未监听」分层；
 * - `proxy 配置节写入`（writeProxySection）：批首把受控 proxy 配置写进 dev
 *   settings.json 的 proxy 字段——**只替换 proxy 字段**，运行配置（含 apiKey
 *   密文）逐字节不动；批尾 restoreFile 逐字节还原。这是「禁止覆盖生产凭据」
 *   的机械保证，不靠批次自觉。
 *
 * 🔴 探明事实（2026-10-01 对着源码数出来，写 6.6 判据前必读，勿再考古）：
 * 「状态读取失败」（proxy:status 错误信封 ⇒ recordingStatusReadFailed）在真机
 * **没有注入面**：main handler 是 `() => ok(proxy.status())`（ipc.ts:387）无 fail
 * 路径；loadProxy 全容错（settings.ts:140-163，settings.test.ts ›
 * 「settings.json 损坏 → loadProxy 容错返回默认值」坐实损坏回退默认值）；
 * handler 抛错只会让 invoke reject（store 的 `await api.proxyStatus()` 异常上抛，
 * 收不到 envelope，`!envelope.ok` 分支到不了）。⇒ 「应用失败回读也失败」半边由
 * recording-draft-store 单元承载 + evidence-index 如实登记；6.6 实机批验证的是
 * 「端口占用 → 应用失败 → 回读成功」的分层呈现路径。
 *
 * 纪律（沿 u5-read-faults 同款）：
 * - settings 还原放 `finally`，还原失败落 `U8-RESTORE-NEEDED.txt`（数据目录根），
 *   批次收尾据此判红而不是判绿；
 * - 快照只存字节与 sha256，**不打印内容**（apiKey 密文不进日志）；
 * - 占位 server 只绑 127.0.0.1（与 startProxyServer 同 host，保证 EADDRINUSE 必然）；
 * - release 后轮询核验端口真空出（close 回调不等于内核释放，假释放会污染后续 tag）。
 */
"use strict";

const { createServer } = require("node:net");
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

/** 还原失败/残留时的标记文件名（放数据目录根，批次收尾核验据此判红） */
const RESTORE_MARKER = "U8-RESTORE-NEEDED.txt";

/** PROXY_START_FAILED 稳定码（来源 config-endpoints.ts toggleProxy 的 catch 分支；期望值从代码读出，勿手改） */
const PROXY_START_FAILED_CODE = "PROXY_START_FAILED";
/** startProxyServer 端口占用文案的稳定前缀（来源 llm-proxy server.ts:75） */
const PORT_OCCUPIED_MESSAGE_PREFIX = "端口";
const PORT_OCCUPIED_MESSAGE_PART = "已被占用";

/** 文件字节快照：存在性 + 内容 + sha256（不打印内容） */
function snapshotFile(path) {
  if (!existsSync(path)) {
    return { path, exists: false, bytes: null, sha256: null };
  }
  const bytes = readFileSync(path);
  return {
    path,
    exists: true,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** 落「需要人工还原」标记（还原失败或核验不一致时调用） */
function markRestoreNeeded(markerDir, note) {
  const path = join(markerDir, RESTORE_MARKER);
  const line = `${new Date().toISOString()} ${note}\n`;
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line);
  return path;
}

/** 无残留时清掉标记（只认自己这份文件名） */
function clearRestoreMarker(markerDir) {
  const path = join(markerDir, RESTORE_MARKER);
  if (existsSync(path)) unlinkSync(path);
  return path;
}

/**
 * 按快照逐字节还原（含存在性）；还原后核验 sha256。
 * 不 clean ⇒ 落标记并返回 { clean:false, ... }，调用方判红。
 * ⚠️ 核验阶段自身容错：目标可能被换成目录等不可读形状（读抛错 ⇒ 按核验失败处理，
 * 而不是让还原判据自己崩掉——selfcheck 用例正是打这个形状）。
 */
function restoreFile(snap, markerDir) {
  let restoreError = null;
  try {
    if (!snap.exists) {
      if (existsSync(snap.path)) unlinkSync(snap.path);
    } else {
      writeFileSync(snap.path, snap.bytes);
    }
  } catch (e) {
    restoreError = e instanceof Error ? e.message : String(e);
  }
  let now;
  try {
    now = snapshotFile(snap.path);
  } catch (e) {
    now = {
      path: snap.path,
      exists: existsSync(snap.path),
      bytes: null,
      sha256: null,
      readError: e instanceof Error ? e.message : String(e),
    };
  }
  const clean = restoreError === null && now.sha256 === snap.sha256 && now.exists === snap.exists;
  if (!clean) {
    markRestoreNeeded(
      markerDir,
      `${snap.path} 未回到快照：restore=${restoreError ?? "ok"} nowSha=${
        now.sha256 ?? "absent"
      } expectSha=${snap.sha256 ?? "absent"}${(now.readError ?? "") ? ` read=${now.readError}` : ""}`,
    );
  } else if (markerDir !== undefined) {
    clearRestoreMarker(markerDir);
  }
  return { clean, restoreError, marked: !clean };
}

/**
 * 受控 proxy 配置节写入：读取现有 settings.json（可不存在），**只替换 proxy 字段**，
 * 其余顶层键（运行配置 baseURL/model/apiKey/apiKeyEncrypted）原样保留。
 * 返回 { snap, restore(markerDir) } —— snap 是写入前的整体字节快照。
 */
function writeProxySection(dataDir, proxy) {
  const settingsPath = join(dataDir, "settings.json");
  const snap = snapshotFile(settingsPath);
  let stored = {};
  if (snap.exists) {
    stored = JSON.parse(snap.bytes.toString("utf8"));
  }
  stored.proxy = proxy;
  writeFileSync(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return {
    snap,
    settingsPath,
    restore: (markerDir) => restoreFile(snap, markerDir),
  };
}

/**
 * 占位 server：让 startProxyServer 在同端口必撞 EADDRINUSE。
 * 返回 { port, release() }；release 关闭并轮询核验端口真空出（预算 3s，假释放抛错）。
 */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (e) => reject(new Error(`占位 server 监听 ${port} 失败：${e.message}`)));
    server.listen(port, "127.0.0.1", () => {
      let released = false;
      resolve({
        port,
        release() {
          if (released) return Promise.resolve({ freed: true });
          released = true;
          return new Promise((resolveRelease) => {
            server.close(() => {
              // close 回调后轮询核验：能重新 bind 才算真空出
              const probe = createServer();
              const deadline = Date.now() + 3000;
              const tryBind = () => {
                probe.once("error", () => {
                  if (Date.now() > deadline) {
                    resolveRelease({ freed: false });
                    return;
                  }
                  setTimeout(tryBind, 100);
                });
                probe.listen(port, "127.0.0.1", () => {
                  probe.close(() => resolveRelease({ freed: true }));
                });
              };
              tryBind();
            });
          });
        },
      });
    });
  });
}

/** 受控批次常用的隔离端口（避开默认 18787 / mock-llm 18799 / WorkBuddy 8787） */
const CONTROLLED_PROXY_PORT = 18793;

module.exports = {
  RESTORE_MARKER,
  PROXY_START_FAILED_CODE,
  PORT_OCCUPIED_MESSAGE_PREFIX,
  PORT_OCCUPIED_MESSAGE_PART,
  CONTROLLED_PROXY_PORT,
  snapshotFile,
  restoreFile,
  markRestoreNeeded,
  clearRestoreMarker,
  writeProxySection,
  occupyPort,
};
