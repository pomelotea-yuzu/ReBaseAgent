import { describe, expect, it } from "vitest";
import {
  CLI_LOCALE_ENV,
  CLI_LOCALE_EXIT_CODE,
  CLI_LOCALE_FLAG,
  createTranslator,
  hostIntlLocale,
  resolveCliLocale,
} from "../src/index.js";

const emptyEnv = {};

function expectInvalid(outcome: ReturnType<typeof resolveCliLocale>) {
  if (outcome.ok) throw new Error("期望 INVALID_LOCALE，实际解析成功");
  return outcome;
}

describe("cli-locale：优先级与系统回退", () => {
  it("--locale 优先于产品环境变量、系统环境与 Intl", () => {
    const outcome = resolveCliLocale({
      argv: ["--data-dir", "D:/data", CLI_LOCALE_FLAG, "en-US"],
      env: { [CLI_LOCALE_ENV]: "zh-CN", LC_ALL: "zh_TW.UTF-8", LANG: "fr_FR.UTF-8" },
      intlLocale: "fr-FR",
    });
    expect(outcome).toEqual({ ok: true, locale: "en-US", source: "flag" });
  });

  it("没有 --locale 时 REBASEAGENT_LOCALE 优先于系统环境", () => {
    const outcome = resolveCliLocale({
      argv: [],
      env: { [CLI_LOCALE_ENV]: "en-US", LC_ALL: "zh_TW.UTF-8" },
      intlLocale: "zh-CN",
    });
    expect(outcome).toEqual({ ok: true, locale: "en-US", source: "env" });
  });

  it("系统候选按 LC_ALL > LC_MESSAGES > LANG 取首个非空值", () => {
    expect(
      resolveCliLocale({
        argv: [],
        env: { LC_ALL: "zh_TW.UTF-8", LC_MESSAGES: "en_US.UTF-8", LANG: "en_US.UTF-8" },
        intlLocale: null,
      }),
    ).toEqual({ ok: true, locale: "zh-CN", source: "system" });

    expect(
      resolveCliLocale({
        argv: [],
        env: { LC_ALL: "", LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" },
        intlLocale: null,
      }),
    ).toEqual({ ok: true, locale: "zh-CN", source: "system" });

    expect(
      resolveCliLocale({
        argv: [],
        env: { LC_ALL: "   ", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" },
        intlLocale: null,
      }),
    ).toEqual({ ok: true, locale: "zh-CN", source: "system" });
  });

  it("C/POSIX 与非 zh 系统语言归英文，且 C 是首个非空值时不再看 LANG", () => {
    for (const value of ["C", "C.UTF-8", "POSIX", "fr_FR.UTF-8", "en_US.UTF-8"]) {
      expect(
        resolveCliLocale({
          argv: [],
          env: { LC_ALL: value, LC_MESSAGES: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" },
          intlLocale: "zh-CN",
        }),
      ).toEqual({ ok: true, locale: "en-US", source: "system" });
    }
  });

  it("没有 LC_* / LANG 时使用 Intl 建议语言", () => {
    expect(resolveCliLocale({ argv: [], env: emptyEnv, intlLocale: "zh-Hant-TW" })).toEqual({
      ok: true,
      locale: "zh-CN",
      source: "system",
    });
    expect(resolveCliLocale({ argv: [], env: emptyEnv, intlLocale: "fr-FR" })).toEqual({
      ok: true,
      locale: "en-US",
      source: "system",
    });
  });

  it("没有系统语言时回退英文", () => {
    for (const intlLocale of [undefined, null, ""]) {
      expect(resolveCliLocale({ argv: [], env: emptyEnv, intlLocale })).toEqual({
        ok: true,
        locale: "en-US",
        source: "fallback",
      });
    }
    expect(resolveCliLocale({ argv: [], env: { LANG: "   " }, intlLocale: null })).toEqual({
      ok: true,
      locale: "en-US",
      source: "fallback",
    });
  });
});

describe("cli-locale：宿主 Intl 检测", () => {
  it("Intl 缺失、抛错或返回空串时给 null，不抛异常", () => {
    expect(
      hostIntlLocale({
        DateTimeFormat: () => ({ resolvedOptions: () => ({ locale: "" }) }),
      }),
    ).toBeNull();
    expect(
      hostIntlLocale({
        DateTimeFormat: () => {
          throw new Error("Intl unavailable");
        },
      }),
    ).toBeNull();
  });

  it("正常返回宿主建议语言", () => {
    expect(
      hostIntlLocale({
        DateTimeFormat: () => ({ resolvedOptions: () => ({ locale: "zh-Hant-TW" }) }),
      }),
    ).toBe("zh-Hant-TW");
  });
});

describe("cli-locale：非法显式值先于执行失败", () => {
  it("--locale 重复判 INVALID_LOCALE，说明语言取首个有效显式值", () => {
    const outcome = expectInvalid(
      resolveCliLocale({
        argv: [CLI_LOCALE_FLAG, "zh-CN", CLI_LOCALE_FLAG, "en-US"],
        env: emptyEnv,
        intlLocale: "en-US",
      }),
    );
    expect(outcome.code).toBe("INVALID_LOCALE");
    expect(outcome.reason).toBe("duplicate-flag");
    expect(outcome.messageKey).toBe("cli.localeDuplicateFlag");
    expect(outcome.messageLocale).toBe("zh-CN");
    expect(CLI_LOCALE_EXIT_CODE).toBe(2);
  });

  it("--locale 缺值（结尾或紧跟另一个参数）判 INVALID_LOCALE", () => {
    for (const argv of [[CLI_LOCALE_FLAG], [CLI_LOCALE_FLAG, "--data-dir", "D:/data"]]) {
      const outcome = expectInvalid(
        resolveCliLocale({ argv, env: { LANG: "zh_TW.UTF-8" }, intlLocale: null }),
      );
      expect(outcome.reason).toBe("missing-value");
      expect(outcome.messageKey).toBe("cli.localeMissingValue");
      expect(outcome.messageLocale).toBe("zh-CN");
    }
  });

  it("--locale 只接受两个规范值，不做大小写/区域猜测", () => {
    for (const value of ["zh", "zh-cn", "en", "en_US", "fr-FR", " zh-CN", "zh-CN "]) {
      const outcome = expectInvalid(
        resolveCliLocale({
          argv: [CLI_LOCALE_FLAG, value],
          env: { [CLI_LOCALE_ENV]: "en-US" },
          intlLocale: "zh-CN",
        }),
      );
      expect(outcome.reason).toBe("unsupported-value");
      expect(outcome.messageKey).toBe("cli.localeUnsupportedValue");
      expect(outcome.messageLocale).toBe("en-US");
    }
  });

  it("生效的 REBASEAGENT_LOCALE 非法判 INVALID_LOCALE；空串视为未设置", () => {
    const outcome = expectInvalid(
      resolveCliLocale({
        argv: [],
        env: { [CLI_LOCALE_ENV]: "fr-FR", LANG: "zh_TW.UTF-8" },
        intlLocale: "en-US",
      }),
    );
    expect(outcome.reason).toBe("invalid-env-value");
    expect(outcome.messageKey).toBe("cli.localeInvalidEnvValue");
    expect(outcome.messageLocale).toBe("zh-CN");

    expect(
      resolveCliLocale({
        argv: [],
        env: { [CLI_LOCALE_ENV]: "" },
        intlLocale: "zh-Hant-TW",
      }),
    ).toEqual({ ok: true, locale: "zh-CN", source: "system" });

    const whitespace = expectInvalid(
      resolveCliLocale({
        argv: [],
        env: { [CLI_LOCALE_ENV]: " en-US" },
        intlLocale: null,
      }),
    );
    expect(whitespace.reason).toBe("invalid-env-value");
    expect(whitespace.messageLocale).toBe("en-US");
  });

  it("显式非法且无其它有效选择时，说明语言回退英文而非非法值", () => {
    const outcome = expectInvalid(
      resolveCliLocale({
        argv: [CLI_LOCALE_FLAG, "fr-FR"],
        env: emptyEnv,
        intlLocale: null,
      }),
    );
    expect(outcome.messageLocale).toBe("en-US");
    const translator = createTranslator({ locale: outcome.messageLocale });
    expect(translator.t(outcome.messageKey)).toBe(
      "Unsupported locale option: --locale accepts only zh-CN or en-US",
    );
  });
});

describe("cli-locale：受控说明双语且不回显参数", () => {
  it("四种原因各有独立中英文说明", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });

    expect(zh.t("cli.localeDuplicateFlag")).toBe("语言参数重复：--locale 只能出现一次");
    expect(en.t("cli.localeDuplicateFlag")).toBe(
      "Duplicate locale option: --locale may appear only once",
    );
    expect(zh.t("cli.localeMissingValue")).toBe("语言参数缺值：--locale 需要 zh-CN 或 en-US");
    expect(en.t("cli.localeMissingValue")).toBe(
      "Missing locale value: --locale requires zh-CN or en-US",
    );
    expect(zh.t("cli.localeUnsupportedValue")).toBe(
      "语言参数不支持：--locale 只接受 zh-CN 或 en-US",
    );
    expect(en.t("cli.localeUnsupportedValue")).toBe(
      "Unsupported locale option: --locale accepts only zh-CN or en-US",
    );
    expect(zh.t("cli.localeInvalidEnvValue")).toBe(
      "环境变量 REBASEAGENT_LOCALE 不支持：只接受 zh-CN 或 en-US",
    );
    expect(en.t("cli.localeInvalidEnvValue")).toBe(
      "Unsupported REBASEAGENT_LOCALE value: only zh-CN or en-US are accepted",
    );
  });

  it("说明文本不包含调用方传入的非法值", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const cases = [
      expectInvalid(
        resolveCliLocale({
          argv: [CLI_LOCALE_FLAG, "fr-FR"],
          env: { LANG: "zh_TW.UTF-8" },
          intlLocale: null,
        }),
      ),
      expectInvalid(
        resolveCliLocale({
          argv: [],
          env: { [CLI_LOCALE_ENV]: "xx-YY" },
          intlLocale: "zh-CN",
        }),
      ),
    ];
    for (const outcome of cases) {
      const text = zh.t(outcome.messageKey);
      expect(text).not.toContain("fr-FR");
      expect(text).not.toContain("xx-YY");
    }
  });
});
