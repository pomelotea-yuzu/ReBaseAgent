import { describe, expect, it } from "vitest";
import {
  CheckpointSelectorSchema,
  CommandIdSchema,
  LocalBackendEndpointSchema,
  NODE_TS_V1_PROFILE,
  PreparationEventSchema,
  PreparePlanSchema,
  ProfileManifestSchema,
  ResourceRegistrationSchema,
  VerificationErrorCodeSchema,
  VerificationEventSchema,
  VerificationOutcomeSchema,
  VerificationPrepareInputSchema,
  VerificationRunInputSchema,
} from "../src/schema.js";

const validSelectorTarget = {
  runId: "run_abc123",
  checkpoint: { kind: "step", stepSpanId: "s_03" } as const,
};

const validRunInput = {
  target: validSelectorTarget,
  profileId: "node-ts-v1",
  commandId: "test",
  planToken: "tok_1",
  allowExecution: true,
};

describe("检查点选择器必须显式（P05）", () => {
  it("initial 与 step 两形态可解析", () => {
    expect(CheckpointSelectorSchema.parse({ kind: "initial" })).toEqual({ kind: "initial" });
    expect(CheckpointSelectorSchema.parse({ kind: "step", stepSpanId: "s_03" })).toEqual({
      kind: "step",
      stepSpanId: "s_03",
    });
  });
  it("step 缺 stepSpanId 拒绝", () => {
    expect(CheckpointSelectorSchema.safeParse({ kind: "step" }).success).toBe(false);
  });
  it("空对象与未知形态拒绝——没有默认检查点", () => {
    expect(CheckpointSelectorSchema.safeParse({}).success).toBe(false);
    expect(CheckpointSelectorSchema.safeParse({ kind: "latest" }).success).toBe(false);
  });
  it("多余键拒绝（strict）", () => {
    expect(CheckpointSelectorSchema.safeParse({ kind: "initial", fallback: true }).success).toBe(
      false,
    );
  });
});

describe("命令与输入面（P07/P08）", () => {
  it("命令仅枚举 typecheck/test", () => {
    expect(CommandIdSchema.parse("typecheck")).toBe("typecheck");
    expect(CommandIdSchema.parse("test")).toBe("test");
    expect(CommandIdSchema.safeParse("npm run build").success).toBe(false);
    expect(CommandIdSchema.safeParse("bash").success).toBe(false);
  });
  it("执行输入要求显式 allowExecution:true", () => {
    expect(VerificationRunInputSchema.parse(validRunInput).commandId).toBe("test");
    expect(
      VerificationRunInputSchema.safeParse({ ...validRunInput, allowExecution: false }).success,
    ).toBe(false);
    const { allowExecution: _omit, ...withoutFlag } = validRunInput;
    expect(VerificationRunInputSchema.safeParse(withoutFlag).success).toBe(false);
  });
  it("执行输入不存在的字段直接拒绝（路径/环境/镜像无处可传）", () => {
    expect(
      VerificationRunInputSchema.safeParse({ ...validRunInput, physicalPath: "D:/evil" }).success,
    ).toBe(false);
    expect(
      VerificationRunInputSchema.safeParse({ ...validRunInput, env: { HACK: "1" } }).success,
    ).toBe(false);
  });
  it("准备输入要求显式 allowPrepare:true", () => {
    expect(
      VerificationPrepareInputSchema.parse({
        profileId: "node-ts-v1",
        planToken: "tok_1",
        allowPrepare: true,
      }).profileId,
    ).toBe("node-ts-v1");
    expect(
      VerificationPrepareInputSchema.safeParse({
        profileId: "node-ts-v1",
        planToken: "tok_1",
        allowPrepare: false,
      }).success,
    ).toBe(false);
  });
});

describe("后端 endpoint 仅本机命名管道（P02）", () => {
  it("两种本机管道可解析", () => {
    expect(LocalBackendEndpointSchema.parse("npipe:////./pipe/dockerDesktopLinuxEngine")).toContain(
      "npipe",
    );
    expect(LocalBackendEndpointSchema.parse("npipe:////./pipe/docker_engine")).toContain("npipe");
  });
  it("TCP/SSH/UNIX 远程或覆盖形态拒绝", () => {
    expect(LocalBackendEndpointSchema.safeParse("tcp://127.0.0.1:2375").success).toBe(false);
    expect(LocalBackendEndpointSchema.safeParse("ssh://user@remote").success).toBe(false);
    expect(LocalBackendEndpointSchema.safeParse("unix:///var/run/docker.sock").success).toBe(false);
  });
});

describe("node-ts-v1 冻结 manifest", () => {
  it("冻结实例通过自身 schema 校验", () => {
    expect(ProfileManifestSchema.parse(NODE_TS_V1_PROFILE)).toEqual(NODE_TS_V1_PROFILE);
  });
  it("digest 必须是 sha256:<64 位小写十六进制>", () => {
    const bad = structuredClone(NODE_TS_V1_PROFILE);
    bad.baseImage.digest = "sha256:XYZ";
    expect(ProfileManifestSchema.safeParse(bad).success).toBe(false);
  });
  it("tmpfs 合并预算语义不可关闭（阶段 1 发现）", () => {
    const bad = {
      ...NODE_TS_V1_PROFILE,
      limits: { ...NODE_TS_V1_PROFILE.limits, tmpfsCountsTowardMemoryBudget: false },
    };
    expect(ProfileManifestSchema.safeParse(bad).success).toBe(false);
  });
  it("缺少任一固定命令拒绝", () => {
    const bad = structuredClone(NODE_TS_V1_PROFILE);
    bad.commands = bad.commands.filter((c) => c.commandId !== "test");
    expect(ProfileManifestSchema.safeParse(bad).success).toBe(false);
  });
  it("commandId 重复拒绝", () => {
    const bad = structuredClone(NODE_TS_V1_PROFILE);
    bad.commands = [{ ...bad.commands[0] }, { ...bad.commands[0] }];
    expect(ProfileManifestSchema.safeParse(bad).success).toBe(false);
  });
  it("安全口径任一项降级拒绝", () => {
    const bad = {
      ...NODE_TS_V1_PROFILE,
      security: { ...NODE_TS_V1_PROFILE.security, readOnlyRootfs: false },
    };
    expect(ProfileManifestSchema.safeParse(bad).success).toBe(false);
    const bad2 = {
      ...NODE_TS_V1_PROFILE,
      security: { ...NODE_TS_V1_PROFILE.security, networkMode: "bridge" },
    };
    expect(ProfileManifestSchema.safeParse(bad2).success).toBe(false);
  });
});

