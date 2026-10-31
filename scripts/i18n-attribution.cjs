#!/usr/bin/env node
/**
 * i18n 候选文案归属表生成器（只读源码，写 i18n/attribution.json）。
 *
 * 口径与 docs/engineering/reports/2026-10-28-i18n-attribution.md 一致：
 * - 只统计 `apps/desktop/src` 与 `packages` 各包 `src` 的 TS/TSX 字符串字面量、模板与 JSX 文本；
 *   注释不计入；CSS 中的中文均为注释，HTML 当前无中文。
 * - 每条候选带文件、层、工作区、符号路径、角色与分类：
 *   product（产品展示，迁移目标）/ original（原文、模型输入、记录或机器报告）/
 *   internal（内部诊断或存储不变量）/ generated（生成资产）。
 * - 分类是审查辅助，不是运行时判据；后续批次可在本文件维护映射，但必须保留理由。
 *
 * 复跑：node scripts/i18n-attribution.cjs
 * 对比盘点：node scripts/i18n-attribution.cjs --compare-inventory
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const HAN = /\p{Script=Han}/u;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  ".rebaseagent",
  ".vite",
  ".tmp",
  "release",
  "release-win",
  "build",
]);

const UI_PROPS =
  /(label|title|description|message|hint|placeholder|text|summary|heading|empty|help|error|notice|status|action|confirm|cancel|reason|note|tip|aria)/i;
const UI_CONSTS =
  /LABEL|TEXT|MESSAGE|TITLE|HINT|ERROR|NOTICE|STATUS|DESC|PLACEHOLDER|EMPTY|HELP|SUMMARY/;

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

/* ---------- 工作区近似（与盘点报告同口径） ---------- */

const RENDERER_RULES = [
  ["创建运行", /^(CreateRunWorkspace|create-run|create-workspace|entry-gate)$/],
  [
    "重跑/分叉",
    /^(MessagesWorkspace|MessagesForkEditor|MessagesResults|RunActionsBar|ResultForkEditor|PromptForkEditor|IsolatedPromptEntry|isolated-fork|isolated-prompt|prompt-fork|fork-cache-hint|messages-)/,
  ],
  ["录制接入", /^(RecordingWorkspace|RecordingWorkspaceView|recording-draft|proxy-)/],
  [
    "模型实验",
    /^(ExperimentWorkspace|ExperimentResults|ModelAbEditor|AbBatchResult|experiment-results|model-ab|prompt-experiment-view)/,
  ],
  [
    "比较工作区",
    /^(CompareWorkspace|CompareWorkspaceView|CompareFileWorkspace|CompareMetricsTable|CompareSelectionBar|compare-|DraftCompareGrid|DraftListPanel|DraftSourceBanner|draft-|verification-compare)/,
  ],
  [
    "文件工作区",
    /^(WorkspaceFilesPanel|WorkspaceFileView|WorkspaceFileViewBody|FileContent|workspace-file|workspace-files|file-)/,
  ],
  ["项目验证", /^(VerificationPanel|verification-)/],
  ["设置", /^(SettingsDialog|settings-form)$/],
  ["辅助/导出", /^(AuxWorkspaceFrame|WorkspaceExportPanel|aux-workspace|workspace-export-state)/],
  [
    "运行总览/详情",
    /^(RunList|OverviewPanel|BudgetMap|SpanTree|span-tree-view|DetailPanel|DetailNotices|DetailShared|StepDetailView|LlmCallDetail|ToolInvokeDetail|RunStatusBadge|SessionActivity|RunWorkspace|ShortIdLabel|overview-view|tree-view|budget|call-detail-view|detail-)/,
  ],
];
const RENDERER_FALLBACK = "通用外壳/组件";

function rendererWorkspace(file) {
  const b = baseName(file);
  for (const [ws, re] of RENDERER_RULES) if (re.test(b)) return ws;
  return RENDERER_FALLBACK;
}

function mainWorkspace(file) {
  const b = baseName(file);
  if (
    /^(run-create|run-repository|run-read-context|run-lineage-read|run-detail-project|run-source-gate|fork-runner)$/.test(
      b,
    )
  )
    return "运行创建/读取/分叉";
  if (/^(exec-endpoints|execution-config-state|isolated-prompt-endpoints)$/.test(b))
    return "隔离执行/实验";
  if (/^verification-/.test(b)) return "项目验证";
  if (/^(compare-endpoints|workspace-compare-endpoint)$/.test(b)) return "比较";
  if (/^(config-endpoints|settings)$/.test(b)) return "设置/配置";
  if (/^proxy-/.test(b)) return "录制代理";
  if (/^(operation-|draft-close)/.test(b)) return "操作/草稿";
  return "外壳/其他";
}

const RENDERER_BATCH = {
  "通用外壳/组件": 1,
  创建运行: 1,
  "运行总览/详情": 1,
  "重跑/分叉": 1,
  项目验证: 2,
  比较工作区: 2,
  文件工作区: 2,
  模型实验: 3,
  录制接入: 3,
  设置: 3,
  "辅助/导出": 3,
};

const MAIN_BATCH = {
  "运行创建/读取/分叉": 1,
  "隔离执行/实验": 1,
  "操作/草稿": 1,
  "外壳/其他": 1,
  项目验证: 2,
  比较: 2,
  "设置/配置": 3,
  录制代理: 3,
};

/* ---------- 文件级归属规则 ---------- */

const PRODUCT = "product";
const ORIGINAL = "original";
const INTERNAL = "internal";
const GENERATED = "generated";

