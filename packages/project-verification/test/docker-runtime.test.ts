import { describe, expect, it } from "vitest";
import type { CliRunOptions, CliRunResult } from "../src/docker/cli.js";
import { DockerRuntimeBackend } from "../src/docker/docker-runtime.js";
import { RuntimeCreateStaleNameError, RuntimeCreateUnknownError } from "../src/runtime/create.js";

const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;
const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };

function cliResult(overrides: Partial<CliRunResult> = {}): CliRunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    stdoutBytes: new Uint8Array(),
    stderrBytes: new Uint8Array(),
    stdoutTotalBytes: 0,
    stderrTotalBytes: 0,
    outputLimitHit: false,
    spawnError: null,
    ...overrides,
  };
}

function backend(script: (args: string[], options: CliRunOptions) => CliRunResult): {
  backend: DockerRuntimeBackend;
  calls: { args: string[]; options: CliRunOptions }[];
} {
  const calls: { args: string[]; options: CliRunOptions }[] = [];
  const runner = async (exePath: string, args: string[], options: CliRunOptions) => {
    expect(exePath).toBe("C:\\x\\bin\\docker.exe");
    calls.push({ args, options });
    return script(args, options);
  };
  return { backend: new DockerRuntimeBackend({ installation, endpoint: ENDPOINT, runner }), calls };
}

describe("DockerRuntimeBackend：核查面 argv 与错误语义（3.7）", () => {
  it("listOwnedContainers：ps -aq + label 精确过滤取 ID，再逐容器 inspect 取权威事实（§1.6）", async () => {
    const { backend: b, calls } = backend((args) => {
      if (args.includes("ps")) {
        return cliResult({ stdout: `${"a".repeat(64)}\n${"b".repeat(64)}\n` });
      }
      const id = args[args.length - 1];
      if (id === "a".repeat(64)) {
        return cliResult({
          stdout: `${JSON.stringify({
            ID: "a".repeat(64),
            Name: "/r3-verify-x1",
            State: { Status: "running" },
            Config: { Labels: { "rebaseagent.owner": "rebaseagent-r3" } },
          })}\n`,
        });
      }
      return cliResult({
        stdout: `${JSON.stringify({
          ID: "b".repeat(64),
          Name: "/r3-prepare-y1",
          State: { Status: "exited" },
          Config: { Labels: { "rebaseagent.owner": "rebaseagent-r3" } },
        })}\n`,
      });
    });
    const facts = await b.listOwnedContainers();
    expect(calls[0]?.args).toEqual([
      "--host",
      ENDPOINT,
      "ps",
      "-aq",
      "--filter",
      "label=rebaseagent.owner=rebaseagent-r3",
    ]);
    expect(facts).toEqual([
      {
        containerId: "a".repeat(64),
        name: "r3-verify-x1",
        state: "running",
        labels: { "rebaseagent.owner": "rebaseagent-r3" },
      },
      {
        containerId: "b".repeat(64),
        name: "r3-prepare-y1",
        state: "exited",
        labels: { "rebaseagent.owner": "rebaseagent-r3" },
      },
    ]);
  });

  it("listOwnedContainers：枚举后容器已消失（外部竞态）⇒ 跳过；inspect 垃圾输出 ⇒ 抛错", async () => {
    const { backend: b } = backend((args) => {
      if (args.includes("ps")) {
        return cliResult({ stdout: `${"a".repeat(64)}\n` });
      }
      return cliResult({ exitCode: 1, stderr: "Error: No such container: aaa" });
    });
    await expect(b.listOwnedContainers()).resolves.toEqual([]);
    const { backend: b2 } = backend((args) => {
      if (args.includes("ps")) {
        return cliResult({ stdout: `${"a".repeat(64)}\n` });
      }
      return cliResult({ stdout: "not-json\n" });
    });
    await expect(b2.listOwnedContainers()).rejects.toThrow(/不可解析/);
  });

  it("stopContainer：-t 宽限 + 非零退出带 daemon 分类；spawn/超时 ⇒ 抛错", async () => {
    const { backend: b, calls } = backend((args) =>
      args.includes("stop") && args.includes("probe-bad")
        ? cliResult({ exitCode: 1, stderr: "failed to connect to the docker API" })
        : cliResult(),
    );
    await b.stopContainer("probe-ok");
    expect(calls[0]?.args).toEqual(["--host", ENDPOINT, "stop", "-t", "10", "probe-ok"]);
    await expect(b.stopContainer("probe-bad")).rejects.toThrow(/unknown/);
  });

  it("confirmStopped：running ⇒ 抛错（不乐观宣布）；exited ⇒ ok；No such ⇒ ok", async () => {
    const { backend: b } = backend((args) =>
      args.includes("still-running")
        ? cliResult({ stdout: "running\n" })
        : args.includes("gone")
          ? cliResult({ exitCode: 1, stderr: "Error: No such container: gone" })
          : cliResult({ stdout: "exited\n" }),
    );
    await expect(b.confirmStopped("still-running")).rejects.toThrow(/仍在运行/);
    await expect(b.confirmStopped("exited-ctr")).resolves.toBeUndefined();
    await expect(b.confirmStopped("gone")).resolves.toBeUndefined();
  });

  it("removeContainer：No such 容错（幂等）；其他非零 ⇒ 抛错", async () => {
    const { backend: b, calls } = backend((args) =>
      args.includes("vanished")
        ? cliResult({ exitCode: 1, stderr: "Error: No such container: vanished" })
        : args.includes("busy")
          ? cliResult({ exitCode: 1, stderr: "cannot remove container" })
          : cliResult(),
    );
    await expect(b.removeContainer("ok-ctr")).resolves.toBeUndefined();
    // 6.2：编排在 supervisor 仍存活时收尾 ⇒ 必须 rm -f（否则 Docker 拒绝并残留）
    expect(calls[0]?.args).toEqual(["--host", ENDPOINT, "rm", "-f", "ok-ctr"]);
    await expect(b.removeContainer("vanished")).resolves.toBeUndefined();
    await expect(b.removeContainer("busy")).rejects.toThrow(/非零退出/);
  });
});

