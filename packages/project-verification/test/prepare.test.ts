import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Text } from "../src/canonical.js";
import type {
  PreparationBackend,
  TrustedEnvironmentBuildOutcome,
  TrustedEnvironmentBuildRequest,
} from "../src/prepare/backend.js";
import {
  PREPARE_POLICY_VERSION,
  buildPreparePlan,
  currentPreparePlanToken,
  manifestDigest,
  preparePlanDigest,
  preparePlanToken,
} from "../src/prepare/plan.js";
import { executePreparation } from "../src/prepare/prepare.js";
import { NODE_TS_V1_PROFILE, PreparationEventSchema } from "../src/schema.js";
import {
  NODE_TS_V1_BUILD_ASSETS,
  nodeTsV1ExpectedAssetHashes,
  nodeTsV1RecipeSha256,
  verifyNodeTsV1Assets,
} from "../src/trusted-env/node-ts-v1.js";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "r3-pv-prep-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  // 临时目录交由系统清理；测试间互不共享 root
});

const FIXED_NOW = () => new Date("2026-10-25T03:00:00.000Z");
const GOOD_OUTCOME: TrustedEnvironmentBuildOutcome = {
  imageDigest: `sha256:${"a".repeat(64)}`,
  toolchain: { node: "22.23.4", typescript: "5.9.3" },
  networkUsed: true,
  downloadedBytes: 65712983,
};

/** 编排测试的记录后端：只覆盖编排（design D3——mock 不能代替真实门槛）。 */
class FakeBackend implements PreparationBackend {
  calls = 0;
  lastRequest: TrustedEnvironmentBuildRequest | null = null;
  constructor(private readonly behavior: () => TrustedEnvironmentBuildOutcome) {}
  async buildTrustedEnvironment(
    request: TrustedEnvironmentBuildRequest,
  ): Promise<TrustedEnvironmentBuildOutcome> {
    this.calls += 1;
    this.lastRequest = request;
    return this.behavior();
  }
}

function throwingBackend(message: string): FakeBackend {
  return new FakeBackend(() => {
    throw new Error(message);
  });
}

function validInput(): { profileId: "node-ts-v1"; planToken: string; allowPrepare: true } {
  return { profileId: "node-ts-v1", planToken: currentPreparePlanToken(), allowPrepare: true };
}

