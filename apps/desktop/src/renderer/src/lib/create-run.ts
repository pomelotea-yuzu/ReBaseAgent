import type { ChooseSourceResult, CreateRunRequest } from "@shared/ipc";

/**
 * 新建运行（创建工作区）的纯逻辑（无 React、无 fs，可在 node 环境单测）。
 *
 * 设计要点（B 任务 2.1 / spec:desktop-ui「桌面端提供原生 run 创建入口」）：
 *
 * 1. **判据与请求同源**：`resolveCreateRunSubmission` 一次返回"能不能提交"和
 *    "提交什么"。按钮的禁用判据与真正发出的请求由**同一个函数**决定，不存在
 *    "界面显示可提交、请求却缺字段"或反之的漂移（组件里不要再手拼请求）。
 * 2. **纯对话默认，且请求里不出现 workspace 键**：没有 workspace 时 main 走
 *    `runCreate`（空工具表、v1）。这里刻意用"键不存在"而不是 `workspace: undefined`
 *    ——后者经结构化克隆后仍是自有属性，会让 strict schema 与"是否隔离"的分流
 *    出现两种读法。用例直接断言 `"workspace" in request === false`。
 * 3. **授权只对本次操作有效**（spec 场景「每次桌面操作独立确认写入」）：
 *    - `initialCreateRunForm()` 每次新的创建操作都返回未授权状态；
 *    - 选中目录**不等于**授权（`applyChosenSource` 只落目录，把授权复位）；
 *    - 切换运行模式视为新的一次隔离操作，目录与授权一并丢弃 —— 宁可让用户重选，
 *      也不把上一次的授权带进下一次提交（`workspace.write_authorized` 那类历史
 *      标注更不能代替本次授权，见 spec:workspace-isolation「副本写入必须显式授权」）。
 */

/** 运行模式：纯对话（空工具表）/ 隔离文件运行（固定 file-tools-v1 + 源目录副本） */
export const CREATE_RUN_MODES = ["chat", "isolated_files"] as const;
export type CreateRunMode = (typeof CREATE_RUN_MODES)[number];

/** 分段控件文案（spec 用词：默认"纯对话"或"隔离文件运行"） */
export const CREATE_RUN_MODE_LABELS: Record<CreateRunMode, string> = {
  chat: "纯对话",
  isolated_files: "隔离文件运行",
};

/**
 * 隔离模式的工具组展示文案。**不得**在这里手抄第二份定义——它与 replay 的
 * `FILE_TOOLS_V1_PROFILE` / `READ_FILE_TOOL_NAME` / `WRITE_FILE_TOOL_NAME` 同值，
 * 由 `test/create-run-dialog.test.ts` 的对照用例钉住（渲染层不 import replay，
 * 那会把 node:fs 拖进 renderer 包）。
 */
export const ISOLATED_TOOL_PROFILE_LABEL = "file-tools-v1";
export const ISOLATED_TOOL_NAMES = ["read_file", "write_file"] as const;

/**
 * 本次操作选定的源目录。只带 main 签发的会话 token 与展示用信息——
 * 渲染层不持有、也不需要任何文件系统能力（真实路径的校验在 main 与 A 包）。
 */
export interface ChosenSource {
  token: string;
  /** 目录名（窄窗口下的短标识） */
  name: string;
  /** 完整路径（仅供用户核对选的是哪个目录） */
  path: string;
}

export interface CreateRunFormState {
  mode: CreateRunMode;
  /** 本次操作选定的源目录；取消选择时保持原值 */
  source: ChosenSource | null;
  /** 本次操作的副本写入授权：恒为默认未选，必须本次显式勾选 */
  writesAuthorized: boolean;
}

/** 一次新的创建操作：默认纯对话、无目录、未授权 */
export function initialCreateRunForm(): CreateRunFormState {
  return { mode: "chat", source: null, writesAuthorized: false };
}

/**
 * 切换运行模式 = 开始一次新的隔离操作：目录选择与副本授权都作废。
 * systemPrompt / userMessage 是文本输入，不属于授权状态，由组件各自持有、不受影响。
 */
export function switchCreateRunMode(mode: CreateRunMode): CreateRunFormState {
  return { mode, source: null, writesAuthorized: false };
}

/**
 * 应用一次目录选择结果。
 * - 取消（`{canceled:true}`）：main 不签发 token ⇒ 状态原样不动（零写入、零请求）
 * - 成功：只落目录，**授权复位为未选** —— "选中目录"不是"允许写入"
 */
export function applyChosenSource(
  state: CreateRunFormState,
  result: ChooseSourceResult,
): CreateRunFormState {
  if (result.canceled) return state;
  return {
    ...state,
    source: { token: result.sourceToken, name: result.name, path: result.path },
    writesAuthorized: false,
  };
}

/** 勾选/取消本次副本写入授权（用户手动的唯一授权入口） */
export function setWritesAuthorized(
  state: CreateRunFormState,
  writesAuthorized: boolean,
): CreateRunFormState {
  return { ...state, writesAuthorized };
}

