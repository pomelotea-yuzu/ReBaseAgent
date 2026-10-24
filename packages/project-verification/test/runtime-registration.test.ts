import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeRegistrationPath } from "../src/records/layout.js";
import {
  type RuntimeContainerCreatePort,
  RuntimeCreateStaleNameError,
  RuntimeCreateUnknownError,
  createRegisteredContainer,
} from "../src/runtime/create.js";
import type { RuntimeResourceFacts } from "../src/runtime/reconcile.js";
import {
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  RegistrationIoError,
  bindCreatedContainer,
  deriveContainerName,
  listResourceRegistrations,
  markResourceRemoved,
  newResourceOwnerId,
  readResourceRegistration,
  registerResourceBeforeCreate,
} from "../src/runtime/registration.js";

const ROOT = "D:\\data\\r3-root";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "r3-pv-reg-"));
}

describe("确定性名称与 owner 归属（3.7）", () => {
  it("newResourceOwnerId 满足记录 ID 约束且唯一", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const id = newResourceOwnerId();
      expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("deriveContainerName 按 kind 确定性派生；穿越/大写 ID 在入口即拒", () => {
    expect(deriveContainerName("verification", "abc-123")).toBe("r3-verify-abc-123");
    expect(deriveContainerName("prepare", "abc-123")).toBe("r3-prepare-abc-123");
    expect(() => deriveContainerName("verification", "../evil")).toThrow(RegistrationIoError);
    expect(() => deriveContainerName("verification", "UPPER")).toThrow(RegistrationIoError);
  });

  it("owner 标签常量与 §1.6 探针口径一致", () => {
    expect(OWNER_LABEL_KEY).toBe("rebaseagent.owner");
    expect(OWNER_LABEL_VALUE).toBe("rebaseagent-r3");
  });
});

describe("登记生命周期：创建前落盘 → 绑定 ID → 收尾（P22 登记面）", () => {
  it("registerResourceBeforeCreate 先于容器持久化名称/归属（phase=registered）", () => {
    const root = newRoot();
    const entry = registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-new",
      dataRoot: ROOT,
      verificationId: "ver_1",
      resourceOwnerId: "abcdef01",
    });
    expect(entry.phase).toBe("registered");
    expect(entry.containerName).toBe("r3-verify-abcdef01");
    expect(entry.ownerLabel).toBe("rebaseagent-r3");
    expect(entry.knownContainerIds).toEqual([]);
    expect(entry.verificationId).toBe("ver_1");
    expect(entry.preparationId).toBeNull();
    // 落盘可读回且与派生一致
    const reread = readResourceRegistration(root, "abcdef01");
    expect(reread).toEqual(entry);
    expect(existsSync(runtimeRegistrationPath(root, "abcdef01"))).toBe(true);
  });

  it("同 resourceOwnerId 重复登记拒绝（ID 唯一，不覆盖旧登记）", () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-1",
      dataRoot: ROOT,
      resourceOwnerId: "same-id-1",
    });
    expect(() =>
      registerResourceBeforeCreate(root, {
        kind: "verification",
        epoch: "ep-2",
        dataRoot: ROOT,
        resourceOwnerId: "same-id-1",
      }),
    ).toThrow(RegistrationIoError);
  });

  it("bindCreatedContainer 绑定实际容器 ID（phase=created）；非法 ID 形态拒绝；重复绑定不叠加", () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-1",
      dataRoot: ROOT,
      resourceOwnerId: "bind-id-1",
    });
    const id64 = `${"a".repeat(63)}b`;
    const bound = bindCreatedContainer(root, "bind-id-1", id64);
    expect(bound.phase).toBe("created");
    expect(bound.knownContainerIds).toEqual([id64]);
    const rebound = bindCreatedContainer(root, "bind-id-1", id64);
    expect(rebound.knownContainerIds).toEqual([id64]);
    expect(() => bindCreatedContainer(root, "bind-id-1", "not-an-id")).toThrow(RegistrationIoError);
  });

  it("markResourceRemoved 收尾为 removed，容器 ID 历史保留", () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "prepare",
      epoch: "ep-1",
      dataRoot: ROOT,
      preparationId: "prep_1",
      resourceOwnerId: "rm-id-1",
    });
    bindCreatedContainer(root, "rm-id-1", `${"c".repeat(64)}`);
    const closed = markResourceRemoved(root, "rm-id-1");
    expect(closed.phase).toBe("removed");
    expect(closed.knownContainerIds).toEqual(["c".repeat(64)]);
  });
});

