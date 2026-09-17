import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BYTE_LIMIT,
  auditRendererSource,
  auditRendererSourceText,
  auditWorkerAssets,
  auditWorkerFileList,
  checkSize,
  expectedArtifactName,
  isUnderByteLimit,
  parseArtifactVersion,
  readAppVersion,
  verifyRelease,
} from "../scripts/release-check.mjs";

/** 测试文件所在目录（用于定位 electron-builder.yml）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 临时目录底座：每个用例自动建/清。 */
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "release-check-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("尺寸判定纯函数（不创建百兆测试文件）", () => {
  it("99_999_999 → 通过", () => {
    expect(isUnderByteLimit(99_999_999)).toBe(true);
    expect(checkSize(99_999_999).ok).toBe(true);
    expect(checkSize(99_999_999).excess).toBe(0);
  });

  it("100_000_000 → 边界失败，超出 1 byte", () => {
    expect(isUnderByteLimit(100_000_000)).toBe(false);
    const r = checkSize(100_000_000);
    expect(r.ok).toBe(false);
    expect(r.actual).toBe(100_000_000);
    expect(r.limit).toBe(BYTE_LIMIT);
    expect(r.excess).toBe(1);
  });

  it("100_000_001 → 失败，超出 2 bytes", () => {
    expect(isUnderByteLimit(100_000_001)).toBe(false);
    const r = checkSize(100_000_001);
    expect(r.ok).toBe(false);
    expect(r.excess).toBe(2);
  });
});

describe("源码静态审计：禁用导入规则", () => {
  it("从 monaco-editor 包根导入 → 违规且含文件路径与行号", () => {
    const file = join(tmp, "bad.tsx");
    writeFileSync(file, 'import * as monaco from "monaco-editor";\n');
    const v = auditRendererSource(tmp);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "bad.tsx", line: 1 });
    expect(v[0]?.reason).toContain("monaco-editor 包根");
  });

  it("从 basic-languages/monaco.contribution 导入 → 违规且含文件路径", () => {
    const dir = join(tmp, "src");
    mkdirSync(dir);
    const file = join(dir, "main.ts");
    writeFileSync(file, 'import "monaco-editor/basic-languages/monaco.contribution";\n');
    const v = auditRendererSource(tmp);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toBe(join("src", "main.ts"));
    expect(v[0]?.reason).toContain("基础语言聚合入口");
  });

  it("显式 ESM 入口（editor.api / json contribution）→ 不违规", () => {
    const content = [
      'import * as monaco from "monaco-editor/esm/vs/editor/editor.api";',
      'import "monaco-editor/esm/vs/language/json/monaco.contribution";',
      'import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";',
      "",
    ].join("\n");
    expect(auditRendererSourceText("ok.ts", content)).toEqual([]);
  });

  it("跳过 node_modules，不影响真实目录扫描", () => {
    const nm = join(tmp, "node_modules", "monaco-editor");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), 'import "monaco-editor";\n');
    writeFileSync(
      join(tmp, "real.ts"),
      'import * as monaco from "monaco-editor/esm/vs/editor/editor.api";\n',
    );
    expect(auditRendererSource(tmp)).toEqual([]);
  });
});

