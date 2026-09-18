import { describe, expect, it } from "vitest";
import { findLogicalPathViolation } from "../src/logical-path";
import { RunMetaSchema, WorkspaceSnapshotSchema } from "../src/schema";
import type { WorkspaceFile, WorkspaceMeta } from "../src/schema";
import {
  canonicalWorkspaceFiles,
  computeWorkspaceSnapshotId,
  createWorkspaceSnapshot,
  findSnapshotIdViolation,
} from "../src/workspace-hash";
import {
  compareLogicalPath,
  findSnapshotFilesViolation,
  findWorkspaceOriginViolation,
  isCanonicalWorkspaceOrder,
} from "../src/workspace-snapshot";

/** 三个不同的 64 位小写十六进制占位哈希 */
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function file(path: string, over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { path, sha256: HASH_A, bytes: 1, ...over };
}

/**
 * 规范清单哈希的**金标准**（2026-09-17 由独立脚本按规范形式算出）。
 * 硬编码是刻意的：任何对排序键、字段顺序或编码方式的改动都会让这些值失效，
 * 从而在这一层被抓住——而不是等到跨机器比对时才表现为"看起来一样但哈希不同"。
 */
const GOLDEN_EMPTY = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const GOLDEN_ASCII = "a6bd2938e7bc8a21aed7cf611d9b17c2adaeb41f208f6ee0f6c339d3d43a7d58";
const GOLDEN_CJK = "ffe1dbb8a8d5372d326ebb3de99096affc0a34913994b6374fe7cb9fd3760505";

describe("workspace-snapshot：路径契约已并入清单校验（2.1）", () => {
  it("合法路径的清单通过（含中文与深层）", () => {
    expect(findSnapshotFilesViolation([file("a.txt"), file("配置/说明.md")])).toBeNull();
    expect(findSnapshotFilesViolation([file("dir/sub/b.md")])).toBeNull();
  });

  it("平台特性规则自 2.1 起生效：1.2 刻意放行的 CON 与 ADS 现在被拒", () => {
    // 1.2 时这两条断言是 toBeNull()（"平台特性规则不在此层，留给 2.1"）；
    // 2.1 把完整路径契约接进来后，清单层与工具写入层用的是同一份规则。
    expect(findLogicalPathViolation("CON")).toContain("保留设备名");
    expect(findLogicalPathViolation("a.txt:ads")).toContain("冒号");
    expect(findSnapshotFilesViolation([file("CON")])).toContain("保留设备名");
    expect(findSnapshotFilesViolation([file("a.txt:ads")])).toContain("冒号");
  });

  it("长度与深度上限在清单层同样生效", () => {
    expect(findSnapshotFilesViolation([file("a".repeat(512))])).toBeNull();
    expect(findSnapshotFilesViolation([file("a".repeat(513))])).toContain("长度超过上限");
    const deep = Array.from({ length: 33 }, (_, i) => `d${i}`).join("/");
    expect(findSnapshotFilesViolation([file(deep)])).toContain("段数超过上限");
  });

  it("NFC/大小写碰撞的清单被拒（同一世界不可能有两条等价路径）", () => {
    // 规范序下 `A.txt`(0x41) < `a.txt`(0x61)，故这份清单能走到碰撞判定
    expect(isCanonicalWorkspaceOrder([file("A.txt"), file("a.txt")])).toBe(true);
    expect(findSnapshotFilesViolation([file("A.txt"), file("a.txt")])).toContain("碰撞");
  });
});

