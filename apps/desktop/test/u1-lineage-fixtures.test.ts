import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import {
  buildRunForest,
  deriveAncestorIds,
  deriveChainTotals,
  deriveComparison,
  deriveRunSummary,
  findCommonAncestor,
  forkEditLabel,
  indexRunsById,
  isPromptForkField,
} from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 1.2：继承/来源/短 ID/坏版本 fixture 组的输入条件验证。
 *
 * 数据来源：`apps/desktop/scripts/gen-u1-lineage-fixtures.cjs`
 * （手工组固定时间常量；隔离组为**真实引擎产物** `createIsolatedRun` + `replayIsolatedRun`，
 *  故含绝对临时路径、不追求逐字节可重复——改由 MANIFEST.json 记录关系与哈希）。
 *
 * ⚠️ 与 1.1 的分工：
 *   1.1 = 单个 run 的**结局**形状；1.2 = run 之间的**关系**与**导航**形状。
 *
 * ⚠️ 本文件是**数据契约校验**，不是 U1 的验收：
 *   - 它证明「这批 fixture 的输入确实满足 1.2 三条断言的前提」；
 *   - 它**不**证明概览/列表/树已按这些形状正确展示（属任务 2.x / 5.x）；
 *   - 短 ID **算法本身**属任务 2.4，尚未实现——这里只保证"碰撞条件确实成立"，
 *     故用夹具自身的结构性事实（后缀相同、互为后缀）来钉，而不是调用尚不存在的短 ID 函数。
 *
 * ⚠️ 已知覆盖缺口（诚实记录）：
 *   缺父链（祖先 run 缺失）语料归 U6；此处 `parent` 指向的 run 都真实存在于同一目录。
 */

const DIR = resolve(import.meta.dirname, "fixtures/u1-lineage");
const TRACES = resolve(DIR, "traces");
const BROKEN = resolve(DIR, "broken");
const ISO = resolve(DIR, "isolated-traces");
const MANIFEST_FILE = resolve(DIR, "MANIFEST.json");

interface TrackBoundary {
  id: string;
  自有spanIds: string[];
  parent: string | null;
  fork字段: string | null;
  resumeAfterStep?: string | null;
  workspaceWorldId?: string | null;
  originKind?: string | null;
  步骤轮号?: number[];
}

interface Manifest {
  关系: {
    result: { parent: string; child: string; 语义: string };
    prompt: { parent: string; child: string; 语义: string };
    model_params: { parent: string; arms: string[]; experimentId: string; 语义: string };
    proxy: { parent: string; child: string; 语义: string };
    isolated: { root: string; fork1: string; fork2: string; 语义: string };
  };
  短ID碰撞组: string[];
  坏版本组: string[];
  隔离附件哈希: Array<{ name: string; sha256: string }>;
  隔离源目录: string;
  轨迹边界: Record<string, TrackBoundary>;
}

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Manifest;

/** 读手工组 run（traces/） */
function readManual(name: string) {
  return readRun(resolve(TRACES, `${name}.jsonl`));
}

/** 读隔离组 run（isolated-traces/） */
function readIsolated(id: string) {
  return readRun(resolve(ISO, `${id}.jsonl`));
}

/**
 * 把一批 RunRecord 转成列表口径的 RunSummary[]（与 main 的 runs:list 同源派生）。
 * ⚠️ `deriveRunSummary` 的数字是「本 run 自身新增 span」的聚合——入参必须是 readRun 的原始
 *    记录（不含祖先前缀），这正是 resolveBranch 合并前的形态。
 */
function summariesOf(records: Array<{ name: string; file: string }>): RunSummary[] {
  return records.map(({ file }) => deriveRunSummary(readRun(file)));
}

// ---------------------------------------------------------------------------
// 资产齐备：清单声明的每一条都必须真的存在且可读
// ---------------------------------------------------------------------------

const manualNames = manifest.短ID碰撞组.concat([
  manifest.关系.result.parent,
  manifest.关系.result.child,
  manifest.关系.prompt.parent,
  manifest.关系.prompt.child,
  manifest.关系.model_params.parent,
  ...manifest.关系.model_params.arms,
  manifest.关系.proxy.parent,
  manifest.关系.proxy.child,
  "u1_long_task",
  "u1_long_model",
  "u1_empty_task",
]);

