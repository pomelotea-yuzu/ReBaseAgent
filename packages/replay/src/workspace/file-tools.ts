import type { Tool, ToolContext } from "@rebaseagent/agent-loop";
import { findLogicalPathViolation, normalizeLogicalPath } from "@rebaseagent/trace-sdk";
import { tryDecodeUtf8 } from "./utf8.js";
import type { WorkspaceWorld } from "./world.js";

/**
 * 固定 `file-tools-v1` 工具集（A design §4）：隔离运行**唯一**可用的一对文件工具。
 *
 * ## 与桌面内置 `read_file` / `write_file` 的关系：同名，但不可互换
 *
 * 桌面那对工具把路径 `resolve(ctx.cwd, path)` 到宿主磁盘上真读写——它们是"在某个目录里干活"。
 * 这里的工具**不认识物理路径**：路径只用来查世界实例的内存映射表，取到的字节来自不可变的
 * 内容附件。因此：
 *
 * - **`exec.cwd` 不参与文件定位**。它作为受控运行上下文照常传进 handler，但根本不参与路径解析；
 *   传什么都定位不到宿主文件（对应用例「不使用宿主 cwd 查找文件」）。
 * - **世界实例绑在闭包里**。handler 拿不到源目录，也拿不到附件物理根；调用方无法通过传参越权。
 * - **不接受 `Tool[]`**。编排层只调 `createFileToolsV1`，定义由本模块写死，不能从外部塞进来。
 *
 * ## 交付切分
 *
 * 本模块在 3.1 只交付**定义**与 `read_file`；`write_file` 的 handler 由 3.2 补齐（现在写入即
 * 报"尚未实现"的工具错误——这是诚实失败，不是静默成功）。`read_file` 已经能完整工作，因为
 * 世界实例（2.5）与附件存储（2.2）都已就绪。3.3 的 profile 一致性校验会逐字段比对本模块
 * 导出的 `FILE_TOOLS_V1_DEFINITIONS`。
 */

/** 固定 profile 名（写进 `run.meta.workspace.profile`） */
export const FILE_TOOLS_V1_PROFILE = "file-tools-v1";

/** 固定工具定义的形状（不带 handler；`ToolDef` 的本地窄化，供指纹逐字段比对用） */
export interface FileToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly sideEffect: boolean;
}

/** 两个工具的固定名字（编排与预检都引用这里，避免字面量散落） */
export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";

/**
 * 固定工具定义：顺序、名字、schema 与 `sideEffect` 都是契约的一部分（A design §4：指纹包含原定义）。
 *
 * `sideEffect` 的取值是**语义**而非装饰：`read_file=false` 表示可零成本重放，`write_file=true`
 * 表示需真实重执行。给写工具改标记来放行是明确禁止的——定义在这里写死，3.3 会逐字段核对，
 * 定义被改成 `false` 的 write_file 会在启动前被拒。
 *
 * `parameters` 是 JSON Schema：`additionalProperties:false` 与 `required` 一起构成"拒绝额外键、
 * 拒绝缺参"的**声明**；真正的运行期把关在 `parseReadFileArgs`（声明只是给模型看的，模型可以不遵守）。
 */
export const FILE_TOOLS_V1_DEFINITIONS: readonly [FileToolDefinition, FileToolDefinition] = [
  {
    name: READ_FILE_TOOL_NAME,
    description: "读取隔离工作区内某个文件的 UTF-8 文本内容。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "工作区内的相对路径（使用 / 分隔符）",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    sideEffect: false,
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    description: "把完整 UTF-8 文本写入隔离工作区内的某个文件（必要时创建父目录）。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "工作区内的相对路径（使用 / 分隔符）",
        },
        content: {
          type: "string",
          description: "要写入的完整文本内容",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    sideEffect: true,
  },
];

/**
 * 参数校验失败：**错误是数据**。ToolRegistry 会把抛出的异常捕获成 `tool.invoke.error` 文本
 * （既有 loop 语义），所以这里 throw 就是"记录可诊断的工具错误，不执行动作"。
 */
export class FileToolArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileToolArgsError";
  }
}

/** 读取参数的解析结果：已规范化的逻辑路径 */
export interface ParsedReadFileArgs {
  readonly path: string;
}

/**
 * 严格解析 `read_file` 参数。
 *
 * 四条规则，缺一不可：
 * 1. **必须是普通对象**：`null`、数组、字符串、数字都不接受（`typeof null === "object"` 是经典坑）。
 * 2. **只允许已知键**：多余键直接拒绝——静默丢弃会让模型以为参数被采纳了（例如它传
 *    `{"path":"a","encoding":"base64"}`，我们按 UTF-8 读出来，双方理解不一致）。
 * 3. **`path` 必须是非空字符串**：不用 `String()` 强制转换（`123` 不该变成 `"123"` 去找文件）。
 * 4. **路径必须先规范化再校验契约**：工具输入的 `\` 规范化为 `/`（`normalizeLogicalPath`），
 *    之后仍须过 `findLogicalPathViolation`——规范化 **≠** 放行，`..\a` 变成 `../a` 照样拒绝，
 *    `\\server\share` 变成 `//server/share` 照样按 UNC 拒绝。
 */