describe("workspace-snapshot：规范序与清单冲突", () => {
  it("空清单与已排序清单合法", () => {
    expect(findSnapshotFilesViolation([])).toBeNull();
    expect(isCanonicalWorkspaceOrder([])).toBe(true);
    expect(findSnapshotFilesViolation([file("a.txt"), file("dir/b.txt")])).toBeNull();
  });

  it("乱序被拒", () => {
    const files = [file("dir/b.txt"), file("a.txt")];
    expect(isCanonicalWorkspaceOrder(files)).toBe(false);
    expect(findSnapshotFilesViolation(files)).toContain("代码单元序");
  });

  it("重复路径被拒", () => {
    expect(findSnapshotFilesViolation([file("a.txt"), file("a.txt", { bytes: 9 })])).toContain(
      "重复路径",
    );
  });

  it("文件/目录冲突被拒（一条路径不能既是文件又是目录）", () => {
    expect(findSnapshotFilesViolation([file("a"), file("a/b")])).toContain("既是文件又是");
  });

  it("冲突的祖先不必紧邻后代——不能只比相邻两项", () => {
    // 规范序：`a`(0x61) < `a-x`(0x61,0x2D) < `a/b`(0x61,0x2F)，故 `a` 的紧邻是 `a-x`
    const files = [file("a"), file("a-x"), file("a/b")];
    expect(isCanonicalWorkspaceOrder(files)).toBe(true);
    expect(findSnapshotFilesViolation(files)).toContain("a 既是文件又是 a/b");
  });

  it("仅字符串前缀相同不算冲突（缺 “/” 边界）", () => {
    expect(findSnapshotFilesViolation([file("a"), file("ab")])).toBeNull();
    expect(findSnapshotFilesViolation([file("dir"), file("dirs/x")])).toBeNull();
  });

  it("路径规则先于冲突检测生效", () => {
    expect(findSnapshotFilesViolation([file("/abs"), file("b")])).toContain("相对路径");
  });

  it("排序键是 UTF-16 代码单元序，不是 locale 序", () => {
    // 代码单元序：`-`(0x2D) < `/`(0x2F)，且中文（U+554A）大于 ASCII 的 `b`
    expect(compareLogicalPath("a-x", "a/b")).toBeLessThan(0);
    expect(compareLogicalPath("啊", "b")).toBeGreaterThan(0);
    // locale 序（zh）会认为 "啊" 在 "b" 之前——两者结论相反，故本用例能区分实现
    expect("啊".localeCompare("b")).toBeLessThan(0);
  });
});

describe("workspace-snapshot：origin 与运行关系自洽", () => {
  function meta(over: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
    return {
      profile: "file-tools-v1",
      world_id: "r_01",
      write_authorized: true,
      initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
      origin: { kind: "import" },
      ...over,
    };
  }

  it("根 run：origin 必须是 import", () => {
    expect(
      findWorkspaceOriginViolation({ id: "r_01", parent: null, workspace: meta() }),
    ).toBeNull();
    const bad = meta({ origin: { kind: "checkpoint", run_id: "r_00", step_span: "s_01" } });
    expect(findWorkspaceOriginViolation({ id: "r_01", parent: null, workspace: bad })).toContain(
      "import",
    );
  });

  it("分支 run：origin 必须是 checkpoint 且指向直接父", () => {
    const ok = meta({
      origin: { kind: "checkpoint", run_id: "r_01", step_span: "s_04" },
    });
    expect(
      findWorkspaceOriginViolation({
        id: "r_02",
        parent: "r_01",
        resumeAfterStep: "s_04",
        workspace: { ...ok, world_id: "r_02" },
      }),
    ).toBeNull();

    // origin 为 import 的分支（world_id 先对上，确保这里报的是 origin 而不是 world_id）
    const importOrigin = meta({ world_id: "r_02" });
    expect(
      findWorkspaceOriginViolation({ id: "r_02", parent: "r_01", workspace: importOrigin }),
    ).toContain("checkpoint");

    const wrongParent = meta({ origin: { kind: "checkpoint", run_id: "r_00", step_span: "s_04" } });
    expect(
      findWorkspaceOriginViolation({
        id: "r_02",
        parent: "r_01",
        workspace: { ...wrongParent, world_id: "r_02" },
      }),
    ).toContain("直接父");
  });

  it("world_id 必须等于本 run id", () => {
    expect(findWorkspaceOriginViolation({ id: "r_99", parent: null, workspace: meta() })).toContain(
      "world_id",
    );
  });

  it("resume_after_step 存在时必须与 origin.step_span 同指一个 step", () => {
    const workspace = meta({
      world_id: "r_02",
      origin: { kind: "checkpoint", run_id: "r_01", step_span: "s_04" },
    });
    expect(
      findWorkspaceOriginViolation({
        id: "r_02",
        parent: "r_01",
        resumeAfterStep: "s_07",
        workspace,
      }),
    ).toContain("同一个 step");
  });

  it("resume_after_step 缺省时不作判定（必填约束属 1.4）", () => {
    const workspace = meta({
      world_id: "r_02",
      origin: { kind: "checkpoint", run_id: "r_01", step_span: "s_04" },
    });
    expect(findWorkspaceOriginViolation({ id: "r_02", parent: "r_01", workspace })).toBeNull();
  });
});

