// AppState 分片：Configuration 域（refactor-renderer 4.1 接口 / 5.6 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// 代理订阅/静默等待者经注入的 ProxyCoordinationRuntime 句柄消费（唯一所有者住在
// store/runtime/proxy-coordination，store.ts 在 create 后组合——句柄方法全是惰性调用，
// 与 4.3 的薄包装语义逐字等价）；describeZodError 自 lib/describe-zod-error 直连（5.7 归置）；
// setSettingsSection 对 results.noteReadingChanged / drafts.clearExecutionConfirmations
// 的调用走执行时 get()（跨域调用走 action，design D2）。
import type { ProxyState, ProxyToggleInput, SettingsInput, SettingsState } from "@shared/ipc";
import { ProxyStateSchema, SettingsStateSchema } from "@shared/ipc";
import { api } from "../../lib/api";
import { describeZodError } from "../../lib/describe-zod-error";
import type { ProxyFactCursor } from "../../lib/proxy-changes";
import { initialProxyFactCursor, shouldReconcileOnActivate } from "../../lib/proxy-changes";
import type { ProxyStatusReadState } from "../../lib/proxy-status-read";
import {
  acceptProxySnapshot,
  beginStatusRead,
  initialProxyStatusReadState,
  settleStatusRead,
} from "../../lib/proxy-status-read";
import type { RecordingDraft, RecordingDraftPatch } from "../../lib/recording-draft";
import {
  applyRecordingBaseline,
  discardRecordingDraft as discardRecordingDraftState,
  recordingApplyRequest,
  recordingBaselineOf,
  writeRecordingDraft,
} from "../../lib/recording-draft";
import type { SettingsSaveOutcome } from "../../lib/settings-form";
import { clearedStoreError, storeError } from "../../lib/store-error";
import type { ProxyCoordinationRuntime } from "../runtime/proxy-coordination";
import type { SliceContext } from "../types";

export interface ConfigurationState {
  /** 运行配置状态（不含 apiKey；null = 尚未加载成功） */
  settings: SettingsState | null;

  /** 本地录制代理状态（不含 key 值；null = 尚未加载） */
  proxy: ProxyState | null;
  /**
   * 任务 2.1：代理状态读取的**在途合并与代次守卫**（`lib/proxy-status-read.ts` 判据）。
   * 与列表读取的 `listRefreshInFlight/Pending` 是**两套独立计数**——守卫锚点不同
   * （列表锚阅读位置，状态锚门禁事实），合并不许互相影响。
   *
   * ⚠️ 不参与渲染；UI 要「核对中」请派生 `proxyStatusChecking`（避免订阅整对象）。
   */
  proxyStatusRead: ProxyStatusReadState;
  /** U8 任务 2.6：状态读取代次（每次 loadProxyStatus 推进；守卫的锚点之一） */
  proxyReadGeneration: number;
  /**
   * 已采纳的代理事实版本游标（`proxy-changes.ts` 的判据输入）。
   * 只存 epoch 与两个计数器——**没有任何凭据、指纹或载荷**。
   */
  proxyFactCursor: ProxyFactCursor;
  /**
   * U8 任务 3.7：**已核实的运行配置变化代次**——已核实保存（含仅轮换 key：model/baseURL
   * 相同、指纹不变的那次）与已核实清除推进；保存失败不推进；已保存但回读失败**也推进**
   * （状态未知 ⇒ 撤销旧计划，不拿猜测保住结论）；普通 proxy:status 刷新**不**推进。
   * 只记次数，零密钥值传播。
   */
  settingsChangeGeneration: number;
  /** 「录制接入」跳转后要高亮的设置分区（null = 常规打开设置） */
  settingsSection: "proxy" | null;

  recordingDraft: RecordingDraft | null;
  /**
   * U8 任务 2.5/2.6：在飞应用的**提交修订**（null = 无在飞）。应用+回读全程防重复提交；
   * 响应只有与当前草稿修订匹配才更新基线（「录制应用收尾不覆盖后来输入」）。
   */
  recordingApply: number | null;
  /** 最近一次应用的启动失败原始诊断（成功即清；「已保存意图 vs 监听事实」的分层呈现归视图） */
  recordingApplyError: string | null;
  /** 启动失败信封的稳定码（null = 无失败）；视图据此给本地化摘要，原文按原始诊断展示 */
  recordingApplyErrorCode: string | null;
  /** 最近一次状态回读失败（2.5：失败也允许只读重试；重试即 loadProxyStatus，不重新 toggle） */
  recordingStatusReadFailed: boolean;

