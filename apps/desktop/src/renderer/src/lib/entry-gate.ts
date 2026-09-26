import type { OperationBlockedBy, OperationSession } from "./operation-session";
import { deriveGate } from "./operation-session";

/**
 * U4 任务 4.3/4.4：把会话门禁翻成**界面能直接用的三样东西**（能不能提交、按钮旁的说明、
 * 该不该继续锁着输入）。四个编辑器与创建对话框共用本模块，不各自判一套。
 *
 * 两条容易走偏的口径：
 * 1. **"自己的提交在飞"和"别人的操作占槽"要分开**。前者（`busy`）才锁输入与放弃——
 *    草稿正文此刻已被提交快照冻结；后者只是不让再发一条，用户仍可继续编辑本地草稿。
 *    把两者混成一个 `inProgress`，会让"另一个入口在跑"看起来像"这份草稿正在提交"。
 * 2. **禁用必须有可见理由**。只把按钮置灰 = 死按钮（spec「操作入口在窄窗口和键盘下可达」
 *    的反面）；`notice` 按 `blockedBy` 给一句人话，且只有"未确认状态"这一类才引导用户去核对。
 */

export interface EntryGate {
  /** 本入口此刻可否提交 */
  readonly canSubmit: boolean;
  /** 不能提交的原因（可提交时为 null） */
  readonly blockedBy: OperationBlockedBy | null;
  /** 按钮旁的说明文案；可提交时为 null */
  readonly notice: string | null;
  /** 是否该提示"去核对状态"（只有通信未知才引导核对，不拿它当通用文案） */
  readonly shouldReconcile: boolean;
}

const NOTICES: Record<OperationBlockedBy, string> = {
  not_handshaked: "尚未与主进程确认操作状态，正在重试握手……",
  communication_unknown: "操作状态未确认（状态通道失联或返回异常）。请先核对状态，不要重复提交。",
  closing: "应用正在退出，不能发起新的执行。",
  configuration_busy: "运行配置或代理正在变更，请等这次变更结束后再执行。",
  operation_running: "已有操作正在执行（桌面同时只允许一个主动操作），请等它结束。",
};

export function deriveEntryGate(session: OperationSession): EntryGate {
  const gate = deriveGate(session);
  if (gate.blockedBy === null) {
    return {
      canSubmit: true,
      blockedBy: null,
      notice: null,
      shouldReconcile: false,
    };
  }
  return {
    canSubmit: false,
    blockedBy: gate.blockedBy,
    notice: NOTICES[gate.blockedBy],
    shouldReconcile: gate.blockedBy === "communication_unknown",
  };
}

/**
 * 配置写入口的门禁（任务 4.8）：settings 保存/清除与代理启停。
 *
 * 与提交入口同源（同一份会话），但**只管写**——spec 明确要求
 * `settings:get` / `proxy:status` 一类读取在任何状态下都保持可用（「直接 IPC 不能绕过配置锁」
 * 的 THEN 句），所以读取路径不接这里，只有三个写动作接。
 */
export interface ConfigGate {
  readonly canChange: boolean;
  readonly notice: string | null;
}

export function deriveConfigGate(session: OperationSession): ConfigGate {
  const gate = deriveGate(session);
  if (gate.blockedBy === null) return { canChange: true, notice: null };
  return {
    canChange: false,
    // 自己就是"配置变更中"那条判据的持有者 ⇒ 文案换成面向配置的说法
    notice:
      gate.blockedBy === "configuration_busy"
        ? NOTICES.configuration_busy
        : NOTICES[gate.blockedBy],
  };
}
