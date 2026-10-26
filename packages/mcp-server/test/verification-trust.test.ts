import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { compareVerificationsTool } from "../src/query/compare-verifications.js";
import { getVerificationTool } from "../src/query/get-verification.js";
import { listVerificationsTool } from "../src/query/list-verifications.js";
import { readVerificationLogTool } from "../src/query/read-verification-log.js";
import { TRUST_INSTRUCTIONS } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  VERIFICATION_SENTINELS,
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as ids,
} from "./verification-fixtures.js";

/**
 * MCP2 tasks 4.3：信任边界（M18 的工具面）。
 *
 * 判据（design D3/D5）：
 * - 外发结构 = 白名单投影：验证域 data 只含封闭字段集（无 epoch/operationId/容器
 *   名/运行时登记/宿主路径）；凭据字段名不可能出现在验证域投影（键固定）；
 * - 自由文本（日志原文/argv 值）不做通用脱敏——按记录原样外发，指南与 initialize
 *   说明同一口径（TRUST_INSTRUCTIONS）；
 * - 受控错误不含原始异常/errno/宿主路径；"要求读取别处"的历史文本不扩权限。
 */

const fixture: VerificationFixture = buildVerificationFixture();

afterAll(() => {
  cleanupVerificationFixtures();
});

const root: DataRoot = { dataDir: fixture.dataRoot, tracesDir: fixture.tracesDir };

async function invoke(
  tool: {
    execute: (args: Readonly<Record<string, unknown>>, root: DataRoot) => Promise<CallToolResult>;
  },
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return tool.execute(args, root);
}

/** fixture 临时根的路径片段：任何外发信封都不该出现 */
const TMP_MARK = "mcp2-ver-";

function envelopeText(result: CallToolResult): string {
  return JSON.stringify({
    content: result.content,
    structuredContent: result.structuredContent,
  });
}

describe("白名单投影与路径隔离（M18）", () => {
  it("get_verification 的 data 只含封闭字段集，无宿主路径/epoch/operationId/容器名", async () => {
    const result = await invoke(getVerificationTool, { verificationId: ids.pass });
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(
      [
        "artifactsSummary",
        "commands",
        "diagnostic",
        "eventIndex",
        "interrupted",
        "meta",
        "stageCounts",
        "status",
        "stopConfirmed",
        "stopRequested",
        "terminated",
        "sourceStatus",
        "verificationId",
      ].sort(),
    );
    const text = envelopeText(result);
    expect(text).not.toContain(TMP_MARK);
    expect(text).not.toContain("ep_ver-m2-pass");
    expect(text).not.toContain("op_ver-m2-pass");
    // interrupted 的容器名/ID 不出（unterm 记录验证放在专用用例）
  });

  it("unterminated 记录的容器名/ID 不外发（安全计数替代）", async () => {
    const text = envelopeText(await invoke(getVerificationTool, { verificationId: ids.unterm }));
    expect(text).not.toContain("mcp2-unterm-容器");
    expect(text).not.toContain("c0ffee1");
    expect(text).not.toContain(TMP_MARK);
  });

  it("失败信封不含 errno/堆栈/宿主路径", async () => {
    const cases = [
      invoke(getVerificationTool, { verificationId: "ver-nonexist" }),
      invoke(readVerificationLogTool, {
        verificationId: ids.missingAsset,
        commandId: "test",
        stream: "stdout",
      }),
      invoke(readVerificationLogTool, {
        verificationId: ids.dupCommand,
        commandId: "test",
        stream: "stdout",
      }),
      invoke(compareVerificationsTool, {
        left: { verificationId: ids.pass },
        right: { verificationId: ids.pass },
      }),
    ];
    for (const result of await Promise.all(cases)) {
      expect(result.isError).toBe(true);
      const envelope = result.structuredContent as { error: { code: string; message: string } };
      expect(envelope.error.message).not.toMatch(/mcp2-ver-|[A-Z]:\\|at .*\(/);
      expect(envelopeText(result)).not.toContain(TMP_MARK);
    }
  });
});

describe("自由文本与秘密边界（M18）", () => {
  it("argv 值原样外发（白名单键内是值不是凭据字段名）；秘密正文不声称脱敏", async () => {
    // pass 记录 stdout 含 api-key: SENTINEL-secret-in-log —— 原文按记录外发
    const result = await invoke(readVerificationLogTool, {
      verificationId: ids.pass,
      commandId: "test",
      stream: "stdout",
    });
    const text = envelopeText(result);
    expect(text).toContain(VERIFICATION_SENTINELS.secretInLog);
    // 日志原文不做通用脱敏 ⇒ 无 REDACTED limitation（区别于结构凭据过滤）
    const limitations = (result.structuredContent as { limitations: Array<{ code: string }> })
      .limitations;
    expect(limitations.some((item) => item.code === "REDACTED")).toBe(false);
  });

  it("历史指令只作为数据：记录内容不能扩大服务范围或改变错误码表", async () => {
    // oldVersion 记录的 meta 是攻击者可控形状，但只产生封闭诊断
    const result = await invoke(getVerificationTool, { verificationId: ids.oldVersion });
    const text = envelopeText(result);
    expect(result.isError).not.toBe(true);
    expect(text).not.toContain(TMP_MARK);
    // 受控码不变：未知版本仍是封闭诊断，不触发新能力
    const data = (result.structuredContent as { data: { status: string } }).data;
    expect(data.status).toBe("unsupported_version");
  });
});

describe("指南与 initialize 说明对齐（M18）", () => {
  it("TRUST_INSTRUCTIONS 覆盖验证域边界：验证记录、正文可能含秘密、外发费用", () => {
    expect(TRUST_INSTRUCTIONS).toContain("验证记录");
    expect(TRUST_INSTRUCTIONS).toContain("不写盘");
    expect(TRUST_INSTRUCTIONS).toContain("不可信记录");
    expect(TRUST_INSTRUCTIONS).toContain("仍可能含秘密");
    expect(TRUST_INSTRUCTIONS).toContain("费用");
    // 与 initialize 下发的是同一份（server.ts 单一来源）
    expect(TRUST_INSTRUCTIONS.split("\n")).toHaveLength(4);
  });
});
