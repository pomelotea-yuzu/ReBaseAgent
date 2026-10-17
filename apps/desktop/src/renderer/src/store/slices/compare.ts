// AppState 分片：Compare 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type { ComparePair, CompareReturnLocation } from "../../lib/compare-navigation";
import type { CompareReadSession } from "../../lib/compare-state";

export interface CompareState {
  compareRead: CompareReadSession;
  /**
   * U7 任务 1.4：进入/更换比较对象并读取。合法性与幂等判据：
   * 非法（数量/重复/空 id）⇒ 不变；与当前选择集同序同 id ⇒ 幂等不重读（保留结论）；
   * 换集 ⇒ 旧结论撤销 + 发起单次 `runs:compare`（旧在飞响应被代次淘汰）。
   * 返回值供调用方与测试区分三分支。
   */
  comparePair: ComparePair | null;
  /**
   * U7 任务 4.8：比较步骤的**复合定位**——左右两列各自的选中调用，身份 =
   * 侧 + run + span。选左不改变右（scenario「重复 span ID 与独立分支不强行
   * 对齐」：两侧重复的 s_01 各归各列）；更换对象清空被换侧，交换随 pair 对调，
   * 换了 pair（新比较集）则两侧全清。
   */
  compareStepSelection: { readonly left: string | null; readonly right: string | null };
  /** U7 任务 4.8：设置某一列的选中调用（null = 取消选中）；只动本侧。 */
  comparePrefixFolded: { readonly left: boolean; readonly right: boolean };
  /** U7 任务 4.14：切换某一侧的前缀折叠/展开（只动本侧）。 */
  compareEvidenceExpanded: boolean;
  /** UI 密度 change 1.4：展开/收起修改证据区。 */
  compareReturnLocation: CompareReturnLocation | null;
  /**
   * U7 任务 2.1/2.5：概览/可信结果的「与父运行对比」入口。父左子右恒定；
   * 无 parent ⇒ hidden（入口不显示），model_params 臂 ⇒ blocked（实验门禁，
   * 不提供普通旁路）。返回值供调用方与测试区分分支。
   */
  compareIds: string[];
  /** 对照集合的操作提示（超上限等），空则无提示 */
  compareNotice: string | null;

  /**
   * 创建工作区（U5 任务 4.1）：**这次是从哪儿点进来创建的**。
   *
   * 「新建」不再是覆盖模态而是主工作区的一个页面（`view === "create"`），于是需要一个
   * 与创建草稿**分开**的凭据来兑现"返回来源"（design D1 + delta 场景「创建工作区任务
   * 优先且可返回来源」）。三条纪律：
   * - 只含阅读位置（运行 / 页签 / 调用 / 文件定位），**不含**草稿正文、目录引用、授权、
   *   凭据，也不含 main 操作登记的任何字段（判据与形状都在 `lib/create-workspace.ts`）；
   * - 只存 renderer 会话：不落盘、不进 URL/日志/IPC ⇒ **重载后必然失效**，
   *   返回时只能回退到已有可用工作区，不从草稿或登记反推旧位置；
   * - 与草稿生命周期互不决定：草稿的恢复/放弃/正常结束清理都不动它；
   *   从别的工作区进入创建重记，创建页内重复点击与设置往返沿用。
   *
   * ⚠️ 与 `createSourceRef`（隔离运行的**源目录**引用：main 签发的 token + name/path）
   * 是两回事，别混用。
   */
  enterCompareSelection: (
    runIds: readonly string[],
  ) => Promise<"started" | "unchanged" | "invalid">;
  /**
   * U7 任务 1.5：**显式只读重试**——同选择集全量重读（design D3：整组重验保持
   * 共同基线一致）。旧结论先行撤销；无活动选择集时不可重试（返回 false）。
   * 零执行通道调用。
   */
  retryCompareSelectionRead: () => Promise<boolean>;
  /**
   * U7 任务 1.4：离开比较（销毁守卫）。在飞请求作废、结论清空、代次递增——
   * 迟到响应永不复活；不碰选择运行/草稿/操作事实。
   */
  leaveCompare: () => void;

