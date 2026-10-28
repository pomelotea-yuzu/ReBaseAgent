# 软件 i18n 测试迁移规范

版本：1（2026-10-28）。对应 `add-software-i18n` 任务 0.7，验收口径 G04。适用于批次 1–5 的测试改造；不是一次性批量替换脚本。

机器索引：[test-guarantee-index.json](test-guarantee-index.json)（5 类 / 46 个文件 / 666 条基线测试）。术语：[glossary.md](glossary.md)。候选归属：[attribution.json](attribution.json)。

## 1. 不可让步的保证

迁移文案时只能**替换断言的表达方式**，不能删除、跳过或放宽原保证。以下行为/事实必须继续被测试覆盖：

- 授权：费用确认、副本写入、执行/准备许可、来源 token、配置修订与计划指纹；未确认默认不可提交，旧确认随输入/配置变化失效。
- 未知与在飞：`unknown` 不补 `passed/cancelled/零消耗`；已提交操作按原 owner/operationId 关联，迟到结果不重发、不抢导航、不清新草稿。
- 竞态：偏好保存/刷新响应与提交交错、同一操作重复提交、epoch/revision 推进；旧响应不得覆盖新状态。
- 零执行：切语言、只读核对、比较/文件查看、拒绝路径不得新增模型、工具、准备、测试或导出调用。
- 隔离：父 run、源目录、兄弟分支逐字节不变；轮末文件副本边界不撤销同轮写入、不恢复外部状态。
- 机器契约：MCP 工具名/字段/错误码/只读范围、CLI 参数/退出码/JSON 字段/脱敏、trace/验证记录字节不随 locale 变化。

`check:i18n` 会读取本索引并检查每个文件的 `minTests` 下限；测试数低于基线直接判红。平台条件导致的 `skipIf` 是既有例外，但**不得**把缺产物、缺依赖或未实现功能静默跳过当作通过；确需拆分/合并测试文件时，先人工复核保证未丢失，再更新索引的 `minTests` 与 `titles`。

## 2. 稳定钩子优先

行为断言优先使用：

1. 稳定 `code` / `presentation.id` / 结构化字段（如 `result.outcome`、`operationId`、`runIds`）；
2. `data-testid`、语义角色、`data-state`、`aria-checked` 等稳定钩子；
3. 纯函数/连接层的返回值与调用计数（零执行、零请求、单次提交）。

不要把固定中文文本或中文 `aria-label` 当作稳定性锚点。可访问名称仍要翻译，但测试应通过角色/结构定位，再用显式 locale 断言名称。

```tsx
// 不推荐：中文文本既是行为判据，又是可访问名称锚点
expect(html).toContain("返回来源");

// 推荐：结构定位 + 显式 locale 的独立文案期望
expect(html).toContain('data-testid="back-to-source"');
expect(renderWithLocale("en-US", <BackToSource />)).toContain("Back to source");
expect(renderWithLocale("zh-CN", <BackToSource />)).toContain("返回来源");
```

## 3. 领域错误断言

错误的原因用稳定 code / 受控描述判断，不匹配中文 `message`，也不从中文正文猜错误类型。

```ts
// 不推荐
expect(result.message).toContain("未找到");

// 推荐：code 与 presentation 分离；原始 detail 仅在契约要求时单独断言
expect(result.code).toBe("RUN_NOT_FOUND");
expect(result.presentation?.id).toBe("errors.notFound");
expect(result.text).toBe("The requested resource was not found.");
```

旧 code 无描述时走 `legacyPresentationId`；未知异常只显示 `errors.generic` / `UNKNOWN_ERROR`，测试不得要求透传原始异常 message/stack。

## 4. 文案测试使用独立期望

- 使用 `renderWithLocale(locale, element)`（`apps/desktop/test/i18n/render-with-locale.tsx`）显式指定语言；不读宿主系统语言。
- 每种语言至少保留一条**独立书写**的期望字符串；不得只用 `t(key)` 的返回值作为期望（自证）。
- 同一测试可同时断言 zh/en；富文本用 `Trans` 的受控槽位，断言槽位顺序与转义，不把参数当 HTML。

```tsx
const en = renderWithLocale("en-US", <DeleteConfirm name="<img>" />);
expect(en).toContain("<code>&lt;img&gt;</code>");
expect(en).not.toContain("<img");
```

复数至少覆盖 0/1/2/大数；中文量词自然，不机械复制英文单复数。

## 5. 分批流程

对每个工作区批次：

1. **读索引**：按 `test-guarantee-index.json` 的 `batch` 过滤出本批保证文件，记录 `minTests`。
2. **先加钩子**：在组件/连接层补 `data-testid`/结构字段/code；先让旧中文断言仍绿，再改文案。
3. **迁移文案**：本批全部入口/确认/执行/未知/失败/结果一起迁移；同批处理 main/shared/包层的产品解释。
4. **改测试**：按第 2–4 节替换断言；保留授权/未知/竞态/零执行断言；不删不 skip。
5. **跑门禁**：
   ```powershell
   node scripts/check-i18n.mjs
   pnpm --filter @rebaseagent/i18n test
   ```
   以及本批定向测试与桌面 typecheck。
6. **更新归属**：本批产品文案归零后，把 `i18n/attribution.json` 对应文件 `status` 改为 `migrated`；仍有余项保持 `pending`，不得整目录豁免。
7. **记录**：在批次记录中写明本批保证文件、`minTests` 对照、零执行/授权测试未删、未覆盖项。若拆分测试文件，同步更新索引并说明原因。

收口时 `node scripts/check-i18n.mjs --final` 必须为零 pending；`check:i18n --selftest` 的 13 个反例必须仍全部判红。

## 6. 反模式

- 删除“只断言中文文案”的测试来换绿；正确做法是改断言对象，不是移除覆盖。
- 用 `expect(t("key"))` 作为唯一期望，或直接比较两种语言的 `t()` 输出而不写独立期望。
- 用 `aria-label="返回来源"` 定位元素；改用 role/testid，再单独测名称。
- 为通过英文布局测试而放宽授权/费用/未知/只读断言。
- 把 `tool_result`、trace、验证日志、JSON 报告正文翻译后再断言；这些是原文/机器契约，应保持原值。
- 用 `--final` 之外的宽松模式宣称产品覆盖完成；`--final` 只允许在 6.6/6.7 收口时通过。

## 7. 索引摘要（2026-10-28 基线）

| 类别 | 文件 | 基线测试数 |
|---|---:|---:|
| 授权与确认 | 9 | 212 |
| 未知、在飞与竞态 | 8 | 124 |
| 隔离、只读与零执行 | 8 | 97 |
| 未知结局与不猜测 | 7 | 82 |
| MCP/CLI 契约与机器输出 | 14 | 151 |

索引中的 `titles` 是迁移时的定位提示，不是完整用例清单；测试文件新增用例不受限制，减少用例受 `minTests` 门禁约束。