describe("schema 接入：WorkspaceSnapshotSchema", () => {
  it("合法快照通过（空清单与非空清单）", () => {
    expect(WorkspaceSnapshotSchema.parse({ id: GOLDEN_EMPTY, files: [] }).files).toEqual([]);
    const ascii = createWorkspaceSnapshot([file("a.txt", { bytes: 3 })]);
    expect(WorkspaceSnapshotSchema.parse(ascii).id).toBe(ascii.id);
  });

  it("负 bytes 与非整数 bytes 被拒", () => {
    const bad = { id: HASH_A, files: [file("a.txt", { bytes: -1 })] };
    expect(WorkspaceSnapshotSchema.safeParse(bad).success).toBe(false);
    expect(
      WorkspaceSnapshotSchema.safeParse({ id: HASH_A, files: [file("a.txt", { bytes: 1.5 })] })
        .success,
    ).toBe(false);
  });

  it("非法哈希被拒（大写与长度不足）", () => {
    expect(
      WorkspaceSnapshotSchema.safeParse({
        id: HASH_A,
        files: [file("a.txt", { sha256: HASH_A.toUpperCase() })],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceSnapshotSchema.safeParse({
        id: HASH_A,
        files: [file("a.txt", { sha256: "abc" })],
      }).success,
    ).toBe(false);
    // id 自身也必须是 64 位小写十六进制
    expect(WorkspaceSnapshotSchema.safeParse({ id: "not-a-hash", files: [] }).success).toBe(false);
  });

  it("乱序、重复与冲突清单在解析期被拒", () => {
    const shuffled = WorkspaceSnapshotSchema.safeParse({
      id: HASH_A,
      files: [file("dir/b.txt"), file("a.txt")],
    });
    expect(shuffled.success).toBe(false);
    expect(JSON.stringify(shuffled.error?.issues)).toContain("代码单元序");

    expect(
      WorkspaceSnapshotSchema.safeParse({ id: HASH_A, files: [file("a"), file("a/b")] }).success,
    ).toBe(false);
  });

  it("路径契约（保留设备名/ADS/UNC/长度/碰撞）在解析期被拒", () => {
    const single = (path: string) =>
      WorkspaceSnapshotSchema.safeParse({ id: HASH_A, files: [file(path)] });
    expect(single("CON.txt").success).toBe(false);
    expect(single("a.txt:ads").success).toBe(false);
    expect(single("//server/share/a.txt").success).toBe(false);
    expect(single("a".repeat(513)).success).toBe(false);
    expect(
      WorkspaceSnapshotSchema.safeParse({ id: HASH_A, files: [file("A.txt"), file("a.txt")] })
        .success,
    ).toBe(false);
  });
});

describe("schema 接入：RunMetaSchema 的隔离元数据自洽", () => {
  function metaLine(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "run.meta",
      id: "r_01",
      format_version: 2,
      task: "测试",
      model: "deepseek-chat",
      created_at: "2026-09-17T00:00:00Z",
      parent: null,
      fork: null,
      config_hash: "sha256:abc",
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_01",
        write_authorized: true,
        initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
        origin: { kind: "import" },
      },
      ...over,
    };
  }

  it("合法 v2 根 run 通过", () => {
    expect(RunMetaSchema.parse(metaLine()).workspace?.world_id).toBe("r_01");
  });

  it("合法 v2 分支 run 通过", () => {
    const line = metaLine({
      id: "r_02",
      parent: "r_01",
      fork: { at_span: "s_04", resume_after_step: "s_03", edit: { field: "result", value: "x" } },
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_02",
        write_authorized: true,
        initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
        origin: { kind: "checkpoint", run_id: "r_01", step_span: "s_03" },
      },
    });
    expect(RunMetaSchema.parse(line).parent).toBe("r_01");
  });

  it("矛盾 origin 被拒：根 run 却写 checkpoint", () => {
    const line = metaLine({
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_01",
        write_authorized: true,
        initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
        origin: { kind: "checkpoint", run_id: "r_00", step_span: "s_01" },
      },
    });
    const result = RunMetaSchema.safeParse(line);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("import");
  });

  it("矛盾 origin 被拒：world_id 与 run id 不符", () => {
    const line = metaLine({
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_other",
        write_authorized: true,
        initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
        origin: { kind: "import" },
      },
    });
    expect(RunMetaSchema.safeParse(line).success).toBe(false);
  });

  it("write_authorized 只接受字面 true（审计标注的形状约束）", () => {
    const line = metaLine({
      workspace: {
        profile: "file-tools-v1",
        world_id: "r_01",
        write_authorized: false,
        initial_snapshot: { id: GOLDEN_EMPTY, files: [] },
        origin: { kind: "import" },
      },
    });
    expect(RunMetaSchema.safeParse(line).success).toBe(false);
  });

  it("缺省 workspace 的普通 v1 不受新校验影响", () => {
    const v1 = metaLine({ format_version: 1, workspace: undefined });
    const parsed = RunMetaSchema.parse(v1);
    expect(parsed.workspace).toBeUndefined();
  });
});

