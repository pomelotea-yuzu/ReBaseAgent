export { TraceTestConfigError } from "./errors.js";
export { CassetteLlmClient, extractCassette } from "./cassette-llm-client.js";
export type { RequestDrift } from "./cassette-llm-client.js";
export { StubToolTable, sameShape } from "./stub-tools.js";
export type { ArgsDrift } from "./stub-tools.js";
export { alignShape } from "./shape-align.js";
export type { ShapeAlignment, ShapeMismatch } from "./shape-align.js";
export { rerunWithCassette } from "./rerun.js";
export type { RerunOptions, RerunResult, ConfigDrift } from "./rerun.js";
export {
  DEFINITION_FORMAT_VERSION,
  TraceTestDefinitionSchema,
  SelectorSchema,
  AssertionSchema,
} from "./definition.js";
export type { TraceTestDefinition, Assertion, Selector } from "./definition.js";
export { loadDefinition, resolveTracePath, discoverDefinitions, loadTrace } from "./loader.js";
export { evaluateAssertions, matchSpans } from "./assertions.js";
export type { AssertionResult } from "./assertions.js";
export { deepEqual, formatValue, redactValue, truncate } from "./format.js";
export {
  runTraceTest,
  runTraceTests,
  exitCodeFor,
  writeTraceBaseline,
} from "./run-test.js";
export type { TestResult, TestMode, RunTraceTestOptions } from "./run-test.js";
