import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATA_DIR_FLAG,
  STARTUP_EXIT_CODE,
  type StartupRejectReason,
  parseStartupArgv,
} from "../src/startup.js";

/**
 * MCP0 4.1（S02）：启动期数据根核验。
 *
 * design D3 的判据是"缺一律拒、且绝不兜底"：这里逐条钉住拒绝原因与**不产生副作用**
 * （不建目录、不写文件），并钉住合法形态——空 `traces/` 合法（S01 的前半段）。
 */

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp0-startup-"));
  roots.push(dir);
  return dir;
}

function withTraces(dir: string): string {
  mkdirSync(join(dir, "traces"), { recursive: true });
  return dir;
}

let dataDir: string;
let tracesDir: string;
let notADir: string;
let noTraces: string;
let tracesIsFile: string;

beforeAll(() => {
  dataDir = withTraces(tempRoot());
  tracesDir = join(dataDir, "traces");
  notADir = join(tempRoot(), "run.jsonl");
  writeFileSync(notADir, "{}\n");
  noTraces = tempRoot();
  tracesIsFile = tempRoot();
  writeFileSync(join(tracesIsFile, "traces"), "不是目录\n");
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("parseStartupArgv：合法数据根", () => {
  it("--data-dir 指向已有目录且其下有 traces/ ⇒ 返回两个目录", () => {
    const outcome = parseStartupArgv([DATA_DIR_FLAG, dataDir]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.root).toEqual({ dataDir, tracesDir });
  });

  it("空 traces/ 合法（S01 前半段：没有 run 也照样是可用数据根）", () => {
    expect(readdirCount(tracesDir)).toBe(0);
    expect(parseStartupArgv([DATA_DIR_FLAG, dataDir]).ok).toBe(true);
  });
});

describe("parseStartupArgv：启动即失败（S02）", () => {
  it("缺参数 / 缺取值 / 空取值 ⇒ DATA_DIR_INVALID 固定码", () => {
    for (const argv of [[], [DATA_DIR_FLAG], [DATA_DIR_FLAG, ""]]) {
      const outcome = parseStartupArgv(argv);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe("DATA_DIR_INVALID");
      expect(outcome.reason).toBe("MISSING_DATA_DIR");
      expect(outcome.messageKey).toBe("mcp.startupMissingDataDir");
    }
  });

  it("相对路径拒绝（不猜当前目录，也不切换数据根）", () => {
    const outcome = parseStartupArgv([DATA_DIR_FLAG, "relative/data"]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("DATA_DIR_INVALID");
    expect(outcome.reason).toBe("DATA_DIR_NOT_ABSOLUTE");
  });

  it("不存在 / 是文件 / 没有 traces/ / traces 是文件 ⇒ 逐条可辨认原因", () => {
    const cases: Array<[readonly string[], StartupRejectReason]> = [
      [[DATA_DIR_FLAG, join(tempRoot(), "nope")], "DATA_DIR_MISSING"],
      [[DATA_DIR_FLAG, notADir], "DATA_DIR_NOT_DIRECTORY"],
      [[DATA_DIR_FLAG, noTraces], "TRACES_MISSING"],
      [[DATA_DIR_FLAG, tracesIsFile], "TRACES_NOT_DIRECTORY"],
    ];
    for (const [argv, reason] of cases) {
      const outcome = parseStartupArgv(argv);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe("DATA_DIR_INVALID");
      expect(outcome.reason).toBe(reason);
    }
  });

  it("多余参数与第二个数据根一律拒绝（不接受第二个数据根）", () => {
    for (const argv of [
      [DATA_DIR_FLAG, dataDir, "--verbose"],
      [DATA_DIR_FLAG, dataDir, DATA_DIR_FLAG, dataDir],
      [dataDir],
      ["--help"],
    ]) {
      expect(parseStartupArgv(argv).ok).toBe(false);
    }
  });

  it("拒绝原因不回显调用方给定的路径（日志与退出信息都不带用户参数）", () => {
    const secretish = join(tempRoot(), "用户目录");
    const outcome = parseStartupArgv([DATA_DIR_FLAG, secretish]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(JSON.stringify(outcome)).not.toContain(secretish);
  });

  it("核验失败不建目录、不写文件（无副作用）", () => {
    const empty = tempRoot();
    const outcome = parseStartupArgv([DATA_DIR_FLAG, empty]);
    expect(outcome.ok).toBe(false);
    expect(readdirCount(empty)).toBe(0);
  });

  it("退出码固定为非零（1.1 实机记录用的是 2）", () => {
    expect(STARTUP_EXIT_CODE).toBe(2);
  });
});

function readdirCount(dir: string): number {
  return readdirSync(dir).length;
}