describe("1.2 资产齐备：清单声明的语料真的存在且可读", () => {
  it("手工组每份 fixture 都存在", () => {
    for (const name of manualNames) {
      expect(existsSync(resolve(TRACES, `${name}.jsonl`)), `缺少 fixture：${name}`).toBe(true);
    }
  });

  it("隔离组三条 run 都存在（真实引擎产物）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    for (const id of [root, fork1, fork2]) {
      expect(existsSync(resolve(ISO, `${id}.jsonl`)), `缺少隔离 run：${id}`).toBe(true);
    }
  });

  it("手工组每份都能被 readRun 读取，且 meta.id 与文件名一致", () => {
    for (const name of manualNames) {
      const record = readManual(name);
      expect(record.meta.id, name).toBe(name);
      expect(record.spans.length, name).toBeGreaterThan(0);
    }
  });

  it("清单记录的自有 span 边界与真实读取结果逐条一致（清单不是自说自话）", () => {
    for (const [label, boundary] of Object.entries(manifest.轨迹边界)) {
      const record = label.startsWith("isolated_")
        ? readIsolated(boundary.id)
        : readManual(boundary.id);
      expect(
        record.spans.map((s) => s.id),
        label,
      ).toEqual(boundary.自有spanIds);
      expect(record.meta.parent, label).toBe(boundary.parent);
      expect(record.meta.fork === null ? null : record.meta.fork.edit.field, label).toBe(
        boundary.fork字段,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 断言① 继承轨迹与独立执行来源
// ---------------------------------------------------------------------------

/**
 * result 分叉：**共享父前缀**。子 run 文件只记录**新增段**（自有 span 从 `s_09` 起），
 * 完整轨迹由 `resolveBranch` 在读取时把父 span 拼在前头。
 * prompt 分叉：**独立执行**。子 run 从头重跑，span 编号从 `s_01` 起，
 * 文件里**没有任何祖先 span**，连轮号也从本地第 1 轮重算。
 */
describe("断言① 继承轨迹与独立执行来源", () => {
  it("result 分叉子 run 只记新增段：自有 span 从 s_09 起，不与父重叠", () => {
    const parent = readManual(manifest.关系.result.parent);
    const child = readManual(manifest.关系.result.child);

    expect(child.meta.parent).toBe(parent.meta.id);
    expect(child.meta.fork?.edit.field).toBe("result");

    // 自有 span 从 s_09 起（父止于 s_05）——证明子文件不含父前缀，是"继承"而非"重录"
    expect(manifest.轨迹边界.result_child?.自有spanIds).toEqual(["s_09", "s_10"]);
    const parentIds = new Set(parent.spans.map((s) => s.id));
    for (const span of child.spans) {
      expect(parentIds.has(span.id), `result 子不应含父 span id：${span.id}`).toBe(false);
    }
  });

  it("prompt 分叉子 run 是独立执行：span 从 s_01 重编、且与父**同名**却不共享", () => {
    const parent = readManual(manifest.关系.prompt.parent);
    const child = readManual(manifest.关系.prompt.child);

    expect(child.meta.parent).toBe(parent.meta.id);
    expect(child.meta.fork?.edit.field).toBe("system_prompt");
    // 关键对照：两边自有 span 编号**相同**（s_01/s_02），但它们是各自独立的新轨迹
    expect(manifest.轨迹边界.prompt_child?.自有spanIds).toEqual(["s_01", "s_02"]);
    expect(manifest.轨迹边界.prompt_parent?.自有spanIds).toEqual(["s_01", "s_02"]);
    // 因此父的 id 集合与子的 id 集合**相交**——这正说明「非同源拼接」不能靠 id 去重
    const parentIds = new Set(parent.spans.map((s) => s.id));
    expect(child.spans.every((s) => parentIds.has(s.id))).toBe(true);
  });

  it("prompt 分叉字段被 isPromptForkField 认可（独立执行的判据来源）", () => {
    expect(isPromptForkField("system_prompt")).toBe(true);
    expect(isPromptForkField("user_message")).toBe(true);
    // result 分叉**不是** prompt 分叉（它共享前缀）
    expect(isPromptForkField("result")).toBe(false);
    expect(isPromptForkField("messages")).toBe(false);
  });

  it("model_params 臂与父的分叉字段为 model_params、边标签为「换 model/params（A/B）」", () => {
    const { arms } = manifest.关系.model_params;
    const first = arms[0];
    if (first === undefined) throw new Error("清单缺 A/B 臂");
    const armA = readManual(first);
    expect(armA.meta.parent).toBe(manifest.关系.model_params.parent);
    expect(armA.meta.fork?.edit.field).toBe("model_params");
    expect(forkEditLabel("model_params")).toBe("换 model/params（A/B）");
  });

  it("代理分叉 run：source.kind 为 proxy，且**无** config_hash（不可作 replay 父本）", () => {
    const proxyRoot = readManual(manifest.关系.proxy.parent);
    const proxyChild = readManual(manifest.关系.proxy.child);

    expect(deriveRunSummary(proxyRoot).source).toBe("proxy");
    expect(deriveRunSummary(proxyChild).source).toBe("proxy");
    expect(proxyChild.meta.fork?.edit.field).toBe("messages");
    // 代理录制无源配置可哈希 ⇒ 不可作 replay 分叉父本
    expect(proxyRoot.meta.config_hash).toBeUndefined();
    expect(proxyChild.meta.config_hash).toBeUndefined();
  });

  it("对照：手工 result 分叉父本**有** config_hash（可作 replay 父本，与代理成对）", () => {
    // 若两者都不带 config_hash，上一条就失去鉴别力——故显式钉住对照条件
    expect(readManual(manifest.关系.result.parent).meta.config_hash).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 断言② 同名运行的短 ID 稳定可辨（碰撞条件确实成立）
// ---------------------------------------------------------------------------

/**
 * 短 ID 规则（design D3）：从**末尾 8 字符**起、在全部已加载记录中**按需逐字符延长**、
 * 必要时用完整 ID；一个 ID 是另一个的后缀时较长者继续延长。
 *
 * 这里**只验证夹具让碰撞条件成立**（后缀相同 / 互为后缀），不实现算法（那是 2.4）。
 */
describe("断言② 同名运行的短 ID 稳定可辨（输入条件）", () => {
  const group = manifest.短ID碰撞组;

  it("碰撞组至少三条，且都真实存在", () => {
    expect(group.length).toBeGreaterThanOrEqual(3);
  });

  it("组内存在两条后 8 位**完全相同**（必须延长才能区分）", () => {
    const suffixes = group.map((id) => id.slice(-8));
    const dup = suffixes.filter((s, i) => suffixes.indexOf(s) !== i);
    expect(dup.length, `后 8 位应出现重复：${suffixes.join(", ")}`).toBeGreaterThan(0);
  });

  it("组内存在一条 id 是另一条的**后缀**（较长者须继续延长）", () => {
    const hasSuffixPair = group.some((a) => group.some((b) => a !== b && a.endsWith(b)));
    expect(hasSuffixPair, `应存在后缀对：${group.join(", ")}`).toBe(true);
  });

  it("三条 fixture 各自定义可读（碰撞的是 id 后缀，不是内容）", () => {
    for (const id of group) {
      const record = readManual(id);
      expect(record.meta.id).toBe(id);
      expect(record.meta.task).toBe("同名任务：整理构建产物");
    }
  });

  it("短 ID 的碰撞必须靠**全量已加载记录**才能察觉：单看一条无法分辨", () => {
    // 任取一条，它的 8 位后缀在组内都不是唯一的 ⇒ 只看自己必然与另一条混淆
    const target = group[group.length - 1];
    if (target === undefined) throw new Error("碰撞组为空");
    const targetSuffix = target.slice(-8);
    const colliding = group.filter(
      (id) => id !== target && (id.slice(-8) === targetSuffix || target.endsWith(id)),
    );
    expect(colliding.length, `目标 ${target} 应存在碰撞伙伴`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 断言③ 非法详情不被概览绕过（坏版本必须读取失败）
// ---------------------------------------------------------------------------

/**
 * 三份坏版本文件分居独立子目录 `broken/`——它们**必须读取失败**，
 * 不得混进可读语料被列表静默降级展示。
 */
describe("断言③ 非法详情不被概览绕过", () => {
  it("坏版本三份都存在，且**都不在**手工可读目录里", () => {
    expect(manifest.坏版本组).toHaveLength(3);
    for (const file of manifest.坏版本组) {
      expect(existsSync(resolve(BROKEN, file)), `缺少坏版本文件：${file}`).toBe(true);
      // 同名文件不得出现在 traces/（否则会被列表当可读语料吞掉）
      const inReadable = resolve(TRACES, file);
      expect(existsSync(inReadable), `坏版本不得混入可读目录：${file}`).toBe(false);
    }
  });

  it("未来格式版本：读取被版本门禁拒绝，报「不支持的格式版本」", () => {
    expect(() => readRun(resolve(BROKEN, "u1b_future.jsonl"))).toThrowError(/不支持的格式版本/);
  });

  it("结构损坏：缺 type 的行被读取器拒绝，报「type 为必填」", () => {
    expect(() => readRun(resolve(BROKEN, "u1b_schema.jsonl"))).toThrowError(/type 为必填/);
  });

  it("v1 私带隔离字段：被版本守卫拒绝，报「v1 禁止携带 workspace」", () => {
    // zod 会剥离未知键 ⇒ 靠 schema 本身拒不了，必须由版本守卫在 parse 前判定
    expect(() => readRun(resolve(BROKEN, "u1b_v1ws.jsonl"))).toThrowError(/v1 禁止携带 workspace/);
  });

  it("对照：同目录结构下的可读文件都能被读出来（拒绝不是「一律失败」）", () => {
    // 把三份坏版本各自的"好版本"重生出来对照，证明拒绝确因那一处破坏
    const good = readManual("u1_long_task");
    expect(good.meta.id).toBe("u1_long_task");
  });
});

// ---------------------------------------------------------------------------
// 隔离组：真实引擎谱系（自有 vs 祖先、二次分叉轮号、附件哈希）
// ---------------------------------------------------------------------------

describe("隔离组：真实引擎谱系（自有 vs 祖先 + 二次分叉轮号）", () => {
  it("三条 run 构成 root → fork1 → fork2 的父链（父 id 真实存在）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    const byId = new Map(
      [root, fork1, fork2].map((id) => [id, readIsolated(id).meta.parent] as const),
    );
    expect(byId.get(root)).toBeNull();
    expect(byId.get(fork1)).toBe(root);
    expect(byId.get(fork2)).toBe(fork1);
  });

  it("隔离 run 为 v2 且携带真实 workspace（world_id 与自身 id 一致）", () => {
    const { root, fork1, fork2 } = manifest.关系.isolated;
    for (const id of [root, fork1, fork2]) {
      const record = readIsolated(id);
      expect(record.meta.format_version, id).toBe(2);
      expect(record.meta.workspace, id).toBeDefined();
      expect(record.meta.workspace?.world_id, id).toBe(id);
    }
  });

  it("分叉点 resume_after_step 指向**父 run 自有段**里的 span（不是新增的）", () => {
    const { root, fork1 } = manifest.关系.isolated;
    const rootOwn = new Set(readIsolated(root).spans.map((s) => s.id));
    const fork1Record = readIsolated(fork1);
    const resume = fork1Record.meta.fork?.resume_after_step;
    expect(resume).toBeDefined();
    expect(rootOwn.has(resume as string), `resume 点应在父自有段内：${resume}`).toBe(true);
    // 且 resume 点不得出现在分叉自己的新增段里
    expect(fork1Record.spans.some((s) => s.id === resume)).toBe(false);
  });

  it("二次分叉的轮号**回到本地第 1 轮**，不沿链累加（隔离续跑的关键口径）", () => {
    const fork2 = manifest.轨迹边界.isolated_fork2;
    const fork1 = manifest.轨迹边界.isolated_fork1;
    if (fork2 === undefined || fork1 === undefined) throw new Error("清单缺隔离分叉边界");
    // 两侧 step 轮号都从 1 起——若"沿链累计"就会得到 3/4 之类的错值
    expect(fork1.步骤轮号?.[0]).toBe(1);
    expect(fork2.步骤轮号?.[0]).toBe(1);
  });

  it("隔离附件哈希：清单声明的每一份都与落盘字节实测一致（哈希非占位）", () => {
    expect(manifest.隔离附件哈希.length).toBeGreaterThan(0);
    for (const blob of manifest.隔离附件哈希) {
      // 文件名即 sha256（workspace-blobs/sha256/<hash> 的命名契约）
      expect(blob.name).toBe(blob.sha256);
      expect(blob.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 分支树派生：把同一目录的 records 投影成森林，验证既有派生能消化这批语料
// ---------------------------------------------------------------------------

describe("分支树派生在 1.2 语料上的投影（既有 derive 不崩且分类正确）", () => {
  it("result/prompt/model_params 组构建出正确的父子森林", () => {
    const files = [
      manifest.关系.result.parent,
      manifest.关系.result.child,
      manifest.关系.prompt.parent,
      manifest.关系.prompt.child,
      manifest.关系.model_params.parent,
      ...manifest.关系.model_params.arms,
    ].map((name) => ({ name, file: resolve(TRACES, `${name}.jsonl`) }));

    const summaries = summariesOf(files);
    const forest = buildRunForest(summaries);
    const byId = indexRunsById(summaries);

    // 每个子 run 都挂在各自父节点下；根的 orphanReason 为 null
    for (const rootId of [
      manifest.关系.result.parent,
      manifest.关系.prompt.parent,
      manifest.关系.model_params.parent,
    ]) {
      const node = forest.find((n) => n.run.id === rootId);
      expect(node, `森林缺根 ${rootId}`).toBeDefined();
      expect(node?.orphanReason).toBeNull();
      expect(node?.children.length, `根 ${rootId} 应有子节点`).toBeGreaterThan(0);
    }

    // model_params 臂应共享同一 experiment_id（分支树据此聚合）
    const armSummaries = manifest.关系.model_params.arms.map((id) => byId.get(id));
    const expIds = armSummaries.map((s) => s?.fork?.experiment_id);
    expect(expIds.every((e) => e === manifest.关系.model_params.experimentId)).toBe(true);
  });

  it("祖先链集合：result 子含父，prompt 子的祖先链同样含父（独立执行 ≠ 无父）", () => {
    const files = [
      manifest.关系.result.parent,
      manifest.关系.result.child,
      manifest.关系.prompt.parent,
      manifest.关系.prompt.child,
    ].map((name) => ({ name, file: resolve(TRACES, `${name}.jsonl`) }));
    const summaries = summariesOf(files);
    const byId = indexRunsById(summaries);

    const resultAncestors = deriveAncestorIds(byId, manifest.关系.result.child);
    expect(resultAncestors.has(manifest.关系.result.parent)).toBe(true);
    expect(resultAncestors.has(manifest.关系.result.child)).toBe(true);

    // prompt 子同样"有父"——独立执行指的是**轨迹**独立，不是**父链**断开
    const promptAncestors = deriveAncestorIds(byId, manifest.关系.prompt.child);
    expect(promptAncestors.has(manifest.关系.prompt.parent)).toBe(true);
  });

  it("共同祖先：同批 A/B 臂的共同祖先是其父", () => {
    const { arms, parent } = manifest.关系.model_params;
    const files = [parent, ...arms].map((name) => ({
      name,
      file: resolve(TRACES, `${name}.jsonl`),
    }));
    const summaries = summariesOf(files);
    const byId = indexRunsById(summaries);

    const common = findCommonAncestor(byId, arms);
    expect(common.id).toBe(parent);
    expect(common.incomplete).toBe(false);
  });

  it("代理分叉链可累计（config_hash 缺失不影响 parent 链求和）", () => {
    const files = [manifest.关系.proxy.parent, manifest.关系.proxy.child].map((name) => ({
      name,
      file: resolve(TRACES, `${name}.jsonl`),
    }));
    const summaries = summariesOf(files);
    const byId = indexRunsById(summaries);

    const totals = deriveChainTotals(byId, manifest.关系.proxy.child);
    expect(totals).not.toBeNull();
    const parentTotals = deriveChainTotals(byId, manifest.关系.proxy.parent);
    expect(totals?.steps).toBe((parentTotals?.steps ?? 0) + 1);
  });

  it("多分支对照：A/B 臂可算出相对共同祖先的增量（基线可得）", () => {
    const { arms, parent } = manifest.关系.model_params;
    const files = [parent, ...arms].map((name) => ({
      name,
      file: resolve(TRACES, `${name}.jsonl`),
    }));
    const summaries = summariesOf(files);

    const comparison = deriveComparison(summaries, arms);
    expect(comparison.commonAncestor.id).toBe(parent);
    for (const entry of comparison.entries) {
      expect(entry.totals).not.toBeNull();
      expect(entry.deltaFromAncestor).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 导航摘要边界：长任务 / 长模型 / 空任务
// ---------------------------------------------------------------------------

describe("导航摘要边界：长任务 / 长模型 / 空任务", () => {
  it("长任务样本：task 长度显著大于常见值（列表需截断/展开）", () => {
    const record = readManual("u1_long_task");
    expect(record.meta.task.length).toBeGreaterThan(80);
    expect(record.meta.task).toContain("README");
  });

  it("长模型样本：model 是超长标识符（不遮挡相邻内容）", () => {
    const record = readManual("u1_long_model");
    expect(record.meta.model.length).toBeGreaterThan(60);
  });

  it("空任务样本：task 为空字符串 ⇒ 摘要需回退到来源/时间/短 ID", () => {
    const record = readManual("u1_empty_task");
    expect(record.meta.task).toBe("");
    // 空任务仍是一份合法可读的 run（回退不是错误路径）
    expect(record.spans.length).toBeGreaterThan(0);
  });
});
