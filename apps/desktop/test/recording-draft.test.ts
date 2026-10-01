import { describe, expect, it } from "vitest";
import {
  applyRecordingBaseline,
  discardRecordingDraft,
  ensureRecordingDraft,
  isRecordingDraftDirty,
  recordingApplyRequest,
  recordingPortError,
  recordingUpstreamError,
  writeRecordingDraft,
  type RecordingBaseline,
  type RecordingDraft,
} from "../src/renderer/src/lib/recording-draft";

const baseline: RecordingBaseline = {
  enabled: false,
  port: 18787,
  upstreamBaseUrl: "https://api.deepseek.com",
};

function draft(overrides: Partial<RecordingDraft> = {}): RecordingDraft {
  return {
    baseline,
    enabled: false,
    portText: "18787",
    upstreamText: "https://api.deepseek.com",
    revision: 1,
    ...overrides,
  };
}

describe("U8 2.1：录制草稿的 ensure 与基线", () => {
  it("无草稿时从已核实状态初始化（读到什么填什么）", () => {
    expect(ensureRecordingDraft(null, baseline)).toEqual({
      baseline,
      enabled: false,
      portText: "18787",
      upstreamText: "https://api.deepseek.com",
      revision: 1,
    });
  });

  it("状态未读到 ⇒ 默认值起点且 baseline 为 null（默认值不充当已保存事实）", () => {
    const d = ensureRecordingDraft(null, null);
    expect(d.baseline).toBeNull();
    expect(d.portText).toBe("18787");
    expect(d.upstreamText).toBe("https://api.deepseek.com");
    expect(d.enabled).toBe(false);
  });

  it("已有草稿原样返回：重进页面不覆盖输入", () => {
    const edited = writeRecordingDraft(ensureRecordingDraft(null, baseline), { portText: "20000" });
    expect(ensureRecordingDraft(edited, baseline)).toBe(edited);
  });

  it("状态回读落地只更新 baseline，不动用户输入；相同 baseline 返回原引用", () => {
    const edited = writeRecordingDraft(ensureRecordingDraft(null, baseline), { portText: "20000" });
    const next = applyRecordingBaseline(edited, { enabled: false, port: 19000, upstreamBaseUrl: "https://x" });
    expect(next.portText).toBe("20000");
    expect(next.baseline?.port).toBe(19000);
    expect(applyRecordingBaseline(edited, baseline)).toBe(edited);
  });
});

describe("U8 2.1：写入修订与 dirty", () => {
  it("任一字段实际变化推进修订；相同写入返回原引用", () => {
    const d0 = ensureRecordingDraft(null, baseline);
    const d1 = writeRecordingDraft(d0, { portText: "20000" });
    expect(d1.revision).toBe(d0.revision + 1);
    expect(writeRecordingDraft(d1, { portText: "20000" })).toBe(d1);
  });

  it("未偏离 baseline ⇒ 不 dirty；偏离任一字段 ⇒ dirty；running 状态不参与判定", () => {
    const d0 = ensureRecordingDraft(null, baseline);
    expect(isRecordingDraftDirty(d0)).toBe(false);
    expect(isRecordingDraftDirty(writeRecordingDraft(d0, { enabled: true }))).toBe(true);
    expect(isRecordingDraftDirty(writeRecordingDraft(d0, { portText: "18787 " }))).toBe(true);
    // baseline 未读 ⇒ 不算修改（没有可比的当前应用值；默认表单不误报）
    const unread = ensureRecordingDraft(null, null);
    expect(isRecordingDraftDirty(unread)).toBe(false);
    expect(isRecordingDraftDirty(writeRecordingDraft(unread, { portText: "1" }))).toBe(false);
  });

  it("改回 baseline 值后 dirty 归零（内容语义，不是「改过就算」）", () => {
    const d0 = ensureRecordingDraft(null, baseline);
    const d1 = writeRecordingDraft(d0, { portText: "20000" });
    const d2 = writeRecordingDraft(d1, { portText: "18787" });
    expect(isRecordingDraftDirty(d2)).toBe(false);
    expect(d2.revision).toBeGreaterThan(d1.revision);
  });
});

describe("U8 2.2：放弃（CAS，不调用配置写通道）", () => {
  it("修订一致 ⇒ 恢复 baseline 值且拿新修订（防 ABA 复用旧确认）", () => {
    const d1 = writeRecordingDraft(ensureRecordingDraft(null, baseline), { portText: "1", enabled: true });
    const result = discardRecordingDraft(d1, d1.revision);
    expect(result.discarded).toBe(true);
    expect(result.draft?.portText).toBe("18787");
    expect(result.draft?.enabled).toBe(false);
    expect(result.draft?.revision).toBeGreaterThan(d1.revision);
    expect(isRecordingDraftDirty(result.draft!)).toBe(false);
  });

  it("旧修订确认不能删除新输入（确认后内容又变 ⇒ 拒绝）", () => {
    const d1 = writeRecordingDraft(ensureRecordingDraft(null, baseline), { portText: "1" });
    const d2 = writeRecordingDraft(d1, { portText: "2" });
    const result = discardRecordingDraft(d2, d1.revision);
    expect(result.discarded).toBe(false);
    expect(result.draft).toBe(d2);
  });

  it("baseline 未读时放弃恢复默认值起点", () => {
    const d = writeRecordingDraft(ensureRecordingDraft(null, null), { portText: "9" });
    const result = discardRecordingDraft(d, d.revision);
    expect(result.discarded).toBe(true);
    expect(result.draft?.portText).toBe("18787");
    expect(result.draft?.baseline).toBeNull();
  });
});

describe("U8 2.4：应用前字段校验（完整整数 + URL；非法即零请求）", () => {
  it("端口：18787abc / 小数 / 空 / 0 / 65536 / 负数全部拒绝；完整整数放行", () => {
    for (const bad of ["18787abc", "18787.5", "", "0", "65536", "-1", " 18787", "①"]) {
      expect(recordingPortError(bad), `应拒绝「${bad}」`).not.toBeNull();
    }
    for (const good of ["1", "18787", "65535"]) {
      expect(recordingPortError(good), `应放行「${good}」`).toBeNull();
    }
  });

  it("upstream：空串 / 未完成 URL 拒绝；合法 URL 放行（与 main schema 同判据）", () => {
    for (const bad of ["", "https://", "api.deepseek.com", "https://x y"]) {
      expect(recordingUpstreamError(bad), `应拒绝「${bad}」`).not.toBeNull();
    }
    expect(recordingUpstreamError("https://api.deepseek.com")).toBeNull();
    expect(recordingUpstreamError("http://127.0.0.1:11434/v1")).toBeNull();
  });

  it("非法字段 ⇒ 不产出请求（ok:false + 双字段错误），不可能发出半截配置写调用", () => {
    const bad = writeRecordingDraft(ensureRecordingDraft(null, baseline), { portText: "18787abc" });
    const result = recordingApplyRequest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.port).not.toBeNull();
      expect(result.errors.upstream).toBeNull();
    }
  });

  it("合法字段 ⇒ 产出与草稿逐项一致的 toggle 输入", () => {
    const d = writeRecordingDraft(ensureRecordingDraft(null, baseline), {
      enabled: true,
      portText: "20000",
      upstreamText: "http://127.0.0.1:11434",
    });
    expect(recordingApplyRequest(d)).toEqual({
      ok: true,
      input: { enabled: true, port: 20000, upstreamBaseUrl: "http://127.0.0.1:11434" },
    });
  });
});
