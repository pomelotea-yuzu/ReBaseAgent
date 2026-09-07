import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DataDirOptions,
  MARKER_FILE,
  POINTER_FILE,
  PORTABLE_DIR_NAME,
  SESSION_DATA_DIR_NAME,
  USER_DATA_DIR_NAME,
  derivePortableIdentity,
  portableRuntimePaths,
  resolveAnchorDir,
  resolveDataDir,
} from "../src/main/data-dir";

/** 最小 fs 注入：用内存映射模拟文件存在性（key 用 join 构造，与实现侧一致） */
function fakeFs(files: Record<string, string>): DataDirOptions["fs"] {
  return {
    existsSync: (p) => Object.hasOwn(files, p),
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`不存在：${p}`);
      return content;
    },
  } as NonNullable<DataDirOptions["fs"]>;
}

const devDir = join("D:", "repo");
const exeDir = join("D:", "app");

describe("resolveDataDir：三条路径", () => {
  it("开发模式 → 仓库根 .rebaseagent/", () => {
    const result = resolveDataDir({ devDir, exeDir, packaged: false, fs: fakeFs({}) });
    expect(result).toEqual({ kind: "resolved", dir: join(devDir, ".rebaseagent") });
  });

  it("打包 + portable.marker → <exe 目录>/data", () => {
    const fs = fakeFs({ [join(exeDir, MARKER_FILE)]: "" });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "resolved", dir: join(exeDir, "data") });
  });

  it("打包 + 无 marker + 有指针 → 指针记录的目录", () => {
    const target = join("E:", "my-traces");
    const fs = fakeFs({ [join(exeDir, POINTER_FILE)]: JSON.stringify({ dataDir: target }) });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "resolved", dir: target });
  });

  it("打包 + 无 marker + 无指针 → needs-selection，不创建任何文件", () => {
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs: fakeFs({}) });
    expect(result).toEqual({ kind: "needs-selection" });
  });

  it("指针内容非法（dataDir 非字符串）→ needs-selection", () => {
    const fs = fakeFs({ [join(exeDir, POINTER_FILE)]: JSON.stringify({ dataDir: 42 }) });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "needs-selection" });
  });
});

/**
 * 单文件 portable exe 会解压到系统临时目录再运行，此时 app.getPath("exe") 指向临时目录。
 * 数据若锚定在那里，退出即被清理 —— 必须锚定到 PORTABLE_EXECUTABLE_DIR（用户双击处）。
 */
describe("resolveDataDir：portable exe 锚点回落", () => {
  const tempExeDir = join("C:", "Temp", "nsxA2C0.tmp"); // 应用实际运行处（临时解压目录）
  const userDir = join("D:", "portable"); // 用户双击 exe 处（PORTABLE_EXECUTABLE_DIR）

  it("marker 在用户目录 → 数据落在用户目录，而不是临时解压目录", () => {
    const fs = fakeFs({ [join(userDir, MARKER_FILE)]: "" });
    const result = resolveDataDir({
      devDir,
      exeDir: tempExeDir,
      portableExeDir: userDir,
      packaged: true,
      fs,
    });
    expect(result).toEqual({ kind: "resolved", dir: join(userDir, "data") });
  });

  it("临时目录与用户目录都有 marker 时，以用户目录为准", () => {
    const fs = fakeFs({
      [join(userDir, MARKER_FILE)]: "",
      [join(tempExeDir, MARKER_FILE)]: "",
    });
    const result = resolveDataDir({
      devDir,
      exeDir: tempExeDir,
      portableExeDir: userDir,
      packaged: true,
      fs,
    });
    expect(result).toEqual({ kind: "resolved", dir: join(userDir, "data") });
  });

  it("单文件 portable：有 PORTABLE_EXECUTABLE_DIR 时不读指针（portable 身份即 resolved，见 D3）", () => {
    const target = join("E:", "my-traces");
    const fs = fakeFs({ [join(userDir, POINTER_FILE)]: JSON.stringify({ dataDir: target }) });
    const result = resolveDataDir({
      devDir,
      exeDir: tempExeDir,
      portableExeDir: userDir,
      packaged: true,
      fs,
    });
    expect(result).toEqual({ kind: "resolved", dir: join(userDir, "data") });
  });

  it("无 PORTABLE_EXECUTABLE_DIR（普通安装版）时行为不变", () => {
    const fs = fakeFs({ [join(exeDir, MARKER_FILE)]: "" });
    const result = resolveDataDir({ devDir, exeDir, packaged: true, fs });
    expect(result).toEqual({ kind: "resolved", dir: join(exeDir, "data") });
  });

  it("单文件 portable：外层只有 exe（无任何 marker/指针）→ 直接解析为 <用户目录>/data", () => {
    // D3：PORTABLE_EXECUTABLE_DIR 本身就是可靠身份，不再要求外层 marker
    const fs = fakeFs({});
    const result = resolveDataDir({
      devDir,
      exeDir: tempExeDir,
      portableExeDir: userDir,
      packaged: true,
      fs,
    });
    expect(result).toEqual({ kind: "resolved", dir: join(userDir, "data") });
  });

  it("单文件 portable：临时解压目录有 marker 但外层没有 → 以外层为准", () => {
    const fs = fakeFs({ [join(tempExeDir, MARKER_FILE)]: "" });
    const result = resolveDataDir({
      devDir,
      exeDir: tempExeDir,
      portableExeDir: userDir,
      packaged: true,
      fs,
    });
    expect(result).toEqual({ kind: "resolved", dir: join(userDir, "data") });
  });
});

