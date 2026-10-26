import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INITIALIZED_FRAME,
  StdioSession,
  callFrame,
  cancelFrame,
  envelopeOf,
  errorOf,
  initFrame,
  okData,
  requestFrame,
  resultOf,
  treeListing,
} from "./stdio-harness.js";
import {
  VERIFICATION_SENTINELS,
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 5.1：真实 Node stdio 子进程里的六工具全链（M01–M18 适用项的线务面）。
 *
 * 服务 = `node dist/cli.js --data-dir <根>`：真初始化协商、真 tools/list（十三）、
 * 真 tools/call 帧往返。判据：
 * - 十三工具发现；六工具在真实子进程里调通且信封合规；
 * - 错误路径出**业务失败帧**（isError + 稳定码），不是协议错误；
 * - 台账变化使续读 STALE_CURSOR（跨进程帧往返）；
 * - 同批取消：不起跑读取（stderr 无 tool_call，无响应帧）；
 * - EOF 落定、stdout 无半帧；
 * - 数据根目录树前后逐字相同（字节级指纹在 5.3/6.3 实机取证）。
 */

describe("六工具真实 stdio 全链（tasks 5.1）", () => {
  let fixture: VerificationFixture;
  let session: StdioSession;
  let treeBefore: string[];
  let nextId = 100;

  beforeAll(async () => {
    fixture = buildVerificationFixture();
    treeBefore = treeListing(fixture.dataRoot);
    session = await StdioSession.start(fixture.dataRoot);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME, requestFrame(2, "tools/list")]);
    await session.waitForFrame(1);
    await session.waitForFrame(2);
  }, 40_000);

  afterAll(async () => {
    await session?.dispose();
    cleanupVerificationFixtures();
  });

  function call(name: string, args: Record<string, unknown>) {
    const id = nextId++;
    session.writeFrames([callFrame(id, name, args)]);
    return session.waitForFrame(id);
  }

  it("tools/list 恰十三工具，六工具在列", () => {
    const frame = session.frameFor(2);
    const tools = (resultOf(frame).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(tools).toHaveLength(13);
    for (const name of [
      "list_verifications",
      "get_verification",
      "read_verification_log",
      "inspect_verification_artifacts",
      "read_verification_artifact",
      "compare_verifications",
    ]) {
      expect(tools).toContain(name);
    }
    expect(session.unparsedStdout()).toEqual([]);
  });

  it("list_verifications：真实子进程返回摘要与 verifications provenance（M01/M02）", async () => {
    const frame = await call("list_verifications", { runId: "run-m2-pass" });
    const { data, envelope } = okData<{ items: Array<Record<string, unknown>> }>(frame);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ verificationId: ids.pass, status: "sealed" });
    expect(envelope.provenance.runs).toEqual([]);
    expect(
      (envelope.provenance as { verifications?: Array<Record<string, unknown>> }).verifications,
    ).toHaveLength(1);
  });

  it("get_verification：摘要/命令/环境/事件索引在真实帧里合规（M04/M05）", async () => {
    const frame = await call("get_verification", { verificationId: ids.pass });
    const { data } = okData<{
      status: string;
      terminated: { outcome: string } | null;
      commands: Array<Record<string, unknown>>;
      eventIndex: { total: number };
    }>(frame);
    expect(data.status).toBe("sealed");
    expect(data.terminated?.outcome).toBe("passed");
    expect(data.commands).toHaveLength(1);
    expect(data.eventIndex.total).toBeGreaterThan(0);
  });

  it("read_verification_log：正文经 content 单次承载（M10/M11）", async () => {
    const frame = await call("read_verification_log", {
      verificationId: ids.pass,
      commandId: "test",
      stream: "stdout",
    });
    const result = resultOf(frame);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain(VERIFICATION_SENTINELS.passStdout);
    const { data } = okData<{ body: { kind: string; bodyIn: string } }>(frame);
    expect(data.body).toMatchObject({ kind: "text", bodyIn: "content" });
  });

  it("inspect + read artifact：清单与产物正文在真实帧里合规（M09/M11）", async () => {
    const inspect = await call("inspect_verification_artifacts", { verificationId: ids.pass });
    const inspectData = okData<{ totals: { entries: number } }>(inspect).data;
    expect(inspectData.totals.entries).toBe(2);

    const read = await call("read_verification_artifact", {
      verificationId: ids.pass,
      path: "report.json",
    });
    const text = (resultOf(read).content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain(VERIFICATION_SENTINELS.artifactText);
  });

  it("compare_verifications：同条件失败→通过在真实帧里成立（M14）", async () => {
    const frame = await call("compare_verifications", {
      left: { verificationId: ids.fail },
      right: { verificationId: ids.pass },
    });
    const { data } = okData<{ verdict: { kind: string }; conditions: Array<{ state: string }> }>(
      frame,
    );
    expect(data.verdict.kind).toBe("failed-to-passed");
    expect(data.conditions.every((condition) => condition.state === "same")).toBe(true);
  });

  it("错误路径出业务失败帧：VERIFICATION_NOT_FOUND（M03）", async () => {
    const frame = await call("get_verification", { verificationId: "ver-nonexist" });
    const error = errorOf(frame);
    expect(error.code).toBe("VERIFICATION_NOT_FOUND");
    expect(error.retryable).toBe(false);
    expect(session.unparsedStdout()).toEqual([]);
  });

  it("台账变化使续读游标 STALE_CURSOR（M12 跨进程）", async () => {
    const page1 = await call("list_verifications", { limit: 3 });
    const nextCursor = envelopeOf(page1).page?.nextCursor;
    expect(nextCursor).toBeDefined();
    // 测试进程直接改数据根：候选集合变化
    const { VerificationRecordWriter } = await import("@rebaseagent/project-verification");
    const w = VerificationRecordWriter.open(fixture.dataRoot, {
      verificationId: "ver-m2-stdio",
      epoch: "ep_stdio",
      operationId: "op_stdio",
      target: { runId: "run-stdio", checkpoint: { kind: "initial" }, snapshotId: "snap-stdio" },
      profileId: "node-ts-v1",
      manifestVersion: 1,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T03:00:00.000Z",
    });
    w.terminate({ outcome: "passed", detail: "d", evidenceComplete: true, at: "t" });
    // 测试自己改的数据根也算"基线"：后续零写入判据以此为起点
    treeBefore = treeListing(fixture.dataRoot);
    const page2 = await call("list_verifications", { limit: 3, cursor: nextCursor ?? "" });
    expect(errorOf(page2).code).toBe("STALE_CURSOR");
  });

  it("同批取消：不起跑读取（stderr 无新 tool_call、无响应帧），验证状态不受影响（M17）", async () => {
    const treeBeforeCancel = treeListing(fixture.dataRoot);
    const toolCallsBefore = session.stderrFor("tool_call").length;
    const cancelId = nextId++;
    // 同一次 write：请求 + 针对它的取消 ⇒ handler 起跑前已见 aborted
    session.writeFrames([
      callFrame(cancelId, "get_verification", { verificationId: ids.pass }),
      cancelFrame(cancelId),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 无响应帧
    expect(session.framesFor(cancelId)).toEqual([]);
    // 读取没起跑：stderr 有 tool_cancelled、没有新增 tool_call
    expect(session.stderrFor("tool_cancelled").length).toBeGreaterThan(0);
    expect(session.stderrFor("tool_call").length).toBe(toolCallsBefore);
    // 数据根未动
    expect(treeListing(fixture.dataRoot)).toEqual(treeBeforeCancel);
  });

  it("EOF 落定：stdin 关闭后进程退出、stdout 无半帧", async () => {
    const exit = await session.end();
    expect(exit.stdout).not.toContain("tool_call");
    expect(session.unparsedStdout()).toEqual([]);
    // 数据根目录树与开局逐字相同（零写入）
    expect(treeListing(fixture.dataRoot)).toEqual(treeBefore);
  });
});

describe("5.1 边界注记", () => {
  it("fixture 根满足启动契约（traces/ 在场）", () => {
    const fixture = buildVerificationFixture();
    expect(treeListing(fixture.dataRoot)).toContain("/traces");
    cleanupVerificationFixtures();
  });
});
