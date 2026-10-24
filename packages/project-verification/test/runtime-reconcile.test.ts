import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RecordAppendError,
  appendInterruptedToVerificationRecord,
  probeRecordState,
} from "../src/records/append.js";
import { verificationRecordPath } from "../src/records/layout.js";
import { PreparationRecordWriter, VerificationRecordWriter } from "../src/records/writer.js";
import type { RuntimeResourceFacts, RuntimeResourcePort } from "../src/runtime/reconcile.js";
import { reconcileStartupLeftovers } from "../src/runtime/reconcile.js";
import {
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  bindCreatedContainer,
  registerResourceBeforeCreate,
} from "../src/runtime/registration.js";
import {
  type InterruptedEvent,
  PreparationMetaEventSchema,
  VerificationEventSchema,
  VerificationMetaEventSchema,
} from "../src/schema.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "r3-pv-rec-"));
}

function verificationMeta(verificationId: string) {
  return {
    verificationId,
    epoch: "ep-old",
    operationId: "op-old",
    target: {
      runId: "run_rec1",
      checkpoint: { kind: "initial" } as const,
      snapshotId: "snap_1",
    },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "a".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

function preparationMeta(preparationId: string) {
  return {
    preparationId,
    epoch: "ep-old",
    operationId: "op-old",
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    planDigest: "b".repeat(64),
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

function metaSchemaParse(kind: "verification" | "preparation", id: string) {
  return kind === "verification"
    ? VerificationMetaEventSchema.parse({ ...verificationMeta(id), type: "meta", schemaVersion: 1 })
    : PreparationMetaEventSchema.parse({ ...preparationMeta(id), type: "meta", schemaVersion: 1 });
}

function openVerification(root: string, id: string): VerificationRecordWriter {
  return VerificationRecordWriter.open(root, metaSchemaParse("verification", id));
}

function openPreparation(root: string, id: string): PreparationRecordWriter {
  return PreparationRecordWriter.open(root, metaSchemaParse("preparation", id));
}

function facts(name: string, id: string): RuntimeResourceFacts {
  return {
    containerId: id,
    name,
    state: "running",
    labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE },
  };
}

class FakePort implements RuntimeResourcePort {
  stopCalls: string[] = [];
  confirmCalls: string[] = [];
  removeCalls: string[] = [];
  constructor(
    private readonly containers: RuntimeResourceFacts[],
    private readonly failStopOn: string | null = null,
    private readonly listThrows = false,
  ) {}
  async listOwnedContainers(): Promise<RuntimeResourceFacts[]> {
    if (this.listThrows) {
      throw new Error(
        "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified",
      );
    }
    return this.containers;
  }
  async stopContainer(containerId: string): Promise<void> {
    if (this.failStopOn === containerId) {
      throw new Error("docker stop 非零退出：device is busy");
    }
    this.stopCalls.push(containerId);
  }
  async confirmStopped(containerId: string): Promise<void> {
    this.confirmCalls.push(containerId);
  }
  async removeContainer(containerId: string): Promise<void> {
    this.removeCalls.push(containerId);
  }
}

const ID64 = (c: string) => c.repeat(64);

/** 一条「crash 现场」夹具：登记（可选绑定 ID）+ 未封存验证记录。 */
function crashFixture(
  root: string,
  opts: {
    ownerId: string;
    verificationId: string;
    /** 传入即绑定该容器 ID（应与 port 侧 facts 一致）；省略 = phase 保持 registered。 */
    bind?: string;
    seal?: boolean;
    seedInterrupted?: boolean;
  },
) {
  registerResourceBeforeCreate(root, {
    kind: "verification",
    epoch: "ep-old",
    dataRoot: root,
    verificationId: opts.verificationId,
    resourceOwnerId: opts.ownerId,
  });
  if (opts.bind !== undefined) {
    bindCreatedContainer(root, opts.ownerId, opts.bind);
  }
  const writer = openVerification(root, opts.verificationId);
  writer.append({ type: "stage", phase: "executing", at: "2026-10-25T00:00:01.000Z" });
  if (opts.seal) {
    writer.terminate({
      outcome: "check_failed",
      detail: "断言失败",
      evidenceComplete: true,
      at: "2026-10-25T00:00:03.000Z",
    });
  }
  if (opts.seedInterrupted) {
    appendInterruptedToVerificationRecord(root, opts.verificationId, {
      reason: "早前核查",
      stoppedResources: [],
      removedResources: [],
      unconfirmedResources: [],
      at: "2026-10-25T00:00:02.000Z",
    });
  }
  return { name: `r3-verify-${opts.ownerId}` };
}

describe("启动残留核查：干净与主路径（P22）", () => {
  it("干净机器（无登记无容器）⇒ ok，零动作", async () => {
    const root = newRoot();
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(outcome).toMatchObject({ ok: true, scannedRegistrations: 0 });
  });

  it("主路径：登记+存活容器+未封存记录 ⇒ 停止/确认/移除 + interrupted 事实 + 登记收尾", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "main01",
      verificationId: "ver_main1",
      bind: ID64("2"),
    });
    const port = new FakePort([facts(name, ID64("2"))]);
    const outcome = await reconcileStartupLeftovers({ root, port });
    expect(outcome).toMatchObject({
      ok: true,
      stopped: [{ name, containerId: ID64("2") }],
      removed: [{ name, containerId: ID64("2") }],
      appendedRecords: ["ver_main1"],
    });
    // 容器级动作顺序：stop → confirm → remove（确认后才移除，不乐观）
    expect(port.stopCalls).toEqual([ID64("2")]);
    expect(port.confirmCalls).toEqual([ID64("2")]);
    expect(port.removeCalls).toEqual([ID64("2")]);
    // 记录内 interrupted 事实：含资源名与容器 ID，不写终止
    const text = readFileSync(verificationRecordPath(root, "ver_main1"), "utf8");
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    const interrupted = events.find((e) => e.type === "interrupted") as
      | InterruptedEvent
      | undefined;
    expect(interrupted).toBeDefined();
    expect(interrupted?.stoppedResources).toEqual([{ name, containerId: ID64("2") }]);
    expect(interrupted?.removedResources).toEqual([{ name, containerId: ID64("2") }]);
    expect(events.filter((e) => e.type === "terminated")).toEqual([]);
    // 登记收尾 + 复跑幂等（no-op）
    expect(listPhase(root, "main01")).toBe("removed");
    const again = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(again).toMatchObject({ ok: true, stopped: [], appendedRecords: [] });
  });

  it("响应丢失窗口：phase=registered（未绑定 ID）+ 容器按名存活 ⇒ 同样清理（P22）", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "resp01",
      verificationId: "ver_resp1",
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts(name, ID64("3"))]),
    });
    expect(outcome).toMatchObject({ ok: true, appendedRecords: ["ver_resp1"] });
    expect(listPhase(root, "resp01")).toBe("removed");
  });

  it("准备资源同理：kind=prepare + 未封存准备记录 ⇒ 向准备记录追加 interrupted", async () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "prepare",
      epoch: "ep-old",
      dataRoot: root,
      preparationId: "prep_p1",
      resourceOwnerId: "prep01",
    });
    openPreparation(root, "prep_p1").append({
      type: "failed",
      reason: "构建中断",
      at: "2026-10-25T00:00:01.000Z",
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts("r3-prepare-prep01", ID64("4"))]),
    });
    expect(outcome).toMatchObject({ ok: true, appendedRecords: ["prep_p1"] });
    const text = readFileSync(join(root, "verification-environments", "prep_p1.jsonl"), "utf8");
    expect(text).toContain('"type":"interrupted"');
    expect(text).not.toContain('"type":"terminated"');
  });
});

