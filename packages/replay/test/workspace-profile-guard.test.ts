import type { ToolDef } from "@rebaseagent/agent-loop";
import type { WorkspaceMeta } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  checkToolProfile,
  checkWriteAuthority,
  describeWriteAuthorizationAudit,
  requireWriteAuthority,
} from "../src/index";

/**
 * 3.3：profile 一致性与"当前请求"授权校验。
 *
 * 验证点（tasks.md 3.3）：
 * - `workspace-isolation/缺授权或伪造工具定义`：缺 `allowFileWrites`，或把 `write_file` 标成 pure、
 *   删掉标记、加入自定义工具 ⇒ **执行前拒绝**，不产生运行、不调用 LLM；
 * - `workspace-isolation/历史审计标记不能授权新执行`：父 trace 含 `write_authorized:true`、
 *   或调用方伪造同名字段，本次请求缺 `allowFileWrites` ⇒ 仍拒绝；
 * - `workspace-isolation/恶意路径与未知工具` 的**未知工具部分**：自定义工具被 profile 门禁挡下。
 *
 * 本文件是纯函数级用例（门禁不依赖世界/磁盘），刻意把"拒绝"钉在**调用 LLM 之前**这一层。
 */

/** 出一份合法的固定工具表副本（后续用例在它上面做可控篡改） */
function fixedToolDefs(): ToolDef[] {
  return FILE_TOOLS_V1_DEFINITIONS.map((def) => ({ ...def }));
}

/** 篡改某个工具：按名字定位，返回新表（不改原常量） */
function mutateTool(
  defs: readonly ToolDef[],
  name: string,
  patch: (def: ToolDef) => ToolDef | Record<string, unknown>,
): ToolDef[] {
  return defs.map((def) => (def.name === name ? (patch(def) as ToolDef) : def));
}

describe("checkToolProfile：完整工具表与固定 profile 逐字段一致", () => {
  it("原样的固定工具表通过，并回报 profile 名", () => {
    const result = checkToolProfile(fixedToolDefs(), FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: true, profile: FILE_TOOLS_V1_PROFILE });
  });

  it("传 FILE_TOOLS_V1_DEFINITIONS 本身也通过（常量即契约）", () => {
    expect(checkToolProfile([...FILE_TOOLS_V1_DEFINITIONS], FILE_TOOLS_V1_PROFILE).ok).toBe(true);
  });

  it("未知 profile 被拒（不接受调用方自报一个新 profile 名）", () => {
    const result = checkToolProfile(fixedToolDefs(), "file-tools-v2");

    expect(result).toMatchObject({ ok: false, failure: { kind: "unknown_profile" } });
    expect(result.ok ? "" : result.failure.reason).toContain("未知的工具 profile");
  });
});

describe("checkToolProfile：缺授权或伪造工具定义（执行前拒绝）", () => {
  it("把 write_file 标成 pure（sideEffect:false）被拒 —— 不能改标记来放行", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => ({
      ...def,
      sideEffect: false,
    }));

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("sideEffect 不符");
  });

  it("删掉 write_file 的 sideEffect 标记被拒 —— 缺标记不等于默认值", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => {
      const { sideEffect: _drop, ...rest } = def;
      return rest;
    });

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("缺少 sideEffect 标记");
  });

  it("把 read_file 标成有副作用（sideEffect:true）同样被拒（两个方向都挡）", () => {
    const forged = mutateTool(fixedToolDefs(), READ_FILE_TOOL_NAME, (def) => ({
      ...def,
      sideEffect: true,
    }));

    expect(checkToolProfile(forged, FILE_TOOLS_V1_PROFILE)).toMatchObject({
      ok: false,
      failure: { kind: "definition_mismatch" },
    });
  });

  it("加入自定义工具（多一个）被拒，且原因点出工具数量", () => {
    const forged = [
      ...fixedToolDefs(),
      {
        name: "shell",
        description: "执行任意命令",
        parameters: { type: "object", properties: {} },
        sideEffect: true,
      },
    ];

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "tool_count_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("不接受自定义工具");
  });

  it("只给一个工具（少一个）被拒", () => {
    const [readOnly] = fixedToolDefs();

    expect(checkToolProfile([readOnly as ToolDef], FILE_TOOLS_V1_PROFILE)).toMatchObject({
      ok: false,
      failure: { kind: "tool_count_mismatch" },
    });
  });

  it("空工具表被拒（不是「没有工具所以不用校验」）", () => {
    expect(checkToolProfile([], FILE_TOOLS_V1_PROFILE)).toMatchObject({
      ok: false,
      failure: { kind: "tool_count_mismatch" },
    });
  });

  it("调换两个工具的顺序被拒 —— 顺序是 profile 的一部分", () => {
    const swapped = [...fixedToolDefs()].reverse();

    const result = checkToolProfile(swapped, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("名字不符");
  });

  it("改名字被拒（同名替换成 shell）", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => ({
      ...def,
      name: "shell",
    }));

    expect(checkToolProfile(forged, FILE_TOOLS_V1_PROFILE)).toMatchObject({
      ok: false,
      failure: { kind: "definition_mismatch" },
    });
  });

  it("改参数 schema（放宽 additionalProperties）被拒", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => ({
      ...def,
      parameters: {
        ...(def.parameters as Record<string, unknown>),
        additionalProperties: true,
      },
    }));

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("参数 schema 不符");
  });

  it("改 required（去掉 content）被拒 —— 参数 schema 是深比较", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => ({
      ...def,
      parameters: {
        ...(def.parameters as Record<string, unknown>),
        required: ["path"],
      },
    }));

    expect(checkToolProfile(forged, FILE_TOOLS_V1_PROFILE)).toMatchObject({
      ok: false,
      failure: { kind: "definition_mismatch" },
    });
  });

  it("改描述被拒（描述也进 profile 指纹）", () => {
    const forged = mutateTool(fixedToolDefs(), READ_FILE_TOOL_NAME, (def) => ({
      ...def,
      description: "读取任意宿主文件",
    }));

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    expect(result.ok ? "" : result.failure.reason).toContain("描述不符");
  });

  it("sideEffect 显式写成 undefined 也算不符（存在性按自有属性判，不看 truthiness）", () => {
    const forged = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => ({
      ...def,
      sideEffect: undefined,
    }));

    const result = checkToolProfile(forged, FILE_TOOLS_V1_PROFILE);

    expect(result).toMatchObject({ ok: false, failure: { kind: "definition_mismatch" } });
    // undefined 值下报的是「不符」而不是「缺少」——两种都由存在性判定兜住
    expect(result.ok ? "" : result.failure.reason).toMatch(/sideEffect 不符|缺少 sideEffect 标记/);
  });

  it("只重排 parameters 里的键不构成差异（键序无关，内容才有关）", () => {
    const reordered = mutateTool(fixedToolDefs(), WRITE_FILE_TOOL_NAME, (def) => {
      const params = def.parameters as Record<string, unknown>;
      return {
        ...def,
        parameters: {
          additionalProperties: params.additionalProperties,
          required: params.required,
          properties: params.properties,
          type: params.type,
        },
      };
    });

    expect(checkToolProfile(reordered, FILE_TOOLS_V1_PROFILE).ok).toBe(true);
  });
});