describe("workspace-hash：规范清单哈希", () => {
  it('空清单有确定哈希（等于 sha256("[]")）', () => {
    expect(computeWorkspaceSnapshotId([])).toBe(GOLDEN_EMPTY);
  });

  it("ASCII 与中文清单的哈希与金标准一致", () => {
    const ascii = [
      file("a.txt", { sha256: HASH_A, bytes: 3 }),
      file("dir/b.txt", { sha256: HASH_B, bytes: 10 }),
    ];
    expect(computeWorkspaceSnapshotId(ascii)).toBe(GOLDEN_ASCII);

    expect(computeWorkspaceSnapshotId([file("配置/说明.md", { sha256: HASH_C, bytes: 42 })])).toBe(
      GOLDEN_CJK,
    );
  });

  it("哈希与输入顺序无关（乱序输入得到同一 id）", () => {
    const ordered = [file("a.txt", { bytes: 3 }), file("dir/b.txt", { sha256: HASH_B, bytes: 10 })];
    const shuffled = [ordered[1], ordered[0]];
    expect(computeWorkspaceSnapshotId(shuffled)).toBe(computeWorkspaceSnapshotId(ordered));
  });

  it("canonicalWorkspaceFiles 返回排序副本，不修改入参", () => {
    const input = [file("b.txt"), file("a.txt")];
    const canonical = canonicalWorkspaceFiles(input);
    expect(canonical.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(input.map((f) => f.path)).toEqual(["b.txt", "a.txt"]);
  });

  it("createWorkspaceSnapshot 排序并算出对应 id", () => {
    const snapshot = createWorkspaceSnapshot([file("b.txt"), file("a.txt")]);
    expect(snapshot.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(snapshot.id).toBe(computeWorkspaceSnapshotId(snapshot.files));
  });

  it("findSnapshotIdViolation：id 相符通过，被篡改则报错", () => {
    const snapshot = createWorkspaceSnapshot([file("a.txt", { bytes: 3 })]);
    expect(findSnapshotIdViolation(snapshot)).toBeNull();

    const tampered = { ...snapshot, id: HASH_B };
    expect(findSnapshotIdViolation(tampered)).toContain("不符");

    const contentChanged = {
      ...snapshot,
      files: [file("a.txt", { bytes: 999 })],
    };
    expect(findSnapshotIdViolation(contentChanged)).toContain("不符");
  });
});