describe("derivePortableIdentity：环境变量 / marker / 非 portable 三态", () => {
  const tempExeDir = join("C:", "Temp", "nsxA2C0.tmp"); // 临时解压目录
  const userDir = join("D:", "portable"); // PORTABLE_EXECUTABLE_DIR

  it("有 PORTABLE_EXECUTABLE_DIR → 单文件 portable，锚点 = 该目录（忽略 exe 目录与 marker）", () => {
    expect(
      derivePortableIdentity({
        packaged: true,
        exeDir: tempExeDir,
        portableExeDir: userDir,
        fs: fakeFs({}),
      }),
    ).toEqual({ isPortable: true, anchorDir: userDir });
  });

  it("无环境变量但 exe 旁有 marker → unpacked portable，锚点 = exe 目录", () => {
    expect(
      derivePortableIdentity({
        packaged: true,
        exeDir,
        portableExeDir: undefined,
        fs: fakeFs({ [join(exeDir, MARKER_FILE)]: "" }),
      }),
    ).toEqual({ isPortable: true, anchorDir: exeDir });
  });

  it("无环境变量且 exe 旁无 marker → 非 portable（返回 null，走指针/选择流程）", () => {
    expect(
      derivePortableIdentity({
        packaged: true,
        exeDir,
        portableExeDir: undefined,
        fs: fakeFs({}),
      }),
    ).toBeNull();
  });

  it("开发模式无 marker 也非 portable", () => {
    expect(
      derivePortableIdentity({
        packaged: false,
        exeDir,
        portableExeDir: undefined,
        fs: fakeFs({}),
      }),
    ).toBeNull();
  });
});

describe("portableRuntimePaths：pre-ready 锚定子目录", () => {
  const userDir = join("D:", "portable");

  it("userData / sessionData 落在 <锚点>/data/ 下明确子目录", () => {
    const paths = portableRuntimePaths(userDir);
    expect(paths.userData).toBe(join(userDir, PORTABLE_DIR_NAME, USER_DATA_DIR_NAME));
    expect(paths.sessionData).toBe(join(userDir, PORTABLE_DIR_NAME, SESSION_DATA_DIR_NAME));
  });
});

describe("resolveAnchorDir", () => {
  it("有 portableExeDir 时优先于 exeDir", () => {
    expect(resolveAnchorDir({ exeDir: "A", portableExeDir: "B" })).toBe("B");
  });

  it("无 portableExeDir 时回落 exeDir", () => {
    expect(resolveAnchorDir({ exeDir: "A" })).toBe("A");
  });
});
