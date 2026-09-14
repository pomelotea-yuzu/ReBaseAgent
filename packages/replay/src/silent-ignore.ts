import type { Scalar } from "@rebaseagent/agent-loop";

/**
 * 「已知静默忽略」知识库（纯数据 + 纯函数，零 fs / 零网络）。
 *
 * 为什么是告警不是门禁：条目基于**本机抽样实测**，provider 行为随版本漂移；
 * 且部分绕行方式（`num_ctx` → 派生模型）恰恰要求用户继续保留该键在别处生效的意图，
 * 硬拒绝会把合法绕行也堵死。告警只负责"让你知道"，不阻断执行。
 *
 * 为什么放 replay 不放 agent-loop：告警只发生在"参数实验编排"场景（A/B 臂、dry-run），
 * agent-loop 是纯执行库不该带 provider 知识；replay 是编排层，CLI 与桌面都从它取结果
 * （同源，双端不各写一份）。
 *
 * 首期只录两条（都有 2026-09-10 dogfood 实测记录），不追 API 面、不做官方适配——
 * 这是"已知坑的路标"，不是 provider 档案。
 */

/** 一条静默忽略记录 */
export interface SilentIgnoreRule {
  provider: "ollama";
  /** baseURL 识别启发式（本机 11434 或路径含 ollama） */
  matches: (baseURL: string) => boolean;
  /** 命中的参数键 */
  keys: string[];
  /** 实测结论原文（含日期） */
  reason: string;
  /** 实测过的绕行方式 */
  workaround: string;
}

/** 命中知识库的告警（供 CLI 输出与桌面展示） */
export interface SilentIgnoreWarning {
  /** 命中的参数键 */
  key: string;
  provider: string;
  /** 风险描述（实测结论） */
  reason: string;
  /** 绕行方式 */
  workaround: string;
}

/** baseURL 是否指向本机 / 任意 Ollama（11434 端口或路径含 ollama） */
function isOllama(baseURL: string): boolean {
  const lower = baseURL.toLowerCase();
  return lower.includes(":11434") || lower.includes("ollama");
}

/**
 * 首期知识库：两条 Ollama `/v1` 实测记录（2026-09-10）。
 * 新增条目必须附实测日期与具体行为，不接受"听说 provider X 不支持 Y"。
 */
export const SILENT_IGNORE_RULES: SilentIgnoreRule[] = [
  {
    provider: "ollama",
    matches: isOllama,
    keys: ["num_ctx"],
    reason:
      "Ollama /v1 静默忽略 num_ctx（顶层 / 嵌套 options / 字符串三种写法均不认，实测 2026-09-10）：HTTP 200、无警告，上下文长度仍是模型默认值",
    workaround:
      "派生模型（Modelfile 中 PARAMETER num_ctx N 后 ollama create），再以派生模型名发起请求",
  },
  {
    provider: "ollama",
    matches: isOllama,
    keys: ["think"],
    reason:
      "Ollama /v1 顶层 think 无效（实测 2026-09-10）：不报错但思维链行为不变，须改用 OpenAI 兼容的 reasoning_effort",
    workaround:
      '改传 reasoning_effort（如 reasoning_effort: "none" 关思考）——实测与生产结果逐字一致',
  },
];

/**
 * 按 baseURL 与 params 计算静默忽略告警。
 *
 * 返回空数组 = 未命中，**不构成"参数已生效"的证据**（知识库只是已知坑的抽样）。
 * 同一键命中多条规则时全部返回（同一 provider 的重复条目按 key 去重）。
 */
export function warnSilentIgnores(
  baseURL: string,
  params: Record<string, Scalar>,
): SilentIgnoreWarning[] {
  const warnings: SilentIgnoreWarning[] = [];
  const seen = new Set<string>();
  for (const rule of SILENT_IGNORE_RULES) {
    if (!rule.matches(baseURL)) continue;
    for (const key of rule.keys) {
      if (!(key in params)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        key,
        provider: rule.provider,
        reason: rule.reason,
        workaround: rule.workaround,
      });
    }
  }
  return warnings;
}
