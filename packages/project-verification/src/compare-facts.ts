/**
 * 共享比较纯事实（MCP2 design D7，tasks 2.5/2.6）——桌面与 MCP 复用同一判据。
 *
 * 本模块**零导入**（连 Node 内置都不碰）：renderer bundle 可以直接吃；MCP 从
 * `/facts` 子入口取同一实现。显示文案/格式化留在各自展示层（V02「交互不变」），
 * 条件状态与结论只出自这里。
 *
 * 判据纪律（M15）：
 * - argv **按数组**逐元素比较——`["npx","tsc --noEmit"]` 与 `["npx","tsc","--noEmit"]`
 *   join 后同串但边界不同，必须判 different；
 * - 对象（toolchain/limits/security）按**规范值**比较（键序无关的深相等）；
 * - 历史缺项 ⇒ unknown，**不拿当前 manifest 或另一侧补齐**；
 * - preparationId/verificationId/runId/snapshotId/耗时是身份或结果，不进条件。
 *
 * 结论顺序（D7）：非封存/不可读 → outcome-unknown；任侧证据不完整 →
 * evidence-incomplete（**双来源**：封存时 evidenceComplete 缺项，或查询时当前必需
 * 资产缺失）；条件不同 → conditions-differ；条件缺项 → conditions-unknown；
 * 全 same 且左 check_failed/右 passed → failed-to-passed；其余 →
 * same-conditions-other-outcome。快照漂移/来源缺失**不改结论**，只降低可声明
 * （sourceVerified=false ⇒ 不能称"已核验修复分支"，见 sourceVerified）。
 */

export type FactConditionState = "same" | "different" | "unknown";

export type FactConditionKey =
  | "profileId"
  | "manifestVersion"
  | "planBindingDigest"
  | "commandId"
  | "command"
  | "cwd"
  | "platform"
  | "imageDigest"
  | "toolchain"
  | "limits"
  | "security";

export interface FactConditionResult {
  readonly key: FactConditionKey;
  readonly state: FactConditionState;
}

export type FactVerdictKind =
  | "failed-to-passed"
  | "same-conditions-other-outcome"
  | "conditions-differ"
  | "conditions-unknown"
  | "evidence-incomplete"
  | "outcome-unknown";

export interface VerificationFactsSide {
  /** 侧身份 */
  readonly verificationId: string;
  readonly status: "sealed" | "unterminated" | "corrupt" | "unsupported_version";
  /** 记录头条件（meta 缺失 ⇒ null） */
  readonly profileId: string | null;
  readonly manifestVersion: number | null;
  readonly planBindingDigest: string | null;
  readonly commandId: string | null;
  /** 实际命令（start/end 配对结果；缺 start ⇒ null，不猜） */
  readonly executable: string | null;
  readonly argv: readonly string[] | null;
  readonly cwd: string | null;
  /** 历史环境（记录内事实；缺 ⇒ null） */
  readonly environment: {
    readonly platform: string | null;
    readonly imageDigest: string | null;
    readonly toolchain: unknown;
    readonly limits: unknown;
    readonly security: unknown;
  } | null;
  /** 封存门后的可信结局（非 sealed ⇒ null） */
  readonly outcome: string | null;
  readonly evidenceComplete: boolean | null;
  /** recordedTarget：记录头固定快照（回查引用用它，永不切最近步骤） */
  readonly recordedSnapshotId: string | null;
  /** 来源状态（trace 在场性） */
  readonly sourceStatus: "unknown" | "present" | "missing";
  /** 来源核对实际定位到的快照（未核对 ⇒ null）；与 recordedSnapshotId 不同 = 漂移 */
  readonly locatedSnapshotId: string | null;
  /** 查询时当前必需资产（日志/已发布产物）可用性；未核验 ⇒ null */
  readonly currentAssetsAvailable: boolean | null;
}

export interface VerificationFactsComparison {
  readonly conditions: readonly FactConditionResult[];
  readonly verdict: { readonly kind: FactVerdictKind };
  /** 代码快照一致性（两侧 recordedSnapshotId 可得才可判，否则 null） */
  readonly codeSame: boolean | null;
  /**
   * 来源可核验性：true = 两侧来源在场且定位快照与 recordedTarget 一致；
   * false = 缺失或漂移（不能称"已核验修复分支/代码因果"）；null = 未核对。
   */
  readonly sourceVerified: boolean | null;
  /** evidence-incomplete 的两个触发来源是否命中（诊断用，不改写历史 outcome） */
  readonly evidenceIncompleteFromRecord: boolean;
  readonly evidenceIncompleteFromCurrentAssets: boolean;
  /** 回查引用：固定 recordedTarget（expectedSnapshotId），调用方按此核对 */
  readonly expectedSnapshotIds: { readonly left: string | null; readonly right: string | null };
}

