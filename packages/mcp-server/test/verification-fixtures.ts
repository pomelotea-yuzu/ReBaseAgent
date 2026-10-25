import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
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
import { NODE_TS_V1_PROFILE } from "@rebaseagent/project-verification/schema";
import { publishAsset } from "@rebaseagent/project-verification";
import {
  type PreparationMetaInput,
  PreparationRecordWriter,
  VerificationRecordWriter,
} from "@rebaseagent/project-verification";
import { JsonlTracer } from "@rebaseagent/trace-sdk";

/**
 * MCP2 tasks 1.3：验证查询的记录与故障 fixture（**独立数据根**，不与 MCP1 夹具共用）。
 *
 * 纪律（与 query-fixtures.ts 同源）：
 * - 记录一律经 `VerificationRecordWriter`/`PreparationRecordWriter` 真写、附件经
 *   `publishAsset` 内容寻址发布——手写 JSONL 会绕过读取层判据，造出「桌面读不出但
 *   MCP 测得过」的假对象。仅两类**故意损坏**例外（坏尾行/未知版本），它们本身就是
 *   被测对象，与 R3 reader.test.ts 同手法；
 * - 每条记录有名字可指认（下表），3.x/4.x/5.1 按场景取用，不互借形状；
 * - 旧 environment 缺项、来源 trace 缺失、capture 截断、歧义命令、冲突清单、
 *   残留 runtime 登记与未封存记录都各有一条独立记录或独立根内事实。
 *
 * | id                | 状态                | 用途（场景）                     |
 * |-------------------|---------------------|----------------------------------|
 * | ver-m2-pass       | sealed/passed       | 通过样本；同条件对右翼（M14/M19）|
 * | ver-m2-fail       | sealed/check_failed | 失败样本；capture 截断（M10/M14）|
 * | ver-m2-oldenv     | sealed/passed       | 旧记录缺 environment（M04/M15）  |
 * | ver-m2-unterm     | unterminated        | 中断+interrupted（M05/M17）      |
 * | ver-m2-badtail    | corrupt             | 坏尾（M05）                      |
 * | ver-m2-oldver     | unsupported_version | 未知版本（M03/M05）              |
 * | ver-m2-dupcmd     | sealed（重复 end）  | 歧义命令定位（M08）              |
 * | ver-m2-missasset  | sealed，附件缺失    | ASSET_MISSING（M09）             |
 * | ver-m2-corrupt    | sealed，附件被改    | ASSET_CORRUPT（M09/M12）         |
 * | ver-m2-duppath    | sealed，清单重路径  | 冲突产物清单（M08/M09）          |
 * | ver-m2-gone       | sealed，来源缺失    | sourceStatus=missing（M07）      |
 *
 * 零执行/零写入探针（M17/5.1 用）：
 * - `snapshotRootFingerprint`/`assertRootUnchanged`：整根递归（相对路径+size+sha256）
 *   前后比对，注入在**基线之前**完成，注入自身不算查询的写入；
 * - 根内预置残留 `verification-runtime/owner-m2.json` 与未封存记录：真实 stdio 全链
 *   跑完后两者必须逐字未动——查询既不核查清理、也不补写终止；
 * - 「执行/模型/导出/登记调用为零」的计数探针属于实机取证（Docker/进程表），在
 *   5.1/5.3 的真实 stdio 与真实客户端轮次做，fixture 无法在本进程内度量。
 */

const T0 = "2026-10-25T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

const ROOTS: string[] = [];

/** 测试进程退出后清理临时根（vitest 单进程；独立根不与其它批次共享） */
export function cleanupVerificationFixtures(): void {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
}

export const VERIFICATION_FIXTURE_IDS = {
  pass: "ver-m2-pass",
  fail: "ver-m2-fail",
  oldEnv: "ver-m2-oldenv",
  unterm: "ver-m2-unterm",
  badTail: "ver-m2-badtail",
  oldVersion: "ver-m2-oldver",
  dupCommand: "ver-m2-dupcmd",
  missingAsset: "ver-m2-missasset",
  corruptAsset: "ver-m2-corrupt",
  dupPath: "ver-m2-duppath",
  goneSource: "ver-m2-gone",
} as const;