describe("结局与错误码（D6/P15）", () => {
  it("11 种结局逐一可解析，编造值拒绝", () => {
    const outcomes = [
      "check_failed",
      "passed",
      "environment_failed",
      "start_failed",
      "process_failed",
      "timed_out",
      "output_limit",
      "cancelled",
      "artifact_invalid",
      "evidence_incomplete",
      "unknown",
    ] as const;
    for (const o of outcomes) {
      expect(VerificationOutcomeSchema.parse(o)).toBe(o);
    }
    expect(VerificationOutcomeSchema.safeParse("success").success).toBe(false);
    expect(VerificationOutcomeSchema.safeParse("failed").success).toBe(false);
  });
  it("错误码闭集：样本可解析、拼错拒绝", () => {
    expect(VerificationErrorCodeSchema.parse("BACKEND_REMOTE_REFUSED")).toBe(
      "BACKEND_REMOTE_REFUSED",
    );
    expect(VerificationErrorCodeSchema.parse("PLAN_STALE")).toBe("PLAN_STALE");
    expect(VerificationErrorCodeSchema.safeParse("BACKEND_REMOTE").success).toBe(false);
  });
});

describe("验证记录事件（P15：版本与形状）", () => {
  const metaEvent = {
    type: "meta",
    schemaVersion: 1,
    verificationId: "ver_1",
    epoch: "ep_1",
    operationId: "op_1",
    target: { runId: "run_abc123", checkpoint: { kind: "initial" }, snapshotId: "snap_1" },
    profileId: "node-ts-v1",
    manifestVersion: 1,
    commandId: "test",
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  } as const;

  it("合法 meta 事件可解析并 JSON 往返一致", () => {
    const parsed = VerificationEventSchema.parse(metaEvent);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
  it("未知 schemaVersion 拒绝（不得静默降级）", () => {
    const bad = { ...metaEvent, schemaVersion: 2 };
    expect(VerificationEventSchema.safeParse(bad).success).toBe(false);
  });
  it("terminated 结局必须取值于枚举", () => {
    const ok = {
      type: "terminated",
      outcome: "evidence_incomplete",
      detail: "stdout 截断",
      evidenceComplete: false,
      at: "2026-10-25T00:00:01.000Z",
    };
    expect(VerificationEventSchema.parse(ok).type).toBe("terminated");
    expect(VerificationEventSchema.safeParse({ ...ok, outcome: "green" }).success).toBe(false);
  });
  it("command_end 允许 exitCode:null + signal（被杀形态）", () => {
    const killed = {
      type: "command_end",
      commandId: "test",
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 4800,
      stdout: { byteLength: 3, totalBytes: 3, sha256: "b".repeat(64), truncated: false },
      stderr: { byteLength: 0, totalBytes: 0, sha256: "c".repeat(64), truncated: false },
      endedAt: "2026-10-25T00:00:02.000Z",
    };
    const r = VerificationEventSchema.safeParse(killed);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe("command_end");
    }
  });
});

describe("准备记录与恢复日志", () => {
  it("准备事件 prepared 形状可解析", () => {
    const ev = {
      type: "prepared",
      imageDigest: `sha256:${"d".repeat(64)}`,
      toolchain: { node: "22.23.4", typescript: "5.9.3" },
      networkUsed: true,
      downloadedBytes: 1048576,
      at: "2026-10-25T00:00:00.000Z",
    };
    expect(PreparationEventSchema.parse(ev).type).toBe("prepared");
  });
  it("准备计划含下载来源/许可/体积（P03 形状）", () => {
    const plan = {
      profileId: "node-ts-v1",
      manifestVersion: 1,
      manifestDigest: "e".repeat(64),
      downloads: [
        {
          source: "registry",
          approxBytes: 60000000,
          license: "Docker Subscription Service Agreement",
        },
      ],
      networkScopeNote: "仅环境准备阶段联网；正式测试断网",
      spaceEstimateBytes: 524288000,
    };
    expect(PreparePlanSchema.parse(plan).downloads).toHaveLength(1);
    expect(PreparePlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
  });
  it("资源登记 owner 标签闭集（P23：归属不可任意声明）", () => {
    const reg = {
      resourceOwnerId: "r3-run_x-abc",
      kind: "verification",
      ownerLabel: "rebaseagent-r3",
      knownContainerIds: [],
      phase: "registered",
      preparationId: null,
      verificationId: "ver_1",
      updatedAt: "2026-10-25T00:00:00.000Z",
    };
    expect(ResourceRegistrationSchema.parse(reg).phase).toBe("registered");
    expect(
      ResourceRegistrationSchema.safeParse({ ...reg, ownerLabel: "someuser-app" }).success,
    ).toBe(false);
  });
});
