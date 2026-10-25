import { z } from "zod";
import { compareVerificationFacts, type VerificationFactsSide } from "@rebaseagent/project-verification/facts";
import {
  getVerification,
  projectVerification,
  resolveLogAsset,
  verifyAsset,
  type VerificationRecordRead,
} from "@rebaseagent/project-verification/read";
import type { LimitationInput, ProvenanceVerificationInput } from "../envelope.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import {
  type CompareVerificationsArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { computeVerificationReadVersion } from "./verification-support.js";

/**
 * `compare_verifications`（MCP2 design D2/D7，tasks 3.6）。
 *
 * - 固定用户选定的两个**不同**验证（同 ID = INVALID_ARGUMENT），固定左右同序；
 *   一侧不可读/不存在 ⇒ 该侧 unavailable（M16：另一侧仍可查，不自动换验证）；
 * - 判据与结论出自共享 `compareVerificationFacts`（V02）：argv 数组、对象规范值、
 *   缺项 unknown；evidence-incomplete 双来源；历史 outcome 不改写；
 * - 当前必需资产（meta.commandId 的 stdout/stderr 日志 + 已发布产物）逐项核验，
 *   缺失 ⇒ currentAssetsAvailable=false，阻止可核查结论但不重写历史（D7）；
 * - 不默认读正文（无 content body）；expectedSnapshotId 固定 recordedTarget。
 */

const SideSchema = z
  .object({
    verificationId: z.string().max(64),
    /** ready = 记录可读；unavailable = 不存在/不可读（不换验证） */
    availability: z.enum(["ready", "unavailable"]),
    status: z
      .enum(["sealed", "unterminated", "corrupt", "unsupported_version"])
      .nullable(),
    outcome: z.string().min(1).nullable(),
    evidenceComplete: z.boolean().nullable(),
    exitCode: z.number().int().nullable(),
    currentAssetsAvailable: z.boolean().nullable(),
    recordedSnapshotId: z.string().min(1).nullable(),
    sourceStatus: z.enum(["unknown", "present", "missing"]).nullable(),
  })
  .strict();

const CompareVerificationDataSchema = z
  .object({
    left: SideSchema,
    right: SideSchema,
    conditions: z.array(
      z
        .object({
          key: z.string().min(1),
          state: z.enum(["same", "different", "unknown"]),
        })
        .strict(),
    ),
    verdict: z.object({ kind: z.string().min(1) }).strict(),
    codeSame: z.boolean().nullable(),
    sourceVerified: z.boolean().nullable(),
    evidenceIncomplete: z
      .object({
        fromRecord: z.boolean(),
        fromCurrentAssets: z.boolean(),
      })
      .strict(),
    expectedSnapshotIds: z
      .object({ left: z.string().min(1).nullable(), right: z.string().min(1).nullable() })
      .strict(),
  })
  .strict();

export const compareVerificationsTool: ToolDefinition = defineTool(
  requireVerificationContract("compare_verifications"),
  async (args: CompareVerificationsArgs, root: DataRoot): Promise<ToolPayload> => {
    if (args.left.verificationId === args.right.verificationId) {
      // 必须是两个不同验证（语义约束在任何读取之前拒，与 compare_runs 同注释）
      throw new ToolFailure("INVALID_ARGUMENT", "left/right");
    }

    const leftRead = readSide(root, args.left.verificationId);
    const rightRead = readSide(root, args.right.verificationId);
    const leftSide = sideFactsOf(root, args.left.verificationId, leftRead);
    const rightSide = sideFactsOf(root, args.right.verificationId, rightRead);

    const facts = compareVerificationFacts(leftSide.facts, rightSide.facts);

    const limitations: LimitationInput[] = [];
    for (const [label, side] of [
      ["left", leftRead],
      ["right", rightRead],
    ] as const) {
      if (side?.status === "unterminated") {
        limitations.push({
          code: "VERIFICATION_UNTERMINATED",
          ref: `verification:${label === "left" ? args.left.verificationId : args.right.verificationId}`,
          message: "该侧记录未封存：没有可信结局，不参与比较结论",
        });
      }
      if (side?.sourceStatus === "missing") {
        limitations.push({
          code: "VERIFICATION_SOURCE_MISSING",
          ref: `verification:${label === "left" ? args.left.verificationId : args.right.verificationId}`,
          message: "该侧来源 trace 缺失：不宣称已核验修复分支或代码因果",
        });
      }
    }
    if (facts.verdict.kind === "evidence-incomplete" && facts.evidenceIncompleteFromCurrentAssets) {
      limitations.push({
        code: "VERIFICATION_SOURCE_MISSING",
        ref: "comparison",
        message: "至少一侧当前必需资产（日志/产物）不可核验：不发布可核查的修复结论",
      });
    }

    const provenance: ProvenanceVerificationInput[] = [];
    if (leftRead !== null) {
      provenance.push({
        verificationId: args.left.verificationId,
        status: leftRead.status,
        ...(leftRead.meta === undefined
          ? {}
          : { runId: leftRead.meta.target.runId, snapshotId: leftRead.meta.target.snapshotId }),
      });
    }
    if (rightRead !== null) {
      provenance.push({
        verificationId: args.right.verificationId,
        status: rightRead.status,
        ...(rightRead.meta === undefined
          ? {}
          : { runId: rightRead.meta.target.runId, snapshotId: rightRead.meta.target.snapshotId }),
      });
    }

    const readVersion = computeVerificationReadVersion(
      "compare_verifications",
      { left: { verificationId: args.left.verificationId }, right: { verificationId: args.right.verificationId } },
      root,
      {
        left: leftRead?.meta?.target.snapshotId ?? null,
        right: rightRead?.meta?.target.snapshotId ?? null,
      },
    );

    const data = CompareVerificationDataSchema.parse({
      left: {
        verificationId: args.left.verificationId,
        availability: leftRead === null ? "unavailable" : "ready",
        status: leftRead?.status ?? null,
        outcome: leftSide.facts.outcome,
        evidenceComplete: leftSide.facts.evidenceComplete,
        exitCode: leftSide.exitCode,
        currentAssetsAvailable: leftSide.facts.currentAssetsAvailable,
        recordedSnapshotId: leftSide.facts.recordedSnapshotId,
        sourceStatus: leftSide.facts.sourceStatus,
      },
      right: {
        verificationId: args.right.verificationId,
        availability: rightRead === null ? "unavailable" : "ready",
        status: rightRead?.status ?? null,
        outcome: rightSide.facts.outcome,
        evidenceComplete: rightSide.facts.evidenceComplete,
        exitCode: rightSide.exitCode,
        currentAssetsAvailable: rightSide.facts.currentAssetsAvailable,
        recordedSnapshotId: rightSide.facts.recordedSnapshotId,
        sourceStatus: rightSide.facts.sourceStatus,
      },
      conditions: facts.conditions.map((condition) => ({
        key: condition.key,
        state: condition.state,
      })),
      verdict: { kind: facts.verdict.kind },
      codeSame: facts.codeSame,
      sourceVerified: facts.sourceVerified,
      evidenceIncomplete: {
        fromRecord: facts.evidenceIncompleteFromRecord,
        fromCurrentAssets: facts.evidenceIncompleteFromCurrentAssets,
      },
      expectedSnapshotIds: facts.expectedSnapshotIds,
    });

    return {
      readVersion,
      data,
      truncated: false,
      runs: [],
      verifications: provenance,
      limitations,
      headline: [
        `compare_verifications：${facts.verdict.kind}`,
        `${String(facts.conditions.filter((c) => c.state === "same").length)} 同 / ${String(facts.conditions.filter((c) => c.state === "different").length)} 异 / ${String(facts.conditions.filter((c) => c.state === "unknown").length)} 未知`,
      ].join(" / "),
    };
  },
);