const ORIGINAL_REASONS = {
  "apps/desktop/src/shared/ipc.ts":
    "shared Zod/契约校验提示（字段名/边界事实），作为机器/原始详情展示；产品摘要按稳定码在展示层派生",
  "apps/desktop/src/shared/operations.ts":
    "操作登记/核对契约的校验提示，作为机器/原始详情展示；产品摘要按稳定码在展示层派生",
  "apps/desktop/src/shared/detail-version-guard.ts": "详情版本守卫的违规路径事实，作为原始详情展示",
  "apps/desktop/src/shared/experiment-records.ts":
    "实验资格判据的领域原因（带稳定码），渲染层按码呈现并作为原始详情展示",
  "apps/desktop/src/main/exec-endpoints.ts":
    "main 主动执行通道的拒绝/失败原始说明，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "apps/desktop/src/main/ipc.ts":
    "main 通道注册/启动诊断原始说明，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/agent-loop/src/config.ts":
    "预算/采样参数的领域校验事实，作为原始诊断展示；产品摘要由调用方按稳定码派生",
  "packages/replay/src/derive.ts":
    "回放/分叉推导的领域校验事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/fork-parent.ts":
    "fork 父本加载/资格校验事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/replay-run.ts":
    "重跑前置校验/父本加载事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/parent-chain.ts": "父链读取/成环校验事实，作为原始诊断展示",
  "packages/replay/src/isolated-guard.ts":
    "隔离父本限制的领域事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/silent-ignore.ts":
    "Ollama 静默忽略知识库的实测原文（含日期与数值）；桌面按稳定键投影本地化说明，原文仅作详情，CLI 5.7 同键投影",
  "packages/replay/src/workspace/isolated-run.ts":
    "隔离续跑创建的参数/来源校验事实，作为原始诊断展示",
  "packages/replay/src/workspace/isolated-replay.ts": "隔离续跑的领域事实，作为原始诊断展示",
  "packages/replay/src/workspace/compare-api.ts":
    "比较侧选择/快照一致性校验事实，作为原始诊断展示；产品标签由渲染层给出",
  "packages/replay/src/workspace/quota.ts":
    "文件数/字节配额的领域事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/workspace/preflight.ts":
    "隔离续跑预检的参数/来源/授权事实，作为原始诊断展示；产品摘要由渲染层给出",
  "packages/replay/src/workspace/read-api.ts":
    "文件清单/正文读取的领域事实，作为原始诊断展示；产品标签由渲染层给出",
  "packages/replay/src/workspace/import-source.ts":
    "源目录校验/采集/一致性核对事实，作为原始诊断展示；产品摘要由渲染层给出",
  "packages/replay/src/workspace/profile-guard.ts":
    "工具 profile/写入授权的领域校验事实，作为原始诊断展示；产品摘要由渲染层给出",
  "packages/project-verification/src/schema.ts":
    "验证记录的 Zod/注册表校验事实，作为原始诊断展示；产品摘要由渲染层给出",

  "packages/agent-loop/src/diagnostic.ts": "模型/工具错误事实，随 trace 与工具结果保留原文",
  "packages/agent-loop/src/llm-client.ts":
    "模型调用错误事实，写入 llm.call.error，不能随 locale 改写",
  "packages/agent-loop/src/run-loop.ts": "工具结果与执行错误事实，保留原文",
  "packages/agent-loop/src/tool-registry.ts": "工具注册与调用结果原文，进入模型上下文",
  "packages/llm-proxy/src/diagnostic.ts": "上游错误原文，随录制记录保留",
  "packages/llm-proxy/src/server.ts":
    "录制代理监听启动失败与内部错误的原文事实，main 作为受控诊断回传；渲染层按稳定码给出本地化摘要并作为原始诊断展示",
  "packages/llm-proxy/src/handler.ts": "录制代理对外 HTTP 响应原文，不属桌面/MCP/CLI 产品面",
  "packages/replay/src/tool-unwrap.ts": "父录工具声明解析事实，属于模型工具定义原文",
  "packages/replay/src/workspace/file-tools.ts": "隔离文件工具的声明/参数说明，直接进入模型上下文",
  "packages/replay/src/workspace/export-manifest.ts":
    "导出清单正文标签，导出内容不随 UI locale 改写",
  "packages/trace-sdk/src/branch.ts": "轨迹结构校验事实，供来源拒绝详情与记录读取展示",
  "packages/trace-sdk/src/schema.ts": "trace schema 校验事实，属于记录原文边界",
  "packages/trace-sdk/src/logical-path.ts": "逻辑路径校验事实，属于记录/文件操作原文边界",
  "packages/trace-sdk/src/reader.ts": "JSONL 读取错误事实，属于记录原文边界",
  "packages/trace-sdk/src/version-guard.ts": "trace 版本守卫事实，属于记录原文边界",
  "packages/trace-sdk/src/workspace-snapshot.ts": "快照清单校验事实，属于记录原文边界",
  "packages/trace-sdk/src/fs-boundary.ts": "文件系统边界错误事实，属于读取原文边界",
  "packages/trace-sdk/src/tracer.ts": "tracer 不变量事实，属于记录生成边界",
  "packages/trace-sdk/src/jsonl-tracer.ts": "JSONL 写入不变量事实，属于记录生成边界",
  "packages/trace-sdk/src/guards.ts": "分支/删除守卫事实，属于记录边界",
  "packages/trace-sdk/src/memory-tracer.ts": "MemoryTracer 不变量事实，属于测试/记录边界",
  "packages/trace-sdk/src/workspace-hash.ts": "快照哈希校验事实，属于记录边界",
  "apps/desktop/src/main/run-create.ts":
    "main 返回的创建失败原始说明，渲染层作为原始详情展示；产品摘要按稳定码本地化",
  "apps/desktop/src/main/compare-endpoints.ts":
    "main 比较读取端点的请求/逐项读取失败原始说明，渲染层按稳定码本地化摘要并作为原始详情展示",
  "apps/desktop/src/main/verification-availability.ts":
    "main 启动核查门禁的原始诊断，渲染层按稳定码给出本地化摘要并按原始详情展示",
  "apps/desktop/src/main/verification-endpoints.ts":
    "main 验证执行端点的门内拒绝/停止原始诊断，渲染层按稳定码本地化摘要并按原始详情展示",
  "apps/desktop/src/main/verification-read-endpoints.ts":
    "main 只读验证端点的引擎/来源诊断原始说明，渲染层作为原始详情与不可用原因参数展示",
  "apps/desktop/src/main/run-source-gate.ts": "main 返回的来源拒绝原始说明，渲染层作为原始详情展示",
  "apps/desktop/src/main/workspace-export-endpoint.ts":
    "main 导出端点的目标/来源/会话校验原始说明，渲染层按稳定码给出本地化摘要并作为原始说明展示",
  "apps/desktop/src/main/settings.ts":
    "main 设置存储的校验/读写失败原始说明，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "apps/desktop/src/main/config-endpoints.ts":
    "配置写通道的可信来源/判锁/写入失败原始诊断（含脱敏占位），渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "apps/desktop/src/main/fork-runner.ts":
    "main 返回的分叉失败原始说明与工具结果原文，渲染层按原始详情展示；产品摘要按稳定码本地化",
  "apps/desktop/src/renderer/src/lib/result-verification.ts":
    "结果读取核对的原始诊断（信封/版本/schema/身份），作为原始详情展示，不随 UI locale 改写",
  "packages/trace-test/src/assertions.ts":
    "断言 detail 进入 JSON 报告与原始 detail，报告契约不随 locale 改写",
  "packages/trace-test/src/shape-align.ts": "形状对齐 detail 进入 JSON 报告，保留原始事实",
  "packages/trace-test/src/cassette-llm-client.ts":
    "卡带消息差异 detail 进入 JSON 报告，保留原始事实",
  "packages/trace-test/src/format.ts": "机器/人类共用的截断说明，随原始 detail 序列化",
  "packages/replay/src/prompt-fork.ts":
    "prompt fork 的领域校验/重建失败事实，作为原始诊断展示；产品摘要由渲染层按稳定码给出",
  "packages/replay/src/prompt-replay-run.ts":
    "prompt 重跑的执行失败事实，作为原始诊断展示，不随 UI locale 改写",
  "packages/replay/src/model-replay-run.ts":
    "模型实验内核的领域校验/执行失败事实（费用未确认、工具策略、臂形状、实验组冲突），桌面端按稳定码给出本地化摘要并作为原始详情展示；CLI 人类报告在 5.7 统一投影",
  "packages/replay/src/workspace/isolated-prompt-preflight.ts":
    "隔离 prompt 预检的校验/计划事实，作为原始诊断展示，不随 UI locale 改写",
  "packages/replay/src/workspace/isolated-prompt-run.ts":
    "隔离 prompt 执行失败事实，作为原始诊断展示，不随 UI locale 改写",
  "packages/replay/src/workspace/isolated-prompt-state.ts":
    "隔离 prompt 状态还原的校验事实，作为原始诊断展示，不随 UI locale 改写",
  "packages/replay/src/workspace/export-api.ts":
    "导出目标/来源校验的领域诊断，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/replay/src/workspace/export-materialize.ts":
    "导出写入/复核/清理的领域诊断，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/replay/src/workspace/export-snapshot.ts":
    "导出快照绑定的领域诊断，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/replay/src/workspace/export-diff.ts":
    "补丁生成上限的领域诊断，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/replay/src/workspace/export-patch.ts":
    "补丁基线/附件不可用的领域诊断，渲染层按稳定码给出本地化摘要并作为原始详情展示",
  "packages/project-verification/src/prepare/plan.ts":
    "准备计划正文（网络范围/许可）进入计划 token，按原文展示；外围标签与边界由渲染层本地化",
  "packages/project-verification/src/source/precheck.ts":
    "来源预检的领域原因，作为不可用原因参数与原始详情展示，不随 UI locale 改写",
  "packages/run-query/src/facts/compare-edit-evidence.ts":
    "比较投影的编辑证据/不可核对原因（带稳定 reasonCode），作为原始详情展示；外围标签与结构由渲染层本地化",
  "packages/run-query/src/facts/compare-output.ts":
    "比较逐侧输出与文本 diff 门禁的领域原因，作为原始详情展示；状态/缺型由渲染层本地化",
  "packages/run-query/src/facts/compare-source-map.ts":
    "result 链来源映射的领域原因，作为原始详情展示；来源标签由渲染层本地化",
  "apps/desktop/src/renderer/src/lib/compare-state.ts":
    "比较请求的载荷/响应错配诊断（带稳定码），作为原始详情展示；产品摘要由渲染层本地化",
  "packages/project-verification/src/records/reader.ts":
    "验证记录读取/坏尾/附件校验的领域诊断，作为稳定码之外的原始详情展示，不随 locale 改写",
  "packages/project-verification/src/records/assets-view.ts":
    "验证日志/产物附件的定位与完整性诊断，作为稳定码之外的原始详情展示，不随 locale 改写",
};
const ORIGINAL_PREFIXES = [
  [
    "packages/run-query/src/",
    "run-query 只读查询的领域事实/校验诊断，展示层按 code/kind 本地化，原文作详情",
  ],
  ["packages/project-verification/src/", "验证记录/runner/日志正文，持久化事实不随 locale 改写"],
];