/** argv 数组逐元素比较（长度与内容都必须一致；null = 缺项 unknown） */
function compareArgv(
  left: readonly string[] | null,
  right: readonly string[] | null,
): FactConditionState {
  if (left === null || right === null) return "unknown";
  if (left.length !== right.length) return "different";
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return "different";
  }
  return "same";
}

/** 规范值深相等：对象键序无关、数组保序；null = 缺项 unknown */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((key, index) => key !== kb[index])) return false;
    return ka.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function compareScalar<T>(
  left: T | null,
  right: T | null,
  equal: (a: T, b: T) => boolean,
): FactConditionState {
  if (left === null || right === null) return "unknown";
  return equal(left, right) ? "same" : "different";
}

export function compareVerificationFacts(
  left: VerificationFactsSide,
  right: VerificationFactsSide,
): VerificationFactsComparison {
  const leftEnv = left.environment;
  const rightEnv = right.environment;
  const conditions: FactConditionResult[] = [
    {
      key: "profileId",
      state: compareScalar(left.profileId, right.profileId, (a, b) => a === b),
    },
    {
      key: "manifestVersion",
      state: compareScalar(left.manifestVersion, right.manifestVersion, (a, b) => a === b),
    },
    {
      key: "planBindingDigest",
      state: compareScalar(left.planBindingDigest, right.planBindingDigest, (a, b) => a === b),
    },
    {
      key: "commandId",
      state: compareScalar(left.commandId, right.commandId, (a, b) => a === b),
    },
    {
      // command 行：executable 与 argv **分开比**，argv 按数组（M15）
      key: "command",
      state:
        compareScalar(left.executable, right.executable, (a, b) => a === b) === "unknown"
          ? "unknown"
          : compareArgv(left.argv, right.argv),
    },
    { key: "cwd", state: compareScalar(left.cwd, right.cwd, (a, b) => a === b) },
    {
      key: "platform",
      state: compareScalar(
        leftEnv?.platform ?? null,
        rightEnv?.platform ?? null,
        (a, b) => a === b,
      ),
    },
    {
      key: "imageDigest",
      state: compareScalar(
        leftEnv?.imageDigest ?? null,
        rightEnv?.imageDigest ?? null,
        (a, b) => a === b,
      ),
    },
    {
      key: "toolchain",
      state: compareScalar(leftEnv?.toolchain ?? null, rightEnv?.toolchain ?? null, deepEqual),
    },
    {
      key: "limits",
      state: compareScalar(leftEnv?.limits ?? null, rightEnv?.limits ?? null, deepEqual),
    },
    {
      key: "security",
      state: compareScalar(leftEnv?.security ?? null, rightEnv?.security ?? null, deepEqual),
    },
  ];

  const differences = conditions.filter((condition) => condition.state === "different");
  const unknowns = conditions.filter((condition) => condition.state === "unknown");

  const evidenceIncompleteFromRecord =
    left.evidenceComplete !== true || right.evidenceComplete !== true;
  const evidenceIncompleteFromCurrentAssets =
    left.currentAssetsAvailable === false || right.currentAssetsAvailable === false;

  let verdict: FactVerdictKind;
  if (left.outcome === null || right.outcome === null) {
    verdict = "outcome-unknown";
  } else if (evidenceIncompleteFromRecord || evidenceIncompleteFromCurrentAssets) {
    verdict = "evidence-incomplete";
  } else if (differences.length > 0) {
    verdict = "conditions-differ";
  } else if (unknowns.length > 0) {
    verdict = "conditions-unknown";
  } else if (left.outcome === "check_failed" && right.outcome === "passed") {
    verdict = "failed-to-passed";
  } else {
    verdict = "same-conditions-other-outcome";
  }

  const codeSame =
    left.recordedSnapshotId === null || right.recordedSnapshotId === null
      ? null
      : left.recordedSnapshotId === right.recordedSnapshotId;

  let sourceVerified: boolean | null = null;
  if (left.sourceStatus !== "unknown" || right.sourceStatus !== "unknown") {
    // design D7：present 仅证明 trace 在场——快照定位核对（located）未给出时
    // **不得**宣称已核验（保守侧）；漂移（located ≠ recorded）同样为 false
    const sideVerified = (side: VerificationFactsSide): boolean =>
      side.sourceStatus === "present" &&
      side.locatedSnapshotId !== null &&
      side.locatedSnapshotId === side.recordedSnapshotId;
    sourceVerified = sideVerified(left) && sideVerified(right);
  }

  return {
    conditions,
    verdict: { kind: verdict },
    codeSame,
    sourceVerified,
    evidenceIncompleteFromRecord,
    evidenceIncompleteFromCurrentAssets,
    expectedSnapshotIds: {
      left: left.recordedSnapshotId,
      right: right.recordedSnapshotId,
    },
  };
}
