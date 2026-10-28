#!/usr/bin/env node
/**
 * check:i18n：双语资源完整性 + 分批归属 + 英文硬编码审查门禁。
 *
 * 运行前提：packages/* 已构建（check:ci 的 check:build 在前），脚本直接读取
 * packages/i18n/dist 的资源，确保门禁检查的是即将被测试/打包的产物，而不是 src 的旁路副本。
 *
 * 用法：
 *   node scripts/check-i18n.mjs            中间态：待迁移项允许存在
 *   node scripts/check-i18n.mjs --final    收口：产品待迁移必须为零
 *   node scripts/check-i18n.mjs --selftest 反证：缺键/参数/复数/槽位/迁移状态必须判红
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FINAL = process.argv.includes("--final");

function paramsOf(text) {
  return new Set([...text.matchAll(/{{\s*([\w.]+)\s*}}/g)].map((m) => m[1]));
}

function tagsOf(text) {
  return [...text.matchAll(/<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?\/?>/g)].map((m) => m[1]);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function checkTags(text, allowedTags, add, where) {
  for (const tag of tagsOf(text)) {
    if (!allowedTags.includes(tag)) {
      add("RICH_TEXT_TAG", `${where} 使用未允许的富文本标签 <${tag}>`);
    }
  }
  const stack = [];
  for (const match of text.matchAll(/<(\/?)([a-zA-Z][\w-]*)(?:\s[^>]*)?(\/?)>/g)) {
    const [, closing, tag, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== tag) {
        add("RICH_TEXT_UNBALANCED", `${where} 富文本槽位 <${tag}> 不配对`);
        return;
      }
    } else {
      stack.push(tag);
    }
  }
  if (stack.length > 0)
    add("RICH_TEXT_UNBALANCED", `${where} 富文本槽位未闭合：${stack.join(", ")}`);
}

function checkString(value, where, add, allowedTags, enValue) {
  if (typeof value !== "string" || value.trim() === "") {
    add("EMPTY_VALUE", `${where} 为空`);
    return;
  }
  const params = paramsOf(value);
  if (enValue !== undefined) {
    const enParams = paramsOf(enValue);
    if (!sameSet(params, enParams)) {
      add(
        "PARAM_MISMATCH",
        `${where} 参数不一致：zh=[${[...params].join(",")}] en=[${[...enParams].join(",")}]`,
      );
    }
  }
  checkTags(value, allowedTags, add, where);
}

export function validateCatalogs(zh, en, allowedTags) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const zhNamespaces = Object.keys(zh).sort();
  const enNamespaces = Object.keys(en).sort();
  if (zhNamespaces.join(",") !== enNamespaces.join(",")) {
    add("NAMESPACE_MISMATCH", `namespace 不一致：zh=[${zhNamespaces}] en=[${enNamespaces}]`);
    return errors;
  }
  for (const namespace of zhNamespaces) {
    const zhKeys = Object.keys(zh[namespace]).sort();
    const enKeys = Object.keys(en[namespace]).sort();
    for (const key of zhKeys) {
      if (!enKeys.includes(key)) {
        add("MISSING_KEY", `en-US 缺键：${namespace}.${key}`);
        continue;
      }
      const where = `${namespace}.${key}`;
      const zhValue = zh[namespace][key];
      const enValue = en[namespace][key];
      if (typeof zhValue !== typeof enValue) {
        add("TYPE_MISMATCH", `${where} 类型不一致（string/复数对象）`);
        continue;
      }
      if (typeof zhValue === "string") {
        checkString(zhValue, `zh-CN ${where}`, add, allowedTags);
        checkString(enValue, `en-US ${where}`, add, allowedTags, zhValue);
        continue;
      }
      if (zhValue.other === undefined || typeof zhValue.other !== "string") {
        add("PLURAL_BRANCH", `zh-CN ${where} 缺复数 other 分支`);
      }
      if (enValue.one === undefined || typeof enValue.one !== "string") {
        add("PLURAL_BRANCH", `en-US ${where} 缺复数 one 分支`);
      }
      if (enValue.other === undefined || typeof enValue.other !== "string") {
        add("PLURAL_BRANCH", `en-US ${where} 缺复数 other 分支`);
      }
      if (typeof zhValue.other === "string") {
        checkString(zhValue.other, `zh-CN ${where}.other`, add, allowedTags);
      }
      if (typeof enValue.other === "string") {
        checkString(enValue.other, `en-US ${where}.other`, add, allowedTags, zhValue.other);
      }
      if (typeof enValue.one === "string") {
        checkString(enValue.one, `en-US ${where}.one`, add, allowedTags);
        const zhParams = paramsOf(String(zhValue.other ?? ""));
        for (const param of paramsOf(enValue.one)) {
          if (param !== "count" && !zhParams.has(param)) {
            add("PARAM_MISMATCH", `en-US ${where}.one 参数 ${param} 在中文复数分支中不存在`);
          }
        }
      }
    }
    for (const key of enKeys) {
      if (!zhKeys.includes(key)) add("EXTRA_KEY", `zh-CN 缺键（en-US 多余）：${namespace}.${key}`);
    }
  }
  return errors;
}

export function validateManifest(manifest, { final = false } = {}) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (!Array.isArray(manifest.files)) {
    add("MANIFEST_SCHEMA", "attribution.json 缺 files 数组");
    return errors;
  }
  for (const file of manifest.files) {
    const product = (file.symbols ?? [])
      .filter((symbol) => symbol.classification === "product")
      .reduce((sum, symbol) => sum + symbol.count, 0);
    if (!["pending", "migrated", "excluded"].includes(file.status)) {
      add("MANIFEST_STATUS", `${file.path} 状态未知：${file.status}`);
    }
    if (file.status === "migrated" && product > 0) {
      add("MIGRATED_PRODUCT", `${file.path} 已标记 migrated 仍有 ${product} 处产品文案`);
    }
    if (
      file.status === "pending" &&
      !(Number.isInteger(file.batch) && file.batch >= 1 && file.batch <= 4)
    ) {
      add("MISSING_BATCH", `${file.path} 产品文件缺少批次（1–4）`);
    }
    if (file.status === "excluded") {
      const reason = file.reason ?? (file.symbols ?? []).find((symbol) => symbol.reason)?.reason;
      if (!reason) add("EXCLUDED_REASON", `${file.path} 排除项缺少理由`);
    }
    if (final && file.status === "pending" && product > 0) {
      add("FINAL_PENDING", `${file.path} 收口仍有 ${product} 处产品待迁移`);
    }
  }
  return errors;
}

export function validateEnglishReviews(candidates) {
  const errors = [];
  for (const candidate of candidates.candidates ?? []) {
    if (!["product", "fragment", "technical"].includes(candidate.review)) {
      errors.push({
        code: "ENGLISH_REVIEW",
        message: `英文候选未审查：${candidate.file} :: ${candidate.text}（review=${candidate.review ?? "missing"}）`,
      });
    }
  }
  return errors;
}

function validateBoundaryConfig() {
  const errors = [];
  const add = (message) => errors.push({ code: "BOUNDARY", message });
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const desktopPkg = JSON.parse(readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8"));
  const i18nPkg = JSON.parse(readFileSync(join(ROOT, "packages/i18n/package.json"), "utf8"));
  const forbidden = ["jsdom", "i18next-http-backend", "i18next-browser-languagedetector"];
  for (const [name, pkg] of [
    ["root", rootPkg],
    ["desktop", desktopPkg],
  ]) {
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (forbidden.includes(dep) || dep.startsWith("@testing-library/")) {
        add(`${name} 不得新增 DOM/网络语言依赖：${dep}`);
      }
    }
  }
  const i18nDeps = Object.keys(i18nPkg.dependencies ?? {});
  if (i18nDeps.length !== 1 || i18nDeps[0] !== "i18next") {
    add(`packages/i18n 只允许依赖 i18next，实际：${i18nDeps.join(",") || "<none>"}`);
  }
  const vitestConfig = readFileSync(join(ROOT, "apps/desktop/vitest.config.ts"), "utf8");
  if (!/environment:\s*"node"/.test(vitestConfig)) {
    add("desktop vitest 必须保持 environment: node（不引入 DOM 测试环境）");
  }
  return errors;
}

async function loadCatalogs() {
  const dist = join(ROOT, "packages/i18n/dist");
  const zhPath = join(dist, "resources/zh-CN.js");
  const enPath = join(dist, "resources/en-US.js");
  const tagsPath = join(dist, "rich-text.js");
  for (const [name, path] of [
    ["zh-CN", zhPath],
    ["en-US", enPath],
    ["rich-text", tagsPath],
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        `缺少 ${name} 构建产物：${path}\n先运行 check:build（check:ci 已保证构建先于本门禁）`,
      );
    }
  }
  const zh = (await import(pathToFileURL(zhPath).href)).zhCN;
  const en = (await import(pathToFileURL(enPath).href)).enUS;
  const tags = (await import(pathToFileURL(tagsPath).href)).RICH_TEXT_TAGS;
  return { zh, en, tags };
}

function runAttributionCheck() {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/i18n-attribution.cjs"), "--check"],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  return result.status ?? 1;
}

function loadJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
}

function printErrors(errors) {
  for (const error of errors) console.error(`[check:i18n] ${error.code}: ${error.message}`);
}

export function runSelfTest() {
  const failures = [];
  const tags = ["code", "strong", "link"];
  const zh = {
    common: {
      unknown: "未知",
      confirm: "删除 <code>{{name}}</code>",
      stepCount: { other: "{{count}} 步" },
    },
    run: {},
  };
  const en = {
    common: {
      unknown: "Unknown",
      confirm: "Delete <code>{{name}}</code>",
      stepCount: { one: "{{count}} step", other: "{{count}} steps" },
    },
    run: {},
  };
  const expect = (name, actual, code) => {
    if (!actual.some((error) => error.code === code)) {
      failures.push(`${name}: 期望 ${code}，实际 ${JSON.stringify(actual.map((e) => e.code))}`);
    }
  };
  const positive = validateCatalogs(zh, en, tags);
  if (positive.length > 0) failures.push(`正例不应报错：${JSON.stringify(positive)}`);

  const missing = structuredClone(en);
  Reflect.deleteProperty(missing.common, "unknown");
  expect("英文缺键", validateCatalogs(zh, missing, tags), "MISSING_KEY");

  const extraParam = structuredClone(en);
  extraParam.common.confirm = "Delete <code>{{name}} {{extra}}</code>";
  expect("参数不一致", validateCatalogs(zh, extraParam, tags), "PARAM_MISMATCH");

  const noOne = structuredClone(en);
  noOne.common.stepCount = { other: "{{count}} steps" };
  expect("缺 one 分支", validateCatalogs(zh, noOne, tags), "PLURAL_BRANCH");

  const badTag = structuredClone(zh);
  badTag.common.confirm = "删除 <script>{{name}}</script>";
  expect("未允许槽位", validateCatalogs(badTag, en, tags), "RICH_TEXT_TAG");

  const unbalanced = structuredClone(zh);
  unbalanced.common.confirm = "删除 <code>{{name}}";
  expect("槽位不配对", validateCatalogs(unbalanced, en, tags), "RICH_TEXT_UNBALANCED");

  const migrated = {
    files: [
      {
        path: "x.ts",
        status: "migrated",
        batch: 1,
        reason: null,
        symbols: [{ symbol: "x", role: "ui_text", classification: "product", count: 1 }],
      },
    ],
  };
  expect("已迁移仍含产品文案", validateManifest(migrated), "MIGRATED_PRODUCT");
  expect("收口仍有待迁移", validateManifest(migrated, { final: true }), "MIGRATED_PRODUCT");
  const pending = structuredClone(migrated);
  pending.files[0].status = "pending";
  expect("收口阻止 pending", validateManifest(pending, { final: true }), "FINAL_PENDING");
  const noBatch = structuredClone(pending);
  noBatch.files[0].batch = null;
  expect("缺批次", validateManifest(noBatch), "MISSING_BATCH");
  const excluded = structuredClone(migrated);
  excluded.files[0].status = "excluded";
  excluded.files[0].symbols[0].reason = null;
  expect("排除无理由", validateManifest(excluded), "EXCLUDED_REASON");

  expect(
    "英文候选未审查",
    validateEnglishReviews({ candidates: [{ file: "a.tsx", text: "Run", review: "pending" }] }),
    "ENGLISH_REVIEW",
  );

  const temp = mkdtempSync(join(tmpdir(), "i18n-gate-"));
  try {
    const tampered = structuredClone(loadJson("i18n/attribution.json"));
    tampered.files[0].symbols[0].count += 1;
    const fixture = join(temp, "attribution.json");
    writeFileSync(fixture, JSON.stringify(tampered));
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/i18n-attribution.cjs"), "--check", "--manifest", fixture],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (result.status === 0) failures.push("归属漂移未被发现（篡改计数后 --check 仍通过）");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`[check:i18n] --selftest FAIL: ${failure}`);
    return 1;
  }
  console.log("[check:i18n] --selftest 通过（11 个反例 + 1 个正例）");
  return 0;
}

async function main() {
  if (process.argv.includes("--selftest")) {
    process.exit(runSelfTest());
  }

  let catalogs;
  try {
    catalogs = await loadCatalogs();
  } catch (error) {
    console.error(`[check:i18n] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const errors = [
    ...validateCatalogs(catalogs.zh, catalogs.en, catalogs.tags),
    ...validateManifest(loadJson("i18n/attribution.json"), { final: FINAL }),
    ...validateEnglishReviews(loadJson("i18n/english-product-candidates.json")),
    ...validateBoundaryConfig(),
  ];
  const attributionStatus = runAttributionCheck();
  if (attributionStatus !== 0) {
    errors.push({
      code: "ATTRIBUTION_DRIFT",
      message: "源码候选与 i18n/attribution.json 不一致（见上方差异）",
    });
  }
  if (errors.length > 0) {
    printErrors(errors);
    console.error(`[check:i18n] 失败：${errors.length} 项`);
    process.exit(1);
  }
  const manifest = loadJson("i18n/attribution.json");
  console.log(
    `[check:i18n] 通过：${catalogs.zh && Object.keys(catalogs.zh).length} 个 namespace，` +
      `${manifest.files.length} 个归属文件，英文候选全部已审查${FINAL ? "（final）" : ""}`,
  );
}

await main();
