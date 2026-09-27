// 只读锁文件与本机包元数据，输出审计输入，不判定最终发行物合规。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../..");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const lockBytes = fs.readFileSync(path.join(root, "pnpm-lock.yaml"));
const store = path.join(root, "node_modules/.pnpm");
const storeEntries = fs.readdirSync(store).sort();
const parserDir = storeEntries.find((name) => name.startsWith("js-yaml@"));
if (!parserDir) throw new Error("需要当前安装树中的 js-yaml；本脚本不会安装依赖");
const parserRoot = path.join(store, parserDir, "node_modules/js-yaml");
const yaml = require(parserRoot);
const lock = yaml.load(lockBytes.toString("utf8"));
if (String(lock.lockfileVersion) !== "9.0") throw new Error("仅核查 pnpm lockfile 9.0");
const direct = [];
const manifests = [];
for (const [importer, data] of Object.entries(lock.importers)) {
  const file = path.join(root, importer, "package.json");
  manifests.push({ path: relative(file), sha256: sha256(fs.readFileSync(file)) });
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(data[section] || {})) {
      direct.push({ importer, section, name, specifier: spec.specifier, resolved: spec.version });
    }
  }
}

const production = new Set();
const visitedImporters = new Set();
const visitedSnapshots = new Set();
function visitImporter(importer) {
  if (visitedImporters.has(importer)) return;
  visitedImporters.add(importer);
  const data = lock.importers[importer];
  if (!data) throw new Error(`未找到 workspace importer: ${importer}`);
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(data[section] || {})) {
      if (spec.version.startsWith("link:")) {
        visitImporter(path.posix.normalize(path.posix.join(importer, spec.version.slice(5))));
      } else visitPackage(name, spec.version);
    }
  }
}
function visitPackage(name, version) {
  const snapshotKey = `${name}@${version}`;
  if (visitedSnapshots.has(snapshotKey)) return;
  visitedSnapshots.add(snapshotKey);
  const key = snapshotKey.split("(")[0];
  if (!lock.packages[key]) throw new Error(`未找到锁定包: ${key}`);
  production.add(key);
  const data = lock.snapshots[snapshotKey];
  if (!data) throw new Error(`未找到依赖图节点: ${snapshotKey}`);
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [child, resolved] of Object.entries(data[section] || {})) visitPackage(child, resolved);
  }
}
visitImporter("apps/desktop");

const packages = [];
for (const key of Object.keys(lock.packages).sort()) {
  const split = key.lastIndexOf("@");
  const name = key.slice(0, split);
  const version = key.slice(split + 1);
  const prefix = `${name.replaceAll("/", "+")}@${version}`;
  let packageRoot = null;
  let metadata = null;
  for (const entry of storeEntries) {
    if (entry !== prefix && !entry.startsWith(`${prefix}_`) && !entry.startsWith(`${prefix}(`)) continue;
    const candidate = path.join(store, entry, "node_modules", name);
    const file = path.join(candidate, "package.json");
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.name === name && parsed.version === version) {
      packageRoot = candidate;
      metadata = parsed;
      break;
    }
  }
  const licenseFiles = packageRoot
    ? fs.readdirSync(packageRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice|copyright|third[-_]?party[-_]?notices?)([._-]|$)/i.test(entry.name))
        .map((entry) => ({ name: entry.name, sha256: sha256(fs.readFileSync(path.join(packageRoot, entry.name))) }))
    : [];
  packages.push({
    key,
    desktopProductionGraph: production.has(key),
    installed: metadata !== null,
    packagePath: packageRoot ? relative(packageRoot) : null,
    declaredLicense: metadata?.license ?? metadata?.licenses ?? null,
    manifestSha256: packageRoot ? sha256(fs.readFileSync(path.join(packageRoot, "package.json"))) : null,
    licenseFiles,
  });
}

const electronFiles = [];
for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
  const file = path.join(root, "apps/desktop/node_modules/electron/dist", name);
  electronFiles.push({ path: relative(file), exists: fs.existsSync(file), sha256: fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null });
}
// 扫描期间发生依赖变更时不输出混合基线。
if (sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))) !== sha256(lockBytes)) throw new Error("扫描期间锁文件变化，请重新运行");
for (const manifest of manifests) {
  if (sha256(fs.readFileSync(path.join(root, manifest.path))) !== manifest.sha256) throw new Error(`扫描期间清单变化: ${manifest.path}`);
}
const installed = packages.filter((pkg) => pkg.installed);
const licenseCounts = {};
for (const pkg of installed) {
  const label = typeof pkg.declaredLicense === "string" ? pkg.declaredLicense : JSON.stringify(pkg.declaredLicense);
  licenseCounts[label] = (licenseCounts[label] || 0) + 1;
}
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  sourceCommitAtEnd: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  lockfileSha256: sha256(lockBytes),
  parser: { name: "js-yaml", version: JSON.parse(fs.readFileSync(path.join(parserRoot, "package.json"), "utf8")).version },
  scope: "锁文件包身份与本机顶层许可证元数据；生产依赖图不是实际发行清单，Electron 二进制另列；未下载缺失包或核验包归档完整性",
  summary: {
    lockPackages: packages.length,
    installedPackages: installed.length,
    notInstalled: packages.filter((pkg) => !pkg.installed).map((pkg) => pkg.key),
    missingLicenseMetadata: installed.filter((pkg) => !pkg.declaredLicense).map((pkg) => pkg.key),
    withoutTopLevelLicenseFile: installed.filter((pkg) => pkg.licenseFiles.length === 0).map((pkg) => pkg.key),
    desktopProductionGraphPackages: production.size,
    licenseCounts,
  },
  manifests,
  direct,
  electronFiles,
  packages,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
