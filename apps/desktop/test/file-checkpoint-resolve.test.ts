import { describe, expect, it } from "vitest";
import {
  defaultCheckpointStepId,
  deriveCheckpointOptions,
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
