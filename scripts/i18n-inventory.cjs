#!/usr/bin/env node
/**
 * i18n 文案盘点（只读）：AST 解析桌面端与 packages 的中文字符串，按层/工作区/角色统计，
 * 并对测试断言做 UI / 领域消息 / 未归属归类。结果写入 .tmp/i18n-inventory.json。
 * 口径与已知局限见 docs/engineering/reports/2026-10-28-i18n-text-inventory.md。
 * 复跑：node scripts/i18n-inventory.cjs
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const HAN = /\p{Script=Han}/u;
const SKIP_DIRS = new Set([
  "node_modules", "dist", "out", ".rebaseagent", ".vite", ".tmp",
  "release", "release-win", "build",
]);

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, exts, out);
    } else if (exts.includes(path.extname(ent.name)) && !ent.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const baseName = (p) => path.basename(p).replace(/\.(tsx?|css|html)$/, "");

/* ---------- workspace mapping (approximate, by filename) ---------- */

const RENDERER_RULES = [
  ["创建运行", /^(CreateRunWorkspace|create-run|create-workspace|entry-gate)$/],
  ["重跑/分叉", /^(MessagesWorkspace|MessagesForkEditor|MessagesResults|RunActionsBar|ResultForkEditor|PromptForkEditor|IsolatedPromptEntry|isolated-fork|isolated-prompt|prompt-fork|fork-cache-hint|messages-)/],
  ["录制接入", /^(RecordingWorkspace|RecordingWorkspaceView|recording-draft|proxy-)/],
  ["模型实验", /^(ExperimentWorkspace|ExperimentResults|ModelAbEditor|AbBatchResult|experiment-results|model-ab|prompt-experiment-view)/],
  ["比较工作区", /^(CompareWorkspace|CompareWorkspaceView|CompareFileWorkspace|CompareMetricsTable|CompareSelectionBar|compare-|DraftCompareGrid|DraftListPanel|DraftSourceBanner|draft-|verification-compare)/],
  ["文件工作区", /^(WorkspaceFilesPanel|WorkspaceFileView|WorkspaceFileViewBody|FileContent|workspace-file|workspace-files|file-)/],
  ["项目验证", /^(VerificationPanel|verification-)/],
  ["设置", /^(SettingsDialog|settings-form)$/],
  ["辅助/导出", /^(AuxWorkspaceFrame|WorkspaceExportPanel|aux-workspace|workspace-export-state)/],
  ["运行总览/详情", /^(RunList|OverviewPanel|BudgetMap|SpanTree|span-tree-view|DetailPanel|DetailNotices|DetailShared|StepDetailView|LlmCallDetail|ToolInvokeDetail|RunStatusBadge|SessionActivity|RunWorkspace|ShortIdLabel|overview-view|tree-view|budget|call-detail-view|detail-)/],
];
const RENDERER_FALLBACK = "通用外壳/组件";

function rendererWorkspace(file) {
  const b = baseName(file);
  for (const [ws, re] of RENDERER_RULES) if (re.test(b)) return ws;
  return RENDERER_FALLBACK;
}

function mainWorkspace(file) {
  const b = baseName(file);
  if (/^(run-create|run-repository|run-read-context|run-lineage-read|run-detail-project|run-source-gate|fork-runner)$/.test(b)) return "运行创建/读取/分叉";
  if (/^(exec-endpoints|execution-config-state|isolated-prompt-endpoints)$/.test(b)) return "隔离执行/实验";
  if (/^verification-/.test(b)) return "项目验证";
  if (/^(compare-endpoints|workspace-compare-endpoint)$/.test(b)) return "比较";
  if (/^(config-endpoints|settings)$/.test(b)) return "设置/配置";
  if (/^proxy-/.test(b)) return "录制代理";
  if (/^(operation-|draft-close)/.test(b)) return "操作/草稿";
  return "外壳/其他";
}

/* ---------- classification ---------- */

const UI_PROPS = /(label|title|description|message|hint|placeholder|text|summary|heading|empty|help|error|notice|status|action|confirm|cancel|reason|note|tip|aria)/i;
const UI_CONSTS = /LABEL|TEXT|MESSAGE|TITLE|HINT|ERROR|NOTICE|STATUS|DESC|PLACEHOLDER|EMPTY|HELP|SUMMARY/;

