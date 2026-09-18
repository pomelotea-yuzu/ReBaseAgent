/**
 * 逻辑路径的完整契约：规范化、合法性与碰撞判定。
 *
 * **无 Node 依赖、无内部 import**——renderer、包 API、隔离工具链用的是同一份规则。
 *
 * 隔离文件世界里的"逻辑路径"始终是**根内相对路径**，`/` 是唯一分隔符；它与宿主物理路径
 * 无关：世界实例按路径查自己的映射表，永不把逻辑路径拼到磁盘上（见 A design §4）。所以这里的
 * 规则不是"某个平台上能不能创建这个文件"，而是**Windows 可移植子集**——被判非法的形式，
 * 在 Windows 上要么本就不存在，要么会被系统静默改写（尾随点/空格、大小写），要么根本不被
 * 当作路径（ADS、保留设备名、UNC/设备前缀）。
 *
 * ## 分工（2026-09-17 随任务 2.1 收口）
 *
 * - 本模块：**路径本身**的规则——整串形状、段结构、长度/深度上限、逐段平台命名、NFC+小写碰撞；
 * - `workspace-snapshot.ts`：**清单层面**的规则——规范排序、重复、文件/目录冲突；它对每条路径
 *   调用本模块（世界状态里存的路径必须满足同一份契约，否则导入放的与写工具放的是两套标准）；
 * - `packages/replay/src/workspace/quota.ts`：文件数与字节配额。那是隔离编排的容量约束，
 *   不是路径契约的一部分，故不在本模块。
 *
 * 1.2 落地时这里只有"跨平台通用结构"判定，并**刻意放行** `CON` / `a.txt:ads`（当时避免与 2.1
 * 各写一半）；2.1 起完整规则生效，那两条用例已随之改为"应拒绝"。
 *
 * ## 已知边界（刻意不做的，别当成漏判）
 *
 * - **不限制** `<` `>` `"` `|` `?` `*` 与控制字符：A design §3 只列举了本模块实现的那几类形式，
 *   收紧需要先改 spec。它们在 Windows 上非法 ⇒ 从 Windows 源目录导入时不会出现，
 *   从 Linux 源导入则可能带进来（届时仍只作为逻辑路径存 blob，不会被当真文件打开）。
 * - **保留设备名只覆盖经典集合**（CON/PRN/AUX/NUL/COM1-9/LPT1-9 与 CONIN$/CONOUT$）：
 *   `COM0` 在 Windows 上并不保留，故放行；上标变体（`COM¹`）按"未列举"放行。
 * - **大小写折叠用 `toLowerCase()`**：它与 locale 无关；`toLocaleLowerCase()` 会跟着 locale 走，
 *   同一条路径在不同机器上折成不同键，碰撞判定随之不一致（同一类静默不等的坑，
 *   与快照 id 禁用 `localeCompare` 同源）。
 */

/** 逻辑路径的长度上限：512 个 UTF-16 代码单元（含 `/` 分隔符）；**等于上限合法** */
export const MAX_LOGICAL_PATH_LENGTH = 512;

/** 逻辑路径的深度上限：32 段（含文件名段，`a/b.txt` 记 2 段）；**等于上限合法** */
export const MAX_LOGICAL_PATH_DEPTH = 32;

/**
 * Windows 保留设备名（大小写不敏感地命中段名主体即拒绝）。
 *
 * "段名主体" = 段里第一个 `.` 之前的部分：Windows 对 `CON.txt` 与 `CON` 一视同仁。
 * 这些名字在任意目录层级都被保留（`dir/CON.log` 同样命中）。
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "CONIN$",
  "CONOUT$",
]);

/**
 * 工具输入路径的规范化：把 `\` 一律换成 `/`（A design §3：工具输入的 `\` 规范化为 `/`）。
 *
 * 只做这一件事——**不**折叠 `.`/`..`、**不**去尾随空格、**不**折叠大小写。那三件要么是必须
 * 原样拒绝的形式（穿越、尾随点空格会掩盖等价名），要么会让两条不同的路径悄悄变成同一条。
 *
 * ⚠️ 规范化**不等于**放行：之后仍须过 `findLogicalPathViolation`。例如 `\\server\share\a`
 * 规范化成 `//server/share/a`，照样要按 UNC 拒绝；`C:\a.txt` 规范化后仍是盘符路径。
 */
