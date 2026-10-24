import type { ProfileManifest } from "../schema.js";

/**
 * 准备后端**端口**（R3 tasks 3.1；design D3「mock 后端仅覆盖编排，不能代替真实门槛」）。
 *
 * 包层只依赖本端口；真实实现（Docker adapter，tasks 3.2）在本后端内构建受信环境镜像。
 * 实现契约（每一款都是验收面，mock 不销账）：
 * - **不在宿主跑 npm**：依赖构建发生在后端内（design D2），本包对宿主零 npm 调用；
 * - **仅准备阶段联网**：构建可按计划声明的来源下载；实现不得把网络范围扩大到
 *   计划之外，也不得携带用户凭据（代理/镜像源凭据等一律不透传，3.2 落牙）；
 * - **构建输入只用请求给出的字节**：`assets` 已过完整性门（P08），实现不得从
 *   项目目录/网络取补任何文件；
 * - 返回的 `imageDigest` 为构建产物的内容寻址摘要（`sha256:…`）；`toolchain` 为
 *   镜像内**实测**版本（不是抄 manifest 声明值——实测与声明不符时如实返回实测，
 *   由调用方/记录承载差异）。
 */
export interface TrustedEnvironmentBuildRequest {
  readonly profile: ProfileManifest;
  /** 构建上下文（相对路径 → UTF-8 字节）；由 3.2 适配器转交后端（如 tar 流）。 */
  readonly assets: Readonly<Record<string, string>>;
}

export interface TrustedEnvironmentBuildOutcome {
  readonly imageDigest: string;
  readonly toolchain: { readonly node: string; readonly typescript: string };
  readonly networkUsed: boolean;
  /** 本准备可测得的下载字节数；后端测不出时为 `null`（如实未知，禁止伪造 0）。 */
  readonly downloadedBytes: number | null;
}

export interface PreparationBackend {
  buildTrustedEnvironment(
    request: TrustedEnvironmentBuildRequest,
  ): Promise<TrustedEnvironmentBuildOutcome>;
}
