import { describe, expect, it } from "vitest";
import { parseRunText } from "../src/reader";
import { findVersionFieldViolation } from "../src/version-guard";
import { sampleRequest, sampleResponse } from "./helpers";

/**
 * v1/v2 版本 ↔ 隔离字段一致性（change `add-sandboxed-rerun` 阶段 1）。
 *
 * 核心动机：zod object 默认**剥离**未知键。若不在 schema parse 前显式拒绝，
 * "v1 文件私带 workspace" 会被静默丢掉、读成合法 v1，旧路径随后可能对同名
 * `write_file` 用普通 handler 降级执行——这正是 v2 版本门禁要防的事故。
 */

/** 一份最小合法 v1 meta 原始对象（可覆盖/追加字段） */
function v1Meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run.meta",
    id: "r_01",
    format_version: 1,
    task: "t",
    model: "m",
    created_at: "2026-09-16T00:00:00Z",
    parent: null,
    fork: null,
    config_hash: "sha256:abc",
    ...over,
  };
}

/** 一份最小合法 v2 meta 原始对象 */
function v2Meta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return v1Meta({
    format_version: 2,
    workspace: {
      profile: "file-tools-v1",
      world_id: "r_01",
      write_authorized: true,
      initial_snapshot: { id: "a".repeat(64), files: [] },
      origin: { kind: "import" },
    },
    ...over,
  });
}

const lines = (...objects: Record<string, unknown>[]): string[] =>
  objects.map((o) => JSON.stringify(o));

describe("findVersionFieldViolation：v1 禁字段（存在性判定，非 truthiness）", () => {
  it.each([
    ["workspace 为对象", { workspace: { profile: "file-tools-v1" } }],
    ["workspace 为 null", { workspace: null }],
    ["workspace 为空对象", { workspace: {} }],
    ["workspace 为 false", { workspace: false }],
  ])("v1 meta 携带 %s ⇒ 拒绝", (_label, extra) => {
    expect(findVersionFieldViolation(v1Meta(extra), null)).toContain("workspace");
  });

  it.each([
    ["对象形态", { at_span: "s_02", resume_after_step: "s_01", edit: {} }],
    ["值为 null", { at_span: "s_02", resume_after_step: null, edit: {} }],
  ])("v1 meta 的 fork 携带 resume_after_step（%s）⇒ 拒绝", (_label, fork) => {
    expect(findVersionFieldViolation(v1Meta({ fork }), null)).toContain("resume_after_step");
  });

  it("v1 span 携带 workspace_snapshot ⇒ 拒绝（版本从文件传参，不在 span 行上）", () => {
    const span = {
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
      workspace_snapshot: null,
    };
    expect(findVersionFieldViolation(span, 1)).toContain("workspace_snapshot");
  });

  it("v1 不带隔离字段 ⇒ 放行", () => {
    expect(findVersionFieldViolation(v1Meta(), null)).toBeNull();
    expect(
      findVersionFieldViolation(
        { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 },
        1,
      ),
    ).toBeNull();
  });
});

describe("findVersionFieldViolation：v2 契约与无关扩展字段", () => {
  it("v2 meta 缺 workspace ⇒ 拒绝", () => {
    expect(findVersionFieldViolation(v1Meta({ format_version: 2 }), null)).toContain("workspace");
  });

  it("v2 meta 带 workspace ⇒ 放行；v2 span 无需检查快照存在性（由 reader 跨行判定）", () => {
    expect(findVersionFieldViolation(v2Meta(), null)).toBeNull();
    expect(
      findVersionFieldViolation(
        { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 },
        2,
      ),
    ).toBeNull();
  });

  it("v1 携带**无关**扩展字段仍放行（禁字段检查只针对隔离字段，不泛化 strict）", () => {
    const raw = v1Meta({ future_field: { anything: 1 }, custom: null });
    expect(findVersionFieldViolation(raw, null)).toBeNull();
    // 且 reader 仍能正常读完（旧数据的向后兼容不被破坏）
    const record = parseRunText(
      lines(raw, { type: "run.event", event: "stopped", reason: "completed", at: 1 }),
    );
    expect(record.meta.id).toBe("r_01");
    expect(record.status).toBe("completed");
  });
});

describe("parseRunText：版本门禁与 v1/v2 往返", () => {
  it("v1 文件私带 workspace ⇒ 读取报错（不被 zod 静默剥离后当成合法 v1）", () => {
    expect(() => parseRunText(lines(v1Meta({ workspace: { profile: "file-tools-v1" } })))).toThrow(
      /v1 禁止携带 workspace/,
    );
  });

  it("v1 文件的 span 私带 workspace_snapshot ⇒ 读取报错", () => {
    const span = {
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
      workspace_snapshot: { id: "a".repeat(64), files: [] },
    };
    expect(() => parseRunText(lines(v1Meta(), span))).toThrow(/workspace_snapshot/);
  });

  it("未来版本 3 ⇒ 读取报「不支持的格式版本」，且不被禁字段检查抢先", () => {
    expect(() => parseRunText(lines(v1Meta({ format_version: 3 })))).toThrow(/不支持的格式版本 3/);
  });

  it("v2 隔离文件可读：meta.workspace 与 step.workspace_snapshot 往返保留", () => {
    const snapshot = {
      id: "b".repeat(64),
      files: [{ path: "a.txt", sha256: "c".repeat(64), bytes: 6 }],
    };
    const record = parseRunText(
      lines(
        v2Meta({ workspace: { ...(v2Meta().workspace as object), initial_snapshot: snapshot } }),
        {
          type: "span",
          id: "s_01",
          kind: "agent.step",
          parent: null,
          n: 1,
          workspace_snapshot: snapshot,
        },
        { type: "run.event", event: "stopped", reason: "completed", at: 1 },
      ),
    );
    expect(record.meta.format_version).toBe(2);
    expect(record.meta.workspace?.initial_snapshot.files).toHaveLength(1);
    const step = record.spans.find((s) => s.kind === "agent.step");
    expect(step?.kind === "agent.step" ? step.workspace_snapshot?.id : null).toBe(snapshot.id);
  });

  it("v1 正常文件仍照旧（回归）：无隔离字段、状态与 span 解析不变", () => {
    const record = parseRunText(
      lines(
        v1Meta(),
        { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 },
        {
          type: "span",
          id: "s_02",
          kind: "llm.call",
          parent: "s_01",
          request: sampleRequest(),
          response: sampleResponse(),
        },
        { type: "run.event", event: "stopped", reason: "completed", at: 1 },
      ),
    );
    expect(record.meta.format_version).toBe(1);
    expect(record.meta.workspace).toBeUndefined();
    expect(record.spans).toHaveLength(2);
    expect(record.status).toBe("completed");
  });
});
