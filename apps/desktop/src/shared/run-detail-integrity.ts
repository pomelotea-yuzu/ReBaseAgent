// 完整性校验判据已迁至 @rebaseagent/run-query/schema；保留旧路径供 main/renderer/测试消费。
export {
  findRunDetailIntegrityViolation,
  type RunDetailIntegrityInput,
} from "@rebaseagent/run-query/schema";