// 文件内混有产品文案与模型输入原文时，按符号改判（文件级规则无法拆分）。
// 工具结果文本会写入新 trace 并作为模型消息重新送入，不能随 UI locale 生成。
const ORIGINAL_SYMBOLS = {
  "apps/desktop/src/renderer/src/components/detail/ResultForkEditor.tsx::toolMessageText":
    "模型所见的工具结果文本（写入新 trace 并进入模型上下文），不随 UI locale 生成",
  "apps/desktop/src/renderer/src/lib/draft-source.ts::toolResultText":
    "模型所见的工具结果文本（写入新 trace 并进入模型上下文），不随 UI locale 生成",
  "apps/desktop/src/main/exec-endpoints.ts::forkChannel.run":
    "main 返回的分叉失败原始说明，渲染层作为原始详情展示；产品摘要按稳定码本地化",
  "apps/desktop/src/main/exec-endpoints.ts::modelAbChannel.run":
    "main 返回的模型实验 A/B 通道拒绝原始说明（设置未配置/通道误用），渲染层作为原始详情展示；产品摘要按稳定码本地化",
  "apps/desktop/src/main/proxy-manager.ts::classifyRecoveryFailure.message":
    "main 回传的监听启动失败原始诊断（已脱敏限长），渲染层按稳定码给出本地化摘要并作为原始诊断展示",
  "apps/desktop/src/main/isolated-prompt-endpoints.ts::runIsolatedPromptCapability":
    "main 返回的隔离 prompt 能力预检原始说明，渲染层作为原始详情展示",
  "apps/desktop/src/main/proxy-manager.ts::ProxyManager.fork":
    "main 返回的代理重发失败原始说明（凭据/配置在核对后变化），渲染层作为原始详情展示",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::not_handshaked.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::communication_unknown.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::closing.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::configuration_busy.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::operation_running.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::inspectAck.problem":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::error.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::loadForkCapability.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::loadIsolatedPromptCapability.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::inspectWorkspace.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::readWorkspaceFile.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::submitVerificationPrepare.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/operations.ts::submitVerificationRun.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/verification.ts::verificationStopError.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
  "apps/desktop/src/renderer/src/store/slices/verification.ts::verificationCompareError.message":
    "本地提交门禁/回执核验的原始诊断，作为原始说明展示；产品摘要按稳定码派生",
};

