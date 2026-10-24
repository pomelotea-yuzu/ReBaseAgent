import { canonicalJson, sha256Text } from "../canonical.js";
import {
  NODE_TS_V1_PROFILE,
  type PreparePlan,
  PreparePlanSchema,
  type ProfileManifest,
} from "../schema.js";
import { NODE_TS_V1_RECIPE_DIGEST } from "../trusted-env/node-ts-v1.js";

/**
 * 固定准备计划（R3 tasks 3.1；验收 P03/P07）。
 *
 * **纯函数、零副作用**（P03「只读计划不准备环境」）：不读后端、不下载、不建容器、
 * 不写盘——只把冻结 manifest 与 3.1 实测的下载/占用读数组织成可展示计划。
 * 下载体积为**压缩传输口径**的实测值（测量方式见各常量注释）；正式执行（`prepare`）
 * 必须另行当前授权（`allowPrepare:true` + 当前 token），见 prepare.ts。
 */

/**
 * 准备策略版本：网络范围/脚本策略/许可口径的文本（`networkScopeNote`、downloads 的
 * license 字段）变化时递增；进入计划 token（P07：策略漂移 ⇒ 旧 token 失效）。
 */
export const PREPARE_POLICY_VERSION = 1;

// —— 以下数字均为 2026-10-25 本机实测冻结（backend-verification.md §3.1）——
// 基础镜像压缩层合计：`docker manifest inspect` amd64 子清单 layers size 求和。
const BASE_IMAGE_COMPRESSED_BYTES = 61337515;
// typescript@5.9.3 tarball 压缩体积：registry.npmjs.org Range 请求 Content-Range 总长。
const NPM_TYPESCRIPT_TARBALL_BYTES = 4377468;
// 磁盘占用估计（本地解压口径）：基础镜像 + v2 环境镜像本地大小（docker image inspect）。
const BASE_IMAGE_LOCAL_BYTES = 239050910;
const ENV_IMAGE_LOCAL_BYTES = 270824228;

/** manifest 的规范摘要（计划与 token 的锚点；manifest 任何字段变化 ⇒ 摘要变化）。 */
export function manifestDigest(profile: ProfileManifest = NODE_TS_V1_PROFILE): string {
  return sha256Text(canonicalJson(profile));
}

/**
 * 构建当前固定准备计划。数字/来源为 node-ts-v1 专属实测冻结值（新 profile =
 * 版本化 manifest + 本函数同步扩展，不做通用下载描述引擎）。
 */
export function buildPreparePlan(profile: ProfileManifest = NODE_TS_V1_PROFILE): PreparePlan {
  return PreparePlanSchema.parse({
    profileId: profile.profileId,
    manifestVersion: profile.manifestVersion,
    manifestDigest: manifestDigest(profile),
    downloads: [
      {
        source: `${profile.baseImage.repository}@${profile.baseImage.digest}`,
        approxBytes: BASE_IMAGE_COMPRESSED_BYTES,
        license: "Node.js 运行时（MIT）；Alpine 及镜像内组件许可随 6.5 第三方清单核对汇总",
      },
      {
        source: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
        approxBytes: NPM_TYPESCRIPT_TARBALL_BYTES,
        license: "Apache-2.0（入库锁文件 license 字段，integrity 校验安装）",
      },
    ],
    networkScopeNote:
      "仅本次准备允许联网：按上方来源拉取基础镜像与依赖（固定锁文件 integrity 校验、" +
      "--ignore-scripts 禁生命周期脚本，不在宿主跑 npm）；不传用户凭据；" +
      "正式测试断网（manifest security.networkMode 钉 none）。" +
      "基础镜像经 DaoCloud 源前缀拉取，与官方源一致性核对未完成（backend-verification.md §1.2 未闭合项）。",
    spaceEstimateBytes: BASE_IMAGE_LOCAL_BYTES + ENV_IMAGE_LOCAL_BYTES,
  });
}

/** 计划本身的规范摘要（准备记录 meta.planDigest 锚定「用户确认的是哪份计划」）。 */
export function preparePlanDigest(plan: PreparePlan): string {
  return sha256Text(canonicalJson(plan));
}

/**
 * 准备计划 token：计划 + 策略版本 + 受信环境配方摘要的绑定哈希（P07）。
 * 三者任一变化 ⇒ token 变化 ⇒ 持旧 token 的提交按 PLAN_STALE 拒绝，要求重新核对；
 * token 防漂移，**不替代**当前授权（`allowPrepare`/`allowExecution` 仍须显式为 true）。
 * `kind` 域分离：计划 token 与其他摘要（如计划 digest）不互换。
 */
export function preparePlanToken(plan: PreparePlan, recipeSha256: string): string {
  return sha256Text(
    canonicalJson({
      kind: "rebaseagent-r3-prepare-plan-token",
      plan,
      policyVersion: PREPARE_POLICY_VERSION,
      recipeSha256,
    }),
  );
}

/** 当前（manifest × 策略 × 配方）组合下的正确 token——prepare 提交比对基准。 */
export function currentPreparePlanToken(): string {
  return preparePlanToken(buildPreparePlan(), NODE_TS_V1_RECIPE_DIGEST);
}
