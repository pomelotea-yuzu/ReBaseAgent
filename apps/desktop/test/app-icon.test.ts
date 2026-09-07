import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppIconPath } from "../src/main/app-icon";

describe("resolveAppIconPath：开发态/打包态同路径解析", () => {
  it("以 appPath 为基，落到 build/icon.png（asar 内虚拟路径同样成立）", () => {
    expect(resolveAppIconPath("D:/ReBaseAgent/apps/desktop")).toBe(
      join("D:/ReBaseAgent/apps/desktop", "build", "icon.png"),
    );
  });

  it("打包态（app.getAppPath = asar 虚拟路径）解析结果同构", () => {
    const packaged = resolveAppIconPath("D:/app/resources/app.asar");
    expect(packaged).toBe(join("D:/app/resources/app.asar", "build", "icon.png"));
    expect(packaged.endsWith(join("build", "icon.png"))).toBe(true);
  });
});
