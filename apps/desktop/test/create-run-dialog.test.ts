import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import {
  FILE_TOOLS_V1_DEFINITIONS,
  FILE_TOOLS_V1_PROFILE,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from "@rebaseagent/replay";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { runCreate, runCreateIsolated } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import {
  ISOLATED_TOOL_NAMES,
  ISOLATED_TOOL_PROFILE_LABEL,
  applyChosenSource,
  initialCreateRunForm,
  resolveCreateRunSubmission,
  setWritesAuthorized,
  submitCreateRun,
  switchCreateRunMode,
} from "../src/renderer/src/lib/create-run";
import type { CreateRunFormFields } from "../src/renderer/src/lib/create-run";
import { CreateRunRequestSchema } from "../src/shared/ipc";
import type { ChooseSourceResult, CreateRunRequest } from "../src/shared/ipc";

/**
 * B 任务 2.1：新建运行对话框的模式 / 目录 / 副本授权 / 提交状态。
 *
 * 覆盖场景（change add-sandboxed-rerun-desktop，specs/desktop-ui）：
 * - `新建 run 成功`（默认纯对话：请求不带 workspace、真跑出 v1）
 * - `userMessage 为空时禁用提交`（拒绝 + 对照成对）
 * - `空 systemPrompt 允许`（两种模式都放行；隔离按空串 + 固定工具组算指纹）
 * - `每次桌面操作独立确认写入`（每次会话/每次模式切换都作废目录与授权；选目录 ≠ 授权）
 * - `直接创建隔离文件父本`（对话框构造的请求 → zod → 真跑隔离创建：v2 根 run、源目录字节不变）
 *
 * 判据全部落在 `src/renderer/src/lib/create-run.ts`（纯函数），因此可在 node 环境
 * 直接测（本包 vitest 无 jsdom）；组件只消费同一函数，不另写一套判据。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

const SYSTEM = "你是一个简洁的问答助手，用两三句话回答。";
const TASK = "用一句话解释什么是时间旅行调试。";

/** 收集被发出的请求，用于断言"判据不过时零请求" */
function recorder(): {
  requests: CreateRunRequest[];
  createRun: (r: CreateRunRequest) => Promise<boolean>;
} {
  const requests: CreateRunRequest[] = [];
  return {
    requests,
    createRun: async (request) => {
      requests.push(request);
      return true;
    },
  };
}

const fields = (over: Partial<CreateRunFormFields> = {}): CreateRunFormFields => ({
  systemPrompt: SYSTEM,
  userMessage: TASK,
  busy: false,
  ...over,
});

function chosenSource(path: string, token = "tok_1"): ChooseSourceResult {
  return {
    canceled: false,
    sourceToken: token,
    name: "source",
    path,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

/** 源目录与数据目录必须互为兄弟（A 的 validateSourceRoot 拒绝嵌套） */
function tempLayout(): { dataDir: string; source: string; traces: string; cleanup: () => void } {
  const outer = mkdtempSync(join(tmpdir(), "create-run-dialog-"));
  const dataDir = join(outer, "data");
  const source = join(outer, "source");
  const traces = join(dataDir, "traces");
  mkdirSync(traces, { recursive: true });
  mkdirSync(source, { recursive: true });
  return {
    dataDir,
    source,
    traces,
    cleanup: () => rmSync(outer, { recursive: true, force: true }),
  };
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

/** 源目录树指纹（相对路径 + 内容哈希）——"源目录字节不变"的判据 */
function treeFingerprint(dir: string): string {
  const acc: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    acc.push(`${name} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
  }
  return acc.join("\n");
}

const readCall = (id: string, path: string) => ({
  id,
  name: READ_FILE_TOOL_NAME,
  args: JSON.stringify({ path }),
});

describe("2.1 默认纯对话：请求里没有 workspace（main 走空工具表 + v1）", () => {
  it("初始表单 = 纯对话 / 无目录 / 未授权；请求只有 systemPrompt 与 userMessage 两个键", () => {
    const form = initialCreateRunForm();
    expect(form).toEqual({ mode: "chat", source: null, writesAuthorized: false });

    const submission = resolveCreateRunSubmission(form, fields());
    expect(submission.ok).toBe(true);
    if (!submission.ok) return;
    // 刻意不是 `workspace: undefined`：用"键不存在"表达"非隔离"，避免两种读法
    expect("workspace" in submission.request).toBe(false);
    expect(Object.keys(submission.request).sort()).toEqual(["systemPrompt", "userMessage"]);
    // 经 main 的 zod 后仍是纯对话形状
    const parsed = CreateRunRequestSchema.safeParse(submission.request);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workspace).toBeUndefined();
  });

  it("真跑：对话框构造的请求 → zod → runCreate，落 v1 根 run 且指纹按空工具表算", async () => {
    const { traces, cleanup } = tempLayout();
    try {
      const submission = resolveCreateRunSubmission(initialCreateRunForm(), fields());
      if (!submission.ok) throw new Error("默认纯对话应放行");
      const parsed = CreateRunRequestSchema.parse(submission.request);

      const repo = new RunRepository(traces);
      const { id } = await runCreate(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient([{ content: "时间旅行调试是…", usage: { in: 10, out: 5 } }]),
        },
        parsed,
      );

      const record = repo.loadRunRecord(id);
      expect(record.meta.format_version).toBe(1);
      expect(record.meta.parent).toBeNull();
      expect(record.meta.fork).toBeNull();
      // 空工具表：指纹与 configHash(systemPrompt, []) 逐字节一致
      expect(record.meta.config_hash).toBe(configHash(SYSTEM, []));
      // 隔离元数据必须完全不出现（新形态不渗入原形态）
      expect(record.meta.workspace).toBeUndefined();
      expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);
    } finally {
      cleanup();
    }
  });

  it("空 systemPrompt 允许：两种模式都放行，且请求里 systemPrompt 为空串", () => {
    const blank = fields({ systemPrompt: "" });
    const chat = resolveCreateRunSubmission(initialCreateRunForm(), blank);
    expect(chat.ok).toBe(true);

    const ready = setWritesAuthorized(
      applyChosenSource(switchCreateRunMode("isolated_files"), chosenSource("D:\\lab\\source")),
      true,
    );
    const isolated = resolveCreateRunSubmission(ready, blank);
    expect(isolated.ok).toBe(true);
    if (!chat.ok || !isolated.ok) return;
    expect(chat.request.systemPrompt).toBe("");
    expect(isolated.request.systemPrompt).toBe("");
  });
});

describe("2.1 userMessage 为空时禁用提交（拒绝 + 对照成对）", () => {
  it("空串与纯空白都拒绝，且一次 IPC 都不发", async () => {
    for (const value of ["", "   ", "\n\t"]) {
      const rec = recorder();
      const submission = resolveCreateRunSubmission(
        initialCreateRunForm(),
        fields({ userMessage: value }),
      );
      expect(submission.ok).toBe(false);
      expect(submission.ok ? "" : submission.reason).toContain("User Message");

      const created = await submitCreateRun(
        initialCreateRunForm(),
        fields({ userMessage: value }),
        rec,
      );
      expect(created).toBe(false);
      expect(rec.requests).toEqual([]);
    }
  });

  it("对照：同样的表单填了 userMessage 就放行并发出请求（不是把所有输入都拒了）", async () => {
    const rec = recorder();
    const created = await submitCreateRun(initialCreateRunForm(), fields(), rec);
    expect(created).toBe(true);
    expect(rec.requests).toHaveLength(1);
    expect(rec.requests[0]?.userMessage).toBe(TASK);
  });

  it("执行中不得重复提交：busy 时判据不过且零请求", async () => {
    const rec = recorder();
    const submission = resolveCreateRunSubmission(initialCreateRunForm(), fields({ busy: true }));
    expect(submission.ok).toBe(false);
    expect(submission.ok ? "" : submission.reason).toContain("执行中");

    const created = await submitCreateRun(initialCreateRunForm(), fields({ busy: true }), rec);
    expect(created).toBe(false);
    expect(rec.requests).toEqual([]);
  });
});

describe("2.1 隔离模式：目录、副本授权与「每次操作独立确认」", () => {
  it("切到隔离模式即无目录、未授权；未选目录时禁用提交并给出原因", async () => {
    const form = switchCreateRunMode("isolated_files");
    expect(form).toEqual({ mode: "isolated_files", source: null, writesAuthorized: false });

    const submission = resolveCreateRunSubmission(form, fields());
    expect(submission.ok).toBe(false);
    expect(submission.ok ? "" : submission.reason).toContain("源目录");

    const rec = recorder();
    expect(await submitCreateRun(form, fields(), rec)).toBe(false);
    expect(rec.requests).toEqual([]);
  });

  it("选中目录 ≠ 授权：落目录的同时把授权复位为未选", async () => {
    const isolated = switchCreateRunMode("isolated_files");
    const after = applyChosenSource(isolated, chosenSource("D:\\lab\\source"));
    expect(after.source).toEqual({
      token: "tok_1",
      name: "source",
      path: "D:\\lab\\source",
    });
    expect(after.writesAuthorized).toBe(false);

    const submission = resolveCreateRunSubmission(after, fields());
    expect(submission.ok).toBe(false);
    expect(submission.ok ? "" : submission.reason).toContain("副本写入");

    const rec = recorder();
    expect(await submitCreateRun(after, fields(), rec)).toBe(false);
    expect(rec.requests).toEqual([]);
  });

  it("取消目录选择不改变任何状态（main 不签发 token ⇒ 零写入零请求）", () => {
    const isolated = switchCreateRunMode("isolated_files");
    // 已选过一次目录后再次打开选择器又取消：保留原选择，不产生新 token
    const after = applyChosenSource(isolated, chosenSource("D:\\lab\\source", "tok_1"));
    expect(applyChosenSource(after, { canceled: true })).toBe(after);
    // 从未选择时取消：仍是"无目录"
    expect(applyChosenSource(isolated, { canceled: true })).toBe(isolated);
  });

  it("本次显式勾选后放行：workspace 是 strict 三键形状，allowFileWrites 为布尔 true", () => {
    const ready = setWritesAuthorized(
      applyChosenSource(switchCreateRunMode("isolated_files"), chosenSource("D:\\lab\\source")),
      true,
    );
    const submission = resolveCreateRunSubmission(ready, fields());
    expect(submission.ok).toBe(true);
    if (!submission.ok) return;

    expect(submission.request.workspace).toEqual({
      mode: "isolated_files",
      sourceToken: "tok_1",
      allowFileWrites: true,
    });
    // strict：多一个键就会被 main 拒（配额覆盖 / handler 注入的防护面）
    const parsed = CreateRunRequestSchema.safeParse(submission.request);
    expect(parsed.success).toBe(true);
    expect(Object.keys(submission.request.workspace ?? {}).sort()).toEqual([
      "allowFileWrites",
      "mode",
      "sourceToken",
    ]);
    expect(
      CreateRunRequestSchema.safeParse({
        ...submission.request,
        workspace: { ...submission.request.workspace, quotaOverride: { maxTotalBytes: 1 } },
      }).success,
    ).toBe(false);
  });

  it("每次桌面操作独立确认：重新打开对话框 / 切换模式后，授权与目录都作废", async () => {
    // 第一次会话：选目录 → 勾选 → 可提交
    const first = setWritesAuthorized(
      applyChosenSource(switchCreateRunMode("isolated_files"), chosenSource("D:\\lab\\source")),
      true,
    );
    const firstSubmission = resolveCreateRunSubmission(first, fields());
    expect(firstSubmission.ok).toBe(true);

    // 第二次会话（重新打开对话框）：全新状态，必须重新选择与勾选
    const reopened = initialCreateRunForm();
    expect(reopened.mode).toBe("chat");
    expect(reopened.source).toBeNull();
    expect(reopened.writesAuthorized).toBe(false);
    const reopenedIsolated = switchCreateRunMode("isolated_files");
    const rec = recorder();
    expect(await submitCreateRun(reopenedIsolated, fields(), rec)).toBe(false);
    expect(rec.requests).toEqual([]);

    // 第二次会话重新选目录（新 token）：授权仍默认未选 —— 授权不从历史补
    const second = applyChosenSource(reopenedIsolated, chosenSource("D:\\lab\\source", "tok_2"));
    expect(second.writesAuthorized).toBe(false);
    expect(await submitCreateRun(second, fields(), recorder())).toBe(false);

    // 模式来回切换同样作废已勾选的授权与已选目录
    const switchedAway = switchCreateRunMode("chat");
    const switchedBack = switchCreateRunMode("isolated_files");
    expect(switchedAway.source).toBeNull();
    expect(switchedBack).toEqual({ mode: "isolated_files", source: null, writesAuthorized: false });
  });
});

describe("2.1 直接创建隔离文件父本（对话框请求 → zod → 隔离编排）", () => {
  it("落 v2 根 run、指纹按固定工具组算、源目录逐字节不变", async () => {
    const { dataDir, source, traces, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha 内容", "keep.txt": "keep" });

      // 对话框侧的请求（勾选授权后）
      const form = setWritesAuthorized(
        applyChosenSource(switchCreateRunMode("isolated_files"), chosenSource(source)),
        true,
      );
      const submission = resolveCreateRunSubmission(form, fields());
      if (!submission.ok) throw new Error("勾选授权后应放行");
      const parsed = CreateRunRequestSchema.parse(submission.request);
      const workspace = parsed.workspace;
      if (workspace === undefined) throw new Error("隔离请求必须带 workspace");

      // main 侧：token 换出真实路径（测试直接代入 source）
      const repo = new RunRepository(traces);
      const before = treeFingerprint(source);
      const { id } = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }]),
        },
        { systemPrompt: parsed.systemPrompt, userMessage: parsed.userMessage, workspace },
      );

      const record = repo.loadRunRecord(id);
      expect(record.meta.format_version).toBe(2);
      expect(record.meta.parent).toBeNull();
      expect(record.meta.workspace?.profile).toBe(FILE_TOOLS_V1_PROFILE);
      expect(record.meta.workspace?.world_id).toBe(id);
      // 隔离模式的指纹 = configHash(systemPrompt, 固定 file-tools-v1 工具组)
      expect(record.meta.config_hash).toBe(configHash(SYSTEM, [...FILE_TOOLS_V1_DEFINITIONS]));
      // 列表可见（结束后文件名 = meta.id）
      expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);
      // 源目录逐字节不变
      expect(treeFingerprint(source)).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("空 systemPrompt 的隔离根：指纹按空串 + 固定工具组计算", async () => {
    const { dataDir, source, traces, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const form = setWritesAuthorized(
        applyChosenSource(switchCreateRunMode("isolated_files"), chosenSource(source)),
        true,
      );
      const submission = resolveCreateRunSubmission(form, fields({ systemPrompt: "" }));
      if (!submission.ok) throw new Error("空 systemPrompt 应放行");
      const parsed = CreateRunRequestSchema.parse(submission.request);
      if (parsed.workspace === undefined) throw new Error("隔离请求必须带 workspace");

      const repo = new RunRepository(traces);
      const { id } = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([{ toolCalls: [readCall("c1", "a.txt")] }, { content: "完成。" }]),
        },
        {
          systemPrompt: parsed.systemPrompt,
          userMessage: parsed.userMessage,
          workspace: parsed.workspace,
        },
      );

      expect(repo.loadRunRecord(id).meta.config_hash).toBe(
        configHash("", [...FILE_TOOLS_V1_DEFINITIONS]),
      );
    } finally {
      cleanup();
    }
  });
});

describe("2.1 展示文案不漂移（渲染层不 import replay）", () => {
  it("隔离模式的 tool 名与 profile 名等于 replay 的固定契约", () => {
    expect(ISOLATED_TOOL_PROFILE_LABEL).toBe(FILE_TOOLS_V1_PROFILE);
    expect([...ISOLATED_TOOL_NAMES]).toEqual([READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME]);
  });
});

/**
 * U5（unify-run-execution-workflow）任务 4.2：每条拒绝都**点名归属字段**。
 *
 * 就近呈现要求每个错误跟着自己的字段走，而归属只能来自同一份提交判据——
 * 组件不得自己再算一套"哪条错属于哪个框"。`null` = 不属于任何字段（执行中），
 * 由表单级说明位承接。视图侧的能力断言见 `test/create-form-view.test.ts`。
 */
function rejection(sub: ReturnType<typeof resolveCreateRunSubmission>): string {
  return sub.ok ? "（放行了，本用例只判拒绝）" : `${sub.field ?? "<无归属>"}`;
}

describe("U5 4.2 拒绝的字段归属（就近呈现的唯一依据）", () => {
  it("四类拒绝各自点名；同一表单补齐后即放行且 ok 分支不带归属键", () => {
    expect(
      rejection(resolveCreateRunSubmission(initialCreateRunForm(), fields({ userMessage: "" }))),
    ).toBe("userMessage");
    const isolated = switchCreateRunMode("isolated_files");
    expect(rejection(resolveCreateRunSubmission(isolated, fields()))).toBe("source");
    expect(
      rejection(
        resolveCreateRunSubmission(
          applyChosenSource(isolated, chosenSource("D:\\lab\\src")),
          fields(),
        ),
      ),
    ).toBe("writesAuthorized");
    // 执行中不属于任何字段（它是这一次提交的状态，不是某个输入框的问题）
    expect(
      rejection(resolveCreateRunSubmission(initialCreateRunForm(), fields({ busy: true }))),
    ).toBe("<无归属>");

    const passed = resolveCreateRunSubmission(initialCreateRunForm(), fields());
    expect(passed.ok).toBe(true);
    // 放行分支的键集合钉死：不加 field、也不带 workspace
    expect(Object.keys(passed).sort()).toEqual(["ok", "request"]);
  });

  it("归属只说明「错在哪个框」，不改写拒绝理由本身", () => {
    const sub = resolveCreateRunSubmission(initialCreateRunForm(), fields({ userMessage: "  " }));
    expect(sub.ok).toBe(false);
    // 文案与 U3/B 时代逐字相同（就近的是位置，不是话术）
    expect(sub.ok ? "" : sub.reason).toBe(
      "User Message 不能为空（它同时是该 run 的标题与首条用户消息）",
    );
  });
});
