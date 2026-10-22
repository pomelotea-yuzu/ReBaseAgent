// 自有终止事实与结果身份判据已迁至 @rebaseagent/run-query/facts；保留旧路径供消费。
export { deriveOwnTerminalFacts, findResultIdentityViolation } from "@rebaseagent/run-query/facts";
export type {
  OwnTerminalFacts,
  OwnTerminalInput,
  ResultIdentityInput,
  TerminalEventLine,
} from "@rebaseagent/run-query/facts";
