/**
 * 跨运行检查点比较的共享访问面。
 *
 * 事实与字节核验仍由 replay `compare-api` 承担；本模块只做依赖方向收口，
 * 让 desktop/MCP 通过同一入口接入，**不复制清单解析、哈希或附件读取**。
 * 清单 same 只表示引用相同；字节结论必须由 readComparedWorkspaceFile 的核验结果给出。
 */
export { compareWorkspaceSnapshots, readComparedWorkspaceFile } from "@rebaseagent/replay";
export type {
  ComparedFileSide,
  ComparedWorkspaceFileResult,
  CompareFileReference,
  ComparePathEntry,
  /** 比较侧失败码（= 定位码 + `identity_mismatch`）；外部投影按它做穷尽映射，不手抄清单 */
  CompareSideFailureCode,
  CompareSideFailure,
  CompareSideIdentity,
  CompareSideResult,
  CompareSideSelector,
  CompareWorkspaceSnapshotsOptions,
  CompareWorkspaceSnapshotsResult,
  ExpectedSnapshotIds,
  ReadComparedWorkspaceFileRequest,
} from "@rebaseagent/replay";
