// 自有输出/错误/消耗事实已迁至 @rebaseagent/run-query/facts；保留旧路径供 renderer/测试消费。
export {
  deriveCacheCoverage,
  deriveErrorTarget,
  deriveOwnConsumption,
  deriveOwnOutput,
  deriveOwnToolErrors,
} from "@rebaseagent/run-query/facts";
export type {
  CacheCoverage,
  ErrorTarget,
  OwnConsumption,
  OwnOutput,
  OutputBlock,
  ToolErrorTarget,
} from "@rebaseagent/run-query/facts";