/** 正文 canary：白名单/脱敏判据把结果序列化后逐个搜这些标记（与 SENTINELS 同纪律） */
export const VERIFICATION_SENTINELS = {
  passStdout: "SENTINEL-pass-stdout-中文✅",
  failStdoutPrefix: "SENTINEL-fail-stdout-",
  stderrText: "SENTINEL-stderr-行",
  artifactText: "SENTINEL-artifact-正文",
  secretInLog: "api-key: SENTINEL-secret-in-log",
} as const;

export interface VerificationFixture {
  readonly dataRoot: string;
  readonly tracesDir: string;
  readonly assetsDir: string;
  readonly ids: typeof VERIFICATION_FIXTURE_IDS;
  /** 关键附件哈希：日志/产物读取场景直接引用 */
  readonly hashes: {
    readonly passStdout: string;
    readonly passArtifactText: string;
    readonly passBinarySha: string;
    readonly failStdout: string;
    readonly emptySha: string;
  };
  /** fail 记录的采集双口径（截断事实：保留 < 观测） */
  readonly failCapture: { readonly retainedBytes: number; readonly observedBytes: number };
}

function environment(preparationId: string) {
  return {
    preparationId,
    imageDigest: `sha256:${"a".repeat(63)}1`,
    platform: "linux/amd64" as const,
    toolchain: NODE_TS_V1_PROFILE.toolchain,
    limits: NODE_TS_V1_PROFILE.limits,
    security: NODE_TS_V1_PROFILE.security,
  };
}

function metaInput(verificationId: string, runId: string, withEnvironment: boolean) {
  return {
    verificationId,
    epoch: `ep_${verificationId}`,
    operationId: `op_${verificationId}`,
    target: {
      runId,
      checkpoint: { kind: "initial" } as const,
      snapshotId: `snap-${verificationId}`,
    },
    profileId: "node-ts-v1" as const,
    manifestVersion: 1,
    commandId: "test" as const,
    planBindingDigest: "b".repeat(64),
    createdAt: at(0),
    // 同条件对（pass/fail）来自同一次准备；M14 的身份/结果字段本就不要求相等
    ...(withEnvironment
      ? { environment: environment(`prep-${VERIFICATION_FIXTURE_IDS.pass}`) }
      : {}),
  };
}

interface StreamPlan {
  readonly text?: string;
  readonly bytes?: Uint8Array;
  /** 观测字节数 > 保留字节数 ⇒ capture 截断（M10） */
  readonly observedBytes?: number;
}

interface CommandPlan {
  readonly commandId: "typecheck" | "test";
  readonly exitCode: number;
  readonly stdout: StreamPlan;
  readonly stderr: StreamPlan;
}

