import type { MessageKey, MissingKeyEvent } from "@rebaseagent/i18n";
import { useMemo } from "react";
import { describe, expect, it } from "vitest";
import { Trans, useTranslator } from "../../src/renderer/src/i18n/index";
import { createTestTranslator, renderWithLocale } from "./render-with-locale";

function UnknownLabel() {
  const { t } = useTranslator();
  return <span>{t("common.unknown")}</span>;
}

function StepCount({ count }: { readonly count: number }) {
  const { t } = useTranslator();
  return <span>{t("common.stepCount", { count })}</span>;
}

function RichSummary() {
  return (
    <Trans
      i18nKey="common.runSummaryRich"
      values={{ runId: "r_01", stepCount: 3, duration: "1.2s" }}
      components={{ code: <code />, strong: <strong /> }}
    />
  );
}

function DeleteConfirm({ name }: { readonly name: string }) {
  return (
    <Trans i18nKey="common.deleteRunConfirm" values={{ name }} components={{ code: <code /> }} />
  );
}

function EnglishFallback() {
  const translator = useTranslator();
  useMemo(() => {
    translator.instance.removeResourceBundle("en-US", "common");
  }, [translator]);
  return <span>{translator.t("common.unknown")}</span>;
}

function MissingProbe() {
  const { t } = useTranslator();
  return <span>{t("run.missingKey" as MessageKey, { secret: "do-not-log" })}</span>;
}

describe("React 同步 Provider（S01/S03/S04）", () => {
  it("S01：Node 静态渲染首次同步得到完整对应文案", () => {
    expect(renderWithLocale("zh-CN", <UnknownLabel />)).toBe("<span>未知</span>");
    expect(renderWithLocale("en-US", <UnknownLabel />)).toBe("<span>Unknown</span>");
    expect(createTestTranslator("zh-CN").t("common.back")).toBe("返回");
    expect(createTestTranslator("en-US").t("common.back")).toBe("Back");
  });

  it("S03：0/1/2/大数复数正确，中文量词自然", () => {
    expect(renderWithLocale("en-US", <StepCount count={0} />)).toBe("<span>0 steps</span>");
    expect(renderWithLocale("en-US", <StepCount count={1} />)).toBe("<span>1 step</span>");
    expect(renderWithLocale("en-US", <StepCount count={2} />)).toBe("<span>2 steps</span>");
    expect(renderWithLocale("en-US", <StepCount count={100} />)).toBe("<span>100 steps</span>");
    expect(renderWithLocale("zh-CN", <StepCount count={1} />)).toBe("<span>1 步</span>");
    expect(renderWithLocale("zh-CN", <StepCount count={100} />)).toBe("<span>100 步</span>");
  });

  it("S03：富文本槽位可调序，参数保持原值且不作为 HTML 执行", () => {
    expect(renderWithLocale("en-US", <RichSummary />)).toBe(
      "1.2s · <strong>3</strong> steps · <code>r_01</code>",
    );
    expect(renderWithLocale("zh-CN", <RichSummary />)).toBe(
      "运行 <code>r_01</code>：<strong>3</strong> 步 · 1.2s",
    );

    const html = renderWithLocale(
      "en-US",
      <DeleteConfirm name={'<img src=x onerror="alert(1)">'} />,
    );
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("S04：英文缺键回退中文同键，两语言缺键给通用提示", () => {
    expect(renderWithLocale("en-US", <EnglishFallback />)).toBe("<span>未知</span>");

    const events: MissingKeyEvent[] = [];
    const html = renderWithLocale("en-US", <MissingProbe />, {
      onMissingKey: (event) => events.push(event),
    });
    expect(html).toBe("<span>This message is unavailable</span>");
    expect(html).not.toContain("missingKey");
    expect(events).toEqual([{ locale: "en-US", namespace: "run", key: "missingKey" }]);
    expect(JSON.stringify(events)).not.toContain("do-not-log");
    // 回退只是运行期容错；发行门禁仍由 check:i18n（任务 0.5）判失败。
  });
});