  loadSettings: () => Promise<boolean>;
  saveSettings: (input: SettingsInput) => Promise<SettingsSaveOutcome>;
  clearSettings: () => Promise<boolean>;
  setSettingsSection: (section: "proxy" | null) => void;
  loadProxyStatus: () => Promise<void>;
  /** 启停即保存（端口/upstream 一并生效）；失败返回 null 并在 error 里给出原因 */
  toggleProxy: (input: ProxyToggleInput) => Promise<ProxyState | null>;
  ensureProxyChangeSubscription: () => void;
  /** 解除订阅（renderer 卸载时必须调用，否则监听器泄漏） */
  releaseProxyChangeSubscription: () => void;
  /**
   * 只读核对当前代理事实版本（design D1 的补读路径）。
   * 供窗口重新激活时调用：读到更新的 `recordsRevision` 才补刷列表。
   * 它**只读**：不启动监听、不调上游、不产生模型请求（design D3）。
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
  /** U8 任务 2.1：写入录制草稿字段（原始文本无损；修订按实际变化推进） */
  writeRecordingDraftFields: (patch: RecordingDraftPatch) => void;
  /** U8 任务 2.2：按修订 CAS 明确放弃录制草稿（旧确认不能删除新输入；零配置写调用） */
  discardRecordingDraftConfirmed: (expectedRevision: number) => boolean;
  /**
   * U8 任务 2.5：保存并应用（toggle）→ 随后**一律回读**真实状态（toggle 非事务：
   * 可能已保存但监听失败——不伪造回滚）。非法字段不接受（纵深防御，组件判据同源）；
   * 在飞期间拒绝重复应用；响应只在修订匹配时更新基线（2.6）。
   */
  applyRecordingDraft: () => Promise<"applied" | "start-failed" | "invalid" | "busy" | "no-draft">;
}

/** configuration 分片工厂上下文：完整 set/get + 代理协调句柄的显式注入 */
export interface ConfigurationSliceContext extends SliceContext {
  /** 代理协调 runtime 句柄（唯一所有者在 store/runtime/proxy-coordination；store.ts create 前组合） */
  coordination: ProxyCoordinationRuntime;
}

