// 编辑证据投影已迁至 @rebaseagent/run-query/facts；保留旧路径供 renderer/测试消费。
export {
  deriveDifferentRootFacts,
  deriveDirectEditEvidence,
  deriveHopChains,
} from "@rebaseagent/run-query/facts";
export type {
  DifferentRootComparison,
  DirectEditEvidence,
  EditEvidenceIdentity,
  EditEvidenceVariant,
  EditSemantics,
  EditUnavailableCode,
  EditValuePresence,
  SideHopChain,
  SideInputFacts,
  SourceDetailProvider,
} from "@rebaseagent/run-query/facts";