interface ArtifactPlan {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function publishStream(
  root: string,
  plan: StreamPlan,
): { byteLength: number; totalBytes: number; sha256: string; truncated: boolean } {
  const bytes = plan.bytes ?? new TextEncoder().encode(plan.text ?? "");
  const { sha256 } = publishAsset(root, bytes);
  const observed = plan.observedBytes ?? bytes.length;
  return {
    byteLength: bytes.length,
    totalBytes: observed,
    sha256,
    truncated: observed > bytes.length,
  };
}

function commandStartEvent(commandId: "typecheck" | "test") {
  return {
    type: "command_start" as const,
    commandId,
    executable: "/usr/local/bin/node",
    argv: ["node", "--test", "src"],
    cwd: "/workspace",
    startedAt: at(1),
  };
}

function writeVerificationRecord(
  root: string,
  meta: ReturnType<typeof metaInput>,
  plan: {
    readonly commands?: readonly CommandPlan[];
    readonly artifacts?: {
      readonly entries: readonly ArtifactPlan[];
      readonly excludedPatterns?: readonly string[];
    };
    readonly terminated?:
      | { outcome: "passed" | "check_failed"; detail: string; evidenceComplete: boolean }
      | undefined;
    readonly stages?: readonly ("materializing" | "executing" | "collecting")[];
  },
): void {
  const writer = VerificationRecordWriter.open(root, meta);
  for (const phase of plan.stages ?? ["materializing", "executing"]) {
    writer.append({ type: "stage", phase, at: at(1) });
  }
  for (const command of plan.commands ?? []) {
    writer.append(commandStartEvent(command.commandId));
    writer.append({
      type: "command_end",
      commandId: command.commandId,
      exitCode: command.exitCode,
      signal: null,
      durationMs: 1200,
      stdout: publishStream(root, command.stdout),
      stderr: publishStream(root, command.stderr),
      endedAt: at(2),
    });
  }
  if (plan.artifacts !== undefined) {
    const entries = plan.artifacts.entries.map((entry) => {
      const { sha256 } = publishAsset(root, entry.bytes);
      return { path: entry.path, size: entry.bytes.length, sha256 };
    });
    writer.append({
      type: "artifacts",
      entries,
      excludedPatterns: [
        ...(plan.artifacts.excludedPatterns ?? ["node_modules/**", ".git/**"]),
      ],
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    });
  }
  if (plan.terminated !== undefined) {
    writer.terminate({ ...plan.terminated, at: at(3) });
  }
}

/** 一条最小真实 trace（sourceStatus=present 的"在场"事实用） */
function writeMinimalTrace(tracesDir: string, runId: string): void {
  const tracer = new JsonlTracer(join(tracesDir, `${runId}.jsonl`));
  tracer.startRun({
    id: runId,
    format_version: 1,
    task: `MCP2 验证夹具来源 ${runId}`,
    model: "controlled-model",
    created_at: at(0),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
}

export function buildVerificationFixture(): VerificationFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), "mcp2-ver-"));
  ROOTS.push(dataRoot);
  const tracesDir = join(dataRoot, "traces");
  const assetsDir = join(dataRoot, "verification-assets", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  const unicodeStdout = `${VERIFICATION_SENTINELS.passStdout}\r\n第二行😀\r\n${VERIFICATION_SENTINELS.secretInLog}\n`;
  const binaryBytes = new Uint8Array([0x00, 0xff, 0x80, 0x81, 0xfe, 0x01, 0x02]);
  const emptyBytes = new Uint8Array(0);
  const longText = VERIFICATION_SENTINELS.failStdoutPrefix + "失败🙂".repeat(700);
  const longBytes = new TextEncoder().encode(longText);

  // 同条件对（M14）：环境逐字段相同，只有结局与 exit 不同
  writeVerificationRecord(dataRoot, metaInput(VERIFICATION_FIXTURE_IDS.pass, "run-m2-pass", true), {
    commands: [
      {
        commandId: "test",
        exitCode: 0,
        stdout: { text: unicodeStdout },
        stderr: { bytes: emptyBytes },
      },
    ],
    artifacts: {
      entries: [
        { path: "report.json", bytes: new TextEncoder().encode(VERIFICATION_SENTINELS.artifactText) },
        { path: "blob.bin", bytes: binaryBytes },
      ],
    },
    terminated: { outcome: "passed", detail: "tests 2 pass 2", evidenceComplete: true },
  });
  writeMinimalTrace(tracesDir, "run-m2-pass");

  writeVerificationRecord(dataRoot, metaInput(VERIFICATION_FIXTURE_IDS.fail, "run-m2-fail", true), {
    commands: [
      {
        commandId: "test",
        exitCode: 1,
        stdout: { bytes: longBytes, observedBytes: longBytes.length + 5678 },
        stderr: { text: VERIFICATION_SENTINELS.stderrText },
      },
    ],
    terminated: { outcome: "check_failed", detail: "断言失败", evidenceComplete: true },
  });
  writeMinimalTrace(tracesDir, "run-m2-fail");

  // 旧记录：environment 缺项（M04/M15）
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.oldEnv, "run-m2-oldenv", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "old env unknown\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );

  // 未封存 + interrupted（M05/M17）：查询不得补写终止
  const unterm = VerificationRecordWriter.open(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.unterm, "run-m2-unterm", true),
  );
  unterm.append({ type: "stage", phase: "executing", at: at(1) });
  unterm.append({
    type: "interrupted",
    reason: "宿主进程退出，未能确认清理",
    stoppedResources: [{ name: "mcp2-unterm-容器", containerId: "c0ffee1" }],
    removedResources: [],
    unconfirmedResources: ["mcp2-unterm-容器"],
    at: at(2),
  });
  unterm.abortClose();

  // 坏尾（M05）：密封后追加非法 JSON 行
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.badTail, "run-m2-badtail", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "ok\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );
  appendFileSync(
    join(dataRoot, "verifications", `${VERIFICATION_FIXTURE_IDS.badTail}.jsonl`),
    '{"type":"stage","phase":"finalizi',
  );

  // 未知版本（M03/M05）：手写 meta（被测对象本身即非法格式）
  writeFileSync(
    join(dataRoot, "verifications", `${VERIFICATION_FIXTURE_IDS.oldVersion}.jsonl`),
    `${JSON.stringify({
      type: "meta",
      schemaVersion: 2,
      verificationId: VERIFICATION_FIXTURE_IDS.oldVersion,
    })}\n`,
  );

  // 重复 command_end（M08）：同一 commandId 两条 end（terminated 之前），附件定位歧义
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.dupCommand, "run-m2-dupcmd", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "first run\n" },
          stderr: { bytes: emptyBytes },
        },
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "second run\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );

  // 附件缺失（M09）：引用从未发布的哈希
  const missingSha = createHash("sha256").update("never-published").digest("hex");
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.missingAsset, "run-m2-missasset", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "will lose asset\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );
  {
    // 把已发布资产删掉，制造"记录引用在场、资产缺失"
    const recordText = readFileSync(
      join(dataRoot, "verifications", `${VERIFICATION_FIXTURE_IDS.missingAsset}.jsonl`),
      "utf8",
    );
    const missing = /"sha256":"([0-9a-f]{64})"/.exec(recordText)?.[1];
    if (missing !== undefined) {
      rmSync(join(assetsDir, missing), { force: true });
    }
  }

  // 附件被改（M09/M12）：发布后覆写字节 ⇒ 哈希核验失败
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.corruptAsset, "run-m2-corrupt", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "soon corrupt\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );
  {
    const recordText = readFileSync(
      join(dataRoot, "verifications", `${VERIFICATION_FIXTURE_IDS.corruptAsset}.jsonl`),
      "utf8",
    );
    const target = /"sha256":"([0-9a-f]{64})"/.exec(recordText)?.[1];
    if (target !== undefined) {
      writeFileSync(join(assetsDir, target), "TAMPERED-BYTES");
    }
  }

  // 冲突产物清单（M08/M09）：同 path 两条 entry，hash 不同
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.dupPath, "run-m2-duppath", false),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "dup path\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      artifacts: {
        entries: [
          { path: "same.txt", bytes: new TextEncoder().encode("version A") },
          { path: "same.txt", bytes: new TextEncoder().encode("version B") },
        ],
      },
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );

  // 来源缺失（M07）：记录合法但 traces/ 无对应文件
  writeVerificationRecord(
    dataRoot,
    metaInput(VERIFICATION_FIXTURE_IDS.goneSource, "run-m2-gone", true),
    {
      commands: [
        {
          commandId: "test",
          exitCode: 0,
          stdout: { text: "source gone\n" },
          stderr: { bytes: emptyBytes },
        },
      ],
      terminated: { outcome: "passed", detail: "tests 1 pass 1", evidenceComplete: true },
    },
  );

  // 残留 runtime 登记（M17）：查询前后必须逐字未动
  const runtimeDir = join(dataRoot, "verification-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "owner-m2.json"),
    JSON.stringify({
      resourceOwnerId: "owner-m2",
      state: "residual",
      containerName: "mcp2-residual",
      at: at(0),
    }),
    "utf8",
  );

  // 一条配套准备记录（历史 preparationId 关联用；M04/M15）
  const prepInput: PreparationMetaInput = {
    preparationId: `prep-${VERIFICATION_FIXTURE_IDS.pass}`,
    epoch: "ep_prep",
    operationId: "op_prep",
    profileId: "node-ts-v1",
    manifestVersion: 1,
    planDigest: "c".repeat(64),
    createdAt: at(0),
  };
  const prep = PreparationRecordWriter.open(dataRoot, prepInput);
  prep.append({
    type: "prepared",
    imageDigest: `sha256:${"a".repeat(63)}1`,
    toolchain: { node: "20.x", typescript: "5.6" },
    networkUsed: false,
    downloadedBytes: 0,
    at: at(1),
  });
  prep.terminate({ outcome: "prepared", at: at(2) });

  return {
    dataRoot,
    tracesDir,
    assetsDir,
    ids: VERIFICATION_FIXTURE_IDS,
    hashes: {
      passStdout: createHash("sha256").update(unicodeStdout).digest("hex"),
      passArtifactText: createHash("sha256")
        .update(VERIFICATION_SENTINELS.artifactText)
        .digest("hex"),
      passBinarySha: createHash("sha256").update(binaryBytes).digest("hex"),
      failStdout: createHash("sha256").update(longBytes).digest("hex"),
      emptySha: createHash("sha256").update(emptyBytes).digest("hex"),
    },
    failCapture: { retainedBytes: longBytes.length, observedBytes: longBytes.length + 5678 },
  };
}

