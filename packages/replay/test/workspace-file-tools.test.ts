import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ToolRegistry } from "@rebaseagent/agent-loop";
import type { Tool } from "@rebaseagent/agent-loop";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  READ_FILE_TOOL_NAME,
  WORKSPACE_QUOTA,
  WRITE_FILE_TOOL_NAME,
  type WorkspaceWorld,
  createFileToolsV1,
  createWorkspaceBlobStore,
  createWorkspaceWorld,
  hashWorkspaceContent,
  importSourceTree,
  parseReadFileArgs,
  parseWriteFileArgs,
} from "../src/index";
import { cleanupTempDirs, makeTempDir, writeTree } from "./workspace-helpers";

/**
 * 3.1 / 3.2：固定 `file-tools-v1` 定义、受控 `read_file` 与受控 `write_file`。
 *
 * 验证点：
 * - 3.1 —— `workspace-isolation/二进制字节保持`：非 UTF-8 文件读过文本时**报工具错误**，
 *   不用替换字符冒充；`名称冲突和参数非法` 的读取参数部分；**不使用宿主 cwd 查找文件**。
 * - 3.2 —— `同一分支写后立即读取`（含必要逻辑父目录）、`内容发布失败和并发去重`、
 *   `超限导入与运行时超限` 的**运行写入部分**（失败成工具错误、旧映射与已有检查点不变）；
 *   字节数按**实际 UTF-8 编码**限制。
 *
 * 用例都走"真导入 → 建世界 → 经 ToolRegistry 执行"的端到端路径：直接调 handler 会绕过
 * `ToolRegistry` 的"错误是数据"转换，而模型看到的恰恰是那一层的结果。
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(cleanupTempDirs);

/** 源目录的逐字节指纹（相对路径 + 大小 + 内容哈希） */
function sourceFingerprint(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else {
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        entries.push(`${relative(root, full)}:${statSync(full).size}:${hash}`);
      }
    }
  };
  walk(root);
  return entries.sort();
}

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

describe("file-tools-v1：未知工具", () => {
  it("未知工具由 ToolRegistry 记录错误，不执行任何动作", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const { result, error } = await callTool(world, "shell", { cmd: "rm -rf /" });

    expect(result).toBe("");
    expect(error).toContain("未知工具");
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

describe("write_file：写后立即读与来源隔离（3.2）", () => {
  it("同一分支写后立即读取：新路径可读回，源目录与其他分支不变", async () => {
    const { source, world } = await importedWorld({ tree: { "a.txt": "before" } });
    const sourceBefore = sourceFingerprint(source);
    const sibling = world.fork({ allowFileWrites: true });

    const written = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "nested/a.txt",
      content: "hello",
    });
    expect(written.error).toBeNull();
    expect(written.result).toContain("nested/a.txt");
    expect(written.result).toContain("5 字节");

    // 必要逻辑父目录可用：新路径立刻读得回
    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "nested/a.txt" })).toEqual({
      result: "hello",
      error: null,
    });
    // 只写本分支：兄弟世界与源目录逐字节不变
    expect(sibling.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    expect(sourceFingerprint(source)).toEqual(sourceBefore);
  });

  it("覆盖写：读回的是新内容，清单条目更新为新的哈希与字节数", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "before" } });
    const before = world.listFiles().find((file) => file.path === "a.txt");

    const written = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "a.txt",
      content: "after!",
    });
    expect(written.error).toBeNull();

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "after!",
      error: null,
    });
    const after = world.listFiles().find((file) => file.path === "a.txt");
    expect(after?.sha256).not.toBe(before?.sha256);
    expect(after?.bytes).toBe(utf8("after!").byteLength);
    // 覆盖不新增文件
    expect(world.listFiles()).toHaveLength(1);
  });

  it("零字节内容是合法的：写入后读回空字符串", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });

    const written = await callTool(world, WRITE_FILE_TOOL_NAME, { path: "empty.txt", content: "" });
    expect(written.error).toBeNull();
    expect(written.result).toContain("0 字节");
    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "empty.txt" })).toEqual({
      result: "",
      error: null,
    });
  });

  it("字节数按实际 UTF-8 编码算，不按字符数（中文 1 字符 = 3 字节）", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });

    const written = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "cn.txt",
      content: "中文内容",
    });
    // 4 个中文字符 → 12 字节；若按 content.length 报就是错的
    expect(written.result).toContain("12 字节");
    expect(world.listFiles().find((file) => file.path === "cn.txt")?.bytes).toBe(12);
  });

  it("代理对（emoji）按 4 字节计：UTF-16 length 是 2", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });
    const emoji = "🀄"; // U+1F004，UTF-16 2 单元、UTF-8 4 字节

    await callTool(world, WRITE_FILE_TOOL_NAME, { path: "e.txt", content: emoji });
    expect(world.listFiles().find((file) => file.path === "e.txt")?.bytes).toBe(4);
  });

  it("写入不产生任何宿主文件：源目录与数据目录外都没有新条目", async () => {
    const { source, world } = await importedWorld({ tree: { "a.txt": "before" } });
    const sourceBefore = sourceFingerprint(source);

    await callTool(world, WRITE_FILE_TOOL_NAME, { path: "deep/a/b/c.txt", content: "x" });

    // 源目录结构完全没变（世界只写附件，不建宿主目录）
    expect(sourceFingerprint(source)).toEqual(sourceBefore);
    expect(readdirSync(source)).toEqual(["a.txt"]);
  });
});

