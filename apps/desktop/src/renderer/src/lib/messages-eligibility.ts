/**
 * U8（unify-recording-and-experiment-workspaces）任务 5.2：**messages 重发的凭据与
 * 来源资格**（design D3/D7）。
 *
 * 从 MessagesForkEditor 的内联资格链提取为纯判据（顺序即语义——谁先挡住这次重发）：
 * 源记录 → 恢复重验 → 代理是否在跑 → 是否捕获到 key → 统一槽门禁。
 *
 * 两条 delta 明令的边界（定向测试钉死顺序）：
 * - **「停用代理仍有凭据不能重发」**：`running` 检查先于 `hasKey`——hasKey=true 只是
 *   "本会话曾捕获过 key"，重发还要求现有 handler 可用（running）；内存 key 可能仍在，
 *   但服务停了就没有可重发的 upstream；
 * - **「未捕获 key」**：桌面 settings 里保存的模型密钥**不替代**代理 key——本判据
 *   只消费代理状态的 hasKey，输入里没有 settings（结构上借不到模型 key）。
 *
 * `recordingEntry`：该原因能否由「打开录制工作区」就地化解（代理启停/凭据接入都在
 * 录制页完成；来源失效与执行槽忙碌不在此列——前者要修数据，后者等槽空）。
 */

export interface MessagesEligibilityInput {
  /** 目标作用域的源可用性（列表在场 + 非 ownOnly + 已读出） */
  readonly sourceExecutable: boolean;
  /** 恢复重验未通过的原因；null = 通过 */
  readonly sourceBlockedReason: string | null;
  /**
   * 代理监听状态：true = running；false = 已停；null = 状态未知（待读取/读取失败）。
   * 状态未知同样不能放行——「不知道在不在跑」不是「在跑」。
   */
  readonly proxyRunning: boolean | null;
  /**
   * tasks 2.1：代理事实**正在核对中**（读取在飞）。
   *
   * ⚠️ 与 `proxyRunning === null` 是**两回事**，措辞也必须分开：
   * - `null` = 状态未知（没读到 / 读失败）⇒ 长期占位，需要用户去核对；
   * - `checking` = 正在读，几毫秒后就有结论 ⇒ 说成「未知」会让每次打开编辑器
   *   都先闪一句恐吓话（delta：「读取期间显示核对中……不谎报未捕获」）。
   *
   * 两者都**不放行**提交：依赖当前事实的动作不能拿"正在读"当许可。
   */
  readonly proxyChecking?: boolean;
  /** 代理会话是否捕获过 key（ProxyState.hasKey；与 settings 密钥无关） */
  readonly hasKey: boolean;
  /** 统一执行槽门禁的就近说明（gate.canSubmit = false 时的 notice）；null = 槽可用 */
  readonly gateNotice: string | null;
}

export interface MessagesIneligibility {
  readonly reason: string;
  /** 就近给「打开录制工作区」入口（原因属代理启停/凭据接入范畴） */
  readonly recordingEntry: boolean;
}

export function deriveMessagesIneligibility(
  input: MessagesEligibilityInput,
): MessagesIneligibility | null {
  if (!input.sourceExecutable) {
    return { reason: "源记录不可用：重新读取并校验通过前不能重发", recordingEntry: false };
  }
  if (input.sourceBlockedReason !== null) {
    return { reason: `来源失效，已禁止重发：${input.sourceBlockedReason}`, recordingEntry: false };
  }
  if (input.proxyRunning !== true) {
    return {
      reason:
        input.proxyRunning === false
          ? "本地录制代理未运行：没有可重发的 upstream（停用状态下即使本会话捕获过 key 也不能重发）"
          : input.proxyChecking === true
            ? "正在核对代理当前状态…（读到最新事实前不能按「可能在跑」放行重发）"
            : "代理状态未知（尚未读取或读取失败）：不能按「可能在跑」放行重发",
      recordingEntry: true,
    };
  }
  if (input.hasKey !== true) {
    return {
      reason: "本会话未捕获到 key：先把你的应用经代理跑一次，再回来重发",
      recordingEntry: true,
    };
  }
  if (input.gateNotice !== null) {
    return { reason: input.gateNotice, recordingEntry: false };
  }
  return null;
}