const INTERNAL_REASONS = {
  "apps/desktop/src/main/operation-registry.ts": "操作登记/执行槽不变量错误，不面向用户",
  "apps/desktop/src/main/operation-request.ts": "业务请求规范化/深冻结的内部不变量错误，不面向用户",
  "apps/desktop/src/main/operation-endpoints.ts": "操作通道可信来源/核对形状的安全拒绝，不面向用户",
  "apps/desktop/src/main/draft-close-attach.ts": "关闭协商握手的内部拒绝，不面向用户",

  "packages/mcp-server/src/tool-contracts.ts":
    "工具契约缺失/名字写错属实现缺陷，模块加载即炸，不面向用户",
  "packages/mcp-server/src/verification-contracts.ts":
    "验证工具契约缺失属实现缺陷，模块加载即炸，不面向用户",
  "packages/replay/src/workspace/blob-store.ts": "附件存储不变量，不面向用户",
  "packages/replay/src/workspace/world.ts": "隔离世界内部不变量，不面向用户",
  "packages/replay/src/workspace/checkpoint-tracer.ts": "检查点 tracer 不变量，不面向用户",
  "packages/project-verification/src/runtime/reconcile.ts": "main 启动残留核查诊断，不面向用户",
  "packages/project-verification/src/runtime/registration.ts": "容器登记内部不变量，不面向用户",
  "packages/project-verification/src/trusted-env/node-ts-v1.ts":
    "受信环境 manifest 构建不变量，不面向用户",
  "packages/project-verification/src/docker/cli.ts": "Docker CLI 子进程内部错误，不面向用户",
  "apps/desktop/src/main/ui-preferences.ts": "语言偏好存储内部校验，不面向用户",
  "apps/desktop/src/main/ui-preferences-endpoints.ts": "语言偏好 IPC 安全拒绝，不面向用户",
  "apps/desktop/src/renderer/src/main.tsx": "渲染入口启动断言（缺 #root 即崩溃），不面向用户",
  "apps/desktop/src/renderer/src/lib/a11y-action.ts": "开发期可访问性审计判据，只在测试/断言中消费",
  "apps/desktop/src/renderer/src/lib/navigation-intent.ts":
    "自动导航判定理由，仅内部区分 wait/drop 使用，不显示给用户",
  "apps/desktop/src/renderer/src/lib/overview-view.ts":
    "迁移后仅剩安全渲染审计说明，只在测试中断言，不面向用户",
  "apps/desktop/src/renderer/src/lib/format.ts":
    "文件内唯一中文是历史状态短标签 reasonLabel，当前界面无消费点（状态由 RunStatusBadge/classifyOutcome 呈现）",
  "apps/desktop/src/renderer/src/lib/execution-confirmation.ts":
    "decideConfirmation 的 reason 只用于内部判定对象，界面只消费 kind（confirmed/missing/stale），不显示给用户",
  "apps/desktop/src/renderer/src/lib/draft-closure.ts":
    "草稿收尾判定/清理结果的内部结论，只用于决定是否删除，不显示给用户",
  "apps/desktop/src/renderer/src/store/slices/runs.ts":
    "run 列表/详情读取失败的内部诊断与稳定码，界面按 errorDescriptor 派生文案，不显示原文",
};

