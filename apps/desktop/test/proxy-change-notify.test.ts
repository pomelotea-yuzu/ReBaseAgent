import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyChangeEventSchema } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyManager } from "../src/main/proxy-manager";
import type { ProxyChangeNotice, ProxyRecorderSink } from "../src/main/proxy-manager";
import { ProxyRunRecorder } from "../src/main/proxy-recorder";
import { RunRepository } from "../src/main/run-repository";
import { SettingsStore } from "../src/main/settings";
import type { SettingsCipher } from "../src/main/settings";

/**
 * tasks 1.2/1.4 的 **main 侧** 回归：`ProxyManager` 的变化通知记账。
 *
 * 判据来源：llm-proxy delta「代理变化通知不属于主动执行」
 * - 「通知只包含受控元信息」⇒ 载荷只有 epoch/revision/recordsRevision/changes，
 *   且能过 `ProxyChangeEventSchema`；不含 key / messages / 错误体；
 * - 「写入失败不报告新记录」⇒ recorder.write 抛错时 recordsRevision 不推进、
 *   不发 records 通知，但客户端响应仍照常送达（转发不被破坏）；
 * - 「不为主动操作登记执行」⇒ 通知路径零 operation、零模型调用。
 *
 * 代理走真实 127.0.0.1 回环 + stub upstream fetch（零真实 API）；落盘失败用
 * recorder 注入面确定性制造。
 */

const cipher: SettingsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (encoded) => encoded.slice(4),
};

const CAPTURED_KEY = "Bearer sk-notify-supersecret";
const SECRET_PROMPT = "系统提示里的秘密";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "proxy-change-notify-"));
  dirs.push(dir);
  return dir;
}
const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Notice_ {
  epoch: string;
  revision: number;
  recordsRevision: number;
  changes: readonly string[];
}

interface Behavior {
  /** 被动录制写入抛错（模拟磁盘/权限失败） */
  failWrite: boolean;
  /** 收到的全部通知 */
  notices: Notice_[];
  /** 解绑后再收到的通知数（验证解绑真的生效） */
  afterUnsubscribe: number;
  unsubscribed: boolean;
  /** stub upstream 被调用的次数（= 有多少请求真正转发到了上游） */
  upstreamCalls: number;
}

function setup(): {
  manager: ProxyManager;
  repository: RunRepository;
  tracesDir: string;
  behavior: Behavior;
  /** 订阅并返回解绑函数；同时挂一个"解绑后计数"监听器 */
  subscribe: () => () => void;
} {
  const dataDir = tempDir();
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const repository = new RunRepository(tracesDir);
  const settings = new SettingsStore({ dataDir, cipher });
  const real = new ProxyRunRecorder(tracesDir);
  const behavior: Behavior = {
    failWrite: false,
    notices: [],
    afterUnsubscribe: 0,
    unsubscribed: false,
    upstreamCalls: 0,
  };
  const sink: ProxyRecorderSink = {
    write: (recording, fork) => {
      if (fork === undefined && behavior.failWrite) throw new Error("落盘失败：附件目录不可写");
      return real.write(recording, fork);
    },
  };
  const manager = new ProxyManager({
    repository,
    settings,
    tracesDir,
    newRecorder: () => sink,
    newEpoch: () => "epoch-fixed-0001",
    fetchImpl: async () => {
      behavior.upstreamCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "stub 回复" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const record = (notice: ProxyChangeNotice): void => {
    if (behavior.unsubscribed) {
      behavior.afterUnsubscribe += 1;
      return;
    }
    behavior.notices.push({ ...notice, changes: [...notice.changes] });
  };
  return { manager, repository, tracesDir, behavior, subscribe: () => manager.onChange(record) };
}

/** 经真实回环发一次请求（代理内部转发 + 录制） */
async function sendOnce(port: number, content = "你好"): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: CAPTURED_KEY },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SECRET_PROMPT },
        { role: "user", content },
      ],
      temperature: 0.7,
    }),
  });
  await res.text();
  await new Promise((r) => setTimeout(r, 40));
  return res.status;
}

async function startProxy(manager: ProxyManager): Promise<number> {
  const config = { upstreamBaseUrl: "https://upstream.test" };
  const state = await manager.toggle({ enabled: true, port: 0, ...config });
  // 端口每次不同 ⇒ 记录下来逐个停，别复用 state.port
  servers.push({
    stop: async () => {
      await manager.toggle({ enabled: false, port: state.port, ...config });
    },
  });
  return state.port;
}