describe("登记损坏门（P23「恢复记录损坏」的登记面）", () => {
  it("垃圾 JSON / 形状不合法 / 文件名身份错配 ⇒ REGISTRATION_CORRUPT", () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-1",
      dataRoot: ROOT,
      resourceOwnerId: "corrupt-1",
    });
    const file = runtimeRegistrationPath(root, "corrupt-1");
    writeFileSync(file, "{not json", "utf8");
    expect(() => readResourceRegistration(root, "corrupt-1")).toThrow(/REGISTRATION_CORRUPT/);

    writeFileSync(file, JSON.stringify({ garbage: true }), "utf8");
    expect(() => readResourceRegistration(root, "corrupt-1")).toThrow(RegistrationIoError);

    // 身份错配：内容合法但 resourceOwnerId 与文件名不一致
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-1",
      dataRoot: ROOT,
      resourceOwnerId: "corrupt-2",
    });
    const mismatch = JSON.parse(readFileSync(runtimeRegistrationPath(root, "corrupt-2"), "utf8"));
    mismatch.resourceOwnerId = "corrupt-3";
    writeFileSync(runtimeRegistrationPath(root, "corrupt-2"), JSON.stringify(mismatch), "utf8");
    expect(() => readResourceRegistration(root, "corrupt-2")).toThrow(/身份错配/);
  });

  it("listResourceRegistrations 任一损坏即抛错（不跳过继续，P23 fail-closed）", () => {
    const root = newRoot();
    registerResourceBeforeCreate(root, {
      kind: "verification",
      epoch: "ep-1",
      dataRoot: ROOT,
      resourceOwnerId: "list-ok-1",
    });
    expect(listResourceRegistrations(root)).toHaveLength(1);
    mkdirSync(join(root, "verification-runtime"), { recursive: true });
    writeFileSync(runtimeRegistrationPath(root, "list-bad-2"), "]}garbage{[", "utf8");
    expect(() => listResourceRegistrations(root)).toThrow(/REGISTRATION_CORRUPT/);
  });

  it("缺失文件读取 ⇒ IO_FAILED；空目录列表为空", () => {
    const root = newRoot();
    expect(listResourceRegistrations(root)).toEqual([]);
    expect(() => readResourceRegistration(root, "nope-1")).toThrow(RegistrationIoError);
  });
});

/** 创建端口 fake：脚本化 create 行为与按名探查。 */
class ScriptedCreatePort implements RuntimeContainerCreatePort {
  createCalls: { name: string; labels: Readonly<Record<string, string>> }[] = [];
  constructor(
    private readonly createBehavior: "ok" | "stale" | "failed" | "unknown",
    private readonly resolvedByName: RuntimeResourceFacts | null,
    private readonly resolveThrows = false,
  ) {}
  async createContainer(request: {
    name: string;
    labels: Readonly<Record<string, string>>;
    imageRef: string;
    runFlags: readonly string[];
    command: readonly string[];
  }): Promise<{ containerId: string }> {
    this.createCalls.push({ name: request.name, labels: request.labels });
    if (this.createBehavior === "stale") {
      throw new RuntimeCreateStaleNameError("already in use");
    }
    if (this.createBehavior === "failed") {
      throw new Error("docker create 非零退出（daemon 拒绝）");
    }
    if (this.createBehavior === "unknown") {
      throw new RuntimeCreateUnknownError("create 超时（响应丢失）");
    }
    return { containerId: "d".repeat(64) };
  }
  async resolveContainerByName(): Promise<RuntimeResourceFacts | null> {
    if (this.resolveThrows) {
      throw new Error("探查超时");
    }
    return this.resolvedByName;
  }
}

const FACTS = (name: string, id: string): RuntimeResourceFacts => ({
  containerId: id,
  name,
  state: "created",
  labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE },
});