describe("DockerRuntimeBackend：创建面 argv 与响应丢失分类（P22）", () => {
  it("createContainer：create --name --label + runFlags + 镜像 + 命令；64 位 ID 返回", async () => {
    const { backend: b, calls } = backend(() => cliResult({ stdout: `${"d".repeat(64)}\n` }));
    const out = await b.createContainer({
      name: "r3-verify-x1",
      labels: { "rebaseagent.owner": "rebaseagent-r3" },
      imageRef: "r3/node-ts-v1:v3",
      runFlags: ["--network", "none", "--memory", "512m"],
      command: ["/bin/sh", "/opt/r3/supervisor.sh"],
    });
    expect(out.containerId).toBe("d".repeat(64));
    expect(calls[0]?.args).toEqual([
      "--host",
      ENDPOINT,
      "create",
      "--name",
      "r3-verify-x1",
      "--label",
      "rebaseagent.owner=rebaseagent-r3",
      "--network",
      "none",
      "--memory",
      "512m",
      "r3/node-ts-v1:v3",
      "/bin/sh",
      "/opt/r3/supervisor.sh",
    ]);
  });

  it("同名占用 ⇒ RuntimeCreateStaleNameError；daemon 拒绝 ⇒ 普通 Error（明确未创建）", async () => {
    const { backend: b } = backend((args) =>
      args.includes("r3-verify-stale")
        ? cliResult({
            exitCode: 1,
            stderr: 'Conflict. The container name "/r3-verify-stale" is already in use',
          })
        : cliResult({ exitCode: 1, stderr: "No such image: img" }),
    );
    await expect(
      b.createContainer({
        name: "r3-verify-stale",
        labels: {},
        imageRef: "img",
        runFlags: [],
        command: [],
      }),
    ).rejects.toThrow(RuntimeCreateStaleNameError);
    await expect(
      b.createContainer({
        name: "r3-verify-fail",
        labels: {},
        imageRef: "img",
        runFlags: [],
        command: [],
      }),
    ).rejects.toThrow(/docker create 非零退出/);
    const e = await b
      .createContainer({
        name: "r3-verify-fail",
        labels: {},
        imageRef: "img",
        runFlags: [],
        command: [],
      })
      .catch((error: unknown) => error);
    expect(e).not.toBeInstanceOf(RuntimeCreateUnknownError);
  });

  it("超时 / exit 0 但响应不可解析 ⇒ RuntimeCreateUnknownError（响应丢失窗口）", async () => {
    const { backend: b } = backend((args) =>
      args.includes("r3-verify-slow")
        ? cliResult({ timedOut: true })
        : cliResult({ stdout: "  \n" }),
    );
    await expect(
      b.createContainer({
        name: "r3-verify-slow",
        labels: {},
        imageRef: "img",
        runFlags: [],
        command: [],
      }),
    ).rejects.toThrow(RuntimeCreateUnknownError);
    await expect(
      b.createContainer({
        name: "r3-verify-empty",
        labels: {},
        imageRef: "img",
        runFlags: [],
        command: [],
      }),
    ).rejects.toThrow(RuntimeCreateUnknownError);
  });

  it("resolveContainerByName：No such ⇒ null（判定未创建）；inspect JSON ⇒ facts", async () => {
    const { backend: b, calls } = backend((args) =>
      args.includes("r3-verify-missing")
        ? cliResult({ exitCode: 1, stderr: "Error: No such object: r3-verify-missing" })
        : cliResult({
            stdout: `${JSON.stringify({
              ID: "e".repeat(64),
              Name: "/r3-verify-found",
              State: { Status: "created" },
              Config: { Labels: { "rebaseagent.owner": "rebaseagent-r3" } },
            })}\n`,
          }),
    );
    expect(await b.resolveContainerByName("r3-verify-missing")).toBeNull();
    const facts = await b.resolveContainerByName("r3-verify-found");
    expect(facts).toEqual({
      containerId: "e".repeat(64),
      name: "r3-verify-found",
      state: "created",
      labels: { "rebaseagent.owner": "rebaseagent-r3" },
    });
    expect(calls[0]?.args).toEqual([
      "--host",
      ENDPOINT,
      "container",
      "inspect",
      "--format",
      "{{json .}}",
      "r3-verify-missing",
    ]);
  });
});