describe("启动残留核查：阻断矩阵（P23）", () => {
  it("带 owner 标签但无登记 ⇒ 归属不明 ⇒ 阻断且未触碰（陌生资源保护）", async () => {
    const root = newRoot();
    const port = new FakePort([facts("r3-verify-ghost01", ID64("5"))]);
    const outcome = await reconcileStartupLeftovers({ root, port });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "blocked",
      unattributed: [{ name: "r3-verify-ghost01", containerId: ID64("5") }],
    });
    expect(port.stopCalls).toEqual([]);
    expect(port.removeCalls).toEqual([]);
  });

  it("登记在案但容器名对不上（登记 containerName 不一致）⇒ 归属不明 ⇒ 阻断", async () => {
    const root = newRoot();
    crashFixture(root, { ownerId: "name01", verificationId: "ver_name1" });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts("somebody-elses-name", ID64("6"))]),
    });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("容器 ID 与登记 knownContainerIds 冲突 ⇒ 归属存疑按陌生处理 ⇒ 阻断", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "conf01",
      verificationId: "ver_conf1",
      bind: ID64("1"), // knownContainerIds 与容器 ID 冲突
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts(name, ID64("7"))]), // 不同 ID 同名
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "blocked",
      unattributed: [expect.anything()],
    });
  });

  it("恢复日志损坏 ⇒ 阻断（先于任何容器动作）", async () => {
    const root = newRoot();
    crashFixture(root, { ownerId: "corrupt01", verificationId: "ver_cor1" });
    writeFileSync(join(root, "verification-runtime", "corrupt01.json"), "}}{{", "utf8");
    const port = new FakePort([facts("r3-verify-corrupt01", ID64("8"))]);
    const outcome = await reconcileStartupLeftovers({ root, port });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
    expect(port.stopCalls).toEqual([]);
  });

  it("daemon 不可达 ⇒ 阻断（P21/P23 断连族）", async () => {
    const root = newRoot();
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([], null, true) });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
    expect((outcome as { reason: string }).reason).toContain("daemon 不可达");
  });

  it("登记关联的验证记录缺失 ⇒ 阻断（记录先于资源的纪律被破坏）", async () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-old",
      dataRoot: root,
      verificationId: "ver_gone1",
      resourceOwnerId: "gone01",
    });
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("记录坏尾（无换行结尾）⇒ 损坏 ⇒ 阻断", async () => {
    const root = newRoot();
    crashFixture(root, { ownerId: "tail01", verificationId: "ver_tail1" });
    const file = verificationRecordPath(root, "ver_tail1");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, ""), "utf8");
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("已封存记录 + 容器仍存活 ⇒ 收尾事实自相矛盾 ⇒ 阻断", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "seal01",
      verificationId: "ver_seal1",
      bind: ID64("9"),
      seal: true,
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts(name, ID64("9"))]),
    });
    expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("已封存记录 + 无容器 ⇒ ok（历史干净），不追加 interrupted", async () => {
    const root = newRoot();
    crashFixture(root, {
      ownerId: "sealok01",
      verificationId: "ver_sealok1",
      bind: ID64("1"),
      seal: true,
    });
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(outcome).toMatchObject({
      ok: true,
      sealedRecords: ["ver_sealok1"],
      appendedRecords: [],
    });
    expect(listPhase(root, "sealok01")).toBe("removed");
  });

  it("停止中途失败 ⇒ blocked + 部分事实如实呈现（不伪造清理成功）", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "part01",
      verificationId: "ver_part1",
      bind: ID64("a"),
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts(name, ID64("a"))], ID64("a")),
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "blocked",
      partialStopped: [],
      partialRemoved: [],
    });
    expect(listPhase(root, "part01")).toBe("created"); // 登记未收尾，复跑可重试
  });
});