export function normalizeLogicalPath(input: string): string {
  return input.replace(/\\/g, "/");
}

/**
 * 单条逻辑路径的合法性；违规返回中文原因，合法返回 `null`。
 *
 * 判定顺序是**固定**的——整串形状 → 段结构 → 长度/深度上限 → 逐段的平台命名规则。
 * 一份坏路径在任何机器上只会报出同一条原因（用户反馈与用例都依赖这一点）。
 *
 * 上限的边界语义：`≤` 合法。512 个单元的路径、32 段的路径都是**合法**的，513 与 33 才拒绝。
 */
export function findLogicalPathViolation(path: string): string | null {
  if (path.length === 0) {
    return "路径不得为空";
  }
  if (path.includes("\0")) {
    return `路径不得包含 NUL 字符：${JSON.stringify(path)}`;
  }

  // ① 整串形状：UNC/设备前缀、绝对路径、未规范化的分隔符、尾随空段。
  //    `//` 先于 `/` 判，才能把 `//server/share`、`//?/C:/x`、`//./PhysicalDrive0`
  //    与普通绝对路径区分开，给出可诊断的原因（两者都拒绝，但原因不同）。
  if (path.startsWith("//")) {
    return `路径不得是 UNC 或设备路径（以 "//" 开头）：${path}`;
  }
  if (path.startsWith("/")) {
    return `路径必须是相对路径，不得以 "/" 开头：${path}`;
  }
  if (path.includes("\\")) {
    return `路径分隔符必须规范化为 "/"（工具输入请先经 normalizeLogicalPath）：${path}`;
  }
  if (path.endsWith("/")) {
    return `路径不得以 "/" 结尾（尾随空段）：${path}`;
  }

  // ② 段结构：空段与点段（穿越）。
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return `路径不得包含空段（连续的 "/"）：${path}`;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `路径不得包含 "." 或 ".." 段：${path}`;
  }

  // ③ 上限（两侧都含边界）。
  if (segments.length > MAX_LOGICAL_PATH_DEPTH) {
    return `路径段数超过上限 ${MAX_LOGICAL_PATH_DEPTH}（当前 ${segments.length} 段）：${path}`;
  }
  if (path.length > MAX_LOGICAL_PATH_LENGTH) {
    return `路径长度超过上限 ${MAX_LOGICAL_PATH_LENGTH} 个 UTF-16 单元（当前 ${path.length}）：${path}`;
  }

  // ④ 逐段的平台命名规则。
  for (const segment of segments) {
    if (segment.includes(":")) {
      return `路径段不得包含冒号（Windows ADS 或盘符前缀）：${JSON.stringify(segment)}`;
    }
    const dot = segment.indexOf(".");
    const baseName = (dot === -1 ? segment : segment.slice(0, dot)).toUpperCase();
    if (RESERVED_DEVICE_NAMES.has(baseName)) {
      return `路径段使用了 Windows 保留设备名：${JSON.stringify(segment)}`;
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return `路径段不得以点或空格结尾（Windows 会静默改写）：${JSON.stringify(segment)}`;
    }
  }

  return null;
}

/**
 * 碰撞键：`NFC` 规范化 + 小写折叠。
 *
 * 键只用于判定"同一世界内是否已存在等价路径"，**显示路径不被改写**——快照里存的、
 * 消息里展示的始终是调用方给的原字符串。
 */
export function logicalPathCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * 一组逻辑路径之间是否存在碰撞（NFC 或大小写等价的两条路径）；无碰撞返回 `null`。
 *
 * 为什么整条路径做键而不是逐段：`/` 在两边都出现，等价关系在整串上同样成立，代码更短也
 * 更容易解释。真重复（完全相同的字符串）也会命中，此时给更直接的"重复路径"文案。
 *
 * 报"先出现的那条"，故对同一份输入结果稳定（要求调用方按确定的顺序传入：清单走规范序，
 * 导入走枚举序）。
 */
export function findLogicalPathCollisionViolation(paths: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = logicalPathCollisionKey(path);
    const first = seen.get(key);
    if (first !== undefined) {
      return first === path
        ? `重复路径：${path}`
        : `路径碰撞：${first} 与 ${path} 在 NFC + 小写意义下等价，同一世界内不能同时存在`;
    }
    seen.set(key, path);
  }
  return null;
}