const PRODUCT_FILES = new Set([
  "packages/agent-loop/src/config.ts",
  "packages/project-verification/src/prepare/plan.ts",
  "packages/project-verification/src/schema.ts",
  "packages/project-verification/src/records/reader.ts",
  "packages/project-verification/src/records/assets-view.ts",
  "packages/project-verification/src/source/precheck.ts",
]);
const PRODUCT_PREFIXES = [
  "packages/mcp-server/src/",
  "packages/trace-test/src/cli.ts",
  "packages/trace-test/src/loader.ts",
  "packages/trace-test/src/run-test.ts",
  "packages/trace-test/src/rerun.ts",
  "packages/trace-test/src/definition.ts",
  "packages/trace-test/src/stub-tools.ts",
];

function packageOf(file) {
  const m = /^packages\/([^/]+)\//.exec(file);
  return m ? m[1] : null;
}

function fileRule(file, layer) {
  if (file.endsWith(".generated.ts")) {
    return { classification: GENERATED, reason: "生成资产（内嵌 runner/脚本），不作为产品文案" };
  }
  if (INTERNAL_REASONS[file]) return { classification: INTERNAL, reason: INTERNAL_REASONS[file] };
  // 原文/记录事实的显式清单优先于层默认：main 返回的原始错误说明由渲染层按
  // “原始详情”展示，产品摘要另按稳定 code 本地化，不把原始字节当作待翻文案。
  if (ORIGINAL_REASONS[file]) return { classification: ORIGINAL, reason: ORIGINAL_REASONS[file] };
  if (layer === "renderer" || layer === "main" || layer === "shared" || layer === "preload") {
    return { classification: PRODUCT, reason: null };
  }
  if (PRODUCT_FILES.has(file)) return { classification: PRODUCT, reason: null };
  if (PRODUCT_PREFIXES.some((p) => file.startsWith(p)))
    return { classification: PRODUCT, reason: null };
  const prefix = ORIGINAL_PREFIXES.find(([p]) => file.startsWith(p));
  if (prefix) return { classification: ORIGINAL, reason: prefix[1] };
  if (file.startsWith("packages/replay/")) return { classification: PRODUCT, reason: null };
  // 包层其余文件按“原文/记录事实”处理：错误码与参数由适配层投影，不在此处翻译。
  return { classification: ORIGINAL, reason: "包层领域事实/错误原文，由适配层按稳定 code 投影" };
}

function isCliFile(file) {
  return /(^|\/)(cli|model-ab-cli)\.ts$/.test(file) || file.endsWith("startup.ts");
}

function classifySymbol(file, layer, role, symbol) {
  const originalSymbol = ORIGINAL_SYMBOLS[`${file}::${symbol}`];
  if (originalSymbol) return { classification: ORIGINAL, reason: originalSymbol };
  const base = fileRule(file, layer);
  if (role === "internal_log" && !isCliFile(file)) {
    return { classification: INTERNAL, reason: "console 内部诊断，不面向用户" };
  }
  return base;
}

function batchOf(file, layer, workspace, classification) {
  if (classification !== PRODUCT) return null;
  if (layer === "renderer") return RENDERER_BATCH[workspace] ?? 1;
  if (layer === "main") return MAIN_BATCH[workspace] ?? 1;
  if (layer === "shared" || layer === "preload") return 1;
  if (file === "packages/replay/src/model-ab-cli.ts") return 4;
  if (file === "packages/replay/src/model-replay-run.ts") return 3;
  if (file.startsWith("packages/replay/src/workspace/export-")) return 2;
  if (file.startsWith("packages/project-verification/")) return 2;
  if (file.startsWith("packages/run-query/src/facts/compare-")) return 2;
  if (file.startsWith("packages/run-query/")) return 1;
  if (file.startsWith("packages/mcp-server/")) return 4;
  if (file.startsWith("packages/trace-test/")) return 4;
  if (file.startsWith("packages/agent-loop/")) return 1;
  if (file.startsWith("packages/llm-proxy/")) return 3;
  if (file.startsWith("packages/replay/")) return 1;
  return null;
}

/* ---------- AST 扫描 ---------- */

function callRole(calleeText) {
  if (
    /^(fail|throw)$/.test(calleeText) ||
    /(^|\.)fail$/.test(calleeText) ||
    /Error$/.test(calleeText)
  )
    return "error_message";
  if (/^console\./.test(calleeText)) return "internal_log";
  if (/^(set|show|open|request|confirm|notify|toast|alert|warn)/i.test(calleeText))
    return "ui_message";
  return "call_arg";
}