describe("checkWriteAuthority：授权只由当前请求提供", () => {
  it("显式 allowFileWrites:true 通过", () => {
    const result = checkWriteAuthority({ allowFileWrites: true });

    expect(result).toMatchObject({ ok: true, authority: { allowFileWrites: true } });
  });

  it("allowFileWrites:false 被拒", () => {
    const result = checkWriteAuthority({ allowFileWrites: false });

    expect(result).toMatchObject({ ok: false, failure: { kind: "missing_authority" } });
    expect(result.ok ? "" : result.failure.reason).toContain("未显式允许副本写入");
  });

  it("缺少 allowFileWrites 键被拒", () => {
    expect(checkWriteAuthority({ task: "跑一下" })).toMatchObject({
      ok: false,
      failure: { kind: "missing_authority" },
    });
  });

  it('宽松取值都不算授权：字符串 "true" / 数字 1 / 空对象', () => {
    for (const bad of [
      { allowFileWrites: "true" },
      { allowFileWrites: 1 },
      { allowFileWrites: {} },
    ]) {
      expect(checkWriteAuthority(bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        failure: { kind: "missing_authority" },
      });
    }
  });

  it("非对象输入（null / 数组 / undefined）一律拒绝，不抛错", () => {
    for (const bad of [null, undefined, ["allowFileWrites"], "allowFileWrites"]) {
      expect(checkWriteAuthority(bad)).toMatchObject({
        ok: false,
        failure: { kind: "missing_authority" },
      });
    }
  });

  it("拒绝原因点明「历史审计标注不能替代本次授权」", () => {
    const result = checkWriteAuthority({ allowFileWrites: false });
    expect(result.ok ? "" : result.failure.reason).toContain("历史审计标注不能替代本次授权");
  });

  it("requireWriteAuthority 与 checkWriteAuthority 同语义（编排层入口）", () => {
    expect(requireWriteAuthority({ allowFileWrites: true })).toEqual(
      checkWriteAuthority({ allowFileWrites: true }),
    );
    expect(requireWriteAuthority({}).ok).toBe(false);
  });
});

describe("历史审计标记不能授权新执行", () => {
  /** 一份带 write_authorized:true 的父 meta（schema 里是恒真字面量） */
  const parentMetaWithAudit: WorkspaceMeta = {
    profile: FILE_TOOLS_V1_PROFILE,
    world_id: "run_parent",
    write_authorized: true,
    initial_snapshot: { id: "0".repeat(64), files: [] },
    origin: { kind: "import" },
  };

  it("父 meta 带 write_authorized:true，但本次请求缺 allowFileWrites ⇒ 仍拒绝", () => {
    // 审计标注只被当作**文本**读出来，用于展示/记录
    expect(describeWriteAuthorizationAudit(parentMetaWithAudit)).toContain("审计标注");

    // 就算把它整个塞进请求，也不构成授权（字段名不匹配 ⇒ 走 "缺少 allowFileWrites"）
    const result = checkWriteAuthority(parentMetaWithAudit);
    expect(result).toMatchObject({ ok: false, failure: { kind: "missing_authority" } });
  });

  it("调用方伪造同名字段（{ write_authorized: true }）也不能授权", () => {
    const forged = { write_authorized: true, world_id: "run_parent" };

    expect(checkWriteAuthority(forged)).toMatchObject({
      ok: false,
      failure: { kind: "missing_authority" },
    });
  });

  it("把审计标注与 allowFileWrites:false 一起传，仍是拒绝（不因存在标注而补齐）", () => {
    const result = checkWriteAuthority({ write_authorized: true, allowFileWrites: false });

    expect(result).toMatchObject({ ok: false, failure: { kind: "missing_authority" } });
  });

  it("describeWriteAuthorizationAudit 返回的是文本/空值，不是可当授权用的对象", () => {
    expect(typeof describeWriteAuthorizationAudit(parentMetaWithAudit)).toBe("string");
    // 普通 v1 run（无 workspace 段）⇒ 无审计信息
    expect(describeWriteAuthorizationAudit(undefined)).toBeNull();
  });

  it("审计文本明确写着「不代表本次已授权」", () => {
    expect(describeWriteAuthorizationAudit(parentMetaWithAudit)).toContain("不代表本次已授权");
  });
});
