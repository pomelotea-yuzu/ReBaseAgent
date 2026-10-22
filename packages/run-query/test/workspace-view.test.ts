import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectWorkspace, readWorkspaceFileForView } from "../src/read/workspace-view";

let root = "";
let dataDir = "";
const repository = {
  loadRunRecord(): never {
    throw new Error("缺失 run 的元数据读取不应发生");
  },
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "run-query-workspace-view-"));
  dataDir = join(root, "data");
  mkdirSync(join(dataDir, "traces"), { recursive: true });
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("run-query 文件检查点包装", () => {
  it("缺失 run 的清单查看给可辨认拒绝，不伪造空清单", async () => {
    const outcome = await inspectWorkspace({ dataDir, repository }, { runId: "r_missing" });
    expect(outcome).toMatchObject({ ok: false, code: "WORKSPACE_RUN_NOT_FOUND" });
  });

  it("缺失 run 的文件读取给 rejected 状态，不把请求不成立伪装成数据缺失", async () => {
    const result = await readWorkspaceFileForView(
      { dataDir, repository },
      { runId: "r_missing", path: "a.txt" },
    );
    expect(result).toMatchObject({ status: "rejected", code: "run_not_found" });
  });
});