function classifyRole(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (ts.isJsxAttribute(a)) return { role: "ui_attr", context: a.name.getText() };
    if (ts.isPropertyAssignment(a)) {
      const name = a.name.getText().replace(/^["']|["']$/g, "");
      return { role: UI_PROPS.test(name) ? "ui_prop" : "prop", context: name };
    }
    if (ts.isCallExpression(a)) {
      const callee = a.expression.getText();
      return { role: callRole(callee), context: callee };
    }
    if (ts.isNewExpression(a) && a.expression.getText().endsWith("Error")) {
      return { role: "error_message", context: `new ${a.expression.getText()}` };
    }
    if (ts.isVariableDeclaration(a)) {
      const name = a.name.getText();
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

function nameOfDeclaration(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteralLike(node.name)) return node.name.text;
  return null;
}

function symbolOf(ancestors, sf) {
  const parts = [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    let name = null;
    if (
      ts.isFunctionDeclaration(a) ||
      ts.isMethodDeclaration(a) ||
      ts.isMethodSignature(a) ||
      ts.isGetAccessorDeclaration(a) ||
      ts.isSetAccessorDeclaration(a) ||
      ts.isConstructorDeclaration(a)
    ) {
      name = nameOfDeclaration(a) ?? (ts.isConstructorDeclaration(a) ? "constructor" : null);
    } else if (
      ts.isVariableDeclaration(a) ||
      ts.isPropertyAssignment(a) ||
      ts.isPropertyDeclaration(a) ||
      ts.isPropertySignature(a)
    ) {
      name = nameOfDeclaration(a);
    } else if (
      ts.isClassDeclaration(a) ||
      ts.isInterfaceDeclaration(a) ||
      ts.isTypeAliasDeclaration(a) ||
      ts.isEnumDeclaration(a)
    ) {
      name = nameOfDeclaration(a);
    } else if (ts.isJsxElement(a)) {
      name = a.openingElement.tagName.getText(sf);
    } else if (ts.isJsxSelfClosingElement(a)) {
      name = a.tagName.getText(sf);
    }
    if (name) {
      parts.unshift(name);
      // 只保留最近两层，避免超长路径；文件名已单独记录。
      if (parts.length === 2) break;
    }
  }
  return parts.length ? parts.join(".") : "<module>";
}

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

const files = new Map();
let occurrenceTotal = 0;

for (const [layer, relDir] of sourceRoots) {
  for (const f of walk(path.join(ROOT, relDir), [".ts", ".tsx"])) {
    const file = rel(f);
    // 资源目录是迁移终点（键契约与译文），不是待迁移候选；由 check:i18n 单独校验。
    if (file.startsWith("packages/i18n/src/resources/")) continue;
    const text = fs.readFileSync(f, "utf8");
    if (!HAN.test(text)) continue;
    const sf = ts.createSourceFile(
      f,
      text,
      ts.ScriptTarget.Latest,
      true,
      f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const workspace =
      layer === "renderer" ? rendererWorkspace(f) : layer === "main" ? mainWorkspace(f) : layer;
    const entry = files.get(file) ?? {
      path: file,
      layer,
      package: packageOf(file),
      workspace,
      classification: "product",
      batch: null,
      status: "pending",
      reason: null,
      symbols: [],
    };
    const symbolMap = new Map(entry.symbols.map((s) => [`${s.symbol}|${s.role}`, s]));

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
        const { role, context } = classifyRole(ancestors);
        const symbol = symbolOf(ancestors, sf);
        const { classification, reason } = classifySymbol(file, layer, role, symbol);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const key = `${symbol}|${role}`;
        let s = symbolMap.get(key);
        if (!s) {
          s = {
            symbol,
            role,
            context,
            classification,
            reason: reason ?? null,
            count: 0,
            samples: [],
            lines: [],
          };
          symbolMap.set(key, s);
          entry.symbols.push(s);
        }
        s.count += 1;
        if (s.samples.length < 2 && !s.samples.includes(rec.text.slice(0, 100))) {
          s.samples.push(rec.text.slice(0, 100));
        }
        if (s.lines.length < 20) s.lines.push(line);
        occurrenceTotal += 1;
      }
      ts.forEachChild(node, (c) => visit(c, [...ancestors, node]));
    };
    visit(sf, []);
    files.set(file, entry);
  }
}

/* ---------- 汇总与分类收口 ---------- */

const manifestFiles = [];
for (const entry of [...files.values()]
  .filter((e) => e.symbols.length > 0)
  .sort((a, b) => a.path.localeCompare(b.path))) {
  for (const s of entry.symbols) s.lines = [...new Set(s.lines)].sort((a, b) => a - b);
  const classes = new Set(entry.symbols.map((s) => s.classification));
  entry.classification = classes.size === 1 ? [...classes][0] : "mixed";
  const rule = fileRule(entry.path, entry.layer);
  entry.reason = rule.reason ?? entry.symbols.find((s) => s.reason)?.reason ?? null;
  entry.batch = entry.symbols.some((s) => s.classification === PRODUCT)
    ? batchOf(entry.path, entry.layer, entry.workspace, PRODUCT)
    : null;
  entry.status = entry.symbols.some((s) => s.classification === PRODUCT) ? "pending" : "excluded";
  manifestFiles.push(entry);
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] ?? 0) + 1;
  return out;
}

const allSymbols = manifestFiles.flatMap((f) => f.symbols);
const totals = {
  files: manifestFiles.length,
  occurrences: occurrenceTotal,
  product: allSymbols.filter((s) => s.classification === PRODUCT).reduce((n, s) => n + s.count, 0),
  original: allSymbols
    .filter((s) => s.classification === ORIGINAL)
    .reduce((n, s) => n + s.count, 0),
  internal: allSymbols
    .filter((s) => s.classification === INTERNAL)
    .reduce((n, s) => n + s.count, 0),
  generated: allSymbols
    .filter((s) => s.classification === GENERATED)
    .reduce((n, s) => n + s.count, 0),
};
const byLayer = {};
for (const f of manifestFiles) {
  const e = byLayer[f.layer] ?? {
    files: 0,
    occurrences: 0,
    product: 0,
    original: 0,
    internal: 0,
    generated: 0,
  };
  e.files += 1;
  for (const s of f.symbols) {
    e.occurrences += s.count;
    e[s.classification] += s.count;
  }
  byLayer[f.layer] = e;
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scanner: "scripts/i18n-attribution.cjs",
  taxonomy: {
    product: "产品展示：需要按批次迁移为双语资源",
    original: "原文/模型输入/持久化记录/机器报告：不随 UI locale 改写",
    internal: "内部诊断或存储不变量：不面向用户",
    generated: "生成资产：不作为产品文案",
  },
  totals,
  byLayer,
  files: manifestFiles,
};