describe("构建产物 worker 审计：缺失 / 禁用规则（合成目录）", () => {
  function makeAssets(files: Record<string, string>): string {
    const dir = join(tmp, "assets");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it("缺 editor worker → 失败并明确报告 editor.worker 缺失", () => {
    const dir = makeAssets({ "json.worker-abc.js": "" });
    const r = auditWorkerAssets(dir);
    expect(r.ok).toBe(false);
    expect(r.missing.join("\n")).toContain("editor.worker");
    expect(r.forbidden).toEqual([]);
  });

  it("缺 json worker → 失败并明确报告 json.worker 缺失", () => {
    const dir = makeAssets({ "editor.worker-abc.js": "" });
    const r = auditWorkerAssets(dir);
    expect(r.ok).toBe(false);
    expect(r.missing.join("\n")).toContain("json.worker");
  });

  it("ts.worker 存在 → 失败并报告具体路径", () => {
    const dir = makeAssets({
      "editor.worker-a.js": "",
      "json.worker-b.js": "",
      "ts.worker-c.js": "",
    });
    const r = auditWorkerAssets(dir);
    expect(r.ok).toBe(false);
    expect(r.forbidden[0]).toBe(join(dir, "ts.worker-c.js"));
  });

  it("css / html worker 存在 → 均被逐项报告", () => {
    const dir = makeAssets({
      "editor.worker-a.js": "",
      "json.worker-b.js": "",
      "css.worker-c.js": "",
      "html.worker-d.js": "",
    });
    const r = auditWorkerAssets(dir);
    expect(r.ok).toBe(false);
    expect(r.forbidden).toHaveLength(2);
    expect(r.forbidden.join("\n")).toContain("css.worker-c.js");
    expect(r.forbidden.join("\n")).toContain("html.worker-d.js");
  });

  it("editor/json 齐备且无禁用 worker → 通过，并报告字节数", () => {
    const dir = makeAssets({
      "index-abc.js": "x".repeat(10),
      "editor.worker-a.js": "x".repeat(30),
      "json.worker-b.js": "x".repeat(20),
    });
    const r = auditWorkerAssets(dir);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.forbidden).toEqual([]);
    expect(r.rendererJsBytes).toBe(60);
    expect(r.workerBytes).toBe(50);
  });

  it("纯函数版直接接受文件名列表（合成目录不依赖文件系统）", () => {
    expect(auditWorkerFileList(["editor.worker-a.js", "json.worker-b.js"]).ok).toBe(true);
    expect(auditWorkerFileList(["editor.worker-a.js"]).missing.join("\n")).toContain("json.worker");
  });
});

