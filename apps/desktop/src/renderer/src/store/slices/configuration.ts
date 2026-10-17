// AppState 分片：Configuration 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type {
  ProxyState,
  ProxyToggleInput,
  SettingsInput,
  SettingsState,
} from "../../../../shared/ipc";
import type { ProxyFactCursor } from "../../lib/proxy-changes";
import type { ProxyStatusReadState } from "../../lib/proxy-status-read";
import type { RecordingDraft, RecordingDraftPatch } from "../../lib/recording-draft";
import type { SettingsSaveOutcome } from "../../lib/settings-form";

export interface ConfigurationState {
  settings: SettingsState | null;

  /** 本地录制代理状态（不含 key 值；null = 尚未加载） */
  proxy: ProxyState | null;
  /** run 列表来源过滤 */
  proxyStatusRead: ProxyStatusReadState;
  /**
   * U8 任务 3.7：**已核实的运行配置变化代次**——已核实保存（含仅轮换 key：model/baseURL
   * 相同、指纹不变的那次）与已核实清除推进；保存失败不推进；已保存但回读失败**也推进**
   * （状态未知 ⇒ 撤销旧计划，不拿猜测保住结论）；普通 proxy:status 刷新**不**推进。
   * 只记次数，零密钥值传播。
   */
  proxyReadGeneration: number;
  /**
   * 任务 2.1：代理状态读取的**在途合并与代次守卫**（`lib/proxy-status-read.ts` 判据）。
   * 与列表读取的 `listRefreshInFlight/Pending` 是**两套独立计数**——守卫锚点不同
   * （列表锚阅读位置，状态锚门禁事实），合并不许互相影响。
   *
   * ⚠️ 不参与渲染；UI 要「核对中」请派生 `proxyStatusChecking`（避免订阅整对象）。
   */
  proxyFactCursor: ProxyFactCursor;
  /**
   * 只读核对当前代理事实版本（design D1 的补读路径）。
   * 供窗口重新激活时调用：读到更新的 `recordsRevision` 才补刷列表。
   * 它**只读**：不启动监听、不调上游、不产生模型请求（design D3）。
   */
  settingsChangeGeneration: number;

  /**
   * 会话内的短 ID 长度记忆（任务 4.4）。
   *
   * ⚠️ 为什么不放在 RunList 组件里：delta 要求「**会话中**已扩展的长度不因刷新删除
   * 碰撞项而缩短」。组件随导航收起/展开会卸载重建，本地 state 一卸载就丢长度记忆 ⇒
   * 刷新后短 ID 缩回 8 位，正是规则禁止的。放 store 才跨渲染存活。
   */
  settingsSection: "proxy" | null;

  /**
   * U8（unify-recording-and-experiment-workspaces）任务 1.2/1.3：三个辅助工作区的
   * **来源位置引用**（判据在 `lib/aux-workspace.ts`，语义同 `createReturnLocation`）：
   * - 只含会话内可核对的阅读位置，不含草稿正文 / 目标 / 凭据 / 授权；
   * - 页内重复进入与设置往返（视图未变）沿用；跨视图进入重记；经 setView 离开 = 用掉；
   * - `selectRun` 离开辅助页时**保留**（与比较页同一纪律：返回动作才消费引用）。
   * recording 是全局页面，也留来源（可从 messages 缺凭据提示进入，返回要回得去）。
   */
  recordingDraft: RecordingDraft | null;
  /**
   * U8 任务 2.5/2.6：在飞应用的**提交修订**（null = 无在飞）。应用+回读全程防重复提交；
   * 响应只有与当前草稿修订匹配才更新基线（「录制应用收尾不覆盖后来输入」）。
   */
  recordingApply: number | null;
  /** 最近一次应用的启动失败诊断（成功即清；「已保存意图 vs 监听事实」的分层呈现归视图） */
  recordingApplyError: string | null;
  /** 最近一次状态回读失败（2.5：失败也允许只读重试；重试即 loadProxyStatus，不重新 toggle） */
  recordingStatusReadFailed: boolean;
  /** U8 任务 2.6：状态读取代次（每次 loadProxyStatus 推进；守卫的锚点之一） */
  loadSettings: () => Promise<boolean>;
  saveSettings: (input: SettingsInput) => Promise<SettingsSaveOutcome>;
  clearSettings: () => Promise<boolean>;

  setSettingsSection: (section: "proxy" | null) => void;
  /** 勾选/取消对照（上限 4，超出不加入并给出提示） */
  loadProxyStatus: () => Promise<void>;
  /** 启停即保存（端口/upstream 一并生效）；失败返回 null 并在 error 里给出原因 */
  toggleProxy: (input: ProxyToggleInput) => Promise<ProxyState | null>;
  ensureProxyChangeSubscription: () => void;
  /** 解除订阅（renderer 卸载时必须调用，否则监听器泄漏） */
  releaseProxyChangeSubscription: () => void;
  /**
   * 已采纳的代理事实版本游标（`proxy-changes.ts` 的判据输入）。
   * 只存 epoch 与两个计数器——**没有任何凭据、指纹或载荷**。
   */
  reconcileProxyFacts: () => Promise<void>;
  /**
   * tasks 2.1：**门禁用**的只读核对（messages 打开 / 从录制返回时）。
   *
   * 与 `reconcileProxyFacts` 的分工：后者判"要不要补刷列表"（比对 recordsRevision），
   * 本者只保证"读到的事实是最新的"——**不刷列表**（打开编辑器不该白读一遍全量 traces）。
   * 同样只读：不启动监听、不调上游、不产生模型请求。
   *
   * ⚠️ 内部**等静默**：合并调度下被合并的那次调用会立即返回，不等就等于没读。
   */
  reconcileProxyGate: () => Promise<void>;

  writeRecordingDraftFields: (patch: RecordingDraftPatch) => void;
  /** U8 任务 2.2：按修订 CAS 明确放弃录制草稿（旧确认不能删除新输入；零配置写调用） */
  discardRecordingDraftConfirmed: (expectedRevision: number) => boolean;
  /**
   * U8 任务 2.5：保存并应用（toggle）→ 随后**一律回读**真实状态（toggle 非事务：
   * 可能已保存但监听失败——不伪造回滚）。非法字段不接受（纵深防御，组件判据同源）；
   * 在飞期间拒绝重复应用；响应只在修订匹配时更新基线（2.6）。
   */
  applyRecordingDraft: () => Promise<"applied" | "start-failed" | "invalid" | "busy" | "no-draft">;
  /**
   * U8 任务 3.1b：实验目标的**父本源读取**（只读 `runs:get`）。
   * 目标不跟随侧栏选择 ⇒ 工作区不能借用全局 `detail`；本读取不改选中项、
   * 不切页、不碰阅读状态——失败保留旧读取项并允许只读重试。
   */
}