const outFile = path.join(ROOT, "i18n", "attribution.json");
const CHECK_ONLY = process.argv.includes("--check");
const manifestArg = process.argv.indexOf("--manifest");
const manifestPath =
  manifestArg !== -1 && process.argv[manifestArg + 1]
    ? path.resolve(ROOT, process.argv[manifestArg + 1])
    : outFile;

if (CHECK_ONLY) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`[i18n-attribution] --check 缺少归属表：${manifestPath}；先运行生成器`);
    process.exit(2);
  }
  const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const keyOf = (s) => `${s.symbol}|${s.role}`;
  const structure = (m) => {
    const map = new Map();
    for (const f of m.files ?? []) {
      const symbols = new Map();
      for (const s of f.symbols ?? []) symbols.set(keyOf(s), `${s.classification}:${s.count}`);
      map.set(f.path, symbols);
    }
    return map;
  };
  const before = structure(existing);
  const current = structure(manifest);
  const diffs = [];
  for (const [file, symbols] of current) {
    const old = before.get(file);
    if (!old) {
      diffs.push(`新增文件：${file}`);
      continue;
    }
    for (const [key, value] of symbols) {
      const oldValue = old.get(key);
      if (oldValue === undefined) diffs.push(`新增符号：${file} :: ${key} (${value})`);
      else if (oldValue !== value)
        diffs.push(`计数/分类变化：${file} :: ${key} (${oldValue} -> ${value})`);
    }
    for (const key of old.keys()) {
      if (!symbols.has(key)) diffs.push(`符号消失：${file} :: ${key}`);
    }
  }
  for (const file of before.keys()) {
    if (!current.has(file)) diffs.push(`文件消失：${file}`);
  }
  if (diffs.length > 0) {
    console.error(
      `[i18n-attribution] --check 与归属表不一致（${diffs.length} 项，最多显示 30 项）：`,
    );
    for (const line of diffs.slice(0, 30)) console.error(`  - ${line}`);
    console.error("请核对新增/变更文本；产品文案需归属并在 i18n/attribution.json 更新后重新生成。");
    process.exit(1);
  }
  console.log(
    `[i18n-attribution] --check 一致：${manifestFiles.length} 个文件 / ${occurrenceTotal} 处候选`,
  );
  process.exit(0);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

/* ---------- 英文硬编码产品文本候选（审查辅助，不冒充全覆盖） ---------- */

const ENGLISH_SKIP_ATTRS =
  /^(className|class|style|d|fill|stroke|viewBox|width|height|id|name|type|href|src|key|htmlFor|role|tabIndex|transform|points|xmlns|strokeWidth|strokeLinecap|strokeLinejoin|fontSize|fontFamily|textAnchor)$/;