describe("版本来源：推导与读取", () => {
  it("expectedArtifactName 与 electron-builder.yml 的 artifactName 同形", () => {
    const yml = readFileSync(join(HERE, "..", "electron-builder.yml"), "utf8");
    expect(yml).toContain("ReBaseAgent-${version}-win-x64-portable.${ext}");
    expect(expectedArtifactName("1.2.3")).toBe("ReBaseAgent-1.2.3-win-x64-portable.exe");
  });

  it("parseArtifactVersion 解析声明版本，模板不符返回 null", () => {
    expect(parseArtifactVersion("ReBaseAgent-0.2.0-win-x64-portable.exe")).toBe("0.2.0");
    expect(parseArtifactVersion("ReBaseAgent-0.3.0-k0-win-x64-portable.exe")).toBe("0.3.0-k0");
    expect(parseArtifactVersion("ReBaseAgent-win-x64-portable.exe")).toBeNull();
    expect(parseArtifactVersion("other-0.2.0-win-x64-portable.exe")).toBeNull();
  });

  it("readAppVersion 读版本；文件缺失 / JSON 非法 / 无 version 均返回 null（不抛错）", () => {
    const good = join(tmp, "good.json");
    writeFileSync(good, JSON.stringify({ name: "@rebaseagent/desktop", version: "0.3.0-k0" }));
    expect(readAppVersion(good)).toBe("0.3.0-k0");

    expect(readAppVersion(join(tmp, "missing.json"))).toBeNull();

    const broken = join(tmp, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(readAppVersion(broken)).toBeNull();

    const noVersion = join(tmp, "noversion.json");
    writeFileSync(noVersion, JSON.stringify({ name: "@rebaseagent/desktop" }));
    expect(readAppVersion(noVersion)).toBeNull();

    const emptyVersion = join(tmp, "empty.json");
    writeFileSync(emptyVersion, JSON.stringify({ version: "" }));
    expect(readAppVersion(emptyVersion)).toBeNull();
  });

  it("体积阈值不变（本 change 不放宽任何门禁）", () => {
    expect(BYTE_LIMIT).toBe(100_000_000);
  });
});

describe("verifyRelease：身份 + 体积 + 资源总验收", () => {
  function writeArtifact(dir: string, name: string, bytes: number): string {
    const file = join(dir, name);
    writeFileSync(file, "x".repeat(bytes));
    return file;
  }

  function writeAppPackage(dir: string, version: string): string {
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "@rebaseagent/desktop", version }));
    return file;
  }

  it("既有版本产物 → 拒绝（不得把旧产物当作本次结果）", () => {
    const artifact = writeArtifact(tmp, "ReBaseAgent-0.1.0-win-x64-portable.exe", 1_000);
    const appPackage = writeAppPackage(tmp, "0.2.0");
    const r = verifyRelease({ artifactPath: artifact, appPackagePath: appPackage });
    expect(r.expectedVersion).toBe("0.2.0");
    expect(r.artifactVersion).toBe("0.1.0");
    expect(r.fileNameOk).toBe(false);
    expect(r.appVersionOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("期望值随应用包版本变化：仅改版本即可通过，无需改脚本", () => {
    for (const [index, version] of ["0.2.0", "0.3.0-k0"].entries()) {
      const dir = join(tmp, `case${index}`);
      mkdirSync(dir, { recursive: true });
      const artifact = writeArtifact(dir, expectedArtifactName(version), 1_000);
      const appPackage = writeAppPackage(dir, version);
      const r = verifyRelease({ artifactPath: artifact, appPackagePath: appPackage });
      expect(r.expectedVersion).toBe(version);
      expect(r.expectedArtifactName).toBe(expectedArtifactName(version));
      expect(r.fileNameOk).toBe(true);
      expect(r.appVersionOk).toBe(true);
      expect(r.size.ok).toBe(true);
      expect(r.ok).toBe(true);
    }
  });

  it("文件名符合模板但版本与应用包不一致 → 失败且带出期望值与实际值", () => {
    const artifact = writeArtifact(tmp, "ReBaseAgent-0.9.9-win-x64-portable.exe", 1_000);
    const appPackage = writeAppPackage(tmp, "0.2.0");
    const r = verifyRelease({ artifactPath: artifact, appPackagePath: appPackage });
    expect(r.expectedVersion).toBe("0.2.0");
    expect(r.artifactVersion).toBe("0.9.9");
    expect(r.fileNameOk).toBe(false);
    expect(r.appVersionOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("文件名不符模板 → 解析不出声明版本，身份判定失败", () => {
    const artifact = writeArtifact(tmp, "ReBaseAgent-win-x64-portable.exe", 1_000);
    const appPackage = writeAppPackage(tmp, "0.2.0");
    const r = verifyRelease({ artifactPath: artifact, appPackagePath: appPackage });
    expect(r.artifactVersion).toBeNull();
    expect(r.fileNameOk).toBe(false);
    expect(r.appVersionOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("未提供应用包 → 不放行（不因缺少输入而跳过身份校验）", () => {
    const artifact = writeArtifact(tmp, expectedArtifactName("0.2.0"), 1_000);
    const r = verifyRelease({ artifactPath: artifact });
    expect(r.expectedVersion).toBeNull();
    expect(r.expectedArtifactName).toBeNull();
    expect(r.fileNameOk).toBe(false);
    expect(r.appVersionOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("应用包不可读 → 不放行", () => {
    const artifact = writeArtifact(tmp, expectedArtifactName("0.2.0"), 1_000);
    const r = verifyRelease({
      artifactPath: artifact,
      appPackagePath: join(tmp, "missing-package.json"),
    });
    expect(r.expectedVersion).toBeNull();
    expect(r.ok).toBe(false);
  });

  it("体积等于阈值 → 整体失败并报告超出量", () => {
    const artifact = writeArtifact(tmp, expectedArtifactName("0.2.0"), BYTE_LIMIT);
    const appPackage = writeAppPackage(tmp, "0.2.0");
    const r = verifyRelease({ artifactPath: artifact, appPackagePath: appPackage });
    expect(r.size.ok).toBe(false);
    expect(r.size.excess).toBe(1);
    expect(r.ok).toBe(false);
  });
});