// ---------------------------------------------------------------------------
// 只读探针：整根递归指纹（M17/5.1 用）
// ---------------------------------------------------------------------------

export interface RootFingerprint {
  /** 相对路径（"/" 分隔、排序稳定）→ 字节数与内容 sha256 */
  readonly entries: Readonly<Record<string, { readonly size: number; readonly sha256: string }>>;
}

export function snapshotRootFingerprint(root: string): RootFingerprint {
  const entries: Record<string, { size: number; sha256: string }> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const relative = `${prefix}${name}`;
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, `${relative}/`);
        continue;
      }
      const bytes = readFileSync(absolute);
      entries[relative] = {
        size: stat.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
  };
  walk(root, "");
  return { entries };
}

/** 指纹差异报告（空数组 = 逐字未动）；路径出现/消失/改字节都算差 */
export function rootFingerprintDiff(
  baseline: RootFingerprint,
  current: RootFingerprint,
): string[] {
  const diffs: string[] = [];
  const paths = new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)]);
  for (const path of [...paths].sort()) {
    const before = baseline.entries[path];
    const after = current.entries[path];
    if (before === undefined) {
      diffs.push(`新增：${path}`);
    } else if (after === undefined) {
      diffs.push(`消失：${path}`);
    } else if (before.size !== after.size || before.sha256 !== after.sha256) {
      diffs.push(`改写：${path}`);
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// 真实记录复制（M19/5.3 用）：把真实 R3 记录与其引用资产复制进临时根
// ---------------------------------------------------------------------------

/** 从记录文本中提取全部 64 位十六进制引用（附件哈希） */
function referencedHashes(recordText: string): string[] {
  return [...recordText.matchAll(/"sha256":"([0-9a-f]{64})"/g)].map((match) => match[1] ?? "");
}

/**
 * 复制一条真实验证记录及其全部引用资产到目标根（不复制其它记录）。
 * 来源根必须含 verifications/<id>.jsonl 与 verification-assets/sha256/；
 * 来源里已缺失的附件如实缺失（不补造）。
 */
export function copyVerificationRecord(
  sourceRoot: string,
  targetRoot: string,
  verificationId: string,
): void {
  const sourceRecord = join(sourceRoot, "verifications", `${verificationId}.jsonl`);
  if (!existsSync(sourceRecord)) {
    throw new Error(`来源根没有该验证记录：${verificationId}`);
  }
  mkdirSync(join(targetRoot, "verifications"), { recursive: true });
  mkdirSync(join(targetRoot, "verification-assets", "sha256"), { recursive: true });
  const text = readFileSync(sourceRecord, "utf8");
  writeFileSync(join(targetRoot, "verifications", `${verificationId}.jsonl`), text, "utf8");
  for (const hash of new Set(referencedHashes(text))) {
    const sourceAsset = join(sourceRoot, "verification-assets", "sha256", hash);
    if (existsSync(sourceAsset)) {
      writeFileSync(join(targetRoot, "verification-assets", "sha256", hash), readFileSync(sourceAsset));
    }
  }
}

/** 供泄漏检查：当前模块持有的临时根数量 */
export function liveFixtureRootCount(): number {
  return ROOTS.length;
}