export interface CreateRunFormFields {
  systemPrompt: string;
  userMessage: string;
  /** 上一次提交是否仍在飞（执行中不得重复提交） */
  busy: boolean;
}

/**
 * 提交判据 + 请求构造（同一个函数，杜绝两处口径分叉）：
 * 不满足条件时给出可直接展示的中文原因，且**不产出请求** ⇒ 调用方不可能发出半截请求。
 *
 * `field` 是**就近呈现**的归属（U5 任务 4.2）：错误跟着它所属的字段走，而不是全堆在
 * 按钮上方一条横幅里。它只是同一份判据多带的一个键——组件不得据此再算一套"能不能提交"，
 * 也不得给一个 `field` 之外的情形凭空造错误。`null` = 不属于任何字段（执行中/门禁），
 * 由表单级的说明位承接。
 */
export type CreateRunFailureField = "userMessage" | "source" | "writesAuthorized";

export type CreateRunSubmission =
  | { ok: true; request: CreateRunRequest }
  | { ok: false; reason: string; field: CreateRunFailureField | null };

export function resolveCreateRunSubmission(
  state: CreateRunFormState,
  fields: CreateRunFormFields,
): CreateRunSubmission {
  if (fields.busy) {
    return {
      ok: false,
      reason: "执行中：本次运行尚未结束，不能重复提交",
      field: null,
    };
  }
  if (fields.userMessage.trim().length === 0) {
    return {
      ok: false,
      reason: "User Message 不能为空（它同时是该 run 的标题与首条用户消息）",
      field: "userMessage",
    };
  }

  if (state.mode === "isolated_files") {
    if (state.source === null) {
      return {
        ok: false,
        reason: "隔离文件运行需要先选择源目录（只读采集，源目录不会被修改）",
        field: "source",
      };
    }
    if (!state.writesAuthorized) {
      return {
        ok: false,
        reason: "请勾选“允许本次执行的副本写入”——授权只对这一次提交有效，不会从历史记录补授权",
        field: "writesAuthorized",
      };
    }
    return {
      ok: true,
      request: {
        systemPrompt: fields.systemPrompt,
        userMessage: fields.userMessage,
        workspace: {
          mode: "isolated_files",
          sourceToken: state.source.token,
          allowFileWrites: true,
        },
      },
    };
  }

  // 纯对话：请求里不出现 workspace 键（main 走空工具表 + v1 纯对话路径）
  return {
    ok: true,
    request: { systemPrompt: fields.systemPrompt, userMessage: fields.userMessage },
  };
}

/**
 * 拒绝的**就近归属**（U5 任务 4.2）：把一条拒绝分到它所属的输入框，其余留给表单级说明位。
 *
 * 组件只消费这个映射，不得自己再判一次"这条错该显示在哪儿"——那会变成第二份判据，
 * 与 `resolveCreateRunSubmission` 漂移。全 null = 没有任何拒绝。
 */
export interface CreateRunFieldErrors {
  readonly userMessage: string | null;
  readonly source: string | null;
  readonly writesAuthorized: string | null;
  /** 不属于任何字段的说明（执行中；调用方另可在此放门禁文案） */
  readonly form: string | null;
}

export function fieldErrorsOf(submission: CreateRunSubmission): CreateRunFieldErrors {
  const blank: CreateRunFieldErrors = {
    userMessage: null,
    source: null,
    writesAuthorized: null,
    form: null,
  };
  if (submission.ok) return blank;
  const { reason, field } = submission;
  return field === null ? { ...blank, form: reason } : { ...blank, [field]: reason };
}

/**
 * 重新进入创建工作区时的表单底稿（U5 任务 4.3）。
 *
 * 三条规则各有一处判据，都在这个函数里（此前它们散在组件的 `useState` 初始化里，
 * 只能靠源码字符串钉，改一行就静默失效）：
 * - **模式**跟着会话草稿走（离开再回来不丢已选模式）；
 * - **源目录引用**从 store 的 `createSourceRef` 恢复——它是 main 先前签发的 token，
 *   是否仍然有效**只由 main 在真正使用时判定**（渲染层不校时间戳，也不按路径重建引用）；
 * - **副本授权恒为未选**：spec「每次桌面操作独立确认写入」——引用可恢复，授权不可继承。
 */
export function restoreCreateForm(input: {
  draftMode: CreateRunMode | null | undefined;
  sourceRef: ChosenSource | null;
}): CreateRunFormState {
  return {
    mode: input.draftMode ?? "chat",
    source: input.sourceRef,
    writesAuthorized: false,
  };
}

/**
 * 提交：先过判据，再发请求。判据不过时**一次 IPC 都不发**
 * （用例据此断言"userMessage 为空 / 未授权时零请求"）。
 */
export async function submitCreateRun(
  state: CreateRunFormState,
  fields: CreateRunFormFields,
  deps: { createRun(request: CreateRunRequest): Promise<boolean> },
): Promise<boolean> {
  const submission = resolveCreateRunSubmission(state, fields);
  if (!submission.ok) return false;
  return deps.createRun(submission.request);
}