export function parseReadFileArgs(args: unknown): ParsedReadFileArgs {
  const record = requirePlainObject(args);

  for (const key of Object.keys(record)) {
    if (key !== "path") {
      throw new FileToolArgsError(`read_file 不接受参数 ${JSON.stringify(key)}（只接受 path）`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(record, "path")) {
    throw new FileToolArgsError("read_file 缺少必填参数 path");
  }

  const raw = record.path;
  if (typeof raw !== "string") {
    throw new FileToolArgsError(
      `read_file 的 path 必须是字符串（收到 ${describeType(raw)}，不做隐式转换）`,
    );
  }
  if (raw.length === 0) {
    throw new FileToolArgsError("read_file 的 path 不得为空");
  }

  const path = normalizeLogicalPath(raw);
  const violation = findLogicalPathViolation(path);
  if (violation !== null) {
    throw new FileToolArgsError(`read_file 路径不合法：${violation}`);
  }
  return { path };
}

/**
 * 造出固定 `file-tools-v1` 的工具表，读工具绑定给定世界。
 *
 * 世界实例进闭包，**不出现在任何参数里**：模型无法通过 tool args 换一个世界或换一条路径基准。
 * 返回的 `Tool[]` 顺序与 `FILE_TOOLS_V1_DEFINITIONS` 一致（顺序也是 profile 指纹的一部分）。
 */
export function createFileToolsV1(world: WorkspaceWorld): Tool[] {
  return [
    {
      ...FILE_TOOLS_V1_DEFINITIONS[0],
      handler: makeReadFileHandler(world),
    },
    {
      ...FILE_TOOLS_V1_DEFINITIONS[1],
      handler: makeWriteFileHandler(world),
    },
  ];
}

/**
 * 受控读：解析参数 → 按世界的**当前映射**读内容 → 严格 UTF-8 解码。
 *
 * `ctx` 刻意**不被使用**——`exec.cwd` 不是路径能力（A design §4）。参数留着是因为 ToolHandler
 * 签名如此，且将来若需中止信号可以从这里拿。
 *
 * 三态映射（世界读结果 → 工具返回值 / 工具错误）：
 * - `ok` + 合法 UTF-8 → 返回文本；
 * - `ok` + 非法 UTF-8 → **抛错**。文件字节被完整保存，但"以文本读取"不成立；用 U+FFFD 替换字符
 *   冒充原文就是静默损坏（对应用例「二进制字节保持」）。要看原字节请走包只读附件接口。
 * - `not_found` / `missing` / `corrupt` → 抛错，原因带上世界给的中文说明（可诊断）。
 *
 * 不读源目录、不写任何文件。
 */
export function makeReadFileHandler(world: WorkspaceWorld): Tool["handler"] {
  return async (args: unknown, _ctx: ToolContext): Promise<string> => {
    const { path } = parseReadFileArgs(args);
    const result = await world.readFile(path);
    if (!result.ok) {
      throw new FileToolArgsError(`read_file 失败（${result.state}）：${result.reason}`);
    }
    const text = tryDecodeUtf8(result.data);
    if (text === null) {
      const { bytes, sha256 } = result.file;
      const suffix = "——原始字节已保留在附件存储中，不做有损转码";
      throw new FileToolArgsError(
        `read_file 失败：${path} 不是合法 UTF-8 文本（${bytes} 字节，sha256=${sha256}）${suffix}`,
      );
    }
    return text;
  };
}

/**
 * 受控写的占位：3.2 才实现（先持久发布内容、再更新映射）。
 *
 * 现在写入一律报工具错误——**不能**让它落到桌面那套 `writeFileSync`，也**不能**静默返回成功。
 * 授权门禁（`allowFileWrites`）由世界实例承担，所以即便 3.2 落地后，未授权的运行也写不进去。
 */
export function makeWriteFileHandler(_world: WorkspaceWorld): Tool["handler"] {
  return (): never => {
    throw new FileToolArgsError("write_file 尚未实现（受控写入在第 3.2 步交付）");
  };
}

/** 参数必须是普通对象：数组、null、原始值都不算 */
function requirePlainObject(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new FileToolArgsError(
      `工具参数必须是对象（收到 ${describeType(args)}）——JSON 解析失败或模型给出了非对象参数`,
    );
  }
  return args as Record<string, unknown>;
}

/** 给错误消息用的类型描述（比 `typeof` 更能区分 null / 数组） */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}