describe("createRegisteredContainer：登记先于 create、响应丢失按名消解（P22）", () => {
  const request = {
    kind: "verification" as const,
    epoch: "ep-1",
    dataRoot: ROOT,
    verificationId: "ver_c1",
  };

  it("成功路径：register → create → bind（phase=created + 已知 ID）", async () => {
    const root = newRoot();
    const port = new ScriptedCreatePort("ok", null);
    const outcome = await createRegisteredContainer({
      root,
      port,
      request,
      imageRef: "r3/node-ts-v1:v3",
      runFlags: ["--network", "none"],
      command: ["/bin/sh", "/opt/r3/supervisor.sh"],
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.containerId).toBe("d".repeat(64));
      expect(outcome.registration.phase).toBe("created");
      expect(outcome.registration.knownContainerIds).toEqual(["d".repeat(64)]);
    }
    // create 收到的名字/标签来自登记（确定性名称 + owner 标签）
    expect(port.createCalls[0]?.name).toMatch(/^r3-verify-/);
    expect(port.createCalls[0]?.labels[OWNER_LABEL_KEY]).toBe("rebaseagent-r3");
  });

  it("同名残留（stale-name）拒绝创建；登记已落盘待核查", async () => {
    const root = newRoot();
    const outcome = await createRegisteredContainer({
      root,
      port: new ScriptedCreatePort("stale", null),
      request: { ...request, verificationId: "ver_c2" },
      imageRef: "img",
      runFlags: [],
      command: [],
    });
    expect(outcome).toMatchObject({ ok: false, kind: "stale-name" });
  });

  it("明确失败（请求未到达引擎）⇒ failed；登记保持 registered", async () => {
    const root = newRoot();
    const outcome = await createRegisteredContainer({
      root,
      port: new ScriptedCreatePort("failed", null),
      request: { ...request, verificationId: "ver_c3" },
      imageRef: "img",
      runFlags: [],
      command: [],
    });
    expect(outcome).toMatchObject({ ok: false, kind: "failed" });
  });

  it("响应丢失 + 按名发现 ⇒ 绑定实际 ID（窗口关闭，P22 核心切片）", async () => {
    const root = newRoot();
    const port = new ScriptedCreatePort("unknown", FACTS("r3-verify-resp-1", "e".repeat(64)));
    // 资源 ID 固定以对齐按名探查结果（真实路径中名字由派生决定）
    const outcome = await createRegisteredContainer({
      root,
      port,
      request: { ...request, verificationId: "ver_c4", resourceOwnerId: "resp-1" },
      imageRef: "img",
      runFlags: [],
      command: [],
    });
    expect(outcome).toMatchObject({ ok: true, containerId: "e".repeat(64) });
    const entry = readResourceRegistration(root, "resp-1");
    expect(entry.phase).toBe("created");
    expect(entry.knownContainerIds).toEqual(["e".repeat(64)]);
  });

  it("响应丢失 + 按名明确不存在 ⇒ 判定未创建（failed）；登记保持 registered 等核查", async () => {
    const root = newRoot();
    const outcome = await createRegisteredContainer({
      root,
      port: new ScriptedCreatePort("unknown", null),
      request: { ...request, verificationId: "ver_c5", resourceOwnerId: "resp-2" },
      imageRef: "img",
      runFlags: [],
      command: [],
    });
    expect(outcome).toMatchObject({ ok: false, kind: "failed" });
    expect(readResourceRegistration(root, "resp-2").phase).toBe("registered");
  });

  it("响应丢失 + 探查也不可判 ⇒ unknown（不乐观宣布）；登记保持 registered", async () => {
    const root = newRoot();
    const outcome = await createRegisteredContainer({
      root,
      port: new ScriptedCreatePort("unknown", null, true),
      request: { ...request, verificationId: "ver_c6", resourceOwnerId: "resp-3" },
      imageRef: "img",
      runFlags: [],
      command: [],
    });
    expect(outcome).toMatchObject({ ok: false, kind: "unknown" });
    expect(readResourceRegistration(root, "resp-3").phase).toBe("registered");
  });
});