describe("write_file：参数非法（严格校验，不静默改写）", () => {
  const cases: readonly {
    readonly label: string;
    readonly args: unknown;
    readonly needle: string;
  }[] = [
    { label: "缺 path", args: { content: "x" }, needle: "缺少必填参数 path" },
    { label: "缺 content", args: { path: "a.txt" }, needle: "缺少必填参数 content" },
    { label: "content 是 null", args: { path: "a.txt", content: null }, needle: "必须是字符串" },
    { label: "content 是数字", args: { path: "a.txt", content: 42 }, needle: "必须是字符串" },
    {
      label: "content 是对象",
      args: { path: "a.txt", content: { text: "x" } },
      needle: "必须是字符串",
    },
    {
      label: "额外键",
      args: { path: "a.txt", content: "x", mode: "append" },
      needle: "不接受参数",
    },
    { label: "path 是数字", args: { path: 1, content: "x" }, needle: "必须是字符串" },
    { label: "参数是数组", args: ["a.txt", "x"], needle: "必须是对象" },
  ];

  for (const { label, args, needle } of cases) {
    it(`${label}：报工具错误且清单不变`, async () => {
      const { world } = await importedWorld({ tree: { "a.txt": "before" } });

      const { result, error } = await callTool(world, WRITE_FILE_TOOL_NAME, args);

      expect(result).toBe("");
      expect(error).toContain(needle);
      expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
      expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
        result: "before",
        error: null,
      });
    });
  }

  const badPaths: readonly { readonly label: string; readonly path: string }[] = [
    { label: "穿越 ../a", path: "../a" },
    { label: "反斜杠穿越 ..\\a", path: "..\\a" },
    { label: "盘符路径", path: "C:/a.txt" },
    { label: "UNC 路径", path: "//server/share/a.txt" },
    { label: "绝对路径", path: "/etc/passwd" },
    { label: "ADS", path: "a.txt:stream" },
    { label: "保留设备名", path: "NUL" },
    { label: "尾随点", path: "a." },
    { label: "NUL 字符", path: "a\u0000b" },
  ];

  for (const { label, path } of badPaths) {
    it(`恶意路径「${label}」被拒且清单不变`, async () => {
      const { world } = await importedWorld({ tree: { "a.txt": "before" } });

      const { result, error } = await callTool(world, WRITE_FILE_TOOL_NAME, { path, content: "x" });

      expect(result).toBe("");
      expect(error).toContain("路径不合法");
      expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    });
  }

  it("parseWriteFileArgs 是纯函数：返回规范化路径与原样 content", () => {
    expect(parseWriteFileArgs({ path: "dir\\b.txt", content: "x" })).toEqual({
      path: "dir/b.txt",
      content: "x",
    });
    // 空串是合法内容
    expect(parseWriteFileArgs({ path: "a.txt", content: "" })).toEqual({
      path: "a.txt",
      content: "",
    });
  });
});

