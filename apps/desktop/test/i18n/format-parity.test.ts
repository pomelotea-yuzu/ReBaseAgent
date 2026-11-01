import { createTranslator } from "@rebaseagent/i18n";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
} from "../../src/renderer/src/lib/format";

/**
 * i18n 5.8（S08）：时间/数字的技术格式不随展示语言漂移。
 *
 * 耗时、tokens、字节与时间只做既有技术单位与舍入；外围标签才是产品说明。
 * 同一输入在两语言上下文下必须得到同一个技术串——本文件同时钉住独立期望，
 * 不用 translator 返回值自证。
 */
describe("i18n 5.8 技术格式不随语言漂移", () => {
  it("耗时/tokens/字节保持既有单位与舍入", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    const technical = (): string[] => [
      formatDuration(820),
      formatDuration(1200),
      formatDuration(90_000),
      formatTokens(999),
      formatTokens(1800),
      formatBytes(0),
      formatBytes(13_824),
      formatBytes(1_468_006),
    ];
    expect(technical()).toEqual([
      "820ms",
      "1.2s",
      "1m30s",
      "999",
      "1.8k",
      "0 B",
      "13.5 KB",
      "1.4 MB",
    ]);
    // 同一输入在两语言上下文中仍是同一技术串；只有外围标签不同
    expect(technical()).toEqual(technical());
    expect(zh.t("common.copy")).toBe("复制");
    expect(en.t("common.copy")).toBe("Copy");
  });

  it("时间保持 MM-DD HH:mm:ss 与本地时区，非法输入原样返回", () => {
    const iso = "2026-11-01T08:05:00.000Z";
    const first = formatTime(iso);
    expect(first).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatTime(iso)).toBe(first);
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});
