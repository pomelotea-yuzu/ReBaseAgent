import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultCheckpointStepId,
  deriveCheckpointOptions,
  resolveCheckpoint,
  validateCheckpointStepId,
  validateSavedPath,
} from "../src/renderer/src/lib/workspace-files";

/**
 * U2 任务 2.2：默认检查点与引用重校验（纯逻辑）。
 *
 * 对应 delta：
 * -「首次文件页选择最近自有完成步骤」「无自有完成步骤时选择初始」
 * -「失效检查点和路径安全回退」「切检查点保留仍存在的路径」
 * -「文件选择器轮号不沿链累加」
 *
 * ⚠️ 核心陷阱（与 1.1/1.2 同一类）：判据必须建立在**整条 id** 与**本 run 本地轮号**上，
 *    不能用合并轨迹的数组下标（合并轨迹把祖先前缀排在本 run 之前）。
 */

interface Step {
  id: string;
  parent: null;
  kind: "agent.step";
  n: number;
}

function run(spans: Step[], leafSpanIds: string[]) {
  return { spans, leafSpanIds, meta: { workspace: {} } };
}

describe("U2 默认检查点：最近自有完成步骤", () => {
  it("多轮自有步骤 ⇒ 取本地轮号最大者（不是数组末条）", () => {
    const r = run(
      [
        { id: "s_1", parent: null, kind: "agent.step", n: 1 },
        { id: "s_2", parent: null, kind: "agent.step", n: 2 },
        { id: "s_3", parent: null, kind: "agent.step", n: 3 },
      ],
      ["s_1", "s_2", "s_3"],
    );
    expect(defaultCheckpointStepId(r)).toBe("s_3");
  });

  it("合并轨迹含祖先前缀时**不选祖先**（只认 leafSpanIds）", () => {
    // 祖先 s_9（n=9）排在前面、本 run 自有 s_mine（n=1）在后
    const r = run(
      [
        { id: "s_9", parent: null, kind: "agent.step", n: 9 },
        { id: "s_mine", parent: null, kind: "agent.step", n: 1 },
      ],
      ["s_mine"],
    );
    expect(defaultCheckpointStepId(r)).toBe("s_mine");
  });

  it("没有自有完成步骤 ⇒ null（调用方落到初始状态）", () => {
    const r = run([{ id: "s_1", parent: null, kind: "agent.step", n: 1 }], []);
    expect(defaultCheckpointStepId(r)).toBeNull();
  });

  it("失败 run 的既有完成步骤仍可选（不因整体非 completed 而隐藏）", () => {
    const r = run(
      [
        { id: "s_1", parent: null, kind: "agent.step", n: 1 },
        { id: "s_2", parent: null, kind: "agent.step", n: 2 },
      ],
      ["s_1", "s_2"],
    );
    // 判据不看 status ⇒ 这里不传 status 也能选到
    expect(defaultCheckpointStepId(r)).toBe("s_2");
  });

  it("轮号取本 run 本地 n，不沿链累加（与选择器文案同源）", () => {
    const r = run(
      [
        { id: "s_a1", parent: null, kind: "agent.step", n: 1 },
        { id: "s_a2", parent: null, kind: "agent.step", n: 2 },
        { id: "s_b1", parent: null, kind: "agent.step", n: 1 },
      ],
      ["s_b1"],
    );
    const options = deriveCheckpointOptions(r);
    expect(options.map((o) => o.label)).toEqual(["本 run 初始状态", "本 run 第 1 轮结束"]);
    expect(defaultCheckpointStepId(r)).toBe("s_b1");
  });
});

describe("U2 检查点引用重校验", () => {
  const r = run(
    [
      { id: "s_1", parent: null, kind: "agent.step", n: 1 },
      { id: "s_2", parent: null, kind: "agent.step", n: 2 },
      { id: "s_ancestor", parent: null, kind: "agent.step", n: 5 },
    ],
    ["s_1", "s_2"],
  );

  it("null 判为初始", () => {
    expect(validateCheckpointStepId(r, null)).toBe("initial");
  });

  it("仍是自有完成步骤 ⇒ valid", () => {
    expect(validateCheckpointStepId(r, "s_2")).toBe("valid");
  });

  it("祖先步骤 / 拼错 id ⇒ stale（提示并回退默认，不换别的检查点）", () => {
    expect(validateCheckpointStepId(r, "s_ancestor")).toBe("stale");
    expect(validateCheckpointStepId(r, "s_nope")).toBe("stale");
  });
});

/**
 * U2 任务 5.6 实机缺陷修复的判据面：**两种"没有 step id"必须分开**。
 *
 * 缺陷原文（2026-09-24 实机坐实）：原实现只看 `validateCheckpointStepId(run, saved.checkpoint)`，
 * 首次进入（从未进过文件页）时 `saved.checkpoint === null` 被判成 `"initial"` ⇒ 界面停在
 * **初始状态**，而 delta 明文「首次进入 SHALL 选择最近自有完成步骤」。`defaultCheckpointStepId`
 * 的纯函数用例全绿，却**没有任何用例钉住"首次进入"这条分支**——与本 change 反复出现的
 * "纯逻辑写好、接线少一支"同一形态。
 */