function readSide(root: DataRoot, verificationId: string): VerificationRecordRead | null {
  try {
    return getVerification(root.dataDir, verificationId, { tracesRoot: root.tracesDir });
  } catch {
    // M16：一侧不存在/不可读 ⇒ unavailable，另一侧仍可查（不抛错、不换验证）
    return null;
  }
}

interface SideBuild {
  readonly facts: VerificationFactsSide;
  readonly exitCode: number | null;
}

function sideFactsOf(
  root: DataRoot,
  verificationId: string,
  record: VerificationRecordRead | null,
): SideBuild {
  if (record === null) {
    return {
      facts: {
        verificationId,
        status: "corrupt",
        profileId: null,
        manifestVersion: null,
        planBindingDigest: null,
        commandId: null,
        executable: null,
        argv: null,
        cwd: null,
        environment: null,
        outcome: null,
        evidenceComplete: null,
        recordedSnapshotId: null,
        sourceStatus: "unknown",
        locatedSnapshotId: null,
        currentAssetsAvailable: null,
      },
      exitCode: null,
    };
  }
  const projected = projectVerification(record);
  const meta = projected.meta;
  const command = meta === null ? null : (projected.commands[0] ?? null);

  // 当前必需资产核验（D7）：meta.commandId 的 stdout/stderr 日志 + 全部已发布产物。
  // 解析歧义/缺失/损坏 ⇒ false；无法核验（未封存/坏记录）⇒ null（结论由其它门拦截）。
  let currentAssetsAvailable: boolean | null = null;
  if (record.status === "sealed" && meta !== null) {
    currentAssetsAvailable = true;
    try {
      for (const stream of ["stdout", "stderr"] as const) {
        const log = resolveLogAsset(record, meta.commandId, stream);
        verifyAsset(root.dataDir, log.sha256);
      }
      if (projected.artifacts !== null) {
        for (const entry of projected.artifacts.entries) {
          verifyAsset(root.dataDir, entry.sha256);
        }
      }
    } catch {
      currentAssetsAvailable = false;
    }
  }

  return {
    facts: {
      verificationId,
      status: projected.status,
      profileId: meta?.profileId ?? null,
      manifestVersion: meta?.manifestVersion ?? null,
      planBindingDigest: meta?.planBindingDigest ?? null,
      commandId: meta?.commandId ?? null,
      executable: command?.executable ?? null,
      argv: command === null ? null : [...command.argv],
      cwd: command?.cwd ?? null,
      environment:
        meta?.environment == null
          ? null
          : {
              platform: meta.environment.platform,
              imageDigest: meta.environment.imageDigest,
              toolchain: meta.environment.toolchain,
              limits: meta.environment.limits,
              security: meta.environment.security,
            },
      outcome: projected.terminated?.outcome ?? null,
      evidenceComplete: projected.terminated?.evidenceComplete ?? null,
      recordedSnapshotId: meta?.snapshotId ?? null,
      sourceStatus: projected.sourceStatus,
      locatedSnapshotId: null,
      currentAssetsAvailable,
    },
    exitCode: command?.exitCode ?? null,
  };
}