function readPreparationLines(root: string, preparationId: string): unknown[] {
  const text = readFileSync(
    join(root, "verification-environments", `${preparationId}.jsonl`),
    "utf8",
  );
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("受信环境资产完整性门（3.1，P08 准备侧）", () => {
  it("产品内嵌资产逐项哈希等于冻结 manifest 期望值，完整性门通过", () => {
    const result = verifyNodeTsV1Assets();
    expect(result.ok).toBe(true);
    // 锁文件哈希必须就是 manifest 冻结值（v2 配方 npm ci 不改写锁文件，实测对上）
    expect(nodeTsV1ExpectedAssetHashes()["package-lock.json"]).toBe(
      NODE_TS_V1_PROFILE.trustedEnvironment.lockfile.sha256,
    );
    expect(sha256Text(NODE_TS_V1_BUILD_ASSETS["package-lock.json"] as string)).toBe(
      NODE_TS_V1_PROFILE.trustedEnvironment.lockfile.sha256,
    );
  });

  it("配方摘要重算稳定，且进入当前计划 token", () => {
    expect(nodeTsV1RecipeSha256()).toBe(nodeTsV1RecipeSha256());
    expect(currentPreparePlanToken()).toBe(
      preparePlanToken(buildPreparePlan(), nodeTsV1RecipeSha256()),
    );
  });

  it("篡改任一受信资产即拒绝并指名文件", () => {
    const tampered = { ...NODE_TS_V1_BUILD_ASSETS, "runner.mjs": "// pwned\n" };
    const result = verifyNodeTsV1Assets(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("runner.mjs");
      expect(result.reason).toContain("不一致");
    }
  });

  it("缺少配方文件（Dockerfile/package.json）拒绝", () => {
    const withoutDockerfile = Object.fromEntries(
      Object.entries(NODE_TS_V1_BUILD_ASSETS).filter(([path]) => path !== "Dockerfile"),
    );
    const result = verifyNodeTsV1Assets(withoutDockerfile);
    expect(result.ok).toBe(false);
  });
});

describe("固定准备计划（3.1，P03/P07）", () => {
  it("计划可解析且下载/网络/许可/占用逐项在场（纯函数，不触碰后端）", () => {
    const plan = buildPreparePlan();
    expect(plan.profileId).toBe("node-ts-v1");
    expect(plan.downloads).toHaveLength(2);
    for (const download of plan.downloads) {
      expect(download.source).toMatch(/^(docker\.m\.daocloud\.io|https:\/\/registry\.npmjs\.org)/);
      expect(download.approxBytes).toBeGreaterThan(0);
      expect(download.license.length).toBeGreaterThan(0);
    }
    expect(plan.networkScopeNote).toContain("正式测试断网");
    expect(plan.spaceEstimateBytes).toBeGreaterThan(0);
    expect(plan.manifestDigest).toBe(manifestDigest());
  });

  it("计划 token 决定且敏感：配方或计划内容变化即变化（P07 绑定面）", () => {
    const plan = buildPreparePlan();
    const token = preparePlanToken(plan, nodeTsV1RecipeSha256());
    expect(token).toBe(preparePlanToken(buildPreparePlan(), nodeTsV1RecipeSha256()));
    expect(token).not.toBe(preparePlanToken(plan, "f".repeat(64)));
    // 键序无关（规范序列化）：内容相同的重排计划 token 不变；内容变化即变化
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(plan).reverse()) {
      reordered[key] = (plan as unknown as Record<string, unknown>)[key];
    }
    expect(token).toBe(
      preparePlanToken(reordered as unknown as typeof plan, nodeTsV1RecipeSha256()),
    );
    expect(token).not.toBe(
      preparePlanToken(
        { ...plan, spaceEstimateBytes: plan.spaceEstimateBytes + 1 },
        nodeTsV1RecipeSha256(),
      ),
    );
    // 策略版本参与 token（当前导出版本只作存在性锚定）
    expect(PREPARE_POLICY_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("受限准备执行编排（3.1，P04/P07/P08）", () => {
  it("授权准备成功：独立记录 meta→prepared→terminated，身份/摘要/网络事实在场", async () => {
    const root = newRoot();
    const backend = new FakeBackend(() => GOOD_OUTCOME);
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_1",
      input: validInput(),
      now: FIXED_NOW,
      mintPreparationId: () => "prep-ok0000000001",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.preparationId).toBe("prep-ok0000000001");
    expect(result.imageDigest).toBe(GOOD_OUTCOME.imageDigest);

    const lines = readPreparationLines(root, "prep-ok0000000001").map((line) =>
      PreparationEventSchema.parse(line),
    );
    expect(lines).toHaveLength(3);
    const [meta, prepared, terminated] = lines as unknown as [
      { type: string; preparationId: string; planDigest: string; manifestVersion: number },
      { type: string; imageDigest: string; downloadedBytes: number | null },
      { type: string; outcome: string },
    ];
    expect(meta.type).toBe("meta");
    expect(meta.preparationId).toBe("prep-ok0000000001");
    expect(meta.planDigest).toBe(preparePlanDigest(buildPreparePlan()));
    expect(meta.manifestVersion).toBe(NODE_TS_V1_PROFILE.manifestVersion);
    expect(prepared.type).toBe("prepared");
    expect(prepared.imageDigest).toBe(GOOD_OUTCOME.imageDigest);
    expect(terminated).toEqual({
      type: "terminated",
      outcome: "prepared",
      at: "2026-10-25T03:00:00.000Z",
    });
    // 独立准备记录：验证记录目录未被创建
    expect(existsSync(join(root, "verifications"))).toBe(false);
    expect(backend.lastRequest?.assets).toEqual(NODE_TS_V1_BUILD_ASSETS);
  });

  it("downloadedBytes 为 null（后端测不得）也是合法成功记录", async () => {
    const root = newRoot();
    const backend = new FakeBackend(() => ({ ...GOOD_OUTCOME, downloadedBytes: null }));
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_2",
      input: validInput(),
      now: FIXED_NOW,
      mintPreparationId: () => "prep-nullbytes001",
    });
    expect(result.ok).toBe(true);
    const [, prepared] = readPreparationLines(root, "prep-nullbytes001") as [
      unknown,
      { downloadedBytes: number | null },
    ];
    expect(prepared.downloadedBytes).toBeNull();
  });

  it("准备失败（后端构建抛错）：failed 记录封存真实原因，不算测试失败", async () => {
    const root = newRoot();
    const backend = throwingBackend("npm ci integrity mismatch for typescript@5.9.3");
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_3",
      input: validInput(),
      now: FIXED_NOW,
      mintPreparationId: () => "prep-fail0000001",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("prepare_failed");
    expect(result.failure.reason).toContain("integrity mismatch");
    expect(result.preparationId).toBe("prep-fail0000001");

    const lines = readPreparationLines(root, "prep-fail0000001").map((line) =>
      PreparationEventSchema.parse(line),
    );
    expect(lines).toHaveLength(3);
    const [, failed, terminated] = lines as unknown as [
      unknown,
      { type: string; reason: string },
      { outcome: string },
    ];
    expect(failed.type).toBe("failed");
    expect(failed.reason).toContain("integrity mismatch");
    expect(terminated.outcome).toBe("failed");
    // 失败也不产生验证记录（准备与验证是两套记录域）
    expect(existsSync(join(root, "verifications"))).toBe(false);
  });

  it("后端返回非法镜像摘要：failed 记录 + prepare_failed", async () => {
    const root = newRoot();
    const backend = new FakeBackend(() => ({
      ...GOOD_OUTCOME,
      imageDigest: "r3/node-ts-v1:latest",
    }));
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_4",
      input: validInput(),
      now: FIXED_NOW,
      mintPreparationId: () => "prep-baddigest1",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.preparationId === null) throw new Error("unreachable");
    expect(result.failure.code).toBe("prepare_failed");
    const terminated = readPreparationLines(root, result.preparationId)[2] as {
      outcome: string;
    };
    expect(terminated.outcome).toBe("failed");
  });

  it("缺少 allowPrepare:true：授权门拒绝，零记录零后端调用（P04）", async () => {
    const root = newRoot();
    const backend = throwingBackend("不应被调用");
    for (const badInput of [
      { profileId: "node-ts-v1", planToken: currentPreparePlanToken() },
      { profileId: "node-ts-v1", planToken: currentPreparePlanToken(), allowPrepare: false },
    ]) {
      const result = await executePreparation({
        dataRoot: root,
        backend,
        epoch: "ep_r3",
        operationId: "op_prepare_5",
        input: badInput,
        now: FIXED_NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.code).toBe("prepare_not_allowed");
      expect(result.preparationId).toBeNull();
    }
    expect(backend.calls).toBe(0);
    expect(existsSync(join(root, "verification-environments"))).toBe(false);
  });

  it("请求带多余键：schema strict 拒绝（P08 形状面）", async () => {
    const root = newRoot();
    const backend = throwingBackend("不应被调用");
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_6",
      input: { ...validInput(), executable: "/bin/sh" },
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("invalid_input");
    expect(backend.calls).toBe(0);
    expect(existsSync(join(root, "verification-environments"))).toBe(false);
  });

  it("旧 token（配方/策略漂移后）按 plan_stale 拒绝：零记录零调用（P07）", async () => {
    const root = newRoot();
    const backend = throwingBackend("不应被调用");
    const staleInput = {
      profileId: "node-ts-v1" as const,
      planToken: preparePlanToken(buildPreparePlan(), "f".repeat(64)),
      allowPrepare: true as const,
    };
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_7",
      input: staleInput,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("plan_stale");
    expect(result.preparationId).toBeNull();
    expect(backend.calls).toBe(0);
    expect(existsSync(join(root, "verification-environments"))).toBe(false);
  });

  it("资产被篡改：已接受后失败 ⇒ failed 记录在案 + trusted_environment_drift（P08）", async () => {
    const root = newRoot();
    const backend = throwingBackend("不应被调用");
    const result = await executePreparation({
      dataRoot: root,
      backend,
      epoch: "ep_r3",
      operationId: "op_prepare_8",
      input: validInput(),
      assets: { ...NODE_TS_V1_BUILD_ASSETS, "package-lock.json": '{"tampered":true}' },
      now: FIXED_NOW,
      mintPreparationId: () => "prep-drift00001",
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.preparationId === null) throw new Error("unreachable");
    expect(result.failure.code).toBe("trusted_environment_drift");
    expect(result.failure.reason).toContain("package-lock.json");
    expect(backend.calls).toBe(0);
    const terminated = readPreparationLines(root, "prep-drift00001")[2] as { outcome: string };
    expect(terminated.outcome).toBe("failed");
  });
});
