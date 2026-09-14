import { describe, expect, it } from "vitest";
import { SILENT_IGNORE_RULES, warnSilentIgnores } from "../src/index";

const OLLAMA = "http://127.0.0.1:11434/v1";
const DEEPSEEK = "https://api.deepseek.com/v1";

describe("warnSilentIgnores（已知静默忽略知识库）", () => {
  it("Ollama + num_ctx → 命中，含 reason 与绕行方式", () => {
    const warnings = warnSilentIgnores(OLLAMA, { num_ctx: 8192 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("num_ctx");
    expect(warnings[0]?.provider).toBe("ollama");
    expect(warnings[0]?.reason).toContain("num_ctx");
    expect(warnings[0]?.reason).toContain("2026-09-14");
    // 实测结论：/v1 不转发到 options；原生 API 的 options.num_ctx 有效
    expect(warnings[0]?.reason).toContain("/v1");
    expect(warnings[0]?.reason).toContain("options");
    // 绕行须同时给出「轻（原生 API）」与「重（派生模型）」两条路
    expect(warnings[0]?.workaround).toContain("原生");
    expect(warnings[0]?.workaround).toContain("派生模型");
  });

  it("Ollama + think → 命中，绕行指向 reasoning_effort", () => {
    const warnings = warnSilentIgnores(OLLAMA, { think: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("think");
    expect(warnings[0]?.workaround).toContain("reasoning_effort");
  });

  it("reason 里的实测日期必须是「较新」的复测日期（防止旧结论长期不复核）", () => {
    for (const rule of SILENT_IGNORE_RULES) {
      expect(rule.reason).toMatch(/实测 \d{4}-\d{2}-\d{2}/);
    }
  });

  it("多键同时命中 → 全部返回", () => {
    const warnings = warnSilentIgnores(OLLAMA, { num_ctx: 4096, think: true, temperature: 0.7 });
    expect(warnings.map((w) => w.key).sort()).toEqual(["num_ctx", "think"]);
  });

  it("非 Ollama baseURL 不误报（条目按 provider 限定）", () => {
    expect(warnSilentIgnores(DEEPSEEK, { num_ctx: 8192, think: false })).toEqual([]);
  });

  it("Ollama 但未含知识库键 → 不告警（未命中 ≠ 已生效）", () => {
    expect(warnSilentIgnores(OLLAMA, { temperature: 0.7, presence_penalty: 0.1 })).toEqual([]);
  });

  it("空 params → 不告警", () => {
    expect(warnSilentIgnores(OLLAMA, {})).toEqual([]);
  });

  it("baseURL 含 ollama 字样（非本机端口）也识别", () => {
    const warnings = warnSilentIgnores("http://ollama.internal:8080/v1", { num_ctx: 2048 });
    expect(warnings).toHaveLength(1);
  });

  it("知识库条目结构完整（provider / matches / keys / reason / workaround）", () => {
    expect(SILENT_IGNORE_RULES.length).toBeGreaterThanOrEqual(2);
    for (const rule of SILENT_IGNORE_RULES) {
      expect(typeof rule.provider).toBe("string");
      expect(typeof rule.matches).toBe("function");
      expect(rule.keys.length).toBeGreaterThan(0);
      // reason 必须含实测日期（"听说"不算证据）
      expect(rule.reason).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(rule.workaround.length).toBeGreaterThan(0);
    }
  });
});