  /**
   * U7 任务 2.2：详细比较的**独立 pair**（父左子右 / 手动加入顺序）。与侧栏
   * 选中项、`compareIds` 全局集合互不决定（D1）；null = 比较工作区无详细比较
   * （单条自有指标 / 引导态）。只存 renderer 会话。
   */
  selectCompareStep: (side: "left" | "right", spanId: string | null) => void;
  /**
   * U7 任务 4.14：每侧前缀的折叠态（默认折叠——共同执行部分收进摘要行，
   * 可展开完整前缀）。复位口径与复合定位一致：换 pair 双侧回默认、
   * 更换对象被换侧回默认、交换随 pair 对调。
   */
  toggleComparePrefix: (side: "left" | "right") => void;
  /**
   * UI 密度 change 1.4：比较修改证据区的展开态（**默认收起**——design D2
   * 「比较页修改证据折为『修改证据 · 字段/修改数 · 展开』，收起释放输出阅读空间」；
   * 缺证据/关系未知摘要不受它影响，始终可见）。复位口径与 comparePrefixFolded 一致：
   * 换 pair 回默认收起；交换左右不改证据内容，保持现状。
   */
  setCompareEvidenceExpanded: (expanded: boolean) => void;
  /**
   * U7 任务 2.3：比较页的来源位置引用（类型与创建页同形，捕获/恢复复用同一批
   * 判据）。一次性凭据：返回来源即用掉；经 `selectRun` 打开单侧时**保留**——
   * 「打开单侧 → 返回比较 → 再返回来源」的往返要靠它（setView 才清）。
   */
  openCompareWithParent: (runId: string) => Promise<"opened" | "hidden" | "blocked">;
  /**
   * U7 任务 5.3：从宽幅指标表**显式选择两条**进入详细比较（design D1）。
   * - 两枚 runId 必须互异（相同 ID 不构成两条比较）且都属于当前对照集合
   *   （表列只能来自集合，双保险）；
   * - 显式选择**不改全局集合**（进入/交换不改集合，D1）；
   * - 页内换 pair = 显式换阅读对象 ⇒ 推进阅读代次（2.4 同款）；
   *   步骤选中/折叠随 pair 变更的清理在 `enterCompareView` 内完成。
   */
  openComparePair: (leftRunId: string, rightRunId: string) => Promise<"opened" | "rejected">;
  /**
   * U7 任务 2.2/2.5：从全局对照集合进入比较工作区。恰好两条 ⇒ 按加入顺序
   * （先子在左也是子左父右）；三/四条 ⇒ 不自动选两条（§5.3 显式选择，这里如实
   * 提示后仍进工作区）；零/一条 ⇒ 无详细比较（引导态）。
   */
  openCompareWorkspace: () => Promise<void>;
  /**
   * U7 任务 2.2：更换 pair 的一侧。同 ID 拒绝（两枚 runId 必须互异）、同值幂等；
   * 换成功 ⇒ 推进阅读代次并按新序重读。**不**调 `selectRun`、不动侧栏选择
   * 与全局集合（scenario「更换交换不改变侧栏选择」）。
   */
  setCompareSide: (
    side: "left" | "right",
    runId: string,
  ) => Promise<"replaced" | "unchanged" | "rejected">;
  /** U7 任务 2.2：交换左右。方向、标题、每侧内容随序号同步；推进阅读代次并重读。 */
  swapCompareSides: () => Promise<"swapped" | "none">;
  /**
   * U7 任务 2.3：返回比较的来源页（一次性凭据，恢复/回退都算用掉）。
   * 来源不可用（no-location / run-missing）⇒ 回退到仍有效的来源视图，不选同名运行。
   */
  returnFromCompare: () => Promise<void>;
  /**
   * U7 任务 2.3：从单侧运行/调用回到比较页（打开单侧**不清**来源引用与 pair）。
   * 同 pair 幂等：`enterCompareSelection` 不重读，会话结论与阅读位置保留。
   */
  returnToCompare: () => void;
  /**
   * U7 任务 4.5：比较侧的**单侧错误跳转**——打开目标侧运行并定位其自有失败
   * 调用。spanId 来自该侧已校验详情的错误定位派生（`deriveSideOutputFacts`），
   * 本动作不做二次归属判断；运行不可达（详情读取失败）⇒ false，由视图给
   * 回退说明。打开单侧按 2.3 保留 pair 与来源引用 ⇒ 「返回比较」仍成立。
   */
  openCompareSideError: (runId: string, llmCallSpanId: string) => Promise<boolean>;
  /**
   * U7 任务 5.6/5.7：**分别打开左右侧文件页**（design D6）。
   * - 能力判据用比较响应里该侧的**已校验详情**（isIsolatedRun），普通运行
   *   ⇒ unsupported（不造文件历史、不借当前选中 run 冒充）；
   * - 该侧若有选中的比较步骤，仅**合法自有完成步骤**（leafSpanIds 内 agent.step）
   *   写成文件检查点定位目标，否则不写、走 U2 已保存位置/默认规则；
   * - 落地判据与 `openCompareSideError` 同款（selectRun 后详情读出且归属相符）；
   *   打开单侧保留 pair 与来源引用 ⇒ 「返回比较」仍成立（2.3）。
   */
  openCompareSideFiles: (side: "left" | "right") => Promise<"opened" | "unsupported" | "failed">;

  /**
   * U7 任务 3.1/3.2/3.3：分支树的**会话观察状态**（design D2——视口是观察参数，
   * 逻辑布局永不在 store 里重排）。null = 本会话尚未进入过树（首次进入由
   * `decideTreeInitialFocus` 决定初始范围与焦点）。
   */
  toggleCompare: (runId: string) => void;
  clearCompare: () => void;
  /**
   * 代理 run 的 messages 单请求重发（`proxy:fork`）：只交代**请求事实**。
   * U5 任务 3.3：与 result / prompt 同形——不再"成功刷新列表并自动选中新 run"；
   * 列表刷新与按可信 ID 核实归终态消费点，是否进入新 run 概览归导航意图（任务 3.4）。
   */
}
