import type { ProfileManifest } from "../schema.js";

/**
 * manifest → 受限容器旗标的**唯一映射**（R3 tasks 3.2「限额参数」；验收 P10 静态面）。
 *
 * 硬规则：
 * - 每个旗标值**只来自 manifest**（security/limits 字段）——本文件禁止内嵌限额常数；
 *   限额变化 = manifest 版本化更新 = 条件指纹变化（design D2/D5），此处自动跟随；
 * - 语义锚定阶段 1 实测（backend-verification.md §1.4）：
 *   `memory == memory-swap` ⇒ 无 swap；tmpfs 页计入内存 cgroup ⇒ memory 是
 *   「进程 + /work + /tmp 合并预算」（`tmpfsCountsTowardMemoryBudget` 钉 literal）；
 *   mode=1777 使 uid 1000 可写 tmpfs 根；
 * - `--restart no` 显式禁自动重启、`--log-driver none` 禁 daemon 持久保存项目输出
 *   （输出只经有界执行通道采集，design D5.3）；
 * - **不用 `--init`**：PID 1 必须是产品受控 supervisor（`supervisorPid1` 钉 literal，
 *   §1.4 发现①——裸 PID 1 忽略 SIGTERM），docker-init 不承担该角色。
 *
 * 消费方：3.4 执行容器创建；3.5 停止语义不在此。旗标顺序固定（同 manifest 在任何
 * 机器上产生同一 argv，进入条件指纹面）。
 */
export function containerRunFlags(profile: ProfileManifest): string[] {
  const security = profile.security;
  const limits = profile.limits;
  return [
    "--user",
    security.runAsUser,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    security.networkMode,
    "--memory",
    String(limits.memoryBytes),
    // memory-swap == memory ⇒ 无 swap（候选限额经 §1.4 实测冻结）
    "--memory-swap",
    String(limits.memoryBytes),
    "--pids-limit",
    String(limits.pidsLimit),
    "--cpus",
    String(limits.cpus),
    "--tmpfs",
    `/work:size=${String(limits.workTmpfsBytes)},mode=1777`,
    "--tmpfs",
    `/tmp:size=${String(limits.tmpTmpfsBytes)},mode=1777`,
    "--restart",
    "no",
    "--log-driver",
    "none",
  ];
}
