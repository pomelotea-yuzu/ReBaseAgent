import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import {
  CREATE_RUN_ERROR_CODES,
  CreateRunError,
  ISOLATED_CREATE_ERROR_CODE,
  runCreate,
  runCreateIsolated,
} from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";

/**
 * U4 任务 2.7：main 创建路径的结构化身份（`CreateRunError.runId` + `onRunIdentified`）。
 *
 * 判据来源：tasks.md 2.7 + design D5「已核实的身份来源」；delta spec `desktop-ui`。
 * 验收场景（delta 逐字标题）：
 * - 「普通和隔离创建失败保留 ID」——模型失败但运行 meta/失败记录已写出时，
 *   异常上带的是**该记录的真实 id**（等于落盘文件名与 `readRun().meta.id`），
 *   且登记侧通过回调在同一次执行里拿到同一个 id；不解析异常文案；
 * - 「分叉在已知身份后异常仍可关联」的另一半（未写 meta 的前置拒绝不给身份）——
 *   隔离授权缺失 / 源边界被 A 拒 ⇒ 零回调、`runId` 为 undefined。
 *
 * 真跑 runLoop + MockLlmClient（仓库约定：不 mock runLoop，否则测不到 meta 落盘与改名）。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};
const SYSTEM = "你是简洁的问答助手。";
const TASK = "用一句话解释时间旅行调试。";

function tempPlain(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "create-identity-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function tempLayout(): { dataDir: string; source: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "create-identity-iso-"));
  const dataDir = join(root, "data");
  const source = join(root, "source");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  return { dataDir, source, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTree(dir: string, tree: Record<string, string>): void {
  for (const [path, content] of Object.entries(tree)) {
    const file = join(dir, path);
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, content);
  }
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

/** 目录内容的可辨认快照（用于断言"写入前的拒绝连文件都没多出"） */
function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("U4 2.7 普通创建的身份", () => {
  it("成功路径：回调恰一次、等于落盘 meta.id，且先于首次模型调用", async () => {
    const { traces, repo, cleanup } = tempPlain();
    try {
      const llm = new MockLlmClient([
        { content: "时间旅行调试=回到过去改一步再跑。", usage: { in: 8, out: 4 } },
      ]);
      const seen: { id: string; calls: number }[] = [];
      const result = await runCreate(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm,
          onRunIdentified: (id) => {
            seen.push({ id, calls: llm.requests.length });
          },
        },
        { systemPrompt: SYSTEM, userMessage: TASK },
      );
      expect(seen).toEqual([{ id: result.id, calls: 0 }]);
      expect(repo.loadRunRecord(result.id).meta.id).toBe(result.id);
      expect(jsonlFiles(traces)).toEqual([`${result.id}.jsonl`]);
    } finally {
      cleanup();
    }
  });

  it("模型失败：CreateRunError 结构化携带该失败记录的 id（不需要解析文案），且与回调同值", async () => {
    const { traces, repo, cleanup } = tempPlain();
    try {
      const seen: string[] = [];
      const error = await runCreate(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient([]),
          onRunIdentified: (id) => {
            seen.push(id);
          },
        },
        { systemPrompt: SYSTEM, userMessage: TASK },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CreateRunError);
      const failure = error as CreateRunError;
      expect(failure.code).toBe(CREATE_RUN_ERROR_CODES.RUN_FAILED);
      const landed = jsonlFiles(traces);
      expect(landed).toHaveLength(1);
      const fileId = (landed[0] ?? "").replace(/\.jsonl$/, "");
      // 三条身份必须互证：回调值 = 异常字段 = 落盘文件名 = 记录里的 meta.id
      expect(seen).toEqual([fileId]);
      expect(failure.runId).toBe(fileId);
      expect(repo.loadRunRecord(fileId).meta.id).toBe(fileId);
    } finally {
      cleanup();
    }
  });

  it("省略回调与回调抛错都不改变落盘（观察者不是新的失败原因）", async () => {
    const observed: { files: number; event: string }[] = [];
    for (const mode of ["absent", "throws"] as const) {
      const { traces, repo, cleanup } = tempPlain();
      try {
        const result = await runCreate(
          {
            repository: repo,
            settings: SETTINGS,
            execCwd: traces,
            llm: new MockLlmClient([{ content: "一步答完。", usage: { in: 5, out: 2 } }]),
            onRunIdentified:
              mode === "absent"
                ? undefined
                : () => {
                    throw new Error("观察者炸了");
                  },
          },
          { systemPrompt: SYSTEM, userMessage: TASK },
        );
        const record = repo.loadRunRecord(result.id);
        observed.push({
          files: jsonlFiles(traces).length,
          event: String(record.events.at(-1)?.event ?? record.status),
        });
      } finally {
        cleanup();
      }
    }
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[0]?.files).toBe(1);
  });
});

describe("U4 2.7 隔离创建的身份", () => {
  it("errored 终止：异常携带最终世界身份，等于落盘 meta.id 与 world_id", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const repo = new RunRepository(join(dataDir, "traces"));
      const seen: string[] = [];
      const error = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([
            { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
          ]),
          onRunIdentified: (id) => {
            seen.push(id);
          },
        },
        {
          systemPrompt: "",
          userMessage: "读一下 a.txt",
          workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: true },
        },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CreateRunError);
      const failure = error as CreateRunError;
      expect(failure.code).toBe(CREATE_RUN_ERROR_CODES.RUN_FAILED);
      const landed = jsonlFiles(join(dataDir, "traces"));
      expect(landed).toHaveLength(1);
      const fileId = (landed[0] ?? "").replace(/\.jsonl$/, "");
      expect(seen).toEqual([fileId]);
      expect(failure.runId).toBe(fileId);
      const record = repo.loadRunRecord(fileId);
      expect(record.meta.id).toBe(fileId);
      // 报告的是替换后的最终世界身份，不是 loop 自造的临时 id
      expect(record.meta.workspace?.world_id).toBe(fileId);
    } finally {
      cleanup();
    }
  });

  it("写入前的拒绝不给身份：授权形状不合法 ⇒ 零回调、runId undefined、零落盘", async () => {
    const { dataDir, source, cleanup } = tempLayout();
    try {
      writeTree(source, { "a.txt": "alpha" });
      const repo = new RunRepository(join(dataDir, "traces"));
      const tracesDir = join(dataDir, "traces");
      const before = listing(tracesDir);
      let seen = 0;
      const error = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([{ content: "不该被调用" }]),
          onRunIdentified: () => {
            seen += 1;
          },
        },
        {
          systemPrompt: "",
          userMessage: "读一下 a.txt",
          // 授权声明不是字面量 true：A 包在写任何文件之前拒绝
          workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: "true" } as never,
        },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CreateRunError);
      const failure = error as CreateRunError;
      expect(failure.code).toBe(ISOLATED_CREATE_ERROR_CODE);
      expect(failure.runId).toBeUndefined();
      expect(seen).toBe(0);
      expect(listing(tracesDir)).toEqual(before);
    } finally {
      cleanup();
    }
  });
});
