import { canonicalJson, sha256Text } from "../canonical.js";
import { NODE_TS_V1_PROFILE, type ProfileManifest, TrustedEnvironmentSchema } from "../schema.js";
import { NODE_TS_V1_BUILD_ASSETS } from "./node-ts-v1-assets.generated.js";

/**
 * node-ts-v1 受信环境资产的**完整性门**（R3 tasks 3.1；验收 P08 的准备侧落点）。
 *
 * P08「项目更改固定 package/锁文件/配置和可信测试 ⇒ 明确拒绝」：构建受信环境镜像
 * **之前**，先把包内构建资产逐项哈希对回冻结 manifest——不一致即拒绝构建（3.2 适配器
 * 只在门通过后才把字节交给后端）。资产形态为内嵌常量（见生成的资产文件头注释），
 * 常规路径下与 manifest 由同一流程冻结；本门防的是**手工改文件 / 生成链被跳过 /
 * 依赖被替换**这类漂移。
 *
 * ⚠️ 路径映射：manifest 里的哈希锚定的是**镜像内落位路径**（`/opt/r3/runner.mjs` 等，
 * 模板为 /work 落位路径），构建资产是**构建上下文相对路径**——映射关系固定如下，
 * 未知映射一律按不成立处理（宁可拒绝，不静默放行）。
 */

/** 模板文件的 /work 落位路径 → 构建上下文资产路径（字节相同，落位名不同）。 */
const TEMPLATE_WORK_PATH_TO_ASSET: Readonly<Record<string, string>> = {
  "package.json": "package.tmpl.json",
  "tsconfig.json": "tsconfig.json",
};

/** 镜像内 `/opt/r3` 路径 → 构建上下文资产路径（同名字节相同）。 */
const OPT_R3_ASSET_PREFIX = "/opt/r3/";

/**
 * 计算 manifest 冻结哈希对应的**构建资产期望表**：`资产路径 → sha256`。
 * manifest 引用了映射不到资产的条目时抛错（manifest 与资产生成链必须同步修订，
 * 不允许半边更新后继续准备）。
 */
export function nodeTsV1ExpectedAssetHashes(
  profile: ProfileManifest = NODE_TS_V1_PROFILE,
): Readonly<Record<string, string>> {
  const expected: Record<string, string> = {};

  const trusted = TrustedEnvironmentSchema.parse(profile.trustedEnvironment);
  expected[trusted.runner.path.replace(OPT_R3_ASSET_PREFIX, "")] = trusted.runner.sha256;
  expected[trusted.lockfile.path.replace(OPT_R3_ASSET_PREFIX, "")] = trusted.lockfile.sha256;
  for (const testFile of trusted.testFiles) {
    expected[testFile.path.replace(OPT_R3_ASSET_PREFIX, "")] = testFile.sha256;
  }
  for (const template of profile.templateFiles) {
    const assetPath = TEMPLATE_WORK_PATH_TO_ASSET[template.path];
    if (assetPath === undefined) {
      throw new Error(
        `manifest 模板文件 ${template.path} 没有到构建资产的映射：资产生成链与 manifest 必须同步修订`,
      );
    }
    expected[assetPath] = template.sha256;
  }
  if (Object.keys(expected).length === 0) {
    throw new Error("manifest 没有引用任何受信/模板文件：冻结读数缺失，拒绝准备");
  }
  return expected;
}

export type NodeTsV1AssetVerification =
  | { readonly ok: true; readonly recipeSha256: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 完整性门：逐项把资产字节哈希对回 manifest 期望值；同时要求配方文件（Dockerfile 与
 * 受信依赖清单 package.json）在场——它们没有 manifest 内哈希锚点，由**配方摘要**
 * （`recipeSha256`，进入准备计划 token）绑定。任一不成立即拒绝（P08）。
 */
export function verifyNodeTsV1Assets(
  assets: Readonly<Record<string, string>> = NODE_TS_V1_BUILD_ASSETS,
  profile: ProfileManifest = NODE_TS_V1_PROFILE,
): NodeTsV1AssetVerification {
  for (const required of ["Dockerfile", "package.json"]) {
    if (assets[required] === undefined) {
      return { ok: false, reason: `缺少配方文件 ${required}：受信环境构建输入不完整` };
    }
  }
  let expected: Readonly<Record<string, string>>;
  try {
    expected = nodeTsV1ExpectedAssetHashes(profile);
  } catch (error) {
    return { ok: false, reason: `manifest 期望表不可用：${(error as Error).message}` };
  }
  for (const [assetPath, expectedHash] of Object.entries(expected)) {
    const actual = assets[assetPath];
    if (actual === undefined) {
      return { ok: false, reason: `缺少受信构建资产 ${assetPath}（manifest 冻结哈希无对应输入）` };
    }
    const actualHash = sha256Text(actual);
    if (actualHash !== expectedHash) {
      return {
        ok: false,
        reason: `受信构建资产 ${assetPath} 与冻结 manifest 不一致（sha256 ${actualHash} ≠ ${expectedHash}）：拒绝构建（P08）`,
      };
    }
  }
  return { ok: true, recipeSha256: nodeTsV1RecipeSha256(assets) };
}

/**
 * 配方摘要：整张构建资产表（路径 → 字节哈希）的规范序列化 SHA-256。
 * Dockerfile / package.json 等无 manifest 锚点的配方文件由此进入计划 token——
 * 任何配方改动 = 新计划 = 旧 token 全部失效（P07 的准备侧绑定面）。
 */
export function nodeTsV1RecipeSha256(
  assets: Readonly<Record<string, string>> = NODE_TS_V1_BUILD_ASSETS,
): string {
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(assets).sort()) {
    hashes[path] = sha256Text(assets[path] as string);
  }
  return sha256Text(canonicalJson(hashes));
}

/** 产品资产（内嵌常量）的配方摘要——模块加载期计算一次，供计划 token 使用。 */
export const NODE_TS_V1_RECIPE_DIGEST: string = nodeTsV1RecipeSha256();

export { NODE_TS_V1_BUILD_ASSETS } from "./node-ts-v1-assets.generated.js";
