import { rmSync } from "node:fs";
import { join } from "node:path";
import { ToolRegistry } from "@rebaseagent/agent-loop";
import type { Tool } from "@rebaseagent/agent-loop";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  type WorkspaceWorld,
  createFileToolsV1,
  createWorkspaceBlobStore,
  createWorkspaceWorld,
  hashWorkspaceContent,
  importSourceTree,
  parseReadFileArgs,
} from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 3.1：固定 `file-tools-v1` 定义与受控 `read_file`。
 *
 * 验证点（tasks.md 3.1）：
 * - `workspace-isolation/二进制字节保持`：非 UTF-8 文件读过文本时**报工具错误**，不用替换字符冒充；
 * - `workspace-isolation/名称冲突和参数非法` 的**读取参数部分**：content 非字符串、额外键、非法路径；
 * - **不使用宿主 cwd 查找文件**：path 只用来查世界的映射表，与 `exec.cwd` 无关。
 *
 * 用例都走"真导入 → 建世界 → 经 ToolRegistry 执行"的端到端路径：直接调 handler 会绕过
 * `ToolRegistry` 的"错误是数据"转换，而模型看到的恰恰是那一层的结果。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(cleanupTempDirs);

/** 导入一棵真目录树并建一个世界 */
async function importedWorld(options: {
  tree: Record<string, string | Uint8Array>;
  allowFileWrites?: boolean;
}): Promise<{ source: string; dataDir: string; world: WorkspaceWorld }> {
  const source = makeTempDir("file-tools-src-");
  const dataDir = join(makeTempDir("file-tools-data-"), "data");
  writeTree(source, options.tree);

  const imported = await importSourceTree({ source, dataDir });
  if (!imported.ok) {
    throw new Error(`fixture 导入失败：${imported.failure.reason}`);
  }
  const created = createWorkspaceWorld({
    dataDir,
    snapshot: createWorkspaceSnapshot(imported.value.files),
    allowFileWrites: options.allowFileWrites ?? true,
  });
  if (!created.ok) {
    throw new Error(`fixture 建世界失败：${created.failure.reason}`);
  }
  return { source, dataDir, world: created.value };
}

/**
 * 经 `ToolRegistry` 执行工具——和模型走的是同一条路。
 *
 * ⚠️ `ctx.cwd` 刻意填一个**不存在**的宿主路径：受控工具不该碰 cwd，填一个假的仍然正常工作才是证据。
 * 若某个用例的 `cwd` 恰好影响结果，那正说明它偷偷用了 cwd 去解析路径。
 *
 * 只投影 `result` / `error`：`durMs` 是计时噪声，断言里没有它才有意义。
 */
async function callTool(
  world: WorkspaceWorld,
  name: string,
  args: unknown,
  cwd = "D:/definitely-not-a-host-path/nope",
): Promise<{ result: string; error: string | null }> {
  const registry = new ToolRegistry(createFileToolsV1(world));
  const { result, error } = await registry.execute(name, JSON.stringify(args), {
    cwd,
    signal: null,
  });
  return { result, error };
}

describe("file-tools-v1：固定定义", () => {
  it("profile 名与两个工具的名字、顺序、sideEffect 固定", () => {
    expect(FILE_TOOLS_V1_PROFILE).toBe("file-tools-v1");
    expect(FILE_TOOLS_V1_DEFINITIONS.map((def) => def.name)).toEqual([
      READ_FILE_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
    ]);
    // sideEffect 是语义：读可零成本重放，写需真实重执行
    expect(FILE_TOOLS_V1_DEFINITIONS.map((def) => def.sideEffect)).toEqual([false, true]);
  });

  it("参数 schema 声明 required 与 additionalProperties:false", () => {
    const [read, write] = FILE_TOOLS_V1_DEFINITIONS;
    expect(read.parameters).toMatchObject({
      required: ["path"],
      additionalProperties: false,
    });
    expect(write.parameters).toMatchObject({
      required: ["path", "content"],
      additionalProperties: false,
    });
  });

  it("createFileToolsV1 造出的表与固定定义逐字段一致（定义不被调用方改写）", () => {
    const tools = createFileToolsV1(
      createWorkspaceWorld({ dataDir: makeTempDir("ft-"), allowFileWrites: false }) as never &
        WorkspaceWorld,
    );
    const definitions = tools.map(({ handler: _handler, ...def }: Tool) => def);
    expect(definitions).toEqual([...FILE_TOOLS_V1_DEFINITIONS]);
  });
});