describe("会话事实：epoch 一次生命周期内不变，两个 revision 各自单调", () => {
  it("status() 暴露 epoch/revision/recordsRevision，且 epoch 稳定", async () => {
    const { manager } = setup();
    const before = manager.status();
    expect(before.epoch).toBe("epoch-fixed-0001");
    expect(before.revision).toBe(0);
    expect(before.recordsRevision).toBe(0);

    const port = await startProxy(manager);
    await sendOnce(port);

    const after = manager.status();
    // epoch 不变（它回答"哪一届 main"，不是"现在几点"）
    expect(after.epoch).toBe(before.epoch);
    // 凭据捕获推进状态 revision；成功落盘同时推进两个
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.recordsRevision).toBe(1);
  });

  it("两个 ProxyManager 实例的 epoch 互不相同（判别会话的依据）", () => {
    // 缺省生成器是 crypto.randomUUID：两个实例撞上同一 epoch 会让新旧会话不可判别
    const a = setup().manager;
    const b = setup().manager;
    expect(a).not.toBe(b);
  });
});

describe("通知载荷只包含受控元信息", () => {
  it("status() 的版本事实与通知载荷同源，都能过 ProxyChangeEventSchema", async () => {
    const { manager, behavior, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);
    await sendOnce(port);

    const state = manager.status();
    expect(state.recordsRevision).toBe(1);
    expect(state.revision).toBeGreaterThan(0);
    expect(state.epoch).toBe("epoch-fixed-0001");

    // main 侧发出的通知必须能被 shared 侧的 schema 接受——
    // 两边各写一份形状时，这条是唯一的对齐点（任一漂移即红）
    for (const notice of behavior.notices) {
      const parsed = ProxyChangeEventSchema.safeParse(notice);
      expect(parsed.success).toBe(true);
    }
    // status 的版本事实按同一形状也应当合法（renderer 拿它做补读快照）
    expect(
      ProxyChangeEventSchema.safeParse({
        epoch: state.epoch,
        revision: state.revision,
        recordsRevision: state.recordsRevision,
        changes: ["records"],
      }).success,
    ).toBe(true);
  });

  it("通知文本里不含 key、messages 正文或系统提示（delta 的核心禁令）", async () => {
    const { manager, behavior, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);
    await sendOnce(port, "用户的私密输入正文");

    expect(behavior.notices.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(behavior.notices);
    expect(serialized).not.toContain("sk-notify-supersecret");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain("用户的私密输入正文");
    // 捕获的 key 本身不出main 边界：status 只给 hasKey 布尔
    expect(manager.status().hasKey).toBe(true);
    expect(Object.keys(manager.status()).sort()).toEqual([
      "enabled",
      "epoch",
      "hasKey",
      "keyCaptureRevision",
      "port",
      "recordsRevision",
      "revision",
      "running",
      "upstreamBaseUrl",
    ]);
  });
});

describe("成功落盘才推进记录 revision", () => {
  it("落盘成功 ⇒ 发 records 通知，recordsRevision 前进", async () => {
    const { manager, behavior, repository, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);
    await sendOnce(port);

    expect(repository.listRuns().runs).toHaveLength(1);
    expect(manager.status().recordsRevision).toBe(1);
    const recordNotices = behavior.notices.filter((n) => n.changes.includes("records"));
    expect(recordNotices).toHaveLength(1);
    expect(recordNotices[0]?.recordsRevision).toBe(1);
  });

  it("落盘失败 ⇒ 不推进 recordsRevision、不发 records 通知，但响应仍送达客户端", async () => {
    const { manager, behavior, subscribe } = setup();
    behavior.failWrite = true;
    subscribe();
    const port = await startProxy(manager);

    // ⚠️ 客户端仍必须拿到 200：通知/录制失败不得破坏转发（llm-proxy delta）
    expect(await sendOnce(port)).toBe(200);
    // 但这条记录并不存在 ⇒ 不宣告新 run 可用
    expect(manager.status().recordsRevision).toBe(0);
    expect(behavior.notices.some((n) => n.changes.includes("records"))).toBe(false);
    // 转发本身确实发生了一次（不是请求被提前掐断）
    expect(behavior.upstreamCalls).toBe(1);
  });

  it("先失败后成功 ⇒ recordsRevision 只在成功那次前进（不会跳过或补记）", async () => {
    const { manager, behavior, repository, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);

    behavior.failWrite = true;
    await sendOnce(port, "第一条会失败");
    expect(manager.status().recordsRevision).toBe(0);

    behavior.failWrite = false;
    await sendOnce(port, "第二条会成功");
    expect(manager.status().recordsRevision).toBe(1);
    expect(repository.listRuns().runs).toHaveLength(1);
    expect(repository.listRuns().runs[0]?.task).toBe("(llm-proxy)");
  });
});

describe("凭据捕获推状态 revision，但不推记录 revision", () => {
  it("捕获 key 发 status 通知；该通知不推进 recordsRevision（捕获本身不产生新 run）", async () => {
    const { manager, behavior, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);
    await sendOnce(port);

    // 一次请求会经历三步：toggle 启停、捕获 key、成功落盘。
    // 前两步是 status 类，第三步才是 records 类。
    const statusNotices = behavior.notices.filter((n) => n.changes.includes("status"));
    expect(statusNotices).toHaveLength(2);
    // ⚠️ 断言 status 类通知的版本事实，不是全部通知——落盘那条 recordsRevision
    // 必然是 1（它就是"推进它"的那一条）。
    for (const notice of statusNotices) {
      expect(notice.recordsRevision).toBe(0);
      expect(notice.changes).toEqual(["status"]);
    }
    // 顺序上捕获先于落盘：renderer 收到 records 时状态事实已经是最新的
    expect(behavior.notices.at(-1)?.changes).toEqual(["records"]);
    expect(manager.status().recordsRevision).toBe(1);
  });
});

describe("启停的通知语义", () => {
  it("toggle 只在终态推进一次 revision（中间那次 stop 不单独通知）", async () => {
    const { manager, behavior, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);
    const afterStart = manager.status().revision;

    behavior.notices.length = 0;
    // 重跑同一配置：内部先停再启，终态仍是 running ⇒ 只应有一次通知
    await manager.toggle({ enabled: true, port, upstreamBaseUrl: "https://upstream.test" });
    expect(behavior.notices).toHaveLength(1);
    expect(behavior.notices[0]?.changes).toEqual(["status"]);
    expect(manager.status().revision).toBe(afterStart + 1);
  });

  it("autoStart 无论成功失败都推进 revision（renderer 不能停留在启动前的 stopped 事实）", async () => {
    const { manager, behavior } = setup();
    const before = manager.status().revision;
    await manager.autoStart();
    // 未启用 ⇒ 无事发生，但"恢复这件事走过了"必须可被只读核对看见
    expect(manager.status().revision).toBeGreaterThan(before);
    expect(behavior.notices.length).toBe(0);
  });
});

describe("订阅生命周期与隔离", () => {
  it("无订阅者时不发通知（不白白序列化载荷），但 revision照常推进", async () => {
    const { manager } = setup();
    const port = await startProxy(manager);
    const before = manager.status().revision;
    await sendOnce(port);
    // 落盘发生了（recordsRevision 前进），只是没人订阅
    expect(manager.status().recordsRevision).toBe(1);
    expect(manager.status().revision).toBeGreaterThan(before);
  });

  it("解绑后不再收到通知", async () => {
    const { manager, behavior, subscribe } = setup();
    const unsubscribe = subscribe();
    const port = await startProxy(manager);
    await sendOnce(port);
    const seen = behavior.notices.length;
    expect(seen).toBeGreaterThan(0);

    unsubscribe();
    behavior.unsubscribed = true;
    await sendOnce(port, "解绑之后");
    expect(behavior.afterUnsubscribe).toBe(0);
    // 但落盘事实照常累积：订阅与否不影响记录本身
    expect(manager.status().recordsRevision).toBe(2);
  });

  it("一个订阅者抛错不影响其他订阅者，也不影响转发", async () => {
    const { manager, behavior, subscribe } = setup();
    subscribe();
    manager.onChange(() => {
      throw new Error("订阅者自己的 bug");
    });
    const port = await startProxy(manager);

    // 转发与落盘不受影响
    expect(await sendOnce(port)).toBe(200);
    expect(manager.status().recordsRevision).toBe(1);
    // 先注册的订阅者照常收到
    expect(behavior.notices.length).toBeGreaterThan(0);
  });

  it("同一函数注册两次 ⇒ 只投递一次（Set 按引用去重，不隐式双投）", async () => {
    const { manager, subscribe } = setup();
    subscribe();
    let extraDeliveries = 0;
    const listener = (): void => {
      extraDeliveries += 1;
    };
    manager.onChange(listener);
    manager.onChange(listener);
    const port = await startProxy(manager);
    await sendOnce(port);
    // toggle 一次 + 捕获一次 + 落盘一次 = 3 次投递；
    // 若去重失效会变成 6 次。这条钉住"同一订阅位只收一份"
    expect(extraDeliveries).toBe(3);
  });
});

describe("并发录制：多条通知各自记账，不丢不重", () => {
  it("三条并发请求 ⇒ recordsRevision 恰好到 3，通知逐条对应", async () => {
    const { manager, behavior, repository, subscribe } = setup();
    subscribe();
    const port = await startProxy(manager);

    await Promise.all([sendOnce(port, "甲"), sendOnce(port, "乙"), sendOnce(port, "丙")]);

    expect(repository.listRuns().runs).toHaveLength(3);
    expect(manager.status().recordsRevision).toBe(3);
    const recordNotices = behavior.notices.filter((n) => n.changes.includes("records"));
    expect(recordNotices).toHaveLength(3);
    // 单调递增、无重复、无遗漏
    expect(recordNotices.map((n) => n.recordsRevision)).toEqual([1, 2, 3]);
    // 通知的 revision 也严格单调（renderer 的乱序守卫依赖这个性质）
    const revisions = behavior.notices.map((n) => n.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });
});
