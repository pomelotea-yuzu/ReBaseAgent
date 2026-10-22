// 文件检查点只读包装已迁至 @rebaseagent/run-query；保留旧路径供 desktop IPC/测试消费。
export {
  inspectWorkspace,
  readWorkspaceFileForView,
  type RunRecordLoader,
  type WorkspaceInspectOutcome,
  type WorkspaceViewDeps,
} from "@rebaseagent/run-query";
