import { MAX_LOGICAL_PATH_DEPTH, MAX_LOGICAL_PATH_LENGTH } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MIB,
  WORKSPACE_QUOTA,
  findFileSetQuotaViolation,
  findNewContentQuotaViolation,
} from "../src/index";

/** 造 n 个文件的条目（路径各不相同，字节数为 `bytes`） */
function entries(n: number, bytes: number): { path: string; bytes: number }[] {
  return Array.from({ length: n }, (_, i) => ({ path: `f${i}.bin`, bytes }));
}

describe("workspace quota：固定上限", () => {
  it("首期数值与 design §3 一致，且不可被调用方改写", () => {
    expect(WORKSPACE_QUOTA.maxFiles).toBe(2000);
    expect(WORKSPACE_QUOTA.maxFileBytes).toBe(8 * BYTES_PER_MIB);
    expect(WORKSPACE_QUOTA.maxSnapshotBytes).toBe(64 * BYTES_PER_MIB);
    expect(WORKSPACE_QUOTA.maxNewContentBytes).toBe(128 * BYTES_PER_MIB);
    expect(BYTES_PER_MIB).toBe(1024 * 1024);
    expect(Object.isFrozen(WORKSPACE_QUOTA)).toBe(true);
  });

  it("路径长度/深度上限与 trace-sdk 同源（不在本包另写一份字面量）", () => {
    expect(WORKSPACE_QUOTA.maxPathLength).toBe(MAX_LOGICAL_PATH_LENGTH);
    expect(WORKSPACE_QUOTA.maxPathDepth).toBe(MAX_LOGICAL_PATH_DEPTH);
  });
});

describe("workspace quota：文件集合（导入与运行期共用同一判定）", () => {
  it("空集合与零字节文件合法", () => {
    expect(findFileSetQuotaViolation([])).toBeNull();
    expect(findFileSetQuotaViolation([{ path: "empty.txt", bytes: 0 }])).toBeNull();
    expect(findFileSetQuotaViolation(entries(3, 0))).toBeNull();
  });

  it("文件数上限：等于上限合法，多一个即拒", () => {
    expect(findFileSetQuotaViolation(entries(WORKSPACE_QUOTA.maxFiles, 1))).toBeNull();
    const over = findFileSetQuotaViolation(entries(WORKSPACE_QUOTA.maxFiles + 1, 1));
    expect(over).toContain("文件数超过上限");
    expect(over).toContain("2001");
  });

  it("单文件上限：恰好 8 MiB 合法，多 1 字节即拒并报出是哪条", () => {
    const limit = WORKSPACE_QUOTA.maxFileBytes;
    expect(findFileSetQuotaViolation([{ path: "big.bin", bytes: limit }])).toBeNull();

    const over = findFileSetQuotaViolation([{ path: "big.bin", bytes: limit + 1 }]);
    expect(over).toContain("单文件超过上限");
    expect(over).toContain("big.bin");
  });

  it("快照合计上限：恰好 64 MiB 合法，多 1 字节即拒", () => {
    const limit = WORKSPACE_QUOTA.maxSnapshotBytes;
    // 8 个 8 MiB = 64 MiB，同时满足"单文件不超"与"文件数不超"
    expect(findFileSetQuotaViolation(entries(8, WORKSPACE_QUOTA.maxFileBytes))).toBeNull();

    const over = findFileSetQuotaViolation([
      ...entries(8, WORKSPACE_QUOTA.maxFileBytes),
      { path: "extra.bin", bytes: 1 },
    ]);
    expect(over).toContain("快照合计超过上限");
    expect(over).toContain(String(limit + 1));
  });

  it("判定顺序固定：同时踩文件数与单文件时报文件数", () => {
    const over = findFileSetQuotaViolation(
      entries(WORKSPACE_QUOTA.maxFiles + 1, WORKSPACE_QUOTA.maxFileBytes + 1),
    );
    expect(over).toContain("文件数超过上限");
  });

  it("路径契约不在这里判（分工：路径归 trace-sdk，本函数只看数量与字节）", () => {
    // 这不是漏判，而是刻意的分层：导入预检必须"路径校验 + 配额"两者都调。
    // 若某天有人把这里当成唯一门禁，这条用例会提醒他缺了另一半。
    expect(findFileSetQuotaViolation([{ path: "../escape", bytes: 1 }])).toBeNull();
  });
});

describe("workspace quota：一次运行新增内容（按唯一哈希集合求和）", () => {
  it("零新增与恰好上限合法，多 1 字节即拒", () => {
    expect(findNewContentQuotaViolation(0)).toBeNull();
    expect(findNewContentQuotaViolation(WORKSPACE_QUOTA.maxNewContentBytes)).toBeNull();
    const over = findNewContentQuotaViolation(WORKSPACE_QUOTA.maxNewContentBytes + 1);
    expect(over).toContain("新增内容超过上限");
    expect(over).toContain(String(WORKSPACE_QUOTA.maxNewContentBytes + 1));
  });

  it("新增内容上限高于单份快照上限（重复写入不得耗光配额）", () => {
    expect(WORKSPACE_QUOTA.maxNewContentBytes).toBeGreaterThan(WORKSPACE_QUOTA.maxSnapshotBytes);
  });
});