export function createConfigurationSlice({
  set,
  get,
  coordination,
}: ConfigurationSliceContext): ConfigurationState {
  return {
    proxyFactCursor: initialProxyFactCursor,

    settings: null,
    proxy: null,
    recordingDraft: null,
    recordingApply: null,
    recordingApplyError: null,
    recordingApplyErrorCode: null,
    recordingStatusReadFailed: false,
    proxyReadGeneration: 0,
    proxyStatusRead: initialProxyStatusReadState,
    settingsChangeGeneration: 0,
    settingsSection: null,

    /**
     * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**。
     *
     * 三条纪律：
     * - **零主动登记**：这条订阅不碰 `operations:status`、不占执行槽、不发任何请求
     *   （delta「通知只包含受控元信息」的 renderer 半边：证明没有自动请求/自动重发）；
     * - **先订阅后首读**：调用方必须在本方法之后才 `loadProxyStatus`，
     *   否则订阅与首读之间落盘的记录两边都看不到；
     * - **载荷过 schema 才采纳**：非法载荷整条丢弃（不按"看起来像"的部分字段处理），
     *   否则一个坏载荷能把 hasKey 之类的门禁事实带歪。
     */
    ensureProxyChangeSubscription() {
      coordination.ensureSubscription();
    },

    releaseProxyChangeSubscription() {
      coordination.releaseSubscription();
    },

    /**
     * 只读核对代理事实版本（失焦/激活补读，design D1）。
     *
     * 失焦期间可能错过任意多条通知；重新激活时读一次状态，
     * 只有 `recordsRevision` 确实落后才补刷列表——否则每次点回窗口都白读全量 traces。
     * **只读**：不启动监听、不调上游、不产生模型请求。
     *
     * ⚠️ 这里**必须等状态读取静默**（tasks 2.1）：`loadProxyStatus` 在飞时会把本次意图
     * 合并成尾随并**立即返回**，此时游标一个字都没动。若不等待就拿游标做判据，
     * "没读到" 又会被误判成"没有变化"，失焦期间漏掉的落盘永远补不上。
     */
    async reconcileProxyFacts() {
      const before = get().proxyFactCursor;
      await get().loadProxyStatus();
      await coordination.settledProxyStatusRead();
      const readOk = get().proxy !== null;
      const after = get().proxyFactCursor;
      // 读取失败/载荷非法时 loadProxyStatus 把 proxy 置 null 且**游标不前进**
      // （见上面的 `loadProxyStatus`）。⚠️ 这时**不能**直接把 `after` 当"已核实版本"：
      // 游标没动 ⇒ epoch 仍与 `before` 相同 ⇒ `shouldReconcileOnActivate` 会走
      // "无落后"分支返回 false，正好把"这次什么都没读到"误判成"没有变化"，
      // 于是失焦期间漏掉的落盘永远补不上。故此处把 epoch 置 null 显式表达
      // "本次未取得任何版本事实"，由判据一律要求补刷。
      const observed: ProxyFactCursor = readOk ? after : { ...after, epoch: null };
      if (shouldReconcileOnActivate(before, observed).reloadRuns) await get().loadRuns();
    },

    /**
     * 门禁事实的只读核对（tasks 2.1）。
     *
     * 与 `reconcileProxyFacts` 刻意分开：那个判"要不要补刷列表"，这个只刷新门禁事实。
     * 分开的理由是**代价不对称**——打开 messages 编辑器时补刷一次全量 traces 是白读，
     * 而窗口激活时漏掉一次落盘补读是事实缺失（delta 两条场景各自点名）。
     */
    async reconcileProxyGate() {
      await get().loadProxyStatus();
      await coordination.settledProxyStatusRead();
    },

    async loadSettings() {
      const envelope = await api.getSettings();
      if (!envelope.ok) {
        set({
          settings: null,
          ...storeError("UI_SETTINGS_LOAD_FAILED", `读取运行配置失败：${envelope.error.message}`),
        });
        return false;
      }
      const parsed = SettingsStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          settings: null,
          ...storeError(
            "UI_SETTINGS_INVALID",
            `运行配置数据结构校验失败：${describeZodError(parsed.error)}`,
            { id: "errors.invalidArgument" },
          ),
        });
        return false;
      }
      set({ settings: parsed.data });
      return true;
    },

    async saveSettings(input) {
      const envelope = await api.saveSettings(input);
      if (!envelope.ok) {
        set({
          ...storeError("UI_SETTINGS_SAVE_FAILED", `保存运行配置失败：${envelope.error.message}`),
        });
        return "save-failed";
      }
      // U5 任务 5.4：保存与回读是**两个结论**——回读失败不否定"已保存"，
      // 但也绝不把旧摘要当新配置事实（loadSettings 失败路径已把 settings 置 null）。
      // U8 任务 3.7：两种成功结局都推进已核实配置变化代次（含仅轮换 key 的保存；
      // 回读失败=已保存但状态未知，同样撤销实验旧计划）；保存失败不推进。
      const outcome = (await get().loadSettings()) ? "saved" : "reread-failed";
      if (outcome === "saved" || outcome === "reread-failed") {
        set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
      }
      return outcome;
    },

    async clearSettings() {
      const envelope = await api.clearSettings();
      if (!envelope.ok) {
        set({
          ...storeError("UI_SETTINGS_CLEAR_FAILED", `清除运行配置失败：${envelope.error.message}`),
        });
        return false;
      }
      set({ settings: null });
      // U8 任务 3.7：已核实清除推进配置变化代次（实验旧计划随之作废）
      set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
      return true;
    },

    /**
     * 只读读一次代理状态（tasks 2.1：**合并 + 代次守卫 + 快照新旧守卫**）。
     *
     * 三个触发源会叠出并发读取（通知 / messages 打开的核对 / 窗口激活补读），
     * 两条守卫各自挡一种"旧事实覆盖新事实"：
     * - **合并**：在飞时不并发发射，只登记尾随，结束后补发恰好一次；
     * - **快照新旧**：读回的载荷可能比已采纳的事实更旧（请求在途期间又发生了一次变更），
     *   同 epoch 且任一版本维度落后 ⇒ 整份丢弃，一个字节都不写。
     *
     * ⚠️ **为什么没有第三道「代次守卫」**（变异验证的结论，别照着旧注释再加回去）：
     * 合并已经保证同时至多一个读取在飞，因此"响应对不上自己那次请求"在这条链路上
     * **不可达**。曾加过一道 `isLatestStatusRead` 断言，变异测试（改成 `if (false)`）
     * 显示 14 条 store 用例全绿——它从未真正拒绝过任何响应。留着它等于挂一个永不
     * 触发的"保险"，读代码的人会以为并发防护靠它。故移除；真正的并发防线是合并，
     * 真正的乱序防线是快照新旧守卫（变异后 3 条用例变红，见 proxy-status-read.test.ts）。
     *
     * ⚠️ 失败时游标**不前进**：状态未知时不能断言"版本没变"——否则失焦期间漏掉的落盘
     * 会被这次失败读取"确认"成没有变化（design D1）。
     */
    async loadProxyStatus() {
      const decision = beginStatusRead(get().proxyStatusRead);
      set({ proxyStatusRead: decision.state });
      if (decision.action === "deferred") {
        // 刷新意图已受理：不发射、不返回事实。尾随补发由在飞那次收尾时完成。
        return;
      }
      try {
        // ⚠️ **通道本身抛错也必须被吞进失败分支**（tasks 2.1 实施期坐实）：本方法被
        // `openMessagesWorkspace` / `returnToAuxSource` 以 `void` 方式发起（fire-and-forget），
        // 一旦这里把异常抛出去就变成**未处理拒绝**——既没有可重试入口，也不会有人看见。
        // 实测：`aux-workspace-store.test.ts` 的 api 桩没有 proxyStatus，8 处未处理错误
        // 全部来自这一条路径。读通道失败与"读到一个失败信封"是同一件事：状态未知。
        let envelope: Awaited<ReturnType<typeof api.proxyStatus>>;
        try {
          envelope = await api.proxyStatus();
        } catch (e) {
          envelope = {
            ok: false as const,
            error: { code: "PROXY_STATUS_UNAVAILABLE", message: (e as Error).message },
          };
        }
        // U8 任务 2.6：每次真正发射的读取推进状态代次（守卫锚点；读取本身零写通道）
        set({ proxyReadGeneration: get().proxyReadGeneration + 1 });
        if (!envelope.ok) {
          set({
            proxy: null,
            ...storeError(
              "UI_PROXY_STATUS_LOAD_FAILED",
              `读取代理状态失败：${envelope.error.message}`,
            ),
            // U8 任务 2.5：回读失败如实呈现「状态待读取」，允许只读重试（不重新 toggle）
            recordingStatusReadFailed: true,
          });
          // ⚠️ 游标**不前进**（理由见上方注释）
          // 草稿在场 ⇒ baseline 撤到 null（没有可核实的当前应用值；输入原样保留）
          const draft = get().recordingDraft;
          if (draft !== null) set({ recordingDraft: applyRecordingBaseline(draft, null) });
          return;
        }
        const parsed = ProxyStateSchema.safeParse(envelope.data);
        if (!parsed.success) {
          set({
            proxy: null,
            ...storeError(
              "UI_PROXY_STATUS_INVALID",
              `代理状态数据结构校验失败：${describeZodError(parsed.error)}`,
              { id: "errors.invalidArgument" },
            ),
          });
          return;
        }
        // 规则 3（快照新旧）：载荷比已采纳事实更旧 ⇒ 整份丢弃。
        // ⚠️ 这一条**不能**由 cursorFromStatus 兜住：它只保证游标数字不回退，
        // 而 `proxy` 状态对象仍会被这份旧载荷写下去（hasKey 由 true 按回 false）。
        const ruling = acceptProxySnapshot(get().proxyFactCursor, parsed.data);
        if (!ruling.accept) return;
        set({
          proxy: parsed.data,
          recordingStatusReadFailed: false,
          proxyFactCursor: ruling.cursor,
        });
        // U8 任务 2.1：草稿在场 ⇒ baseline 跟随最近可核实事实（输入原样，dirty 随之重算）
        const draft = get().recordingDraft;
        if (draft !== null)
          set({ recordingDraft: applyRecordingBaseline(draft, recordingBaselineOf(parsed.data)) });
      } finally {
        const settled = settleStatusRead(get().proxyStatusRead);
        set({ proxyStatusRead: settled.state });
        // 尾随补发走本方法自身（由它登记在途数）——旁路直发 IPC 会让补发那次
        // 无人递减计数，此后所有读取都被"合并"成尾随而永不发射。
        //
        // ⚠️ 这里**不写 `return`**：`finally` 里的 return 会吞掉 try 块的控制流，
        // 且 Biome 直接把它标成错误（`noUnsafeFinally`）。改成 if/else 让两条路径互斥。
        if (settled.shouldRefire) {
          await get().loadProxyStatus();
        } else {
          // 只在**不再补发**时唤醒等待者：补发会在上面的 await 里重新置起在途计数，
          // 先唤醒会让"等静默"的调用方在补发还在飞时就拿到判断依据。
          coordination.notifyProxyStatusSettled();
        }
      }
    },

    async toggleProxy(input) {
      set({ ...clearedStoreError() });
      const envelope = await api.proxyToggle(input);
      if (!envelope.ok) {
        set({
          ...storeError("UI_PROXY_TOGGLE_FAILED", `代理操作失败：${envelope.error.message}`),
        });
        return null;
      }
      const parsed = ProxyStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({
          ...storeError(
            "UI_PROXY_STATUS_INVALID",
            `代理状态数据结构校验失败：${describeZodError(parsed.error)}`,
            { id: "errors.invalidArgument" },
          ),
        });
        return null;
      }
      set({ proxy: parsed.data });
      return parsed.data;
    },

    writeRecordingDraftFields(patch) {
      const draft = get().recordingDraft;
      if (draft === null) return;
      set({ recordingDraft: writeRecordingDraft(draft, patch) });
    },

    discardRecordingDraftConfirmed(expectedRevision) {
      const draft = get().recordingDraft;
      if (draft === null) return false;
      const result = discardRecordingDraftState(draft, expectedRevision);
      if (!result.discarded) return false;
      set({ recordingDraft: result.draft });
      return true;
    },

    async applyRecordingDraft() {
      const draft = get().recordingDraft;
      if (draft === null) return "no-draft";
      if (get().recordingApply !== null) return "busy";
      const request = recordingApplyRequest(draft);
      // 纵深防御：组件判据同源，但这里再拦一次——非法字段连在飞标记都不该出现
      if (!request.ok) return "invalid";
      const submittedRevision = draft.revision;
      set({
        recordingApply: submittedRevision,
        recordingApplyError: null,
        recordingApplyErrorCode: null,
      });
      const envelope = await api.proxyToggle(request.input);
      // toggle 非事务（design D2）：无论启动成败都回读真实状态——成功确认「已保存意图」，
      // 回读给出「监听事实」；回读失败 ⇒ 状态待读取，两层诊断分别呈现
      const startOk = envelope.ok;
      const startMessage = envelope.ok ? "" : envelope.error.message;
      const startCode = envelope.ok ? null : envelope.error.code;
      await get().loadProxyStatus();
      const current = get();
      // U8 任务 2.6：响应只在「与当前草稿修订匹配」时更新基线——在飞期间的后来输入
      // 不被旧响应覆写；诊断照报（它属于真实发生过的那次应用）
      const stale =
        current.recordingDraft === null || current.recordingDraft.revision !== submittedRevision;
      const patch: {
        recordingApply: number | null;
        recordingApplyError: string | null;
        recordingApplyErrorCode: string | null;
        recordingDraft?: RecordingDraft;
      } = {
        recordingApply: null,
        recordingApplyError: startOk ? null : startMessage,
        recordingApplyErrorCode: startCode,
      };
      if (startOk && !stale && current.recordingDraft !== null) {
        patch.recordingDraft = applyRecordingBaseline(current.recordingDraft, {
          enabled: request.input.enabled,
          port: request.input.port,
          upstreamBaseUrl: request.input.upstreamBaseUrl,
        });
      }
      set(patch);
      return startOk ? "applied" : "start-failed";
    },

    setSettingsSection(section) {
      // U5 3.4：进设置 SHALL 撤销自动导航资格（delta「结果导航尊重用户当前阅读意图」）
      // noteReadingChanged 是 results 分片公开成员，经执行时 get() 消费（跨域调用走 action，design D2）
      if (section !== null) get().noteReadingChanged();
      // U5 4.4：设置往返本身即撤销待用的执行确认（进出都算——确认时看到的模型/接入
      // 与回来后可能已经不是同一份配置了）。5.6：出口迁 drafts 分片，同款 get() 消费。
      else get().clearExecutionConfirmations();
      set({ settingsSection: section });
    },
  };
}
