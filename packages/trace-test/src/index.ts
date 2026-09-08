export { TraceTestConfigError } from "./errors.js";
export { CassetteLlmClient, extractCassette } from "./cassette-llm-client.js";
export type { RequestDrift } from "./cassette-llm-client.js";
export { StubToolTable, sameShape } from "./stub-tools.js";
export type { ArgsDrift } from "./stub-tools.js";
export { alignShape } from "./shape-align.js";
export type { ShapeAlignment, ShapeMismatch } from "./shape-align.js";
export { rerunWithCassette } from "./rerun.js";
export type { RerunOptions, RerunResult, ConfigDrift } from "./rerun.js";
