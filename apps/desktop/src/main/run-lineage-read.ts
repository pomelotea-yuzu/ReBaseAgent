// 读取诊断已迁至 @rebaseagent/run-query；保留旧路径供 main/测试消费。
export {
  findIllegalRunIdViolation,
  readRunLineage,
  type RunLineageDiagnostic,
  type RunLineageFailure,
  type RunLineageOutcome,
} from "@rebaseagent/run-query";