describe("read_file：读取世界内容", () => {
  it("读得到导入的文本，且返回值就是原文", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before", "dir/b.txt": "嵌套" } });

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "before",
      error: null,
    });
    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "dir/b.txt" })).toEqual({
      result: "嵌套",
      error: null,
    });
  });

  it("不使用宿主 cwd 查找文件：cwd 指向不存在的路径也能读到", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });

    // cwd 根本不存在，且与源目录/数据目录都无关
    const result = await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" }, "D:/nope");
    expect(result).toEqual({ result: "before", error: null });
    // 传一个"看起来像源目录"的 cwd 也一样——路径只查映射表，不拼宿主路径
    const result2 = await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" }, "C:/Windows");
    expect(result2).toEqual({ result: "before", error: null });
  });

  it("工具输入的 \\ 规范化为 /：反斜杠路径能读到同一文件", async () => {
    const { world } = await importedWorld({ tree: { "dir/b.txt": "嵌套" } });

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "dir\\b.txt" })).toEqual({
      result: "嵌套",
      error: null,
    });
  });

  it("读得到工具刚写进世界的内容（写后立即读的回环）", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const written = await world.writeFile("nested/new.txt", utf8("hello"));

    expect(written.ok).toBe(true);
    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "nested/new.txt" })).toEqual({
      result: "hello",
      error: null,
    });
  });

  it("路径不存在：报可诊断的工具错误，而不是空内容", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const { result, error } = await callTool(world, READ_FILE_TOOL_NAME, { path: "nope.txt" });

    expect(result).toBe("");
    expect(error).toContain("read_file 失败");
    expect(error).toContain("not_found");
  });

  it("附件缺失：报工具错误，不静默返回旧内容或回读源目录", async () => {
    const { dataDir, world } = await importedWorld({ tree: { "a.txt": "before" } });
    const store = createWorkspaceBlobStore(dataDir);
    rmSync(store.blobPath(hashWorkspaceContent(utf8("before"))));

    const { error } = await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" });
    expect(error).toContain("missing");
  });
});

describe("read_file：二进制字节保持", () => {
  it("非 UTF-8 文件读过文本时报错，不用替换字符冒充原内容", async () => {
    // 0xFF 0xFE 不是合法 UTF-8 起始序列
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x42]);
    const { world } = await importedWorld({ tree: { "blob.bin": binary } });

    const { result, error } = await callTool(world, READ_FILE_TOOL_NAME, { path: "blob.bin" });

    expect(result).toBe("");
    expect(error).toContain("不是合法 UTF-8");
    // 错误里带上哈希与字节数，便于对照附件核对原始字节
    expect(error).toContain(hashWorkspaceContent(binary));
    expect(error).toContain(String(binary.byteLength));
    // 关键：无论如何都不能出现替换字符
    expect(error).not.toContain("\uFFFD");
  });

  it("原始字节仍完好地留在附件存储里（可核对的二进制）", async () => {
    const binary = new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0xff]);
    const { dataDir, world } = await importedWorld({ tree: { "blob.bin": binary } });

    await callTool(world, READ_FILE_TOOL_NAME, { path: "blob.bin" });

    const store = createWorkspaceBlobStore(dataDir);
    const stored = await store.readVerified({
      path: "blob.bin",
      sha256: hashWorkspaceContent(binary),
      bytes: binary.byteLength,
    });
    expect(stored.state).toBe("ok");
    expect(stored.state === "ok" ? [...stored.data] : []).toEqual([...binary]);
  });

  it("空文件是合法文本：读得到空字符串，不报错", async () => {
    const { world } = await importedWorld({ tree: { "empty.txt": "" } });

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "empty.txt" })).toEqual({
      result: "",
      error: null,
    });
  });

  it("含 BOM 的 UTF-8 文本按合法 UTF-8 返回（BOM 保留，不做编辑器式改写）", async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hi")]);
    const { world } = await importedWorld({ tree: { "bom.txt": withBom } });

    const { result, error } = await callTool(world, READ_FILE_TOOL_NAME, { path: "bom.txt" });
    expect(error).toBeNull();
    expect(result.charCodeAt(0)).toBe(0xfeff);
  });
});

