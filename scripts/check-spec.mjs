#!/usr/bin/env node
/**
 * `check:spec`：OpenSpec 严格校验（全部活动 change 与 spec）。
 *
 * 为什么不直接写 `npx -y @fission-ai/openspec@<版本>`：
 *   1. **版本漂移**：脚本里钉的版本与本机实际安装的 CLI 长期不一致（修本轮之前是
 *      全局 1.13.1 / 脚本 1.12.0），于是"本机跑过的门禁"与"CI 跑的门禁"是两个
 *      东西，strict 结论不可互相引用。
 *   2. **每次走网络**：本机已有可用 CLI 时仍去拉 npx 缓存，离线环境直接跑不了。
 *   3. **CI 不能走本机路径**：`check:ci` 在 GitHub Actions 与 Gitee Go 上都跑，
 *      那两处**没有**全局 openspec ⇒ 必须保留 npx 兜底路径。
 *
 * 定案：**优先 PATH 上的 openspec，没有才回退 npx 的固定版本**。两条路径都实测过
 * （本机全局 1.13.1 与 npx 1.13.1 均输出 `Totals: 15 passed, 0 failed`）。
 *
 * ⚠️ **`--no-interactive` 是 CI 必需**：没有它，validate 在需要决策时可能等 stdin，
 *   在 CI 上表现为 job 挂到超时而不是失败。
 *
 * 🔴 **为什么用「扫 PATH」而不是「spawn 后看 exit code」判定命令是否存在**
 * （第一版就是这么写的，实测在 Windows 上判错）：
 *   Windows 上必须 `shell: true` 才能跑 `.cmd`/npx shim，而 **cmd.exe 找不到命令时
 *   返回 exit code 1**（不是 `ENOENT`、也不是 `status === null`）⇒ `status !== null`
 *   这个判据会把「命令不存在」误判成「校验不过」，于是回退分支永远不执行、CI 上
 *   直接红。纯 fs 扫 PATH 没有这个歧义：找到就跑，找不到就回退。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** 回退版本。升级时改这里 + 顶部注释，勿只改一处。 */
const FALLBACK_VERSION = "1.13.1";
const ARGS = ["validate", "--all", "--strict", "--no-interactive"];

/** Windows 需要 shell 才能跑 `.cmd` shim；其他平台直接 exec 即可。 */
const isWindows = process.platform === "win32";
const CANDIDATES = isWindows ? ["openspec.cmd", "openspec.exe", "openspec.bat"] : ["openspec"];

/** 按 PATH 顺序找 openspec（纯 fs，不起子进程）。 */
function findOnPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of CANDIDATES) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: isWindows,
    windowsHide: true,
  });
  // 走到这里说明命令确实存在（PATH 已验证 / npx 由包管理器提供）。
  // `status === null` 只在极少数「存在但起不来」的情形出现，单独给出提示而不是
  // 与 0 混为一谈。
  if (result.status === null) {
    console.error(`[check:spec] ${command} 存在但无法执行（status=null）`);
    return 1;
  }
  return result.status;
}

const onPath = findOnPath();
if (onPath !== null) {
  console.log(`[check:spec] 使用 PATH 上的 openspec：${onPath}`);
  process.exit(run(onPath, ARGS));
}

console.log(`[check:spec] PATH 上没有 openspec，回退 npx @fission-ai/openspec@${FALLBACK_VERSION}`);
process.exit(run("npx", ["-y", `@fission-ai/openspec@${FALLBACK_VERSION}`, ...ARGS]));