const TECHNICAL = /^[\w./:@#$%&*+=[\]{}<>-]+$/;
const STYLE_LIKE =
  /(^|\s)(flex|grid|text-|bg-|border-|px-|py-|mt-|mb-|ml-|mr-|w-|h-|min-|max-|gap-|rounded|absolute|relative|hover:|disabled:|overflow|shrink|break-|font-|md:|lg:)/;
const UI_ROLES = new Set(["ui_attr", "ui_prop", "ui_text", "return"]);
const reviewFile = path.join(ROOT, "i18n", "english-product-review.json");
const englishReviews = fs.existsSync(reviewFile)
  ? (JSON.parse(fs.readFileSync(reviewFile, "utf8")).reviews ?? {})
  : {};

function englishCandidates() {
  const seen = new Set();
  const out = [];
  const roots = [
    ["renderer", "apps/desktop/src/renderer"],
    ["main", "apps/desktop/src/main"],
    ["shared", "apps/desktop/src/shared"],
  ];
  for (const [layer, relDir] of roots) {
    for (const f of walk(path.join(ROOT, relDir), [".ts", ".tsx"])) {
      const text = fs.readFileSync(f, "utf8");
      if (!/[A-Za-z]/.test(text)) continue;
      const sf = ts.createSourceFile(
        f,
        text,
        ts.ScriptTarget.Latest,
        true,
        f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node, ancestors) => {
        let candidate = null;
        if (ts.isJsxText(node)) {
          const t = node.text.replace(/\s+/g, " ").trim();
          if (t && !HAN.test(t) && /[A-Za-z]{2}/.test(t)) candidate = t;
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const t = node.text.trim();
          if (t && !HAN.test(t) && /[A-Za-z]{2}/.test(t) && t.length >= 4) candidate = t;
        }
        if (candidate !== null) {
          const { role, context } = classifyRole(ancestors);
          if (
            UI_ROLES.has(role) &&
            !ENGLISH_SKIP_ATTRS.test(context) &&
            !TECHNICAL.test(candidate) &&
            !STYLE_LIKE.test(candidate)
          ) {
            const key = `${rel(f)}|${candidate}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({
                file: rel(f),
                layer,
                role,
                context,
                text: candidate.slice(0, 160),
                review: englishReviews[`${rel(f)}|${candidate}`] ?? "pending",
                note: null,
              });
            }
          }
        }
        ts.forEachChild(node, (c) => visit(c, [...ancestors, node]));
      };
      visit(sf, []);
    }
  }
  return out;
}

const englishOut = path.join(ROOT, "i18n", "english-product-candidates.json");
const english = englishCandidates();
fs.writeFileSync(
  englishOut,
  `${JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      scanner: "scripts/i18n-attribution.cjs",
      method:
        "AST 扫描 desktop 三层 ASCII-only 字符串/JSX 文本，按 UI 角色过滤 className/CSS/技术值；正则只作候选发现，逐条人工复核后才进入迁移范围。",
      candidates: english,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  `[i18n-attribution] 英文产品文本候选 ${english.length} 条 -> ${rel(englishOut)}（需人工复核，正则不是覆盖判据）`,
);

console.log(`[i18n-attribution] 写入 ${rel(outFile)}`);
console.log(`[i18n-attribution] files=${totals.files} occurrences=${totals.occurrences}`);
console.log(
  `[i18n-attribution] product=${totals.product} original=${totals.original} internal=${totals.internal} generated=${totals.generated}`,
);
for (const [layer, e] of Object.entries(byLayer)) {
  console.log(
    `  ${layer}: files=${e.files} occ=${e.occurrences} product=${e.product} original=${e.original} internal=${e.internal} generated=${e.generated}`,
  );
}

if (process.argv.includes("--verify-boundaries")) {
  const assert = require("node:assert/strict");
  const byPath = new Map(manifestFiles.map((f) => [f.path, f]));
  const occ = (f, cls) =>
    f.symbols.filter((s) => s.classification === cls).reduce((n, s) => n + s.count, 0);

  // S07：生成资产、模型输入、记录/报告原文必须划在翻译范围之外。
  const generated = byPath.get(
    "packages/project-verification/src/trusted-env/node-ts-v1-assets.generated.ts",
  );
  assert.ok(generated, "缺少生成资产条目");
  assert.equal(generated.classification, GENERATED, "生成资产必须整文件排除");
  assert.equal(occ(generated, GENERATED), 4, "生成资产应有 4 条内嵌脚本字符串");
  for (const p of [
    "packages/replay/src/workspace/file-tools.ts",
    "packages/replay/src/tool-unwrap.ts",
    "packages/trace-sdk/src/branch.ts",
    "packages/trace-sdk/src/schema.ts",
    "packages/trace-test/src/assertions.ts",
    "packages/trace-test/src/shape-align.ts",
    "packages/trace-test/src/cassette-llm-client.ts",
    "packages/trace-test/src/format.ts",
    "packages/agent-loop/src/llm-client.ts",
    "packages/agent-loop/src/run-loop.ts",
    "packages/agent-loop/src/tool-registry.ts",
    "packages/llm-proxy/src/handler.ts",
  ]) {
    const f = byPath.get(p);
    assert.ok(f, `缺少原文边界条目：${p}`);
    assert.equal(occ(f, PRODUCT), 0, `原文边界不应含产品文案：${p}`);
  }
  assert.equal(
    occ(byPath.get("packages/project-verification/src/orchestrate/run.ts"), PRODUCT),
    0,
    "验证记录正文必须保持原文",
  );
  assert.equal(
    occ(byPath.get("packages/llm-proxy/src/handler.ts"), PRODUCT),
    0,
    "录制代理对外响应保持原文",
  );

  // S11：全部现有包层 CLI 入口在归属表中有产品文案归属。
  for (const pkg of ["mcp-server", "trace-test", "replay"]) {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8"),
    );
    assert.ok(pkgJson.bin && Object.keys(pkgJson.bin).length > 0, `${pkg} 应声明 bin`);
    const product = manifestFiles
      .filter((f) => f.path.startsWith(`packages/${pkg}/`))
      .reduce((n, f) => n + occ(f, PRODUCT), 0);
    assert.ok(product > 0, `${pkg} CLI 未找到产品文案候选`);
  }
  // 模型实验 CLI 属 5.7 范围，必须有独立归属与批次。
  const modelAb = byPath.get("packages/replay/src/model-ab-cli.ts");
  assert.equal(modelAb.classification, PRODUCT, "模型实验 CLI 应为产品文案");
  assert.equal(modelAb.batch, 4, "模型实验 CLI 应归入包层 CLI 批次");

  // G03：所有产品文件有批次，所有排除项有理由。
  for (const f of manifestFiles) {
    if (f.status === "pending") {
      assert.ok([1, 2, 3, 4].includes(f.batch), `产品文件缺批次：${f.path}`);
    } else {
      assert.ok(f.reason || f.symbols.some((s) => s.reason), `排除项缺理由：${f.path}`);
    }
  }
  console.log(
    "[i18n-attribution] 边界核对通过：生成资产/模型输入/记录原文/内部诊断/全部 CLI/批次归属",
  );
}

if (process.argv.includes("--compare-inventory")) {
  const invPath = path.join(ROOT, ".tmp", "i18n-inventory.json");
  if (!fs.existsSync(invPath)) {
    console.error(
      "[i18n-attribution] 缺少 .tmp/i18n-inventory.json，先运行 node scripts/i18n-inventory.cjs",
    );
    process.exit(2);
  }
  const inv = JSON.parse(fs.readFileSync(invPath, "utf8"));
  const invByLayer = Object.fromEntries(inv.byLayer.map((b) => [b.key, b.occurrences]));
  let failed = false;
  for (const [layer, e] of Object.entries(byLayer)) {
    const expected = invByLayer[layer] ?? 0;
    const actual = e.occurrences;
    const ok = layer === "renderer" ? actual === expected - 1 : actual === expected; // 盘点把 index.css 计 1 条
    if (!ok) {
      failed = true;
      console.error(
        `[i18n-attribution] 层 ${layer} 与盘点不一致：attribution=${actual} inventory=${expected}`,
      );
    }
  }
  if (failed) process.exit(1);
  console.log("[i18n-attribution] 与盘点报告分层计数一致（renderer 扣除 CSS 汇总记录 1 条）");
}