describe("read_file：参数非法（严格校验，不静默改写）", () => {
  const cases: readonly {
    readonly label: string;
    readonly args: unknown;
    readonly needle: string;
  }[] = [
    { label: "缺少 path", args: {}, needle: "缺少必填参数 path" },
    { label: "额外键", args: { path: "a.txt", encoding: "base64" }, needle: "不接受参数" },
    { label: "path 是数字", args: { path: 123 }, needle: "必须是字符串" },
    { label: "path 是 null", args: { path: null }, needle: "必须是字符串" },
    { label: "path 是空串", args: { path: "" }, needle: "不得为空" },
    { label: "参数是数组", args: ["a.txt"], needle: "必须是对象" },
    { label: "参数是字符串", args: "a.txt", needle: "必须是对象" },
    { label: "参数是 null", args: null, needle: "必须是对象" },
  ];

  for (const { label, args, needle } of cases) {
    it(`${label}：报工具错误且不读任何文件`, async () => {
      const { world } = await importedWorld({ tree: { "a.txt": "before" } });

      const { result, error } = await callTool(world, READ_FILE_TOOL_NAME, args);

      expect(result).toBe("");
      expect(error).toContain(needle);
    });
  }

  const badPaths: readonly { readonly label: string; readonly path: string }[] = [
    { label: "穿越 ../a", path: "../a" },
    { label: "反斜杠穿越 ..\\a", path: "..\\a" },
    { label: "盘符路径 C:/a.txt", path: "C:/a.txt" },
    { label: "UNC 路径 //server/share/a", path: "//server/share/a" },
    { label: "设备路径 //./PhysicalDrive0", path: "//./PhysicalDrive0" },
    { label: "绝对路径 /etc/passwd", path: "/etc/passwd" },
    { label: "ADS file:stream", path: "a.txt:stream" },
    { label: "保留设备名 CON", path: "CON" },
    { label: "保留设备名带扩展 dir/CON.log", path: "dir/CON.log" },
    { label: "尾随点 a.", path: "a." },
    { label: "尾随空格 a ", path: "a " },
    { label: "重复分隔符 a//b", path: "a//b" },
    { label: "尾随斜杠 dir/", path: "dir/" },
    { label: "NUL 字符", path: "a\u0000b" },
  ];

  for (const { label, path } of badPaths) {
    it(`恶意路径「${label}」被拒，不读写宿主目标`, async () => {
      const { world } = await importedWorld({ tree: { "a.txt": "before" } });

      const { result, error } = await callTool(world, READ_FILE_TOOL_NAME, { path });

      expect(result).toBe("");
      expect(error).toContain("路径不合法");
      // 世界清单未被改动（读操作本来就不改，这里钉的是"没有意外写入"）
      expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    });
  }

  it("parseReadFileArgs 是纯函数：合规路径返回规范化结果", () => {
    expect(parseReadFileArgs({ path: "dir\\b.txt" })).toEqual({ path: "dir/b.txt" });
    expect(parseReadFileArgs({ path: "a.txt" })).toEqual({ path: "a.txt" });
  });
});

describe("file-tools-v1：未知工具与 write_file 占位", () => {
  it("未知工具由 ToolRegistry 记录错误，不执行任何动作", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const { result, error } = await callTool(world, "shell", { cmd: "rm -rf /" });

    expect(result).toBe("");
    expect(error).toContain("未知工具");
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("write_file 在 3.1 阶段明确报未实现（不静默成功、不落宿主盘）", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const { result, error } = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "b.txt",
      content: "x",
    });

    expect(result).toBe("");
    expect(error).toContain("尚未实现");
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("未授权世界的读不受影响（授权只管写）", async () => {
    const { world } = await importedWorld({
      tree: { "a.txt": "before" },
      allowFileWrites: false,
    });

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "before",
      error: null,
    });
  });
});