describe("interrupted 追加的幂等与门", () => {
  it("记录已有 interrupted ⇒ 不二次追加，登记仍收尾", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "idem01",
      verificationId: "ver_idem1",
      bind: ID64("b"),
      seedInterrupted: true,
    });
    const outcome = await reconcileStartupLeftovers({
      root,
      port: new FakePort([facts(name, ID64("b"))]),
    });
    expect(outcome).toMatchObject({ ok: true, appendedRecords: [] });
    const text = readFileSync(verificationRecordPath(root, "ver_idem1"), "utf8");
    expect(text.match(/"type":"interrupted"/g)).toHaveLength(1);
    expect(listPhase(root, "idem01")).toBe("removed");
  });

  it("未封存 + 无容器（create 前崩溃）⇒ interrupted 以 unconfirmed 如实登记", async () => {
    const root = newRoot();
    crashFixture(root, { ownerId: "noc01", verificationId: "ver_noc1" });
    const outcome = await reconcileStartupLeftovers({ root, port: new FakePort([]) });
    expect(outcome).toMatchObject({
      ok: true,
      appendedRecords: ["ver_noc1"],
      unconfirmed: ["r3-verify-noc01"],
    });
    const text = readFileSync(verificationRecordPath(root, "ver_noc1"), "utf8");
    expect(text).toContain('"unconfirmedResources":["r3-verify-noc01"]');
  });

  it("append 拒绝：已封存 / 身份错配 / 坏尾（不写盘）", () => {
    const root = newRoot();
    crashFixture(root, { ownerId: "gate01", verificationId: "ver_gate1", seal: true });
    expect(() =>
      appendInterruptedToVerificationRecord(root, "ver_gate1", {
        reason: "x",
        stoppedResources: [],
        removedResources: [],
        unconfirmedResources: [],
        at: "2026-10-25T00:00:00.000Z",
      }),
    ).toThrow(RecordAppendError);

    crashFixture(root, { ownerId: "gate02", verificationId: "ver_gate2" });
    // 身份错配 = 文件内容合法但 meta 身份与路径不符（外部篡改形态）⇒ 按损坏拒绝
    const tampered = verificationRecordPath(root, "ver_gate2");
    const lines = readFileSync(tampered, "utf8").split("\n");
    lines[0] = lines[0].replace("ver_gate2", "ver_evil1");
    writeFileSync(tampered, lines.join("\n"), "utf8");
    expect(() =>
      appendInterruptedToVerificationRecord(root, "ver_gate2", {
        reason: "x",
        stoppedResources: [],
        removedResources: [],
        unconfirmedResources: [],
        at: "2026-10-25T00:00:00.000Z",
      }),
    ).toThrow(/身份错配/);

    const file = verificationRecordPath(root, "ver_gate2");
    const before = readFileSync(file, "utf8");
    expect(() =>
      appendInterruptedToVerificationRecord(root, "ver_missing", {
        reason: "x",
        stoppedResources: [],
        removedResources: [],
        unconfirmedResources: [],
        at: "2026-10-25T00:00:00.000Z",
      }),
    ).toThrow(/RECORD_NOT_FOUND/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("追加失败（记录不可写）⇒ RecordAppendError.IO_FAILED，登记不收尾（复跑重试）", async () => {
    const root = newRoot();
    const { name } = crashFixture(root, {
      ownerId: "ro01",
      verificationId: "ver_ro1",
      bind: ID64("c"),
    });
    const file = verificationRecordPath(root, "ver_ro1");
    chmodSync(file, 0o444);
    try {
      const outcome = await reconcileStartupLeftovers({
        root,
        port: new FakePort([facts(name, ID64("c"))]),
      });
      expect(outcome).toMatchObject({ ok: false, kind: "blocked" });
      expect(listPhase(root, "ro01")).toBe("created");
    } finally {
      chmodSync(file, 0o666);
    }
  });
});

describe("probeRecordState（先判定后动手的只读探测）", () => {
  it("四种状态：缺失 / 未封存 / 已封存 / 损坏", () => {
    const root = newRoot();
    const missing = probeRecordState(
      verificationRecordPath(root, "ver_none"),
      "verificationId",
      "ver_none",
      VerificationEventSchema,
    );
    expect(missing).toEqual({ exists: false });

    crashFixture(root, { ownerId: "probe01", verificationId: "ver_probe1" });
    expect(
      probeRecordState(
        verificationRecordPath(root, "ver_probe1"),
        "verificationId",
        "ver_probe1",
        VerificationEventSchema,
      ),
    ).toMatchObject({ exists: true, state: "unsealed", hasInterrupted: false });

    crashFixture(root, {
      ownerId: "probe02",
      verificationId: "ver_probe2",
      seal: true,
    });
    expect(
      probeRecordState(
        verificationRecordPath(root, "ver_probe2"),
        "verificationId",
        "ver_probe2",
        VerificationEventSchema,
      ),
    ).toMatchObject({ exists: true, state: "sealed" });

    crashFixture(root, {
      ownerId: "probe03",
      verificationId: "ver_probe3",
      seedInterrupted: true,
    });
    expect(
      probeRecordState(
        verificationRecordPath(root, "ver_probe3"),
        "verificationId",
        "ver_probe3",
        VerificationEventSchema,
      ),
    ).toMatchObject({ exists: true, state: "unsealed", hasInterrupted: true });

    const file = verificationRecordPath(root, "ver_probe3");
    writeFileSync(file, "not-json-line\n", "utf8");
    expect(
      probeRecordState(
        verificationRecordPath(root, "ver_probe3"),
        "verificationId",
        "ver_probe3",
        VerificationEventSchema,
      ),
    ).toMatchObject({ exists: true, state: "corrupt" });
  });
});

function listPhase(root: string, ownerId: string): string {
  const text = readFileSync(join(root, "verification-runtime", `${ownerId}.json`), "utf8");
  return (JSON.parse(text) as { phase: string }).phase;
}
