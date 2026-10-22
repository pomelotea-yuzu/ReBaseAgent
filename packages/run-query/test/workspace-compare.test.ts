import * as replay from "@rebaseagent/replay";
import { describe, expect, it } from "vitest";
import {
  compareWorkspaceSnapshots,
  readComparedWorkspaceFile,
} from "../src/read/workspace-compare";

describe("run-query 跨运行比较共享访问面", () => {
  it("不复制实现：导出与 replay compare-api 是同一函数", () => {
    expect(compareWorkspaceSnapshots).toBe(replay.compareWorkspaceSnapshots);
    expect(readComparedWorkspaceFile).toBe(replay.readComparedWorkspaceFile);
  });
});
