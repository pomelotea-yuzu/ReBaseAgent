# @rebaseagent/i18n

纯 TypeScript 的同步双语运行时：locale 规范化、`zh-CN` / `en-US` 资源、实例工厂与受控消息契约。对应 `add-software-i18n` 任务 0.3/0.4。

## 边界

- 只依赖 `i18next`，不依赖 React、Electron、`fs`、网络或环境变量。
- 资源本地静态内置，初始化同步（`initAsync: false`），无 HTTP backend、语言检测插件或加载 suspense。
- 每个桌面根 / CLI / MCP server / 测试创建独立实例；不存在模块级可变当前语言。
- React 适配（`react-i18next` Provider、`Trans` 槽位）只放在桌面 renderer，不进本包。
- 资源对象冻结；实例初始化时复制资源，实例内 `addResourceBundle` 不会污染其他实例。

## 依赖冻结

| 包 | 版本 | 许可 | 说明 |
|---|---|---|---|
| `i18next` | `26.5.11`（精确版本，无 `^`） | MIT | 仅本包运行时依赖；无传递依赖 |
| `react-i18next` | `17.1.9`（精确版本，无 `^`） | MIT | 只由 `apps/desktop` 的 React 适配使用，不在本包依赖中；peer 要求 i18next ≥ 26.2 |

版本与许可写入 `pnpm-lock.yaml`。升级必须先复核同步初始化行为（`initAsync:false`）与 Node / Electron renderer 兼容性，再更新本表。

## 目录

```text
src/locale.ts            Locale 类型、显式值校验、系统语言/桌面偏好解析
src/cli-locale.ts        CLI 语言优先级、受控 INVALID_LOCALE 与说明资源键
src/resources/zh-CN.ts   中文键契约（源）
src/resources/en-US.ts   英文资源（键必须与中文一致）
src/resources/index.ts   namespace 清单与资源聚合
src/create-i18n.ts       同步实例工厂、缺键回退与诊断回调
src/index.ts             公共导出
```

资源按 `common/run/detail/fork/experiment/compare/files/verification/recording/settings/export/errors/mcp/cli` 分 namespace。0.x 先建立 `common` 通用键；各工作区在对应批次补键，不以中文原句或数字索引作键名。

## CLI 语言解析

`resolveCliLocale({ argv, env, intlLocale })` 是纯函数：不读 `process.env`、不打印、不退出。优先级为

`--locale` > `REBASEAGENT_LOCALE` > `LC_ALL` > `LC_MESSAGES` > `LANG` > Intl > `en-US`。

- 显式值与产品环境变量只接受 `zh-CN` / `en-US`；重复、缺值、不支持或环境变量非法时返回
  `INVALID_LOCALE`（`reason` + `messageKey` + `messageLocale`），入口应使用
  `CLI_LOCALE_EXIT_CODE = 2` 退出，且尚未加载用户配置/执行。
- 系统候选取首个非空值，`zh` 及其变体归 `zh-CN`，`C`/`POSIX`/未知/无系统语言归 `en-US`。
- 受控说明只用 `cli.locale*` 资源键，不回显调用方传入的非法值；宿主 Intl 建议语言由入口传入
  （检测不可用或无系统语言时传 `null`）。


## 缺键行为

1. 当前语言缺键 → 回退 `zh-CN` 同键；
2. 两语言都缺 → 返回当前语言的通用提示（`此消息暂不可用` / `This message is unavailable`），不显示裸 key；
3. `onMissingKey` 只收到 `locale/namespace/key`，不包含插值参数或密钥；发行门禁仍要求无缺键，运行期回退不豁免资源缺失。

## 受控错误描述

- 现有 `Envelope.error` 的 `{code,message}` 保持兼容；`attachPresentation` 只追加通过校验的 `presentation:{id,params}`，不改 code/message。
- `id` 由 `errors` namespace 的键派生（`PRESENTATION_IDS`），参数按 id 白名单校验：只接受有界字符串、有限数字、布尔和有界字符串/数字集合；拒绝对象、堆栈、未知字段与超限值。
- `explainError` 优先使用受控描述；无描述时按稳定 code 映射；未知异常只给通用本地化摘要和 `UNKNOWN_ERROR`，不携带 message/stack。
- `renderPresentation` 只把校验后的参数作为文本交给 translator，不把参数当资源键或 HTML；数组参数按 `, ` 连接展示。

## 命令

```powershell
pnpm --filter @rebaseagent/i18n build
pnpm --filter @rebaseagent/i18n test
```
