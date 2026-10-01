import { describe, expect, it } from "vitest";
import { deriveMessagesIneligibility } from "../src/renderer/src/lib/messages-eligibility";

/**
 * U8 任务 5.2：**messages 重发的凭据与来源资格**（delta「停用代理仍有凭据不能重发」
 * 「未捕获 key」+ design D3「停止后 hasKey 可能仍为 true，重发还要求 running」）。
 *
 * 判据来源：MessagesForkEditor 原内联资格链提取为纯函数——顺序即语义。
 */

const base = {
  sourceExecutable: true,
  sourceBlockedReason: null,
  proxyRunning: true as boolean | null,
  hasKey: true,
  gateNotice: null,
};

describe("5.2 messages 资格顺序判据：源 → 重验 → 监听 → 凭据 → 槽", () => {
  it("全部通过 ⇒ null（可重发）", () => {
    expect(deriveMessagesIneligibility(base)).toBeNull();
  });

  it("源记录不可用最先挡住；来源失效次之——两者不给录制入口（不是启停代理能修的）", () => {
    const noSource = deriveMessagesIneligibility({ ...base, sourceExecutable: false });
    expect(noSource?.reason).toContain("源记录不可用");
    expect(noSource?.recordingEntry).toBe(false);

    const blocked = deriveMessagesIneligibility({
      ...base,
      sourceBlockedReason: "源内容已改变",
    });
    expect(blocked?.reason).toContain("来源失效");
    expect(blocked?.recordingEntry).toBe(false);
  });

  it("「停用代理仍有凭据不能重发」：running=false 且 hasKey=true ⇒ 仍被监听检查挡住（顺序有牙）", () => {
    const stopped = deriveMessagesIneligibility({ ...base, proxyRunning: false, hasKey: true });
    expect(stopped?.reason).toContain("未运行");
    expect(stopped?.reason).toContain("即使本会话捕获过 key 也不能重发");
    // 该原因可由录制工作区化解（启停代理在那页完成）
    expect(stopped?.recordingEntry).toBe(true);
  });

  it("状态未知（running=null）不能按「可能在跑」放行", () => {
    const unknown = deriveMessagesIneligibility({ ...base, proxyRunning: null });
    expect(unknown?.reason).toContain("状态未知");
    expect(unknown?.recordingEntry).toBe(true);
  });

  it("「未捕获 key」：running 正常但 hasKey=false ⇒ 提示先把应用经代理跑一次", () => {
    const noKey = deriveMessagesIneligibility({ ...base, hasKey: false });
    expect(noKey?.reason).toBe("本会话未捕获到 key：先把你的应用经代理跑一次，再回来重发");
    expect(noKey?.recordingEntry).toBe(true);
  });

  it("槽忙碌的最后防线就近呈现；不给录制入口（等槽空，不是录制能修的）", () => {
    const busy = deriveMessagesIneligibility({ ...base, gateNotice: "已有操作在飞" });
    expect(busy?.reason).toBe("已有操作在飞");
    expect(busy?.recordingEntry).toBe(false);
  });

  it("「不借用模型 key」是结构性的：判据输入里没有 settings（想借也借不到）", () => {
    // 输入形状只有代理状态与来源/槽事实——settings 的 apiKey 没有通路进入本判据
    expect(deriveMessagesIneligibility.length).toBe(1);
    const input = deriveMessagesIneligibility(base);
    expect(input).toBeNull();
  });
});