function callRole(calleeText) {
  if (/^(fail|throw)$/.test(calleeText) || /(^|\.)fail$/.test(calleeText) || /Error$/.test(calleeText)) return "error_message";
  if (/^console\./.test(calleeText)) return "internal_log";
  if (/^(set|show|open|request|confirm|notify|toast|alert|warn)/i.test(calleeText)) return "ui_message";
  return "call_arg";
}

function classify(ancestors, sf) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (ts.isJsxAttribute(a)) return { role: "ui_attr", context: a.name.getText(sf) };
    if (ts.isPropertyAssignment(a)) {
      const name = a.name.getText(sf).replace(/^["']|["']$/g, "");
      return { role: UI_PROPS.test(name) ? "ui_prop" : "prop", context: name };
    }
    if (ts.isCallExpression(a)) {
      const callee = a.expression.getText(sf);
      return { role: callRole(callee), context: callee };
    }
    if (ts.isNewExpression(a) && a.expression.getText(sf).endsWith("Error")) {
      return { role: "error_message", context: "new " + a.expression.getText(sf) };
    }
    if (ts.isVariableDeclaration(a)) {
      const name = a.name.getText(sf);
      return { role: UI_CONSTS.test(name) ? "ui_constant" : "constant", context: name };
    }
    if (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return { role: "concat", context: "+" };
    }
    if (ts.isJsxExpression(a)) return { role: "ui_text", context: "jsx_expr" };
    if (ts.isReturnStatement(a)) return { role: "return", context: "return" };
    if (ts.isArrayLiteralExpression(a)) return { role: "array_item", context: "[]" };
    if (ts.isConditionalExpression(a)) return { role: "ui_text", context: "ternary" };
  }
  return { role: "other", context: "" };
}

function hanStringsIn(node, out = []) {
  if (ts.isJsxText(node)) {
    const t = node.text.replace(/\s+/g, " ").trim();
    if (t && HAN.test(t)) out.push(t);
    return out;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (HAN.test(node.text)) out.push(node.text);
    return out;
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
    if (parts.some((p) => HAN.test(p))) out.push(parts.join("${…}"));
    return out;
  }
  ts.forEachChild(node, (c) => hanStringsIn(c, out));
  return out;
}

function commentCount(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let tok;
  let n = 0;
  while ((tok = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (HAN.test(scanner.getTokenText())) n++;
    }
  }
  return n;
}

/* ---------- source scan ---------- */

const sourceRoots = [
  ["renderer", "apps/desktop/src/renderer"],
  ["main", "apps/desktop/src/main"],
  ["shared", "apps/desktop/src/shared"],
  ["preload", "apps/desktop/src/preload"],
];
for (const pkg of fs.readdirSync(path.join(ROOT, "packages"))) {
  if (fs.existsSync(path.join(ROOT, "packages", pkg, "src"))) {
    sourceRoots.push([`pkg:${pkg}`, `packages/${pkg}/src`]);
  }
}

const records = [];
const fileStats = [];
let commentTotal = 0;
let cssHtml = { files: 0, lines: 0, strings: 0 };

