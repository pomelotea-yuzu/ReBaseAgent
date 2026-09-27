# 依赖许可证核查记录

日期：2026-09-27。状态：已完成锁文件与本机安装树扫描；**尚未完成最终发行物许可证核查**。报告依据 [机器清单](2026-09-27-dependency-licenses.json)，不将 `package.json` 的 license 字段视为全部许可义务。

## 基线与方法

- 扫描开始和结束提交均为 `41df2c0d1e6c36ed1ebe18b862733f6851ec691c`。
- `pnpm-lock.yaml` 格式为 9.0，SHA-256 为 `18bfa39b4f28c53f4440048055409bdbd99bc3e76e7fd1b6310a35f1c5cfcae8`。
- 本机 Windows 安装树，使用现有 `js-yaml@4.3.2` 解析锁文件；未安装或升级依赖。
- 包身份按名称和版本去重；同版本的 peer 变体不重复计数。桌面生产图从 dependencies/optionalDependencies 及 workspace 引用递归遍历，可能包含类型或 peer 关联包，不能直接当作发行清单。
- 对本机存在的包读取 license 元数据，并计算顶层 LICENSE/COPYING/NOTICE/COPYRIGHT/ThirdPartyNotices 文件及包清单的哈希。没有递归审查包内全部文件、嵌入资源或二进制。
- 单列 Electron 二进制附带的 LICENSE 和 LICENSES.chromium.html。扫描前后核对锁文件与 workspace 清单未改变；没有验证 npm 归档完整性，也没有解析所有许可证文本的法律条件。

生成器：[dependency-license-inventory.cjs](../tools/dependency-license-inventory.cjs)。从仓库根可只读重跑：

```powershell
node docs/development/tools/dependency-license-inventory.cjs
```

命令向标准输出生成 JSON，不修改依赖或应用数据。需要已安装的 pnpm 依赖树；不同平台缺失的可选包可能不同。归档新结果时应新建日期文件，不覆盖本次证据。

## 扫描结果

| 项目 | 数量 | 解释 |
|---|---:|---|
| 锁文件包身份 | 519 | 包含开发工具和跨平台可选包 |
| 本机找到精确名称/版本 | 394 | 已读取包清单与可发现的顶层声明 |
| 本机未安装 | 125 | 包含其他平台的可选包；未取得其许可证证据，不能自动标记通过 |
| 已安装但缺少 license 元数据 | 0 | 仅代表字段存在 |
| 已安装但未找到匹配的顶层声明文件 | 24 | 不等于没有许可证；需要按实际用途继续追溯 |
| 桌面生产图中的外部包 | 19 | 全部已安装且发现顶层声明；仍不是最终发行物覆盖率 |

394 个包的声明分类：MIT 306、ISC 39、Apache-2.0 11、BSD-3-Clause 11、BlueOak-1.0.0 8、BSD-2-Clause 6、MPL-2.0 2、0BSD 2、`MIT OR Apache-2.0` 2，其余 7 个分别使用 Python-2.0、CC-BY-4.0、`(MPL-2.0 OR Apache-2.0)`、`WTFPL OR ISC`、WTFPL、`(MIT OR CC0-1.0)`、`(WTFPL OR MIT)`。此统计只按元数据分组，不能覆盖包内另附的第三方许可。

完整缺失包清单和 24 个未发现顶层声明的包均保存在 JSON 的 `summary` 中。后者包括构建工具平台包、`app-builder-lib`、`chromium-pickle-js`、`keyv`、`truncate-utf8-bytes` 等；需区分未分发的开发依赖与可能携带入发行物的代码/二进制。

## 与桌面发行直接相关的项目

| 包或组件 | 本次证据 | 后续处理 |
|---|---|---|
| React / React DOM 19.2.8、Zustand 5.0.15、Zod 3.25.76 | MIT，发现 LICENSE | 保留适用版权和许可声明，检查 bundle 与发行目录 |
| Monaco Editor 0.56.0 | MIT，发现 LICENSE 与 ThirdPartyNotices.txt | 同时审查第三方声明，不能只带 Monaco 自身 LICENSE |
| @monaco-editor/react 4.7.0、loader 1.7.0 | MIT，发现 LICENSE | 核对实际捆绑内容及相应声明 |
| ECharts 6.1.0 / zrender 6.1.0 | Apache-2.0 / BSD-3-Clause；ECharts 同时有 NOTICE | 保留适用许可、版权与 NOTICE 内容 |
| lucide-react 1.47.0 | 元数据 ISC；LICENSE 还包含 Feather 派生图标的 MIT 部分 | 保留完整相关声明，不能只根据 ISC 字段生成通知 |
| DOMPurify 3.4.8 | `(MPL-2.0 OR Apache-2.0)`；发现 LICENSE 与 LICENSE-MPL | 发行核查时记录采用的许可路径及对应义务，不把 OR 写成必须同时接受两套条件 |
| eventsource-parser 3.1.1、marked 14.0.0、scheduler 0.27.0、state-local 1.0.7 | MIT，发现声明 | 区分外部运行依赖与 bundle 内容，均按实际包含情况处理 |
| tslib 2.3.0 | 0BSD，发现 LICENSE.txt | 按实际内容核对并保留可追溯记录 |
| 类型关联包 | @types/react、@types/trusted-types、csstype，均声明 MIT | 生产图包含它们不证明发行物包含它们，需查看构建结果 |
| Electron 44.1.1 | 虽列于 devDependencies，桌面运行时会随包交付；本机存在运行时 LICENSE 和 Chromium 声明 | 作为独立发行组件核查，不能因为 devDependency 就排除 |

本机 Electron 运行时文件指纹：

```text
LICENSE
5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d
LICENSES.chromium.html
f2310820377f4d8f2a5f6bc8744b985d6772cef9ee7d8d197b01fdb330db0bb8
```

开发依赖中还存在 `lightningcss` / 平台包的 MPL-2.0、`caniuse-lite` 的 CC-BY-4.0、`argparse` 的 Python-2.0 等。不能简单要求所有构建输入都作为运行依赖分发，也不能未经检查就认定构建产物完全不包含受其许可约束的内容。

## 打包配置观察

[electron-builder.yml](../../../apps/desktop/electron-builder.yml) 将前端构建输出打入应用，并排除了多个已被打包进 renderer 的原始 node_modules 目录。排除目录减少重复体积，但不会自动消除 bundle 中代码的许可义务。

所读配置未显式声明自定义的第三方汇总通知文件。此观察不能证明最终 exe 缺少声明，因为构建器、bundle 和 Electron 分发可能各自携带部分内容。本轮没有解包最终 exe/asar，也未新增打包规则或重新构建。

## 发行前完成条件

1. 对候选发行物记录提交、锁文件哈希和产物 SHA-256，在独立目录检查实际 bundle、asar、运行时和资源。
2. 建立“实际携带组件 → 版本 → 上游许可/版权/NOTICE → 包内位置”的映射。生产依赖图只是初始候选，打包进来的开发工具代码也应纳入。
3. 按实际内容准备第三方声明，覆盖 Monaco 第三方通知、ECharts NOTICE、Lucide/Feather 以及 Electron/Chromium；核实双许可证的采用方式。
4. 对未安装包和未找到顶层声明的包逐项记录“不分发及证据”或“已核查上游及处理”，不能用开发依赖标签代替证据。
5. 验证用户在发行物中能够取得所需声明，并保存检查记录；依赖或打包配置变化后重新核查。

本次可得结论是“已建立可重复的依赖元数据基线，并识别发行核查重点”。尚不能得出“全部依赖合规”或“最终包已完整满足第三方义务”。