describe("write_file：授权限定于当前世界（3.2）", () => {
  it("未授权世界写入被拒（not_authorized），清单不变", async () => {
    const { world } = await importedWorld({
      tree: { "a.txt": "before" },
      allowFileWrites: false,
    });

    const { result, error } = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "b.txt",
      content: "x",
    });

    expect(result).toBe("");
    expect(error).toContain("not_authorized");
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("读写共用同一份授权判定：读照常、写被拒", async () => {
    const { world } = await importedWorld({
      tree: { "a.txt": "before" },
      allowFileWrites: false,
    });

    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toMatchObject({
      result: "before",
      error: null,
    });
    expect(
      await callTool(world, WRITE_FILE_TOOL_NAME, { path: "a.txt", content: "y" }),
    ).toMatchObject({ error: expect.stringContaining("not_authorized") });
    expect(await callTool(world, READ_FILE_TOOL_NAME, { path: "a.txt" })).toMatchObject({
      result: "before",
      error: null,
    });
  });

  it("授权不传染：兄弟世界各自决定，一个写不动另一个", async () => {
    const { world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const authorized = parent.fork({ allowFileWrites: true });
    const readOnly = parent.fork({ allowFileWrites: false });

    expect(
      (await callTool(authorized, WRITE_FILE_TOOL_NAME, { path: "new.txt", content: "y" })).error,
    ).toBeNull();
    expect(
      (await callTool(readOnly, WRITE_FILE_TOOL_NAME, { path: "new.txt", content: "y" })).error,
    ).toContain("not_authorized");

    expect(authorized.listFiles().map((file) => file.path)).toEqual(["a.txt", "new.txt"]);
    expect(readOnly.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
  });
});

describe("write_file：发布失败与并发去重（3.2）", () => {
  it("附件发布失败：报工具错误（write_failed）且映射不变", async () => {
    const { dataDir, world } = await importedWorld({ tree: { "a.txt": "a" } });
    // 把附件根目录换成普通文件 ⇒ 发布必然失败
    const store = createWorkspaceBlobStore(dataDir);
    rmSync(store.root, { recursive: true, force: true });
    writeFileSync(store.root, "占位");

    const { result, error } = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "b.txt",
      content: "b",
    });

    expect(result).toBe("");
    expect(error).toContain("write_failed");
    // 旧**映射**保持：清单仍是原样，没有把失败的新路径塞进去
    // （这里不能断言"a.txt 还能读回来"——附件根被整个换掉了，a.txt 自己的附件也已不在）
    expect(world.listFiles().map((file) => file.path)).toEqual(["a.txt"]);
    expect(world.quotaUsage().newContentBytes).toBe(0);
  });

  it("两个世界并发写同一内容：附件只存一份，各自清单都有该条目", async () => {
    const { dataDir, world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const left = parent.fork({ allowFileWrites: true });
    const right = parent.fork({ allowFileWrites: true });
    const shared = "共享内容";

    await Promise.all([
      callTool(left, WRITE_FILE_TOOL_NAME, { path: "s.txt", content: shared }),
      callTool(right, WRITE_FILE_TOOL_NAME, { path: "s.txt", content: shared }),
    ]);

    const store = createWorkspaceBlobStore(dataDir);
    expect(
      readdirSync(store.root).filter((name) => name === hashWorkspaceContent(utf8(shared))),
    ).toHaveLength(1);
    expect(left.listFiles().find((file) => file.path === "s.txt")?.bytes).toBe(
      utf8(shared).byteLength,
    );
    expect(right.listFiles().find((file) => file.path === "s.txt")?.bytes).toBe(
      utf8(shared).byteLength,
    );
  });

  it("两个世界并发覆盖同一路径：各自读回自写的内容，互不覆盖", async () => {
    const { world: parent } = await importedWorld({ tree: { "a.txt": "before" } });
    const left = parent.fork({ allowFileWrites: true });
    const right = parent.fork({ allowFileWrites: true });

    await Promise.all([
      callTool(left, WRITE_FILE_TOOL_NAME, { path: "a.txt", content: "left" }),
      callTool(right, WRITE_FILE_TOOL_NAME, { path: "a.txt", content: "right" }),
    ]);

    expect(await callTool(left, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "left",
      error: null,
    });
    expect(await callTool(right, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "right",
      error: null,
    });
    expect(await callTool(parent, READ_FILE_TOOL_NAME, { path: "a.txt" })).toEqual({
      result: "before",
      error: null,
    });
  });
});

describe("write_file：运行时配额超限（3.2）", () => {
  it("单文件恰好 8 MiB 合法；多 1 字节被拒且内容未发布、清单不变", async () => {
    const { dataDir, world } = await importedWorld({ tree: { "keep.txt": "k" } });
    const store = createWorkspaceBlobStore(dataDir);
    // 一个恰好顶到单文件上限的 ASCII 字符串（1 字节/字符）
    const atLimit = "a".repeat(WORKSPACE_QUOTA.maxFileBytes);

    const ok = await callTool(world, WRITE_FILE_TOOL_NAME, { path: "big.txt", content: atLimit });
    expect(ok.error).toBeNull();
    expect(world.listFiles().find((file) => file.path === "big.txt")?.bytes).toBe(
      WORKSPACE_QUOTA.maxFileBytes,
    );

    const over = `${atLimit}a`;
    const rejected = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "too-big.txt",
      content: over,
    });
    expect(rejected.error).toContain("quota_exceeded");
    // 失败写入不留在映射里，也不留附件
    expect(world.listFiles().map((file) => file.path)).toEqual(["big.txt", "keep.txt"]);
    expect(readdirSync(store.root)).not.toContain(hashWorkspaceContent(utf8(over)));
  });

  it("文件数超上限：第 2001 个文件被拒，清单不变", async () => {
    const { world } = await importedWorld({ tree: { "keep.txt": "k" } });

    for (let i = 0; i < WORKSPACE_QUOTA.maxFiles - 1; i++) {
      const written = await callTool(world, WRITE_FILE_TOOL_NAME, {
        path: `f${String(i).padStart(5, "0")}.txt`,
        content: "x",
      });
      expect(written.error, `第 ${i + 1} 个`).toBeNull();
    }
    expect(world.quotaUsage().fileCount).toBe(WORKSPACE_QUOTA.maxFiles);

    const rejected = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "overflow.txt",
      content: "x",
    });
    expect(rejected.error).toContain("quota_exceeded");
    expect(world.quotaUsage().fileCount).toBe(WORKSPACE_QUOTA.maxFiles);
  });

  it("新增内容配额：连续覆盖写同一路径，超 128 MiB 后成工具错误", async () => {
    const { world } = await importedWorld({ tree: { "a.txt": "a" } });
    // 每份都**恰好** 8 MiB（内容各不相同 ⇒ 每份都进"本 run 新增"；
    // 刻意不超单文件上限，才能干净地只测"新增内容"这一条配额）
    const chunk = "b".repeat(WORKSPACE_QUOTA.maxFileBytes);
    for (let i = 0; i < 16; i++) {
      // 只改第一个字符来区分内容，长度保持 8 MiB
      const content = `${String.fromCharCode(97 + i)}${chunk.slice(1)}`;
      const written = await callTool(world, WRITE_FILE_TOOL_NAME, { path: "a.txt", content });
      expect(written.error, `第 ${i + 1} 次`).toBeNull();
    }
    expect(world.quotaUsage().newContentBytes).toBe(WORKSPACE_QUOTA.maxNewContentBytes);

    const rejected = await callTool(world, WRITE_FILE_TOOL_NAME, { path: "a.txt", content: "d" });
    expect(rejected.error).toContain("quota_exceeded");
    // 旧映射与配额计数都不变
    expect(world.quotaUsage().newContentBytes).toBe(WORKSPACE_QUOTA.maxNewContentBytes);
  });

  it("配额失败不影响已有检查点：先冻结快照，再撞配额，旧快照 id 不变", async () => {
    const empty = createWorkspaceWorld({
      dataDir: join(makeTempDir("ft-quota-"), "data"),
      allowFileWrites: true,
    });
    if (!empty.ok) throw new Error(empty.failure.reason);
    const world = empty.value;

    const chunk = "e".repeat(WORKSPACE_QUOTA.maxFileBytes);
    for (let i = 0; i < 8; i++) {
      expect(
        (await callTool(world, WRITE_FILE_TOOL_NAME, { path: `chunk-${i}.bin`, content: chunk }))
          .error,
      ).toBeNull();
    }
    const frozen = world.snapshot();

    const rejected = await callTool(world, WRITE_FILE_TOOL_NAME, {
      path: "extra.bin",
      content: "x",
    });
    expect(rejected.error).toContain("quota_exceeded");
    // 检查点（冻结快照）与当前清单都不受影响
    expect(world.snapshot().id).toBe(frozen.id);
    expect(world.listFiles().map((file) => file.path)).toEqual(frozen.files.map((f) => f.path));
  });
});