describe("U2 5.6：首次进入 vs 明确选初始（resolveCheckpoint）", () => {
  const r = run(
    [
      { id: "s_1", parent: null, kind: "agent.step", n: 1 },
      { id: "s_2", parent: null, kind: "agent.step", n: 2 },
    ],
    ["s_1", "s_2"],
  );

  it("**从未进入**（entered=false）⇒ 取最近自有完成步骤，而不是初始", () => {
    expect(resolveCheckpoint(r, { entered: false, checkpoint: null })).toEqual({
      stepSpanId: "s_2",
      invalidated: false,
    });
  });

  it("**已进入**且明确选了初始（entered=true, checkpoint=null）⇒ 保持初始，不套默认", () => {
    expect(resolveCheckpoint(r, { entered: true, checkpoint: null })).toEqual({
      stepSpanId: null,
      invalidated: false,
    });
  });

  it("已进入 + 保存的 step 仍有效 ⇒ 保持保存值", () => {
    expect(resolveCheckpoint(r, { entered: true, checkpoint: "s_1" })).toEqual({
      stepSpanId: "s_1",
      invalidated: false,
    });
  });

  it("已进入 + 保存的 step 失效 ⇒ 回退默认并标记 invalidated（须提示）", () => {
    expect(resolveCheckpoint(r, { entered: true, checkpoint: "s_ancestor" })).toEqual({
      stepSpanId: "s_2",
      invalidated: true,
    });
  });

  it("无自有完成步骤 + 从未进入 ⇒ 初始（null），且不算失效", () => {
    const noOwn = run([{ id: "s_anc", parent: null, kind: "agent.step", n: 9 }], []);
    expect(resolveCheckpoint(noOwn, { entered: false, checkpoint: null })).toEqual({
      stepSpanId: null,
      invalidated: false,
    });
  });
});

/**
 * 接线契约（源码级）：本包无 jsdom，`renderToStaticMarkup` 不跑 effect，
 * 「首次进入是否真的落到默认检查点」在组件测试里打不到 ⇒ 用源码级正/反向断言钉住。
 */
describe("U2 5.6：首次进入默认检查点的接线契约", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/WorkspaceFileView.tsx"),
    "utf8",
  );

  it("视图必须消费 `fileReadingEntered`（区分「从未进入」与「明确选初始」的唯一依据）", () => {
    expect(src).toContain("s.fileReadingEntered(run.meta.id)");
  });

  it("解析必须走 `resolveCheckpoint`（首次进入分支由它承担，不再只看 null）", () => {
    expect(src).toContain("resolveCheckpoint(run, {");
    expect(src).toContain("entered: fileReadingEntered");
  });

  it("**反向**：不得再出现「直接以 validateCheckpointStepId 的结论决定 effective」的旧写法", () => {
    expect(src).not.toContain("const checkpointCheck = validateCheckpointStepId(");
    expect(src).not.toContain('checkpointCheck === "valid"');
  });

  it("首次进入必须**写回默认检查点**，否则后续任一 patch 会以 checkpoint=null 起底跳回初始", () => {
    expect(src).toContain("setFileReading(run.meta.id, { checkpoint: defaultStepSpanId })");
  });

  it("**反向**：写回前必须再查一次新鲜状态（显式文件目标不能被旧快照覆盖）", () => {
    expect(src).toContain("useAppStore.getState().fileReadingEntered(run.meta.id)");
  });

  it("store 必须暴露 `fileReadingEntered`（`files !== undefined`）", () => {
    const store = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
      "utf8",
    );
    expect(store).toContain("fileReadingEntered: (runId: string) => boolean;");
    expect(store).toContain(
      "return readingStateOf(get().readingByRun, runId).files !== undefined;",
    );
  });
});

describe("U2 路径引用重校验", () => {
  const inspect = { files: [{ path: "a.txt" }, { path: "dir/b.txt" }] };

  it("清单里有 ⇒ present（附件不可用/被筛选隐藏也保留意图）", () => {
    expect(validateSavedPath(inspect, false, "a.txt")).toBe("present");
    expect(validateSavedPath(inspect, false, "dir/b.txt")).toBe("present");
  });

  it("清单确认路径不存在 ⇒ absent（清空选择，不改选同名）", () => {
    expect(validateSavedPath(inspect, false, "gone.txt")).toBe("absent");
  });

  it("清单读取失败 ⇒ unknown（**不**当作路径消失，保留意图供重试）", () => {
    expect(validateSavedPath(null, true, "a.txt")).toBe("unknown");
  });

  it("尚未拿到清单 ⇒ unknown", () => {
    expect(validateSavedPath(null, false, "a.txt")).toBe("unknown");
  });

  it("path 为 null ⇒ unknown（无选择意图可校验）", () => {
    expect(validateSavedPath(inspect, false, null)).toBe("unknown");
  });
});