for (const [layer, relDir] of sourceRoots) {
  const files = walk(path.join(ROOT, relDir), [".ts", ".tsx"]);
  const cssFiles = layer === "renderer" ? walk(path.join(ROOT, relDir), [".css", ".html"]) : [];
  for (const f of cssFiles) {
    const text = fs.readFileSync(f, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => HAN.test(l)).length;
    const quoted = (text.match(/["'][^"']*\p{Script=Han}[^"']*["']/gu) || []).length;
    cssHtml.files++;
    cssHtml.lines += lines;
    cssHtml.strings += quoted;
    if (lines) {
      records.push({
        layer, workspace: "通用外壳/组件", file: rel(f), kind: "css_html",
        role: "ui_text", context: path.extname(f), text: `<${lines} 行含中文, ${quoted} 处引号串>`,
      });
    }
  }
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const perFile = [];
    const visit = (node, ancestors) => {
      let rec = null;
      if (ts.isJsxText(node)) {
        const t = node.text.replace(/\s+/g, " ").trim();
        if (t && HAN.test(t)) rec = { kind: "jsx_text", text: t };
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (HAN.test(node.text)) rec = { kind: "string", text: node.text };
      } else if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
        if (parts.some((p) => HAN.test(p))) rec = { kind: "template", text: parts.join("${…}") };
      }
      if (rec) {
        const ctx = classify(ancestors, sf);
        const workspace = layer === "renderer" ? rendererWorkspace(f) : layer === "main" ? mainWorkspace(f) : layer;
        const r = { layer, workspace, file: rel(f), ...rec, ...ctx };
        records.push(r);
        perFile.push(r);
      }
      ts.forEachChild(node, (c) => visit(c, [...ancestors, node]));
    };
    visit(sf, []);
    const comments = commentCount(text);
    commentTotal += comments;
    if (perFile.length || comments) {
      fileStats.push({ file: rel(f), layer, workspace: perFile[0] ? perFile[0].workspace : (layer === "renderer" ? rendererWorkspace(f) : layer), occurrences: perFile.length, unique: new Set(perFile.map((r) => r.text)).size, comments });
    }
  }
}

/* ---------- test scan ---------- */

const MATCHERS = /\.(toContain|toHaveTextContent|toMatch|toBe|toEqual|toStrictEqual|toContainEqual)$/;
const QUERIES = /(getByText|queryByText|findByText|getAllByText|queryAllByText|findAllByText|getByLabelText|queryByLabelText|findByLabelText|getByPlaceholderText|queryByPlaceholderText|findByPlaceholderText|getByTitle|getByAltText|getByDisplayValue|getByRole)$/;

const rendererStrings = new Set(records.filter((r) => r.layer === "renderer").map((r) => r.text.trim()));
const serverStrings = new Set(records.filter((r) => r.layer !== "renderer").map((r) => r.text.trim()));
const rendererList = [...rendererStrings].filter((s) => s.length >= 4);
const serverList = [...serverStrings].filter((s) => s.length >= 4);

function bucketOf(s) {
  const raw = s.trim();
  const norm = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (rendererStrings.has(raw) || rendererStrings.has(norm)) return "ui";
  if (serverStrings.has(raw) || serverStrings.has(norm)) return "domain";
  if (rendererList.some((r) => norm.includes(r) || r.includes(norm))) return "ui";
  if (serverList.some((r) => norm.includes(r) || r.includes(norm))) return "domain";
  return "fixture";
}

const testDirs = [["desktop", "apps/desktop/test"]];
for (const pkg of fs.readdirSync(path.join(ROOT, "packages"))) {
  if (fs.existsSync(path.join(ROOT, "packages", pkg, "test"))) testDirs.push([pkg, `packages/${pkg}/test`]);
}

const testStats = {
  files: 0,
  filesWithHan: 0,
  assertionCalls: 0,
  queryCalls: 0,
  attribution: { ui: 0, domain: 0, fixture_or_data: 0, mixed: 0 },
  matcherDist: {},
  byPackage: {},
  topFiles: [],
  titlesWithHan: 0,
};
const testSamples = { ui: [], domain: [], fixture_or_data: [], mixed: [] };
const testFileStats = [];

for (const [pkg, relDir] of testDirs) {
  const files = walk(path.join(ROOT, relDir), [".ts", ".tsx"]).filter((f) => /\.test\.tsx?$/.test(f));
  for (const f of files) {
    testStats.files++;
    const text = fs.readFileSync(f, "utf8");
    const hasHan = HAN.test(text);
    if (hasHan) testStats.filesWithHan++;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let assertions = 0;
    let queries = 0;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        const args = node.arguments;
        const strs = args.flatMap((a) => hanStringsIn(a));
        if (strs.length) {
          if (MATCHERS.test(callee)) {
            assertions++;
            const matcher = callee.split(".").pop();
            testStats.matcherDist[matcher] = (testStats.matcherDist[matcher] || 0) + 1;
            testStats.byPackage[pkg] = testStats.byPackage[pkg] || { assertions: 0, queries: 0 };
            testStats.byPackage[pkg].assertions++;
            const matched = strs.map((s) => bucketOf(s));
            const uniq = new Set(matched);
            let bucket;
            if (uniq.size > 1) { testStats.attribution.mixed++; bucket = "mixed"; }
            else if (matched[0] === "ui") { testStats.attribution.ui++; bucket = "ui"; }
            else if (matched[0] === "domain") { testStats.attribution.domain++; bucket = "domain"; }
            else { testStats.attribution.fixture_or_data++; bucket = "fixture_or_data"; }
            if (testSamples[bucket].length < 60) {
              testSamples[bucket].push({ file: rel(f), callee, text: strs[0].slice(0, 120) });
            }
          } else if (QUERIES.test(callee)) {
            queries++;
            testStats.attribution.ui++;
            testStats.byPackage[pkg] = testStats.byPackage[pkg] || { assertions: 0, queries: 0 };
            testStats.byPackage[pkg].queries++;
          }
        }
        if (/^(test|it|describe)(\.\w+)?$/.test(callee) && args.length && HAN.test(args[0].getText(sf))) {
          testStats.titlesWithHan++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    testStats.assertionCalls += assertions;
    testStats.queryCalls += queries;
    if (assertions || queries) {
      testFileStats.push({ file: rel(f), pkg, assertions, queries });
    }
  }
}
testStats.topFiles = testFileStats.sort((a, b) => b.assertions + b.queries - (a.assertions + a.queries)).slice(0, 25);

/* ---------- summarize ---------- */

function sumBy(list, key) {
  const m = new Map();
  for (const r of list) {
    const k = r[key];
    if (!m.has(k)) m.set(k, { occurrences: 0, unique: new Set(), files: new Set() });
    const e = m.get(k);
    e.occurrences++;
    e.unique.add(r.text);
    e.files.add(r.file);
  }
  return [...m.entries()]
    .map(([k, v]) => ({ key: k, occurrences: v.occurrences, unique: v.unique.size, files: v.files.size }))
    .sort((a, b) => b.occurrences - a.occurrences);
}

const freq = new Map();
for (const r of records) {
  const t = r.text.trim();
  if (t.length < 2 || t.startsWith("<")) continue;
  freq.set(t, (freq.get(t) || 0) + 1);
}

const commentByLayer = {};
for (const f of fileStats) {
  if (!commentByLayer[f.layer]) commentByLayer[f.layer] = 0;
  commentByLayer[f.layer] += f.comments;
}

const roles = [...new Set(records.map((r) => r.role))];
const roleSamples = Object.fromEntries(roles.map((role) => [
  role,
  records.filter((r) => r.role === role).slice(0, 12).map((r) => ({ file: r.file, text: r.text.slice(0, 120), context: r.context })),
]));

const attrDist = sumBy(records.filter((r) => r.role === "ui_attr"), "context");
const propDist = sumBy(records.filter((r) => r.role === "ui_prop"), "context");

const result = {
  generatedAt: new Date().toISOString(),
  totals: {
    filesScanned: fileStats.length,
    occurrences: records.length,
    uniqueStrings: new Set(records.map((r) => r.text)).size,
    commentsWithHan: commentTotal,
    commentsByLayer: commentByLayer,
    cssHtml,
  },
  byLayer: sumBy(records, "layer"),
  byRole: sumBy(records, "role"),
  rendererByWorkspace: sumBy(records.filter((r) => r.layer === "renderer"), "workspace"),
  rendererWorkspaceByRole: Object.fromEntries(
    [...new Set(records.filter((r) => r.layer === "renderer").map((r) => r.workspace))].map((ws) => [
      ws,
      Object.fromEntries(sumBy(records.filter((r) => r.layer === "renderer" && r.workspace === ws), "role").map((e) => [e.key, e.occurrences])),
    ])
  ),
  mainByWorkspace: sumBy(records.filter((r) => r.layer === "main"), "workspace"),
  topFiles: sumBy(records, "file").slice(0, 30),
  topStrings: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
  roleSamples,
  attrDist,
  propDist,
  records,
  fileStats,
  tests: { ...testStats, samples: testSamples },
};

fs.mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
fs.writeFileSync(path.join(ROOT, ".tmp", "i18n-inventory.json"), JSON.stringify(result, null, 2), "utf8");

console.log("=== totals ===");
console.log(result.totals);
console.log("\n=== by layer ===");
console.log(result.byLayer);
console.log("\n=== by role ===");
console.log(result.byRole);
console.log("\n=== renderer by workspace ===");
console.log(result.rendererByWorkspace);
console.log("\n=== main by workspace ===");
console.log(result.mainByWorkspace);
console.log("\n=== tests ===");
console.log({ ...testStats, topFiles: undefined });
console.log("\n=== top files ===");
console.log(result.topFiles.slice(0, 20));
console.log("\n=== top strings ===");
console.log(result.topStrings.slice(0, 25));
